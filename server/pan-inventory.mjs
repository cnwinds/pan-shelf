// 网盘清单：定时列各来源转存目录的第一层，记下名称里的游戏编号，游戏库据此判断「已入盘」
// （网盘里原有的游戏、手动存进去的都能识别）
import { all, exec, tx } from './db.mjs';
import { listSources, getSource } from './sources.mjs';
import * as bd from './baidu.mjs';
import { serialsFromName } from './tasks/normalize.mjs';
import { lookupCatalogBySerial } from './catalog.mjs';
import { bus } from './bus.mjs';
import { nowIso } from './util.mjs';
import { purgeStaleDu } from './tasks/du.mjs';

const INTERVAL_MS = 30 * 60_000;
// 这些任务会改动转存目录，完成后立即刷新
const PAN_JOBS = new Set(['transfer', 'remove', 'dedupe']);
const running = new Map();
const lastAttempt = new Map();

// 打开游戏库时调用：清单超过 maxAgeMs 没刷新就在后台刷新，完成后推送 pan_inventory 事件让页面重新加载
export function refreshIfStale(sourceId, maxAgeMs = 5 * 60_000) {
  if (sourceId && Date.now() - (lastAttempt.get(sourceId) || 0) > maxAgeMs) syncPanInventory(sourceId);
}

export function syncPanInventory(sourceId) {
  if (running.has(sourceId)) return running.get(sourceId);
  lastAttempt.set(sourceId, Date.now());
  const p = (async () => {
    const src = getSource(sourceId);
    if (!src?.dest_dir) return null;
    const entries = await bd.listDir(src.dest_dir);
    if (entries === null) {
      exec('DELETE FROM pan_items WHERE source_id = ?', sourceId);
      // 转存目录本身没了：底下用量缓存（含孤儿 @exfat/@folder）一并清掉
      purgeStaleDu(src.dest_dir, []);
      return 0;
    }
    // 顺手清掉顶层已不存在、但 @exfat/@folder 等用量缓存还挂着的孤儿，避免误判已入盘
    purgeStaleDu(src.dest_dir, entries.map(e => e.name));
    const at = nowIso();
    let n = 0;
    tx(() => {
      exec('DELETE FROM pan_items WHERE source_id = ?', sourceId);
      for (const e of entries) {
        for (const serial of serialsFromName(e.name)) {
          const concept = lookupCatalogBySerial(serial)?.conceptId || null;
          exec('INSERT OR IGNORE INTO pan_items (source_id, serial, name, path, is_dir, concept_id, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            sourceId, serial, e.name, e.path || `${src.dest_dir}/${e.name}`, e.isdir ? 1 : 0, concept, at);
          n++;
        }
      }
    });
    bus.emit('pan_inventory', { source_id: sourceId, items: n });
    return n;
  })()
    .catch((e) => { console.warn(`网盘清单刷新失败（${sourceId}）：${e.message}`); return null; })
    .finally(() => running.delete(sourceId));
  running.set(sourceId, p);
  return p;
}

const syncAll = () => listSources().filter(s => s.enabled).forEach(s => syncPanInventory(s.id));

export function startPanInventorySync() {
  setTimeout(syncAll, 5000);
  setInterval(syncAll, INTERVAL_MS);
  bus.on('job', (job) => {
    if (job?.status === 'done' && job.source_id && PAN_JOBS.has(job.type)) syncPanInventory(job.source_id);
  });
}

// 供游戏库批量判断：{ serials: Set, concepts: Set }
export function panInventorySets(sourceId) {
  const rows = all('SELECT serial, concept_id FROM pan_items WHERE source_id = ?', sourceId);
  return { serials: new Set(rows.map(r => r.serial)), concepts: new Set(rows.map(r => Number(r.concept_id)).filter(Boolean)) };
}
