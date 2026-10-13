import { execFile } from 'node:child_process';
import { exec, one } from './db.mjs';
import { getSettings } from './settings.mjs';
import { nowIso } from './util.mjs';
import { bus } from './bus.mjs';

// kind: run_done | new_games | error | login_expired | quota_low | site_blocked | plan_ready | info
export async function notify(kind, level, title, body = '') {
  const r = exec('INSERT INTO events (ts, kind, level, title, body) VALUES (?, ?, ?, ?, ?)', nowIso(), kind, level, title, body);
  const ev = one('SELECT * FROM events WHERE id = ?', r.lastInsertRowid);
  bus.emit('event', ev);
  const n = getSettings().notify;
  if (!n.on[kind]) return ev;
  if (n.toast) toast(title, body).catch(() => {});
  if (n.webhook_url) webhook(n.webhook_url, n.webhook_format, title, body).catch(() => {});
  return ev;
}

const psEscape = (s) => String(s).replace(/'/g, "''").replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

export function toast(title, body) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${psEscape(title)}</text><text>${psEscape(body).slice(0, 300)}</text></binding></visual></toast>`;
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('${xml}')
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 },
      (err) => err ? reject(err) : resolve());
  });
}

export async function webhook(url, format, title, body) {
  const text = body ? `${title}\n${body}` : title;
  const payload = {
    json: { title, body, source: 'pan-shelf', ts: nowIso() },
    wecom: { msgtype: 'text', text: { content: text } },
    dingtalk: { msgtype: 'text', text: { content: text } },
    feishu: { msg_type: 'text', content: { text } },
  }[format] || { title, body };
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Webhook 返回 HTTP ' + r.status);
}
