// 帖子标题里没写编号的游戏，读分享里的目录名、文件名取 Title ID（PPSA / CUSA），再按 PlayStation-Titles
// 换成 conceptId 查商店资料，和盘游从网盘目录名认游戏一样；比按游戏名匹配可靠
import { all, exec } from './db.mjs';
import * as bd from './baidu.mjs';
import { serialsFromName } from './tasks/normalize.mjs';
import { lookupCatalogBySerial, ensureCoverFile, sameCatalogGame } from './catalog.mjs';
import { bus } from './bus.mjs';

// 读不出编号（分享失效、名字里没有）的帖子隔一段时间才再读
const RETRY_MS = 6 * 3600_000;
const tried = new Map();
let running = null;

function serialsInPaths(paths) {
  const out = new Set();
  for (const p of paths) for (const seg of p.split('/')) serialsFromName(seg).forEach(s => out.add(s.toUpperCase()));
  return out;
}

// 分享里的编号；列过全部文件的直接用记录，否则只列前两层（编号一般在顶层目录或包名里）。分享读不了返回 null
async function serialsOfShare(link) {
  if (link.files_at) {
    const found = serialsInPaths(all('SELECT path FROM share_files WHERE surl = ?', link.surl).map(r => r.path));
    if (found.size) return found;
  }
  const r = await bd.listShare(link.surl, link.pwd, { maxDepth: 2 });
  if (r.error) return null;
  return serialsInPaths([...r.dirs, ...r.files.map(f => f.rel)]);
}

// 多个编号时：商店目录里查得到的优先，PS5 优先；查得到的编号指向不止一个游戏（合集）就不认
function pickSerial(serials) {
  const known = [...serials].map(s => ({ s, cat: lookupCatalogBySerial(s) })).filter(x => x.cat);
  if (!known.length) return serials.size === 1 ? { serial: [...serials][0], conceptId: null } : null;
  if (new Set(known.map(x => x.cat.conceptId || x.s)).size > 1) return null;
  const best = known.find(x => x.s.startsWith('PPSA')) || known[0];
  return { serial: best.s, conceptId: best.cat.conceptId || null };
}

async function resolvePost(post) {
  const links = all(`SELECT surl, pwd, files_at FROM links WHERE source_id = ? AND post_id = ? AND status != 'invalid'
                     ORDER BY status = 'skipped', rowid`, post.source_id, post.post_id);
  const found = new Set();
  let readable = false;
  for (const l of links) {
    const s = await serialsOfShare(l);
    if (!s) continue;
    readable = true;
    s.forEach(x => found.add(x));
    if (found.size) break;
  }
  if (!readable || !found.size) return false;
  const pick = pickSerial(found);
  exec(`UPDATE posts SET share_serials = ?, serial = COALESCE(serial, ?), concept_id = COALESCE(concept_id, ?)
        WHERE source_id = ? AND post_id = ?`, [...found].join(','), pick?.serial || null, pick?.conceptId || null, post.source_id, post.post_id);
  if (pick?.conceptId) {
    ensureCoverFile(pick.conceptId).catch(() => {});
    bus.emit('meta', { concept_id: pick.conceptId });
  }
  console.log(`[${post.post_id}] ${post.title || ''}：分享里的编号 ${[...found].join(', ')}${pick ? ` → ${pick.serial}` : '（对应多个游戏，未采用）'}`);
  return true;
}

// 找出没有编号的帖子逐个处理；同一时间只跑一轮
export function resolveMissingSerials() {
  if (running) return running;
  running = (async () => {
    // 以前读过分享（退出网盘、清单对照时）记下了编号的，直接用
    for (const p of all(`SELECT source_id, post_id, share_serials FROM posts WHERE COALESCE(serial, '') = '' AND COALESCE(share_serials, '') != ''`)) {
      const pick = pickSerial(new Set(p.share_serials.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)));
      if (!pick) continue;
      exec('UPDATE posts SET serial = ?, concept_id = COALESCE(concept_id, ?) WHERE source_id = ? AND post_id = ?', pick.serial, pick.conceptId, p.source_id, p.post_id);
      if (pick.conceptId) bus.emit('meta', { concept_id: pick.conceptId });
    }
    const posts = all(`SELECT p.source_id, p.post_id, p.title FROM posts p
                       WHERE COALESCE(p.serial, '') = '' AND p.share_serials IS NULL
                         AND EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.source_id AND l.post_id = p.post_id AND l.status != 'invalid')
                       ORDER BY CAST(p.post_id AS INTEGER) DESC`);
    for (const p of posts) {
      const key = `${p.source_id}/${p.post_id}`;
      if (Date.now() - (tried.get(key) || 0) < RETRY_MS) continue;
      tried.set(key, Date.now());
      try { await resolvePost(p); } catch (e) { console.warn(`[${p.post_id}] 读分享取编号失败：${e.message}`); }
    }
  })().finally(() => { running = null; });
  return running;
}

// 帖子上写的编号有时是错的（站点把编号写错、少写一位，被认成另一款游戏）。分享里的文件名才是真内容：
// 链接检查列过的分享里找不到帖子的编号，而且分享里的编号在商店里是另一款游戏时，改用分享里的。
// 同一款游戏的不同区版本（资料库里英文名一样）不动，免得已经按原编号放进网盘的对不上。只读数据库，不请求百度
export function verifySerials() {
  const posts = all(`SELECT p.source_id, p.post_id, p.title, p.serial FROM posts p WHERE COALESCE(p.serial, '') != ''
                     AND EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.source_id AND l.post_id = p.post_id
                                 AND l.files_at IS NOT NULL AND l.status NOT IN ('skipped', 'invalid'))`);
  let fixed = 0;
  for (const p of posts) {
    const paths = all(`SELECT sf.path FROM share_files sf JOIN links l ON l.surl = sf.surl
                       WHERE l.source_id = ? AND l.post_id = ? AND l.status NOT IN ('skipped', 'invalid')`, p.source_id, p.post_id).map(r => r.path);
    const found = serialsInPaths(paths);
    if (!found.size || found.has(String(p.serial).toUpperCase())) continue;
    const pick = pickSerial(found);
    if (!pick?.conceptId || sameCatalogGame(p.serial, pick.serial)) continue;
    exec('UPDATE posts SET serial = ?, concept_id = ?, share_serials = ? WHERE source_id = ? AND post_id = ?',
      pick.serial, pick.conceptId, [...found].join(','), p.source_id, p.post_id);
    ensureCoverFile(pick.conceptId).catch(() => {});
    bus.emit('meta', { concept_id: pick.conceptId });
    console.log(`[${p.post_id}] ${p.title || ''}：帖子写的编号 ${p.serial} 和分享里的 ${[...found].join(', ')} 对不上，改用 ${pick.serial}`);
    fixed++;
  }
  return fixed;
}

export function startShareSerialSync() {
  setTimeout(resolveMissingSerials, 20_000);
  setTimeout(verifySerials, 25_000);
  setInterval(resolveMissingSerials, RETRY_MS);
  bus.on('job', (job) => {
    if (job?.status !== 'done' || job.type !== 'crawl') return;
    resolveMissingSerials();
    verifySerials();
  });
  bus.on('links_checked', () => verifySerials());
}
