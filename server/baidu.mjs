// 百度盘操作：
//   转存 / 改名 / 移动 / 删除 → BaiduPCS-Go（Go TLS 能过百度的指纹墙；curl/Node fetch 调网页接口会 -6）
//   列表 / 配额 / 用户信息   → xpan 开放平台（bd_open.json，access_token 自动续期）
// 开放平台应用只有「应用目录写权限」，所以所有写操作必须走 BaiduPCS-Go。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { BPCS_EXE, BDUSS_FILE, OPEN_FILE } from './paths.mjs';
import { Mutex, sleep } from './util.mjs';

const bpcsLock = new Mutex();

function bpcsRaw(args, timeoutSec = 120, signal) {
  return new Promise((resolve, reject) => {
    execFile(BPCS_EXE, args, { windowsHide: true, timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', signal },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(err.code === 'ABORT_ERR' ? signal.reason : new Error(`BaiduPCS-Go ${args[0]} 失败: ${String(stderr || err.message).slice(0, 200)}`));
        resolve(stdout || '');
      });
  });
}

// BaiduPCS-Go 的工作目录是全局状态，cd + transfer 必须原子执行
export const bpcs = (args, opts = {}) => bpcsLock.run(() => bpcsRaw(args, opts.timeoutSec, opts.signal));

// ---------- 登录态 ----------
export function readBduss() {
  if (!fs.existsSync(BDUSS_FILE)) return null;
  const lines = fs.readFileSync(BDUSS_FILE, 'utf8').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'));
  const bduss = lines.find(l => l.startsWith('BDUSS='))?.slice(6).trim();
  const stoken = lines.find(l => l.startsWith('STOKEN='))?.slice(7).trim();
  return bduss ? { bduss, stoken } : null;
}

export async function ensureBpcsLogin() {
  const c = readBduss();
  if (!c) return false;
  const out = await bpcs(['login', '-bduss=' + c.bduss, '-stoken=' + (c.stoken || '')]);
  return out.includes('登录成功');
}

export async function whoami() {
  try {
    // who 只读本地配置，不加锁，避免被长时间的转存阻塞
    const out = await bpcsRaw(['who'], 30);
    const m = out.match(/uid:\s*(\d+),\s*用户名:\s*([^,\r\n]+)/);
    return m ? { uid: m[1], name: m[2].trim() } : null;
  } catch { return null; }
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
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SHARE_ERR = { '-9': '提取码错误', '-62': '需要验证码（请求太频繁）', '105': '链接已失效', '-7': '链接已失效', '117': '链接已过期', '-12': '提取码错误' };

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
        const j = await (await fetch(`https://pan.baidu.com/share/list?web=1&app_id=250528&shorturl=${short}&${q}&page=${page}&num=100&order=name&desc=0&showempty=0`,
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

// ---------- 写操作（BaiduPCS-Go） ----------
export async function mv(src, dst, signal) {
  const out = await bpcs(['mv', src, dst], { timeoutSec: 180, signal });
  return out.includes('成功');
}

export async function rm(paths, signal) {
  const out = await bpcs(['rm', ...paths], { timeoutSec: 180, signal });
  return out.includes('操作成功') || out.includes('已删除');
}

export async function mkdir(dir, signal) {
  const out = await bpcs(['mkdir', dir], { timeoutSec: 60, signal });
  return out.includes('成功') || out.includes('已存在');
}

// 转存一个分享到 destDir。返回 { status, detail }
// status: saved | exists | invalid | err_quota | err_<code> | exc
export async function transferOne(surl, pwd, destDir, { timeoutSec = 180, signal } = {}) {
  return bpcsLock.run(async () => {
    try {
      const cd = await bpcsRaw(['cd', destDir], 60, signal);
      if (!cd.includes('改变工作目录') && !cd.includes(destDir)) {
        await bpcsRaw(['mkdir', destDir], 60, signal);
        const cd2 = await bpcsRaw(['cd', destDir], 60, signal);
        if (!cd2.includes('改变工作目录') && !cd2.includes(destDir)) return { status: 'err_cd', detail: cd2.slice(0, 160).trim() };
      }
      const out = await bpcsRaw(['transfer', 'https://pan.baidu.com/s/' + surl, pwd || ''], timeoutSec, signal);
      const flat = out.replace(/\s+/g, ' ').trim();
      if (out.includes('转存到网盘成功')) return { status: 'saved' };
      if (out.includes('文件重复') || out.includes('已经存在')) return { status: 'exists' };
      if (/空间不足|容量不足|超出.*容量|quota/i.test(out)) return { status: 'err_quota', detail: flat.slice(0, 160) };
      if (out.includes('失效') || out.includes('不存在') || out.includes('已被删除') || out.includes('取消分享')) return { status: 'invalid', detail: flat.slice(0, 160) };
      if (out.includes('提取码')) return { status: 'err_pwd', detail: flat.slice(0, 160) };
      const m = out.match(/代码:\s*(-?\d+),\s*消息:\s*([^\r\n]*)/);
      return { status: 'err_' + (m ? m[1] : 'unknown'), detail: flat.slice(0, 160) };
    } catch (e) {
      if (signal?.aborted) throw e;
      return { status: 'exc', detail: String(e.message || e).slice(0, 160) };
    }
  });
}
