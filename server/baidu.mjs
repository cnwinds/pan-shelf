// 百度盘操作（纯 Node.js HTTP 实现，无外部二进制依赖）：
//   转存                     → pan.baidu.com/share/{verify,list,transfer}（携带 BDUSS + STOKEN + Netdisk UA）
//   改名 / 移动 / 删除 / 建目录 → pcs.baidu.com/rest/2.0/pcs/file?app_id=266719（携带 BDUSS）
//   列表 / 配额 / 用户信息    → xpan 开放平台（bd_open.json，access_token 自动续期）
import fs from 'node:fs';
import { BDUSS_FILE, OPEN_FILE } from './paths.mjs';
import { Mutex, sleep } from './util.mjs';

const PCS_APP_ID = '266719';
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

export async function whoami() {
  const c = readBduss();
  if (!c?.bduss) return null;
  try {
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
    if (j.errno === 0 && j.result?.bdstoken) {
      return { uid: String(j.result.uk || ''), name: String(j.result.username || '已登录').trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export async function verifyLogin() {
  return Boolean(await whoami());
}

// ---------- 开放平台 token ----------
function loadOpen() {
  if (!fs.existsSync(OPEN_FILE)) return null;
  const j = JSON.parse(fs.readFileSync(OPEN_FILE, 'utf8'));
  j.expires_at = j.expires_at || (Date.now() + (j.expires_in || 2592000) * 1000 - 86400000);
  return j;
}

export function openTokenInfo() {
  const j = loadOpen();
  if (!j) return { configured: false };
  return { configured: true, expires_at: new Date(j.expires_at).toISOString(), can_refresh: !!j.refresh_token, scope: j.scope };
}

export async function refreshOpenToken() {
  const j = loadOpen();
  if (!j?.refresh_token) throw new Error('bd_open.json 缺少 refresh_token');
  const r = await fetch(`https://openapi.baidu.com/oauth/2.0/token?grant_type=refresh_token&refresh_token=${j.refresh_token}&client_id=${j.client_id}&client_secret=${j.client_secret}`);
  const t = await r.json();
  if (!t.access_token) throw new Error('token 刷新失败: ' + JSON.stringify(t).slice(0, 120));
  t.client_id = j.client_id; t.client_secret = j.client_secret;
  t.expires_at = Date.now() + (t.expires_in || 2592000) * 1000 - 86400000;
  fs.writeFileSync(OPEN_FILE, JSON.stringify(t, null, 1));
  return t.access_token;
}

async function accessToken() {
  const j = loadOpen();
  if (!j) throw new Error('缺少 bd_open.json（开放平台授权）');
  if (Date.now() > j.expires_at && j.refresh_token) return refreshOpenToken();
  return j.access_token;
}

async function xpanGet(url, { tries = 4 } = {}) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const txt = await r.text();
      if (!txt.trim()) throw new Error('空响应（限流）');
      return JSON.parse(txt);
    } catch (e) {
      lastErr = e;
      await sleep(1000 * 2 ** t);
    }
  }
  throw lastErr;
}

export async function quota() {
  const at = await accessToken();
  const j = await xpanGet(`https://pan.baidu.com/api/quota?access_token=${at}&checkfree=1&checkexpire=1`);
  if (j.errno !== 0) throw new Error('配额查询失败 errno=' + j.errno);
  return { total: j.total, used: j.used, free: j.free ?? (j.total - j.used) };
}

export async function userInfo() {
  const at = await accessToken();
  const j = await xpanGet(`https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${at}`);
  if (j.errno !== 0) throw new Error('用户信息查询失败 errno=' + j.errno);
  return { name: j.baidu_name, avatar: j.avatar_url, vip_type: j.vip_type };
}

// 列目录（自动翻页）。目录不存在返回 null。
export async function listDir(dir) {
  const at = await accessToken();
  const out = [];
  for (let start = 0; ; start += 1000) {
    const j = await xpanGet('https://pan.baidu.com/rest/2.0/xpan/file?method=list&access_token=' + at +
      '&dir=' + encodeURIComponent(dir) + '&order=name&desc=0&start=' + start + '&limit=1000&web=1');
    if (j.errno === -9) return null;
    if (j.errno !== 0) throw new Error(`列目录失败 ${dir} errno=${j.errno}`);
    out.push(...(j.list || []));
    if ((j.list || []).length < 1000) break;
  }
  return out.map(e => ({ name: e.server_filename, isdir: !!e.isdir, size: e.size || 0, mtime: e.server_mtime, path: e.path }));
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

// 递归列出分享里的全部文件。返回 { files: [{ rel, name, size }] } 或 { error }
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
          else files.push({ rel: e.path, name: e.server_filename, size: +e.size });
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

// ---------- 写操作（PCS 接口 + 网页分享转存接口） ----------
async function pcsFile(method, { query = {}, param = null, timeoutSec = 120, signal } = {}) {
  const qs = new URLSearchParams({ app_id: PCS_APP_ID, method, ...query });
  let body;
  if (param !== null) {
    body = new FormData();
    body.append('param', JSON.stringify(param));
  }
  const r = await fetch(`https://pcs.baidu.com/rest/2.0/pcs/file?${qs}`, {
    method: 'POST',
    headers: { 'user-agent': NETDISK_UA, cookie: cookieHeader() },
    body,
    signal: withTimeout(timeoutSec, signal),
  });
  return r.json();
}

export async function mv(src, dst, signal) {
  return writeLock.run(async () => {
    try {
      const j = await pcsFile('move', { param: { list: [{ from: src, to: dst }] }, timeoutSec: 180, signal });
      return !j.error_code;
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      return false;
    }
  });
}

export async function rm(paths, signal) {
  return writeLock.run(async () => {
    try {
      const j = await pcsFile('delete', { param: { list: paths.map(path => ({ path })) }, timeoutSec: 180, signal });
      // 31066 = 文件或目录不存在（幂等视为已删）
      return !j.error_code || j.error_code === 31066;
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      return false;
    }
  });
}

export async function mkdir(dir, signal) {
  return writeLock.run(async () => {
    try {
      const j = await pcsFile('mkdir', { query: { path: dir }, timeoutSec: 60, signal });
      // 31061 = 目录已存在
      return !j.error_code || j.error_code === 31061;
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      return false;
    }
  });
}

// 转存一个分享到 destDir。返回 { status, detail }
// status: saved | exists | invalid | err_quota | err_pwd | err_<code> | exc
export async function transferOne(surl, pwd, destDir, { timeoutSec = 180, signal } = {}) {
  return writeLock.run(async () => {
    const sig = withTimeout(timeoutSec, signal);
    try {
      const dirRes = await pcsFile('mkdir', { query: { path: destDir }, timeoutSec: 60, signal: sig });
      if (dirRes.error_code && dirRes.error_code !== 31061) {
        return { status: 'err_cd', detail: `目标目录不可用 (${dirRes.error_code}): ${dirRes.error_msg || destDir}`.slice(0, 160) };
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
      if (tj.errno === 0) return { status: 'saved' };
      if (tj.errno === 4 || tj.errno === -8 || tj.errno === -30) return { status: 'exists' };
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
        if (subErrs.length > 0 && subErrs.every(e => e === -30 || e === -8)) return { status: 'exists' };
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
