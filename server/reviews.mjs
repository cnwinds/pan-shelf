// 盘游的评价：盘游把每台设备的评价写到网盘 /盘游/评价/<设备>.json，这里定时读回来。
// 认同一份资源按主游戏各分卷的 md5：分享里看到的 md5 和转存后网盘里的一样，转存前就能认出来。
import { all, one, exec, tx } from './db.mjs';
import * as bd from './baidu.mjs';
import { bus } from './bus.mjs';
import { nowIso } from './util.mjs';
import { linkFormat } from './layout.mjs';

// 盘游也按这个位置写，改了要两边一起改
export const REVIEW_DIR = '/盘游/评价';
const INTERVAL_MS = 30 * 60_000;
const MAX_FILE_BYTES = 4 << 20;

// 文件名 -> 上次读到的 fs_id；盘游每次覆盖写 fs_id 都会变，没变的不重读
const seen = new Map();
let running = null;
let lastAttempt = 0;
export const syncState = { at: null, error: null };

export function syncReviews() {
  if (running) return running;
  lastAttempt = Date.now();
  running = (async () => {
    const entries = await bd.listDir(REVIEW_DIR);
    const files = (entries || []).filter(e => !e.isdir && e.name.endsWith('.json'));
    const ids = files.map(f => f.name.slice(0, -5));
    let changed = false;
    for (const f of files) {
      if (seen.get(f.name) === f.fs_id || f.size > MAX_FILE_BYTES) continue;
      let doc;
      try {
        doc = JSON.parse(await bd.readSmallFile(f.fs_id));
      } catch (e) {
        console.warn(`读盘游评价 ${f.name} 失败：${e.message}`);
        continue;
      }
      if (!Array.isArray(doc?.reviews)) continue;
      const deviceId = f.name.slice(0, -5);
      const deviceName = String(doc.device?.name || '').trim() || '另一台设备';
      tx(() => {
        exec('DELETE FROM reviews WHERE device_id = ?', deviceId);
        for (const r of doc.reviews) {
          if (!r?.fingerprint) continue;
          exec(`INSERT OR REPLACE INTO reviews (fingerprint, device_id, device_name, title_id, name, playable, note, firmware, at, removed, parts, format)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            String(r.fingerprint), deviceId, deviceName, String(r.title_id || '').toUpperCase() || null, r.name || null,
            r.playable === false ? 0 : 1, r.note || null, r.firmware || null, Number(r.at) || 0, r.removed ? 1 : 0,
            JSON.stringify(Array.isArray(r.parts) ? r.parts.filter(p => p?.md5).map(p => ({ md5: String(p.md5), size: Number(p.size) || 0, name: p.name || '' })) : []),
            typeof r.format === 'string' && r.format ? r.format : null);
        }
      });
      seen.set(f.name, f.fs_id);
      changed = true;
    }
    for (const { device_id } of all('SELECT DISTINCT device_id FROM reviews')) {
      if (!ids.includes(device_id)) { exec('DELETE FROM reviews WHERE device_id = ?', device_id); changed = true; }
    }
    syncState.at = nowIso();
    syncState.error = null;
    if (changed) {
      index = null;
      releaseClearedLinks();
      bus.emit('reviews', { at: syncState.at });
    }
    return changed;
  })()
    .catch((e) => { syncState.error = e.message; console.warn(`盘游评价同步失败：${e.message}`); return false; })
    .finally(() => { running = null; });
  return running;
}

export function refreshReviewsIfStale(maxAgeMs = 5 * 60_000) {
  if (Date.now() - lastAttempt > maxAgeMs) syncReviews();
}

// 转存前用：几分钟内读过就不再读，正在读就等它读完
export async function freshReviews(maxAgeMs = 2 * 60_000) {
  if (running) return running;
  if (Date.now() - lastAttempt > maxAgeMs) return syncReviews();
}

export function startReviewSync() {
  setTimeout(syncReviews, 8000);
  setInterval(syncReviews, INTERVAL_MS);
}

// ---------- 以最新为准的评价 ----------
let index = null;

const matchable = (r) => r.parts.length > 0 && r.parts.every(p => p.md5);

function getIndex() {
  if (index) return index;
  const latest = new Map();
  for (const r of all('SELECT * FROM reviews ORDER BY at ASC, device_id ASC')) latest.set(r.fingerprint, r);
  const list = [...latest.values()].filter(r => !r.removed).map(r => ({
    fingerprint: r.fingerprint,
    title_id: r.title_id,
    name: r.name,
    playable: !!r.playable,
    note: r.note || '',
    firmware: r.firmware || '',
    format: r.format || null,
    at: r.at,
    device: r.device_name || '',
    parts: (() => { try { return JSON.parse(r.parts); } catch { return []; } })(),
  })).sort((a, b) => b.at - a.at);
  const byTitle = new Map();
  const byMd5 = new Map();
  for (const r of list) {
    if (r.title_id) byTitle.set(r.title_id, [...(byTitle.get(r.title_id) || []), r]);
    if (matchable(r)) byMd5.set(r.parts[0].md5, [...(byMd5.get(r.parts[0].md5) || []), r]);
  }
  index = { list, byTitle, byMd5 };
  return index;
}

export const allReviews = () => getIndex().list;
export const hasMatchableBad = () => getIndex().list.some(r => !r.playable && matchable(r));

// 这些文件里包含了哪些评价的主游戏全部分卷；不能玩的排前面
export function matchMd5s(md5s) {
  const { byMd5 } = getIndex();
  const out = [];
  for (const m of md5s) {
    for (const r of byMd5.get(m) || []) {
      if (!out.includes(r) && r.parts.every(p => md5s.has(p.md5))) out.push(r);
    }
  }
  return out.sort((a, b) => Number(a.playable) - Number(b.playable) || b.at - a.at);
}

// surl -> 对得上的评价（只看已经列过的分享）
export function shareMatches(surls) {
  const out = new Map();
  if (!surls.length || !getIndex().byMd5.size) return out;
  const sets = new Map();
  for (let i = 0; i < surls.length; i += 500) {
    const chunk = surls.slice(i, i + 500);
    for (const r of all(`SELECT surl, md5 FROM share_files WHERE md5 IS NOT NULL AND surl IN (${chunk.map(() => '?').join(',')})`, ...chunk)) {
      if (!sets.has(r.surl)) sets.set(r.surl, new Set());
      sets.get(r.surl).add(r.md5);
    }
  }
  for (const [surl, md5s] of sets) {
    const m = matchMd5s(md5s);
    if (m.length) out.set(surl, m);
  }
  return out;
}

// 列出分享里的文件存起来；分享内容不会变，列过的不再列。返回出错原因
export async function ensureShareFiles(link) {
  if (link.files_at) return null;
  const r = await bd.listShare(link.surl, link.pwd);
  if (r.error) return r.error;
  const at = nowIso();
  tx(() => {
    exec('DELETE FROM share_files WHERE surl = ?', link.surl);
    for (const f of r.files) exec('INSERT OR REPLACE INTO share_files (surl, path, md5, size) VALUES (?, ?, ?, ?)', link.surl, f.rel, f.md5, f.size || 0);
    exec('UPDATE links SET files_at = ? WHERE surl = ?', at, link.surl);
  });
  link.files_at = at;
  return null;
}

// 这份分享是不是标记过不能玩的那份
export function badReviewOfLink(surl) {
  return shareMatches([surl]).get(surl)?.find(r => !r.playable) || null;
}

// 评价清除或改成能玩后，之前因它没转存的链接放回「可入盘」
function releaseClearedLinks() {
  for (const l of all(`SELECT surl FROM links WHERE status = 'bad'`)) {
    if (!badReviewOfLink(l.surl)) exec(`UPDATE links SET status = 'available', last_error = NULL WHERE surl = ?`, l.surl);
  }
}

export function serialsOf(post, serial) {
  return [...new Set([serial, post?.serial, ...String(post?.share_serials || '').split(',')]
    .map(s => String(s || '').trim().toUpperCase()).filter(Boolean))];
}

export function reviewsOfSerials(serials) {
  const { byTitle } = getIndex();
  const out = [];
  for (const s of serials) for (const r of byTitle.get(s) || []) if (!out.includes(r)) out.push(r);
  return out.sort((a, b) => b.at - a.at);
}

// format：盘游评价时装的格式；旧评价没记，分享对得上时按那条链接的格式补
const brief = (r, link) => ({ fingerprint: r.fingerprint, playable: r.playable, note: r.note, firmware: r.firmware, at: r.at, device: r.device, name: r.name,
  format: r.format || (link ? linkFormat(link) : null) });

// 游戏库格子上的一句：exact 表示这个游戏的某条分享就是评过的那份，否则只是同一个编号评过
export function gameReviewBrief(post, serial, links, matches) {
  const ordered = [...links].sort((a, b) => Number(['saved', 'exists'].includes(b.status)) - Number(['saved', 'exists'].includes(a.status)));
  for (const l of ordered) {
    const m = matches.get(l.surl);
    if (m?.length) return { ...brief(m[0], l), exact: true };
  }
  const t = reviewsOfSerials(serialsOf(post, serial));
  return t.length ? { ...brief(t[0]), exact: false } : null;
}

// 详情里列出的评价：match 为 this（就是这个游戏的某条分享）、other（分享都列过，没有一条对得上）、unknown（还没核对）
export function gameReviews(post, serial, links) {
  const usable = links.filter(l => l.status !== 'invalid');
  const matches = shareMatches(usable.map(l => l.surl));
  const items = [];
  for (const l of usable) {
    for (const r of matches.get(l.surl) || []) {
      if (!items.some(x => x.fingerprint === r.fingerprint)) items.push({ ...brief(r, l), match: 'this', surl: l.surl });
    }
  }
  const checked = usable.every(l => l.files_at);
  for (const r of reviewsOfSerials(serialsOf(post, serial))) {
    if (items.some(x => x.fingerprint === r.fingerprint)) continue;
    items.push({ ...brief(r), match: checked && matchable(r) ? 'other' : 'unknown' });
  }
  return { items, checked };
}

// ---------- 网盘里还占着空间的不能玩的游戏 ----------
const deepCache = new Map(); // path -> { at, files }
bus.on('pan_inventory', () => deepCache.clear());
async function listDeep(path, depth = 0) {
  const c = deepCache.get(path);
  if (c && Date.now() - c.at < 10 * 60_000) return c.files;
  const files = [];
  for (const e of (await bd.listDir(path)) || []) {
    if (e.isdir) { if (depth < 3) files.push(...await listDeep(e.path, depth + 1)); }
    else files.push(e);
  }
  if (depth === 0) deepCache.set(path, { at: Date.now(), files });
  return files;
}

// 只看编号和不能玩的评价对得上的游戏目录，列出里面的文件按 md5 核对，确实是那份资源才算
export async function badGamesInPan(sourceId) {
  const bad = getIndex().list.filter(r => !r.playable && matchable(r));
  const titles = new Set(bad.map(r => r.title_id).filter(Boolean));
  if (!titles.size) return [];
  const items = all('SELECT serial, path, is_dir FROM pan_items WHERE source_id = ?', sourceId).filter(i => titles.has(i.serial) && i.is_dir);
  const out = [];
  for (const item of items) {
    const files = await listDeep(item.path);
    const review = matchMd5s(new Set(files.map(f => f.md5).filter(Boolean))).find(r => !r.playable);
    if (!review) continue;
    const post = one(`SELECT post_id, title, custom_name, serial FROM posts WHERE source_id = ? AND (UPPER(serial) = ? OR ',' || UPPER(COALESCE(share_serials, '')) || ',' LIKE ?)
                      ORDER BY CAST(post_id AS INTEGER) DESC LIMIT 1`, sourceId, item.serial, `%,${item.serial},%`);
    out.push({
      serial: item.serial,
      path: item.path,
      size: files.reduce((s, f) => s + (f.size || 0), 0),
      post_id: post?.post_id || null,
      title: post?.custom_name || review.name || post?.title || item.serial,
      review: brief(review),
    });
  }
  return out;
}

export function reviewStatus() {
  const devices = all(`SELECT device_id, device_name, COUNT(*) n, SUM(CASE WHEN removed = 0 AND playable = 0 THEN 1 ELSE 0 END) bad
                       FROM reviews WHERE removed = 0 GROUP BY device_id ORDER BY device_name`);
  const list = getIndex().list;
  return {
    ...syncState,
    total: list.length,
    bad: list.filter(r => !r.playable).length,
    devices: devices.map(d => ({ id: d.device_id, name: d.device_name, count: d.n, bad: d.bad })),
  };
}
