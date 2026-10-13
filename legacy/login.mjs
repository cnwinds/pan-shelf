#!/usr/bin/env node
// login.mjs — 弹出独立浏览器窗口显示百度盘登录页，用户扫码后
// 通过 CDP 读取 HttpOnly 的 BDUSS/STOKEN 写入 bduss.txt
// 每轮轮询自动重连页面目标，容忍页面跳转/弹窗抖动
// 用法: node login.mjs [--keep]   (--keep: 登录后不关闭浏览器)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(ROOT, 'state', 'browser-profile');
const PORT = 9333;
const OUT = path.join(ROOT, 'bduss.txt');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const browser = CANDIDATES.find(p => fs.existsSync(p));
if (!browser) { console.error('未找到 Edge/Chrome'); process.exit(1); }
fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });

async function getJson(url) {
  try { return JSON.parse(await (await fetch(url)).text()); } catch { return null; }
}

// 清理上次残留的同 profile 浏览器进程（否则 profile 锁冲突会秒退）
function killStale() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object {$_.CommandLine -like '*${PROFILE.replace(/\\/g, '\\\\').replace(/'/g, "''")}*'} | Select-Object -ExpandProperty ProcessId`],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    out.trim().split(/\s+/).filter(Boolean).forEach(pid => {
      try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); } catch {}
    });
    if (out.trim()) console.log('已清理残留浏览器进程:', out.trim().replace(/\s+/g, ' '));
  } catch {}
}
killStale();
await sleep(500);

// 已有调试端口在监听则直接复用，不再新起
let child = null;
const existing = await getJson(`http://127.0.0.1:${PORT}/json/version`);
if (existing) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/new?https://pan.baidu.com/`, { method: 'PUT' }); } catch {}
  console.log('复用已运行的调试浏览器');
} else {
  child = spawn(browser, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=900,760',
    'https://pan.baidu.com/',
  ], { detached: false, stdio: 'ignore' });
}
console.log('浏览器:', browser);
console.log('已弹出登录窗口，请扫码登录百度盘（等待最多 5 分钟）...');

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

async function main() {
  const deadline = Date.now() + 5 * 60 * 1000;
  let conn = null, lastClick = 0;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) { console.error('浏览器窗口被关闭，未完成登录。请重跑: node login.mjs'); process.exit(1); }
    const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
    const page = (targets || []).find(t => t.type === 'page' && /baidu\.com/.test(t.url));
    if (!page) { await sleep(1500); continue; }
    if (!conn || conn.ws.dead) {
      try { conn = await connect(page.webSocketDebuggerUrl); await conn.send('Network.enable'); }
      catch { conn = null; await sleep(1500); continue; }
    }
    // 每 8 秒尝试点一次「去登录」（登录弹窗可能因刷新消失）
    if (Date.now() - lastClick > 8000) {
      lastClick = Date.now();
      await conn.send('Runtime.evaluate', {
        expression: `(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('去登录')); if(b){b.click();return true} return false})()`,
      }).catch(() => {});
    }
    const r = await conn.send('Network.getCookies', { urls: ['https://pan.baidu.com/', 'https://passport.baidu.com/'] });
    const cookies = r?.result?.cookies || [];
    const get = (n) => cookies.find(c => c.name === n)?.value;
    if (get('BDUSS') && get('STOKEN')) {
      fs.writeFileSync(OUT, `BDUSS=${get('BDUSS')}\nSTOKEN=${get('STOKEN')}\n`);
      console.log('✓ 登录成功，BDUSS/STOKEN 已写入 bduss.txt，会话已保存在浏览器配置中');
      if (!KEEP) {
        // 优雅关闭（强杀会丢失刚写入的会话 cookie！）
        try { conn.ws.close(); } catch {}
        try {
          const ver = await getJson(`http://127.0.0.1:${PORT}/json/version`);
          if (ver?.webSocketDebuggerUrl) {
            const bws = new WebSocket(ver.webSocketDebuggerUrl);
            await new Promise(r => { bws.onopen = r; bws.onerror = r; setTimeout(r, 2000); });
            bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
            await sleep(3000);
            try { bws.close(); } catch {}
          }
        } catch {}
        // 兜底：残留才强杀
        killStale();
        console.log('浏览器窗口已关闭。');
      }
      process.exit(0);
    }
    await sleep(2000);
  }
  console.error('超时未登录。可重跑: node login.mjs');
  process.exit(1);
}

main().catch(e => { console.error(String(e)); process.exit(1); });
