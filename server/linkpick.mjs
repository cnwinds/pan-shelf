// 一个帖子常给出同一游戏的多个版本（exFAT / 文件夹 / fpkg，新旧版本号），只收录一个：
//   exFAT > 文件夹 > 未标注；PKG/FPKG 一律不收；同格式取版本号最高的，再按页面顺序
import { getSettings } from './settings.mjs';

export const FORMAT_LABEL = { exfat: 'exFAT', folder: '文件夹', pkg: 'PKG', unknown: '未标注' };
const RANK = { exfat: 0, folder: 1, unknown: 2 };
const EXTRA_RE = /补丁|dlc|金手指|存档|修改器|升级档|更新档|追加内容/i;

export function classify(remark = '') {
  const r = remark.toLowerCase();
  let format = 'unknown';
  if (r.includes('exfat')) format = 'exfat';
  else if (/(^|[^a-z])f?pkg([^a-z]|$)/.test(r)) format = 'pkg';
  else if (r.includes('文件夹')) format = 'folder';
  const version = remark.match(/v?(\d{1,2}\.\d{2,3}(?:\.\d{2,3})?)/i)?.[1] || null;
  // 「v01.012+DLC」是本体带 DLC；没有版本号、只写补丁 / DLC 的才是单独的附加内容
  return { format, version, extra: format === 'unknown' && !version && EXTRA_RE.test(remark) };
}

const cmpVer = (a, b) => {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

const describe = (x) => FORMAT_LABEL[x.format] + (x.version ? ' ' + x.version : '');

// 返回与输入同序的数组：{ ...link, format, version, chosen, reason }
export function pickLinks(links) {
  const items = links.map((l, i) => ({ ...l, ...classify(l.remark), i }));
  if (!getSettings().transfer.pick_one) {
    return items.map(x => ({ ...x, chosen: x.format !== 'pkg', reason: x.format === 'pkg' ? 'PKG 格式，不收录' : null }));
  }
  const best = items.filter(x => x.format !== 'pkg' && !x.extra)
    .sort((a, b) => RANK[a.format] - RANK[b.format] || cmpVer(b.version, a.version) || a.i - b.i)[0];
  return items.map(x => ({
    ...x,
    chosen: x === best,
    reason: x === best ? null
      : x.format === 'pkg' ? 'PKG 格式，不收录'
        : x.extra ? '补丁 / DLC，不收录'
          : `同帖已选用 ${describe(best)}`,
  }));
}

export const pickSummary = (picked) => {
  const best = picked.find(x => x.chosen);
  if (picked.length < 2 && best) return '';
  return best ? `选用 ${describe(best)}` : '没有可收录的版本';
};
