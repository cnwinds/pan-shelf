export function bytes(n?: number | null) {
  if (n == null) return '-';
  if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + ' TB';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.max(0, Math.round(n / 1024)) + ' KB';
}

export function duration(sec?: number | null) {
  if (sec == null || !Number.isFinite(sec)) return '-';
  sec = Math.round(sec);
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function dateTime(iso?: string | null) {
  if (!iso) return '-';
  const d = new Date(iso);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  const t = new Date(now); t.setDate(now.getDate() + 1);
  if (d.toDateString() === t.toDateString()) return `明天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function clock(iso: string) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function ago(iso?: string | null) {
  if (!iso) return '从未';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export const pct = (a: number, b: number) => (b > 0 ? Math.min(100, (a / b) * 100) : 0);
