// 盘游的资源库：把能转存的游戏写成网盘里的 /盘游/资源库.json。盘游据此列出全部游戏，点安装时自己转存，
// 网盘空间也由盘游按需腾（盘游 docs/adr/0011）。内容有变化才上传。
import crypto from 'node:crypto';
import { all, one, exec } from './db.mjs';
import * as bd from './baidu.mjs';
import { bus } from './bus.mjs';
import fs from 'node:fs';
import { listSources } from './sources.mjs';
import { enrichGameRow, parseSiteMeta, postCoverFile } from './catalog.mjs';
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

// 资源库里每款游戏每种格式用哪条链接
function chooseLinks() {
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
    if (!g) games.set(titleId, (g = { title_id: titleId, post: null, concept_id: 0, added_at: 0, byFormat: new Map(), site: null, site_post: 0 }));
    if (!g.post || Number(post.post_id) > Number(g.post.post_id)) g.post = post;
    const site = parseSiteMeta(post.site_meta);
    if ((site.cover || site.description) && Number(post.post_id) > g.site_post) {
      g.site = site;
      g.site_post = Number(post.post_id);
    }
    if (!g.concept_id && e.concept_id) g.concept_id = e.concept_id;
    g.added_at = Math.max(g.added_at, unix(post.discovered_at));
    const cand = { ...l, format, version, firmware };
    const cur = g.byFormat.get(format);
    if (!cur || better(cand, cur) < 0) g.byFormat.set(format, cand);
  }
  return { games, enriched };
}

// 资源库里选中的链接，编排分析只分析这些：[{ surl, pwd, title_id, format, name, post }]
export function libraryLinks() {
  const { games, enriched } = chooseLinks();
  return [...games.values()].flatMap(g => [...g.byFormat.values()].map(l => ({
    surl: l.surl, pwd: l.pwd || '', status: l.status, title_id: g.title_id, format: l.format, remark: l.remark || '', dead: isDead(l),
    name: enriched.get(g.post).display_name, source_id: l.source_id, post_id: l.post_id,
  })));
}

// 商店资料借自同名游戏时告诉盘游借的是哪页（store_concept_id），商店里没有介绍时带上帖子里的资料（info），
// 盘游和盘架显示的一样。介绍截短些，资源库盘游每次都要整份读
function storeFields(sm, site) {
  const out = {};
  if (sm?.found && sm.from_concept) out.store_concept_id = sm.from_concept;
  if (site && !(sm?.found && sm.has_desc)) {
    const info = {};
    if (site.cover) info.cover = site.cover;
    if (site.description) info.description = site.description.slice(0, 1500);
    if (site.publisher) info.publisher = site.publisher;
    if (site.release_date) info.release_date = site.release_date;
    out.info = info;
  }
  return out;
}

export function buildLibrary() {
  const { games, enriched } = chooseLinks();
  const chosen = [...games.values()].flatMap(g => [...g.byFormat.values()]);
  const matches = shareMatches(chosen.map(l => l.surl));
  const plans = new Map(all(`SELECT surl, plan FROM link_plans WHERE status IN ('ok', 'queued') AND plan IS NOT NULL AND uploaded_rev >= rev`)
    .map(p => [p.surl, p.plan]));
  const store = new Map(all(`SELECT concept_id, found, from_concept, COALESCE(description, '') != '' AS has_desc FROM store_meta`)
    .map(r => [r.concept_id, r]));
  const out = [...games.values()].map(g => ({
    title_id: g.title_id,
    concept_id: g.concept_id || 0,
    ...storeFields(store.get(g.concept_id), g.site),
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
      if (plans.has(l.surl)) {
        // 只放摘要，分卷清单在 /盘游/编排/<编号>/<surl>.json，盘游装的时候才去取
        const p = JSON.parse(plans.get(l.surl));
        v.plan = { rev: p.rev, size: p.size, layers: p.layers.map(x => x.name), copies: p.copies.length, notes: p.notes };
        if (p.packages?.length) v.plan.packages = p.packages.length;
        if (p.size) v.size = p.size;
      }
      return v;
    }),
  })).sort((a, b) => b.added_at - a.added_at || a.title_id.localeCompare(b.title_id));

  const src = listSources().find(s => s.enabled) || listSources()[0];
  return { version: 2, generated_at: Math.floor(Date.now() / 1000), library_dir: src?.dest_dir || '', games: out };
}

// 编排的完整内容一条一个文件。先传这些、再发布资源库，资源库里有摘要的编排在网盘上一定找得到
export const PLAN_DIR = `${LIBRARY_DIR}/编排`;
async function uploadPlans() {
  const titles = new Map(libraryLinks().map(l => [l.surl, l.title_id]));
  const rows = all(`SELECT surl, rev, plan FROM link_plans WHERE status IN ('ok', 'queued') AND plan IS NOT NULL AND uploaded_rev < rev`);
  let uploaded = 0;
  for (const row of rows) {
    const title = titles.get(row.surl);
    if (!title) continue;
    await bd.writeSmallFile(`${PLAN_DIR}/${title}/${row.surl}.json`, row.plan);
    exec('UPDATE link_plans SET uploaded_rev = ? WHERE surl = ?', row.rev, row.surl);
    uploaded++;
  }
  if (uploaded) console.log(`已上传 ${uploaded} 份编排到 ${PLAN_DIR}`);
}

// 帖子封面在外面的图床上，主机所在的网络常常连域名都解析不了（盘架这边走代理取得到）。传一份到网盘，
// 资源库里写 info.cover_file，盘游从网盘读。按图片地址记着传过哪些，地址变了才重传
export const COVER_DIR = `${LIBRARY_DIR}/封面`;
const COVERS_KEY = '_library_site_covers';
const MAX_COVER_UPLOADS = 40;
const COVER_RETRY_MS = 6 * 3600_000;
const coverFailedAt = new Map();
async function uploadSiteCovers(games) {
  const done = JSON.parse(one('SELECT value FROM settings WHERE key = ?', COVERS_KEY)?.value || '{}');
  let uploaded = 0, failed = 0;
  for (const g of games) {
    const url = g.info?.cover;
    if (!url) continue;
    const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
    const file = `${COVER_DIR}/${g.title_id}-${key}.img`;
    const recent = Date.now() - (coverFailedAt.get(file) || 0) < COVER_RETRY_MS;
    if (done[g.title_id] !== file && !recent && uploaded + failed < MAX_COVER_UPLOADS) {
      const local = await postCoverFile(url);
      try {
        if (!local) throw new Error('图床取不到');
        await bd.writeSmallFile(file, fs.readFileSync(local));
        done[g.title_id] = file;
        uploaded++;
      } catch (e) {
        failed++;
        coverFailedAt.set(file, Date.now());
        console.warn(`上传帖子封面 ${g.title_id} 失败：${e.message}`);
      }
    }
    if (done[g.title_id] === file) g.info.cover_file = file;
  }
  if (uploaded) {
    exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', COVERS_KEY, JSON.stringify(done));
    console.log(`已上传 ${uploaded} 张帖子封面到 ${COVER_DIR}`);
  }
}

const loadState = () => JSON.parse(one('SELECT value FROM settings WHERE key = ?', KEY)?.value || '{}');
const saveState = (s) => exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(s));

let running = null;
let timer = null;

// force：内容没变也重新上传
export function publishLibrary({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    await uploadPlans();
    const doc = buildLibrary();
    // 一个游戏都没有多半是数据出了问题，不拿空文件覆盖盘游正在用的那份
    if (!doc.games.length) throw new Error('没有可发布的游戏（需要有游戏编号、并且有 exFAT / 文件夹 / 未标注格式的链接）');
    await uploadSiteCovers(doc.games);
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
  setTimeout(() => bd.tidyLegacyDirs().catch(e => console.warn(`整理网盘根目录的旧工作目录失败：${e.message}`)), 40_000);
  setTimeout(publishLibrary, 45_000);
  setInterval(publishLibrary, INTERVAL_MS);
  for (const ev of ['links_checked', 'reviews', 'plans']) bus.on(ev, publishSoon);
  bus.on('job', (job) => { if (job?.status === 'done' && job.type === 'crawl') publishSoon(); });
}
