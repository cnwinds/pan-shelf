// 从网盘删除游戏：按游戏编号（PPSA12345）在目标目录顶层找对应的目录 / 文件，整个删除；
// 删除后该游戏的链接恢复为「可入盘」，之后还能重新加入网盘。
import { all, one, exec, tx } from '../db.mjs';
import { defineJob } from '../jobs.mjs';
import { getSource } from '../sources.mjs';
import * as bd from '../baidu.mjs';
import { getSettings } from '../settings.mjs';
import { notify } from '../notify.mjs';
import { fmtBytes, nowIso } from '../util.mjs';
import { pickLinks, FORMAT_DIR, isFormatDir } from '../linkpick.mjs';
import { linkFormat } from '../layout.mjs';
import { requireLogin } from './transfer.mjs';
import { serialsFromName } from './normalize.mjs';
import { treeSize } from './prune.mjs';

// 返回 [{ post_id, title, serial, targets: [{ path, name, isdir, size }], problem }]
export async function resolveRemoval(sourceId, postIds, { sizes = true, formats = null } = {}) {
  const src = getSource(sourceId);
  if (!src) throw new Error('来源不存在');
  const top = await bd.listDir(src.dest_dir) || [];
  // 用实时目录清掉用量缓存里已不存在的条目，否则游戏库会按缓存继续显示为已入盘
  const liveNames = new Set(top.map(e => e.name));
  for (const old of all('SELECT path, name FROM du_results WHERE parent = ?', src.dest_dir)) {
    if (!liveNames.has(old.name)) exec('DELETE FROM du_results WHERE path = ? OR path LIKE ?', old.path, old.path + '/%');
  }
  const owners = top.map(e => ({ e, serials: serialsFromName(e.name) }));
  const match = (wanted) => owners.filter(({ serials }) => [...serials].some(s => wanted.has(s)));
  const out = [];
  for (const id of postIds) {
    const p = one('SELECT post_id, title, serial, share_serials FROM posts WHERE source_id = ? AND post_id = ?', sourceId, String(id));
    if (!p) continue;
    const g = { post_id: p.post_id, title: p.title, serial: p.serial, targets: [], problem: null };
    out.push(g);
    let wanted = new Set([p.serial, ...(p.share_serials || '').split(',')].filter(Boolean));
    let hits = match(wanted), unsure = false;
    const hasSaved = !!one(`SELECT 1 FROM links WHERE source_id = ? AND post_id = ? AND status IN ('saved', 'exists')`, sourceId, p.post_id);
    if (!hits.length && p.share_serials == null && hasSaved) {
      const found = await shareSerials(sourceId, p.post_id);
      unsure = !found;
      if (found) {
        exec('UPDATE posts SET share_serials = ? WHERE source_id = ? AND post_id = ?', [...found].join(','), sourceId, p.post_id);
        wanted = new Set([...wanted, ...found]);
        hits = match(wanted);
      }
    }
    if (!wanted.size) { g.problem = '不知道这个游戏的编号（帖子没写，分享也读不到），请手动在网盘删除'; continue; }
    for (const { e, serials } of hits) {
      // 名称里同时有别的编号，说明可能混着别的游戏，交给你手动处理
      if ([...serials].some(s => !wanted.has(s))) { g.problem = `「${e.name}」同时包含多个游戏编号，未纳入删除`; continue; }
      let size = e.size;
      if (e.isdir && sizes) size = one('SELECT size FROM du_results WHERE path = ?', e.path)?.size ?? await treeSize(e.path);
      g.targets.push({ path: e.path, name: e.name, isdir: e.isdir, size: e.isdir && !sizes ? null : size });
    }
    if (formats?.length && g.targets.length) await narrowToFormats(g, formats, sizes);
    if (!g.targets.length && !g.problem && unsure) g.problem = `网盘里没有 ${[...wanted].join(' / ')}，分享也已读不到、无法确认实际编号，请手动在网盘删除`;
    else if (!g.targets.length && !g.problem) { g.missing = true; g.problem = `网盘 ${src.dest_dir} 里没有 ${[...wanted].join(' / ')}，确认后只把记录改回「未入盘」`; }
  }
  return out;
}

// 只退出其中几种格式：删游戏目录下对应的格式子目录；删完游戏目录里没别的东西了，游戏目录也删掉
async function narrowToFormats(g, formats, sizes) {
  const wanted = new Set(formats.map(f => FORMAT_DIR[f]).filter(Boolean));
  const out = [];
  for (const t of g.targets) {
    const kids = t.isdir ? await bd.listDir(t.path) : null;
    if (!kids?.some(k => k.isdir && isFormatDir(k.name))) {
      g.problem = `「${t.name}」没有按格式分子目录，只能整个退出网盘`;
      continue;
    }
    const hit = kids.filter(k => k.isdir && wanted.has(k.name.toLowerCase()));
    if (hit.length && hit.length === kids.length) { out.push(t); continue; }
    for (const k of hit) {
      const size = sizes ? one('SELECT size FROM du_results WHERE path = ?', k.path)?.size ?? await treeSize(k.path) : null;
      out.push({ path: k.path, name: `${t.name}/${k.name}`, isdir: true, size });
    }
  }
  g.targets = out;
  g.formats = formats;
}

// 读已转存链接的分享文件列表，从文件名里取编号；分享全都读不了时返回 null（下次再试）
async function shareSerials(sourceId, postId) {
  const links = all(`SELECT surl, pwd FROM links WHERE source_id = ? AND post_id = ? AND status IN ('saved', 'exists')`, sourceId, postId);
  const found = new Set();
  let readable = false;
  for (const l of links) {
    const r = await bd.listShare(l.surl, l.pwd);
    if (r.error) continue;
    readable = true;
    r.files.forEach(f => f.rel.split('/').forEach(seg => serialsFromName(seg).forEach(s => found.add(s))));
  }
  return readable ? found : null;
}

// 删除后：链接恢复为可入盘，多版本里没选中的保持跳过。formats 给了时只动这些格式的链接
export function resetLinks(sourceId, postId, formats = null) {
  const links = all(`SELECT surl, pwd, remark, format, status FROM links WHERE source_id = ? AND post_id = ? ORDER BY rowid`, sourceId, postId);
  const picked = links.some(l => l.remark === null) ? links.map(l => ({ ...l, chosen: true })) : pickLinks(links);
  tx(() => {
    for (const l of picked) {
      if (formats && !formats.includes(linkFormat(l))) continue;
      if (!['saved', 'exists', 'pending'].includes(l.status) && !(l.chosen && l.status.startsWith('err_'))) continue;
      if (l.chosen) exec(`UPDATE links SET status = 'available', last_error = ?, dest_dir = NULL, transferred_at = NULL, saved_names = NULL, allow_bad = 0 WHERE surl = ?`, `已从网盘删除（${nowIso().slice(0, 10)}）`, l.surl);
      else exec(`UPDATE links SET status = 'skipped', last_error = ? WHERE surl = ?`, '自动跳过：' + (l.reason || '未选中的版本'), l.surl);
    }
  });
}

defineJob('remove', {
  lane: 'pan',
  label: '从网盘删除',
  // params: { post_ids: string[], formats?: string[] 只退出这些格式 }
  async run(ctx) {
    const src = getSource(ctx.job.source_id);
    if (!src) throw new Error('来源不存在');
    await requireLogin(ctx);
    const formats = ctx.job.params.formats?.length ? ctx.job.params.formats : null;
    const games = await resolveRemoval(src.id, ctx.job.params.post_ids || [], { sizes: false, formats });
    const sizeOf = (t) => one('SELECT size FROM du_results WHERE path = ?', t.path)?.size ?? t.size ?? 0;
    let removed = 0, failed = 0, bytes = 0, trashed = 0, trashedBytes = 0;
    const done = [];
    for (let i = 0; i < games.length; i++) {
      await ctx.checkpoint();
      const g = games[i];
      ctx.progress({ phase: 'remove', done: i, total: games.length, current: g.title });
      if (g.missing) ctx.log(`${g.title}：网盘里本来就没有，记录改回「未入盘」`);
      else if (g.problem) ctx.log('warn', `${g.title}：${g.problem}`);
      let ok = g.targets.length > 0;
      for (const t of g.targets) {
        const size = sizeOf(t);
        const r = await bd.rm([t.path], ctx.signal);
        if (r) {
          exec('DELETE FROM du_results WHERE path = ? OR path LIKE ?', t.path, t.path + '/%');
          const what = `${t.isdir ? '[目录] ' : ''}${t.name}${size ? '  ' + fmtBytes(size) : ''}`;
          if (r === 'trashed') {
            trashed++; trashedBytes += size;
            ctx.log('warn', `百度要求安全验证、不能直接删除，已移到 ${bd.TRASH_DIR}：${what}`);
          } else {
            bytes += size;
            ctx.log(`已删除 ${what}`);
          }
        } else { ok = false; failed++; ctx.log('warn', `删除失败 ${t.path}`); }
        await ctx.sleep(getSettings().normalize.op_interval_ms);
      }
      // 网盘里本来就找不到的，也把记录恢复为可入盘
      if (ok || g.missing) { resetLinks(src.id, g.post_id, formats); removed++; done.push(g.title); }
    }
    ctx.progress({ phase: 'done', done: games.length, total: games.length, current: null });
    ctx.log(`完成：${removed} 个游戏已移出网盘${bytes ? `，释放约 ${fmtBytes(bytes)}` : ''}${trashed ? `；${trashed} 项${trashedBytes ? `（约 ${fmtBytes(trashedBytes)}）` : ''}在 ${bd.TRASH_DIR}，请在百度网盘 App 里删除这个目录释放空间` : ''}${failed ? `，${failed} 项删除失败` : ''}`);
    return { games: removed, failed, bytes, trashed, trashed_bytes: trashedBytes, titles: done.slice(0, 5) };
  },
  onDone(job, s) {
    if (!s?.games) return;
    const list = `${s.titles.join('、')}${s.games > 5 ? ' 等' : ''}`;
    if (s.trashed) notify('run_done', 'warn', `已移出网盘 ${s.games} 个游戏，需要你手动清空`,
      `百度要求安全验证，接口不能直接删除，${list} 已移到 ${bd.TRASH_DIR}${s.trashed_bytes ? `（约 ${fmtBytes(s.trashed_bytes)}）` : ''}。在百度网盘 App 里删除这个目录才会释放空间。`);
    else notify('run_done', s.failed ? 'warn' : 'success', `已从网盘删除 ${s.games} 个游戏`, `${s.bytes ? `释放约 ${fmtBytes(s.bytes)}：` : ''}${list}`);
  },
  onFail(job, e) { notify('error', 'error', '从网盘删除失败', e.message); },
});
