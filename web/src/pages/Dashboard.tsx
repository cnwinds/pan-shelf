import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Play, Radar, CloudDownload, FolderTree, Clock3, CircleAlert, CircleCheck, Info, TriangleAlert, ArrowRight } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Job, type Overview, type Source } from '../lib/api';
import { useAccount, useOverview, useStartJob, useSettings } from '../lib/hooks';
import { useLiveProgress } from '../lib/live';
import { JobCard } from '../components/JobCard';
import { Bar, Empty, ErrorNote, Field, Modal, PageHeader, Toggle, cx } from '../components/ui';
import { ago, bytes, dateTime } from '../lib/format';

export function Dashboard() {
  const { data: ov, error } = useOverview();
  const [sid, setSid] = useState<string | null>(null);
  const qc = useQueryClient();
  const pipeline = useMutation({
    mutationFn: () => api.post('/pipeline', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['overview'] }),
  });

  if (error) return <ErrorNote error={error} />;
  if (!ov) return <div className="text-muted">加载中…</div>;
  const source = ov.sources.find(s => s.id === sid) || ov.sources.find(s => s.enabled) || ov.sources[0];
  const sourceName = (id: string | null) => ov.sources.find(s => s.id === id)?.name;

  return (
    <>
      <PageHeader
        title="总览"
        desc={ov.schedule_enabled && ov.next_runs[0]
          ? <>下次定时运行：{dateTime(ov.next_runs[0])}。定时运行会依次采集、转存，并生成规整预览。</>
          : '定时运行已关闭，可以在「设置 → 定时运行」里开启。'}
        actions={<button className="btn btn-primary" onClick={() => pipeline.mutate()} disabled={pipeline.isPending}><Play size={14} />立即运行一轮</button>}
      />
      <ErrorNote error={pipeline.error} />

      {ov.sources.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {ov.sources.map(s => (
            <button key={s.id} onClick={() => setSid(s.id)}
              className={cx('rounded-full border px-3 py-1 text-[13px]', s.id === source?.id ? 'border-ink bg-ink text-white' : 'border-line bg-panel hover:border-ink-2', !s.enabled && 'opacity-60')}>
              {s.name}{!s.enabled && '（已停用）'}
            </button>
          ))}
        </div>
      )}

      {source ? <Pipeline ov={ov} source={source} /> : (
        <div className="panel"><Empty title="还没有来源">到「设置 → 采集来源」添加要监控的网站分类。</Empty></div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section>
          <h2 className="mb-3 font-display text-[18px] font-semibold">进行中的任务</h2>
          {ov.active_jobs.length === 0 ? (
            <div className="panel"><Empty title="现在没有任务在运行">点击上方各环节的按钮单独启动，或用「立即运行一轮」跑完整流程。</Empty></div>
          ) : (
            <div className="flex flex-col gap-3">
              {ov.active_jobs.map(j => <JobCard key={j.id} job={j} sourceName={ov.sources.length > 1 ? sourceName(j.source_id) : undefined} />)}
            </div>
          )}
        </section>
        <aside className="flex flex-col gap-6">
          <HealthPanel ov={ov} />
          <EventsPanel ov={ov} />
        </aside>
      </div>
    </>
  );
}

// ---------- 流水线三站 ----------
function Pipeline({ ov, source }: { ov: Overview; source: Source }) {
  const st = source.stats!;
  const active = (type: string) => ov.active_jobs.find(j => j.type === type && j.source_id === source.id);
  const crawlJob = active('crawl') || active('probe');
  const transferJob = active('transfer');
  const normJob = active('normalize_exec') || active('normalize_plan');
  const site = ov.sites.find(s => s.source_id === source.id);
  const [crawlOpen, setCrawlOpen] = useState(false);
  const start = useStartJob();
  const plan = ov.pending_plan && ov.pending_plan.dest_dir === source.dest_dir ? ov.pending_plan : null;
  const lastPlan = ov.last_done.normalize_plan?.source_id === source.id ? ov.last_done.normalize_plan : null;
  const transferred = st.links.saved + st.links.exists;

  return (
    <>
      <div className="grid items-stretch gap-0 md:grid-cols-[1fr_48px_1fr_48px_1fr] max-md:gap-3">
        <Station
          stage="crawl" icon={<Radar size={18} />} title="采集" job={crawlJob}
          big={st.posts.done} of={st.posts.total} unit="个游戏已抓详情"
          lines={[
            st.posts.pending > 0 && { label: '待抓详情', value: st.posts.pending, tone: 'crawl' },
            st.posts.failed > 0 && { label: '抓取失败', value: st.posts.failed, tone: 'bad', to: `/games?view=detail_failed` },
            st.posts.no_link > 0 && { label: '没有网盘链接', value: st.posts.no_link, to: `/games?view=no_link` },
          ]}
          status={site?.blocked
            ? <span className="text-bad">站点疑似封禁：{site.last_error}</span>
            : site?.ok_at ? <>站点正常，{ago(site.ok_at)}访问成功</> : <>本次启动后还未访问站点</>}
          action={<button className="btn btn-sm" onClick={() => setCrawlOpen(true)} disabled={!!crawlJob}><Play size={12} />开始采集</button>}
        />
        <Connector live={!!crawlJob && crawlJob.status === 'running'} color="text-crawl" />
        <Station
          stage="transfer" icon={<CloudDownload size={18} />} title="转存" job={transferJob}
          big={st.games?.in_pan ?? transferred} of={st.games?.with_links ?? st.links.total} unit={st.games ? '个游戏已入盘' : '条链接已入盘'}
          lines={[
            (st.games?.available ?? 0) > 0 && { label: '未入盘（可在游戏库加入）', value: st.games.available, to: '/games?view=available' },
            st.links.pending > 0 && { label: '待转存', value: st.links.pending, tone: 'transfer', to: '/games?view=pending_transfer' },
            st.links.failed > 0 && { label: '转存失败', value: st.links.failed, tone: 'bad', to: '/games?view=transfer_failed' },
            st.links.invalid > 0 && { label: '链接失效', value: st.links.invalid, to: '/games?view=invalid' },
            st.links.skipped > 0 && { label: '已跳过', value: st.links.skipped, to: '/games?view=skipped' },
          ]}
          status={<>转存到 <span className="font-medium text-ink-2">{source.dest_dir}</span></>}
          action={<button className="btn btn-sm" onClick={() => start.mutate({ type: 'transfer', source_id: source.id })} disabled={!!transferJob || st.links.pending === 0}
            title={st.links.pending === 0 ? '没有待转存的链接' : undefined}><Play size={12} />开始转存</button>}
        />
        <Connector live={!!transferJob && transferJob.status === 'running'} color="text-transfer" />
        <Station
          stage="normalize" icon={<FolderTree size={18} />} title="规整" job={normJob}
          big={lastPlan?.summary?.standard ?? 0} unit="个标准 serial 目录"
          lines={[
            !!plan && { label: '等你确认', value: plan.groups, tone: 'normalize', to: '/storage/normalize' },
            !!lastPlan?.summary?.anomalies && { label: '无法推导', value: lastPlan.summary.anomalies, to: '/storage/normalize' },
          ]}
          status={plan ? <>预览生成于 {dateTime(plan.created_at)}</> : lastPlan ? <>{dateTime(lastPlan.finished_at)}检查过，目录已整齐</> : <>还没有检查过目录</>}
          action={
            <div className="flex gap-1.5">
              {plan && <Link to="/storage/normalize" className="btn btn-sm btn-primary">查看预览<ArrowRight size={12} /></Link>}
              <button className="btn btn-sm" onClick={() => start.mutate({ type: 'normalize_plan', source_id: source.id })} disabled={!!normJob}>生成预览</button>
            </div>
          }
        />
      </div>
      <ErrorNote error={start.error} />
      <CrawlDialog open={crawlOpen} onClose={() => setCrawlOpen(false)} source={source} pending={st.posts.pending} />
    </>
  );
}

type Line = { label: string; value: number; tone?: 'crawl' | 'transfer' | 'normalize' | 'bad'; to?: string } | false;

function Station({ stage, icon, title, job, big, of, unit, lines, status, action }: {
  stage: 'crawl' | 'transfer' | 'normalize'; icon: ReactNode; title: string; job?: Job;
  big: number; of?: number; unit: string; lines: Line[]; status: ReactNode; action: ReactNode;
}) {
  const color = { crawl: 'text-crawl', transfer: 'text-transfer', normalize: 'text-normalize' }[stage];
  const barColor = { crawl: 'bg-crawl', transfer: 'bg-transfer', normalize: 'bg-normalize' }[stage];
  const soft = { crawl: 'bg-crawl-soft', transfer: 'bg-transfer-soft', normalize: 'bg-normalize-soft' }[stage];
  return (
    <section className={cx('panel flex flex-col p-5', job && 'ring-2 ring-offset-0', job && { crawl: 'ring-crawl/35', transfer: 'ring-transfer/35', normalize: 'ring-normalize/35' }[stage])}>
      <div className="flex items-center justify-between">
        <div className={cx('flex items-center gap-2 font-display text-[16px] font-semibold', color)}>
          <span className={cx('grid size-8 place-items-center rounded-lg', soft)}>{icon}</span>{title}
        </div>
        {action}
      </div>
      <div className="mt-4 flex items-baseline gap-1.5">
        <span className="num text-[40px] leading-none font-semibold">{big}</span>
        {of != null && <span className="num text-[18px] text-muted">/ {of}</span>}
      </div>
      <div className="mt-1 text-[13px] text-muted">{unit}</div>
      {of != null && of > 0 && <Bar className="mt-3" value={big} max={of} color={barColor} />}

      {lines.some(Boolean) && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
          {lines.filter(Boolean).map(l => {
            const x = l as Exclude<Line, false>;
            const inner = <><span className="text-muted">{x.label}</span> <span className={cx('num text-[15px]', x.tone === 'bad' && 'text-bad', x.tone === 'crawl' && 'text-crawl', x.tone === 'transfer' && 'text-transfer', x.tone === 'normalize' && 'text-normalize')}>{x.value}</span></>;
            return x.to ? <Link key={x.label} to={x.to} className="hover:underline">{inner}</Link> : <span key={x.label}>{inner}</span>;
          })}
        </div>
      )}

      {job && <LiveStrip job={job} color={barColor} />}
      <div className="mt-auto pt-4 text-xs text-muted">{status}</div>
    </section>
  );
}

function LiveStrip({ job, color }: { job: Job; color: string }) {
  const p = useLiveProgress(job);
  return (
    <Link to={`/jobs/${job.id}`} className="mt-4 block rounded-lg bg-paper/70 px-3 py-2 hover:bg-paper">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate text-ink-2">{job.status === 'paused' ? '已暂停' : job.status === 'queued' ? '排队中' : p.current || '进行中'}</span>
        {p.total ? <span className="num shrink-0">{p.done}/{p.total}</span> : null}
      </div>
      <Bar className="mt-1.5" value={p.done || 0} max={p.total || 0} color={color} live={job.status === 'running'} />
    </Link>
  );
}

function Connector({ live, color }: { live: boolean; color: string }) {
  return (
    <div className="flex items-center justify-center max-md:hidden" aria-hidden>
      <div className={cx('h-[3px] w-full rounded-full', live ? cx('track-live', color) : 'bg-line')} />
    </div>
  );
}

function CrawlDialog({ open, onClose, source, pending }: { open: boolean; onClose: () => void; source: Source; pending: number }) {
  const { data } = useSettings();
  const start = useStartJob();
  const [pages, setPages] = useState<number | ''>('');
  const [backlog, setBacklog] = useState(true);
  const [full, setFull] = useState(false);
  const def = data?.settings.crawl;
  const interval = def ? def.detail_interval_sec + def.jitter_sec / 2 : 6;
  const estimate = useMemo(() => {
    const n = (backlog ? pending : 0) + (Number(pages) || def?.list_pages_default || 3);
    return Math.round((n * interval) / 60);
  }, [backlog, pending, pages, def, interval]);

  const submit = () => start.mutate(
    { type: 'crawl', source_id: source.id, params: { ...(full ? { full: true } : pages ? { pages: Number(pages) } : {}), backlog } },
    { onSuccess: onClose },
  );
  return (
    <Modal open={open} onClose={onClose} title="开始采集"
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" onClick={submit} disabled={start.isPending}>开始采集</button></>}>
      <div className="space-y-4">
        <Toggle checked={full} onChange={setFull} label="全量同步：从头翻完所有列表页"
          hint="首次采集会自动全量同步并记住进度，中断后下次接着翻；完成后日常采集只翻最新几页。想重新核对整站时再勾选。" />
        {!full && (
          <Field label="最多翻几页列表" hint={`留空使用默认值 ${def?.list_pages_default ?? 3} 页；连续出现没有新游戏的页面会提前停止。`} unit="页">
            <input className="field w-28" type="number" min={1} max={def?.list_pages_max} value={pages} placeholder={String(def?.list_pages_default ?? 3)}
              onChange={e => setPages(e.target.value ? Number(e.target.value) : '')} />
          </Field>
        )}
        <Toggle checked={backlog} onChange={setBacklog} label={`同时补抓历史缺口（${pending} 个游戏还没抓详情）`}
          hint="关闭后只处理本次列表里新出现的游戏。" />
        <div className="rounded-lg bg-paper px-3 py-2 text-[13px] text-ink-2">
          每次请求间隔约 {interval.toFixed(1)} 秒，{full ? '全量同步每页列表和每个新游戏各请求一次，整站可能要一两个小时' : `预计耗时 ${estimate < 1 ? '不到 1 分钟' : `${estimate} 分钟`}`}。采集中途可以随时暂停或取消。
        </div>
        <ErrorNote error={start.error} />
      </div>
    </Modal>
  );
}

// ---------- 右栏 ----------
function HealthPanel({ ov }: { ov: Overview }) {
  const { data: acc } = useAccount();
  const q = acc?.quota;
  return (
    <section>
      <h2 className="mb-3 font-display text-[18px] font-semibold">状态</h2>
      <div className="panel divide-y divide-line-2 text-[13px]">
        <Row ok={acc?.transfer_login.ok} label="百度网盘登录" value={acc ? (acc.transfer_login.ok ? acc.transfer_login.name : <Link className="underline" to="/settings/account">去扫码登录</Link>) : '…'} />
        <div className="px-4 py-3">
          <div className="flex justify-between"><span className="text-muted">网盘空间</span>{q?.total ? <span><span className="num">{bytes(q.free)}</span> <span className="text-muted">可用</span></span> : <span>…</span>}</div>
          {q?.total ? <Bar className="mt-2" value={q.used} max={q.total} color={q.free < 300 * 1024 ** 3 ? 'bg-bad' : 'bg-ink-2'} /> : null}
          {q?.total ? <div className="mt-1 text-xs text-muted">已用 {bytes(q.used)}，共 {bytes(q.total)}</div> : null}
        </div>
        {ov.sites.map(s => (
          <Row key={s.source_id} ok={s.blocked ? false : s.ok_at ? true : undefined} label={ov.sources.find(x => x.id === s.source_id)?.name || s.host}
            value={s.blocked ? '疑似封禁，定时探测中' : s.ok_at ? `${ago(s.ok_at)}可达` : '未检测'} />
        ))}
      </div>
    </section>
  );
}

function Row({ ok, label, value }: { ok?: boolean; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="flex items-center gap-2 text-muted">
        <span className={cx('size-2 rounded-full', ok === true ? 'bg-ok' : ok === false ? 'bg-bad' : 'bg-line')} />{label}
      </span>
      <span className="truncate text-right">{value}</span>
    </div>
  );
}

function EventsPanel({ ov }: { ov: Overview }) {
  const qc = useQueryClient();
  const readAll = useMutation({ mutationFn: () => api.post('/events/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['overview'] }) });
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-[18px] font-semibold">最近消息</h2>
        {ov.unread_events > 0 && <button className="text-xs text-muted hover:text-ink" onClick={() => readAll.mutate()}>全部标为已读</button>}
      </div>
      <div className="panel divide-y divide-line-2">
        {ov.recent_events.length === 0 && <Empty title="暂无消息" />}
        {ov.recent_events.map(e => {
          const Icon = { error: CircleAlert, warn: TriangleAlert, success: CircleCheck, info: Info }[e.level] || Info;
          const color = { error: 'text-bad', warn: 'text-warn', success: 'text-ok', info: 'text-signal' }[e.level];
          return (
            <div key={e.id} className={cx('flex gap-2.5 px-4 py-3', !e.read && 'bg-signal-soft/40')}>
              <Icon size={15} className={cx('mt-0.5 shrink-0', color)} />
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{e.title}</div>
                {e.body && <div className="mt-0.5 text-xs text-muted">{e.body}</div>}
                <div className="mt-1 flex items-center gap-1 text-[11px] text-muted"><Clock3 size={11} />{dateTime(e.ts)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
