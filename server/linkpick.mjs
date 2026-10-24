// 一个帖子常给出同一游戏的多个版本（exFAT / 文件夹 / fpkg，新旧版本号）。每种格式各收一个：
//   exFAT、文件夹、未标注各取版本号最高的，同版本按页面顺序；PKG/FPKG 一律不收（盘游装不了）
// 转存时每种格式放进游戏编号目录下的格式子目录（@exfat / @folder / @other），盘游据此让你选装哪种格式
import { all, one, exec, tx } from './db.mjs';
import { getSettings } from './settings.mjs';

export const FORMAT_LABEL = { exfat: 'exFAT', folder: '文件夹', pkg: 'PKG', unknown: '未标注' };
export const FORMATS = ['exfat', 'folder', 'unknown'];
// 网盘里的格式子目录名，和盘游约定好，不能随意改
export const FORMAT_DIR = { exfat: '@exfat', folder: '@folder', unknown: '@other' };
export const formatOfDir = (name) => Object.keys(FORMAT_DIR).find(f => FORMAT_DIR[f] === String(name).toLowerCase()) || null;
export const isFormatDir = (name) => formatOfDir(name) !== null;
const EXTRA_RE = /补丁|dlc|金手指|存档|修改器|升级档|更新档|追加内容/i;

export function classify(remark = '') {
  const r = remark.toLowerCase();
  let format = 'unknown';
  if (r.includes('exfat')) format = 'exfat';
  else if (/(^|[^a-z])f?pkg([^a-z]|$)/.test(r)) format = 'pkg';
  else if (r.includes('文件夹')) format = 'folder';
  const version = remark.match(/v?(\d{1,2}\.\d{2,3}(?:\.\d{2,3})?)/i)?.[1] || null;
  // 「4.xx」「8.xx+」是这份资源要求的最低固件
  const firmware = remark.match(/(\d{1,2})\.xx/i)?.[1] || null;
  // 「v01.012+DLC」是本体带 DLC；没有版本号、只写补丁 / DLC 的才是单独的附加内容
  return { format, version, firmware, extra: format === 'unknown' && !version && EXTRA_RE.test(remark) };
}

const cmpVer = (a, b) => {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

export const describe = (x) => FORMAT_LABEL[x.format] + (x.version ? ' ' + x.version : '');

// 返回与输入同序的数组：{ ...link, format, version, chosen, reason }
export function pickLinks(links) {
  const items = links.map((l, i) => ({ ...l, ...classify(l.remark), i }));
  if (!getSettings().transfer.pick_one) {
    return items.map(x => ({ ...x, chosen: x.format !== 'pkg', reason: x.format === 'pkg' ? 'PKG 格式，不收录' : null }));
  }
  const best = new Map();
  for (const x of items) {
    if (x.format === 'pkg' || x.extra) continue;
    const cur = best.get(x.format);
    if (!cur || cmpVer(x.version, cur.version) > 0) best.set(x.format, x);
  }
  return items.map(x => ({
    ...x,
    chosen: best.get(x.format) === x,
    reason: best.get(x.format) === x ? null
      : x.format === 'pkg' ? 'PKG 格式，不收录'
        : x.extra ? '补丁 / DLC，不收录'
          : `同帖已选用 ${describe(best.get(x.format))}`,
  }));
}

// 旧版每帖只收一个版本：升级后按每种格式各收一个重新挑一遍，被自动跳过、现在该收的改回「可入盘」
export function repickMultiFormat() {
  const KEY = '_multi_format_v1';
  if (one('SELECT value FROM settings WHERE key = ?', KEY)) return 0;
  let n = 0;
  tx(() => {
    const posts = all(`SELECT DISTINCT source_id, post_id FROM links WHERE status = 'skipped' AND last_error LIKE '自动跳过：%'`);
    for (const p of posts) {
      const links = all('SELECT surl, remark, status, last_error FROM links WHERE source_id = ? AND post_id = ? ORDER BY rowid', p.source_id, p.post_id);
      if (links.some(l => l.remark === null)) continue;
      for (const l of pickLinks(links)) {
        if (l.chosen && l.status === 'skipped' && l.last_error?.startsWith('自动跳过：')) {
          n += exec(`UPDATE links SET status = 'available', last_error = NULL WHERE surl = ?`, l.surl).changes;
        }
      }
    }
    exec('INSERT INTO settings (key, value) VALUES (?, ?)', KEY, JSON.stringify({ at: new Date().toISOString(), restored: n }));
  });
  return n;
}

export const pickSummary = (picked) => {
  const chosen = picked.filter(x => x.chosen);
  if (picked.length < 2 && chosen.length) return '';
  return chosen.length ? `选用 ${chosen.map(describe).join('、')}` : '没有可收录的版本';
};
