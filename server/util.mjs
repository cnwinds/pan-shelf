export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const nowIso = () => new Date().toISOString();

export const fmtLocal = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const fmtBytes = (n) => {
  if (n == null) return '-';
  if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + ' TB';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
};

export function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch) || typeof base !== 'object' || base === null || typeof patch !== 'object' || patch === null) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

export class Mutex {
  #tail = Promise.resolve();
  run(fn) {
    const next = this.#tail.then(() => fn(), () => fn());
    this.#tail = next.catch(() => {});
    return next;
  }
}
