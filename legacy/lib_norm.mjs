// lib_norm.mjs — /游戏资源/PS5 目录规整：
// 标准 = ^[A-Z]{4}\d{4,6}$ 的 serial 目录（如 PPSA05106）
// 非标准目录：先从目录名推 serial，推不出再从内部 rar 文件名推（三级：rar > 全部文件 > 子目录名）
// 多源同 serial 合并；目标已有同名文件(忽略大小写)判重删除；删源目录前必须验证已空
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bd from './lib_baidu.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse((await import('node:fs')).readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STD_RE = () => new RegExp('^[A-Z]{4}\\d{4,6}$');
const serRe = () => new RegExp('\\b((' + CFG.serial_prefixes + ')[-_ ]?\\d{4,6})\\b', 'g');
const norm = (s) => s.replace(/[-_\s]/g, '').toUpperCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function serialsFromName(name) {
  const out = new Set();
  let m; const re = serRe();
  while ((m = re.exec(name))) out.add(norm(m[1]));
  return out;
}

// 对一个非标准条目推导目标 serial（null=推不出）
async function deriveTarget(entry, rootDir, bt) {
  let cands = serialsFromName(entry.server_filename);
  if (cands.size === 1) return [...cands][0];
  if (!entry.isdir) return null;
  const kids = await bd.listDir(rootDir + '/' + entry.server_filename, bt);
  if (!kids) return null;
  const files = kids.filter(k => !k.isdir);
  const dirs = kids.filter(k => k.isdir);
  for (const src of [
    files.filter(f => /\.rar$/i.test(f.server_filename)),
    files,
    dirs,
  ]) {
    const pool = new Set();
    src.forEach(f => serialsFromName(f.server_filename).forEach(s => pool.add(s)));
    if (pool.size === 1) return [...pool][0];
    if (pool.size > 1) return null; // 内部混杂多个 serial，不自动处理
  }
  return null;
}

// 主入口：规整 dest 目录，返回报告
export async function normalize(destDir, bt, log = []) {
  const std = STD_RE();
  const rootList = await bd.listDir(destDir, bt);
  if (!rootList) return { error: 'list_fail', log };
  const anomalies = [];
  const plans = [];
  for (const e of rootList) {
    if (std.test(e.server_filename)) continue;
    const target = await deriveTarget(e, destDir, bt);
    if (target) plans.push({ name: e.server_filename, isdir: e.isdir, target });
    else anomalies.push(e.server_filename);
    await sleep(250);
  }
  // 分组执行
  const groups = {};
  plans.forEach(p => (groups[p.target] = groups[p.target] || []).push(p.name));
  for (const [target, sources] of Object.entries(groups)) {
    const tDir = destDir + '/' + target;
    let live = await bd.listDir(tDir, bt);
    let rest = sources;
    if (!live) {
      const j = await bd.filemanager('rename', [{ path: destDir + '/' + sources[0], newname: target }], bt);
      log.push({ op: 'rename', from: sources[0], to: target, errno: j.errno });
      await sleep(500);
      rest = sources.slice(1);
      live = await bd.listDir(tDir, bt);
    }
    if (!live) { log.push({ op: 'no_target', target }); continue; }
    const tnames = new Set((live || []).map(x => x.server_filename.toLowerCase()));
    for (const name of rest) {
      const srcDir = destDir + '/' + name;
      const kids = await bd.listDir(srcDir, bt);
      if (!kids) { log.push({ op: 'ls_fail', dir: name }); continue; }
      const toMove = [], toDelete = [];
      kids.forEach(k => {
        const p = srcDir + '/' + k.server_filename;
        if (k.isdir) toMove.push({ path: p, dest: tDir, newname: k.server_filename });
        else if (tnames.has(k.server_filename.toLowerCase())) toDelete.push(p);
        else toMove.push({ path: p, dest: tDir, newname: k.server_filename });
      });
      if (toMove.length) {
        const j = await bd.filemanager('move', toMove, bt);
        const per = (j.info || []).filter(x => x.errno !== 0).length;
        log.push({ op: 'move', from: name, n: toMove.length, errno: j.errno, per_fail: per });
        await sleep(600);
      }
      if (toDelete.length) {
        const j = await bd.filemanager('delete', toDelete, bt);
        log.push({ op: 'dedup_delete', from: name, n: toDelete.length, errno: j.errno });
        await sleep(600);
      }
      await sleep(800);
      const after = await bd.listDir(srcDir, bt);
      if (after && after.length === 0) {
        const j = await bd.filemanager('delete', [srcDir], bt);
        log.push({ op: 'delete_src', dir: name, errno: j.errno });
      } else {
        log.push({ op: 'skip_delete_not_empty', dir: name, left: after ? after.length : 'ls_fail' });
      }
      await sleep(300);
    }
  }
  return { normalized: plans.length, anomalies, log };
}
