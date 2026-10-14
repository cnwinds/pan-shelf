// 网盘扫码登录（纯 HTTP，无需本机浏览器，Linux 服务器上同样可用）：
//   1. passport getqrcode 拿到二维码与 sign，交给前端展示
//   2. 长轮询 channel/unicast，等手机端百度网盘 App 扫码并确认，拿到临时凭据 v
//   3. qrbdusslogin 用 v 换取 BDUSS / PTOKEN
//   4. 走 passport auth 跳转到 pan.baidu.com，拿到网盘域下的 STOKEN
//   5. 校验通过后写入 bduss.txt
import fs from 'node:fs';
import { BDUSS_FILE } from './paths.mjs';
import { whoami } from './baidu.mjs';
import { bus } from './bus.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PASSPORT = 'https://passport.baidu.com';
const PAN_HOME = 'https://pan.baidu.com/disk/home';
const TIMEOUT_MS = 5 * 60 * 1000;

let state = { status: 'idle', message: '', at: null };
let runId = 0;

const set = (status, message, extra = {}) => {
  state = { status, message, at: new Date().toISOString(), ...extra };
  bus.emit('login', state);
};
export const loginState = () => state;

export function cancelLogin() {
  if (!['starting', 'waiting', 'scanned'].includes(state.status)) return;
  runId++;
  set('cancelled', '已取消登录');
}

// ---------- 按域名区分的简易 cookie 罐（passport 与 pan 各有一个 STOKEN） ----------
class Jar {
  list = [];
  absorb(res, url) {
    const host = new URL(url).hostname;
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const domAttr = attrs.map(a => a.trim()).find(a => /^domain=/i.test(a));
      const domain = (domAttr ? domAttr.slice(7) : host).replace(/^\./, '').toLowerCase();
      this.list = this.list.filter(c => !(c.name === name && c.domain === domain));
      if (value && !/^deleted$/i.test(value)) this.list.push({ name, value, domain });
    }
  }
  header(url) {
    const host = new URL(url).hostname;
    return this.list.filter(c => host === c.domain || host.endsWith('.' + c.domain)).map(c => `${c.name}=${c.value}`).join('; ');
  }
  // 取对 host 生效的同名 cookie 中域名最具体的那个
  get(name, host = 'baidu.com') {
    return this.list
      .filter(c => c.name === name && (host === c.domain || host.endsWith('.' + c.domain)))
      .sort((a, b) => b.domain.length - a.domain.length)[0]?.value;
  }
}

async function go(jar, url, { signal, redirects = 8 } = {}) {
  let cur = url;
  for (let i = 0; i <= redirects; i++) {
    const res = await fetch(cur, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': UA, referer: 'https://pan.baidu.com/', cookie: jar.header(cur) },
    });
    jar.absorb(res, cur);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).toString();
      continue;
    }
    return { res, url: cur, text: await res.text() };
  }
  throw new Error('跳转次数过多');
}

const parseJsonp = (txt) => {
  const s = txt.trim();
  const m = s.match(/^[\w$.]*\(([\s\S]*)\)\s*;?$/);
  return JSON.parse(m ? m[1] : s);
};

export async function startLogin() {
  if (['starting', 'waiting', 'scanned'].includes(state.status)) return state;
  const id = ++runId;
  set('starting', '正在获取登录二维码');
  run(id).catch(e => { if (id === runId) set('failed', String(e.message || e)); });
  return state;
}

async function run(id) {
  const jar = new Jar();
  const gid = crypto.randomUUID().toUpperCase();
  const t = () => Date.now();
  const q = await go(jar, `${PASSPORT}/v2/api/getqrcode?lp=pc&qrloginfrom=pc&gid=${gid}&apiver=v3&tt=${t()}&tpl=netdisk&_=${t()}`);
  const qj = parseJsonp(q.text);
  if (!qj.sign || !qj.imgurl) throw new Error('获取登录二维码失败');
  const expiresAt = Date.now() + TIMEOUT_MS;
  const qr = { qrcode_url: `https://${String(qj.imgurl).replace(/^https?:\/\//, '')}`, expires_at: new Date(expiresAt).toISOString() };
  if (id !== runId) return;
  set('waiting', '请用百度网盘 App 扫码登录', qr);

  let v = null;
  while (Date.now() < expiresAt) {
    if (id !== runId) return;
    let pj;
    try {
      const p = await go(jar, `${PASSPORT}/channel/unicast?channel_id=${qj.sign}&tpl=netdisk&gid=${gid}&apiver=v3&tt=${t()}&_=${t()}`, { signal: AbortSignal.timeout(45000) });
      pj = parseJsonp(p.text);
    } catch {
      continue;
    }
    if (id !== runId) return;
    if (pj.errno !== 0 || !pj.channel_v) continue;
    const cv = JSON.parse(pj.channel_v);
    if (cv.status === 1) { if (state.status !== 'scanned') set('scanned', '已扫码，请在手机上确认登录', qr); continue; }
    if (cv.status === 2) { set('failed', '已在手机上取消登录'); return; }
    if (cv.status === 0 && cv.v) { v = cv.v; break; }
  }
  if (!v) { if (id === runId) set('failed', '二维码已过期，请重新获取'); return; }

  set('starting', '已确认，正在获取网盘登录态', qr);
  const login = await go(jar, `${PASSPORT}/v3/login/main/qrbdusslogin?v=${t()}&bduss=${encodeURIComponent(v)}&u=${encodeURIComponent(PAN_HOME)}&loginVersion=v4&qrcode=1&tpl=netdisk&apiver=v3&tt=${t()}&time=${Math.floor(t() / 1000)}&alg=v3`);
  const bduss = jar.get('BDUSS', 'pan.baidu.com');
  if (!bduss) {
    console.warn('[login] qrbdusslogin 未返回 BDUSS:', login.res.status, login.text.slice(0, 200));
    throw new Error('换取 BDUSS 失败，请重试');
  }

  await go(jar, `${PASSPORT}/v3/login/api/auth/?return_type=5&tpl=netdisk&u=${encodeURIComponent(PAN_HOME)}`);
  let stoken = jar.get('STOKEN', 'pan.baidu.com');
  if (!stoken) {
    await go(jar, PAN_HOME);
    stoken = jar.get('STOKEN', 'pan.baidu.com');
  }
  console.log('[login] cookies:', jar.list.map(c => `${c.name}@${c.domain}`).join(', '));
  if (id !== runId) return;
  await finish({ bduss, stoken });
}

async function finish(creds) {
  if (!creds.stoken) {
    set('failed', '未能获取网盘 STOKEN，请重试或改用手动填写');
    return false;
  }
  const who = await whoami(creds);
  if (!who) {
    set('failed', '已拿到凭据，但网盘登录态校验失败，请重试');
    return false;
  }
  fs.writeFileSync(BDUSS_FILE, `BDUSS=${creds.bduss}\nSTOKEN=${creds.stoken}\n`);
  set('success', `登录成功（${who.name}）`);
  bus.emit('account-changed');
  return true;
}

// 手动填写：在浏览器登录 pan.baidu.com 后，从开发者工具的 Cookie 里复制 BDUSS 与 STOKEN
export async function saveManualLogin({ bduss, stoken }) {
  const b = String(bduss || '').trim().replace(/^BDUSS=/, '');
  const s = String(stoken || '').trim().replace(/^STOKEN=/, '');
  if (!b) throw new Error('BDUSS 不能为空');
  if (!s) throw new Error('STOKEN 不能为空（转存需要）');
  runId++;
  const ok = await finish({ bduss: b, stoken: s });
  if (!ok) throw new Error('凭据无效：网盘登录态校验失败');
  return state;
}
