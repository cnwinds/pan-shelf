// 目录规整：把目标目录整理成 ^[A-Z]{4}\d{4,6}$ 的标准 serial 目录。
//   预览（normalize_plan）：只读，推导每个非标准条目的目标 serial，列出改名 / 合并 / 判重删除计划
//   执行（normalize_exec）：仅执行用户勾选的目标；执行时重新读取实时目录，删源目录前必须验证已空
import { one, exec } from '../db.mjs';
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
    for (let i = 0; i < pending.length; i++) {
      await ctx.checkpoint();
      const e = pending[i];
      ctx.progress({ phase: 'analyze', done: i, total: pending.length, current: e.name });
      const d = await derive(e, root);
      if (d.target) derived.push({ ...e, ...d });
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
      const targetExists = existing.has(target);
      let targetNames = new Set();
      if (targetExists) targetNames = new Set(((await bd.listDir(root + '/' + target)) || []).map(k => k.name.toLowerCase()));
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
        let live = await bd.listDir(tDir);
        let sources = g.steps.map(s => s.from);
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
