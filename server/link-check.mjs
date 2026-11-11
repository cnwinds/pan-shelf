// 链接检查：逐条列分享，记下链接还能不能用、分享里文件的总大小和各文件 md5（评价比对也用）。
// 盘游按发布出去的结果判断能不能转存，腾网盘空间时也只退链接还能用的游戏（盘游 docs/adr/0011）。
import { all, exec, tx } from './db.mjs';
import * as bd from './baidu.mjs';
import { bus } from './bus.mjs';
import { nowIso } from './util.mjs';

const RECHECK_MS = 7 * 86400_000;
const INTERVAL_MS = 30 * 60_000;
// 百度对列分享限流（errno -62 要验证码），一条一条慢慢来；连着几次临时出错就停下，下一轮再来
const GAP_MS = 5000;
const STOP_AFTER_ERRORS = 3;

let running = null;
export const checkState = { at: null, checked: 0, dead: 0, error: null };

// 资源库会收的链接：有游戏编号的帖子里没被跳过、还没确认失效的
const dueLinks = (before) => all(`
  SELECT l.surl, l.pwd, l.status, l.title FROM links l
  JOIN posts p ON p.source_id = l.source_id AND p.post_id = l.post_id
  WHERE l.status NOT IN ('skipped', 'invalid') AND COALESCE(p.serial, '') != ''
    AND (l.checked_at IS NULL OR l.checked_at < ?)
  ORDER BY l.checked_at IS NOT NULL, l.checked_at, CAST(l.post_id AS INTEGER) DESC`, before);

function recordAlive(link, files) {
  const at = nowIso();
  tx(() => {
    exec('DELETE FROM share_files WHERE surl = ?', link.surl);
    for (const f of files) exec('INSERT OR REPLACE INTO share_files (surl, path, md5, size) VALUES (?, ?, ?, ?)', link.surl, f.rel, f.md5, f.size || 0);
    exec('UPDATE links SET alive = 1, checked_at = ?, files_at = ?, share_size = ? WHERE surl = ?',
      at, at, files.reduce((n, f) => n + (f.size || 0), 0), link.surl);
  });
}

// 已经在网盘里的（saved / exists）只记下链接死了，状态不动：网盘里那份还在，只是退出后转不回来了
function recordDead(link, reason) {
  const inPan = link.status === 'saved' || link.status === 'exists';
  exec(`UPDATE links SET alive = 0, checked_at = ?${inPan ? '' : `, status = 'invalid', last_error = ?`} WHERE surl = ?`,
    ...(inPan ? [nowIso(), link.surl] : [nowIso(), `链接检查：${reason}`, link.surl]));
}

export function checkLinks() {
  if (running) return running;
  running = (async () => {
    let checked = 0, dead = 0, errors = 0, lastError = null;
    for (const link of dueLinks(new Date(Date.now() - RECHECK_MS).toISOString())) {
      const r = await bd.listShare(link.surl, link.pwd);
      if (!r.error) {
        recordAlive(link, r.files);
        checked++; errors = 0;
      } else if (r.invalid) {
        recordDead(link, r.error);
        checked++; dead++; errors = 0;
        console.log(`链接失效：${link.title || link.surl}（${r.error}）`);
      } else {
        lastError = r.error;
        if (++errors >= STOP_AFTER_ERRORS) break;
      }
      if (checked && checked % 20 === 0) bus.emit('links_checked', { checked, dead });
      await new Promise(ok => setTimeout(ok, GAP_MS));
    }
    Object.assign(checkState, { at: nowIso(), checked, dead, error: errors >= STOP_AFTER_ERRORS ? lastError : null });
    if (checked) bus.emit('links_checked', { checked, dead });
    return { checked, dead };
  })()
    .catch((e) => { checkState.error = e.message; console.warn(`链接检查失败：${e.message}`); return null; })
    .finally(() => { running = null; });
  return running;
}

export function linkCheckStatus() {
  const counts = all(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN l.checked_at IS NOT NULL THEN 1 ELSE 0 END) checked,
           SUM(CASE WHEN l.alive = 0 THEN 1 ELSE 0 END) dead
    FROM links l JOIN posts p ON p.source_id = l.source_id AND p.post_id = l.post_id
    WHERE l.status != 'skipped' AND COALESCE(p.serial, '') != ''`)[0];
  return { ...checkState, running: !!running, total: counts.total || 0, checked_total: counts.checked || 0, dead_total: counts.dead || 0 };
}

export function startLinkCheck() {
  setTimeout(checkLinks, 60_000);
  setInterval(checkLinks, INTERVAL_MS);
  bus.on('job', (job) => { if (job?.status === 'done' && job.type === 'crawl') checkLinks(); });
}
