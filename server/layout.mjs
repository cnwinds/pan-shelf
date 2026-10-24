// 网盘里游戏的摆放：<转存目录>/<游戏编号>/<格式子目录>/，格式子目录见 linkpick 的 FORMAT_DIR。
// 盘游把每个格式子目录当成这款游戏的一种格式，安装时让你选。
import { one } from './db.mjs';
import { FORMAT_DIR, classify } from './linkpick.mjs';
import * as bd from './baidu.mjs';

const STD_RE = /^[A-Z]{4}\d{4,6}$/;

export const linkFormat = (link) => link.format || (link.remark != null ? classify(link.remark).format : null);

// 这条链接该转存到哪：知道游戏编号和格式时进格式子目录，否则还放在转存目录第一层，等规整
export function linkDestDir(src, link) {
  const root = src.dest_dir.replace(/\/+$/, '');
  const format = linkFormat(link);
  const serial = String(one('SELECT serial FROM posts WHERE source_id = ? AND post_id = ?', link.source_id, link.post_id)?.serial || '').toUpperCase();
  if (!STD_RE.test(serial) || !FORMAT_DIR[format]) return root;
  return `${root}/${serial}/${FORMAT_DIR[format]}`;
}

// 每种格式的状态，给游戏库和详情：in_pan 已在网盘 / queued 排队转存 / available 可加入 / bad 盘游说不能玩 / none 没有能用的链接
const STATE_RANK = { in_pan: 0, queued: 1, available: 2, bad: 3, failed: 4, none: 5 };
export function formatStates(links) {
  const out = new Map();
  for (const l of links) {
    const format = linkFormat(l);
    if (!FORMAT_DIR[format]) continue;
    const s = l.status;
    const state = s === 'saved' || s === 'exists' ? 'in_pan' : s === 'pending' ? 'queued' : s === 'available' ? 'available'
      : s === 'bad' ? 'bad' : s.startsWith('err_') || s === 'exc' ? 'failed' : 'none';
    const cur = out.get(format);
    if (!cur || STATE_RANK[state] < STATE_RANK[cur.state]) {
      const { version, firmware } = classify(l.remark || '');
      out.set(format, { format, state, surl: l.surl, version, firmware });
    }
  }
  return Object.keys(FORMAT_DIR).filter(f => out.has(f)).map(f => out.get(f));
}

// 分享里只有一个外包目录时，把它里面的东西挪到格式子目录这一层，外包目录删掉（和规整合并时一样）
export async function flattenWrapper(dir, names, { signal, log } = {}) {
  if (names?.length !== 1) return;
  const list = await bd.listDir(dir);
  const wrapper = list?.find(e => e.name === names[0] && e.isdir);
  if (!wrapper || list.length !== 1) return;
  const kids = await bd.listDir(`${dir}/${wrapper.name}`);
  if (!kids?.length) return;
  let moved = 0;
  for (const k of kids) if (await bd.mv(`${dir}/${wrapper.name}/${k.name}`, `${dir}/${k.name}`, signal)) moved++;
  const left = await bd.listDir(`${dir}/${wrapper.name}`);
  if (left && left.length === 0) await bd.rm([`${dir}/${wrapper.name}`], signal);
  log?.(`去掉外包目录「${wrapper.name}」：移出 ${moved}/${kids.length} 项`);
}
