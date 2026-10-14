import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, ChevronLeft, Folder, Play, Plus, Trash2, Pencil, QrCode, RefreshCw, RotateCcw, Send, Sparkles, TriangleAlert, X } from 'lucide-react';
import { api, type Settings, type Source } from '../lib/api';
import { useAccount, useOverview, useSettings, useSetup, useSources } from '../lib/hooks';
import { ErrorNote, Field, Modal, PageHeader, Toggle, cx } from '../components/ui';
import { duration, bytes } from '../lib/format';

type StepId = 'account' | 'sources' | 'dest';
const REQUIRED: { id: StepId; label: string; title: string }[] = [
  { id: 'account', label: '网盘账号', title: '登录百度网盘' },
  { id: 'sources', label: '采集来源', title: '添加采集来源' },
  { id: 'dest', label: '转存目录', title: '确认转存目录' },
];
const OPTIONAL: { id: keyof Settings; label: string }[] = [
  { id: 'crawl', label: '采集节奏' },
  { id: 'transfer', label: '转存策略' },
  { id: 'normalize', label: '目录规整' },
  { id: 'schedule', label: '定时运行' },
  { id: 'notify', label: '通知' },
];

type Draft = Settings;
type Setter = <K extends keyof Draft>(section: K, patch: Partial<Draft[K]>) => void;

export function SettingsPage() {
  const { tab = 'start' } = useParams();
  const { data } = useSettings();
  const setup = useSetup();
  const [draft, setDraft] = useState<Draft | null>(null);
  const qc = useQueryClient();
  useEffect(() => { if (data && !draft) setDraft(structuredClone(data.settings)); }, [data, draft]);
  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.settings) !== JSON.stringify(draft), [data, draft]);
  const save = useMutation({
    mutationFn: (s: Draft) => api.put<{ settings: Settings }>('/settings', s),
    onSuccess: (r) => { qc.setQueryData(['settings'], { ...data, settings: r.settings }); setDraft(structuredClone(r.settings)); },
  });
  const set: Setter = (section, patch) => setDraft(d => d && ({ ...d, [section]: { ...d[section], ...patch } }));
  const optional = OPTIONAL.find(o => o.id === tab);
  const navCls = (active: boolean) => cx('flex items-center gap-2 rounded-lg px-3 py-2 text-[14px] whitespace-nowrap', active ? 'bg-panel font-medium shadow-[0_0_0_1px_var(--color-line)]' : 'text-ink-2 hover:bg-line-2');

  return (
    <>
      {tab === 'start'
        ? <PageHeader title="设置" />
        : (
          <div className="mb-4 md:hidden">
            <Link to="/settings" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ChevronLeft size={16} />设置</Link>
            <h1 className="mt-1 font-display text-[22px] font-semibold">{[...REQUIRED, ...OPTIONAL].find(t => t.id === tab)?.label}</h1>
          </div>
        )}
      {tab !== 'start' && <div className="max-md:hidden"><PageHeader title="设置" /></div>}
      <div className="grid gap-6 md:grid-cols-[190px_minmax(0,1fr)]">
        <nav className="flex flex-col gap-1 max-md:hidden">
          <Link to="/settings" className={navCls(tab === 'start')}>
            <Sparkles size={14} className="text-signal" />快速开始
            {setup.ready && !setup.done && <span className="num ml-auto rounded-full bg-warn-soft px-1.5 text-[11px] text-warn">{setup.count}/3</span>}
          </Link>
          <div className="mt-3 mb-1 px-3 text-[11px] font-medium tracking-wide text-muted">必需设置</div>
          {REQUIRED.map((t, i) => (
            <Link key={t.id} to={`/settings/${t.id}`} className={navCls(tab === t.id)}>
              <StepDot n={i + 1} done={setup.steps[t.id]} pending={setup.ready} />{t.label}
            </Link>
          ))}
          <div className="mt-3 mb-1 px-3 text-[11px] font-medium tracking-wide text-muted">可选 · 默认即可用</div>
          {OPTIONAL.map(t => (
            <Link key={t.id} to={`/settings/${t.id}`} className={navCls(tab === t.id)}>
              {t.label}
              {data && JSON.stringify(data.settings[t.id]) !== JSON.stringify(data.defaults[t.id]) && <span className="ml-auto size-1.5 rounded-full bg-signal" title="已自定义" />}
            </Link>
          ))}
        </nav>
        <div className="min-w-0 pb-24">
          {tab === 'start' && <SetupGuide />}
          {optional && draft && data && (
            <>
              <OptionalNote
                custom={JSON.stringify(draft[optional.id]) !== JSON.stringify(data.defaults[optional.id])}
                onReset={() => setDraft(d => d && ({ ...d, [optional.id]: structuredClone(data.defaults[optional.id]) }))} />
              {tab === 'crawl' && <CrawlForm d={draft} def={data.defaults} set={set} />}
              {tab === 'transfer' && <TransferForm d={draft} def={data.defaults} set={set} />}
              {tab === 'normalize' && <NormalizeForm d={draft} def={data.defaults} set={set} />}
              {tab === 'schedule' && <ScheduleForm d={draft} set={set} />}
              {tab === 'notify' && <NotifyForm d={draft} set={set} dirty={dirty} />}
            </>
          )}
          {tab === 'account' && <><Account /><StepNext step="account" /></>}
          {tab === 'sources' && <><Sources /><StepNext step="sources" /></>}
          {tab === 'dest' && <><DestDirCard /><StepNext step="dest" /></>}
        </div>
      </div>

      {(dirty || save.error) && (
        <div className="fixed inset-x-0 bottom-[var(--bottom-nav)] z-30 border-t border-line bg-panel/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-[var(--stage-max)] flex-wrap items-center justify-between gap-3 px-[var(--stage-pad)] py-3">
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

function StepDot({ n, done, pending, size = 18 }: { n: number; done: boolean; pending: boolean; size?: number }) {
  return (
    <span className={cx('num grid shrink-0 place-items-center rounded-full text-[11px] font-semibold', done ? 'bg-ok text-white' : pending ? 'bg-warn-soft text-warn' : 'bg-line-2 text-muted')}
      style={{ width: size, height: size }}>
      {done ? <Check size={size * 0.62} strokeWidth={3} /> : n}
    </span>
  );
}

// ---------- 快速开始 ----------
function SetupGuide() {
  const setup = useSetup();
  const { data: settings } = useSettings();
  const nav = useNavigate();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.post('/pipeline', {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['overview'] }); nav('/jobs'); },
  });
  const { acc, sources, steps } = setup;
  const status: Record<StepId, { desc: string; value: ReactNode; action: string }> = {
    account: {
      desc: '用百度网盘 App 扫码。转存、查空间、浏览网盘目录都靠这个登录态，一般能保持几个月。',
      value: steps.account ? <>已登录：{acc?.transfer_login.name}</> : '还没登录',
      action: steps.account ? '查看' : '去扫码登录',
    },
    sources: {
      desc: '告诉盘架去哪个网站分类找游戏。内置了 2468c 的 PS5 / PS4 预设，点一下就能添加。',
      value: steps.sources ? <>已添加 {sources!.length} 个：{sources!.map(s => s.name).join('、')}</> : '还没有来源',
      action: steps.sources ? '管理' : '去添加',
    },
    dest: {
      desc: '游戏转存到网盘的哪个目录。游戏库也按这个目录判断哪些游戏「已入盘」，所以请确认它指向你放游戏的位置。',
      value: steps.sources ? <span className="font-mono">{sources!.map(s => s.dest_dir).join('、')}</span> : '添加来源时设置',
      action: '确认 / 修改',
    },
  };
  const s = settings?.settings;

  return (
    <>
      <section className="panel mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[19px] font-semibold">{setup.done ? '一切就绪' : '三步开始使用盘架'}</h2>
            <p className="mt-1 max-w-[72ch] text-[13px] text-muted">
              {setup.done
                ? '必需设置都已完成，其余设置都有默认值，不改也能正常工作。'
                : '下面三项是必需的，完成后就能采集游戏、转存进网盘。其余设置都有默认值，以后需要再调。'}
            </p>
          </div>
          {setup.ready && <span className="num text-[13px] text-muted">已完成 {setup.count} / 3</span>}
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line-2">
          <div className="h-full rounded-full bg-ok transition-[width] duration-300" style={{ width: `${(setup.count / 3) * 100}%` }} />
        </div>

        <ol className="mt-5 space-y-3">
          {REQUIRED.map((t, i) => {
            const done = steps[t.id];
            const blocked = t.id === 'dest' && !steps.sources;
            const isNext = !done && REQUIRED.findIndex(x => !steps[x.id]) === i;
            return (
              <li key={t.id} className={cx('grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-3 rounded-lg border p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]', isNext ? 'border-signal bg-signal-soft/40' : 'border-line')}>
                <StepDot n={i + 1} done={done} pending={setup.ready} size={26} />
                <div className="min-w-0">
                  <div className="font-medium">{t.title}</div>
                  <p className="mt-0.5 text-[13px] text-muted">{status[t.id].desc}</p>
                  <div className={cx('mt-1.5 text-[13px]', done ? 'text-ok' : 'text-warn')}>{status[t.id].value}</div>
                </div>
                <Link to={blocked ? '/settings/sources' : `/settings/${t.id}`} className={cx('btn btn-sm col-start-2 justify-self-start sm:col-start-3 sm:self-center', isNext && 'btn-primary')}>
                  {blocked ? '先添加来源' : status[t.id].action}<ArrowRight size={12} />
                </Link>
              </li>
            );
          })}
        </ol>

        {setup.done && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-ok-soft px-4 py-3">
            <div className="text-[13px]">
              <div className="font-medium text-ok">可以开始了</div>
              <div className="mt-0.5 text-muted">
                采集会把分类里的游戏收进游戏库，{s?.transfer.auto ? '并自动转存进网盘。' : '只记录信息，不占网盘空间；之后在游戏库挑想要的点「加入网盘」。'}
              </div>
            </div>
            <div className="flex gap-2">
              <Link to="/" className="btn">去游戏库</Link>
              <button className="btn btn-primary" onClick={() => run.mutate()} disabled={run.isPending}><Play size={13} />立即采集一轮</button>
            </div>
          </div>
        )}
        <ErrorNote error={run.error} />
      </section>

      {s && settings && <OptionalOverview s={s} def={settings.defaults} />}
    </>
  );
}

function OptionalOverview({ s, def }: { s: Settings; def: Settings }) {
  const per = s.crawl.detail_interval_sec + s.crawl.jitter_sec / 2;
  const summary: Record<keyof Settings, ReactNode> = {
    crawl: <>约每 {per.toFixed(1)} 秒请求一次站点，避免被封</>,
    transfer: <>{s.transfer.auto ? '采集到新游戏后自动转存' : '手动挑选入盘'}{s.transfer.pick_one ? '，每个游戏只收一个版本' : ''}，保底 {s.transfer.reserve_gb} GB</>,
    normalize: <>{s.normalize.auto_plan_after_transfer ? '转存后自动生成规整预览' : '手动生成规整预览'}，确认后才执行</>,
    schedule: s.schedule.enabled ? <>每天 {s.schedule.times.join('、') || '—'} 自动运行</> : '未开启，需要手动运行',
    notify: <>{[s.notify.toast && '桌面通知', s.notify.webhook_url && 'Webhook'].filter(Boolean).join(' + ') || '只记录在总览页'}</>,
  } as Record<keyof Settings, ReactNode>;
  return (
    <section className="panel p-5">
      <h2 className="font-display text-[17px] font-semibold">可选设置</h2>
      <p className="mt-1 text-[13px] text-muted">都有合理的默认值，不改也能正常工作。下面是当前生效的配置。</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {OPTIONAL.map(o => {
          const custom = JSON.stringify(s[o.id]) !== JSON.stringify(def[o.id]);
          return (
            <Link key={o.id} to={`/settings/${o.id}`} className="group rounded-lg border border-line px-4 py-3 hover:border-signal">
              <div className="flex items-center gap-2 text-[14px] font-medium">
                {o.label}
                <span className={cx('chip text-[11px]', custom ? 'bg-signal-soft text-signal' : 'bg-line-2 text-muted')}>{custom ? '已自定义' : '默认'}</span>
                <ArrowRight size={12} className="ml-auto text-muted group-hover:text-signal" />
              </div>
              <div className="mt-1 text-xs text-muted">{summary[o.id]}</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function OptionalNote({ custom, onReset }: { custom: boolean; onReset: () => void }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-paper px-4 py-2.5 text-[13px] text-muted">
      <span>这一页是可选设置，默认值就能正常工作，按需调整即可。</span>
      {custom && <button className="btn btn-sm" onClick={onReset}><RotateCcw size={12} />本页恢复默认</button>}
    </div>
  );
}

function StepNext({ step }: { step: StepId }) {
  const setup = useSetup();
  if (!setup.ready) return null;
  const i = REQUIRED.findIndex(x => x.id === step);
  const next = REQUIRED[i + 1];
  const done = setup.steps[step];
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-4 py-3 text-[13px]">
      <span className="text-muted">必需设置 第 {i + 1} / 3 步{done ? '，已完成' : ''}</span>
      {next
        ? <Link to={`/settings/${next.id}`} className={cx('btn btn-sm', done && 'btn-primary')}>下一步：{next.title}<ArrowRight size={12} /></Link>
        : <Link to="/settings" className={cx('btn btn-sm', setup.done && 'btn-primary')}>{setup.done ? '完成，开始使用' : '回到快速开始'}<ArrowRight size={12} /></Link>}
    </div>
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
      <Card title="自动转存">
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

function DestDirCard() {
  const { data: sources } = useSources();
  const [editing, setEditing] = useState<Source | null>(null);
  return (
    <section className="panel mb-5 p-5">
      <h2 className="font-display text-[17px] font-semibold">转存根目录</h2>
      <p className="mt-1 max-w-[72ch] text-[13px] text-muted">游戏转存进网盘时放在哪个目录。每个来源各自一个目录，游戏库按这个目录判断哪些游戏已入盘。</p>
      <div className="mt-4 divide-y divide-line-2 rounded-lg border border-line">
        {sources?.map(s => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] text-muted">{s.name}</div>
              <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[13px] text-ink"><Folder size={13} className="shrink-0 text-signal" />{s.dest_dir}</div>
            </div>
            <button className="btn btn-sm" onClick={() => setEditing(s)}><Pencil size={12} />修改</button>
          </div>
        ))}
        {!sources?.length && <div className="px-4 py-3 text-[13px] text-muted">还没有来源。转存目录在添加来源时设置，<Link className="text-signal underline" to="/settings/sources">先去添加来源</Link>。</div>}
      </div>
      {editing && <DestDirDialog source={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function DestDirDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const qc = useQueryClient();
  const [dir, setDir] = useState(source.dest_dir);
  const [browse, setBrowse] = useState(() => source.dest_dir.slice(0, source.dest_dir.lastIndexOf('/')) || '/');
  const [move, setMove] = useState(true);
  const ls = useQuery({
    queryKey: ['storage-ls', browse],
    queryFn: () => api.get<{ rows: { name: string; isdir: boolean; path: string }[] }>(`/storage/ls?path=${encodeURIComponent(browse)}`),
  });
  const save = useMutation({
    mutationFn: () => api.post<{ dest_dir: string; moved: number; skipped: string[] }>(`/sources/${source.id}/dest-dir`, { dest_dir: dir, move }),
    onSuccess: () => ['sources', 'overview', 'games', 'facets', 'du'].forEach(k => qc.invalidateQueries({ queryKey: [k] })),
  });
  const changed = dir.trim().replace(/\/+$/, '') !== source.dest_dir;
  const crumbs = browse.split('/').filter(Boolean);
  const dirs = (ls.data?.rows || []).filter(r => r.isdir);
  const r = save.data;

  return (
    <Modal open onClose={onClose} title={`修改「${source.name}」的转存根目录`} width="max-w-xl"
      footer={r
        ? <button className="btn btn-primary" onClick={onClose}>完成</button>
        : <><button className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending || !changed}>{save.isPending ? (move ? '正在搬移…' : '正在保存…') : '保存'}</button></>}>
      {r ? (
        <div className="space-y-2 text-[13px]">
          <div className="rounded-lg bg-ok-soft px-3 py-2 text-ok">已改为 <span className="font-mono">{r.dest_dir}</span>{r.moved ? `，搬过去 ${r.moved} 项` : ''}</div>
          {r.skipped.length > 0 && (
            <div className="rounded-lg bg-warn-soft px-3 py-2 text-warn">
              新目录里已有同名项，以下 {r.skipped.length} 项留在了原目录 {source.dest_dir}：{r.skipped.slice(0, 8).join('、')}{r.skipped.length > 8 ? ' 等' : ''}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="网盘目录" hint="可以直接输入路径，不存在的目录会自动创建；也可以在下面浏览网盘点选。">
            <input className="field font-mono text-[13px]" value={dir} onChange={e => setDir(e.target.value)} placeholder="/游戏资源/PS5" />
          </Field>

          <div className="rounded-lg border border-line">
            <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2 text-xs">
              <button type="button" className="text-signal hover:underline" onClick={() => setBrowse('/')}>网盘</button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-1">
                  <span className="text-muted">/</span>
                  <button type="button" className="text-signal hover:underline" onClick={() => setBrowse('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button>
                </span>
              ))}
              {browse !== '/' && <button type="button" className="ml-auto btn btn-sm" onClick={() => setDir(browse)}>选用这个目录</button>}
            </div>
            <div className="max-h-56 overflow-y-auto">
              {ls.isLoading && <div className="px-3 py-2 text-xs text-muted">正在读取…</div>}
              {ls.error && <div className="px-3 py-2 text-xs text-bad">{(ls.error as Error).message}</div>}
              {!ls.isLoading && !ls.error && dirs.length === 0 && <div className="px-3 py-2 text-xs text-muted">没有子目录</div>}
              {dirs.map(d => (
                <div key={d.path} className={cx('flex items-center justify-between gap-2 px-3 py-1.5 text-[13px] hover:bg-line-2', d.path === dir && 'bg-signal-soft')}>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setBrowse(d.path)}>
                    <Folder size={13} className="shrink-0 text-signal" /><span className="truncate">{d.name}</span>
                  </button>
                  <button type="button" className="text-xs text-signal hover:underline" onClick={() => setDir(d.path)}>选用</button>
                </div>
              ))}
            </div>
          </div>

          {changed && (
            <div className="space-y-2">
              <Toggle checked={move} onChange={setMove} label={<>把 <span className="font-mono">{source.dest_dir}</span> 里的游戏一起搬到新目录</>}
                hint={move
                  ? '新目录不存在时整体改名，瞬间完成；已存在时逐个移动，同名的会留在原目录，不覆盖。'
                  : '不搬的话，原目录里的游戏在游戏库会显示为「未入盘」，之后转存会放进新目录。'} />
            </div>
          )}
          <ErrorNote error={save.error} />
        </div>
      )}
    </Modal>
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
const PRESETS: { label: string; source: Partial<Source> }[] = [
  { label: '2468c · PS5', source: { id: '2468c-ps5', name: '奥德彪计划 · PS5', adapter: 'wp2468c', base_url: 'https://2468c.com', category_path: '/ps5game', dest_dir: '/游戏资源/PS5', enabled: true, options: { title_suffix: '-奥德彪计划' } } },
  { label: '2468c · PS4', source: { id: '2468c-ps4', name: '奥德彪计划 · PS4', adapter: 'wp2468c', base_url: 'https://2468c.com', category_path: '/ps4game', dest_dir: '/游戏资源/PS4', enabled: true, options: { title_suffix: '-奥德彪计划' } } },
];
const BLANK_SOURCE: Partial<Source> = { adapter: 'wp2468c', enabled: true, options: {} };

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
        <button className={cx('btn', !!sources?.length && 'btn-primary')} onClick={() => setEditing(BLANK_SOURCE)}><Plus size={14} />添加来源</button>
      </div>
      <ErrorNote error={del.error} />
      {sources && !sources.length && (
        <div className="mt-4 rounded-lg border border-signal bg-signal-soft/40 p-4">
          <div className="text-[14px] font-medium">从预设开始</div>
          <p className="mt-0.5 text-[13px] text-muted">选一个预设，确认一下转存目录就能保存；也可以点右上角「添加来源」手动填写。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {PRESETS.map(p => <button key={p.label} className="btn btn-primary btn-sm" onClick={() => setEditing({ ...p.source })}><Plus size={12} />{p.label}</button>)}
          </div>
        </div>
      )}
      <div className={cx('mt-4 divide-y divide-line-2 rounded-lg border border-line', !sources?.length && 'hidden')}>
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
  const { data: sources } = useSources();
  const presets = PRESETS.filter(p => !sources?.some(s => s.id === p.source.id));
  return (
    <Modal open onClose={onClose} title={isNew ? '添加来源' : `编辑「${initial.name}」`} width="max-w-xl"
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>保存</button></>}>
      {isNew && presets.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted">套用预设：</span>
          {presets.map(p => <button key={p.label} type="button" className={cx('btn btn-sm', f.id === p.source.id && 'btn-primary')} onClick={() => setF({ ...p.source })}>{p.label}</button>)}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名称"><input className="field" value={f.name || ''} onChange={e => set({ name: e.target.value })} placeholder="例如：奥德彪计划 · PS4" /></Field>
        <Field label="ID" hint={isNew ? '小写字母、数字和连字符，创建后不能修改' : undefined}><input className="field font-mono" value={f.id || ''} disabled={!isNew} onChange={e => set({ id: e.target.value })} placeholder="2468c-ps4" /></Field>
        <Field label="站点地址"><input className="field" value={f.base_url || ''} onChange={e => set({ base_url: e.target.value })} placeholder="https://2468c.com" /></Field>
        <Field label="分类路径"><input className="field" value={f.category_path || ''} onChange={e => set({ category_path: e.target.value })} placeholder="/ps4game" /></Field>
        <div className="sm:col-span-2">
          {isNew
            ? <Field label="转存到网盘目录" hint="游戏会存进这个目录，游戏库也按它判断哪些已入盘。不存在时会自动创建，以后可在「设置 → 转存目录」修改。"><input className="field" value={f.dest_dir || ''} onChange={e => set({ dest_dir: e.target.value })} placeholder="/游戏资源/PS4" /></Field>
            : <Field label="转存到网盘目录" hint={<>修改请到 <Link className="underline" to="/settings/dest" onClick={onClose}>设置 → 转存目录</Link>，可以把已入盘的游戏一起搬过去</>}><input className="field" value={f.dest_dir || ''} disabled /></Field>}
        </div>
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
  const ls = acc?.login;
  const waiting = ls && ['starting', 'waiting', 'scanned'].includes(ls.status);
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ bduss: '', stoken: '' });
  const saveManual = useMutation({
    mutationFn: () => api.post('/account/login/manual', manual),
    onSuccess: () => { setManual({ bduss: '', stoken: '' }); setManualOpen(false); qc.invalidateQueries({ queryKey: ['account'] }); },
  });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  const left = ls?.expires_at ? Math.max(0, Math.round((Date.parse(ls.expires_at) - now) / 1000)) : 0;

  return (
    <>
      <section className="panel mb-5 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[17px] font-semibold">百度网盘登录</h2>
            <p className="mt-1 max-w-[72ch] text-[13px] text-muted">转存、浏览目录、查空间、删除和规整都使用这一个登录态（保存在 bduss.txt）。用百度网盘 App 扫码即可，一般能保持几个月，失效时会通知你重新扫码。</p>
          </div>
          <button className="btn btn-sm" onClick={() => { setFresh(true); refetch(); }} disabled={isFetching}><RefreshCw size={12} className={cx(isFetching && 'animate-spin')} />重新检查</button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          {acc?.user?.avatar && <img src={acc.user.avatar} alt="" className="size-11 rounded-full" referrerPolicy="no-referrer" />}
          <div className="flex-1">
            {acc?.transfer_login.ok
              ? <><div className="font-medium">{acc.transfer_login.name}</div><div className="text-xs text-ok">登录有效</div></>
              : <><div className="font-medium">未登录</div><div className="text-xs text-bad">转存、目录浏览、删除和规整都无法使用</div></>}
          </div>
          {waiting
            ? <button className="btn" onClick={() => cancel.mutate()}>取消登录</button>
            : <button className={cx('btn', !acc?.transfer_login.ok && 'btn-primary')} onClick={() => login.mutate()} disabled={login.isPending}><QrCode size={14} />{acc?.transfer_login.ok ? '重新扫码登录' : '扫码登录'}</button>}
        </div>
        {waiting && ls?.qrcode_url ? (
          <div className="mt-4 flex flex-wrap items-center gap-5 rounded-lg border border-line bg-shell p-4">
            <div className="relative">
              <img src={ls.qrcode_url} alt="网盘登录二维码" className={cx('size-40 rounded-md bg-white p-2', ls.status === 'scanned' && 'opacity-30')} referrerPolicy="no-referrer" />
              {ls.status === 'scanned' && <div className="absolute inset-0 grid place-items-center text-[13px] font-semibold text-ok">已扫码</div>}
            </div>
            <div className="space-y-2 text-[13px]">
              <div className="flex items-center gap-2 font-medium"><span className="inline-block size-2 rounded-full bg-signal pulse" />{ls.message}</div>
              <div className="text-muted">打开百度网盘 App，点右上角扫一扫。</div>
              <div className="text-xs text-muted">二维码 {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} 后过期</div>
            </div>
          </div>
        ) : ls && ls.status !== 'idle' && (
          <div className={cx('mt-4 rounded-lg px-3 py-2 text-[13px]', ls.status === 'success' ? 'bg-ok-soft text-ok' : ls.status === 'failed' ? 'bg-bad-soft text-bad' : 'bg-signal-soft text-signal')}>
            {waiting && <span className="mr-2 inline-block size-2 rounded-full bg-current pulse" />}{ls.message}
          </div>
        )}
        <ErrorNote error={login.error} />

        <div className="mt-4 border-t border-line pt-3">
          <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => setManualOpen(v => !v)}>
            {manualOpen ? '▾' : '▸'} 扫码不方便？手动填写 BDUSS / STOKEN
          </button>
          {manualOpen && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted">在任意电脑的浏览器登录 pan.baidu.com，按 F12 打开开发者工具 → 应用（Application）→ Cookie → https://pan.baidu.com，复制 BDUSS 和 STOKEN 的值。</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="BDUSS"><input className="field font-mono text-xs" type="password" value={manual.bduss} onChange={e => setManual(m => ({ ...m, bduss: e.target.value }))} autoComplete="off" /></Field>
                <Field label="STOKEN"><input className="field font-mono text-xs" type="password" value={manual.stoken} onChange={e => setManual(m => ({ ...m, stoken: e.target.value }))} autoComplete="off" /></Field>
              </div>
              <button className="btn btn-sm" onClick={() => saveManual.mutate()} disabled={saveManual.isPending || !manual.bduss.trim() || !manual.stoken.trim()}>
                {saveManual.isPending ? '正在校验…' : '校验并保存'}
              </button>
              <ErrorNote error={saveManual.error} />
            </div>
          )}
        </div>
      </section>
    </>
  );
}
