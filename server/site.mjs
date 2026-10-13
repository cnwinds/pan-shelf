// 站点抓取：curl + cookie jar 过反爬双跳；按域名全局串行限速。
// 经验：2468c.com 并发 >1 会触发 IP 硬封（连接重置、0 字节），所以同一域名永远只有一个在途请求。
import { execFile } from 'node:child_process';
import { SITE_COOKIE_JAR } from './paths.mjs';
import { getSettings } from './settings.mjs';
import { Mutex, nowIso } from './util.mjs';
import { bus } from './bus.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_PAGE_BYTES = 5000;

const hosts = new Map(); // host -> { mutex, lastReq, health }

function hostState(host) {
  if (!hosts.has(host)) hosts.set(host, { mutex: new Mutex(), lastReq: 0, health: { host, ok_at: null, fail_streak: 0, blocked: false, last_error: null, checked_at: null } });
  return hosts.get(host);
}

export const siteHealth = () => [...hosts.values()].map(h => h.health);
export const hostHealth = (url) => hostState(new URL(url).host).health;

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function curl(url, timeoutSec, signal) {
  return new Promise((resolve) => {
    execFile('curl', ['-s', '-L', '--compressed', '--max-time', String(timeoutSec), '-A', UA, '-b', SITE_COOKIE_JAR, '-c', SITE_COOKIE_JAR, url],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, signal },
      (err, stdout) => resolve({ body: stdout || '', err: err && !stdout ? (err.code === 'ABORT_ERR' ? 'aborted' : `curl exit ${err.code}`) : null }));
  });
}

async function paced(h, signal, extraJitter = true) {
  const c = getSettings().crawl;
  const gap = c.detail_interval_sec * 1000 + (extraJitter ? Math.random() * c.jitter_sec * 1000 : 0);
  const wait = h.lastReq + gap - Date.now();
  if (wait > 0) await abortableSleep(wait, signal);
  h.lastReq = Date.now();
}

// 抓页面：成功返回 html，失败返回 null。signal 用于任务取消。
export async function fetchSite(url, { signal, retries } = {}) {
  const host = new URL(url).host;
  const h = hostState(host);
  return h.mutex.run(async () => {
    const c = getSettings().crawl;
    const n = retries ?? c.retries;
    let lastErr = null;
    for (let i = 0; i < n; i++) {
      await paced(h, signal);
      const { body, err } = await curl(url, c.timeout_sec, signal);
      if (signal?.aborted) throw signal.reason;
      if (body.length > MIN_PAGE_BYTES) {
        Object.assign(h.health, { ok_at: nowIso(), fail_streak: 0, blocked: false, last_error: null, checked_at: nowIso() });
        bus.emit('site', h.health);
        return body;
      }
      lastErr = err || `响应过小（${body.length} 字节，可能是反爬挑战或封禁）`;
      // 反爬挑战：访问首页刷新 cookie 会话后再试
      await paced(h, signal, false);
      await curl(new URL(url).origin + '/', 20, signal);
      await abortableSleep(2000, signal);
    }
    h.health.fail_streak++;
    h.health.last_error = lastErr;
    h.health.checked_at = nowIso();
    if (h.health.fail_streak >= c.block_threshold) h.health.blocked = true;
    bus.emit('site', h.health);
    return null;
  });
}

