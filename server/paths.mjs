import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_DIR = path.join(ROOT, 'state');
export const DB_FILE = path.join(STATE_DIR, 'ps5watch.db');
export const SITE_COOKIE_JAR = path.join(STATE_DIR, 'site_cookies.txt');
export const BDUSS_FILE = path.join(ROOT, 'bduss.txt');
export const LEGACY_CONFIG = path.join(ROOT, 'config.json');
export const WEB_DIST = path.join(ROOT, 'web', 'dist');
export const SERVER_INFO = path.join(STATE_DIR, 'server.json');

fs.mkdirSync(STATE_DIR, { recursive: true });
