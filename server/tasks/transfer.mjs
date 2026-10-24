import { one, exec } from '../db.mjs';
import { defineJob, enqueue, isActive } from '../jobs.mjs';
import { getSource } from '../sources.mjs';
import * as bd from '../baidu.mjs';
import { getSettings } from '../settings.mjs';
import { notify } from '../notify.mjs';
import { nowIso, fmtBytes } from '../util.mjs';
import { excludeRe, pruneExcluded } from './prune.mjs';
import { linkDestDir, flattenWrapper } from '../layout.mjs';
import { ensureShareFiles, badReviewOfLink, hasMatchableBad, freshReviews } from '../reviews.mjs';

// 盘游标记过不能玩的那份资源（分享里有它主游戏的全部分卷）就不转存；你点过「仍然加入」的不拦
async function knownBad(ctx, link) {
  if (link.allow_bad || !hasMatchableBad()) return null;
  const error = await ensureShareFiles(link);
  if (error) {
    ctx.log('warn', `没能列出分享里的文件，不核对评价直接转存：${link.title || link.surl}（${error}）`);
    return null;
  }
  return badReviewOfLink(link.surl);
}

export const badReason = (r) =>
  `盘游标记过不能玩${r.note ? `：${r.note}` : ''}（${r.device || '盘游'}${r.firmware ? `，固件 ${r.firmware}` : ''}，${new Date(r.at * 1000).toLocaleDateString('zh-CN')}）`;

const GB = 1024 ** 3;

export async function requireLogin(ctx) {
  if (await bd.whoami()) return;
  notify('login_expired', 'error', '百度网盘登录已失效', '请在盘架的「设置 → 网盘账号」里重新扫码登录');
  throw new Error('百度网盘登录已失效，请在「设置 → 网盘账号」重新扫码登录');
}

defineJob('transfer', {
  lane: 'pan',
  label: '转存',
  // params: { surls?: string[] 只转存指定链接, limit?: number }
  async run(ctx) {
    const src = getSource(ctx.job.source_id);
    if (!src) throw new Error('来源不存在');
    const p = ctx.job.params;
    await requireLogin(ctx);
    await freshReviews();

    const counts = { saved: 0, exists: 0, invalid: 0, failed: 0, bad: 0 };
    const badTitles = [];
    const limit = p.limit || getSettings().transfer.max_per_run || Infinity;
    const only = p.surls ? new Set(p.surls) : null;
    const tried = new Set();
    let done = 0, sinceQuota = Infinity, lastFree = null;

    const remaining = () => only
      ? [...only].filter(s => !tried.has(s)).length
      : one(`SELECT COUNT(*) n FROM links WHERE source_id = ? AND status = 'pending'`, src.id).n;

    const nextLink = () => {
      if (only) {
        for (const s of only) if (!tried.has(s)) { tried.add(s); return one('SELECT * FROM links WHERE surl = ?', s); }
        return null;
      }
      const l = one(`SELECT * FROM links WHERE source_id = ? AND status = 'pending' ORDER BY CAST(post_id AS INTEGER) DESC, surl LIMIT 1`, src.id);
      if (l && tried.has(l.surl)) return null;
      if (l) tried.add(l.surl);
      return l;
    };

    const guardQuota = async (force) => {
      const cfg = getSettings().transfer;
      if (!force && sinceQuota < cfg.quota_check_every) return;
      sinceQuota = 0;
      try {
        const q = await bd.quota();
        lastFree = q.free;
        ctx.progress({ quota: q });
        if (q.free < cfg.reserve_gb * GB) {
          const msg = `网盘剩余 ${fmtBytes(q.free)}，低于保底线 ${cfg.reserve_gb} GB`;
          notify('quota_low', 'warn', '网盘空间不足，转存已暂停', msg + '。清理空间或调低保底线后，在任务页点「继续」。');
          await ctx.pauseSelf(msg);
          return guardQuota(true);
        }
      } catch (e) { ctx.log('warn', '配额查询失败：' + e.message); }
    };

    ctx.log(`目标目录 ${src.dest_dir}，待转存 ${remaining()} 条`);
    while (done < limit) {
      await ctx.checkpoint();
      await guardQuota(false);
      let link = nextLink();
      if (!link) {
        const cfg = getSettings().transfer;
        // 不自动转存时采集只产出「可入盘」链接，等下去没有意义；加入网盘会自己启动转存
        if (!only && cfg.auto && cfg.follow_crawl && isActive('crawl', src.id)) {
          ctx.progress({ phase: 'waiting', current: '等待采集产出新链接…', done, total: done });
          await ctx.sleep(5000);
          continue;
        }
        break;
      }
      ctx.progress({ phase: 'transfer', done, total: done + remaining() + 1, current: link.title || link.surl, counts, free: lastFree });
      if (link.status !== 'pending' && only) exec(`UPDATE links SET status = 'pending' WHERE surl = ?`, link.surl);

      const bad = await knownBad(ctx, link);
      if (bad) {
        exec(`UPDATE links SET status = 'bad', last_error = ? WHERE surl = ?`, badReason(bad), link.surl);
        counts.bad++;
        badTitles.push(link.title || link.surl);
        ctx.log('warn', `没有转存 ${link.title || link.surl}：${badReason(bad)}。要转存的话在游戏库里点「仍然加入」`);
        ctx.progress({ done, total: done + remaining(), counts });
        continue;
      }

      const dest = linkDestDir(src, link);
      if (dest !== src.dest_dir) await bd.mkdir(dest.slice(0, dest.lastIndexOf('/')), ctx.signal);
      const r = await bd.transferOne(link.surl, link.pwd, dest, { timeoutSec: getSettings().transfer.timeout_sec, signal: ctx.signal });
      if (r.status === 'err_quota') {
        exec(`UPDATE links SET last_error = ?, attempts = attempts + 1 WHERE surl = ?`, r.detail, link.surl);
        tried.delete(link.surl);
        ctx.log('warn', `空间不足：${link.title}`);
        notify('quota_low', 'warn', '网盘空间不足，转存已暂停', '清理空间后在任务页点「继续」。');
        await ctx.pauseSelf('网盘空间不足（转存接口返回）');
        sinceQuota = Infinity;
        continue;
      }
      exec(`UPDATE links SET status = ?, attempts = attempts + 1, last_error = ?, dest_dir = ?, transferred_at = ?, saved_names = COALESCE(?, saved_names) WHERE surl = ?`,
        r.status, r.detail || null, dest, nowIso(), r.names?.length ? JSON.stringify(r.names) : null, link.surl);
      if (r.status === 'saved' && dest !== src.dest_dir) {
        try { await flattenWrapper(dest, r.names, { signal: ctx.signal, log: (m) => ctx.log(m) }); }
        catch (e) { if (ctx.signal.aborted) throw e; ctx.log('warn', `去掉外包目录失败：${e.message}`); }
      }
      done++; sinceQuota++;
      if (r.status === 'saved') counts.saved++;
      else if (r.status === 'exists') counts.exists++;
      else if (r.status === 'invalid') counts.invalid++;
      else counts.failed++;
      const lvl = r.status === 'saved' || r.status === 'exists' ? 'info' : 'warn';
      ctx.log(lvl, `${{ saved: '已转存', exists: '已存在', invalid: '链接失效' }[r.status] || r.status}  ${link.title || ''} (${link.surl})${r.detail && lvl === 'warn' ? '  ' + r.detail : ''}`);
      ctx.progress({ done, total: done + remaining(), counts });
      await ctx.sleep(getSettings().transfer.interval_ms);
    }
    let pruned = null;
    if (counts.saved > 0 && excludeRe()) {
      try { pruned = await pruneExcluded(ctx, src.dest_dir); }
      catch (e) { if (ctx.signal.aborted) throw e; ctx.log('warn', '清理排除项失败：' + e.message); }
    }
    ctx.progress({ phase: 'done', current: null, done, total: done, counts });
    return { ...counts, total: done, pending_left: remaining(), bad_titles: badTitles.slice(0, 5), ...(pruned?.deleted ? { pruned: pruned.deleted, pruned_bytes: pruned.bytes } : {}) };
  },
  onDone(job, s) {
    if (s?.bad) {
      notify('run_done', 'warn', `${s.bad} 个游戏盘游标记过不能玩，没有转存`,
        `${s.bad_titles.join('、')}${s.bad > 5 ? ' 等' : ''}。确实要的话在游戏库里打开它，点「仍然加入」。`);
    }
    if (!s || s.total === 0) return;
    const name = getSource(job.source_id)?.name || job.source_id;
    notify('run_done', s.failed ? 'warn' : 'success', `转存完成：新增 ${s.saved} 个`,
      `${name}：已存在 ${s.exists}，失效 ${s.invalid}，失败 ${s.failed}${s.pending_left ? `，剩余 ${s.pending_left}` : ''}${s.pruned ? `；按排除规则删除 ${s.pruned} 项（${fmtBytes(s.pruned_bytes)}）` : ''}`);
    if (s.saved > 0 && getSettings().normalize.auto_plan_after_transfer) {
      enqueue('normalize_plan', { source_id: job.source_id, trigger: 'auto' });
    }
  },
  onFail(job, e) {
    notify('error', 'error', '转存任务失败', e.message);
  },
});
