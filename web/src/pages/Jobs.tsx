import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, type Job } from '../lib/api';
import { useSources, useStartJob } from '../lib/hooks';
import { useLiveProgress } from '../lib/live';
import { JobCard, COUNTER } from '../components/JobCard';
import { LogView } from '../components/LogView';
import { Bar, Empty, ErrorNote, Field, JobStatusChip, Modal, PageHeader, Toggle, cx, stageOf } from '../components/ui';
import { dateTime, duration } from '../lib/format';

const FILTERS = [
  { id: '', label: '全部' },
  { id: 'queued,running,paused', label: '进行中' },
  { id: 'failed,interrupted', label: '失败或中断' },
  { id: 'done', label: '已完成' },
];

export function Jobs() {
  const { id } = useParams();
  const nav = useNavigate();
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(40);
  const [creating, setCreating] = useState(false);
  const { data: sources } = useSources();
  const list = useQuery({
    queryKey: ['jobs', filter, limit],
    queryFn: () => api.get<{ rows: Job[]; total: number }>(`/jobs?limit=${limit}${filter ? `&status=${filter}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.rows || [];
  const selectedId = id ? Number(id) : rows.find(r => ['running', 'paused'].includes(r.status))?.id ?? rows[0]?.id;
  const sourceName = (sid: string | null) => sources?.find(s => s.id === sid)?.name;

  return (
    <>
      <PageHeader title="任务" desc="采集、转存、规整和用量扫描都以任务形式运行。站点相关的任务永远一个接一个执行，避免请求并发导致 IP 被封。"
        actions={<button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={14} />新建任务</button>} />

      <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div>
          <div className="mb-2 flex flex-wrap gap-1">
            {FILTERS.map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)} className={cx('rounded-md px-2.5 py-1 text-[13px]', filter === f.id ? 'bg-ink text-white' : 'text-ink-2 hover:bg-line-2')}>{f.label}</button>
            ))}
          </div>
          <div className="panel divide-y divide-line-2 overflow-hidden">
            {rows.length === 0 && <Empty title="没有任务" />}
            {rows.map(j => <JobRow key={j.id} job={j} active={j.id === selectedId} sourceName={sources && sources.length > 1 ? sourceName(j.source_id) : undefined} />)}
          </div>
          {list.data && list.data.total > rows.length && (
            <button className="btn btn-sm mt-2 w-full justify-center" onClick={() => setLimit(l => l + 40)}>加载更多（还有 {list.data.total - rows.length} 个）</button>
          )}
        </div>
        <div className="min-w-0">
          {selectedId ? <JobDetail id={selectedId} sourceName={sourceName} /> : <div className="panel"><Empty title="选择左侧的任务查看详情" /></div>}
        </div>
      </div>
      <NewJobDialog open={creating} onClose={() => setCreating(false)} onCreated={j => nav(`/jobs/${j.id}`)} />
    </>
  );
}

function JobRow({ job, active, sourceName }: { job: Job; active: boolean; sourceName?: string }) {
  const p = useLiveProgress(job);
  const st = stageOf(job.type);
  return (
    <Link to={`/jobs/${job.id}`} className={cx('relative block px-4 py-3 hover:bg-paper/60', active && 'bg-paper')}>
      {active && <span className={cx('absolute inset-y-0 left-0 w-[3px]', st.color)} />}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className={cx('size-2 rounded-full', st.color)} />
          <span className="font-medium">{job.label}</span>
          <span className="num text-xs text-muted">#{job.id}</span>
        </span>
        <JobStatusChip status={job.status} />
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span className="truncate">{sourceName ? `${sourceName}，` : ''}{dateTime(job.started_at || job.created_at)}</span>
        {p.total ? <span className="num">{p.done}/{p.total}</span> : null}
      </div>
      {['running', 'paused'].includes(job.status) && <Bar className="mt-2" value={p.done || 0} max={p.total || 0} color={st.color} live={job.status === 'running'} />}
    </Link>
  );
}

function JobDetail({ id, sourceName }: { id: number; sourceName: (s: string | null) => string | undefined }) {
  const { data: job, error } = useQuery({ queryKey: ['job', id], queryFn: () => api.get<Job>(`/jobs/${id}`) });
  if (error) return <ErrorNote error={error} />;
  if (!job) return null;
  const elapsed = job.started_at ? ((job.finished_at ? Date.parse(job.finished_at) : Date.now()) - Date.parse(job.started_at)) / 1000 : null;
  return (
    <div className="flex flex-col gap-4">
      <JobCard job={job} sourceName={sourceName(job.source_id)} />
      {job.error && <div className="rounded-xl bg-bad-soft px-4 py-3 text-[13px] text-bad"><span className="font-medium">失败原因：</span>{job.error}</div>}
      <div className="panel grid grid-cols-2 gap-x-6 gap-y-2 p-4 text-[13px] sm:grid-cols-4">
        <Meta label="创建">{dateTime(job.created_at)}</Meta>
        <Meta label="结束">{dateTime(job.finished_at)}</Meta>
        <Meta label="用时">{elapsed != null ? duration(elapsed) : '-'}</Meta>
        <Meta label="触发方式">{{ manual: '手动', schedule: '定时', auto: '自动', cli: '命令行', probe: '解封探测' }[job.trigger] || job.trigger}</Meta>
        {job.summary && Object.entries(job.summary).filter(([k]) => COUNTER[k] || SUMMARY[k]).map(([k, v]) => (
          <Meta key={k} label={COUNTER[k] || SUMMARY[k]}><span className="num text-[15px]">{String(v)}</span></Meta>
        ))}
        {job.type === 'normalize_plan' && job.summary?.plan_id && <Meta label="预览"><Link className="text-signal hover:underline" to="/storage/normalize">查看规整预览</Link></Meta>}
      </div>
      <LogView jobId={job.id} className="h-[460px]" />
    </div>
  );
}

const SUMMARY: Record<string, string> = { total: '处理总数', pending_left: '剩余待转存', pending_detail: '剩余待抓详情', groups: '待规整目标', anomalies: '无法推导', standard: '标准目录', dirs: '目录数', skipped: '跳过' };

const Meta = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div><div className="text-xs text-muted">{label}</div><div>{children}</div></div>
);

function NewJobDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (j: Job) => void }) {
  const { data: sources } = useSources();
  const start = useStartJob();
  const [type, setType] = useState('crawl');
  const [sid, setSid] = useState('');
  const [pages, setPages] = useState<number | ''>('');
  const [backlog, setBacklog] = useState(true);
  const [path, setPath] = useState('/');
  const [force, setForce] = useState(false);
  const [pruneDry, setPruneDry] = useState(true);
  useEffect(() => { if (!sid && sources?.length) setSid(sources.find(s => s.enabled)?.id || sources[0].id); }, [sources, sid]);

  const types = [
    { id: 'crawl', label: '采集', desc: '翻列表页找新游戏，并抓详情页里的网盘链接' },
    { id: 'transfer', label: '转存', desc: '把待转存的链接存进网盘' },
    { id: 'normalize_plan', label: '规整预览', desc: '分析目标目录，生成改名与合并计划（不会改动网盘）' },
    { id: 'prune', label: '清理排除项', desc: '删除转存目录里命中排除规则的文件和目录（默认是 PKG 版本）' },
    { id: 'dedupe', label: '重复版本清理', desc: '同一游戏转存了多个版本时，只保留按规则选中的那个（exFAT 优先）' },
    { id: 'du', label: '用量扫描', desc: '统计网盘某个目录下各子目录占用的空间' },
    { id: 'probe', label: '站点探测', desc: '请求一次站点首页，检查是否能访问' },
  ];
  const submit = () => {
    const params: Record<string, unknown> =
      type === 'crawl' ? { ...(pages ? { pages } : {}), backlog }
        : type === 'du' ? { path: path.startsWith('/') ? path : '/' + path, force }
          : type === 'prune' || type === 'dedupe' ? { dry: pruneDry } : {};
    start.mutate({ type, source_id: type === 'du' ? null : sid, params }, { onSuccess: (j) => { onClose(); onCreated(j); } });
  };

  return (
    <Modal open={open} onClose={onClose} title="新建任务"
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" onClick={submit} disabled={start.isPending}>开始</button></>}>
      <div className="space-y-4">
        <div className="grid gap-1.5">
          {types.map(t => (
            <label key={t.id} className={cx('flex cursor-pointer gap-3 rounded-lg border px-3 py-2', type === t.id ? 'border-ink bg-paper' : 'border-line hover:border-ink-2')}>
              <input type="radio" name="jobtype" className="mt-1" checked={type === t.id} onChange={() => setType(t.id)} />
              <span><span className="block font-medium">{t.label}</span><span className="text-xs text-muted">{t.desc}</span></span>
            </label>
          ))}
        </div>
        {type !== 'du' && sources && sources.length > 1 && (
          <Field label="来源"><select className="field" value={sid} onChange={e => setSid(e.target.value)}>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        )}
        {type === 'crawl' && (
          <>
            <Field label="最多翻几页列表" hint="留空使用设置里的默认值" unit="页"><input className="field w-28" type="number" min={1} value={pages} onChange={e => setPages(e.target.value ? Number(e.target.value) : '')} /></Field>
            <Toggle checked={backlog} onChange={setBacklog} label="同时补抓历史缺口" />
          </>
        )}
        {(type === 'prune' || type === 'dedupe') && (
          <Toggle checked={pruneDry} onChange={setPruneDry} label="只列出要删的文件，不删除" hint="先看日志里的清单，确认无误后关掉这个开关再跑一次。规则在「设置 → 转存策略」里修改。" />
        )}
        {type === 'du' && (
          <>
            <Field label="扫描目录" hint="统计这个目录下每个子目录的大小"><input className="field" value={path} onChange={e => setPath(e.target.value)} /></Field>
            <Toggle checked={force} onChange={setForce} label="重新扫描已统计过的子目录" hint="默认跳过已有结果，适合中断后续扫" />
          </>
        )}
        <ErrorNote error={start.error} />
      </div>
    </Modal>
  );
}
