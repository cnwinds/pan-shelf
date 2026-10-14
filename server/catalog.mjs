import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.mjs';
import { all, one, exec, tx } from './db.mjs';
import { bus } from './bus.mjs';

export const COVERS_DIR = path.join(STATE_DIR, 'covers');
fs.mkdirSync(COVERS_DIR, { recursive: true });

const PANPLAY_APPDATA = process.env.APPDATA ? path.join(process.env.APPDATA, 'panplay') : '';
const PANPLAY_COVERS_DIR = PANPLAY_APPDATA ? path.join(PANPLAY_APPDATA, 'covers') : '';

const CATALOG_PATHS = [
  path.join(STATE_DIR, 'panplay-catalog.json'),
  PANPLAY_APPDATA ? path.join(PANPLAY_APPDATA, 'panplay-catalog.json') : '',
  'D:\\ai_projects\\panplay\\data\\panplay-catalog.json',
].filter(Boolean);

const byTitleId = new Map();
const byNormName = new Map();
let catalogLoaded = false;
let catalogSourcePath = '';

function shortTitleId(val) {
  if (!val) return '';
  const s = String(val).trim().toUpperCase();
  const m = s.match(/\b(PPSA|CUSA)\d{5}\b/);
  return m ? m[0] : '';
}

function normEnglish(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/&amp;|&#038;/g, 'and')
    .replace(/['’‘`]/g, '')
    .replace(/\b(the|edition|deluxe|digital|ultimate|definitive|enhanced|remastered|remake|director\s*s\s*cut|complete|gold|goty|bundle|pack|ps5|ps4|playstation\s*[45])\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function exactNorm(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/&amp;|&#038;/g, 'and')
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function decodeHtmlEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&#038;/g, '&')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;|&#8217;/g, '’')
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export function splitBilingualTitle(rawTitle) {
  const clean = decodeHtmlEntities(rawTitle || '');
  if (!clean) return { cnTitle: '', enTitle: '', fullTitle: '' };

  // Pattern 1: "中文名.English Title" (with optional spaces around dot)
  const dotMatch = clean.match(/^(.+?[\u4e00-\u9fa5][^.]*?)\s*\.\s*([A-Za-z0-9].*)$/);
  if (dotMatch) {
    return {
      cnTitle: dotMatch[1].replace(/[.\s]+$/, '').trim(),
      enTitle: dotMatch[2].trim(),
      fullTitle: clean,
    };
  }

  // Pattern 2: "中文名 English Title" (where English part is at the end and has letters)
  const spaceMatch = clean.match(/^([\u4e00-\u9fa50-9：:·—–\-\s《》“”（）().]+?)\s+([A-Za-z][A-Za-z0-9\s:：'’\-–—&!.,/()]+)$/);
  if (spaceMatch && /[\u4e00-\u9fa5]/.test(spaceMatch[1]) && spaceMatch[2].trim().length >= 3) {
    return {
      cnTitle: spaceMatch[1].replace(/[.\s]+$/, '').trim(),
      enTitle: spaceMatch[2].trim(),
      fullTitle: clean,
    };
  }

  return { cnTitle: clean, enTitle: '', fullTitle: clean };
}

export function cleanStoreName(raw) {
  if (!raw) return '';
  let out = decodeHtmlEntities(raw).trim();
  const stripTrailingGroup = (s) => {
    const pairs = [['(', ')'], ['（', '）']];
    for (const [open, close] of pairs) {
      if (!s.endsWith(close)) continue;
      const pos = s.lastIndexOf(open);
      if (pos <= 0) continue;
      const inside = s.slice(pos + open.length, s.length - close.length);
      if (
        inside.includes('文') ||
        inside.includes('語') ||
        inside.includes('语') ||
        inside.includes('Chinese') ||
        inside.includes('English') ||
        inside.includes('Korean') ||
        inside.includes('Japanese') ||
        inside.includes('Ver.') ||
        inside.includes('PlayStation') ||
        inside === 'PS4' ||
        inside === 'PS5' ||
        inside === 'PS4 & PS5'
      ) {
        let next = s.slice(0, pos).trimEnd();
        return next;
      }
    }
    return s;
  };
  for (let i = 0; i < 3; i++) {
    const next = stripTrailingGroup(out);
    if (next === out) break;
    out = next;
  }
  if (out.startsWith('《') && out.endsWith('》') && out.length > 2) {
    const inner = out.slice(1, -1);
    if (!inner.includes('《') && !inner.includes('》')) out = inner;
  }
  return out.trim();
}

function registerNameIndex(key, entry) {
  if (!key || key.length < 3) return;
  const existing = byNormName.get(key);
  if (!existing) {
    byNormName.set(key, entry);
    return;
  }
  // Prefer PS5 (PPSA) with conceptId and HK/Asia region
  const score = (e) =>
    (e.titleId.startsWith('PPSA') ? 10 : 0) +
    (e.conceptId ? 5 : 0) +
    (e.region === 'HK' || e.region === 'AS' || e.region === 'JP' ? 2 : 0);
  if (score(entry) > score(existing)) {
    byNormName.set(key, entry);
  }
}

export function initCatalog() {
  // 1. Load panplay-catalog.json
  for (const p of CATALOG_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const titles = raw.titles || raw.t || {};
      byTitleId.clear();
      byNormName.clear();
      for (const [tid, item] of Object.entries(titles)) {
        const id = shortTitleId(tid);
        if (!id || !item?.n) continue;
        const entry = {
          titleId: id,
          name: item.n,
          conceptId: Number(item.c || item.concept_id || 0),
          region: item.r || '',
          publisherId: item.p || '',
          platform: item.x || (id.startsWith('PPSA') ? 'ps5' : 'ps4'),
          coverUrl: item.u || '',
        };
        byTitleId.set(id, entry);
        registerNameIndex(exactNorm(entry.name), entry);
        registerNameIndex(normEnglish(entry.name), entry);
      }
      catalogLoaded = byTitleId.size > 0;
      catalogSourcePath = p;
      break;
    } catch (e) {
      console.warn('[catalog] failed to load', p, e.message);
    }
  }

  // 2. Import store-meta.json from %APPDATA%/panplay if available
  if (PANPLAY_APPDATA) {
    const smPath = path.join(PANPLAY_APPDATA, 'store-meta.json');
    if (fs.existsSync(smPath)) {
      try {
        const sm = JSON.parse(fs.readFileSync(smPath, 'utf8'));
        const concepts = sm.concepts || {};
        const upsert = one;
        tx(() => {
          for (const [cidStr, meta] of Object.entries(concepts)) {
            const cid = Number(cidStr);
            if (!cid) continue;
            const existing = upsert('SELECT concept_id, has_cover FROM store_meta WHERE concept_id = ?', cid);
            if (existing?.has_cover) continue;
            const hasCoverFile = getCoverFile(cid) !== null;
            exec(
              `INSERT OR REPLACE INTO store_meta
               (concept_id, found, has_cover, locale, name, cover_url, publisher, genres, release_date, description, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              cid,
              meta.found ? 1 : 0,
              hasCoverFile ? 1 : 0,
              meta.locale || '',
              meta.name || '',
              meta.cover_url || '',
              meta.publisher || '',
              meta.genres || '',
              meta.release_date || '',
              meta.description || '',
              Number(meta.fetched_at || Math.floor(Date.now() / 1000))
            );
          }
        });
      } catch (e) {
        console.warn('[catalog] failed to import panplay store-meta.json:', e.message);
      }
    }
  }

  // 3. Backfill serial & concept_id on posts (and repair 4-digit PPSA0xxxx typos)
  if (catalogLoaded) {
    const rows = all('SELECT source_id, post_id, title, serial, concept_id FROM posts');
    tx(() => {
      for (const r of rows) {
        const match = matchCatalogForPost(r.serial, r.title);
        if (!match) continue;
        // If r.serial was a 4-digit typo padded to PPSA0xxxx, replace it with the verified match.titleId
        const isShiftedFix = r.serial && /^PPSA0\d{4}$/.test(r.serial) && match.titleId && match.titleId !== r.serial && match.titleId.startsWith('PPSA' + r.serial.slice(5));
        const newSerial = (!r.serial || isShiftedFix) ? match.titleId : r.serial;
        const newConcept = match.conceptId || r.concept_id || null;
        if (newSerial !== r.serial || newConcept !== r.concept_id) {
          exec(
            'UPDATE posts SET serial = ?, concept_id = ? WHERE source_id = ? AND post_id = ?',
            newSerial,
            newConcept,
            r.source_id,
            r.post_id
          );
        }
      }

      // 3b. Cross-reference Netdisk folders (du_results) by concept_id into share_serials
      const duRows = all("SELECT name FROM du_results WHERE name GLOB '[CP][UP]SA[0-9]*'");
      for (const dr of duRows) {
        const s = shortTitleId(dr.name);
        if (!s) continue;
        const cat = byTitleId.get(s);
        if (!cat?.conceptId) continue;
        const matchingPosts = all('SELECT source_id, post_id, serial, share_serials FROM posts WHERE concept_id = ?', cat.conceptId);
        for (const mp of matchingPosts) {
          if (mp.serial && mp.serial.toUpperCase() === s) continue;
          const existingList = (mp.share_serials || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
          if (!existingList.includes(s)) {
            const nextShare = [...existingList, s].join(',');
            exec('UPDATE posts SET share_serials = ? WHERE source_id = ? AND post_id = ?', nextShare, mp.source_id, mp.post_id);
          }
        }
      }
    });
  }

  // 4. Kick off background warm-up for transferred / pending_transfer games first
  setTimeout(() => warmUpPriorityCovers(), 1500);
}

export function lookupCatalogBySerial(serial) {
  if (!catalogLoaded) return null;
  const sid = shortTitleId(serial);
  return (sid && byTitleId.get(sid)) || null;
}

export function matchCatalogForPost(serial, title) {
  if (!catalogLoaded) return null;
  const sid = shortTitleId(serial);
  const { enTitle, fullTitle } = splitBilingualTitle(title);

  // Check if a 4-digit typo padded as PPSA0xxxx actually matches PPSAxxxx[0-9] by English title
  if (sid && /^PPSA0\d{4}$/.test(sid) && enTitle) {
    const direct = byTitleId.get(sid);
    const w1 = normEnglish(enTitle);
    const s2 = normEnglish(direct?.name || '');
    const directMatchesTitle = w1 && s2 && (w1.includes(s2.slice(0, 5)) || s2.includes(w1.slice(0, 5)));
    if (!directMatchesTitle && w1.length >= 4) {
      const prefix4 = sid.slice(5);
      for (let d = 0; d <= 9; d++) {
        const cand = `PPSA${prefix4}${d}`;
        const cat = byTitleId.get(cand);
        if (!cat) continue;
        const w2 = normEnglish(cat.name);
        if (w2 && (w1.includes(w2.slice(0, 5)) || w2.includes(w1.slice(0, 5)))) {
          return cat;
        }
      }
    }
  }

  if (sid && byTitleId.has(sid)) {
    return byTitleId.get(sid);
  }
  for (const candidate of [enTitle, fullTitle]) {
    if (!candidate) continue;
    const exact = exactNorm(candidate);
    if (exact && byNormName.has(exact)) return byNormName.get(exact);
    const relaxed = normEnglish(candidate);
    if (relaxed && byNormName.has(relaxed)) return byNormName.get(relaxed);
  }
  return null;
}

export function getCoverFile(conceptId) {
  const cid = Number(conceptId);
  if (!cid || cid <= 0) return null;
  const localFile = path.join(COVERS_DIR, `${cid}.img`);
  try {
    const st = fs.statSync(localFile);
    if (st.size > 64) return localFile;
  } catch {}
  if (PANPLAY_COVERS_DIR) {
    const panplayFile = path.join(PANPLAY_COVERS_DIR, `${cid}.img`);
    try {
      const st = fs.statSync(panplayFile);
      if (st.size > 64) return panplayFile;
    } catch {}
  }
  return null;
}

export function detectImageMime(buf) {
  if (!buf || buf.length < 12) return 'application/octet-stream';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function stripHtmlDescription(raw) {
  if (!raw) return '';
  let s = String(raw)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<li\s*>/gi, '• ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeHtmlEntities(s).replace(/\r/g, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

const MEDIA_ROLE_PRIORITY = ['MASTER', 'PORTRAIT_BANNER', 'EDITION_KEY_ART', 'GAMEHUB_COVER_ART'];

function pickBestMediaImage(mediaList) {
  if (!Array.isArray(mediaList)) return '';
  for (const role of MEDIA_ROLE_PRIORITY) {
    for (const item of mediaList) {
      if (item?.type === 'IMAGE' && item?.role === role && typeof item?.url === 'string' && item.url.startsWith('http')) {
        return item.url;
      }
    }
  }
  return '';
}

export function parseConceptPageHtml(html, conceptId) {
  const out = {
    concept_id: Number(conceptId),
    found: false,
    locale: '',
    name: '',
    cover_url: '',
    publisher: '',
    genres: '',
    release_date: '',
    description: '',
  };
  if (!html) return out;
  const conceptKey = `Concept:${conceptId}`;
  const scriptRe = /<script[^>]*id="env:[^"]*"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    const jsonText = m[1];
    if (!jsonText.includes(conceptKey)) continue;
    try {
      const root = JSON.parse(jsonText);
      const cache = root?.cache;
      const concept = cache?.[conceptKey];
      if (!concept || typeof concept !== 'object') continue;
      const prodRef = concept?.defaultProduct?.__ref;
      const prod = prodRef && cache?.[prodRef] ? cache[prodRef] : null;

      if (!out.name) out.name = cleanStoreName(prod?.name || concept?.name || '');
      if (!out.publisher) out.publisher = prod?.publisherName || concept?.publisherName || '';
      if (!out.cover_url) out.cover_url = pickBestMediaImage(prod?.media) || pickBestMediaImage(concept?.media) || '';

      if (!out.genres) {
        const genresArr = prod?.localizedGenres || concept?.localizedGenres;
        if (Array.isArray(genresArr) && genresArr.length) {
          out.genres = genresArr.map((g) => g?.value).filter(Boolean).join(' / ');
        }
      }

      if (!out.release_date) {
        const relObj = prod?.releaseDate || concept?.releaseDate;
        const relVal = typeof relObj === 'string' ? relObj : (relObj?.value || '');
        if (typeof relVal === 'string' && relVal.length >= 10) {
          out.release_date = relVal.slice(0, 10);
        }
      }

      if (!out.description) {
        const descArr = concept?.descriptions || prod?.descriptions;
        if (Array.isArray(descArr) && descArr.length) {
          let shortDesc = '';
          let longDesc = '';
          for (const d of descArr) {
            if (d?.type === 'SHORT' && d?.value) shortDesc = d.value;
            else if (d?.type === 'LONG' && d?.value) longDesc = d.value;
          }
          out.description = stripHtmlDescription(longDesc || shortDesc);
        }
      }
    } catch {}
  }
  out.found = Boolean(out.name || out.cover_url || out.description);
  return out;
}

const LOCALES = ['zh-hans-hk', 'zh-hant-hk', 'en-us'];

async function fetchStoreMetaRemote(conceptId) {
  let best = {
    concept_id: Number(conceptId),
    found: false,
    locale: '',
    name: '',
    cover_url: '',
    publisher: '',
    genres: '',
    release_date: '',
    description: '',
  };

  for (const locale of LOCALES) {
    const url = `https://store.playstation.com/${locale}/concept/${conceptId}`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,zh-HK;q=0.8,en;q=0.7',
        },
        signal: AbortSignal.timeout(12000),
      });
      if (res.status === 404) continue;
      if (!res.ok) continue;
      const html = await res.text();
      const parsed = parseConceptPageHtml(html, conceptId);
      if (parsed.found) {
        parsed.locale = locale;
        return parsed;
      }
    } catch {}
  }
  return best;
}

async function downloadCoverToDisk(conceptId, coverUrl) {
  if (!coverUrl) return null;
  const existing = getCoverFile(conceptId);
  if (existing) return existing;
  const sizedUrl = `${coverUrl}${coverUrl.includes('?') ? '&' : '?'}w=440`;
  try {
    const res = await fetch(sizedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length <= 64 || detectImageMime(buf) === 'application/octet-stream') return null;
    const target = path.join(COVERS_DIR, `${conceptId}.img`);
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
    return target;
  } catch {
    return null;
  }
}

// Prioritized concurrency-limited queue for PS Store requests
const inFlight = new Map(); // conceptId -> Promise<string | null>
const waitQueue = []; // [{ conceptId, force, resolve, reject }]
let activeWorkers = 0;
const MAX_CONCURRENT = 3;

function pumpQueue() {
  while (activeWorkers < MAX_CONCURRENT && waitQueue.length > 0) {
    const task = waitQueue.shift();
    activeWorkers++;
    runFetchTask(task.conceptId, task.force)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeWorkers--;
        inFlight.delete(task.conceptId);
        pumpQueue();
      });
  }
}

async function runFetchTask(conceptId, force = false) {
  const cid = Number(conceptId);
  let row = one('SELECT * FROM store_meta WHERE concept_id = ?', cid);
  if (!force && row) {
    const file = getCoverFile(cid);
    if (file) return file;
  }

  if (!force && row && row.cover_url) {
    const downloaded = await downloadCoverToDisk(cid, row.cover_url);
    if (downloaded) {
      exec('UPDATE store_meta SET has_cover = 1 WHERE concept_id = ?', cid);
      return downloaded;
    }
  }

  // If already checked within 24h and not found, skip unless forced
  const nowSec = Math.floor(Date.now() / 1000);
  if (!force && row && row.fetched_at > nowSec - 86400 && !row.found) {
    return null;
  }

  const meta = await fetchStoreMetaRemote(cid);
  let coverFile = null;
  if (meta.cover_url) {
    if (force) {
      try { fs.unlinkSync(path.join(COVERS_DIR, `${cid}.img`)); } catch {}
    }
    coverFile = await downloadCoverToDisk(cid, meta.cover_url);
  }

  exec(
    `INSERT OR REPLACE INTO store_meta
     (concept_id, found, has_cover, locale, name, cover_url, publisher, genres, release_date, description, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cid,
    meta.found ? 1 : 0,
    coverFile ? 1 : 0,
    meta.locale || '',
    meta.name || '',
    meta.cover_url || '',
    meta.publisher || '',
    meta.genres || '',
    meta.release_date || '',
    meta.description || '',
    nowSec
  );

  if (meta.found) {
    bus.emit('meta', { concept_id: cid, has_cover: Boolean(coverFile) });
  }
  return coverFile;
}

export function ensureCoverFile(conceptId, { priority = false, force = false } = {}) {
  const cid = Number(conceptId);
  if (!cid || cid <= 0) return Promise.resolve(null);

  if (!force) {
    const existing = getCoverFile(cid);
    if (existing && one('SELECT 1 FROM store_meta WHERE concept_id = ?', cid)) return Promise.resolve(existing);
  }

  if (inFlight.has(cid)) {
    // If priority requested and still in waitQueue, bump to front
    if (priority) {
      const idx = waitQueue.findIndex((x) => x.conceptId === cid);
      if (idx > 0) {
        const [item] = waitQueue.splice(idx, 1);
        waitQueue.unshift(item);
      }
    }
    return inFlight.get(cid);
  }

  const p = new Promise((resolve, reject) => {
    const item = { conceptId: cid, force, resolve, reject };
    if (priority) waitQueue.unshift(item);
    else waitQueue.push(item);
  });
  inFlight.set(cid, p);
  pumpQueue();
  return p;
}

export async function refreshStoreMeta(conceptId) {
  const cid = Number(conceptId);
  if (!cid || cid <= 0) return null;
  await ensureCoverFile(cid, { priority: true, force: true });
  return one('SELECT * FROM store_meta WHERE concept_id = ?', cid);
}

function warmUpPriorityCovers() {
  try {
    // Prioritize games that are already in Netdisk (links or du_results) or pending transfer, plus top 40 newest games
    const priorityRows = all(`
      SELECT DISTINCT p.concept_id
      FROM posts p
      LEFT JOIN links l ON l.source_id = p.source_id AND l.post_id = p.post_id
      WHERE p.concept_id IS NOT NULL AND p.concept_id > 0
      ORDER BY
        CASE
          WHEN l.status IN ('saved', 'exists', 'pending')
            OR EXISTS (SELECT 1 FROM du_results d WHERE UPPER(d.name) = UPPER(p.serial))
            OR (p.share_serials IS NOT NULL AND EXISTS (SELECT 1 FROM du_results d WHERE ',' || UPPER(p.share_serials) || ',' LIKE '%,' || UPPER(d.name) || ',%'))
          THEN 0
          ELSE 1
        END,
        CAST(p.post_id AS INTEGER) DESC
      LIMIT 90
    `);
    for (const r of priorityRows) {
      if (!getCoverFile(r.concept_id)) {
        ensureCoverFile(r.concept_id, { priority: false }).catch(() => {});
      }
    }
  } catch {}
}

export function enrichGameRow(row, storeMetaMap = null) {
  const { cnTitle, enTitle, fullTitle } = splitBilingualTitle(row.title);
  const cat = matchCatalogForPost(row.serial, row.title);
  const serial = shortTitleId(row.serial) || cat?.titleId || '';
  const conceptId = Number(row.concept_id || cat?.conceptId || 0);
  const platform = serial.startsWith('CUSA')
    ? 'PS4'
    : serial.startsWith('PPSA')
      ? 'PS5'
      : (cat?.platform || 'ps5').toUpperCase();
  const region = cat?.region || '';

  const sm = conceptId > 0
    ? (storeMetaMap ? storeMetaMap.get(conceptId) : one('SELECT * FROM store_meta WHERE concept_id = ?', conceptId))
    : null;

  const hasCoverFile = conceptId > 0 && (sm?.has_cover ? true : getCoverFile(conceptId) !== null);
  const coverFailed = Boolean(sm && sm.fetched_at > 0 && !sm.found && !hasCoverFile && !sm.cover_url);

  // Display name priority: custom_name > clean Chinese title from post > store_meta name > catalog name > raw title
  const customName = (row.custom_name || '').trim();
  const autoName = cnTitle || sm?.name || cat?.name || fullTitle || serial || `帖子 #${row.post_id}`;
  const displayName = customName || autoName;

  // Serve cover via /api/cover/:conceptId whenever conceptId > 0 and not known-missing
  // v 参数随缓存状态变化，封面下载完成后列表刷新会让前端重新加载图片
  const coverUrl = conceptId > 0 && !coverFailed ? `/api/cover/${conceptId}?v=${hasCoverFile ? 1 : 0}` : (cat?.coverUrl || '');

  return {
    ...row,
    serial: serial || null,
    concept_id: conceptId || 0,
    platform,
    region,
    display_name: displayName,
    auto_name: autoName,
    custom_name: customName,
    cn_title: cnTitle,
    en_title: enTitle || cat?.name || '',
    store_name: sm?.name || '',
    catalog_name: cat?.name || '',
    cover_url: coverUrl,
    has_cached_cover: hasCoverFile,
    publisher: sm?.publisher || '',
    genres: sm?.genres || '',
    release_date: sm?.release_date || '',
    description: sm?.description || '',
    meta_state: sm ? (sm.found ? 'ready' : 'missing') : (conceptId > 0 ? 'pending' : 'missing'),
  };
}
