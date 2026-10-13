import { Link } from 'react-router-dom';
import { Pause, Play, Square, RotateCcw, AlertTriangle } from 'lucide-react';
import type { Job, Progress } from '../lib/api';
import { useLiveProgress } from '../lib/live';
import { useJobAction } from '../lib/hooks';
import { Bar, JobStatusChip, cx, stageOf } from './ui';
import { duration, dateTime } from '../lib/format';

export const PHASE: Record<string, string> = {
  list: '翻列表页', detail: '抓详情页', waiting: '等待采集产出新链接', transfer: '转存中',
  analyze: '分析目录', plan: '生成计划', exec: '执行规整', scan: '扫描目录', probe: '探测站点', done: '已完成',
  prune_scan: '查找排除项', prune_delete: '删除排除项',
  dedupe_index: '索引网盘文件', dedupe_share: '读取分享内容', dedupe_delete: '删除其它版本', remove: '从网盘删除游戏',
};

export const COUNTER: Record<string, string> = {
  list_pages: '列表页', new_posts: '新游戏', crawled: '已抓详情', new_links: '新链接', no_link: '无链接',
  saved: '已转存', exists: '已存在', invalid: '失效', failed: '失败', ok: '成功', partial: '部分失败',
  requests: '请求', scanned_dirs: '已扫目录',
};

export function counterEntries(p: Progress) {
  const c = p.counters || p.counts || p.stats || {};
  return Object.entries(c).filter(([k]) => COUNTER[k]);
}

export function rateText(p: Progress, type: string) {
  if (!p.rate) return null;
  const perMin = p.rate * 60;
  const unit = type === 'crawl' ? '页' : type === 'transfer' ? '条' : '项';
  return perMin >= 1 ? `${perMin.toFixed(perMin < 10 ? 1 : 0)} ${unit}/分钟` : `${(p.rate * 3600).toFixed(0)} ${unit}/小时`;
}

export function JobControls({ job, size = 'sm' }: { job: Job; size?: 'sm' | 'md' }) {
  const act = useJobAction();
  const b = cx('btn', size === 'sm' && 'btn-sm');
  const live = ['running', 'paused', 'queued'].includes(job.status);
  return (
    <div className="flex items-center gap-1.5">
      {job.status === 'running' && <button className={b} onClick={() => act.mutate({ id: job.id, action: 'pause' })} disabled={act.isPending}><Pause size={13} />暂停</button>}
      {job.status === 'paused' && <button className={cx(b, 'btn-primary')} onClick={() => act.mutate({ id: job.id, action: 'resume' })} disabled={act.isPending}><Play size={13} />继续</button>}
      {live && <button className={cx(b, 'btn-danger')} onClick={() => confirm(`确定取消「${job.label}」任务？已完成的部分会保留。`) && act.mutate({ id: job.id, action: 'cancel' })} disabled={act.isPending}><Square size={12} />取消</button>}
      {!live && job.type !== 'normalize_exec' && <button className={b} onClick={() => act.mutate({ id: job.id, action: 'rerun' })} disabled={act.isPending}><RotateCcw size={13} />重新运行</button>}
    </div>
  );
}

export function JobCard({ job, sourceName, compact }: { job: Job; sourceName?: string; compact?: boolean }) {
  const p = useLiveProgress(job);
  const st = stageOf(job.type);
  const total = p.total ?? 0, done = p.done ?? 0;
  const rate = rateText(p, job.type);
  return (
    <div className="panel relative overflow-hidden">
      <div className={cx('absolute inset-y-0 left-0 w-1', st.color)} />
      <div className="p-4 pl-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link to={`/jobs/${job.id}`} className="font-display text-[16px] font-semibold hover:underline">{job.label}</Link>
              <JobStatusChip status={job.status} />
              {job.trigger !== 'manual' && <span className="text-xs text-muted">{{ schedule: '定时', auto: '自动', cli: '命令行', probe: '探测' }[job.trigger] || job.trigger}</span>}
            </div>
            <div className="mt-0.5 text-xs text-muted">{sourceName && <>{sourceName}，</>}{job.status === 'queued' ? `${dateTime(job.created_at)} 加入队列` : `${dateTime(job.started_at)} 开始`}</div>
          </div>
          <JobControls job={job} />
        </div>

        {p.pause_reason && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />{p.pause_reason}
          </div>
        )}

        {job.status !== 'queued' && (
          <>
            <div className="mt-3 flex items-baseline justify-between gap-3">
              <div className="min-w-0 truncate text-[13px] text-ink-2">
                <span className={cx('font-medium', st.text)}>{PHASE[p.phase || ''] || '准备中'}</span>
                {p.phase === 'list' && p.page ? <span className="text-muted">（第 {p.page}/{p.pages} 页）</span> : null}
                {p.current && <span className="text-muted">：{p.current}</span>}
              </div>
              {total > 0 && <div className="num shrink-0 text-[15px]">{done}<span className="text-muted"> / {total}</span></div>}
            </div>
            <Bar className="mt-2" value={done} max={total} color={st.color} live={job.status === 'running'} />
            {!compact && (
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {counterEntries(p).map(([k, v]) => <span key={k}>{COUNTER[k]} <span className="num text-[13px] text-ink">{v}</span></span>)}
                {rate && <span>速度 <span className="text-ink">{rate}</span></span>}
                {p.eta_sec != null && job.status === 'running' && total > done && <span>预计剩余 <span className="text-ink">{duration(p.eta_sec)}</span></span>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
