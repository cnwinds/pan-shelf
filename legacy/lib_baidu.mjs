// lib_baidu.mjs — 百度盘操作（无浏览器架构，全部实测可用）：
//   转存   : BaiduPCS-Go.exe transfer <链接> <提取码>（转存到其工作目录）
//   列表   : 开放平台 xpan file?method=list + access_token（bd_open.json，自动续期）
//   改/移/删/建: BaiduPCS-Go.exe mv / rm / mkdir
//   登录维护 : login.mjs 扫码 → bduss.txt → bpcs login -bduss -stoken（本模块 ensureBpcsLogin）
// 历史经验（保留备查）：
//   - curl 直调 pan.baidu.com/api/* 会被 TLS 指纹拒绝(-6)；xpan 开放接口不受影响
//   - verify 的 surl 去前导 1；sekey(randsk) 已编码勿二次 encode；/share/list 已废弃
//   - move 的 filelist 是 {path,dest,newname}；文件名冲突(errno12)不分大小写
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const BPCS = path.join(ROOT, 'bin', 'BaiduPCS-Go.exe');
const OPEN = path.join(ROOT, 'bd_open.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 开放平台 token ----------
function loadOpen() {
  if (!fs.existsSync(OPEN)) return null;
  const j = JSON.parse(fs.readFileSync(OPEN, 'utf8'));
  j.expires_at = j.expires_at || (Date.now() + (j.expires_in || 2592000) * 1000 - 86400000);
  return j;
}
async function accessToken() {
  const j = loadOpen();
  if (!j) throw new Error('缺 bd_open.json（开放平台授权）');
  if (Date.now() > j.expires_at && j.refresh_token) {
    const r = await fetch(`https://openapi.baidu.com/oauth/2.0/token?grant_type=refresh_token&refresh_token=${j.refresh_token}&client_id=${j.client_id}&client_secret=${j.client_secret}`);
    const t = await r.json();
    if (t.access_token) {
      t.client_id = j.client_id; t.client_secret = j.client_secret;
      t.expires_at = Date.now() + (t.expires_in || 2592000) * 1000 - 86400000;
      fs.writeFileSync(OPEN, JSON.stringify(t, null, 1));
      return t.access_token;
    }
    throw new Error('token 刷新失败: ' + JSON.stringify(t).slice(0, 100));
  }
  return j.access_token;
}

// ---------- BaiduPCS-Go 封装 ----------
async function bpcs(args, { timeoutSec = 120 } = {}) {
  const { stdout } = await run(BPCS, args, { windowsHide: true, timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// 用 bduss.txt 里的 cookie 登录 BaiduPCS-Go（幂等，登录态失效时调用）
export async function ensureBpcsLogin() {
  const f = path.join(ROOT, 'bduss.txt');
  if (!fs.existsSync(f)) return false;
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'));
  const bduss = lines.find(l => l.startsWith('BDUSS='))?.slice(6).trim();
  const stoken = lines.find(l => l.startsWith('STOKEN='))?.slice(7).trim();
  if (!bduss) return false;
  const out = await bpcs(['login', '-bduss=' + bduss, '-stoken=' + (stoken || '')]);
  return out.includes('登录成功');
}

let workdir = null;
export async function setWorkdir(dir) {
  if (workdir === dir) return;
  const out = await bpcs(['cd', dir]);
  if (out.includes('改变工作目录') || out.includes(dir)) workdir = dir;
  else throw new Error('cd 失败: ' + out.slice(0, 100));
}

export async function isLoggedIn() {
  try { const out = await bpcs(['who']); return out.includes('uid'); }
  catch { return false; }
}

export async function getBdstoken() { return ''; } // 兼容旧签名，不再需要

// ---------- 列表（xpan 开放接口） ----------
export async function listDir(dir, _bt) {
  const at = await accessToken();
  const r = await fetch('https://pan.baidu.com/rest/2.0/xpan/file?method=list&access_token=' + at +
    '&dir=' + encodeURIComponent(dir) + '&order=name&desc=0&start=0&limit=1000');
  const j = await r.json();
  return j.errno === 0 ? j.list : null;
}

// ---------- 文件管理（BaiduPCS-Go mv/rm） ----------
// filelist 结构与网页 API 一致：rename [{path,newname}] / move [{path,dest,newname}] / delete [path]
export async function filemanager(opera, filelist, _bt) {
  if (opera === 'delete') {
    const out = await bpcs(['rm', ...filelist], { timeoutSec: 180 });
    return { errno: out.includes('操作成功') || out.includes('已删除') ? 0 : 1, info: [] };
  }
  // rename / move 都用 mv（目标为完整新路径）
  const pairs = filelist.map(x => {
    const parent = opera === 'rename' ? x.path.slice(0, x.path.lastIndexOf('/')) : x.dest;
    return [x.path, parent + '/' + x.newname];
  });
  let ok = 0;
  for (const [src, dst] of pairs) {
    try {
      const out = await bpcs(['mv', src, dst], { timeoutSec: 180 });
      if (out.includes('成功')) ok++;
    } catch {}
  }
  return { errno: ok === pairs.length ? 0 : 12, info: [] };
}

// ---------- 转存 ----------
export async function transferOne(surlFull, pwd, destDir, _bt) {
  try {
    await setWorkdir(destDir);
    const url = 'https://pan.baidu.com/s/' + surlFull;
    const out = await bpcs(['transfer', url, pwd || ''], { timeoutSec: 180 });
    if (out.includes('转存到网盘成功')) return { st: 'saved' };
    if (out.includes('文件重复') || out.includes('已经存在')) return { st: 'exists' };
    if (out.includes('失效') || out.includes('不存在')) return { st: 'invalid' };
    const m = out.match(/代码:\s*(-?\d+),\s*消息:\s*([^\r\n]*)/);
    return { st: 'err_' + (m ? m[1] : 'unknown'), raw: out.slice(0, 160).replace(/\s+/g, ' ') };
  } catch (e) {
    return { st: 'exc_' + String(e).slice(0, 80) };
  }
}

export async function closeBrowser() {} // 兼容旧签名

// 调试用：暴露当前页面 CDP 连接（discover_dirsize.mjs 用）
export function __connForDebug() {
  if (!conn) throw new Error('browser not started');
  return conn;
}
