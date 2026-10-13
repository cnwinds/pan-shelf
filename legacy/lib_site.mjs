// lib_site.mjs — 2468c.com 抓取：反爬双跳 + cookie 持久化 + 限速重试
// 经验：该站并发会被 IP 硬封（连接重置），必须串行 + >=5s 间隔
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const JAR = path.join(ROOT, 'state', 'site_cookies.txt');
export const MIN_INTERVAL_MS = 5500;
let lastReq = 0;

fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });

async function curlOnce(url, out, timeoutSec) {
  try {
    await run('curl', ['-s', '-L', '--max-time', String(timeoutSec || 40), '-A', UA,
      '-b', JAR, '-c', JAR, url, '-o', out], { windowsHide: true });
  } catch { /* 超时/连接失败：按 0 字节处理 */ }
  try { return fs.statSync(out).size; } catch { return 0; }
}

// 抓页面，带反爬处理与重试。成功返回 html 字符串，失败返回 null
export async function fetchSite(url, { timeoutSec = 40, retries = 3 } = {}) {
  const tmp = path.join(ROOT, 'state', '.fetch.tmp');
  for (let i = 0; i < retries; i++) {
    // 全局限速
    const wait = lastReq + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastReq = Date.now();
    let n = await curlOnce(url, tmp, timeoutSec);
    if (n > 5000) return fs.readFileSync(tmp, 'utf8');
    // 反爬挑战（小页面）：访问一次首页刷新会话再试
    lastReq = Date.now();
    await curlOnce(new URL(url).origin + '/', tmp, 20);
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// 从列表页 HTML 提取帖子 URL
export function extractPostUrls(html, origin) {
  const re = /https?:\/\/[^"'\s<>]+\/(\d+)\.html/g;
  const out = new Map();
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith(origin)) out.set(m[1], m[0]);
  }
  return out; // id -> url
}

// 从详情页 HTML 提取百度盘链接（二维码 URL 是编码形态）与标题
export function extractLinks(html) {
  const tm = html.match(/<title>([^<]*)<\/title>/);
  const title = tm ? tm[1].replace(/-奥德彪计划$/, '').trim() : '';
  const links = new Map();
  const re = /pan\.baidu\.com(?:%2F|\/)s(?:%2F|\/)([A-Za-z0-9_-]+)(?:%3Fpwd%3D|\?pwd=)([a-z0-9]+)/g;
  let m;
  while ((m = re.exec(html))) links.set(m[1], m[2]);
  if (links.size === 0) {
    const pwdBox = html.match(/bdp-pwd-box">提取码:\s*<strong>([a-z0-9]+)/i);
    const plain = /pan\.baidu\.com\/s\/([A-Za-z0-9_-]+)/g;
    while ((m = plain.exec(html))) if (!links.has(m[1])) links.set(m[1], pwdBox ? pwdBox[1] : '');
  }
  return { title, links: [...links.entries()].map(([surl, pwd]) => ({ surl, pwd })) };
}
