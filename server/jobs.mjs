// 任务引擎：
//   - 每种任务属于一条通道（lane）。同一通道串行、不同通道并行：
//       site: 站点请求（采集、探测）—— 永不并发，防止 IP 被封
//       pan : 网盘写操作（转存、规整）—— 串行执行避免目录并发冲突
//       scan: 只读扫描（用量统计）
//   - 任务通过 ctx.checkpoint() 协作式暂停/取消；中断后重新入队即可续跑（进度全部落在数据库里）
import { all, one, exec } from './db.mjs';
import { nowIso, fmtLocal } from './util.mjs';
import { bus } from './bus.mjs';

const TYPES = {}; // type -> { lane, label, run(ctx) }
export function defineJob(type, def) { TYPES[type] = def; }
export const jobTypes = () => Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, { lane: v.lane, label: v.label }]));

const running = new Map(); // jobId -> ctx

export class JobCancelled extends Error { constructor() { super('已取消'); this.name = 'JobCancelled'; } }

const hydrate = (r) => r && {
  ...r,
  params: JSON.parse(r.params || '{}'),
  progress: JSON.parse(r.progress || '{}'),
  summary: r.summary ? JSON.parse(r.summary) : null,
  label: TYPES[r.type]?.label || r.type,
  lane: TYPES[r.type]?.lane,
};

export const getJob = (id) => hydrate(one('SELECT * FROM jobs WHERE id = ?', id));

export function listJobs({ status, type, source_id, limit = 50, offset = 0 } = {}) {
  const where = [], args = [];
  if (status) { const st = String(status).split(','); where.push(`status IN (${st.map(() => '?').join(',')})`); args.push(...st); }
  if (type) { where.push('type = ?'); args.push(type); }
  if (source_id) { where.push('source_id = ?'); args.push(source_id); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = all(`SELECT * FROM jobs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, limit, offset).map(hydrate);
  const total = one(`SELECT COUNT(*) n FROM jobs ${w}`, ...args).n;
  return { rows, total };
}

export const jobLogs = (id, afterId = 0, limit = 500) =>
  all('SELECT id, ts, level, msg FROM job_logs WHERE job_id = ? AND id > ? ORDER BY id LIMIT ?', id, afterId, limit);

export const jobLogsTail = (id, n = 2000) =>
  all('SELECT * FROM (SELECT id, ts, level, msg FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id', id, n);

export const activeJobs = () => all(`SELECT * FROM jobs WHERE status IN ('queued','running','paused') ORDER BY id`).map(hydrate);

// 入队。同类型 + 同来源已有排队/运行中的任务时直接复用，避免重复
export function enqueue(type, { source_id = null, params = {}, trigger = 'manual', dedupe = true } = {}) {
  if (!TYPES[type]) { const e = new Error('未知任务类型 ' + type); e.statusCode = 400; throw e; }
  if (dedupe) {
    const dup = one(`SELECT id FROM jobs WHERE type = ? AND IFNULL(source_id,'') = IFNULL(?, '') AND status IN ('queued','running','paused')`, type, source_id);
    if (dup) return getJob(dup.id);
  }
  const r = exec('INSERT INTO jobs (type, source_id, params, status, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    type, source_id, JSON.stringify(params), 'queued', trigger, nowIso());
  const job = getJob(r.lastInsertRowid);
  bus.emit('job', job);
  setImmediate(pump);
  return job;
}

function laneBusy(lane) {
  for (const ctx of running.values()) if (TYPES[ctx.job.type].lane === lane) return true;
  return false;
}

function depsDone(job) {
  const after = job.params.after || [];
  return after.every(id => {
    const d = one('SELECT status FROM jobs WHERE id = ?', id);
    return !d || !['queued', 'running', 'paused'].includes(d.status);
  });
}

function pump() {
  const queued = all(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY id`).map(hydrate);
  for (const job of queued) {
    const lane = TYPES[job.type]?.lane;
    if (!lane) { finish(job.id, 'failed', null, '未知任务类型'); continue; }
    if (laneBusy(lane) || !depsDone(job)) continue;
    start(job);
  }
}

function setStatus(id, status, extra = {}) {
  const cols = Object.keys(extra);
  exec(`UPDATE jobs SET status = ?${cols.map(c => `, ${c} = ?`).join('')} WHERE id = ?`, status, ...Object.values(extra), id);
  bus.emit('job', getJob(id));
}

function finish(id, status, summary, error) {
  exec('UPDATE jobs SET status = ?, summary = ?, error = ?, finished_at = ? WHERE id = ?',
    status, summary ? JSON.stringify(summary) : null, error || null, nowIso(), id);
  running.delete(id);
  bus.emit('job', getJob(id));
  setImmediate(pump);
}

function makeCtx(job) {
  const ac = new AbortController();
  let pausedWaiter = null;
  let progress = { ...job.progress };
  let lastFlush = 0, flushTimer = null, lastEmit = 0, emitTimer = null;
  const startedAt = Date.now();

  const flush = () => { flushTimer = null; lastFlush = Date.now(); exec('UPDATE jobs SET progress = ? WHERE id = ?', JSON.stringify(progress), job.id); };
  const emitProgress = () => { emitTimer = null; lastEmit = Date.now(); bus.emit('progress', { id: job.id, progress }); };

  const ctx = {
    job,
    signal: ac.signal,
    paused: false,
    pauseReason: null,
    log(level, msg) {
      if (msg === undefined) { msg = level; level = 'info'; }
      const r = exec('INSERT INTO job_logs (job_id, ts, level, msg) VALUES (?, ?, ?, ?)', job.id, nowIso(), level, String(msg));
      bus.emit('log', { job_id: job.id, id: Number(r.lastInsertRowid), ts: nowIso(), level, msg: String(msg) });
      if (process.env.PS5WATCH_ECHO) console.log(`[${fmtLocal()}] #${job.id} ${level === 'info' ? '' : level.toUpperCase() + ' '}${msg}`);
    },
    progress(patch) {
      progress = { ...progress, ...patch };
      if (progress.total > 0 && progress.done > 0) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const doneThisRun = progress.done - (progress._done0 ?? 0);
        progress.rate = doneThisRun > 0 ? doneThisRun / elapsed : null;
        progress.eta_sec = progress.rate ? Math.max(0, Math.round((progress.total - progress.done) / progress.rate)) : null;
      }
      if (Date.now() - lastEmit > 300) emitProgress(); else if (!emitTimer) emitTimer = setTimeout(emitProgress, 300);
      if (Date.now() - lastFlush > 2000) flush(); else if (!flushTimer) flushTimer = setTimeout(flush, 2000);
    },
    getProgress: () => progress,
    async checkpoint() {
      if (ac.signal.aborted) throw new JobCancelled();
      if (pausedWaiter) await pausedWaiter.promise;
      if (ac.signal.aborted) throw new JobCancelled();
    },
    // 可被暂停/取消打断的等待
    async sleep(ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await ctx.checkpoint();
        await new Promise(r => setTimeout(r, Math.min(500, end - Date.now())));
      }
      await ctx.checkpoint();
    },
    // 任务主动进入暂停（如网盘空间不足），等待用户点「继续」
    async pauseSelf(reason) {
      ctx._pause(reason);
      await ctx.checkpoint();
    },
    _pause(reason) {
      if (pausedWaiter) return;
      let resolve; const promise = new Promise(r => (resolve = r));
      pausedWaiter = { promise, resolve };
      ctx.paused = true; ctx.pauseReason = reason || null;
      ctx.progress({ pause_reason: reason || null });
      setStatus(job.id, 'paused');
      ctx.log(reason ? 'warn' : 'info', reason ? `已暂停：${reason}` : '已暂停');
    },
    _resume() {
      if (!pausedWaiter) return;
      const w = pausedWaiter; pausedWaiter = null;
      ctx.paused = false; ctx.pauseReason = null;
      ctx.progress({ pause_reason: null });
      setStatus(job.id, 'running');
      ctx.log('已继续');
      w.resolve();
    },
    _cancel() {
      ac.abort(new JobCancelled());
      if (pausedWaiter) { const w = pausedWaiter; pausedWaiter = null; w.resolve(); }
    },
    _flush() { if (flushTimer) clearTimeout(flushTimer); if (emitTimer) clearTimeout(emitTimer); flush(); emitProgress(); },
  };
  return ctx;
}

async function start(job) {
  const ctx = makeCtx(job);
  running.set(job.id, ctx);
  setStatus(job.id, 'running', { started_at: nowIso() });
  ctx.progress({ _done0: job.progress.done ?? 0 });
  ctx.log(`开始：${TYPES[job.type].label}${job.trigger !== 'manual' ? `（${{ schedule: '定时', auto: '自动触发', cli: '命令行', probe: '解封探测' }[job.trigger] || job.trigger}）` : ''}`);
  try {
    const summary = await TYPES[job.type].run(ctx);
    ctx._flush();
    ctx.log('完成');
    finish(job.id, 'done', summary || null, null);
    TYPES[job.type].onDone?.(getJob(job.id), summary);
  } catch (e) {
    ctx._flush();
    if (e instanceof JobCancelled || ctx.signal.aborted) {
      ctx.log('warn', '已取消');
      finish(job.id, 'cancelled', e.summary || null, null);
    } else {
      ctx.log('error', String(e.message || e));
      finish(job.id, 'failed', e.summary || null, String(e.message || e));
      TYPES[job.type].onFail?.(getJob(job.id), e);
    }
  }
}

export function pauseJob(id) {
  const ctx = running.get(Number(id));
  if (!ctx) throw httpErr(409, '任务未在运行');
  ctx._pause();
  return getJob(id);
}

export function resumeJob(id) {
  const ctx = running.get(Number(id));
  if (!ctx) throw httpErr(409, '任务未在运行');
  ctx._resume();
  return getJob(id);
}

export function cancelJob(id) {
  id = Number(id);
  const ctx = running.get(id);
  if (ctx) { ctx._cancel(); return getJob(id); }
  const j = getJob(id);
  if (j?.status === 'queued') { finish(id, 'cancelled', null, null); return getJob(id); }
  throw httpErr(409, '任务已结束');
}

// 重新运行一个已结束的任务（同参数）
export function rerunJob(id) {
  const j = getJob(id);
  if (!j) throw httpErr(404, '任务不存在');
  return enqueue(j.type, { source_id: j.source_id, params: j.params, trigger: 'manual' });
}

const httpErr = (code, msg) => Object.assign(new Error(msg), { statusCode: code });

// 进程重启：上次没跑完的任务标记为「已中断」，排队中的保留
export function recoverOnBoot() {
  const n = exec(`UPDATE jobs SET status = 'interrupted', finished_at = ? WHERE status IN ('running','paused')`, nowIso()).changes;
  setImmediate(pump);
  return n;
}

export function isActive(type, source_id) {
  return !!one(`SELECT id FROM jobs WHERE type = ? AND IFNULL(source_id,'') = IFNULL(?, '') AND status IN ('queued','running','paused')`, type, source_id ?? null);
}

export const kick = () => setImmediate(pump);
