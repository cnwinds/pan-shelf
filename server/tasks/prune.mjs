// 网盘目录工具：算目录大小、删空目录。退出网盘 / 去重在用。
import * as bd from '../baidu.mjs';
import { getSettings } from '../settings.mjs';

export async function treeSize(dir) {
  let size = 0;
  for (const e of await bd.listDir(dir) || []) size += e.isdir ? await treeSize(e.path) : e.size;
  return size;
}

export const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

// 由深到浅检查这些目录（root 以内、不含 root），重新列目录确认已空才删，删掉后继续检查它的父目录
export async function removeEmptyDirs(ctx, root, dirs) {
  const pending = [...dirs];
  let emptied = 0;
  while (pending.length) {
    pending.sort((a, b) => b.split('/').length - a.split('/').length);
    const dir = pending.shift();
    if (dir === root || !dir.startsWith(root + '/')) continue;
    await ctx.checkpoint();
    const left = await bd.listDir(dir);
    if (!left || left.length) continue;
    if (await bd.rm([dir], ctx.signal)) {
      emptied++;
      ctx.log(`已删除空目录 ${dir}`);
      const up = parentOf(dir);
      if (!pending.includes(up)) pending.push(up);
    }
    await ctx.sleep(getSettings().normalize.op_interval_ms);
  }
  return emptied;
}
