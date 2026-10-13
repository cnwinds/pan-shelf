import { all, one, exec } from './db.mjs';
import { nowIso } from './util.mjs';

// ---------- 页面解析：所有来源共用的百度盘链接提取 ----------
// 每条链接附带 remark：它与上一条链接之间最后一个「备注：…」（站点用它标注格式和版本，如「v01.027 4.xx exFAT格式」）
export function extractBaiduLinks(html) {
  const links = new Map();
  const re = /pan\.baidu\.com(?:%2F|\/)s(?:%2F|\/)([A-Za-z0-9_-]+)(?:(?:%3F|\?)pwd(?:%3D|=)([A-Za-z0-9]{4}))?/g;
  let m;
  while ((m = re.exec(html))) {
    const cur = links.get(m[1]);
    if (!cur) links.set(m[1], { surl: m[1], pwd: m[2] || '', at: m.index });
    else if (!cur.pwd && m[2]) cur.pwd = m[2];
  }
  const list = [...links.values()];
  if (list.some(l => !l.pwd)) {
    const box = html.match(/提取码\s*[:：]\s*(?:<[^>]+>\s*)*([A-Za-z0-9]{4})/);
    if (box) for (const l of list) if (!l.pwd) l.pwd = box[1];
  }
  return list.map((l, i) => ({ surl: l.surl, pwd: l.pwd, remark: remarkBefore(html.slice(i ? list[i - 1].at : 0, l.at)) }));
}

function remarkBefore(seg) {
  const text = seg
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>|<\/(div|p|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  const all = [...text.matchAll(/备注\s*[:：]\s*([^\n]+)/g)];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

// 游戏编号（如「游戏编号：PPSA02429」），网盘目录规整后就以它命名，删除游戏时靠它定位
export function extractSerial(html) {
  const m = html.match(/游戏编号\s*[:：]\s*(?:<[^>]+>\s*)*([A-Za-z]{4})[-_ ]?(\d{4,6})/);
  return m ? (m[1] + m[2].padStart(5, '0')).toUpperCase() : null;
}

const pageTitle = (html, strip) => {
  const tm = html.match(/<title>([^<]*)<\/title>/i);
  let t = tm ? tm[1].trim() : '';
  if (strip) t = t.replace(new RegExp(strip + '\\s*$'), '').trim();
  return t.replace(/&amp;/g, '&').replace(/&#8211;/g, '–').replace(/&#039;/g, "'");
};

// ---------- 站点适配器 ----------
// 每个适配器负责：列表第 N 页地址、从列表页提取帖子、从详情页提取标题和链接
export const ADAPTERS = {
  wp2468c: {
    label: 'WordPress 分类（2468c 等）',
    listUrl: (s, page) => page === 1 ? s.base_url + s.category_path : `${s.base_url}${s.category_path}/page/${page}`,
    extractPosts(html, s) {
      const origin = new URL(s.base_url).origin;
      const re = /https?:\/\/[^"'\s<>]+\/(\d+)\.html/g;
      const out = new Map();
      let m;
      while ((m = re.exec(html))) if (m[0].startsWith(origin)) out.set(m[1], m[0]);
      return out;
    },
    extractDetail: (html, s) => ({
      title: pageTitle(html, s.options.title_suffix ? escapeRe(s.options.title_suffix) : ''),
      links: extractBaiduLinks(html),
      serial: extractSerial(html),
    }),
  },
  generic: {
    label: '通用（自定义正则）',
    listUrl: (s, page) => {
      const tpl = page === 1 ? (s.options.first_page_url || '{base}{category}') : (s.options.page_url || '{base}{category}/page/{n}');
      return tpl.replace('{base}', s.base_url).replace('{category}', s.category_path).replace('{n}', String(page));
    },
    extractPosts(html, s) {
      const re = new RegExp(s.options.post_url_regex || 'https?://[^"\'\\s<>]+/(\\d+)\\.html', 'g');
      const out = new Map();
      let m;
      while ((m = re.exec(html))) {
        const url = m[0].startsWith('http') ? m[0] : new URL(m[0], s.base_url).href;
        out.set(m[1] || url, url);
      }
      return out;
    },
    extractDetail: (html, s) => ({
      title: pageTitle(html, s.options.title_strip_regex || ''),
      links: extractBaiduLinks(html),
      serial: extractSerial(html),
    }),
  },
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- CRUD ----------
const hydrate = (r) => r && { ...r, enabled: !!r.enabled, options: JSON.parse(r.options || '{}') };

export const listSources = () => all('SELECT * FROM sources ORDER BY created_at').map(hydrate);
export const getSource = (id) => hydrate(one('SELECT * FROM sources WHERE id = ?', id));

function check(s) {
  const errs = [];
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(s.id || '')) errs.push('ID 只能用小写字母、数字和连字符（2~41 位）');
  if (!s.name?.trim()) errs.push('名称不能为空');
  if (!ADAPTERS[s.adapter]) errs.push('未知的站点类型');
  try { new URL(s.base_url); } catch { errs.push('站点地址无效'); }
  if (!String(s.category_path || '').startsWith('/')) errs.push('分类路径需以 / 开头');
  if (!String(s.dest_dir || '').startsWith('/')) errs.push('网盘目录需以 / 开头');
  if (errs.length) { const e = new Error(errs.join('；')); e.statusCode = 400; throw e; }
}

export function saveSource(input, { isNew }) {
  const s = {
    ...input,
    base_url: String(input.base_url || '').replace(/\/+$/, ''),
    dest_dir: String(input.dest_dir || '').replace(/\/+$/, ''),
    options: input.options || {},
  };
  check(s);
  if (isNew) {
    if (getSource(s.id)) { const e = new Error('ID 已存在'); e.statusCode = 409; throw e; }
    exec(`INSERT INTO sources (id, name, adapter, base_url, category_path, dest_dir, enabled, options, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id, s.name.trim(), s.adapter, s.base_url, s.category_path, s.dest_dir, s.enabled === false ? 0 : 1, JSON.stringify(s.options), nowIso());
  } else {
    exec(`UPDATE sources SET name = ?, adapter = ?, base_url = ?, category_path = ?, dest_dir = ?, enabled = ?, options = ? WHERE id = ?`,
      s.name.trim(), s.adapter, s.base_url, s.category_path, s.dest_dir, s.enabled === false ? 0 : 1, JSON.stringify(s.options), s.id);
  }
  return getSource(s.id);
}

export function deleteSource(id) {
  exec('DELETE FROM links WHERE source_id = ?', id);
  exec('DELETE FROM posts WHERE source_id = ?', id);
  exec('DELETE FROM sources WHERE id = ?', id);
}
