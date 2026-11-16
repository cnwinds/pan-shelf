// 从文件/目录名里识别游戏编号（PPSA… / CUSA… 等）。清单、退出网盘、分享编号在用。
import { getSettings } from '../settings.mjs';

const serialRe = () => new RegExp('\\b((' + getSettings().normalize.serial_prefixes + ')[-_ ]?\\d{4,6})\\b', 'gi');
const normSerial = (s) => s.replace(/[-_\s]/g, '').toUpperCase();

export function serialsFromName(name) {
  const out = new Set();
  const re = serialRe();
  let m;
  while ((m = re.exec(name))) out.add(normSerial(m[1]));
  return out;
}
