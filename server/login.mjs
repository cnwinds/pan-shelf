// 扫码登录：在本机弹出独立浏览器窗口打开百度网盘，用户扫码后通过 CDP 读取 HttpOnly 的 BDUSS/STOKEN，
// 写入 bduss.txt 并校验网盘登录态。BDUSS 是会话 cookie，浏览器必须优雅关闭，强杀会丢失。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { BROWSER_PROFILE, BDUSS_FILE } from './paths.mjs';
import { verifyLogin } from './baidu.mjs';
import { sleep } from './util.mjs';
import { bus } from './bus.mjs';

const PORT = 9333;
const TIMEOUT_MS = 5 * 60 * 1000;

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

let state = { status: 'idle', message: '', at: null };
let cancelRequested = false;

const set = (status, message) => {
  state = { status, message, at: new Date().toISOString() };
  bus.emit('login', state);
};
export const loginState = () => state;

async function getJson(url) {
  try { return JSON.parse(await (await fetch(url, { signal: AbortSignal.timeout(3000) })).text()); } catch { return null; }
}

function killStale() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object {$_.CommandLine -like '*${BROWSER_PROFILE.replace(/'/g, "''")}*'} | Select-Object -ExpandProperty ProcessId`],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true });
    out.trim().split(/\s+/).filter(Boolean).forEach(pid => {
      try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    });
  } catch {}
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(rej, 3000); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  ws.onclose = () => { ws.dead = true; pending.forEach(f => f(null)); pending.clear(); };
  const send = (method, params = {}) => new Promise(res => {
    if (ws.dead || ws.readyState !== 1) return res(null);
    const mid = ++id;
    const t = setTimeout(() => { pending.delete(mid); res(null); }, 5000);
    pending.set(mid, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { send, ws };
}

async function closeBrowserGracefully() {
  const ver = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  if (ver?.webSocketDebuggerUrl) {
    try {
      const bws = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise(r => { bws.onopen = r; bws.onerror = r; setTimeout(r, 2000); });
      bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await sleep(3000);
      try { bws.close(); } catch {}
    } catch {}
  }
  killStale();
}

export function cancelLogin() {
  if (state.status === 'waiting') cancelRequested = true;
}

export async function startLogin() {
  if (state.status === 'waiting' || state.status === 'starting') return state;
  const browser = CANDIDATES.find(p => p && fs.existsSync(p));
  if (!browser) { set('failed', '未找到 Chrome 或 Edge 浏览器'); return state; }
  cancelRequested = false;
  set('starting', '正在打开登录窗口');
  run(browser).catch(e => set('failed', String(e.message || e)));
  return state;
}

async function run(browser) {
  killStale();
  await sleep(500);
  const child = spawn(browser, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${BROWSER_PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=900,760', 'https://pan.baidu.com/',
  ], { detached: false, stdio: 'ignore' });
  set('waiting', '已在本机弹出浏览器窗口，请用百度网盘 App 扫码登录（5 分钟内有效）');

  const deadline = Date.now() + TIMEOUT_MS;
  let conn = null, lastClick = 0;
  while (Date.now() < deadline) {
    if (cancelRequested) { await closeBrowserGracefully(); set('cancelled', '已取消登录'); return; }
    if (child.exitCode !== null) { set('failed', '登录窗口被关闭，未完成登录'); return; }
    const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
    const page = (targets || []).find(t => t.type === 'page' && /baidu\.com/.test(t.url));
    if (!page) { await sleep(1500); continue; }
    if (!conn || conn.ws.dead) {
      try { conn = await connect(page.webSocketDebuggerUrl); await conn.send('Network.enable'); }
      catch { conn = null; await sleep(1500); continue; }
    }
    if (Date.now() - lastClick > 8000) {
      lastClick = Date.now();
      await conn.send('Runtime.evaluate', {
        expression: `(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('去登录')); if(b){b.click();return true} return false})()`,
      });
    }
    const r = await conn.send('Network.getCookies', { urls: ['https://pan.baidu.com/', 'https://passport.baidu.com/'] });
    const cookies = r?.result?.cookies || [];
    const get = (n) => cookies.find(c => c.name === n)?.value;
    if (get('BDUSS') && get('STOKEN')) {
      fs.writeFileSync(BDUSS_FILE, `BDUSS=${get('BDUSS')}\nSTOKEN=${get('STOKEN')}\n`);
      try { conn.ws.close(); } catch {}
      await closeBrowserGracefully();
      const ok = await verifyLogin();
      set(ok ? 'success' : 'failed', ok ? '登录成功' : '已拿到凭据，但网盘登录态校验失败，请重试');
      bus.emit('account-changed');
      return;
    }
    await sleep(2000);
  }
  await closeBrowserGracefully();
  set('failed', '超时未完成扫码');
}
