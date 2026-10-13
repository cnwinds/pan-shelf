// 体检：账号、配额、站点可达性。百度相关结果缓存 60 秒，避免频繁调用
import * as bd from './baidu.mjs';
import { siteHealth, hostHealth } from './site.mjs';
import { listSources } from './sources.mjs';
import { notify } from './notify.mjs';

const TTL = 60_000;
let cache = { at: 0, data: null };
let lastLoginOk = null;

export async function accountStatus({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < TTL) return cache.data;
  const [who, q, ui] = await Promise.all([
    bd.whoami(),
    bd.quota().catch(e => ({ error: e.message })),
    bd.userInfo().catch(() => null),
  ]);
  const data = {
    transfer_login: who ? { ok: true, ...who } : { ok: false },
    open_token: bd.openTokenInfo(),
    quota: q,
    user: ui,
    checked_at: new Date().toISOString(),
  };
  if (lastLoginOk === true && !data.transfer_login.ok) notify('login_expired', 'error', '百度网盘登录已失效', '请在「设置 → 账号」里重新扫码登录');
  lastLoginOk = data.transfer_login.ok;
  cache = { at: Date.now(), data };
  return data;
}

export const invalidateAccount = () => { cache = { at: 0, data: null }; };

export function sitesStatus() {
  return listSources().map(s => ({ source_id: s.id, base_url: s.base_url, ...hostHealth(s.base_url) }));
}

export { siteHealth };
