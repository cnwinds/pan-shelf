import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, STATE_DIR, LEGACY_CONFIG } from './paths.mjs';
import { nowIso } from './util.mjs';

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  adapter       TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  category_path TEXT NOT NULL,
  dest_dir      TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  options       TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  post_id       TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT,
  status        TEXT NOT NULL,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  discovered_at TEXT NOT NULL,
  crawled_at    TEXT,
  PRIMARY KEY (source_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(source_id, status);

CREATE TABLE IF NOT EXISTS links (
  surl           TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  post_id        TEXT NOT NULL,
  pwd            TEXT,
  title          TEXT,
  status         TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  dest_dir       TEXT,
  created_at     TEXT NOT NULL,
  transferred_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_links_status ON links(source_id, status);
CREATE INDEX IF NOT EXISTS idx_links_post ON links(source_id, post_id);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  source_id   TEXT,
  params      TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL,
  trigger     TEXT NOT NULL DEFAULT 'manual',
  progress    TEXT NOT NULL DEFAULT '{}',
  summary     TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS job_logs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  ts     TEXT NOT NULL,
  level  TEXT NOT NULL,
  msg    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, id);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  kind   TEXT NOT NULL,
  level  TEXT NOT NULL,
  title  TEXT NOT NULL,
  body   TEXT,
  read   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS normalize_plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT,
  dest_dir    TEXT NOT NULL,
  status      TEXT NOT NULL,
  plan        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  executed_at TEXT,
  result      TEXT
);

CREATE TABLE IF NOT EXISTS du_results (
  path       TEXT PRIMARY KEY,
  parent     TEXT NOT NULL,
  name       TEXT NOT NULL,
  is_dir     INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  files      INTEGER NOT NULL DEFAULT 0,
  dirs       INTEGER NOT NULL DEFAULT 0,
  fails      INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_du_parent ON du_results(parent);

-- 网盘清单：转存目录第一层里名称带游戏编号的项（一个名字含多个编号就有多行），用来判断游戏是否已入盘
CREATE TABLE IF NOT EXISTS pan_items (
  source_id  TEXT NOT NULL,
  serial     TEXT NOT NULL,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  is_dir     INTEGER NOT NULL,
  concept_id INTEGER,
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (source_id, serial, name)
);
CREATE INDEX IF NOT EXISTS idx_pan_items_concept ON pan_items(source_id, concept_id);

CREATE TABLE IF NOT EXISTS store_meta (
  concept_id   INTEGER PRIMARY KEY,
  found        INTEGER NOT NULL DEFAULT 0,
  has_cover    INTEGER NOT NULL DEFAULT 0,
  locale       TEXT,
  name         TEXT,
  cover_url    TEXT,
  publisher    TEXT,
  genres       TEXT,
  release_date TEXT,
  description  TEXT,
  fetched_at   INTEGER NOT NULL DEFAULT 0
);
`);

export const one = (sql, ...args) => db.prepare(sql).get(...args);
export const all = (sql, ...args) => db.prepare(sql).all(...args);
export const exec = (sql, ...args) => db.prepare(sql).run(...args);

// 商店信息扩展字段（评分、语言、人数、联机等）；meta_ver 低于当前版本的行会在后台重抓补全
const storeCols = new Set(all('PRAGMA table_info(store_meta)').map(c => c.name));
for (const [col, type] of [
  ['rating', 'REAL'], ['rating_count', 'INTEGER'], ['rating_dist', 'TEXT'],
  ['screen_langs', 'TEXT'], ['spoken_langs', 'TEXT'], ['has_cn_sub', 'INTEGER'], ['has_cn_voice', 'INTEGER'],
  ['platforms', 'TEXT'], ['players', 'INTEGER'], ['online_play', 'TEXT'], ['ps_plus_required', 'INTEGER'],
  ['in_game_purchases', 'INTEGER'], ['classification', 'TEXT'], ['edition', 'TEXT'], ['meta_ver', 'INTEGER NOT NULL DEFAULT 0'],
]) if (!storeCols.has(col)) db.exec(`ALTER TABLE store_meta ADD COLUMN ${col} ${type}`);

const linkCols = new Set(all('PRAGMA table_info(links)').map(c => c.name));
if (!linkCols.has('remark')) db.exec('ALTER TABLE links ADD COLUMN remark TEXT');
if (!linkCols.has('format')) db.exec('ALTER TABLE links ADD COLUMN format TEXT');
// 转存时分享里的顶层文件/目录名（JSON 数组），规整改名前用它在网盘里定位
if (!linkCols.has('saved_names')) db.exec('ALTER TABLE links ADD COLUMN saved_names TEXT');
const postCols = new Set(all('PRAGMA table_info(posts)').map(c => c.name));
if (!postCols.has('serial')) db.exec('ALTER TABLE posts ADD COLUMN serial TEXT');
// 分享里文件名上的编号（站点写的编号有时和实际内容不同），逗号分隔，删除游戏时按需查询并缓存
if (!postCols.has('share_serials')) db.exec('ALTER TABLE posts ADD COLUMN share_serials TEXT');
if (!postCols.has('custom_name')) db.exec('ALTER TABLE posts ADD COLUMN custom_name TEXT');
if (!postCols.has('concept_id')) db.exec('ALTER TABLE posts ADD COLUMN concept_id INTEGER');

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const DEFAULT_SOURCE_ID = '2468c-ps5';

// 首次启动：建默认来源，并导入旧版 state.json / du-report.json
export function migrateLegacy() {
  if (one('SELECT value FROM settings WHERE key = ?', '_migrated')) return null;
  const report = { posts: 0, links: 0, du: 0 };
  let legacyCfg = {};
  try { legacyCfg = JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8')); } catch {}

  tx(() => {
    if (!one('SELECT id FROM sources WHERE id = ?', DEFAULT_SOURCE_ID)) {
      exec(`INSERT INTO sources (id, name, adapter, base_url, category_path, dest_dir, enabled, options, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        DEFAULT_SOURCE_ID, '奥德彪计划 · PS5', 'wp2468c',
        legacyCfg.site || 'https://2468c.com', legacyCfg.category_path || '/ps5game',
        legacyCfg.dest_dir || '/游戏资源/PS5', JSON.stringify({ title_suffix: '-奥德彪计划' }), nowIso());
    }

    const stFile = path.join(STATE_DIR, 'state.json');
    if (fs.existsSync(stFile)) {
      const st = JSON.parse(fs.readFileSync(stFile, 'utf8'));
      const toIso = (s) => {
        if (!s) return nowIso();
        const d = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? new Date(s.replace(' ', 'T') + '+08:00') : new Date(s);
        return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString();
      };
      const insPost = db.prepare(`INSERT OR IGNORE INTO posts (source_id, post_id, url, title, status, discovered_at, crawled_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const [id, p] of Object.entries(st.posts || {})) {
        const at = toIso(p.at);
        insPost.run(DEFAULT_SOURCE_ID, id, p.url, p.title || null, p.status, at, p.status === 'pending_detail' ? null : at);
        report.posts++;
      }
      const titleByPost = new Map();
      const insLink = db.prepare(`INSERT OR IGNORE INTO links (surl, source_id, post_id, pwd, title, status, dest_dir, created_at, transferred_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const [surl, l] of Object.entries(st.links || {})) {
        const at = toIso(l.at);
        const done = l.status !== 'pending';
        insLink.run(surl, DEFAULT_SOURCE_ID, String(l.post), l.pwd || '', l.title || null, l.status,
          done ? (legacyCfg.dest_dir || '/游戏资源/PS5') : null, at, done ? at : null);
        if (l.title) titleByPost.set(String(l.post), l.title);
        report.links++;
      }
      const setTitle = db.prepare('UPDATE posts SET title = ? WHERE source_id = ? AND post_id = ? AND title IS NULL');
      for (const [pid, t] of titleByPost) setTitle.run(t, DEFAULT_SOURCE_ID, pid);
    }

    const duFile = path.join(STATE_DIR, 'du-report.json');
    if (fs.existsSync(duFile)) {
      const du = JSON.parse(fs.readFileSync(duFile, 'utf8'));
      const at = du.at || nowIso();
      for (const [name, r] of Object.entries(du.results || {})) {
        exec(`INSERT OR REPLACE INTO du_results (path, parent, name, is_dir, size, files, dirs, fails, scanned_at)
              VALUES (?, '/', ?, 1, ?, ?, ?, ?, ?)`, '/' + name, name, r.size, r.files || 0, r.dirs || 0, r.fails || 0, at);
        report.du++;
      }
    }
    exec('INSERT INTO settings (key, value) VALUES (?, ?)', '_migrated', JSON.stringify({ at: nowIso(), ...report }));
  });
  return report;
}
