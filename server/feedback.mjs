// 盘游的反馈（盘游 docs/adr/0012）：盘游把装的时候发现的问题写到网盘 /盘游/反馈/<设备>.json，这里定时读回来，
// 编排还是出问题那一版的就交给分析器重新分析。盘游看到资源库里编排的版本变高了，自己把那条反馈去掉。
import { one, exec } from './db.mjs';
import * as bd from './baidu.mjs';
import { queueReanalysis } from './analyze.mjs';
import { nowIso } from './util.mjs';

// 盘游也按这个位置写，改了要两边一起改
export const FEEDBACK_DIR = '/盘游/反馈';
const INTERVAL_MS = 10 * 60_000;
const MAX_FILE_BYTES = 4 << 20;
const KINDS = new Set(['mismatch', 'install_failed', 'bad_review', 'manual']);

const seen = new Map();
let running = null;
export const feedbackState = { at: null, error: null, received: 0 };

function take(deviceId, deviceName, item) {
  if (!item?.id || !KINDS.has(item.kind) || !item.surl) return false;
  const id = `${deviceId}:${item.id}`;
  if (one('SELECT 1 FROM feedback WHERE id = ?', id)) return false;
  const planRev = Number(item.plan_rev) || 0;
  exec(`INSERT INTO feedback (id, device_id, device_name, surl, title_id, format, kind, detail, plan_rev, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, deviceId, deviceName, String(item.surl), item.title_id || null, item.format || null, item.kind,
    String(item.detail || '').slice(0, 500), planRev, Number(item.at) || 0);
  const current = one('SELECT rev FROM link_plans WHERE surl = ?', String(item.surl))?.rev || 0;
  if (planRev < current) {
    // 反馈的是旧版编排，已经重新分析过了
    exec('UPDATE feedback SET handled_at = ? WHERE id = ?', nowIso(), id);
    return false;
  }
  console.log(`盘游反馈（${deviceName}）：${item.title_id || item.surl} ${item.kind} ${item.detail || ''}`);
  queueReanalysis(String(item.surl));
  return true;
}

export function syncFeedback() {
  if (running) return running;
  running = (async () => {
    const entries = (await bd.listDir(FEEDBACK_DIR)) || [];
    let received = 0;
    for (const f of entries) {
      if (f.isdir || !f.name.endsWith('.json') || f.size > MAX_FILE_BYTES || seen.get(f.name) === f.fs_id) continue;
      let doc;
      try {
        doc = JSON.parse(await bd.readSmallFile(f.fs_id));
      } catch (e) {
        console.warn(`读盘游反馈 ${f.name} 失败：${e.message}`);
        continue;
      }
      const deviceId = f.name.slice(0, -5);
      const deviceName = String(doc?.device?.name || '').trim() || '盘游';
      for (const item of Array.isArray(doc?.items) ? doc.items : []) if (take(deviceId, deviceName, item)) received++;
      seen.set(f.name, f.fs_id);
    }
    Object.assign(feedbackState, { at: nowIso(), error: null, received: feedbackState.received + received });
    return received;
  })()
    .catch((e) => { feedbackState.error = e.message; console.warn(`盘游反馈同步失败：${e.message}`); return 0; })
    .finally(() => { running = null; });
  return running;
}

export function startFeedbackSync() {
  setTimeout(syncFeedback, 15_000);
  setInterval(syncFeedback, INTERVAL_MS);
}
