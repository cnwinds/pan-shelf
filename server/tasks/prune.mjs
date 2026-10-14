// 清理排除项：删掉目标目录里名称命中排除规则的文件/目录（如 PKG 版本）。
//   命中的目录整个删除、不再深入；删完后父目录若已空（重新列目录确认）也一并删除。
import { defineJob } from '../jobs.mjs';
import { getSource } from '../sources.mjs';
import * as bd from '../baidu.mjs';
import { getSettings } from '../settings.mjs';
import { notify } from '../notify.mjs';
import { fmtBytes } from '../util.mjs';
import { requireLogin } from './transfer.mjs';

export function excludeRe() {
  const t = getSettings().transfer;
  if (!t.exclude_enabled || !t.exclude_pattern) return null;
  const re = new RegExp(t.exclude_pattern, 'i');
  return re.test('') ? null : re;
}

export async function treeSize(dir) {
  let size = 0;
  for (const e of await bd.listDir(dir) || []) size += e.isdir ? await treeSize(e.path) : e.size;
  return size;
}

export const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

// 由深到浅检查这些目录（root 以内、不含 root），重新列目录确认已空才删，删掉后继续检查它的父目录
export async function removeEmptyDirs(ctx, root, dirs) {
  const pending = [...dirs];
  let emptied = 0;
  while (pending.length) {
    pending.sort((a, b) => b.split('/').length - a.split('/').length);
    const dir = pending.shift();
    if (dir === root || !dir.startsWith(root + '/')) continue;
    await ctx.checkpoint();
    const left = await bd.listDir(dir);
    if (!left || left.length) continue;
    if (await bd.rm([dir], ctx.signal)) {
      emptied++;
      ctx.log(`已删除空目录 ${dir}`);
      const up = parentOf(dir);
      if (!pending.includes(up)) pending.push(up);
    }
    await ctx.sleep(getSettings().normalize.op_interval_ms);
  }
  return emptied;
}

// dry = true 时只列出命中项，不删除
export async function pruneExcluded(ctx, root, { dry = false } = {}) {
  const re = excludeRe();
  if (!re) return null;
  const hits = [];
  const queue = [root];
  let scanned = 0;
  while (queue.length) {
    await ctx.checkpoint();
    const dir = queue.shift();
    ctx.progress({ phase: 'prune_scan', done: scanned, total: scanned + queue.length + 1, current: dir });
    const list = await bd.listDir(dir);
    scanned++;
    if (!list) continue;
    for (const e of list) {
      if (re.test(e.name)) hits.push({ path: e.path, isdir: e.isdir, size: e.isdir ? await treeSize(e.path) : e.size });
      else if (e.isdir) queue.push(e.path);
    }
  }
  const total = hits.reduce((s, h) => s + h.size, 0);
  if (!hits.length) { ctx.log(`排除规则没有命中任何文件（扫描了 ${scanned} 个目录）`); return { matched: 0, deleted: 0, failed: 0, bytes: 0, emptied: 0 }; }
  ctx.log(`排除规则命中 ${hits.length} 项，共 ${fmtBytes(total)}${dry ? '（仅预览，未删除）' : ''}`);
  if (dry) { hits.forEach(h => ctx.log(`  ${h.isdir ? '[目录] ' : ''}${h.path}  ${fmtBytes(h.size)}`)); return { matched: hits.length, deleted: 0, failed: 0, bytes: total, emptied: 0, dry: true }; }

  await requireLogin(ctx);
  const opDelay = () => ctx.sleep(getSettings().normalize.op_interval_ms);
  let deleted = 0, failed = 0, bytes = 0, emptied = 0;
  const parents = new Set();
  for (let i = 0; i < hits.length; i++) {
    await ctx.checkpoint();
    const h = hits[i];
    ctx.progress({ phase: 'prune_delete', done: i, total: hits.length, current: h.path });
    const ok = await bd.rm([h.path], ctx.signal);
    if (ok) { deleted++; bytes += h.size; parents.add(parentOf(h.path)); } else failed++;
    ctx.log(ok ? 'info' : 'warn', `${ok ? '已删除' : '删除失败'} ${h.isdir ? '[目录] ' : ''}${h.path}  ${fmtBytes(h.size)}`);
    await opDelay();
  }

  emptied = await removeEmptyDirs(ctx, root, parents);
  ctx.progress({ phase: 'done', done: hits.length, total: hits.length, current: null });
  ctx.log(`清理完成：删除 ${deleted} 项，释放 ${fmtBytes(bytes)}${emptied ? `，另删除 ${emptied} 个空目录` : ''}${failed ? `，${failed} 项失败` : ''}`);
  return { matched: hits.length, deleted, failed, bytes, emptied };
}

defineJob('prune', {
  lane: 'pan',
  label: '清理排除项',
  // params: { dry?: boolean }
  async run(ctx) {
    const src = getSource(ctx.job.source_id);
    if (!src) throw new Error('来源不存在');
    if (!excludeRe()) throw new Error('排除规则未启用，请先在「设置 → 转存策略」里打开');
    return pruneExcluded(ctx, src.dest_dir, { dry: !!ctx.job.params.dry });
  },
  onDone(job, s) {
    if (s?.deleted) notify('run_done', s.failed ? 'warn' : 'success', `已清理排除项：${s.deleted} 项`, `释放 ${fmtBytes(s.bytes)}${s.failed ? `，${s.failed} 项删除失败` : ''}`);
  },
  onFail(job, e) { notify('error', 'error', '清理排除项失败', e.message); },
});
