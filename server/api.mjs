import { all, one, exec, tx } from './db.mjs';
import { getSettings, updateSettings, DEFAULTS } from './settings.mjs';
import { listSources, getSource, saveSource, deleteSource, ADAPTERS } from './sources.mjs';
import * as jobs from './jobs.mjs';
import { runPipeline, nextRuns } from './scheduler.mjs';
import { accountStatus, invalidateAccount, sitesStatus } from './health.mjs';
import { startLogin, cancelLogin, loginState } from './login.mjs';
import * as bd from './baidu.mjs';
import { toast, webhook } from './notify.mjs';
import { duChildren } from './tasks/du.mjs';
import { resolveRemoval } from './tasks/remove.mjs';
import { bus } from './bus.mjs';

const bad = (code, msg) => Object.assign(new Error(msg), { statusCode: code });

// ---------- 统计 ----------
function sourceStats(sid) {
  const posts = Object.fromEntries(all('SELECT status, COUNT(*) n FROM posts WHERE source_id = ? GROUP BY status', sid).map(r => [r.status, r.n]));
  const links = Object.fromEntries(all('SELECT status, COUNT(*) n FROM links WHERE source_id = ? GROUP BY status', sid).map(r => [r.status, r.n]));
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const linkFailed = Object.entries(links).filter(([k]) => /^(err_|exc)/.test(k)).reduce((a, [, n]) => a + n, 0);
  const gamesIn = (w) => one(`SELECT COUNT(*) n FROM posts p WHERE p.source_id = ? AND ${w}`, sid).n;
  return {
    posts: { total: sum(posts), pending: posts.pending_detail || 0, done: (posts.links_done || 0) + (posts.no_link || 0), no_link: posts.no_link || 0, failed: posts.failed || 0 },
    links: { total: sum(links), pending: links.pending || 0, available: links.available || 0, saved: links.saved || 0, exists: links.exists || 0, invalid: links.invalid || 0, skipped: links.skipped || 0, failed: linkFailed },
    games: { in_pan: gamesIn(VIEWS.transferred), available: gamesIn(VIEWS.available), with_links: posts.links_done || 0 },
  };
}

// ---------- 游戏库视图 ----------
const VIEWS = {
  all: '1 = 1',
  pending_detail: `p.status = 'pending_detail'`,
  detail_failed: `p.status = 'failed'`,
  no_link: `p.status = 'no_link'`,
  pending_transfer: `EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.source_id AND l.post_id = p.post_id AND l.status = 'pending')`,
  transferred: `EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.source_id AND l.post_id = p.post_id AND l.status IN ('saved','exists'))`,
  available: `EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.source_id AND l.post_id = p.post_id AND l.status = 'available')
              AND NOT EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.source_id AND l.post_id = p.post_id AND l.status IN ('saved','exists','pending'))`,
  transfer_failed: `EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.source_id AND l.post_id = p.post_id AND (l.status LIKE 'err\\_%' ESCAPE '\\' OR l.status = 'exc'))`,
  invalid: `EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.source_id AND l.post_id = p.post_id AND l.status = 'invalid')`,
  skipped: `EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.source_id AND l.post_id = p.post_id AND l.status = 'skipped')`,
};

function gamesQuery(q) {
  const where = [VIEWS[q.view] || VIEWS.all], args = [];
  if (q.source_id) { where.push('p.source_id = ?'); args.push(q.source_id); }
  if (q.q) {
    // 空格分隔的多个关键词都要命中（「霍格沃茨 遗」「hogwarts」「PPSA01593」都能找到）
    for (const kw of String(q.q).trim().split(/\s+/).slice(0, 5)) {
      where.push(`(p.title LIKE ? OR p.post_id = ? OR p.serial LIKE ? OR EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.source_id AND l.post_id = p.post_id AND l.surl LIKE ?))`);
      args.push(`%${kw}%`, kw, `%${kw.replace(/[-_\s]/g, '')}%`, `%${kw}%`);
    }
  }
  return { w: where.join(' AND '), args };
}

function listGames(q) {
  const size = Math.min(Number(q.size) || 50, 500);
  const page = Math.max(Number(q.page) || 1, 1);
  const { w, args } = gamesQuery(q);
  const order = { newest: 'CAST(p.post_id AS INTEGER) DESC', updated: 'COALESCE(p.crawled_at, p.discovered_at) DESC', title: 'p.title' }[q.sort] || 'CAST(p.post_id AS INTEGER) DESC';
  const rows = all(`SELECT p.* FROM posts p WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, size, (page - 1) * size);
  const total = one(`SELECT COUNT(*) n FROM posts p WHERE ${w}`, ...args).n;
  const linkStmt = 'SELECT surl, pwd, status, attempts, last_error, dest_dir, transferred_at, remark, format FROM links WHERE source_id = ? AND post_id = ? ORDER BY rowid';
  return { total, page, size, rows: rows.map(r => ({ ...r, links: all(linkStmt, r.source_id, r.post_id) })) };
}

function facets(source_id) {
  const out = {};
  for (const v of Object.keys(VIEWS)) {
    const { w, args } = gamesQuery({ view: v, source_id });
    out[v] = one(`SELECT COUNT(*) n FROM posts p WHERE ${w}`, ...args).n;
  }
  return out;
}

// 按游戏选择时不包含已跳过的链接（多版本里没选中的那些），按链接选择时照单全收
function selectedSurls(body, { withSkipped = false } = {}) {
  if (body.surls?.length) return body.surls;
  if (body.post_ids?.length) {
    const sql = `SELECT surl FROM links WHERE source_id = ? AND post_id = ?${withSkipped ? '' : ` AND status <> 'skipped'`}`;
    return body.post_ids.flatMap(pid => all(sql, body.source_id, String(pid)).map(r => r.surl));
  }
  return [];
}

function gameAction(body) {
  const { action, source_id } = body;
  if (!getSource(source_id)) throw bad(400, '需要指定来源');
  switch (action) {
    case 'recrawl': {
      const ids = (body.post_ids || []).map(String);
      if (!ids.length) throw bad(400, '请选择要重新采集的游戏');
      tx(() => ids.forEach(id => exec(`UPDATE posts SET status = 'pending_detail', fail_count = 0, last_error = NULL WHERE source_id = ? AND post_id = ?`, source_id, id)));
      return { job: jobs.enqueue('crawl', { source_id, params: { post_ids: ids }, dedupe: false }) };
    }
    case 'transfer': {
      const surls = selectedSurls(body);
      if (!surls.length) throw bad(400, '所选游戏没有百度盘链接');
      return { job: jobs.enqueue('transfer', { source_id, params: { surls }, dedupe: false }) };
    }
    // 加入网盘：把所选游戏的「可入盘」链接排进转存队列（已在盘里的不重复转存）
    case 'add': {
      const ids = (body.post_ids || []).map(String);
      if (!ids.length) throw bad(400, '请选择要加入网盘的游戏');
      let n = 0, games = 0;
      tx(() => ids.forEach(id => {
        const c = exec(`UPDATE links SET status = 'pending', last_error = NULL WHERE source_id = ? AND post_id = ? AND status = 'available'`, source_id, id).changes;
        n += c; if (c) games++;
      }));
      if (!n) throw bad(400, '所选游戏没有可加入的链接（可能已在网盘里、还没采集到链接，或链接都被跳过了）');
      return { queued: n, games, job: jobs.enqueue('transfer', { source_id, trigger: 'manual' }) };
    }
    case 'retry_failed': {
      const n = exec(`UPDATE links SET status = 'pending' WHERE source_id = ? AND (status LIKE 'err\\_%' ESCAPE '\\' OR status = 'exc')`, source_id).changes;
      const m = exec(`UPDATE posts SET status = 'pending_detail', fail_count = 0 WHERE source_id = ? AND status = 'failed'`, source_id).changes;
      return { reset_links: n, reset_posts: m, job: n ? jobs.enqueue('transfer', { source_id }) : null };
    }
    case 'skip':
    case 'unskip': {
      const surls = selectedSurls(body, { withSkipped: action === 'unskip' });
      const [from, to] = action === 'skip'
        ? [`status IN ('pending', 'available') OR status LIKE 'err\\_%' ESCAPE '\\' OR status = 'exc'`, 'skipped']
        : [`status = 'skipped'`, getSettings().transfer.auto ? 'pending' : 'available'];
      let n = 0;
      tx(() => surls.forEach(s => { n += exec(`UPDATE links SET status = ?, last_error = NULL WHERE surl = ? AND (${from})`, to, s).changes; }));
      return { changed: n };
    }
    default: throw bad(400, '未知操作');
  }
}

export default async function routes(app) {
  // ---------- 实时推送 ----------
  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const send = (type) => (data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    const types = ['job', 'progress', 'log', 'event', 'site', 'login', 'settings', 'account-changed', 'schedule'];
    const handlers = types.map(t => [t, send(t)]);
    handlers.forEach(([t, h]) => bus.on(t, h));
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.raw.on('close', () => { clearInterval(ping); handlers.forEach(([t, h]) => bus.off(t, h)); });
  });

  // ---------- 总览 ----------
  app.get('/api/overview', async () => {
    const sources = listSources().map(s => ({ ...s, stats: sourceStats(s.id) }));
    const plan = one(`SELECT id, dest_dir, source_id, created_at, plan FROM normalize_plans WHERE status = 'ready' ORDER BY id DESC LIMIT 1`);
    const lastDone = Object.fromEntries(['crawl', 'transfer', 'normalize_plan', 'normalize_exec'].map(t => {
      const r = one(`SELECT id, source_id, finished_at, status, summary FROM jobs WHERE type = ? AND status = 'done' ORDER BY id DESC LIMIT 1`, t);
      return [t, r ? { ...r, summary: r.summary ? JSON.parse(r.summary) : null } : null];
    }));
    const planGroups = plan ? JSON.parse(plan.plan).groups.length : 0;
    return {
      sources,
      active_jobs: jobs.activeJobs(),
      sites: sitesStatus(),
      next_runs: nextRuns(),
      schedule_enabled: getSettings().schedule.enabled,
      unread_events: one('SELECT COUNT(*) n FROM events WHERE read = 0').n,
      recent_events: all('SELECT * FROM events ORDER BY id DESC LIMIT 8'),
      pending_plan: planGroups ? { id: plan.id, dest_dir: plan.dest_dir, created_at: plan.created_at, groups: planGroups } : null,
      last_done: lastDone,
    };
  });

  // ---------- 来源 ----------
  app.get('/api/adapters', async () => Object.entries(ADAPTERS).map(([id, a]) => ({ id, label: a.label })));
  app.get('/api/sources', async () => listSources().map(s => ({ ...s, stats: sourceStats(s.id) })));
  app.post('/api/sources', async (req) => saveSource(req.body, { isNew: true }));
  app.put('/api/sources/:id', async (req) => saveSource({ ...req.body, id: req.params.id }, { isNew: false }));
  app.delete('/api/sources/:id', async (req) => {
    if (one(`SELECT id FROM jobs WHERE source_id = ? AND status IN ('queued','running','paused')`, req.params.id)) throw bad(409, '该来源还有进行中的任务');
    deleteSource(req.params.id);
    return { ok: true };
  });

  // ---------- 游戏库 ----------
  app.get('/api/games', async (req) => listGames(req.query));
  app.get('/api/games/facets', async (req) => facets(req.query.source_id));
  app.post('/api/games/actions', async (req) => gameAction(req.body));
  app.post('/api/games/remove-preview', async (req) => {
    const { source_id, post_ids = [] } = req.body || {};
    if (!getSource(source_id)) throw bad(400, '需要指定来源');
    if (!post_ids.length) throw bad(400, '请选择要删除的游戏');
    if (post_ids.length > 200) throw bad(400, '一次最多删除 200 个游戏');
    return { games: await resolveRemoval(source_id, post_ids) };
  });
  app.post('/api/games/remove', async (req) => {
    const { source_id, post_ids = [] } = req.body || {};
    if (!getSource(source_id)) throw bad(400, '需要指定来源');
    if (!post_ids.length) throw bad(400, '请选择要删除的游戏');
    return { job: jobs.enqueue('remove', { source_id, params: { post_ids: post_ids.map(String) }, dedupe: false }) };
  });

  // ---------- 任务 ----------
  app.get('/api/job-types', async () => jobs.jobTypes());
  app.get('/api/jobs', async (req) => jobs.listJobs({ ...req.query, limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0 }));
  app.get('/api/jobs/:id', async (req) => jobs.getJob(Number(req.params.id)) || Promise.reject(bad(404, '任务不存在')));
  app.get('/api/jobs/:id/logs', async (req) => req.query.tail ? jobs.jobLogsTail(Number(req.params.id), Math.min(Number(req.query.tail), 5000)) : jobs.jobLogs(Number(req.params.id), Number(req.query.after) || 0, Math.min(Number(req.query.limit) || 500, 5000)));
  app.post('/api/jobs', async (req) => {
    const { type, source_id = null, params = {} } = req.body || {};
    if (['crawl', 'transfer', 'normalize_plan', 'probe', 'prune', 'dedupe'].includes(type) && !getSource(source_id)) throw bad(400, '需要指定来源');
    if (type === 'normalize_exec') throw bad(400, '请从规整预览发起执行');
    if (type === 'remove') throw bad(400, '请在游戏库里选择游戏后删除');
    return jobs.enqueue(type, { source_id, params, trigger: req.headers['x-ps5watch-cli'] ? 'cli' : 'manual' });
  });
  app.post('/api/jobs/:id/pause', async (req) => jobs.pauseJob(req.params.id));
  app.post('/api/jobs/:id/resume', async (req) => jobs.resumeJob(req.params.id));
  app.post('/api/jobs/:id/cancel', async (req) => jobs.cancelJob(req.params.id));
  app.post('/api/jobs/:id/rerun', async (req) => jobs.rerunJob(req.params.id));
  app.post('/api/pipeline', async (req) => ({ jobs: runPipeline({ trigger: req.headers['x-ps5watch-cli'] ? 'cli' : 'manual', ...(req.body || {}) }) }));

  // ---------- 设置 ----------
  app.get('/api/settings', async () => ({ settings: getSettings(), defaults: DEFAULTS }));
  app.put('/api/settings', async (req) => ({ settings: updateSettings(req.body || {}) }));

  // ---------- 账号 ----------
  app.get('/api/account', async (req) => ({ ...(await accountStatus({ fresh: req.query.fresh === '1' })), login: loginState() }));
  app.post('/api/account/login', async () => startLogin());
  app.post('/api/account/login/cancel', async () => { cancelLogin(); return loginState(); });
  app.post('/api/account/refresh-token', async () => { await bd.refreshOpenToken(); invalidateAccount(); return bd.openTokenInfo(); });
  bus.on('account-changed', invalidateAccount);

  // ---------- 网盘 ----------
  app.get('/api/storage/du', async (req) => {
    const path = req.query.path || '/';
    const rows = duChildren(path);
    return { path, rows, total: rows.reduce((a, r) => a + r.size, 0), scanned_at: rows.reduce((a, r) => (r.scanned_at > a ? r.scanned_at : a), '') };
  });
  app.get('/api/storage/ls', async (req) => ({ path: req.query.path || '/', rows: (await bd.listDir(req.query.path || '/')) || [] }));

  // ---------- 规整 ----------
  app.get('/api/normalize/plans', async (req) => {
    const rows = all(`SELECT id, source_id, dest_dir, status, created_at, executed_at FROM normalize_plans ${req.query.source_id ? 'WHERE source_id = ?' : ''} ORDER BY id DESC LIMIT 30`,
      ...(req.query.source_id ? [req.query.source_id] : []));
    return rows;
  });
  app.get('/api/normalize/plans/:id', async (req) => {
    const r = one('SELECT * FROM normalize_plans WHERE id = ?', Number(req.params.id));
    if (!r) throw bad(404, '预览不存在');
    return { ...r, plan: JSON.parse(r.plan), result: r.result ? JSON.parse(r.result) : null };
  });
  app.post('/api/normalize/plans/:id/execute', async (req) => {
    const id = Number(req.params.id);
    const r = one('SELECT * FROM normalize_plans WHERE id = ?', id);
    if (!r) throw bad(404, '预览不存在');
    if (r.status !== 'ready') throw bad(409, '该预览已执行或已过期，请重新生成');
    const targets = req.body?.targets;
    if (!Array.isArray(targets) || !targets.length) throw bad(400, '请至少勾选一个目标');
    return jobs.enqueue('normalize_exec', { source_id: r.source_id, params: { plan_id: id, targets }, dedupe: false });
  });
  app.post('/api/normalize/plans/:id/discard', async (req) => {
    exec(`UPDATE normalize_plans SET status = 'discarded' WHERE id = ? AND status = 'ready'`, Number(req.params.id));
    return { ok: true };
  });

  // ---------- 消息 ----------
  app.get('/api/events', async (req) => all('SELECT * FROM events ORDER BY id DESC LIMIT ?', Math.min(Number(req.query.limit) || 100, 500)));
  app.post('/api/events/read-all', async () => { exec('UPDATE events SET read = 1 WHERE read = 0'); bus.emit('event', null); return { ok: true }; });
  app.post('/api/notify/test', async (req) => {
    const n = getSettings().notify;
    const results = {};
    if (req.body?.channel !== 'webhook') results.toast = await toast('盘架 测试通知', '能看到这条说明 Windows 通知已开启').then(() => 'ok', e => e.message);
    if (req.body?.channel !== 'toast' && n.webhook_url) results.webhook = await webhook(n.webhook_url, n.webhook_format, '盘架 测试通知', '能收到这条说明 Webhook 配置正确').then(() => 'ok', e => e.message);
    return results;
  });
}
