// 百度盘操作（纯 Node.js HTTP 实现，无外部二进制依赖），全部只用网盘登录态（bduss.txt 的 BDUSS + STOKEN）：
//   列表 / 配额 / 用户信息 / 建目录 / 改名 / 移动 / 删除 → pan.baidu.com/api/*（网页接口，带 bdstoken）
//   转存 → pan.baidu.com/share/{verify,list,transfer}（Netdisk UA 取 bdstoken / shareid / share_uk）
import fs from 'node:fs';
import { BDUSS_FILE } from './paths.mjs';
import { Mutex, sleep } from './util.mjs';

const XPAN_APP_ID = '250528';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// 百度分享页对普通浏览器 UA 会弹登录重定向而隐藏 window.locals；使用网盘客户端 UA 可直接拿到 bdstoken / shareid / share_uk
const NETDISK_UA = 'netdisk;P2SP;3.0.0.8;netdisk;11.12.3;ANG-AN00;android-android;10.0;JSbridge4.4.0;jointBridge;1.1.0;';

const writeLock = new Mutex();

function withTimeout(timeoutSec, signal) {
  const t = AbortSignal.timeout(timeoutSec * 1000);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// ---------- 登录态（BDUSS / STOKEN） ----------
export function readBduss() {
  if (!fs.existsSync(BDUSS_FILE)) return null;
  const lines = fs.readFileSync(BDUSS_FILE, 'utf8').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'));
  const bduss = lines.find(l => l.startsWith('BDUSS='))?.slice(6).trim();
  const stoken = lines.find(l => l.startsWith('STOKEN='))?.slice(7).trim();
  return bduss ? { bduss, stoken } : null;
}

function cookieHeader(extra = '') {
  const c = readBduss();
  if (!c?.bduss) throw new Error('缺少 bduss.txt（百度网盘登录态）');
  return `BDUSS=${c.bduss}` + (c.stoken ? `; STOKEN=${c.stoken}` : '') + (extra ? `; ${extra}` : '');
}

async function templateVars(c) {
  const r = await fetch(
    `https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=${XPAN_APP_ID}&web=1&fields=%5B%22bdstoken%22,%22username%22,%22uk%22%5D`,
    {
      signal: AbortSignal.timeout(15000),
      headers: {
        'user-agent': NETDISK_UA,
        referer: 'https://pan.baidu.com/disk/home',
        cookie: `BDUSS=${c.bduss}` + (c.stoken ? `; STOKEN=${c.stoken}` : ''),
      },
    },
  );
  const j = await r.json();
  return j.errno === 0 && j.result?.bdstoken ? j.result : null;
}

export async function whoami(creds = null) {
  const c = creds || readBduss();
  if (!c?.bduss) return null;
  try {
    const v = await templateVars(c);
    if (!v) return null;
    if (!creds) tokenCache = { bduss: c.bduss, bdstoken: v.bdstoken };
    return { uid: String(v.uk || ''), name: String(v.username || '已登录').trim() };
  } catch {
    return null;
  }
}

export async function verifyLogin() {
  return Boolean(await whoami());
}

// bdstoken 跟着 BDUSS 走，重新登录后自动失效重取
let tokenCache = { bduss: '', bdstoken: '' };
async function bdstoken() {
  const c = readBduss();
  if (!c?.bduss) throw new Error('网盘未登录，请在「设置 → 网盘账号」里扫码登录');
  if (tokenCache.bduss === c.bduss && tokenCache.bdstoken) return tokenCache.bdstoken;
  const v = await templateVars(c);
  if (!v) throw new Error('网盘登录已失效，请在「设置 → 网盘账号」里重新扫码登录');
  tokenCache = { bduss: c.bduss, bdstoken: v.bdstoken };
  return v.bdstoken;
}

// 调用网盘网页接口。form 为空时发 GET；读接口在网络错误/空响应时重试
async function panApi(path, { query = {}, form = null, tries = form ? 1 : 4, timeoutSec = 30, signal } = {}) {
  const qs = new URLSearchParams({ clienttype: '0', app_id: XPAN_APP_ID, web: '1', bdstoken: await bdstoken(), ...query });
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(`https://pan.baidu.com${path}${path.includes('?') ? '&' : '?'}${qs}`, {
        method: form ? 'POST' : 'GET',
        headers: {
          'user-agent': NETDISK_UA,
          referer: 'https://pan.baidu.com/disk/home',
          cookie: cookieHeader(),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: withTimeout(timeoutSec, signal),
      });
      const txt = await r.text();
      if (!txt.trim()) throw new Error('空响应（限流）');
      const j = JSON.parse(txt);
      if (j.errno === -6) {
        tokenCache = { bduss: '', bdstoken: '' };
        throw new Error('网盘登录已失效，请在「设置 → 网盘账号」里重新扫码登录');
      }
      return j;
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      lastErr = e;
      if (/登录/.test(e.message)) break;
      if (t < tries - 1) await sleep(1000 * 2 ** t);
    }
  }
  throw lastErr;
}

// ---------- 读接口 ----------
export async function quota() {
  const j = await panApi('/api/quota', { query: { checkfree: '1', checkexpire: '1' } });
  if (j.errno !== 0) throw new Error('配额查询失败 errno=' + j.errno);
  return { total: j.total, used: j.used, free: j.free ?? (j.total - j.used) };
}

export async function userInfo() {
  const j = await panApi('/rest/2.0/xpan/nas?method=uinfo');
  if (j.errno !== 0) throw new Error('用户信息查询失败 errno=' + j.errno);
  return { name: j.baidu_name, avatar: j.avatar_url, vip_type: j.vip_type };
}

// 列目录（自动翻页）。目录不存在返回 null。
export async function listDir(dir) {
  const out = [];
  for (let page = 1; ; page++) {
    const j = await panApi('/api/list', { query: { dir, page: String(page), num: '1000', order: 'name', desc: '0' } });
    if (j.errno === -9) return null;
    if (j.errno !== 0) throw new Error(`列目录失败 ${dir} errno=${j.errno}`);
    out.push(...(j.list || []));
    if ((j.list || []).length < 1000) break;
  }
  return out.map(e => ({ name: e.server_filename, isdir: !!+e.isdir, size: +e.size || 0, mtime: e.server_mtime, path: e.path, fs_id: String(e.fs_id), md5: e.md5 || null }));
}

// 读网盘里的小文件（几 KB 的 JSON），返回文本
export async function readSmallFile(fsId, { timeoutSec = 30 } = {}) {
  const j = await panApi('/api/filemetas', { query: { dlink: '1', fsids: `[${fsId}]` } });
  const dlink = j.errno === 0 ? j.info?.[0]?.dlink : null;
  if (!dlink) throw new Error(`取下载地址失败 errno=${j.errno}`);
  const r = await fetch(dlink, { headers: { 'user-agent': 'pan.baidu.com', cookie: cookieHeader() }, signal: AbortSignal.timeout(timeoutSec * 1000) });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  return r.text();
}

// ---------- 分享内容（匿名，凭提取码） ----------
const SHARE_ERR = {
  '-9': '提取码错误',
  '-12': '提取码错误',
  '-62': '需要验证码（请求太频繁）',
  '105': '链接已失效',
  '-7': '链接已失效',
  '117': '链接已过期',
  '-21': '分享已取消或不存在',
  '115': '该文件禁止分享',
};
const INVALID_ERRNO = [105, -7, 117, -21, 115];

// 递归列出分享里的全部文件。返回 { files: [{ rel, name, size, md5 }] } 或 { error }
// md5 和转存后网盘里看到的一样（盘游的评价按它认同一份资源）
export async function listShare(surl, pwd, { delayMs = 400 } = {}) {
  const short = surl.replace(/^1/, '');
  try {
    const v = await (await fetch(`https://pan.baidu.com/share/verify?surl=${short}&t=${Date.now()}&channel=chunlei&web=1&clienttype=0`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': UA, referer: `https://pan.baidu.com/share/init?surl=${short}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: `pwd=${pwd || ''}&vcode=&vcode_str=`,
    })).json();
    if (v.errno !== 0) return { error: SHARE_ERR[v.errno] || `验证失败 errno=${v.errno}` };
    const headers = { 'user-agent': UA, referer: `https://pan.baidu.com/s/${surl}`, cookie: `BDCLND=${v.randsk}` };
    const files = [];
    const queue = [null];
    while (queue.length) {
      const dir = queue.shift();
      for (let page = 1; ; page++) {
        const q = dir === null ? 'root=1' : `root=0&dir=${encodeURIComponent(dir)}`;
        const j = await (await fetch(`https://pan.baidu.com/share/list?web=1&app_id=${XPAN_APP_ID}&shorturl=${short}&${q}&page=${page}&num=100&order=name&desc=0&showempty=0`,
          { headers, signal: AbortSignal.timeout(20000) })).json();
        if (j.errno !== 0) return { error: SHARE_ERR[j.errno] || `列目录失败 errno=${j.errno}` };
        for (const e of j.list || []) {
          if (+e.isdir) queue.push(e.path);
          else files.push({ rel: e.path, name: e.server_filename, size: +e.size, md5: e.md5 || null });
        }
        await sleep(delayMs);
        if ((j.list || []).length < 100) break;
      }
    }
    return { files };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 120) };
  }
}

// ---------- 文件管理（建目录 / 改名 / 移动 / 删除） ----------
// 同步执行；整体 errno 为 0 时仍要逐项检查 info
async function fileManager(opera, filelist, { timeoutSec = 180, signal } = {}) {
  const j = await panApi('/api/filemanager', {
    query: { opera, async: '0', onnest: 'fail' },
    form: { filelist: JSON.stringify(filelist), ondup: 'fail' },
    timeoutSec,
    signal,
  });
  return { ok: j.errno === 0 && (j.info || []).every(x => !x.errno), errno: j.errno };
}

// 百度风控要求安全验证时（errno 132，网页版会弹短信验证）接口删不掉文件，移动/改名不受影响
const NEED_VERIFY = 132;
export const TRASH_DIR = '/盘架待删除';

const splitPath = (p) => {
  const i = p.lastIndexOf('/');
  return { dir: p.slice(0, i) || '/', name: p.slice(i + 1) };
};

async function guardedWrite(fn, signal) {
  return writeLock.run(async () => {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      return false;
    }
  });
}

// dst 是完整目标路径（可同时改名）；目标已存在时失败
export async function mv(src, dst, signal) {
  const { dir, name } = splitPath(dst);
  return guardedWrite(async () => (await fileManager('move', [{ path: src, dest: dir, newname: name }], { signal })).ok, signal);
}

// 返回 'deleted' | 'trashed' | false；删除被安全验证拦下时改为移进 TRASH_DIR，等你在网盘 App 里清空
export async function rm(paths, signal) {
  return guardedWrite(async () => {
    const r = await fileManager('delete', paths, { signal });
    if (r.ok) return 'deleted';
    if (r.errno !== NEED_VERIFY) return false;
    await mkdirRaw(TRASH_DIR, signal);
    for (const p of paths) {
      const name = p.slice(p.lastIndexOf('/') + 1);
      let m = await fileManager('move', [{ path: p, dest: TRASH_DIR, newname: name }], { signal });
      if (!m.ok) m = await fileManager('move', [{ path: p, dest: TRASH_DIR, newname: `${name} (${Date.now()})` }], { signal });
      if (!m.ok) return false;
    }
    return 'trashed';
  }, signal);
}

async function mkdirRaw(dir, signal) {
  const j = await panApi('/api/create', { query: { a: 'commit' }, form: { path: dir, isdir: '1', block_list: '[]', rtype: '0' }, timeoutSec: 60, signal });
  // -8 = 目录已存在
  return { ok: j.errno === 0 || j.errno === -8, errno: j.errno };
}

export async function mkdir(dir, signal) {
  return guardedWrite(async () => (await mkdirRaw(dir, signal)).ok, signal);
}

// ---------- 分享转存 ----------

// 转存一个分享到 destDir。返回 { status, detail }
// status: saved | exists | invalid | err_quota | err_pwd | err_<code> | exc
export async function transferOne(surl, pwd, destDir, { timeoutSec = 180, signal } = {}) {
  return writeLock.run(async () => {
    const sig = withTimeout(timeoutSec, signal);
    try {
      const dirRes = await mkdirRaw(destDir, sig);
      if (!dirRes.ok) {
        return { status: 'err_cd', detail: `目标目录不可用 (errno=${dirRes.errno}): ${destDir}`.slice(0, 160) };
      }

      const short = String(surl).replace(/^1/, '');
      const featureStr = '1' + short;

      let randsk = '';
      if (pwd) {
        const vr = await fetch(`https://pan.baidu.com/share/verify?surl=${short}&t=${Date.now()}&channel=chunlei&web=1&clienttype=0`, {
          method: 'POST',
          signal: sig,
          headers: {
            'user-agent': UA,
            referer: `https://pan.baidu.com/share/init?surl=${short}`,
            'content-type': 'application/x-www-form-urlencoded',
            cookie: cookieHeader(),
          },
          body: `pwd=${encodeURIComponent(pwd)}&vcode=&vcode_str=`,
        });
        const vj = await vr.json();
        if (vj.errno === -9 || vj.errno === -12) return { status: 'err_pwd', detail: SHARE_ERR[vj.errno] || '提取码错误' };
        if (INVALID_ERRNO.includes(vj.errno)) return { status: 'invalid', detail: SHARE_ERR[vj.errno] || `链接已失效 errno=${vj.errno}` };
        if (vj.errno !== 0) return { status: 'err_' + vj.errno, detail: SHARE_ERR[vj.errno] || `验证提取码失败 errno=${vj.errno}` };
        randsk = vj.randsk || '';
      }

      const cookie = cookieHeader(randsk ? `BDCLND=${randsk}` : '');
      const pr = await fetch(`https://pan.baidu.com/s/${featureStr}`, {
        signal: sig,
        headers: {
          'user-agent': NETDISK_UA,
          referer: pwd ? `https://pan.baidu.com/share/init?surl=${short}` : 'https://pan.baidu.com/disk/home',
          cookie,
        },
      });
      const html = await pr.text();
      if (pr.url.includes('/error') || html.includes('error-404') || html.includes('platform-non-found') || html.includes('share-error-left')) {
        return { status: 'invalid', detail: '分享链接已失效或不存在' };
      }
      if (pr.url.includes('/share/init')) {
        return { status: 'err_pwd', detail: '需要提取码或提取码错误' };
      }
      const m = html.match(/(\{"[^\r\n]+?"loginstate"[^\r\n]+?\})/);
      if (!m) return { status: 'err_-6', detail: '未能从分享页获取登录态，请检查 BDUSS/STOKEN' };
      const locals = JSON.parse(m[1]);
      if (!locals.bdstoken || !locals.loginstate) return { status: 'err_-6', detail: '百度网盘登录态已失效（缺少 bdstoken）' };
      if (!locals.shareid || !locals.share_uk) return { status: 'invalid', detail: '分享页缺少 shareid / share_uk' };

      const listQs = new URLSearchParams({
        app_id: XPAN_APP_ID,
        bdstoken: String(locals.bdstoken),
        channel: 'chunlei',
        root: '1',
        shorturl: short,
        web: '5',
      });
      const lr = await fetch(`https://pan.baidu.com/share/list?${listQs}`, {
        signal: sig,
        headers: { 'user-agent': UA, referer: `https://pan.baidu.com/s/${featureStr}`, cookie },
      });
      const lj = await lr.json();
      if (INVALID_ERRNO.includes(lj.errno)) return { status: 'invalid', detail: SHARE_ERR[lj.errno] || `链接已失效 errno=${lj.errno}` };
      if (lj.errno !== 0) return { status: 'err_' + lj.errno, detail: `获取分享列表失败 errno=${lj.errno}` };
      const fsids = (lj.list || []).map(x => x.fs_id);
      if (!fsids.length) return { status: 'invalid', detail: '分享内容为空' };
      const names = (lj.list || []).map(x => x.server_filename).filter(Boolean);

      const trQs = new URLSearchParams({
        app_id: XPAN_APP_ID,
        bdstoken: String(locals.bdstoken),
        channel: 'chunlei',
        clienttype: '0',
        from: String(locals.share_uk),
        shareid: String(locals.shareid),
        web: '1',
      });
      const tr = await fetch(`https://pan.baidu.com/share/transfer?${trQs}`, {
        method: 'POST',
        signal: sig,
        headers: {
          'user-agent': UA,
          referer: `https://pan.baidu.com/s/${featureStr}`,
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
        },
        body: new URLSearchParams({ fsidlist: JSON.stringify(fsids), path: destDir }).toString(),
      });
      const tj = await tr.json();
      if (tj.errno === 0) return { status: 'saved', names };
      // 百度偶尔返回「已存在」类错误码但目标目录里并没有同名项，必须核实，否则游戏会被误标为已入盘
      const verifyExists = async (errno) => {
        const entries = await listDir(destDir).catch(() => null);
        if (!entries || entries.some(e => names.includes(e.name))) return { status: 'exists', names };
        return { status: 'err_' + errno, detail: `百度返回「已存在」(errno=${errno})，但 ${destDir} 里没有「${names[0]}」，请重试转存` };
      };
      if (tj.errno === 4 || tj.errno === -8 || tj.errno === -30) return verifyExists(tj.errno);
      const showMsg = String(tj.show_msg || tj.err_msg || '').trim();
      if (tj.errno === -10 || tj.errno === -32 || /空间不足|容量不足|超出.*容量|quota/i.test(showMsg)) {
        return { status: 'err_quota', detail: (showMsg || '网盘空间不足').slice(0, 160) };
      }
      if (INVALID_ERRNO.includes(tj.errno)) {
        return { status: 'invalid', detail: (showMsg || SHARE_ERR[tj.errno] || `链接已失效 errno=${tj.errno}`).slice(0, 160) };
      }
      if (tj.errno === 12) {
        if (tj.target_file_nums > tj.target_file_nums_limit) {
          return { status: 'err_12', detail: `转存文件数(${tj.target_file_nums})超过单次上限(${tj.target_file_nums_limit})` };
        }
        const subErrs = (tj.info || []).map(x => x.errno).filter(e => e !== undefined && e !== 0);
        if (subErrs.length > 0 && subErrs.every(e => e === -30 || e === -8)) return verifyExists(subErrs[0]);
        if (subErrs.includes(-10) || subErrs.includes(-32)) return { status: 'err_quota', detail: (showMsg || '网盘空间不足').slice(0, 160) };
        const sub = subErrs[0] ?? 12;
        return { status: 'err_' + sub, detail: (showMsg || `转存失败 errno=12 (sub=${sub})`).slice(0, 160) };
      }
      return { status: 'err_' + (tj.errno ?? 'unknown'), detail: (showMsg || JSON.stringify(tj)).slice(0, 160) };
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      return { status: 'exc', detail: String(e.message || e).slice(0, 160) };
    }
  });
}
