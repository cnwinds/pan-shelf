// 重复版本清理：同一游戏的多个版本都已转存进网盘时，只保留按「收录哪个版本」规则选中的那个。
//   每条链接的文件清单从分享本身读取（文件名 + 大小），再到网盘里精确匹配，不靠文件名猜测来源。
//   只删「属于未选中链接、且不属于选中链接」的文件，并且只在选中版本所在的游戏目录里删。
import { all } from '../db.mjs';
import { defineJob } from '../jobs.mjs';
import { getSource } from '../sources.mjs';
import * as bd from '../baidu.mjs';
import { getSettings } from '../settings.mjs';
import { notify } from '../notify.mjs';
import { fmtBytes } from '../util.mjs';
import { pickLinks, FORMAT_LABEL } from '../linkpick.mjs';
import { requireLogin } from './transfer.mjs';
import { parentOf, removeEmptyDirs } from './prune.mjs';

const MIN_SIZE = 1024 ** 2;                                     // 小文件（站点说明 txt / url）各游戏都一样，不参与匹配
// 补丁 / 降级包 / DLC 常被别的版本共用（如旧版本分享里附带新版本的 4.xx 降级包），一律保留。
// 特征可能只出现在所在目录名上，所以同时检查分享内路径和网盘路径
const KEEP_RE = /补丁|降级|backport|patch|dlc|金手指|baderlink|(^|[^0-9])[4-9]\.xx/i;
const key = (f) => f.name.toLowerCase() + '|' + f.size;
const describe = (l) => FORMAT_LABEL[l.format] + (l.version ? ' ' + l.version : '');

async function indexPan(ctx, root) {
  const byKey = new Map();
  const queue = [root];
  let scanned = 0;
  while (queue.length) {
    await ctx.checkpoint();
    const dir = queue.shift();
    ctx.progress({ phase: 'dedupe_index', done: scanned, total: scanned + queue.length + 1, current: dir });
    const list = await bd.listDir(dir) || [];
    scanned++;
    for (const e of list) {
      if (e.isdir) { queue.push(e.path); continue; }
      if (e.size < MIN_SIZE) continue;
      const k = key({ name: e.name, size: e.size });
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(e.path);
    }
  }
  ctx.log(`网盘索引完成：${scanned} 个目录`);
  return byKey;
}

const topDirOf = (root, p) => root + '/' + p.slice(root.length + 1).split('/')[0];

defineJob('dedupe', {
  lane: 'pan',
  label: '重复版本清理',
  // params: { dry?: boolean = true }
  async run(ctx) {
    const src = getSource(ctx.job.source_id);
    if (!src) throw new Error('来源不存在');
    const dry = ctx.job.params.dry !== false;
    const root = src.dest_dir;
    const posts = all(`SELECT p.post_id, p.title FROM posts p WHERE p.source_id = ? AND
                         (SELECT COUNT(*) FROM links l WHERE l.source_id = p.source_id AND l.post_id = p.post_id AND l.status IN ('saved','exists')) > 1
                       ORDER BY CAST(p.post_id AS INTEGER) DESC`, src.id);
    ctx.log(`${posts.length} 个游戏转存过多个链接`);
    if (!posts.length) return { games: 0, files: 0, bytes: 0 };

    const byKey = await indexPan(ctx, root);
    const delay = Math.max(300, getSettings().normalize.op_interval_ms);
    const plan = [];
    const skipped = [];
    for (let i = 0; i < posts.length; i++) {
      await ctx.checkpoint();
      const post = posts[i];
      const tag = `[${post.post_id}] ${post.title}`;
      ctx.progress({ phase: 'dedupe_share', done: i, total: posts.length, current: post.title });
      const links = all('SELECT surl, pwd, status, remark FROM links WHERE source_id = ? AND post_id = ? ORDER BY rowid', src.id, post.post_id);
      if (links.some(l => l.remark === null)) { skipped.push(tag); ctx.log('warn', `${tag}：缺少版本备注，请先在游戏库重新采集，跳过`); continue; }
      const picked = pickLinks(links);
      const best = picked.find(l => l.chosen);
      if (!best) { skipped.push(tag); ctx.log('warn', `${tag}：没有可收录的版本，跳过`); continue; }

      const shares = new Map();
      for (const l of picked) {
        if (l !== best && !['saved', 'exists'].includes(l.status)) continue;
        const r = await bd.listShare(l.surl, l.pwd);
        shares.set(l.surl, r);
        await ctx.sleep(delay);
      }
      const bestShare = shares.get(best.surl);
      if (bestShare.error) { skipped.push(tag); ctx.log('warn', `${tag}：选中版本（${describe(best)}）的分享读取失败：${bestShare.error}，跳过`); continue; }
      const bestFiles = bestShare.files.filter(f => f.size >= MIN_SIZE);
      const bestKeys = new Set(bestFiles.map(key));
      const total = bestFiles.reduce((s, f) => s + f.size, 0);
      const found = bestFiles.filter(f => byKey.has(key(f)));
      const missing = bestFiles.filter(f => !byKey.has(key(f)));
      // 选中版本必须完整在盘（常见缺失原因：规整合并时与旧版本同名分卷判重，留下的是旧版本那一卷）
      if (!total || missing.length) {
        skipped.push(tag);
        const foundBytes = found.reduce((s, f) => s + f.size, 0);
        ctx.log('warn', `${tag}：选中版本（${describe(best)}）在网盘里不完整（${fmtBytes(foundBytes)} / ${fmtBytes(total)}，缺 ${missing.length} 个文件：${missing.slice(0, 3).map(f => f.name).join('、')}${missing.length > 3 ? ' 等' : ''}），跳过`);
        continue;
      }
      const scope = new Set(found.flatMap(f => byKey.get(key(f)).map(p => topDirOf(root, p))));

      const victims = new Map();
      const bySource = [];
      for (const l of picked) {
        if (l === best || !shares.has(l.surl)) continue;
        const r = shares.get(l.surl);
        if (r.error) { ctx.log('warn', `${tag}：${describe(l)} 的分享读取失败（${r.error}），它的文件无法识别，保留`); continue; }
        let n = 0, bytes = 0;
        for (const f of r.files) {
          if (f.size < MIN_SIZE || KEEP_RE.test(f.rel) || bestKeys.has(key(f))) continue;
          for (const p of byKey.get(key(f)) || []) {
            if (!scope.has(topDirOf(root, p)) || victims.has(p) || KEEP_RE.test(p.slice(root.length))) continue;
            victims.set(p, f.size); n++; bytes += f.size;
          }
        }
        if (n) bySource.push(`${describe(l)} ${n} 个文件 ${fmtBytes(bytes)}`);
      }
      if (!victims.size) { ctx.log(`${tag}：保留 ${describe(best)}，没有可删的其它版本`); continue; }
      const bytes = [...victims.values()].reduce((s, n) => s + n, 0);
      plan.push({ tag, victims, bytes });
      ctx.log(`${tag}：保留 ${describe(best)}（${[...scope].map(d => d.slice(root.length + 1)).join('、')}），删除 ${bySource.join('；')}`);
      if (dry) for (const p of victims.keys()) ctx.log(`    ${p.slice(root.length + 1)}`);
    }

    const files = plan.reduce((s, g) => s + g.victims.size, 0);
    const bytes = plan.reduce((s, g) => s + g.bytes, 0);
    ctx.log(`合计：${plan.length} 个游戏，${files} 个文件，${fmtBytes(bytes)}${skipped.length ? `；跳过 ${skipped.length} 个游戏` : ''}${dry ? '（仅预览，未删除）' : ''}`);
    if (dry || !files) return { games: plan.length, files, bytes, skipped: skipped.length, dry };

    await requireLogin(ctx);
    let deleted = 0, failed = 0, freed = 0, done = 0;
    const parents = new Set();
    for (const g of plan) {
      for (const [p, size] of g.victims) {
        await ctx.checkpoint();
        ctx.progress({ phase: 'dedupe_delete', done: done++, total: files, current: p });
        if (await bd.rm([p], ctx.signal)) { deleted++; freed += size; parents.add(parentOf(p)); }
        else { failed++; ctx.log('warn', `删除失败 ${p}`); }
        await ctx.sleep(getSettings().normalize.op_interval_ms);
      }
      ctx.log(`${g.tag}：已删除其它版本`);
    }
    const emptied = await removeEmptyDirs(ctx, root, parents);
    ctx.progress({ phase: 'done', done: files, total: files, current: null });
    ctx.log(`清理完成：删除 ${deleted} 个文件，释放 ${fmtBytes(freed)}${emptied ? `，另删除 ${emptied} 个空目录` : ''}${failed ? `，${failed} 个失败` : ''}`);
    return { games: plan.length, files: deleted, failed, bytes: freed, skipped: skipped.length };
  },
  onDone(job, s) {
    if (!s?.dry && s?.files) notify('run_done', s.failed ? 'warn' : 'success', `重复版本清理完成：${s.games} 个游戏`, `删除 ${s.files} 个文件，释放 ${fmtBytes(s.bytes)}`);
  },
  onFail(job, e) { notify('error', 'error', '重复版本清理失败', e.message); },
});
