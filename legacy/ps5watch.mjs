#!/usr/bin/env node
// ps5watch.mjs — 2468c.com PS5 游戏增量监控 + 百度盘自动转存
// 用法:
//   node ps5watch.mjs check                 检查站点可达性/登录态/统计
//   node ps5watch.mjs crawl [--pages N]     增量抓新游戏（默认查 3 页列表，无新帖提前停）
//   node ps5watch.mjs transfer              转存所有 pending 链接（需先 node login.mjs 扫码）
//   node ps5watch.mjs normalize             规整目标目录为标准 serial 目录
//   node ps5watch.mjs run                   一键：crawl -> transfer -> normalize（计划任务入口）
//   node ps5watch.mjs report                状态统计
//   node ps5watch.mjs seed --from DIR       从本次会话数据导入初始状态（一次性）
//   node ps5watch.mjs retry-failed          把失败链接重置为 pending
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSite, extractPostUrls, extractLinks } from './lib_site.mjs';
import * as bd from './lib_baidu.mjs';
import { normalize } from './lib_norm.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_FILE = path.join(ROOT, 'state', 'state.json');
const LOG_DIR = path.join(ROOT, 'state', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const loadState = () => fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { posts: {}, links: {} };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[' + now() + ']', ...a);

// ---------- crawl ----------
async function cmdCrawl(argv) {
  const maxPages = parseInt(argv.find((_, i) => argv[i] === '--pages' && argv[i + 1])?.[1] || CFG.list_pages_default, 10);
  const st = loadState();
  let newPosts = 0, newLinks = 0;
  const origin = CFG.site;

  async function fetchDetail(id, purl) {
    const detail = await fetchSite(purl);
    if (!detail) { log(`  帖 ${id} 抓取失败（站点限流?），保持 pending_detail`); return false; }
    const { title, links } = extractLinks(detail);
    st.posts[id] = { url: purl, title, status: links.length ? 'links_done' : 'no_link', at: now() };
    for (const l of links) {
      if (!st.links[l.surl]) { st.links[l.surl] = { pwd: l.pwd, post: id, title, status: 'pending', at: now() }; newLinks++; }
    }
    saveState(st);
    log(`  [${id}] ${title} -> ${links.length} 条百度盘链接`);
    return true;
  }

  for (let p = 1; p <= Math.min(maxPages, CFG.list_pages_max); p++) {
    const url = p === 1 ? origin + CFG.category_path : `${origin}${CFG.category_path}/page/${p}`;
    const html = await fetchSite(url);
    if (!html) { log(`站点不可达（第${p}页），跳过列表扫描`); break; }
    const posts = extractPostUrls(html, origin);
    const fresh = [...posts.entries()].filter(([id]) => !st.posts[id]);
    log(`列表第${p}页：${posts.size} 帖，其中新帖 ${fresh.length}`);
    if (fresh.length === 0 && p >= 2) break; // 连续无新帖则不再翻页
    for (const [id, purl] of fresh) {
      if (await fetchDetail(id, purl)) newPosts++;
    }
  }
  // 自愈：补抓历史 pending_detail（旧列表页深处的游戏）
  const backlog = Object.entries(st.posts).filter(([, v]) => v.status === 'pending_detail');
  if (backlog.length) {
    log(`补抓历史缺口：${backlog.length} 帖 pending_detail`);
    for (const [id, p] of backlog) {
      await fetchDetail(id, p.url);
    }
  }
  log(`crawl 完成：新游戏 ${newPosts}，新链接 ${newLinks}，待转存 ${Object.values(st.links).filter(l => l.status === 'pending').length}`);
}

// ---------- transfer ----------
async function cmdTransfer() {
  if (!(await bd.isLoggedIn())) { log('百度盘登录态失效，请运行 node login.mjs 扫码后重试。'); await bd.closeBrowser(); process.exit(2); }
  const st = loadState();
  const bt = await bd.getBdstoken();
  const pending = Object.entries(st.links).filter(([, v]) => v.status === 'pending');
  log(`待转存 ${pending.length} 条，目标 ${CFG.dest_dir}`);
  let i = 0;
  for (const [surl, info] of pending) {
    i++;
    const r = await bd.transferOne(surl, info.pwd, CFG.dest_dir, bt);
    st.links[surl].status = r.st;
    st.links[surl].at = now();
    saveState(st);
    log(`[${i}/${pending.length}] ${r.st}  ${info.title || ''} (${surl})${r.raw && r.st.startsWith('err_') ? ' ' + r.raw : ''}`);
    await sleep(CFG.transfer_delay_ms);
  }
  const c = countBy(st);
  log(`transfer 完成：${JSON.stringify(c)}`);
  await bd.closeBrowser();
}

function countBy(st) {
  const c = {};
  Object.values(st.links).forEach(l => c[l.status] = (c[l.status] || 0) + 1);
  return c;
}

// ---------- seed ----------
async function cmdSeed(argv) {
  const dir = argv[argv.indexOf('--from') + 1];
  if (!dir || !fs.existsSync(dir)) { console.error('用法: seed --from <目录>（含 post_urls.txt / games_all.jsonl / results_batch1.json）'); process.exit(2); }
  const st = loadState();
  // 全部帖子 URL（含标题未知）
  const urls = fs.readFileSync(path.join(dir, 'post_urls.txt'), 'utf8').trim().split('\n');
  for (const u of urls) {
    const id = path.basename(u, '.html');
    if (!st.posts[id]) st.posts[id] = { url: u, status: 'links_done', at: now() };
  }
  // 链接 + 提取码
  for (const line of fs.readFileSync(path.join(dir, 'games_all.jsonl'), 'utf8').trim().split('\n').filter(Boolean)) {
    const g = JSON.parse(line);
    if (!st.links[g.s]) st.links[g.s] = { pwd: g.p, post: g.i, title: g.t, status: 'pending', at: now() };
  }
  // 已完成的转存结果
  const rf = path.join(dir, 'results_batch1.json');
  if (fs.existsSync(rf)) {
    const rs = JSON.parse(fs.readFileSync(rf, 'utf8'));
    for (const [surl, r] of Object.entries(rs)) {
      if (st.links[surl]) { st.links[surl].status = r.st; st.links[surl].at = now(); }
    }
  }
  // 有链接的帖子 = links_done；没提取到链接的帖子标记 pending_detail（crawl 会补抓详情）
  const withLinks = new Set(Object.values(st.links).map(l => l.post));
  for (const [id, p] of Object.entries(st.posts)) {
    if (withLinks.has(id)) p.status = p.status === 'pending_detail' ? 'links_done' : p.status;
    else if (p.status === 'links_done') p.status = 'pending_detail';
  }
  saveState(st);
  log(`seed 完成：posts=${Object.keys(st.posts).length} links=${Object.keys(st.links).length} ${JSON.stringify(countBy(st))}`);
}

// ---------- 其他 ----------
async function cmdCheck() {
  const st = loadState();
  const html = await fetchSite(CFG.site + CFG.category_path, { retries: 1 });
  log('站点:', html ? '可达 ✓' : '不可达（封禁/离线）✗');
  if (await bd.isLoggedIn()) {
    log('百度盘登录: 有效 ✓');
  } else log('百度盘登录: 失效 ✗（运行 node login.mjs 重新扫码）');
  await bd.closeBrowser();
  log('状态:', JSON.stringify({ posts: Object.keys(st.posts).length, links: Object.keys(st.links).length, ...countBy(st) }));
}

async function cmdNormalize() {
  if (!(await bd.isLoggedIn())) { log('百度盘登录态失效，请运行 node login.mjs 扫码后重试。'); await bd.closeBrowser(); process.exit(2); }
  const bt = await bd.getBdstoken();
  const report = await normalize(CFG.dest_dir, bt);
  const lf = path.join(LOG_DIR, 'normalize-' + Date.now() + '.json');
  fs.writeFileSync(lf, JSON.stringify(report, null, 1));
  log(`规整完成：处理 ${report.normalized || 0} 项；无法推导 serial（保持原名）: ${(report.anomalies || []).join('、') || '无'}；明细 ${lf}`);
  await bd.closeBrowser();
}

async function cmdReport() {
  const st = loadState();
  const c = countBy(st);
  console.log(JSON.stringify({ posts: Object.keys(st.posts).length, links: Object.keys(st.links).length, ...c }, null, 1));
}

async function cmdRetryFailed() {
  const st = loadState();
  let n = 0;
  for (const l of Object.values(st.links)) {
    if (/^(verify_|err_|exc_)/.test(l.status)) { l.status = 'pending'; n++; }
  }
  saveState(st);
  log(`已重置 ${n} 条失败链接为 pending`);
}

async function cmdRun() {
  const lf = path.join(LOG_DIR, 'run-' + Date.now() + '.log');
  const orig = console.log;
  const lines = [];
  console.log = (...a) => { const s = a.join(' '); lines.push('[' + now() + '] ' + s); orig(...a); };
  try {
    await cmdCrawl([]);
    await cmdTransfer();
    await cmdNormalize();
    console.log('run 完成');
  } catch (e) {
    console.log('run 异常:', String(e));
  }
  console.log = orig;
  fs.writeFileSync(lf, lines.join('\n') + '\n');
}

const [cmd, ...argv] = process.argv.slice(2);
const cmds = { crawl: cmdCrawl, transfer: cmdTransfer, normalize: cmdNormalize, check: cmdCheck, report: cmdReport, seed: cmdSeed, run: cmdRun, 'retry-failed': cmdRetryFailed };
if (!cmds[cmd]) { console.error('未知命令: ' + cmd + '\n可用: ' + Object.keys(cmds).join(' / ')); process.exit(2); }
await cmds[cmd](argv);
