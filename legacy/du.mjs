// du.mjs — 百度盘用量分布（渐进式）：
//  - 逐个顶层目录统计，扫完一个立即输出并保存（断点续扫，重跑跳过已完成的）
//  - API 返回空/坏 JSON 自动退避重试（限流）
// 用法: node du.mjs [顶层目录名...]   不带参数=扫全部
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'bd_open.json'), 'utf8'));
const AT = j.access_token;
const REPORT = path.join(ROOT, 'state', 'du-report.json');
const only = process.argv.slice(2);

async function listPage(dir, start) {
  const url = 'https://pan.baidu.com/rest/2.0/xpan/file?method=list&access_token=' + AT +
    '&dir=' + encodeURIComponent(dir) + '&order=name&desc=0&start=' + start + '&limit=1000&web=1';
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch(url);
      if (r.status !== 200) throw new Error('http ' + r.status);
      const txt = await r.text();
      if (!txt.trim()) throw new Error('empty body');
      const jj = JSON.parse(txt);
      if (jj.errno === 0 || jj.errno === -9) return jj; // -9=目录不存在(被列出的幽灵路径)
      throw new Error('errno ' + jj.errno);
    } catch (e) {
      await new Promise(r2 => setTimeout(r2, 1000 * Math.pow(2, t)));
    }
  }
  return null; // 放弃此目录（记 0，不算致命）
}

const fmt = (n) => n >= 1024 ** 4 ? (n / 1024 ** 4).toFixed(2) + 'TB' : (n / 1024 ** 3).toFixed(1) + 'GB';

async function du(startDir) {
  let total = 0, files = 0, dirs = 0, reqs = 0, fails = 0;
  const queue = [startDir];
  async function worker() {
    while (queue.length) {
      const dir = queue.shift();
      let start = 0, entries = [];
      let page;
      do {
        page = await listPage(dir, start);
        reqs++;
        if (!page) { fails++; break; }
        entries.push(...(page.list || []));
        start += 1000;
      } while ((page.list || []).length === 1000);
      if (!page) continue;
      for (const e of entries) {
        if (e.isdir) { dirs++; queue.push(dir + '/' + e.server_filename); }
        else { files++; total += e.size; }
      }
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
  return { size: total, files, dirs, reqs, fails };
}

// 断点加载
let report = { at: '', results: {} };
try { report = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch {}

// 深挖模式: node du.mjs 游戏资源 -> 统计其每个子目录的大小
if (only.length) {
  const parent = '/' + only[0].replace(/^\/+/, '');
  const kids = await listPage(parent, 0);
  if (!kids || kids.errno !== 0) { console.error('目录列举失败:', parent); process.exit(1); }
  console.log('深挖', parent, '子目录数:', (kids.list || []).filter(e => e.isdir).length);
  for (const e of kids.list || []) {
    if (!e.isdir) { console.log(fmt(e.size).padStart(8), ' ', e.server_filename, ' (文件)'); continue; }
    const t0 = Date.now();
    const r = await du(parent + '/' + e.server_filename);
    console.log(fmt(r.size).padStart(8), ' ', e.server_filename, ` (${r.files}文件 ${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  process.exit(0);
}

const root = await listPage('/', 0);
if (!root) { console.error('根目录列举失败'); process.exit(1); }
const top = (root.list || []).filter(e => e.isdir);
console.log('顶层目录数:', top.length);

for (const e of top) {
  if (report.results[e.server_filename]) { console.log('跳过(已扫):', e.server_filename, fmt(report.results[e.server_filename].size)); continue; }
  console.log('统计中:', e.server_filename);
  const t0 = Date.now();
  const r = await du('/' + e.server_filename);
  r.ms = Date.now() - t0;
  report.results[e.server_filename] = r;
  report.at = new Date().toISOString();
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
  console.log(`✓ ${e.server_filename}: ${fmt(r.size)}  ${r.files}文件 ${r.dirs}目录 ${r.reqs}请求 ${Math.round(r.ms / 1000)}s${r.fails ? ' 失败目录' + r.fails : ''}`);
}
// 汇总当前已知
const rs = Object.entries(report.results).map(([name, r]) => ({ name, ...r })).sort((a, b) => b.size - a.size);
const grand = rs.reduce((s, r) => s + r.size, 0);
console.log('\n===== 已统计部分 =====');
rs.forEach(r => console.log(fmt(r.size).padStart(8), ' ', r.name, ' (' + r.files + '文件)'));
console.log('已知合计:', fmt(grand), ' 共', Object.keys(report.results).length, '/', top.length, '个顶层目录');
