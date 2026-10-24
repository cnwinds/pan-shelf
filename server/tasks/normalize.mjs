// 目录规整：把目标目录整理成 ^[A-Z]{4}\d{4,6}$ 的标准 serial 目录。
//   预览（normalize_plan）：只读，推导每个非标准条目的目标 serial，列出改名 / 合并 / 判重删除计划
//   执行（normalize_exec）：仅执行用户勾选的目标；执行时重新读取实时目录，删源目录前必须验证已空
import { one, all, exec } from '../db.mjs';
import { FORMAT_DIR, FORMAT_LABEL, isFormatDir } from '../linkpick.mjs';
import { linkFormat } from '../layout.mjs';
import { defineJob } from '../jobs.mjs';
import { getSource } from '../sources.mjs';
import * as bd from '../baidu.mjs';
import { getSettings } from '../settings.mjs';
import { notify } from '../notify.mjs';
import { nowIso } from '../util.mjs';
import { requireLogin } from './transfer.mjs';

const STD_RE = /^[A-Z]{4}\d{4,6}$/;
const serialRe = () => new RegExp('\\b((' + getSettings().normalize.serial_prefixes + ')[-_ ]?\\d{4,6})\\b', 'gi');
const normSerial = (s) => s.replace(/[-_\s]/g, '').toUpperCase();

export function serialsFromName(name) {
  const out = new Set();
  const re = serialRe();
  let m;
  while ((m = re.exec(name))) out.add(normSerial(m[1]));
  return out;
}

// 推导目标 serial：目录名 → 内部 rar → 内部全部文件 → 子目录名
async function derive(entry, root) {
  const fromName = serialsFromName(entry.name);
  if (fromName.size === 1) return { target: [...fromName][0], by: '名称' };
  if (fromName.size > 1) return { reason: `名称含多个 serial：${[...fromName].join(', ')}` };
  if (!entry.isdir) return { reason: '文件名里没有 serial' };
  const kids = await bd.listDir(root + '/' + entry.name);
  if (!kids) return { reason: '目录读取失败' };
  const files = kids.filter(k => !k.isdir), dirs = kids.filter(k => k.isdir);
  for (const [label, src] of [['rar 文件名', files.filter(f => /\.rar$/i.test(f.name))], ['文件名', files], ['子目录名', dirs]]) {
    const pool = new Set();
    src.forEach(f => serialsFromName(f.name).forEach(s => pool.add(s)));
    if (pool.size === 1) return { target: [...pool][0], by: label, kids };
    if (pool.size > 1) return { reason: `内部${label}含多个 serial：${[...pool].join(', ')}` };
  }
  return { reason: '目录名和内部文件都推导不出 serial', kids };
}

// 转存目录第一层的名字 → 转存它的链接的格式（转存时记下了分享里的顶层名字）
function savedFormats(sourceId) {
  const out = new Map();
  for (const l of all(`SELECT surl, format, remark, saved_names FROM links WHERE source_id = ? AND status IN ('saved', 'exists') AND saved_names IS NOT NULL`, sourceId)) {
    const f = linkFormat(l);
    if (!FORMAT_DIR[f]) continue;
    try { for (const n of JSON.parse(l.saved_names)) out.set(n, f); } catch {}
  }
  return out;
}

// 这个编号的游戏转存过哪些格式
function formatsOfSerial(sourceId, serial) {
  const rows = all(`SELECT l.format, l.remark FROM links l JOIN posts p ON p.source_id = l.source_id AND p.post_id = l.post_id
                    WHERE l.source_id = ? AND l.status IN ('saved', 'exists')
                      AND (UPPER(p.serial) = ? OR ',' || UPPER(COALESCE(p.share_serials, '')) || ',' LIKE ?)`, sourceId, serial, `%,${serial},%`);
  return new Set(rows.map(linkFormat).filter(f => FORMAT_DIR[f]));
}

const destOf = (ctx) => {
  if (ctx.job.params.dest_dir) return ctx.job.params.dest_dir;
  const src = getSource(ctx.job.source_id);
  if (!src) throw new Error('来源不存在');
  return src.dest_dir;
};

defineJob('normalize_plan', {
  lane: 'pan',
  label: '规整预览',
  async run(ctx) {
    const root = destOf(ctx);
    const list = await bd.listDir(root);
    if (!list) throw new Error('目标目录不存在：' + root);
    const pending = list.filter(e => !STD_RE.test(e.name));
    const standard = list.length - pending.length;
    ctx.log(`${root}：共 ${list.length} 项，标准 ${standard}，待分析 ${pending.length}`);

    const derived = [], anomalies = [];
    const formatOf = savedFormats(ctx.job.source_id);
    for (let i = 0; i < pending.length; i++) {
      await ctx.checkpoint();
      const e = pending[i];
      ctx.progress({ phase: 'analyze', done: i, total: pending.length, current: e.name });
      const d = await derive(e, root);
      // 知道是哪条链接转存来的，就并进游戏目录下的格式子目录
      const fmt = formatOf.get(e.name);
      if (d.target) derived.push({ ...e, ...d, target: fmt ? `${d.target}/${FORMAT_DIR[fmt]}` : d.target });
      else anomalies.push({ name: e.name, isdir: e.isdir, reason: d.reason });
      await ctx.sleep(250);
    }

    // 按目标 serial 分组，计算每组要做什么
    const byTarget = new Map();
    derived.forEach(d => { if (!byTarget.has(d.target)) byTarget.set(d.target, []); byTarget.get(d.target).push(d); });
    const existing = new Map(list.filter(e => STD_RE.test(e.name)).map(e => [e.name, e]));
    const groups = [];
    let gi = 0;
    for (const [target, sources] of byTarget) {
      await ctx.checkpoint();
      ctx.progress({ phase: 'plan', done: gi++, total: byTarget.size, current: target });
      const nested = target.includes('/');
      const targetList = nested ? await bd.listDir(root + '/' + target) : null;
      const targetExists = nested ? targetList !== null : existing.has(target);
      let targetNames = new Set();
      if (targetExists) targetNames = new Set((targetList || (await bd.listDir(root + '/' + target)) || []).map(k => k.name.toLowerCase()));
      const steps = [];
      sources.forEach((s, idx) => {
        if (!targetExists && idx === 0 && s.isdir) {
          steps.push({ op: 'rename', from: s.name, by: s.by });
          (s.kids || []).forEach(k => targetNames.add(k.name.toLowerCase()));
          return;
        }
        if (!s.isdir) {
          const dup = targetNames.has(s.name.toLowerCase());
          steps.push({ op: dup ? 'delete_dup' : 'move_file', from: s.name, by: s.by });
          targetNames.add(s.name.toLowerCase());
          return;
        }
        const kids = s.kids || [];
        const move = kids.filter(k => k.isdir || !targetNames.has(k.name.toLowerCase())).map(k => k.name);
        const dup = kids.filter(k => !k.isdir && targetNames.has(k.name.toLowerCase())).map(k => k.name);
        move.forEach(n => targetNames.add(n.toLowerCase()));
        steps.push({ op: 'merge', from: s.name, by: s.by, move, dup, unknown_kids: !s.kids });
      });
      groups.push({ target, target_exists: targetExists, steps });
    }

    // 已是标准编号、但还没按格式分子目录的游戏：转存记录能确定只有一种格式的，整个挪进那个格式子目录
    const standardDirs = list.filter(e => e.isdir && STD_RE.test(e.name));
    for (let i = 0; i < standardDirs.length; i++) {
      await ctx.checkpoint();
      const e = standardDirs[i];
      ctx.progress({ phase: 'formats', done: i, total: standardDirs.length, current: e.name });
      const kids = await bd.listDir(root + '/' + e.name);
      await ctx.sleep(250);
      const loose = (kids || []).filter(k => !(k.isdir && isFormatDir(k.name)));
      if (!kids || !loose.length) continue;
      // 没有转存记录的（网盘里原有的）不动，盘游当作一种未标注格式
      const fmts = formatsOfSerial(ctx.job.source_id, e.name);
      if (!fmts.size) continue;
      if (fmts.size > 1) {
        anomalies.push({ name: e.name, isdir: true, reason: `转存过 ${[...fmts].map(f => FORMAT_LABEL[f]).join('、')} 多种格式混在一起，分不出哪些文件是哪种，请手动放进 @exfat / @folder / @other` });
        continue;
      }
      const fmt = [...fmts][0];
      const fmtDir = kids.find(k => k.isdir && k.name.toLowerCase() === FORMAT_DIR[fmt]);
      if (fmtDir) {
        anomalies.push({ name: e.name, isdir: true, reason: `已有 ${FORMAT_DIR[fmt]}，外面还有 ${loose.length} 项，请手动确认` });
        continue;
      }
      groups.push({ target: `${e.name}/${FORMAT_DIR[fmt]}`, target_exists: false, steps: [{ op: 'into_format', from: e.name, format: fmt, move: loose.map(k => k.name) }] });
    }

    exec(`UPDATE normalize_plans SET status = 'superseded' WHERE dest_dir = ? AND status = 'ready'`, root);
    const plan = { dest_dir: root, total: list.length, standard, groups, anomalies };
    const r = exec(`INSERT INTO normalize_plans (source_id, dest_dir, status, plan, created_at) VALUES (?, ?, 'ready', ?, ?)`,
      ctx.job.source_id, root, JSON.stringify(plan), nowIso());
    ctx.progress({ phase: 'done', done: byTarget.size, total: byTarget.size, current: null });
    ctx.log(`预览已生成：${groups.length} 个目标待规整，${anomalies.length} 项无法推导`);
    return { plan_id: Number(r.lastInsertRowid), groups: groups.length, anomalies: anomalies.length, standard };
  },
  onDone(job, s) {
    if (s?.groups > 0) notify('plan_ready', 'info', `规整预览已生成：${s.groups} 个目标待确认`, '到「网盘 → 目录规整」查看并确认执行');
  },
  onFail(job, e) { notify('error', 'error', '规整预览失败', e.message); },
});

// 把游戏编号目录里散放的东西（不含已有的格式子目录）挪进格式子目录；执行时重新列目录，只挪还在的
async function intoFormat(ctx, root, step, tDir, opDelay) {
  const gameDir = root + '/' + step.from;
  const kids = await bd.listDir(gameDir);
  if (!kids) return { op: 'into_format', from: step.from, ok: false, error: '读取失败' };
  if (!(await bd.mkdir(tDir, ctx.signal))) return { op: 'into_format', from: step.from, ok: false, error: '建目录失败' };
  let moved = 0, fails = 0;
  for (const k of kids) {
    await ctx.checkpoint();
    if (k.isdir && isFormatDir(k.name)) continue;
    if (await bd.mv(`${gameDir}/${k.name}`, `${tDir}/${k.name}`, ctx.signal)) moved++; else fails++;
    await opDelay();
  }
  ctx.log(fails ? 'warn' : 'info', `${step.from}：${moved} 项移入 ${tDir.slice(root.length + 1)}${fails ? `，${fails} 项失败` : ''}`);
  return { op: 'into_format', from: step.from, moved, fails, ok: !fails };
}

defineJob('normalize_exec', {
  lane: 'pan',
  label: '规整执行',
  // params: { plan_id, targets: string[] }
  async run(ctx) {
    const { plan_id, targets } = ctx.job.params;
    const row = one('SELECT * FROM normalize_plans WHERE id = ?', plan_id);
    if (!row) throw new Error('规整预览不存在');
    if (row.status !== 'ready') throw new Error('该预览已执行或已过期，请重新生成');
    const plan = JSON.parse(row.plan);
    const root = plan.dest_dir;
    const chosen = plan.groups.filter(g => !targets || targets.includes(g.target));
    await requireLogin(ctx);
    exec(`UPDATE normalize_plans SET status = 'executing' WHERE id = ?`, plan_id);

    const opDelay = () => ctx.sleep(getSettings().normalize.op_interval_ms);
    const results = [];
    const counts = { ok: 0, partial: 0, failed: 0 };
    try {
      for (let gi = 0; gi < chosen.length; gi++) {
        await ctx.checkpoint();
        const g = chosen[gi];
        ctx.progress({ phase: 'exec', done: gi, total: chosen.length, current: g.target, counts });
        const tDir = root + '/' + g.target;
        const ops = [];
        const into = g.steps.find(s => s.op === 'into_format');
        if (into) {
          const r = await intoFormat(ctx, root, into, tDir, opDelay);
          results.push({ target: g.target, ops: [r], ok: r.ok });
          r.ok ? counts.ok++ : counts.partial++;
          continue;
        }
        let live = await bd.listDir(tDir);
        let sources = g.steps.map(s => s.from);
        // 格式子目录要先有游戏编号目录
        if (!live && g.target.includes('/')) await bd.mkdir(tDir.slice(0, tDir.lastIndexOf('/')), ctx.signal);
        // 目标不存在：第一个源目录直接改名
        if (!live) {
          const first = g.steps.find(s => s.op === 'rename');
          if (first) {
            const ok = await bd.mv(root + '/' + first.from, tDir, ctx.signal);
            ops.push({ op: 'rename', from: first.from, ok });
            ctx.log(ok ? 'info' : 'warn', `改名 ${first.from} → ${g.target}${ok ? '' : ' 失败'}`);
            sources = sources.filter(n => n !== first.from);
            await opDelay();
          } else {
            await bd.mkdir(tDir, ctx.signal);
          }
          live = await bd.listDir(tDir);
        }
        if (!live) { ops.push({ op: 'no_target', ok: false }); results.push({ target: g.target, ops, ok: false }); counts.failed++; continue; }
        const tnames = new Set(live.map(x => x.name.toLowerCase()));

        for (const name of sources) {
          await ctx.checkpoint();
          const srcPath = root + '/' + name;
          const step = g.steps.find(s => s.from === name);
          if (step && (step.op === 'move_file' || step.op === 'delete_dup')) {
            if (tnames.has(name.toLowerCase())) {
              const ok = !!(await bd.rm([srcPath], ctx.signal));
              ops.push({ op: 'delete_dup', from: name, ok });
              ctx.log(`判重删除 ${name}`);
            } else {
              const ok = await bd.mv(srcPath, tDir + '/' + name, ctx.signal);
              ops.push({ op: 'move_file', from: name, ok });
              tnames.add(name.toLowerCase());
              ctx.log(`移入 ${name} → ${g.target}/`);
            }
            await opDelay();
            continue;
          }
          const kids = await bd.listDir(srcPath);
          if (!kids) { ops.push({ op: 'ls_fail', from: name, ok: false }); ctx.log('warn', `读取失败，跳过 ${name}`); continue; }
          let moved = 0, dedup = 0, fails = 0;
          for (const k of kids) {
            await ctx.checkpoint();
            const p = srcPath + '/' + k.name;
            if (!k.isdir && tnames.has(k.name.toLowerCase())) {
              if (await bd.rm([p], ctx.signal)) dedup++; else fails++;
            } else {
              if (await bd.mv(p, tDir + '/' + k.name, ctx.signal)) { moved++; tnames.add(k.name.toLowerCase()); } else fails++;
            }
            await opDelay();
          }
          await ctx.sleep(800);
          const after = await bd.listDir(srcPath);
          let removed = false;
          if (after && after.length === 0) removed = !!(await bd.rm([srcPath], ctx.signal));
          ops.push({ op: 'merge', from: name, moved, dedup, fails, removed, left: after ? after.length : null, ok: removed && !fails });
          ctx.log(removed && !fails ? 'info' : 'warn',
            `合并 ${name} → ${g.target}：移入 ${moved}，判重删除 ${dedup}${fails ? `，失败 ${fails}` : ''}${removed ? '，源目录已删除' : `，源目录未删除（剩余 ${after ? after.length : '?'} 项）`}`);
          await opDelay();
        }
        const ok = ops.every(o => o.ok);
        results.push({ target: g.target, ops, ok });
        ok ? counts.ok++ : counts.partial++;
      }
    } finally {
      exec(`UPDATE normalize_plans SET status = ?, executed_at = ?, result = ? WHERE id = ?`,
        'executed', nowIso(), JSON.stringify({ targets: chosen.map(g => g.target), results, counts }), plan_id);
    }
    ctx.progress({ phase: 'done', done: chosen.length, total: chosen.length, current: null, counts });
    return { plan_id, ...counts, total: chosen.length };
  },
  onDone(job, s) {
    notify('run_done', s.partial || s.failed ? 'warn' : 'success', `目录规整完成：${s.ok}/${s.total}`, s.partial ? `${s.partial} 个目标部分失败，详见任务日志` : '');
  },
  onFail(job, e) { notify('error', 'error', '规整执行失败', e.message); },
});
