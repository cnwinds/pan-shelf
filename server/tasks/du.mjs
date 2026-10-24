// 网盘用量扫描：统计某目录下每个子项的大小。逐个子项落库，断点续扫（已扫的跳过，force 时重扫）
import { all, exec, one } from '../db.mjs';
import { defineJob } from '../jobs.mjs';
import * as bd from '../baidu.mjs';
import { nowIso } from '../util.mjs';

const parentOf = (p) => p === '/' ? '' : (p.slice(0, p.lastIndexOf('/')) || '/');
const join = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;

async function duTree(ctx, start, stats) {
  let size = 0, files = 0, dirs = 0, fails = 0;
  const queue = [start];
  let inflight = 0;
  // 队列暂时为空但还有目录在读时，空闲 worker 要等它们产出子目录，而不是直接退出
  const worker = async () => {
    for (;;) {
      await ctx?.checkpoint();
      const dir = queue.shift();
      if (dir === undefined) {
        if (inflight === 0) return;
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      inflight++;
      try {
        const list = await bd.listDir(dir);
        stats.requests++;
        if (list) for (const e of list) {
          if (e.isdir) { dirs++; queue.push(join(dir, e.name)); }
          else { files++; size += e.size; }
        }
        stats.scanned_dirs++;
        ctx?.progress({ stats });
      } catch { fails++; }
      finally { inflight--; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { size, files, dirs, fails };
}

defineJob('du', {
  lane: 'scan',
  label: '用量扫描',
  // params: { path = '/', force = false }
  async run(ctx) {
    const root = ctx.job.params.path || '/';
    const force = !!ctx.job.params.force;
    const list = await bd.listDir(root);
    if (!list) throw new Error('目录不存在：' + root);
    const stats = { requests: 1, scanned_dirs: 0 };
    const upsert = (e, r) => exec(`INSERT OR REPLACE INTO du_results (path, parent, name, is_dir, size, files, dirs, fails, scanned_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, join(root, e.name), root, e.name, e.isdir ? 1 : 0, r.size, r.files, r.dirs, r.fails, nowIso());

    // 清掉已不存在的旧记录
    const names = new Set(list.map(e => e.name));
    for (const old of all('SELECT path, name FROM du_results WHERE parent = ?', root)) {
      if (!names.has(old.name)) exec('DELETE FROM du_results WHERE path = ? OR path LIKE ?', old.path, old.path + '/%');
    }
    list.filter(e => !e.isdir).forEach(e => upsert(e, { size: e.size, files: 1, dirs: 0, fails: 0 }));

    const dirs = list.filter(e => e.isdir);
    let skipped = 0;
    for (let i = 0; i < dirs.length; i++) {
      await ctx.checkpoint();
      const e = dirs[i];
      const p = join(root, e.name);
      ctx.progress({ phase: 'scan', done: i, total: dirs.length, current: p, stats });
      if (!force && one('SELECT 1 FROM du_results WHERE path = ?', p)) { skipped++; continue; }
      const t0 = Date.now();
      const r = await duTree(ctx, p, stats);
      upsert(e, r);
      ctx.log(`${p}：${(r.size / 1024 ** 3).toFixed(1)} GB，${r.files} 个文件，用时 ${Math.round((Date.now() - t0) / 1000)} 秒${r.fails ? `，${r.fails} 个目录读取失败` : ''}`);
    }
    ctx.progress({ phase: 'done', done: dirs.length, total: dirs.length, current: null, stats });
    if (skipped) ctx.log(`跳过已扫描的 ${skipped} 个目录（勾选「重新扫描」可强制刷新）`);
    return { path: root, dirs: dirs.length, skipped, ...stats };
  },
});

// 不走任务队列直接统计一个目录（游戏详情里按需统计），结果和用量扫描写同一张表；同一目录并发请求只扫一次
const measuring = new Map();
export function measureDir(path) {
  if (measuring.has(path)) return measuring.get(path);
  const p = duTree(null, path, { requests: 0, scanned_dirs: 0 })
    .then((r) => {
      exec(`INSERT OR REPLACE INTO du_results (path, parent, name, is_dir, size, files, dirs, fails, scanned_at)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`, path, parentOf(path), path.slice(path.lastIndexOf('/') + 1), r.size, r.files, r.dirs, r.fails, nowIso());
      return r;
    })
    .finally(() => measuring.delete(path));
  measuring.set(path, p);
  return p;
}

export function duChildren(dir) {
  return all('SELECT * FROM du_results WHERE parent = ? ORDER BY size DESC', dir);
}
export { parentOf };
