import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, QrCode, RefreshCw, Send, TriangleAlert, X } from 'lucide-react';
import { api, type Settings, type Source } from '../lib/api';
import { useAccount, useOverview, useSettings, useSources } from '../lib/hooks';
import { ErrorNote, Field, Modal, PageHeader, Toggle, cx } from '../components/ui';
import { dateTime, duration, bytes } from '../lib/format';

const TABS = [
  { id: 'crawl', label: '采集节奏' },
  { id: 'transfer', label: '转存入盘' },
  { id: 'normalize', label: '目录规整' },
  { id: 'schedule', label: '定时运行' },
  { id: 'notify', label: '通知' },
  { id: 'sources', label: '来源' },
  { id: 'account', label: '账号' },
];

type Draft = Settings;
type Setter = <K extends keyof Draft>(section: K, patch: Partial<Draft[K]>) => void;

export function SettingsPage() {
  const { tab = 'crawl' } = useParams();
  const { data } = useSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const qc = useQueryClient();
  useEffect(() => { if (data && !draft) setDraft(structuredClone(data.settings)); }, [data, draft]);
  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.settings) !== JSON.stringify(draft), [data, draft]);
  const save = useMutation({
    mutationFn: (s: Draft) => api.put<{ settings: Settings }>('/settings', s),
    onSuccess: (r) => { qc.setQueryData(['settings'], { ...data, settings: r.settings }); setDraft(structuredClone(r.settings)); },
  });
  const set: Setter = (section, patch) => setDraft(d => d && ({ ...d, [section]: { ...d[section], ...patch } }));
  const isForm = !['sources', 'account'].includes(tab);

  return (
    <>
      <PageHeader title="设置" />
      <div className="grid gap-6 md:grid-cols-[180px_minmax(0,1fr)]">
        <nav className="flex gap-1 md:flex-col max-md:overflow-x-auto">
          {TABS.map(t => (
            <Link key={t.id} to={`/settings/${t.id}`}
              className={cx('rounded-lg px-3 py-2 text-[14px] whitespace-nowrap', tab === t.id ? 'bg-panel font-medium shadow-[0_0_0_1px_var(--color-line)]' : 'text-ink-2 hover:bg-line-2')}>{t.label}</Link>
          ))}
        </nav>
        <div className="min-w-0 pb-24">
          {isForm && draft && data && (
            <>
              {tab === 'crawl' && <CrawlForm d={draft} def={data.defaults} set={set} />}
              {tab === 'transfer' && <TransferForm d={draft} def={data.defaults} set={set} />}
              {tab === 'normalize' && <NormalizeForm d={draft} def={data.defaults} set={set} />}
              {tab === 'schedule' && <ScheduleForm d={draft} set={set} />}
              {tab === 'notify' && <NotifyForm d={draft} set={set} dirty={dirty} />}
            </>
          )}
          {tab === 'sources' && <Sources />}
          {tab === 'account' && <Account />}
        </div>
      </div>

      {(dirty || save.error) && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-[var(--stage-max)] items-center justify-between gap-3 px-[var(--stage-pad)] py-3">
            <div className="text-[13px]">{save.error ? <span className="text-bad">{(save.error as Error).message}</span> : '有未保存的修改，保存后立即生效（进行中的任务从下一步开始使用新参数）'}</div>
            <div className="flex gap-2">
              <button className="btn" onClick={() => { setDraft(structuredClone(data!.settings)); save.reset(); }}>放弃修改</button>
              <button className="btn btn-primary" onClick={() => draft && save.mutate(draft)} disabled={save.isPending}>保存</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Card({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel mb-5 p-5">
      <h2 className="font-display text-[17px] font-semibold">{title}</h2>
      {desc && <p className="mt-1 max-w-[72ch] text-[13px] text-muted">{desc}</p>}
      <div className="mt-4 grid gap-5 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Num({ label, value, onChange, unit, hint, def, step = 1, min, max }: { label: string; value: number; onChange: (v: number) => void; unit?: string; hint?: ReactNode; def?: number; step?: number; min?: number; max?: number }) {
  return (
    <Field label={label} unit={unit} hint={<>{hint}{def !== undefined && value !== def && <> <button type="button" className="underline hover:text-ink" onClick={() => onChange(def)}>恢复默认 {def}</button></>}</>}>
      <input className="field w-32" type="number" step={step} min={min} max={max} value={Number.isFinite(value) ? value : ''} onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
    </Field>
  );
}

// ---------- 采集 ----------
function CrawlForm({ d, def, set }: { d: Draft; def: Draft; set: Setter }) {
  const c = d.crawl, s = (p: Partial<Draft['crawl']>) => set('crawl', p);
  const { data: ov } = useOverview();
  const pending = ov?.sources.reduce((a, x) => a + (x.stats?.posts.pending || 0), 0) || 0;
  const per = c.detail_interval_sec + c.jitter_sec / 2;
  return (
    <>
      <Card title="请求节奏" desc="所有对站点的请求都排成一队，逐个发出。这里控制两次请求之间等多久。">
        <Num label="请求间隔" unit="秒" value={c.detail_interval_sec} onChange={v => s({ detail_interval_sec: v })} def={def.crawl.detail_interval_sec} step={0.5} min={2}
          hint="每个详情页、列表页之间的最小等待时间。" />
        <Num label="随机抖动" unit="秒" value={c.jitter_sec} onChange={v => s({ jitter_sec: v })} def={def.crawl.jitter_sec} step={0.5} min={0}
          hint="在间隔上再随机多等 0 到这么多秒，让节奏不那么机械。" />
        <div className="sm:col-span-2 rounded-lg bg-paper px-4 py-3 text-[13px]">
          平均每个请求约 <b className="num">{per.toFixed(1)}</b> 秒，相当于每小时 <b className="num">{Math.floor(3600 / per)}</b> 个页面。
          {pending > 0 && <> 按这个速度，补抓剩下的 <b className="num">{pending}</b> 个游戏详情大约需要 <b>{duration(pending * per)}</b>。</>}
          {c.detail_interval_sec < 5 && <div className="mt-1.5 flex items-center gap-1.5 text-warn"><TriangleAlert size={14} />间隔低于 5 秒时，2468c 这类站点容易封禁 IP，封禁通常持续 3 小时以上。</div>}
        </div>
      </Card>
      <Card title="列表翻页" desc="每次采集先翻分类列表找新游戏。新游戏都在前几页，一般不需要翻太多。">
        <Num label="默认翻页数" unit="页" value={c.list_pages_default} onChange={v => s({ list_pages_default: v })} def={def.crawl.list_pages_default} min={1} />
        <Num label="最多翻页数" unit="页" value={c.list_pages_max} onChange={v => s({ list_pages_max: v })} def={def.crawl.list_pages_max} min={1} hint="手动指定页数时也不会超过这个值。" />
        <Num label="连续几页没有新游戏就停" unit="页" value={c.stop_after_empty_pages} onChange={v => s({ stop_after_empty_pages: v })} def={def.crawl.stop_after_empty_pages} min={1} />
        <Num label="每次补抓历史缺口上限" unit="个" value={c.backlog_per_run} onChange={v => s({ backlog_per_run: v })} def={def.crawl.backlog_per_run} min={0} hint="0 表示不限。想分几天慢慢补齐时可以设个上限。" />
      </Card>
      <Card title="失败与封禁" desc="请求失败会自动刷新会话并重试；连续失败太多次会判定为被封，采集自动停止，并开始定时探测。">
        <Num label="单个页面重试次数" unit="次" value={c.retries} onChange={v => s({ retries: v })} def={def.crawl.retries} min={1} />
        <Num label="请求超时" unit="秒" value={c.timeout_sec} onChange={v => s({ timeout_sec: v })} def={def.crawl.timeout_sec} min={5} />
        <Num label="单个游戏最多失败几次" unit="次" value={c.max_detail_failures} onChange={v => s({ max_detail_failures: v })} def={def.crawl.max_detail_failures} min={1} hint="超过后标记为「抓取失败」，不再自动补抓，可在游戏库手动重试。" />
        <Num label="连续失败几个页面判定为封禁" unit="个" value={c.block_threshold} onChange={v => s({ block_threshold: v })} def={def.crawl.block_threshold} min={1} />
      </Card>
    </>
  );
}

// ---------- 转存 ----------
function TransferForm({ d, def, set }: { d: Draft; def: Draft; set: Setter }) {
  const t = d.transfer, s = (p: Partial<Draft['transfer']>) => set('transfer', p);
  const { data: acc } = useAccount();
  const free = acc?.quota?.free;
  return (
    <>
      <Card title="自动转存" desc="转存目录在「来源」里按来源分别设置。">
        <div className="sm:col-span-2 space-y-4">
          <Toggle checked={t.auto} onChange={v => s({ auto: v })} label="采集到新游戏后自动存进网盘" hint="关闭（默认）时，采集只把游戏收进游戏库、标记为「未入盘」，不占网盘空间；在游戏库里搜索并点「加入网盘」才会转存。" />
          <Toggle checked={t.follow_crawl} onChange={v => s({ follow_crawl: v })} label="采集进行时，转存边等边存" hint="转存任务不会因为暂时没链接就结束，而是等采集产出新链接后继续，直到采集完成。" />
        </div>
      </Card>
      <ExcludeCard t={t} def={def.transfer} s={s} />
      <Card title="空间保底" desc="网盘剩余空间低于保底线时，转存会自动暂停并通知你。清理空间或调低保底线后，在任务页点「继续」。">
        <Num label="保底剩余空间" unit="GB" value={t.reserve_gb} onChange={v => s({ reserve_gb: v })} def={def.transfer.reserve_gb} min={0}
          hint={free != null ? <>当前剩余 {bytes(free)}，扣除保底后还能转存约 {bytes(Math.max(0, free - t.reserve_gb * 1024 ** 3))}。</> : undefined} />
        <Num label="每转存几条检查一次空间" unit="条" value={t.quota_check_every} onChange={v => s({ quota_check_every: v })} def={def.transfer.quota_check_every} min={1} />
      </Card>
      <Card title="节奏">
        <Num label="两次转存之间的间隔" unit="毫秒" value={t.interval_ms} onChange={v => s({ interval_ms: v })} def={def.transfer.interval_ms} step={100} min={0} />
        <Num label="单次转存超时" unit="秒" value={t.timeout_sec} onChange={v => s({ timeout_sec: v })} def={def.transfer.timeout_sec} min={30} />
        <Num label="每次最多转存" unit="条" value={t.max_per_run} onChange={v => s({ max_per_run: v })} def={def.transfer.max_per_run} min={0} hint="0 表示不限。" />
      </Card>
    </>
  );
}

function ExcludeCard({ t, def, s }: { t: Draft['transfer']; def: Draft['transfer']; s: (p: Partial<Draft['transfer']>) => void }) {
  const [sample, setSample] = useState('PPSA03683-app-pkg.part01.rar');
  let re: RegExp | null = null, err = '';
  try { re = new RegExp(t.exclude_pattern, 'i'); if (re.test('')) err = '这个规则会匹配所有名称'; } catch { err = '不是合法的正则表达式'; }
  const hit = re && !err ? re.test(sample) : null;
  return (
    <>
    <Card title="收录哪个版本" desc="站点常在一个帖子里给出同一游戏的多个版本，每个链接上方的「备注」写着格式和版本号。采集时据此挑选，PKG / FPKG 格式的链接一律不收录。">
      <div className="sm:col-span-2 space-y-4">
        <Toggle checked={t.pick_one} onChange={v => s({ pick_one: v })} label="每个游戏只收录一个版本"
          hint="优先 exFAT，其次文件夹格式，再次未标注格式的；同格式取版本号最高的。其余链接标为「已跳过」，单独补丁 / DLC 链接也会跳过。需要时可在游戏库里对某条链接手动转存。" />
      </div>
    </Card>
    <Card title="转存后清理" desc="百度转存只能整份分享一起存，所以这里是「存完就删」：每次转存有新内容后，删掉目标目录里名称命中规则的文件和目录。命中的目录整个删除，删空的父目录也会一并删掉。删除的内容会进网盘回收站。">
      <div className="sm:col-span-2 space-y-4">
        <Toggle checked={t.exclude_enabled} onChange={v => s({ exclude_enabled: v })} label="转存后自动删除排除项" />
        <Field label="排除规则（正则，不区分大小写）" hint={<>默认匹配独立出现的 pkg / fpkg，例如 <code>xxx-app-pkg.part1.rar</code>、<code>卡卡罗特-FPKG</code>，不会误伤 <code>namespace_pkgs</code> 这类名字。{t.exclude_pattern !== def.exclude_pattern && <button type="button" className="ml-1 underline" onClick={() => s({ exclude_pattern: def.exclude_pattern })}>恢复默认</button>}</>}>
          <input className="field font-mono" value={t.exclude_pattern} onChange={e => s({ exclude_pattern: e.target.value })} />
        </Field>
        <Field label="试一试" hint={err ? <span className="text-bad">{err}</span> : hit ? <span className="text-bad">会被删除</span> : <span className="text-ok">会保留</span>}>
          <input className="field font-mono" value={sample} onChange={e => setSample(e.target.value)} />
        </Field>
      </div>
    </Card>
    </>
  );
}

// ---------- 规整 ----------
function NormalizeForm({ d, def, set }: { d: Draft; def: Draft; set: Setter }) {
  const n = d.normalize, s = (p: Partial<Draft['normalize']>) => set('normalize', p);
  return (
    <Card title="目录规整" desc="把转存进来的目录统一改成 PPSA12345、CUSA12345 这样的 serial 命名，同一游戏的多个目录会合并。规整总是先出预览，你确认后才会动网盘。">
      <div className="sm:col-span-2">
        <Toggle checked={n.auto_plan_after_transfer} onChange={v => s({ auto_plan_after_transfer: v })} label="转存完成后自动生成规整预览" hint="只生成预览并通知你，不会自动执行。" />
      </div>
      <div className="sm:col-span-2">
        <Field label="识别的 serial 前缀" hint={<>用竖线分隔。目录名或文件名里出现「前缀 + 4~6 位数字」就会被识别。{n.serial_prefixes !== def.normalize.serial_prefixes && <button type="button" className="ml-1 underline" onClick={() => s({ serial_prefixes: def.normalize.serial_prefixes })}>恢复默认</button>}</>}>
          <input className="field font-mono" value={n.serial_prefixes} onChange={e => s({ serial_prefixes: e.target.value })} />
        </Field>
      </div>
      <Num label="网盘操作间隔" unit="毫秒" value={n.op_interval_ms} onChange={v => s({ op_interval_ms: v })} def={def.normalize.op_interval_ms} step={100} min={0} hint="每次改名、移动、删除之间的等待。" />
    </Card>
  );
}

// ---------- 定时 ----------
function ScheduleForm({ d, set }: { d: Draft; set: Setter }) {
  const c = d.schedule, s = (p: Partial<Draft['schedule']>) => set('schedule', p);
  const steps = [
    { id: 'crawl', label: '采集', hint: '找新游戏并抓网盘链接' },
    { id: 'transfer', label: '转存', hint: '把待转存的链接存进网盘' },
    { id: 'normalize_plan', label: '生成规整预览', hint: '不会自动执行，生成后通知你确认' },
  ];
  return (
    <>
      <Card title="每日定时运行" desc="控制台服务运行期间，到点会自动跑一轮。服务需要常驻，建议设置为开机自启（见 README）。">
        <div className="sm:col-span-2 space-y-4">
          <Toggle checked={c.enabled} onChange={v => s({ enabled: v })} label="启用定时运行" />
          <div>
            <div className="mb-1.5 text-[13px] font-medium">运行时间</div>
            <div className="flex flex-wrap items-center gap-2">
              {c.times.map((t, i) => (
                <span key={i} className="flex items-center gap-1 rounded-lg border border-line bg-paper py-0.5 pr-1 pl-2">
                  <input type="time" className="bg-transparent text-[13px] outline-none" value={t} onChange={e => s({ times: c.times.map((x, j) => j === i ? e.target.value : x) })} />
                  <button className="btn btn-ghost btn-sm px-1" onClick={() => s({ times: c.times.filter((_, j) => j !== i) })} aria-label="删除"><X size={13} /></button>
                </span>
              ))}
              <button className="btn btn-sm" onClick={() => s({ times: [...c.times, '22:00'] })}><Plus size={12} />添加时间</button>
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">每轮包含的步骤</div>
            <div className="flex flex-col gap-2">
              {steps.map(st => (
                <label key={st.id} className="flex items-start gap-2 text-[13px]">
                  <input type="checkbox" className="mt-1" checked={c.steps.includes(st.id)}
                    onChange={e => s({ steps: e.target.checked ? steps.map(x => x.id).filter(x => x === st.id || c.steps.includes(x)) : c.steps.filter(x => x !== st.id) })} />
                  <span><span className="font-medium">{st.label}</span><span className="ml-2 text-muted">{st.hint}</span></span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Card>
      <Card title="封禁后自动恢复" desc="采集判定站点封禁后，按间隔请求一次首页探测；一旦恢复访问，自动重新开始采集。">
        <div className="sm:col-span-2"><Toggle checked={c.probe_enabled} onChange={v => s({ probe_enabled: v })} label="启用封禁探测" /></div>
        <Num label="探测间隔" unit="分钟" value={c.probe_interval_min} onChange={v => s({ probe_interval_min: v })} min={5} />
      </Card>
    </>
  );
}

// ---------- 通知 ----------
const NOTIFY_EVENTS: { id: string; label: string }[] = [
  { id: 'new_games', label: '发现新游戏' },
  { id: 'run_done', label: '转存或规整完成' },
  { id: 'plan_ready', label: '规整预览待确认' },
  { id: 'quota_low', label: '网盘空间不足' },
  { id: 'site_blocked', label: '站点封禁与恢复' },
  { id: 'login_expired', label: '网盘登录失效' },
  { id: 'error', label: '任务失败' },
];

function NotifyForm({ d, set, dirty }: { d: Draft; set: Setter; dirty: boolean }) {
  const n = d.notify, s = (p: Partial<Draft['notify']>) => set('notify', p);
  const test = useMutation({ mutationFn: () => api.post<Record<string, string>>('/notify/test') });
  return (
    <>
      <Card title="通知方式" desc="所有通知都会记录在总览页的「最近消息」里。下面的方式额外推送到桌面或手机。">
        <div className="sm:col-span-2 space-y-4">
          <Toggle checked={n.toast} onChange={v => s({ toast: v })} label="Windows 桌面通知" hint="在屏幕右下角弹出系统通知。" />
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
            <Field label="Webhook 地址" hint="留空表示不推送。支持企业微信、钉钉、飞书群机器人，或任意接收 JSON 的地址。">
              <input className="field" placeholder="https://" value={n.webhook_url} onChange={e => s({ webhook_url: e.target.value.trim() })} />
            </Field>
            <Field label="消息格式">
              <select className="field" value={n.webhook_format} onChange={e => s({ webhook_format: e.target.value })}>
                <option value="json">通用 JSON</option><option value="wecom">企业微信</option><option value="dingtalk">钉钉</option><option value="feishu">飞书</option>
              </select>
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <button className="btn btn-sm" onClick={() => test.mutate()} disabled={test.isPending || dirty} title={dirty ? '请先保存设置' : undefined}><Send size={12} />发送测试通知</button>
            {dirty && <span className="text-xs text-muted">保存后才能测试</span>}
            {test.data && <span className="text-xs">{Object.entries(test.data).map(([k, v]) => `${k === 'toast' ? '桌面通知' : 'Webhook'}：${v === 'ok' ? '已发送' : v}`).join('；')}</span>}
          </div>
        </div>
      </Card>
      <Card title="推送哪些事件">
        <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
          {NOTIFY_EVENTS.map(e => <Toggle key={e.id} checked={!!n.on[e.id]} onChange={v => s({ on: { ...n.on, [e.id]: v } })} label={e.label} />)}
        </div>
      </Card>
    </>
  );
}

// ---------- 来源 ----------
function Sources() {
  const { data: sources } = useSources();
  const [editing, setEditing] = useState<Partial<Source> | null>(null);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/sources/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sources'] }); qc.invalidateQueries({ queryKey: ['overview'] }); },
  });
  return (
    <section className="panel p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] font-semibold">来源</h2>
          <p className="mt-1 max-w-[72ch] text-[13px] text-muted">每个来源是一个要监控的网站分类，各自有独立的游戏库和转存目录。同一个网站的多个来源共用一条请求队列。</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing({ adapter: 'wp2468c', enabled: true, options: {} })}><Plus size={14} />添加来源</button>
      </div>
      <ErrorNote error={del.error} />
      <div className="mt-4 divide-y divide-line-2 rounded-lg border border-line">
        {sources?.map(s => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><span className="font-medium">{s.name}</span>{!s.enabled && <span className="chip bg-line-2 text-muted">已停用</span>}</div>
              <div className="mt-0.5 text-xs text-muted">{s.base_url}{s.category_path} → 网盘 {s.dest_dir}</div>
              {s.stats && <div className="mt-0.5 text-xs text-muted">{s.stats.posts.total} 个游戏，{s.stats.games?.in_pan ?? s.stats.links.saved + s.stats.links.exists} 个已入盘</div>}
            </div>
            <div className="flex gap-1.5">
              <button className="btn btn-sm" onClick={() => setEditing(s)}><Pencil size={12} />编辑</button>
              <button className="btn btn-sm btn-danger" onClick={() => confirm(`删除来源「${s.name}」？它的游戏和链接记录都会被删除（网盘里的文件不受影响）。`) && del.mutate(s.id)}><Trash2 size={12} />删除</button>
            </div>
          </div>
        ))}
      </div>
      {editing && <SourceDialog initial={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function SourceDialog({ initial, onClose }: { initial: Partial<Source>; onClose: () => void }) {
  const isNew = !initial.created_at;
  const [f, setF] = useState<Partial<Source>>(initial);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => isNew ? api.post('/sources', f) : api.put(`/sources/${f.id}`, f),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sources'] }); qc.invalidateQueries({ queryKey: ['overview'] }); onClose(); },
  });
  const set = (p: Partial<Source>) => setF(x => ({ ...x, ...p }));
  const opt = (k: string, v: string) => setF(x => ({ ...x, options: { ...(x.options || {}), [k]: v } }));
  return (
    <Modal open onClose={onClose} title={isNew ? '添加来源' : `编辑「${initial.name}」`} width="max-w-xl"
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>保存</button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名称"><input className="field" value={f.name || ''} onChange={e => set({ name: e.target.value })} placeholder="例如：奥德彪计划 · PS4" /></Field>
        <Field label="ID" hint={isNew ? '小写字母、数字和连字符，创建后不能修改' : undefined}><input className="field font-mono" value={f.id || ''} disabled={!isNew} onChange={e => set({ id: e.target.value })} placeholder="2468c-ps4" /></Field>
        <Field label="站点地址"><input className="field" value={f.base_url || ''} onChange={e => set({ base_url: e.target.value })} placeholder="https://2468c.com" /></Field>
        <Field label="分类路径"><input className="field" value={f.category_path || ''} onChange={e => set({ category_path: e.target.value })} placeholder="/ps4game" /></Field>
        <div className="sm:col-span-2"><Field label="转存到网盘目录" hint="不存在时会自动创建"><input className="field" value={f.dest_dir || ''} onChange={e => set({ dest_dir: e.target.value })} placeholder="/游戏资源/PS4" /></Field></div>
        <Field label="站点类型">
          <select className="field" value={f.adapter} onChange={e => set({ adapter: e.target.value })}>
            <option value="wp2468c">WordPress 分类（2468c 等）</option>
            <option value="generic">通用（自定义正则）</option>
          </select>
        </Field>
        <div className="flex items-end pb-1"><Toggle checked={f.enabled !== false} onChange={v => set({ enabled: v })} label="启用" hint="停用后不参与定时运行" /></div>
        {f.adapter === 'wp2468c' && (
          <div className="sm:col-span-2"><Field label="标题后缀" hint="从网页标题里去掉的站点名后缀"><input className="field" value={f.options?.title_suffix || ''} onChange={e => opt('title_suffix', e.target.value)} placeholder="-奥德彪计划" /></Field></div>
        )}
        {f.adapter === 'generic' && (
          <>
            <Field label="第 1 页地址模板"><input className="field font-mono text-xs" value={f.options?.first_page_url || ''} onChange={e => opt('first_page_url', e.target.value)} placeholder="{base}{category}" /></Field>
            <Field label="第 N 页地址模板"><input className="field font-mono text-xs" value={f.options?.page_url || ''} onChange={e => opt('page_url', e.target.value)} placeholder="{base}{category}/page/{n}" /></Field>
            <div className="sm:col-span-2"><Field label="帖子地址正则" hint="第一个捕获组作为帖子编号"><input className="field font-mono text-xs" value={f.options?.post_url_regex || ''} onChange={e => opt('post_url_regex', e.target.value)} placeholder={'https?://[^"\'\\s<>]+/(\\d+)\\.html'} /></Field></div>
            <div className="sm:col-span-2"><Field label="标题去除正则"><input className="field font-mono text-xs" value={f.options?.title_strip_regex || ''} onChange={e => opt('title_strip_regex', e.target.value)} placeholder="-站点名" /></Field></div>
          </>
        )}
      </div>
      <div className="mt-4"><ErrorNote error={save.error} /></div>
    </Modal>
  );
}

// ---------- 账号 ----------
function Account() {
  const [fresh, setFresh] = useState(false);
  const { data: acc, refetch, isFetching } = useAccount(fresh);
  const qc = useQueryClient();
  const login = useMutation({ mutationFn: () => api.post('/account/login'), onSuccess: () => qc.invalidateQueries({ queryKey: ['account'] }) });
  const cancel = useMutation({ mutationFn: () => api.post('/account/login/cancel') });
  const refresh = useMutation({ mutationFn: () => api.post('/account/refresh-token'), onSuccess: () => qc.invalidateQueries({ queryKey: ['account'] }) });
  const ls = acc?.login;
  const waiting = ls && ['starting', 'waiting'].includes(ls.status);

  return (
    <>
      <section className="panel mb-5 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[17px] font-semibold">网盘登录（转存用）</h2>
            <p className="mt-1 max-w-[72ch] text-[13px] text-muted">转存、改名、移动、删除直接调用百度网盘接口（基于 bduss.txt 的 BDUSS/STOKEN 登录态）。登录态一般能保持几个月，失效时会通知你。</p>
          </div>
          <button className="btn btn-sm" onClick={() => { setFresh(true); refetch(); }} disabled={isFetching}><RefreshCw size={12} className={cx(isFetching && 'animate-spin')} />重新检查</button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          {acc?.user?.avatar && <img src={acc.user.avatar} alt="" className="size-11 rounded-full" referrerPolicy="no-referrer" />}
          <div className="flex-1">
            {acc?.transfer_login.ok
              ? <><div className="font-medium">{acc.transfer_login.name}</div><div className="text-xs text-ok">登录有效</div></>
              : <><div className="font-medium">未登录</div><div className="text-xs text-bad">转存和规整暂时无法使用</div></>}
          </div>
          {waiting
            ? <button className="btn" onClick={() => cancel.mutate()}>取消登录</button>
            : <button className={cx('btn', !acc?.transfer_login.ok && 'btn-primary')} onClick={() => login.mutate()} disabled={login.isPending}><QrCode size={14} />{acc?.transfer_login.ok ? '重新扫码登录' : '扫码登录'}</button>}
        </div>
        {ls && ls.status !== 'idle' && (
          <div className={cx('mt-4 rounded-lg px-3 py-2 text-[13px]', ls.status === 'success' ? 'bg-ok-soft text-ok' : ls.status === 'failed' ? 'bg-bad-soft text-bad' : 'bg-signal-soft text-signal')}>
            {waiting && <span className="mr-2 inline-block size-2 rounded-full bg-current pulse" />}{ls.message}
          </div>
        )}
        <ErrorNote error={login.error} />
      </section>

      <section className="panel p-5">
        <h2 className="font-display text-[17px] font-semibold">开放平台授权（读取目录用）</h2>
        <p className="mt-1 max-w-[72ch] text-[13px] text-muted">列目录、查空间走百度网盘开放平台接口，授权保存在 bd_open.json。访问令牌 30 天过期，会用刷新令牌自动续期。</p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[13px]">
          {acc?.open_token.configured
            ? <span>访问令牌 {dateTime(acc.open_token.expires_at)} 到期{acc.open_token.can_refresh ? '，到期前自动续期' : '，无法自动续期'}</span>
            : <span className="text-bad">缺少 bd_open.json，目录浏览、空间查询和规整都无法使用</span>}
          {acc?.open_token.can_refresh && <button className="btn btn-sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCw size={12} />立即续期</button>}
        </div>
        <ErrorNote error={refresh.error} />
      </section>
    </>
  );
}
