// 盘游的资源库：把能转存的游戏写成网盘里的 /盘游/资源库.json。盘游据此列出全部游戏，点安装时自己转存，
// 网盘空间也由盘游按需腾（盘游 docs/adr/0011）。内容有变化才上传。
import crypto from 'node:crypto';
import { all, one, exec } from './db.mjs';
import * as bd from './baidu.mjs';
import { bus } from './bus.mjs';
import { listSources } from './sources.mjs';
import { enrichGameRow } from './catalog.mjs';
import { classify, cmpVer, FORMAT_DIR } from './linkpick.mjs';
import { linkFormat } from './layout.mjs';
import { shareMatches } from './reviews.mjs';
import { nowIso } from './util.mjs';

// 盘游也按这个位置和格式读，改了要两边一起改
export const LIBRARY_DIR = '/盘游';
export const LIBRARY_NAME = '资源库.json';
const LIBRARY_PATH = `${LIBRARY_DIR}/${LIBRARY_NAME}`;
// 盘游只认 PPSA / CUSA 加 5 位数字的编号，转存时按它建游戏目录
const TITLE_RE = /^(PPSA|CUSA)\d{5}$/;
const INTERVAL_MS = 10 * 60_000;
const DEBOUNCE_MS = 30_000;
const KEY = '_library_publish';

const unix = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) || 0 : 0);
const isDead = (l) => l.status === 'invalid' || l.alive === 0;

// 同一种格式有几条链接时：链接能用的优先，然后版本高的，再然后帖子新的
function better(a, b) {
  if (isDead(a) !== isDead(b)) return isDead(a) ? 1 : -1;
  const v = cmpVer(b.version, a.version);
  if (v) return v;
  return Number(b.post_id) - Number(a.post_id);
}

export function buildLibrary() {
  const posts = new Map(all('SELECT * FROM posts').map(p => [`${p.source_id}/${p.post_id}`, p]));
  const enriched = new Map();
  const games = new Map();
  for (const l of all(`SELECT surl, pwd, status, remark, format, alive, checked_at, share_size, source_id, post_id FROM links WHERE status != 'skipped'`)) {
    const format = linkFormat(l);
    if (!FORMAT_DIR[format]) continue;
    const { version, firmware, extra } = classify(l.remark || '');
    if (extra) continue;
    const post = posts.get(`${l.source_id}/${l.post_id}`);
    if (!post) continue;
    if (!enriched.has(post)) enriched.set(post, enrichGameRow(post));
    const e = enriched.get(post);
    const titleId = String(e.serial || '').toUpperCase();
    if (!TITLE_RE.test(titleId)) continue;

    let g = games.get(titleId);
    if (!g) games.set(titleId, (g = { title_id: titleId, post: null, concept_id: 0, added_at: 0, byFormat: new Map() }));
    if (!g.post || Number(post.post_id) > Number(g.post.post_id)) g.post = post;
    if (!g.concept_id && e.concept_id) g.concept_id = e.concept_id;
    g.added_at = Math.max(g.added_at, unix(post.discovered_at));
    const cand = { ...l, format, version, firmware };
    const cur = g.byFormat.get(format);
    if (!cur || better(cand, cur) < 0) g.byFormat.set(format, cand);
  }

  const chosen = [...games.values()].flatMap(g => [...g.byFormat.values()]);
  const matches = shareMatches(chosen.map(l => l.surl));
  const out = [...games.values()].map(g => ({
    title_id: g.title_id,
    concept_id: g.concept_id || 0,
    name: enriched.get(g.post).display_name,
    added_at: g.added_at,
    variants: Object.keys(FORMAT_DIR).filter(f => g.byFormat.has(f)).map(f => {
      const l = g.byFormat.get(f);
      const v = { format: f, surl: l.surl, pwd: l.pwd || '' };
      if (l.version) v.version = l.version;
      if (l.firmware) v.firmware = l.firmware;
      v.size = Number(l.share_size) || 0;
      if (isDead(l)) v.alive = false;
      else if (l.alive === 1) v.alive = true;
      v.checked_at = unix(l.checked_at);
      const r = matches.get(l.surl)?.[0];
      if (r) v.review = { playable: r.playable, note: r.note, firmware: r.firmware, device: r.device, at: r.at };
      return v;
    }),
  })).sort((a, b) => b.added_at - a.added_at || a.title_id.localeCompare(b.title_id));

  const src = listSources().find(s => s.enabled) || listSources()[0];
  return { version: 1, generated_at: Math.floor(Date.now() / 1000), library_dir: src?.dest_dir || '', games: out };
}

const loadState = () => JSON.parse(one('SELECT value FROM settings WHERE key = ?', KEY)?.value || '{}');
const saveState = (s) => exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(s));

let running = null;
let timer = null;

// force：内容没变也重新上传
export function publishLibrary({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    const doc = buildLibrary();
    // 一个游戏都没有多半是数据出了问题，不拿空文件覆盖盘游正在用的那份
    if (!doc.games.length) throw new Error('没有可发布的游戏（需要有游戏编号、并且有 exFAT / 文件夹 / 未标注格式的链接）');
    const hash = crypto.createHash('sha1').update(JSON.stringify([doc.library_dir, doc.games])).digest('hex');
    const st = loadState();
    if (!force && hash === st.hash) {
      const entries = await bd.listDir(LIBRARY_DIR);
      if (entries?.some(e => e.name === LIBRARY_NAME && !e.isdir)) {
        saveState({ ...st, checked_at: nowIso(), error: null });
        return false;
      }
    }
    await bd.writeSmallFile(LIBRARY_PATH, JSON.stringify(doc));
    saveState({ hash, at: nowIso(), checked_at: nowIso(), count: doc.games.length, error: null });
    bus.emit('library_published', { count: doc.games.length });
    console.log(`已发布盘游资源库：${doc.games.length} 个游戏 → ${LIBRARY_PATH}`);
    return true;
  })()
    .catch((e) => {
      saveState({ ...loadState(), checked_at: nowIso(), error: e.message });
      console.warn(`发布盘游资源库失败：${e.message}`);
      return null;
    })
    .finally(() => { running = null; });
  return running;
}

function publishSoon() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; publishLibrary(); }, DEBOUNCE_MS);
}

export const libraryPublishStatus = () => ({ ...loadState(), path: LIBRARY_PATH, running: !!running });

export function startLibraryPublish() {
  setTimeout(publishLibrary, 45_000);
  setInterval(publishLibrary, INTERVAL_MS);
  for (const ev of ['links_checked', 'reviews']) bus.on(ev, publishSoon);
  bus.on('job', (job) => { if (job?.status === 'done' && job.type === 'crawl') publishSoon(); });
}
