// 商店页下架了的游戏（漫威复仇者联盟这类），商店里查不到封面和介绍，改用帖子正文里的。
// 新采集的帖子采集时就记下了；这里给以前采集的、商店又没有介绍的帖子补抓一次帖子页
import { all, exec } from './db.mjs';
import { getSource, ADAPTERS } from './sources.mjs';
import { fetchSite, hostHealth } from './site.mjs';
import { bus } from './bus.mjs';

const RETRY_MS = 6 * 3600_000;
let running = null;

// 抓帖子页记下正文资料；站点抓不到返回 false
export async function refreshPostMeta(row) {
  const src = getSource(row.source_id);
  const adapter = src && ADAPTERS[src.adapter];
  if (!adapter || !row.url) return false;
  const html = await fetchSite(row.url, { retries: 2 });
  if (!html) return false;
  const { meta } = adapter.extractDetail(html, src);
  if (meta === undefined) return false;
  exec('UPDATE posts SET site_meta = ? WHERE source_id = ? AND post_id = ?', JSON.stringify(meta || {}), row.source_id, row.post_id);
  bus.emit('meta', { concept_id: Number(row.concept_id) || 0, post_id: row.post_id });
  return true;
}

async function backfill() {
  const posts = all(`SELECT p.source_id, p.post_id, p.url, p.title, p.concept_id FROM posts p
                     WHERE p.site_meta IS NULL AND p.status IN ('links_done', 'no_link')
                       AND (COALESCE(p.concept_id, 0) = 0 OR EXISTS (SELECT 1 FROM store_meta s WHERE s.concept_id = p.concept_id
                            AND (s.found = 0 OR COALESCE(s.description, '') = '')))
                     ORDER BY CAST(p.post_id AS INTEGER) DESC`);
  if (!posts.length) return;
  console.log(`[site-meta] ${posts.length} 个游戏商店里没有介绍，从帖子里补`);
  let done = 0;
  for (const p of posts) {
    if (await refreshPostMeta(p)) done++;
    else if (hostHealth(p.url).blocked) break;
  }
  console.log(`[site-meta] 补好 ${done} 个`);
}

export function runSiteMetaBackfill() {
  running ??= backfill().catch(e => console.error('[site-meta]', e.message)).finally(() => { running = null; });
  return running;
}

export function startSiteMetaBackfill() {
  setTimeout(runSiteMetaBackfill, 120_000);
  setInterval(runSiteMetaBackfill, RETRY_MS);
}
