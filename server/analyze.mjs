// 安装编排（盘游 docs/adr/0012）：把分享里的文件、说明文件、帖子备注交给大模型，排出主游戏、补丁的叠放顺序、
// 要放进游戏目录的单独文件和要提醒用户的步骤，核对后存进 link_plans，发布资源库时带上。
import crypto from 'node:crypto';
import { all, one, exec } from './db.mjs';
import * as bd from './baidu.mjs';
import { bus } from './bus.mjs';
import { getSettings } from './settings.mjs';
import { libraryLinks } from './library-publish.mjs';
import { recordAlive, recordDead } from './link-check.mjs';
import { linkFormat } from './layout.mjs';
import { nowIso, sleep } from './util.mjs';

const TEMP_ROOT = '/盘游/临时';
const TEXT_RE = /\.(txt|md|nfo|url|ini|json|html?|cfg)$/i;
const ARCHIVE_RE = /\.(rar|zip|7z)$|\.(7z|zip)\.\d{3}$|\.z\d{2}$|\.r\d{2}$/i;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TEXT_FILES = 10;
const MAX_TEXT_CHARS = 8000;
const CHECK_EVERY_MS = 2 * 60_000;

export const analyzeState = { running: false, current: null, at: null, error: null, done: 0, failed: 0 };
let running = null;

const naturalCompare = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });

export function llmReady() {
  const l = getSettings().llm;
  return Boolean(l.enabled && l.base_url && l.model);
}

// 分享内容的指纹：全部文件的路径、大小、md5。分享里的东西变了指纹就变
export function shareSignature(files) {
  const lines = files.map(f => `${f.path}\t${f.size}\t${f.md5 || ''}`).sort();
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}

const storedSignature = (surl) =>
  shareSignature(all('SELECT path, size, md5 FROM share_files WHERE surl = ?', surl));

// 分享里只有一个外包目录时去掉它：盘游转存后也会把它挪掉（0011），编排里的路径按去掉后的写
export function stripWrapper(files) {
  const tops = new Set(files.map(f => f.path.split('/')[0]));
  if (tops.size !== 1 || files.some(f => !f.path.includes('/'))) return files;
  const cut = [...tops][0].length + 1;
  return files.map(f => ({ ...f, path: f.path.slice(cut) }));
}

function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('gbk').decode(buf);
  }
}

// 把分享里的小文本文件转存到临时目录读出来，读完删掉。读不到时返回空数组，不影响分析
async function readTexts(link, files, log) {
  const picked = files.filter(f => TEXT_RE.test(f.path) && f.size > 0 && f.size <= MAX_TEXT_BYTES && f.fs_id).slice(0, MAX_TEXT_FILES);
  if (!picked.length) return [];
  const dir = `${TEMP_ROOT}/${link.surl}`;
  const error = await bd.transferShareFiles(link.surl, link.pwd, picked.map(f => f.fs_id), dir);
  if (error) {
    log(`说明文件没读到：${error}`);
    return [];
  }
  const out = [];
  try {
    const saved = (await bd.listDir(dir)) || [];
    for (const f of picked) {
      const name = f.path.slice(f.path.lastIndexOf('/') + 1);
      const entry = saved.find(e => !e.isdir && e.name === name);
      if (!entry) continue;
      try {
        const text = decodeText(await bd.readSmallBytes(entry.fs_id));
        out.push({ path: f.path, text: text.slice(0, MAX_TEXT_CHARS) });
      } catch (e) {
        log(`读 ${f.path} 失败：${e.message}`);
      }
    }
  } finally {
    await bd.rm([dir]).catch(() => {});
  }
  return out;
}

const SYSTEM = `你在帮一个 PS5 游戏安装器整理网盘分享里的游戏资源。安装器会把压缩包边下载边解压到主机上这款游戏的目录（有 sce_sys 的那层是游戏根目录），然后按你排的顺序叠补丁、放文件。
只回一个 JSON 对象，不要别的文字：
{"main":[序号...],"patches":[{"name":"简短名称","files":[序号...]}],"copies":[{"file":序号,"to":"游戏根目录里的相对路径"}],"notes":["一句话"],"reason":"一句话说明你的判断"}
规则：
- main：主游戏那一组压缩包的全部分卷（.rar / .partN.rar / .r00 / .zip / .z01 / .7z / .7z.001 等）。只能有一组，分卷一个都不能少，即使它们散在不同子目录里。
- patches：按叠放顺序（先装的在前）列出补丁、更新、DLC、backport 等，每组是一个压缩包的全部分卷。跟这款游戏无关的（广告、别的游戏）、PKG 安装包不要放。没有就给空数组。
- copies：不在压缩包里、需要放进游戏目录的单独文件（如 .sprx、.prx、eboot.bin）。to 相对游戏根目录，例如 fakelib/libSceAmpr.sprx；说明里要求覆盖哪个文件就写哪个。说明没要求的不要放。
- notes：只写用户必须在主机上亲手做、安装器做不了的步骤，比如往游戏目录以外的地方放文件、必须用某个挂载工具或版本。每条一句简短中文，没有就给空数组。
  不要写：已经由 main / patches / copies 处理了的事（比如"使用配套的 backport 补丁"）；资源本身的描述（有几种格式、版本号、大小、固件要求）；网站宣传、广告。
- 拿不准的不要编；序号只能用列表里有的。`;

function userPrompt(link, files, texts, remarks, feedback) {
  const size = (n) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const lines = [
    `游戏：${link.name}（${link.title_id}），这条链接的格式：${link.format}`,
    remarks.length ? `帖子里各链接的备注：\n${remarks.map(r => `- ${r}`).join('\n')}` : '',
    `分享里的文件（序号 路径 大小）：\n${files.map((f, i) => `[${i}] ${f.path}  ${size(f.size)}`).join('\n')}`,
    ...texts.map(t => `说明文件 ${t.path} 的内容：\n${t.text}`),
    feedback.length ? `上一版编排装的时候出了问题，请据此修正：\n${feedback.map(f => `- ${f}`).join('\n')}` : '',
  ];
  return lines.filter(Boolean).join('\n\n');
}

// 大文件多的游戏给模型的内容长，flash 一类的模型忙的时候几分钟才回
const LLM_TIMEOUT_SEC = 300;
// 过一会儿再试多半就好的错（超时、网络、限流），分析器会按 RETRY_AFTER_MIN 自动重试
const transient = (message) => Object.assign(new Error(message), { transient: true });
const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timeout|timed out/i.test(String(e?.message || e));

async function chat(messages) {
  const { base_url, api_key, model } = getSettings().llm;
  const url = base_url.replace(/\/+$/, '') + '/chat/completions';
  const send = (json) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(api_key ? { authorization: `Bearer ${api_key}` } : {}) },
    body: JSON.stringify({ model, messages, temperature: 0, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_SEC * 1000),
  });
  let r, j;
  try {
    r = await send(true);
    // 有的接口不认 response_format，去掉再试
    if (r.status === 400) r = await send(false);
    if (!r.ok) {
      const message = `大模型接口返回 HTTP ${r.status}：${(await r.text()).slice(0, 200)}`;
      // 限流、服务端出错过一会儿多半就好了；别的（密钥错、模型名错）再试也一样
      throw Object.assign(new Error(message), { transient: r.status === 429 || r.status >= 500 });
    }
    j = await r.json();
  } catch (e) {
    if (e.transient !== undefined || e instanceof SyntaxError) throw e;
    throw transient(isTimeout(e) ? `大模型接口 ${LLM_TIMEOUT_SEC / 60} 分钟没有回应` : `连不上大模型接口：${e.cause?.code || e.message}`);
  }
  const text = String(j.choices?.[0]?.message?.content || '').trim();
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`大模型回的不是 JSON：${text.slice(0, 200)}`);
  }
}

const safeTarget = (to) => {
  const p = String(to || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || p.length > 200 || /^[a-z]:/i.test(p)) return null;
  const parts = p.split('/');
  if (parts.some(s => !s || s === '.' || s === '..') || parts[0].startsWith('.panplay')) return null;
  return p;
};

// 核对模型的回答，转成资源库里的 plan。不合格时抛错，错误信息会交给模型重来
export function toPlan(answer, files) {
  const used = new Set();
  const pick = (idx, what) => {
    if (!Number.isInteger(idx) || idx < 0 || idx >= files.length) throw new Error(`${what}里的序号 ${idx} 不在列表里`);
    if (used.has(idx)) throw new Error(`序号 ${idx}（${files[idx].path}）用了不止一次`);
    used.add(idx);
    return files[idx];
  };
  const group = (list, what) => {
    if (!Array.isArray(list) || !list.length) throw new Error(`${what}是空的`);
    const out = list.map(i => pick(i, what));
    const bad = out.find(f => !ARCHIVE_RE.test(f.path));
    if (bad) throw new Error(`${what}里的 ${bad.path} 不是压缩包`);
    return out.sort((a, b) => naturalCompare(a.path, b.path)).map(f => ({ path: f.path, size: f.size, md5: f.md5 || '' }));
  };
  const layers = [{ role: 'main', name: '主游戏', files: group(answer?.main, '主游戏') }];
  for (const [n, p] of (Array.isArray(answer?.patches) ? answer.patches : []).entries()) {
    layers.push({ role: 'patch', name: String(p?.name || `补丁 ${n + 1}`).slice(0, 60), files: group(p?.files, `补丁「${p?.name || n + 1}」`) });
  }
  const copies = (Array.isArray(answer?.copies) ? answer.copies : []).map(c => {
    const f = pick(c?.file, '要放的文件');
    const to = safeTarget(c?.to);
    if (!to) throw new Error(`${f.path} 要放的位置「${c?.to}」不是游戏目录里的相对路径`);
    return { from: { path: f.path, size: f.size, md5: f.md5 || '' }, to };
  });
  const notes = (Array.isArray(answer?.notes) ? answer.notes : []).map(n => String(n).trim().slice(0, 200)).filter(Boolean).slice(0, 8);
  return { layers, copies, notes, size: files.reduce((n, f) => n + (f.size || 0), 0), reason: String(answer?.reason || '').slice(0, 300) };
}

function savePlan(surl, fields) {
  const prev = one('SELECT rev FROM link_plans WHERE surl = ?', surl);
  exec(`INSERT INTO link_plans (surl, rev, status, plan, share_sig, model, error, analyzed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(surl) DO UPDATE SET rev = excluded.rev, status = excluded.status, plan = COALESCE(excluded.plan, link_plans.plan),
          share_sig = excluded.share_sig, model = excluded.model, error = excluded.error, analyzed_at = excluded.analyzed_at`,
    surl, fields.rev ?? (prev?.rev || 0), fields.status, fields.plan ?? null, fields.share_sig ?? null, fields.model ?? null, fields.error ?? null, nowIso());
}

// 失败后多久自动再试：超时、网络、限流这类按次数拉长间隔，最多试 MAX_AUTO_RETRIES 次；
// 模型的回答不合格的隔一小时再给一次机会；链接失效、分享是空的不再自动试
const RETRY_AFTER_MIN = [10, 60, 360, 1440];
const MAX_AUTO_RETRIES = 5;
const ANSWER_RETRY_MIN = 60;

export function recordFailure(surl, fields, kind) {
  const count = (one('SELECT fail_count FROM link_plans WHERE surl = ?', surl)?.fail_count || 0) + 1;
  let wait = null;
  if (kind === 'transient' && count <= MAX_AUTO_RETRIES) wait = RETRY_AFTER_MIN[Math.min(count, RETRY_AFTER_MIN.length) - 1];
  if (kind === 'answer' && count < 2) wait = ANSWER_RETRY_MIN;
  const when = wait == null ? '' : wait < 60 ? `${wait} 分钟` : `${wait / 60} 小时`;
  const error = `${fields.error}（第 ${count} 次${wait == null ? (kind === 'final' ? '' : '，不再自动重试') : `，${when}后自动再试`}）`;
  savePlan(surl, { ...fields, status: 'failed', error });
  exec('UPDATE link_plans SET fail_count = ?, retry_at = ? WHERE surl = ?', count,
    wait == null ? null : new Date(Date.now() + wait * 60_000).toISOString(), surl);
}

const readable = (message) => (isTimeout(message) ? '超时' : message);

// 分析一条链接。feedback 是盘游反馈的问题（重新分析时）
export async function analyzeLink(link, { feedback = [], log = console.log } = {}) {
  const r = await bd.listShare(link.surl, link.pwd);
  if (r.error) {
    if (r.invalid) recordDead(link, r.error);
    recordFailure(link.surl, { error: `列分享失败：${readable(r.error)}` }, r.invalid ? 'final' : 'transient');
    return false;
  }
  recordAlive(link, r.files);
  const sig = shareSignature(r.files);
  const files = stripWrapper(r.files).sort((a, b) => naturalCompare(a.path, b.path));
  if (!files.length) {
    recordFailure(link.surl, { share_sig: sig, error: '分享是空的' }, 'final');
    return false;
  }
  const texts = await readTexts(link, files, log);
  const remarks = all('SELECT remark FROM links WHERE source_id = ? AND post_id = ? AND remark IS NOT NULL ORDER BY rowid', link.source_id, link.post_id)
    .map(x => x.remark).filter(Boolean);
  const { model } = getSettings().llm;
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(link, files, texts, remarks, feedback) }];
  let plan = null, lastError = '', kind = 'answer';
  for (let attempt = 0; attempt < 2 && !plan; attempt++) {
    try {
      const answer = await chat(messages);
      try {
        plan = toPlan(answer, files);
      } catch (e) {
        lastError = `大模型的回答不合格：${e.message}`;
        messages.push({ role: 'assistant', content: JSON.stringify(answer) }, { role: 'user', content: `这个回答有问题：${e.message}。请改正后重新给出完整的 JSON。` });
      }
    } catch (e) {
      lastError = e.message;
      kind = e.transient ? 'transient' : e.transient === false ? 'final' : 'answer';
      break;
    }
  }
  if (!plan) {
    recordFailure(link.surl, { share_sig: sig, model, error: lastError }, kind);
    log(`编排分析失败：${link.name} ${link.format}（${lastError}）`);
    return false;
  }
  const rev = (one('SELECT rev FROM link_plans WHERE surl = ?', link.surl)?.rev || 0) + 1;
  const { reason, ...rest } = plan;
  const published = { rev, model, at: Math.floor(Date.now() / 1000), ...rest };
  savePlan(link.surl, { rev, status: 'ok', plan: JSON.stringify(published), share_sig: sig, model, error: null });
  exec('UPDATE link_plans SET fail_count = 0, retry_at = NULL WHERE surl = ?', link.surl);
  exec(`UPDATE feedback SET handled_at = ? WHERE surl = ? AND handled_at IS NULL`, nowIso(), link.surl);
  log(`编排：${link.name} ${link.format} 第 ${rev} 版，主游戏 ${rest.layers[0].files.length} 卷，补丁 ${rest.layers.length - 1} 组，放文件 ${rest.copies.length} 个${reason ? `（${reason}）` : ''}`);
  return true;
}

// 下一条要分析的：盘游反馈过问题的、还没分析过的、失败了到点该重试的、分享变了的
function nextLink(skip) {
  const plans = new Map(all('SELECT surl, status, share_sig, retry_at FROM link_plans').map(p => [p.surl, p]));
  const links = libraryLinks().filter(l => !l.dead && !skip.has(l.surl));
  const queued = links.find(l => plans.get(l.surl)?.status === 'queued');
  if (queued) return queued;
  const fresh = links.find(l => !plans.has(l.surl));
  if (fresh) return fresh;
  const now = nowIso();
  const due = links.find(l => {
    const p = plans.get(l.surl);
    return p?.status === 'failed' && p.retry_at && p.retry_at <= now;
  });
  if (due) return due;
  return links.find(l => {
    const p = plans.get(l.surl);
    if (!p?.share_sig || p.status === 'failed') return false;
    const known = one('SELECT files_at FROM links WHERE surl = ?', l.surl)?.files_at;
    return known && storedSignature(l.surl) !== p.share_sig;
  }) || null;
}

const feedbackOf = (surl) => all(`SELECT kind, detail, device_name FROM feedback WHERE surl = ? AND handled_at IS NULL ORDER BY at`, surl)
  .map(f => `${{ mismatch: '网盘里的文件和编排对不上', install_failed: '照编排安装失败', bad_review: '装好后标了有问题', manual: '用户要求重新分析' }[f.kind] || f.kind}${f.detail ? `：${f.detail}` : ''}`);

export function runAnalyzer() {
  if (running || !llmReady()) return running;
  running = (async () => {
    analyzeState.running = true;
    analyzeState.error = null;
    const skip = new Set();
    try {
      for (let link = nextLink(skip); link && llmReady(); link = nextLink(skip)) {
        skip.add(link.surl);
        analyzeState.current = `${link.name}（${link.format}）`;
        try {
          if (await analyzeLink(link, { feedback: feedbackOf(link.surl) })) analyzeState.done++;
          else analyzeState.failed++;
        } catch (e) {
          analyzeState.failed++;
          analyzeState.error = e.message;
          recordFailure(link.surl, { error: readable(e.message) }, 'transient');
        }
        bus.emit('plans', { surl: link.surl });
        await sleep(getSettings().llm.interval_sec * 1000);
      }
    } finally {
      analyzeState.running = false;
      analyzeState.current = null;
      analyzeState.at = nowIso();
    }
  })().finally(() => { running = null; });
  return running;
}

// 盘游反馈了问题：标成待重新分析，分析器优先处理
export function queueReanalysis(surl) {
  const row = one('SELECT status FROM link_plans WHERE surl = ?', surl);
  if (row) exec(`UPDATE link_plans SET status = 'queued' WHERE surl = ?`, surl);
  else savePlan(surl, { status: 'queued' });
  runAnalyzer();
}

export function analyzeStatus() {
  const counts = Object.fromEntries(all('SELECT status, COUNT(*) n FROM link_plans GROUP BY status').map(r => [r.status, r.n]));
  return {
    ...analyzeState,
    ready: llmReady(),
    ok: counts.ok || 0,
    failed: counts.failed || 0,
    queued: counts.queued || 0,
    total: libraryLinks().filter(l => !l.dead).length,
    recent_errors: all(`SELECT lp.surl, lp.error, lp.analyzed_at FROM link_plans lp WHERE status = 'failed' ORDER BY analyzed_at DESC LIMIT 5`),
  };
}

const planRow = (r) => ({
  surl: r.surl, rev: r.rev, status: r.status, plan: r.plan ? JSON.parse(r.plan) : null,
  error: r.error || null, model: r.model || null, analyzed_at: r.analyzed_at || null,
});

// 游戏详情里列出各条链接的编排
export function plansOfLinks(surls) {
  const out = {};
  for (let i = 0; i < surls.length; i += 500) {
    const chunk = surls.slice(i, i + 500);
    for (const r of all(`SELECT * FROM link_plans WHERE surl IN (${chunk.map(() => '?').join(',')})`, ...chunk)) out[r.surl] = planRow(r);
  }
  return out;
}

// 最近分析过的，网盘页上看成果
export function recentPlans(limit = 30) {
  return all(`SELECT lp.*, l.format, l.remark, l.source_id, l.post_id, p.title, p.custom_name
              FROM link_plans lp JOIN links l ON l.surl = lp.surl
              JOIN posts p ON p.source_id = l.source_id AND p.post_id = l.post_id
              WHERE lp.analyzed_at IS NOT NULL ORDER BY lp.analyzed_at DESC LIMIT ?`, limit)
    .map(r => ({ ...planRow(r), format: linkFormat(r), source_id: r.source_id, post_id: r.post_id, title: r.custom_name || r.title || r.post_id }));
}

// 把失败的都放回去重新分析（换了模型、改了设置之后用）
export function retryFailed() {
  exec(`DELETE FROM link_plans WHERE status = 'failed' AND plan IS NULL`);
  exec(`UPDATE link_plans SET status = 'queued' WHERE status = 'failed'`);
  runAnalyzer();
}

export async function testLlm() {
  const answer = await chat([{ role: 'system', content: '只回 JSON。' }, { role: 'user', content: '回 {"ok":true}' }]);
  return answer?.ok === true;
}

export function startAnalyzer() {
  // 有自动重试之前因为超时失败的，排上重试
  exec(`UPDATE link_plans SET retry_at = ? WHERE status = 'failed' AND retry_at IS NULL AND fail_count = 0 AND error LIKE '%timeout%'`, nowIso());
  setTimeout(runAnalyzer, 90_000);
  setInterval(runAnalyzer, CHECK_EVERY_MS);
  bus.on('links_checked', () => runAnalyzer());
  bus.on('settings', () => runAnalyzer());
}
