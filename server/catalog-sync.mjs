// PS 游戏目录同步：从 andshrew/PlayStation-Titles 下载全量 titleId → conceptId 映射，生成 state/panplay-catalog.json
// 首次启动缺文件时立即下载，之后文件超过 7 天自动重新下载；下载成功后重新加载目录并补抓封面
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.mjs';
import { initCatalog } from './catalog.mjs';

export const CATALOG_FILE = path.join(STATE_DIR, 'panplay-catalog.json');
const MAX_AGE_MS = 7 * 86400_000;
const CHECK_INTERVAL_MS = 10 * 60_000;
const RETRY_MS = 30 * 60_000;
const UPSTREAM = 'PlayStation-Titles (MIT) — https://github.com/andshrew/PlayStation-Titles';
// 国内直连 raw.githubusercontent.com 经常不通，jsDelivr 镜像优先
const DEFAULT_URLS = [
  'https://cdn.jsdelivr.net/gh/andshrew/PlayStation-Titles@main/Json/All_Titles.json',
  'https://fastly.jsdelivr.net/gh/andshrew/PlayStation-Titles@main/Json/All_Titles.json',
  'https://raw.githubusercontent.com/andshrew/PlayStation-Titles/main/Json/All_Titles.json',
];

let running = null;
let lastFailAt = 0;

const sourceUrls = () => process.env.PS5WATCH_CATALOG_URL ? [process.env.PS5WATCH_CATALOG_URL] : DEFAULT_URLS;

function fileAgeMs() {
  try { return Date.now() - fs.statSync(CATALOG_FILE).mtimeMs; } catch { return Infinity; }
}

function convert(rows, from) {
  const titles = {};
  for (const r of rows) {
    const m = String(r?.titleId || '').toUpperCase().match(/(PPSA|CUSA)\d{5}/);
    if (!m || !r.name) continue;
    const id = m[0];
    const e = { n: r.name };
    if (Number(r.conceptId)) e.c = Number(r.conceptId);
    if (r.region) e.r = r.region;
    if (r.publisherId) e.p = r.publisherId;
    e.x = id.startsWith('PPSA') ? 'ps5' : 'ps4';
    titles[id] = e;
  }
  return { version: 1, source: UPSTREAM, generated_at: new Date().toISOString(), generated_from: from, titles, count: Object.keys(titles).length };
}

async function download() {
  const errors = [];
  for (const url of sourceUrls()) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'pan-shelf-catalog-sync/1.0' }, signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length < 1000) throw new Error('上游数据格式不符合预期');
      const out = convert(rows, url);
      const tmp = `${CATALOG_FILE}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, CATALOG_FILE);
      return out.count;
    } catch (e) {
      errors.push(`${new URL(url).host}: ${e.message}`);
    }
  }
  throw new Error(errors.join('；'));
}

export function syncCatalog({ force = false } = {}) {
  if (running) return running;
  if (!force && fileAgeMs() < MAX_AGE_MS) return Promise.resolve(null);
  running = download()
    .then((count) => {
      console.log(`游戏目录已更新：${count} 个游戏编号`);
      initCatalog();
      return count;
    })
    .catch((e) => {
      lastFailAt = Date.now();
      console.warn(`游戏目录下载失败（${e.message}），${RETRY_MS / 60_000} 分钟后重试`);
      return null;
    })
    .finally(() => { running = null; });
  return running;
}

export function startCatalogSync() {
  const tick = () => {
    if (Date.now() - lastFailAt < RETRY_MS) return;
    syncCatalog();
  };
  setTimeout(tick, 2000);
  setInterval(tick, CHECK_INTERVAL_MS);
}
