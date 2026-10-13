// 调度器：每天定时跑流水线；站点被封时按间隔探测，解封后自动采集
import { one, exec } from './db.mjs';
import { getSettings } from './settings.mjs';
import { listSources } from './sources.mjs';
import { enqueue, isActive } from './jobs.mjs';
import { hostHealth } from './site.mjs';
import { fmtLocal } from './util.mjs';
import { bus } from './bus.mjs';

const KEY = '_schedule_state';
const loadState = () => JSON.parse(one('SELECT value FROM settings WHERE key = ?', KEY)?.value || '{"fired":{},"probe":{}}');
const saveState = (s) => exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(s));

// 启动一轮流水线：按配置的步骤为每个启用的来源入队
export function runPipeline({ trigger = 'manual', steps, source_ids } = {}) {
  steps = steps || getSettings().schedule.steps;
  // 不自动转存时，定时运行只同步游戏列表；转存只处理你在游戏库里加入网盘的游戏
  if (!getSettings().transfer.auto) steps = steps.filter(s => s !== 'transfer');
  const sources = listSources().filter(s => s.enabled && (!source_ids || source_ids.includes(s.id)));
  const jobs = [];
  for (const s of sources) {
    let prev = null;
    for (const step of steps) {
      // 转存与采集并行（转存会跟随采集等待新链接），规整预览等转存结束
      const after = step === 'normalize_plan' && prev ? [prev.id] : [];
      const j = enqueue(step, { source_id: s.id, trigger, params: after.length ? { after } : {} });
      jobs.push(j);
      prev = j;
    }
  }
  return jobs;
}

export function nextRuns() {
  const sch = getSettings().schedule;
  if (!sch.enabled) return [];
  const now = new Date();
  return sch.times.map(t => {
    const [h, m] = t.split(':').map(Number);
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }).sort();
}

function tick() {
  const sch = getSettings().schedule;
  const st = loadState();
  const now = new Date();
  const today = fmtLocal(now).slice(0, 10);

  if (sch.enabled) {
    for (const t of sch.times) {
      // 允许 5 分钟内补触发（服务刚好在整点前后重启的情况）
      const [h, m] = t.split(':').map(Number);
      const target = new Date(now); target.setHours(h, m, 0, 0);
      const late = now - target;
      if (late >= 0 && late < 5 * 60_000 && st.fired[t] !== today) {
        st.fired[t] = today;
        saveState(st);
        const jobs = runPipeline({ trigger: 'schedule' });
        bus.emit('schedule', { time: t, jobs: jobs.map(j => j.id) });
      }
    }
  }

  if (sch.probe_enabled) {
    for (const s of listSources().filter(x => x.enabled)) {
      const h = hostHealth(s.base_url);
      if (!h.blocked) continue;
      if (isActive('crawl', s.id) || isActive('probe', s.id)) continue;
      const last = Math.max(st.probe[s.id] || 0, h.checked_at ? Date.parse(h.checked_at) : 0);
      if (Date.now() - last >= sch.probe_interval_min * 60_000) {
        st.probe[s.id] = Date.now();
        saveState(st);
        enqueue('probe', { source_id: s.id, trigger: 'probe' });
      }
    }
  }
}

export function startScheduler() {
  setInterval(tick, 20_000);
  setTimeout(tick, 3000);
}
