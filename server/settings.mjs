import fs from 'node:fs';
import { one, exec } from './db.mjs';
import { LEGACY_CONFIG } from './paths.mjs';
import { deepMerge } from './util.mjs';
import { bus } from './bus.mjs';

let legacy = {};
try { legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8')); } catch {}

export const DEFAULTS = {
  crawl: {
    detail_interval_sec: 5.5,     // 相邻两次站点请求的最小间隔（全局串行）
    jitter_sec: 1.5,              // 在间隔上叠加 0~N 秒随机抖动
    list_pages_default: legacy.list_pages_default ?? 3,
    list_pages_max: legacy.list_pages_max ?? 20,
    stop_after_empty_pages: 1,    // 连续 N 页没有新帖就停止翻页（第 1 页之后才计）
    timeout_sec: legacy.http_timeout_sec ?? 40,
    retries: 3,
    backlog_per_run: 0,           // 每次补抓历史缺口的上限，0 = 不限
    max_detail_failures: 3,       // 单帖详情连续失败 N 次后标记为失败，不再自动补抓
    block_threshold: 3,           // 连续 N 次请求全部失败判定为被封禁，任务停止
  },
  transfer: {
    auto: false,                  // 采集到新链接后自动转存；关闭时只标为「可入盘」，在游戏库挑选后再加入网盘
    interval_ms: legacy.transfer_delay_ms ?? 1000,
    timeout_sec: 180,
    reserve_gb: 200,              // 网盘剩余空间低于此值时暂停转存
    quota_check_every: 5,         // 每转存 N 条重新查一次配额
    max_per_run: 0,               // 0 = 不限
    follow_crawl: true,           // 采集进行中时，转存任务等待新链接而不是直接结束
    pick_one: true,               // 一个帖子多条链接时只收录一个版本（exFAT 优先），其余自动跳过
    // 百度转存只能整份分享一起存，所以排除项是「存完再删」：名称命中的文件/目录整个删掉
    exclude_enabled: true,
    exclude_pattern: '(^|[^a-z])f?pkg([^a-z]|$)',
  },
  normalize: {
    serial_prefixes: legacy.serial_prefixes ?? 'PPSA|CUSA|CUAS|PUSA|PCAS|PRLA|PLAS|PASA|PEGA|ACBA|BLAS|HLPS',
    op_interval_ms: 600,
    auto_plan_after_transfer: true, // 转存完成后自动生成规整预览（不执行）
  },
  schedule: {
    enabled: true,
    times: ['10:00'],
    steps: ['crawl', 'transfer', 'normalize_plan'],
    probe_enabled: true,          // 站点被封时定时探测，解封后自动跑一轮
    probe_interval_min: 60,
  },
  notify: {
    toast: true,
    webhook_url: '',
    webhook_format: 'json',       // json | wecom | dingtalk | feishu
    on: { run_done: true, new_games: true, error: true, login_expired: true, quota_low: true, site_blocked: true, plan_ready: true },
  },
  server: {
    port: 5175,
  },
};

const RANGES = {
  'crawl.detail_interval_sec': [2, 120, '请求间隔'],
  'crawl.jitter_sec': [0, 60, '随机抖动'],
  'crawl.list_pages_default': [1, 200, '默认翻页数'],
  'crawl.list_pages_max': [1, 500, '最多翻页数'],
  'crawl.stop_after_empty_pages': [1, 50, '连续无新游戏停止页数'],
  'crawl.timeout_sec': [5, 300, '请求超时'],
  'crawl.retries': [1, 10, '单个页面重试次数'],
  'crawl.backlog_per_run': [0, 100000, '每次补抓上限'],
  'crawl.max_detail_failures': [1, 100, '单个游戏最多失败次数'],
  'crawl.block_threshold': [1, 50, '判定封禁的连续失败数'],
  'transfer.interval_ms': [0, 600000, '转存间隔'],
  'transfer.timeout_sec': [30, 1800, '单次转存超时'],
  'transfer.reserve_gb': [0, 100000, '保底剩余空间'],
  'transfer.quota_check_every': [1, 1000, '空间检查频率'],
  'transfer.max_per_run': [0, 100000, '每次最多转存'],
  'normalize.op_interval_ms': [0, 60000, '网盘操作间隔'],
  'schedule.probe_interval_min': [5, 1440, '探测间隔'],
  'server.port': [1024, 65535, '服务端口'],
};

function validate(s) {
  const errs = [];
  for (const [k, [lo, hi, label]] of Object.entries(RANGES)) {
    const [a, b] = k.split('.');
    const v = Number(s[a][b]);
    if (!Number.isFinite(v) || v < lo || v > hi) errs.push(`「${label}」需在 ${lo}~${hi} 之间`);
    else s[a][b] = v;
  }
  if (!Array.isArray(s.schedule.times) || s.schedule.times.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) errs.push('运行时间格式应为 HH:MM');
  const okSteps = ['crawl', 'transfer', 'normalize_plan'];
  if (!Array.isArray(s.schedule.steps) || s.schedule.steps.some(x => !okSteps.includes(x))) errs.push('定时步骤无效');
  try { new RegExp(s.normalize.serial_prefixes); } catch { errs.push('serial 前缀不是合法的正则表达式'); }
  try {
    // 能匹配空串的规则会命中所有名称，等于清空整个目录
    if (new RegExp(s.transfer.exclude_pattern, 'i').test('')) errs.push('排除规则会匹配所有名称，请写得更具体');
  } catch { errs.push('排除规则不是合法的正则表达式'); }
  if (s.notify.webhook_url && !/^https?:\/\//.test(s.notify.webhook_url)) errs.push('Webhook 地址需以 http:// 或 https:// 开头');
  if (!['json', 'wecom', 'dingtalk', 'feishu'].includes(s.notify.webhook_format)) errs.push('Webhook 消息格式无效');
  if (errs.length) { const e = new Error(errs.join('；')); e.statusCode = 400; throw e; }
  return s;
}

let cache = null;
export function getSettings() {
  if (!cache) {
    const row = one('SELECT value FROM settings WHERE key = ?', 'app');
    cache = deepMerge(structuredClone(DEFAULTS), row ? JSON.parse(row.value) : {});
  }
  return cache;
}

export function updateSettings(patch) {
  const next = validate(deepMerge(structuredClone(getSettings()), patch));
  exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'app', JSON.stringify(next));
  cache = next;
  bus.emit('settings', next);
  return next;
}
