#!/usr/bin/env node
// ps5watch 命令行。控制台服务在运行时，命令转交给服务执行（保证站点请求始终串行）；否则在本进程内执行。
//
//   node ps5watch.mjs serve                  启动 Web 控制台（默认 http://127.0.0.1:5175）
//   node ps5watch.mjs check                  账号 / 配额 / 统计
//   node ps5watch.mjs run                    一轮流水线：采集 → 转存 → 规整预览（计划任务入口）
//   node ps5watch.mjs crawl [--pages N] [--full] [--no-backlog] [--source ID]
//   node ps5watch.mjs transfer [--source ID]
//   node ps5watch.mjs normalize [--apply]    生成规整预览；--apply 直接执行预览里的全部目标
//   node ps5watch.mjs du [路径] [--force]     网盘用量扫描
//   node ps5watch.mjs prune [--dry] [--source ID]  删除转存目录里命中排除规则的文件（默认 PKG 版本）
//   node ps5watch.mjs dedupe [--apply] [--source ID]  同一游戏转存了多个版本时只留选中的那个（默认只预览）
//   node ps5watch.mjs retry-failed [--source ID]
//   node ps5watch.mjs report                 状态统计
//   node ps5watch.mjs login                  扫码登录百度网盘
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = path.join(ROOT, 'state', 'server.json');
const [cmd = 'help', ...argv] = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const VALUE_OPTS = ['--pages', '--source'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.includes(argv[i - 1]));
const ts = () => new Date().toLocaleString('zh-CN', { hour12: false });
const say = (...a) => console.log(`[${ts()}]`, ...a);

if (cmd === 'serve') {
  await import('./server/index.mjs');
} else if (cmd === 'help' || cmd === '--help') {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
} else {
  const base = await serverBase();
  await (base ? remote(base) : local());
}

async function serverBase() {
  try {
    const s = JSON.parse(fs.readFileSync(SERVER_INFO, 'utf8'));
    const base = `http://127.0.0.1:${s.port}/api`;
    const r = await fetch(base + '/job-types', { signal: AbortSignal.timeout(2000) });
    return r.ok ? base : null;
  } catch { return null; }
}

function jobRequests(sourceId) {
  switch (cmd) {
    case 'run': return [{ pipeline: true }];
    case 'crawl': return [{ type: 'crawl', source_id: sourceId, params: { ...(opt('pages') ? { pages: Number(opt('pages')) } : {}), ...(flag('full') ? { full: true } : {}), ...(flag('no-backlog') ? { backlog: false } : {}) } }];
    case 'transfer': return [{ type: 'transfer', source_id: sourceId }];
    case 'normalize': return [{ type: 'normalize_plan', source_id: sourceId, apply: flag('apply') }];
    case 'prune': return [{ type: 'prune', source_id: sourceId, params: { dry: flag('dry') } }];
    case 'dedupe': return [{ type: 'dedupe', source_id: sourceId, params: { dry: !flag('apply') } }];
    case 'du': return [{ type: 'du', params: { path: positional[0] ? '/' + positional[0].replace(/^\/+/, '') : '/', force: flag('force') } }];
    default: return null;
  }
}

// ---------- 交给运行中的服务 ----------
async function remote(base) {
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-ps5watch-cli': '1' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  };
  say(`控制台服务运行中，命令已转交给服务（${base.replace('/api', '')}）`);
  const sources = await call('GET', '/sources');
  const sourceId = opt('source') || sources.find(s => s.enabled)?.id;

  if (cmd === 'check' || cmd === 'report') return printStatus(await call('GET', '/account'), sources);
  if (cmd === 'retry-failed') return say(JSON.stringify(await call('POST', '/games/actions', { action: 'retry_failed', source_id: sourceId })));
  if (cmd === 'login') { await call('POST', '/account/login'); return say('已生成登录二维码，请在控制台「设置 → 网盘账号」用百度网盘 App 扫码'); }

  const reqs = jobRequests(sourceId);
  if (!reqs) return unknown();
  let jobs = [];
  for (const r of reqs) {
    if (r.pipeline) jobs.push(...(await call('POST', '/pipeline', {})).jobs);
    else jobs.push(await call('POST', '/jobs', r));
  }
  const results = await followRemote(call, jobs.map(j => j.id));
  if (cmd === 'normalize' && flag('apply')) {
    const planId = results[0]?.summary?.plan_id;
    const plan = planId && await call('GET', '/normalize/plans/' + planId);
    const targets = plan?.plan.groups.map(g => g.target) || [];
    if (!targets.length) return say('没有需要规整的目标');
    const j = await call('POST', `/normalize/plans/${planId}/execute`, { targets });
    await followRemote(call, [j.id]);
  }
}

async function followRemote(call, ids) {
  const after = Object.fromEntries(ids.map(id => [id, 0]));
  const finals = {};
  while (Object.keys(finals).length < ids.length) {
    for (const id of ids) {
      if (finals[id]) continue;
      const logs = await call('GET', `/jobs/${id}/logs?after=${after[id]}`);
      for (const l of logs) { console.log(`[${new Date(l.ts).toLocaleString('zh-CN', { hour12: false })}] #${id} ${l.level === 'info' ? '' : l.level.toUpperCase() + ' '}${l.msg}`); after[id] = l.id; }
      const j = await call('GET', '/jobs/' + id);
      if (!['queued', 'running', 'paused'].includes(j.status)) finals[id] = j;
    }
    if (Object.keys(finals).length < ids.length) await new Promise(r => setTimeout(r, 2000));
  }
  return ids.map(id => finals[id]);
}

// ---------- 本进程执行 ----------
async function local() {
  process.env.PS5WATCH_ECHO = '1';
  const { migrateLegacy } = await import('./server/db.mjs');
  migrateLegacy();
  const jobs = await import('./server/jobs.mjs');
  await Promise.all(['crawl', 'transfer', 'normalize', 'du', 'prune', 'dedupe', 'remove'].map(t => import(`./server/tasks/${t}.mjs`)));
  const { listSources } = await import('./server/sources.mjs');
  const { bus } = await import('./server/bus.mjs');
  const sources = listSources();
  const sourceId = opt('source') || sources.find(s => s.enabled)?.id;
  jobs.recoverOnBoot();

  if (cmd === 'check' || cmd === 'report') {
    const { accountStatus } = await import('./server/health.mjs');
    const { all } = await import('./server/db.mjs');
    const withStats = sources.map(s => ({ ...s, stats: { posts: Object.fromEntries(all('SELECT status, COUNT(*) n FROM posts WHERE source_id = ? GROUP BY status', s.id).map(r => [r.status, r.n])), links: Object.fromEntries(all('SELECT status, COUNT(*) n FROM links WHERE source_id = ? GROUP BY status', s.id).map(r => [r.status, r.n])) } }));
    return printStatus(await accountStatus(), withStats, true);
  }
  if (cmd === 'retry-failed') {
    const { exec } = await import('./server/db.mjs');
    const n = exec(`UPDATE links SET status = 'pending' WHERE source_id = ? AND (status LIKE 'err\\_%' ESCAPE '\\' OR status = 'exc')`, sourceId).changes;
    return say(`已重置 ${n} 条失败链接为待转存`);
  }
  if (cmd === 'login') {
    const { startLogin, loginState } = await import('./server/login.mjs');
    let shownQr = '';
    bus.on('login', s => {
      say(s.message);
      if (s.qrcode_url && s.qrcode_url !== shownQr) { shownQr = s.qrcode_url; say('在浏览器打开二维码后用百度网盘 App 扫码：', s.qrcode_url); }
    });
    await startLogin();
    while (['starting', 'waiting', 'scanned'].includes(loginState().status)) await new Promise(r => setTimeout(r, 1000));
    process.exit(loginState().status === 'success' ? 0 : 1);
  }

  const reqs = jobRequests(sourceId);
  if (!reqs) return unknown();
  const ids = [];
  if (reqs[0].pipeline) {
    const { runPipeline } = await import('./server/scheduler.mjs');
    ids.push(...runPipeline({ trigger: 'cli' }).map(j => j.id));
  } else {
    for (const r of reqs) ids.push(jobs.enqueue(r.type, { source_id: r.source_id ?? null, params: r.params || {}, trigger: 'cli' }).id);
  }
  // 自动触发的后续任务（如采集后自动转存）也一起等待
  const watch = new Set(ids);
  bus.on('job', j => { if (j && j.trigger === 'auto') watch.add(j.id); });
  const settled = () => [...watch].every(id => !['queued', 'running', 'paused'].includes(jobs.getJob(id).status));
  while (!settled()) await new Promise(r => setTimeout(r, 1000));

  if (cmd === 'normalize' && flag('apply')) {
    const planId = jobs.getJob(ids[0]).summary?.plan_id;
    const { one } = await import('./server/db.mjs');
    const plan = planId && JSON.parse(one('SELECT plan FROM normalize_plans WHERE id = ?', planId).plan);
    const targets = plan?.groups.map(g => g.target) || [];
    if (targets.length) {
      const j = jobs.enqueue('normalize_exec', { source_id: sourceId, params: { plan_id: planId, targets }, trigger: 'cli', dedupe: false });
      while (['queued', 'running', 'paused'].includes(jobs.getJob(j.id).status)) await new Promise(r => setTimeout(r, 1000));
    } else say('没有需要规整的目标');
  }
  process.exit(0);
}

function printStatus(acc, sources, local = false) {
  const gb = (n) => (n / 1024 ** 3).toFixed(0) + ' GB';
  say('百度网盘登录:', acc.transfer_login.ok ? `有效 ✓（${acc.transfer_login.name}）` : '失效 ✗（运行 node ps5watch.mjs login 扫码）');
  if (acc.quota?.total) say('网盘空间:', `剩余 ${gb(acc.quota.free)} / 共 ${gb(acc.quota.total)}`);
  for (const s of sources) say(`来源 ${s.name}:`, JSON.stringify(s.stats));
  if (local) process.exit(0);
}

function unknown() {
  console.error('未知命令: ' + cmd + '\n运行 node ps5watch.mjs help 查看用法');
  process.exit(2);
}
