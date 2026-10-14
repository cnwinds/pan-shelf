import { all, one, exec } from '../db.mjs';
import { defineJob, enqueue, isActive } from '../jobs.mjs';
import { getSource, ADAPTERS } from '../sources.mjs';
import { fetchSite, hostHealth } from '../site.mjs';
import { getSettings } from '../settings.mjs';
import { notify } from '../notify.mjs';
import { nowIso } from '../util.mjs';

import { pickLinks, pickSummary } from '../linkpick.mjs';
import { matchCatalogForPost } from '../catalog.mjs';

class SiteBlocked extends Error {}
const AUTO_SKIP = '自动跳过：';

defineJob('crawl', {
  lane: 'site',
  label: '采集',
  // params: { pages?: number, backlog?: boolean = true, list?: boolean = true, post_ids?: string[] }
  async run(ctx) {
    const src = getSource(ctx.job.source_id);
    if (!src) throw new Error('来源不存在');
    const adapter = ADAPTERS[src.adapter];
    const cfg = getSettings().crawl;
    const p = ctx.job.params;
    const counters = { list_pages: 0, new_posts: 0, crawled: 0, new_links: 0, no_link: 0, failed: 0 };
    const summary = () => ({ ...counters, pending_detail: pendingCount(src.id) });

    const fetchOrBlock = async (url) => {
      const html = await fetchSite(url, { signal: ctx.signal });
      if (!html && hostHealth(url).blocked) {
        const e = new SiteBlocked(`站点连续 ${hostHealth(url).fail_streak} 次请求失败，疑似 IP 被封禁，已停止采集`);
        e.summary = summary();
        throw e;
      }
      return html;
    };

    // ---- 阶段 1：翻列表页发现新帖 ----
    const fresh = [];
    if (p.list !== false && !p.post_ids) {
      const maxPages = Math.min(p.pages || cfg.list_pages_default, cfg.list_pages_max);
      let emptyStreak = 0;
      for (let page = 1; page <= maxPages; page++) {
        await ctx.checkpoint();
        const url = adapter.listUrl(src, page);
        ctx.progress({ phase: 'list', page, pages: maxPages, done: 0, total: 0, current: `列表第 ${page} 页`, counters });
        const html = await fetchOrBlock(url);
        if (!html) { ctx.log('warn', `列表第 ${page} 页抓取失败，跳过列表扫描`); break; }
        counters.list_pages++;
        const posts = adapter.extractPosts(html, src);
        let n = 0;
        for (const [id, purl] of posts) {
          const r = exec(`INSERT OR IGNORE INTO posts (source_id, post_id, url, status, discovered_at) VALUES (?, ?, ?, 'pending_detail', ?)`,
            src.id, id, purl, nowIso());
          if (r.changes) { n++; fresh.push(id); }
        }
        counters.new_posts += n;
        ctx.log(`列表第 ${page} 页：${posts.size} 帖，新帖 ${n}`);
        if (posts.size === 0) { ctx.log('warn', '列表页没有解析到帖子，可能是页面结构变化或已到末页'); break; }
        if (page > 1 && n === 0 && ++emptyStreak >= cfg.stop_after_empty_pages) break;
        if (n > 0) emptyStreak = 0;
      }
    }

    // ---- 阶段 2：抓详情（本次新帖优先，再补历史缺口）----
    let queue;
    if (p.post_ids) {
      queue = p.post_ids.map(id => one('SELECT post_id, url, title FROM posts WHERE source_id = ? AND post_id = ?', src.id, String(id))).filter(Boolean);
    } else {
      const freshSet = new Set(fresh);
      const pendings = all(`SELECT post_id, url, title FROM posts WHERE source_id = ? AND status = 'pending_detail' AND fail_count < ?
                            ORDER BY CAST(post_id AS INTEGER) DESC`, src.id, cfg.max_detail_failures);
      const newOnes = pendings.filter(x => freshSet.has(x.post_id));
      let backlog = p.backlog === false ? [] : pendings.filter(x => !freshSet.has(x.post_id));
      if (cfg.backlog_per_run > 0) backlog = backlog.slice(0, cfg.backlog_per_run);
      queue = [...newOnes, ...backlog];
      if (backlog.length) ctx.log(`补抓历史缺口：${backlog.length} 帖`);
    }

    let autoTransferQueued = false;
    for (let i = 0; i < queue.length; i++) {
      await ctx.checkpoint();
      const post = queue[i];
      ctx.progress({ phase: 'detail', done: i, total: queue.length, current: post.title || post.url, counters });
      const html = await fetchOrBlock(post.url);
      if (!html) {
        exec(`UPDATE posts SET fail_count = fail_count + 1, last_error = ?,
              status = CASE WHEN fail_count + 1 >= ? THEN 'failed' ELSE status END WHERE source_id = ? AND post_id = ?`,
          hostHealth(post.url).last_error, cfg.max_detail_failures, src.id, post.post_id);
        counters.failed++;
        ctx.log('warn', `[${post.post_id}] 详情抓取失败：${hostHealth(post.url).last_error}`);
        continue;
      }
      const { title, links, serial } = adapter.extractDetail(html, src);
      const catMatch = matchCatalogForPost(serial, title || post.title);
      const finalSerial = serial || catMatch?.titleId || null;
      const finalConceptId = catMatch?.conceptId || null;
      exec(`UPDATE posts SET title = ?, serial = COALESCE(?, serial), concept_id = COALESCE(?, concept_id), status = ?, crawled_at = ?, fail_count = 0, last_error = NULL WHERE source_id = ? AND post_id = ?`,
        title || post.title, finalSerial, finalConceptId, links.length ? 'links_done' : 'no_link', nowIso(), src.id, post.post_id);
      counters.crawled++;
      if (!links.length) counters.no_link++;
      let added = 0;
      const picked = pickLinks(links);
      // 自动转存关闭时，选中的链接只标为「可入盘」，等你在游戏库里点「加入网盘」
      const want = getSettings().transfer.auto ? 'pending' : 'available';
      for (const l of picked) {
        const skipNote = l.chosen ? null : AUTO_SKIP + l.reason;
        const r = exec(`INSERT OR IGNORE INTO links (surl, source_id, post_id, pwd, title, status, last_error, remark, format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          l.surl, src.id, post.post_id, l.pwd, title, l.chosen ? want : 'skipped', skipNote, l.remark, l.format, nowIso());
        if (r.changes) { if (l.chosen && want === 'pending') added++; continue; }
        // 已有链接（重新采集）：更新备注；还没转存的按新的选择结果调整，不动手动跳过的
        exec(`UPDATE links SET remark = ?, format = ? WHERE surl = ?`, l.remark, l.format, l.surl);
        if (l.chosen) exec(`UPDATE links SET status = ?, last_error = NULL WHERE surl = ? AND status = 'skipped' AND last_error LIKE ?`, want, l.surl, AUTO_SKIP + '%');
        else exec(`UPDATE links SET status = 'skipped', last_error = ? WHERE surl = ? AND status IN ('pending', 'available')`, skipNote, l.surl);
      }
      counters.new_links += added;
      const note = pickSummary(picked);
      ctx.log(`[${post.post_id}] ${title || '(无标题)'}${serial ? ` ${serial}` : ''} → ${links.length} 条链接${note ? `，${note}` : ''}${added ? `（新收录 ${added}）` : ''}`);

      if (added && !autoTransferQueued && getSettings().transfer.auto && !isActive('transfer', src.id)) {
        enqueue('transfer', { source_id: src.id, trigger: 'auto' });
        autoTransferQueued = true;
        ctx.log('已自动启动转存任务');
      }
    }
    ctx.progress({ phase: 'done', done: queue.length, total: queue.length, current: null, counters });
    return summary();
  },
  onDone(job, s) {
    if (s?.new_posts > 0) notify('new_games', 'info', `发现 ${s.new_posts} 个新游戏`, `${sourceName(job)}：新链接 ${s.new_links} 条`);
  },
  onFail(job, e) {
    if (e instanceof SiteBlocked) notify('site_blocked', 'error', '站点疑似封禁，采集已停止', `${sourceName(job)}：${e.message}。已开启定时探测，解封后自动重新采集。`);
    else notify('error', 'error', '采集任务失败', `${sourceName(job)}：${e.message}`);
  },
});

const pendingCount = (sid) => one(`SELECT COUNT(*) n FROM posts WHERE source_id = ? AND status = 'pending_detail'`, sid).n;
const sourceName = (job) => getSource(job.source_id)?.name || job.source_id;

// 探测：被封时定时请求一次首页，恢复后自动采集
defineJob('probe', {
  lane: 'site',
  label: '站点探测',
  async run(ctx) {
    const src = getSource(ctx.job.source_id);
    ctx.progress({ phase: 'probe', current: src.base_url });
    // 首次访问必然是反爬挑战页（下发 cookie），至少要给第二次机会
    const html = await fetchSite(src.base_url + '/', { signal: ctx.signal, retries: 2 });
    ctx.log(html ? '站点可达' : '站点仍不可达');
    return { reachable: !!html };
  },
  onDone(job, s) {
    if (s?.reachable && job.trigger === 'probe') {
      notify('site_blocked', 'success', '站点已恢复访问', `${sourceName(job)}：已自动开始采集`);
      enqueue('crawl', { source_id: job.source_id, trigger: 'probe' });
    }
  },
});
