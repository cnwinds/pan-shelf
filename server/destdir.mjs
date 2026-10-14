// 修改来源的网盘转存根目录。可选把旧目录里已入盘的游戏一起搬过去：
// 新目录不存在时整体改名（一次调用），已存在时逐项移动（同名的跳过，不覆盖）。
import { all, one, exec, tx } from './db.mjs';
import { getSource } from './sources.mjs';
import * as bd from './baidu.mjs';

const fail = (code, msg) => Object.assign(new Error(msg), { statusCode: code });

export function normalizeDir(input) {
  const d = String(input || '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!d.startsWith('/') || d === '') throw fail(400, '网盘目录需以 / 开头，且不能是根目录');
  if (d.split('/').some(seg => seg === '.' || seg === '..')) throw fail(400, '网盘目录不能包含 . 或 ..');
  return d;
}

const within = (p, root) => p === root || p.startsWith(root + '/');

// 把缓存里 from 前缀下的路径改成 to 前缀
function retarget(from, to) {
  for (const r of all('SELECT path, parent FROM du_results WHERE path = ? OR path LIKE ?', from, from + '/%')) {
    const path = to + r.path.slice(from.length);
    const parent = r.path === from ? to.slice(0, to.lastIndexOf('/')) || '/' : to + r.parent.slice(from.length);
    exec('DELETE FROM du_results WHERE path = ?', path);
    exec('UPDATE du_results SET path = ?, parent = ?, name = ? WHERE path = ?', path, parent, path.slice(path.lastIndexOf('/') + 1), r.path);
  }
}

export async function changeDestDir(sourceId, input, { move = true } = {}) {
  const src = getSource(sourceId);
  if (!src) throw fail(404, '来源不存在');
  const oldDir = src.dest_dir;
  const newDir = normalizeDir(input);
  if (newDir === oldDir) return { dest_dir: newDir, moved: 0, skipped: [] };
  if (one(`SELECT id FROM jobs WHERE status IN ('queued','running','paused') AND (source_id = ? OR source_id IS NULL)`, sourceId)) {
    throw fail(409, '还有进行中的任务，请等任务结束或取消后再修改目录');
  }

  let moved = 0;
  const skipped = [];
  if (move) {
    if (within(newDir, oldDir) || within(oldDir, newDir)) throw fail(400, '新旧目录不能互相包含，无法搬移');
    const oldList = await bd.listDir(oldDir);
    if (oldList?.length) {
      const newList = await bd.listDir(newDir);
      if (newList === null) {
        const parent = newDir.slice(0, newDir.lastIndexOf('/'));
        if (parent && !(await bd.mkdir(parent))) throw fail(502, `无法创建上级目录 ${parent}`);
        if (!(await bd.mv(oldDir, newDir))) throw fail(502, '整体搬移失败，网盘里没有做任何改动');
        tx(() => retarget(oldDir, newDir));
        moved = oldList.length;
      } else {
        const taken = new Set(newList.map(e => e.name.toLowerCase()));
        for (const e of oldList) {
          if (taken.has(e.name.toLowerCase()) || !(await bd.mv(e.path, `${newDir}/${e.name}`))) {
            skipped.push(e.name);
            continue;
          }
          tx(() => retarget(e.path, `${newDir}/${e.name}`));
          moved++;
        }
        const left = await bd.listDir(oldDir);
        if (left && left.length === 0) await bd.rm([oldDir]);
      }
    }
  }

  tx(() => {
    exec('UPDATE sources SET dest_dir = ? WHERE id = ?', newDir, sourceId);
    if (move && moved) exec('UPDATE links SET dest_dir = ? WHERE source_id = ? AND dest_dir = ?', newDir, sourceId, oldDir);
    exec(`UPDATE normalize_plans SET status = 'superseded' WHERE dest_dir = ? AND status = 'ready'`, oldDir);
  });
  return { dest_dir: newDir, moved, skipped };
}
