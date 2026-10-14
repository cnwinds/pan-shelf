import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { X, CircleAlert, CircleCheck, Info, TriangleAlert, Pause, Play, Square } from 'lucide-react';
import { useLive, useLiveProgress } from '../lib/live';
import { useAccount, useJobAction, useOverview } from '../lib/hooks';
import { bytes } from '../lib/format';
import type { Job } from '../lib/api';
import { PHASE } from './JobCard';
import { cx } from './ui';
import { BrandLogo } from './BrandLogo';

export function Layout() {
  const { toasts, dismiss } = useLive();
  const { data: acc } = useAccount();
  const { data: ov } = useOverview();
  const loc = useLocation();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();

  const isLibrary = loc.pathname === '/' || loc.pathname.startsWith('/games');
  const urlQ = isLibrary ? (sp.get('q') || '') : '';
  const [searchText, setSearchText] = useState(urlQ);

  useEffect(() => {
    setSearchText(urlQ);
  }, [urlQ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const trimmed = searchText.trim();
      if (isLibrary) {
        const cur = sp.get('q') || '';
        if (cur !== trimmed) {
          const next = new URLSearchParams(sp);
          if (trimmed) next.set('q', trimmed);
          else next.delete('q');
          next.delete('page');
          setSp(next, { replace: true });
        }
      } else if (trimmed) {
        nav(`/?q=${encodeURIComponent(trimmed)}`);
      }
    }, 240);
    return () => window.clearTimeout(timer);
  }, [searchText]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeJobs = ov?.active_jobs || [];
  const runningCount = activeJobs.filter(j => j.status === 'running' || j.status === 'queued').length;
  const primaryJob = activeJobs.find(j => j.status === 'running') || activeJobs[0];
  const q = acc?.quota;
  const usedRatio = q?.total ? Math.min(100, Math.round((q.used / q.total) * 100)) : 0;
  const lowQuota = q?.free != null && q.free < 300 * 1024 ** 3;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bar">
        <div className="bar-inner">
          <Link to="/" className="mark" title="盘架 PanShelf · PS5/PS4 网盘游戏库管理">
            <BrandLogo />
            <span className="mark-text">
              <strong>盘架</strong>
              <small>PanShelf</small>
            </span>
          </Link>

          <label className="find" aria-label="搜索游戏">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M8.5 3a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Zm4.4 9.8 3.6 3.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <input
              type="search"
              placeholder="搜索游戏名或 Title ID"
              autoComplete="off"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
            />
            {searchText && (
              <button
                type="button"
                className="find-clear"
                aria-label="清空搜索"
                onClick={() => setSearchText('')}
              >
                ×
              </button>
            )}
          </label>

          <div className="bar-right">
            {q?.total ? (
              <Link to="/storage" className="quota-pill" title={`已用 ${bytes(q.used)} / 共 ${bytes(q.total)}`}>
                <span>网盘剩余</span>
                <strong className={cx(lowQuota && 'text-[#ff8a7a]!')}>{bytes(q.free)}</strong>
                <span className={cx('quota-mini-bar', lowQuota && 'low')}>
                  <span style={{ width: `${usedRatio}%` }} />
                </span>
              </Link>
            ) : acc && !acc.transfer_login.ok ? (
              <Link to="/settings/account" className="quota-pill text-[#ff8a7a]!">
                网盘未登录
              </Link>
            ) : null}

            <nav className="tabs" aria-label="主导航">
              <NavLink to="/" end className={() => cx(isLibrary && 'active')}>
                游戏库
              </NavLink>
              <NavLink to="/storage" className={({ isActive }) => cx(isActive && 'active')}>
                网盘
              </NavLink>
              <NavLink to="/jobs" className={({ isActive }) => cx(isActive && 'active')}>
                任务
                {runningCount > 0 && (
                  <span className="num rounded-full bg-[#4d8bff] px-1.5 text-[11px] leading-[17px] text-white">
                    {runningCount}
                  </span>
                )}
              </NavLink>
              <NavLink to="/overview" className={({ isActive }) => cx(isActive && 'active')}>
                总览
              </NavLink>
              <NavLink to="/settings" className={({ isActive }) => cx(isActive && 'active')}>
                设置
              </NavLink>
            </nav>
          </div>
        </div>
      </header>

      <main className="stage flex-1 w-full">
        <Outlet />
      </main>

      {primaryJob && <ActiveJobDock job={primaryJob} queueCount={activeJobs.length} />}

      <div className="fixed right-5 bottom-5 z-40 flex w-[340px] flex-col gap-2" aria-live="polite">
        {toasts.map(t => {
          const Icon = { error: CircleAlert, warn: TriangleAlert, success: CircleCheck, info: Info }[t.level] || Info;
          const color = { error: 'text-bad', warn: 'text-warn', success: 'text-ok', info: 'text-signal' }[t.level];
          return (
            <div key={t.id} className="panel flex gap-3 p-3 shadow-2xl">
              <Icon size={18} className={cx('mt-0.5 shrink-0', color)} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{t.title}</div>
                {t.body && <div className="mt-0.5 text-xs text-muted">{t.body}</div>}
              </div>
              <button className="btn btn-ghost btn-sm -mr-1 -mt-1" onClick={() => dismiss(t.id)} aria-label="关闭">
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActiveJobDock({ job, queueCount }: { job: Job; queueCount: number }) {
  const p = useLiveProgress(job);
  const act = useJobAction();
  const done = p.done ?? 0;
  const total = p.total ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const phaseLabel = PHASE[p.phase || ''] || job.label;

  return (
    <aside className="dock" aria-live="polite">
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3 text-[13px]">
          <Link to={`/jobs/${job.id}`} className="truncate font-semibold hover:underline">
            {job.label} · {phaseLabel}
            {p.current ? <span className="ml-1.5 font-normal text-muted">{p.current}</span> : null}
          </Link>
          <span className="num shrink-0 text-xs text-muted">
            {total > 0 ? `${done} / ${total} (${pct}%)` : job.status === 'paused' ? '已暂停' : '运行中'}
            {queueCount > 1 ? ` · 共 ${queueCount} 项任务` : ''}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#131a27]">
          <div
            className={cx(
              'h-full rounded-full bg-[#4d8bff] transition-[width] duration-300',
              job.status === 'running' && total === 0 && 'w-1/3 animate-pulse'
            )}
            style={total > 0 ? { width: `${pct}%` } : undefined}
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {job.status === 'running' && (
          <button
            className="btn btn-sm"
            onClick={() => act.mutate({ id: job.id, action: 'pause' })}
            disabled={act.isPending}
            title="暂停任务"
          >
            <Pause size={12} />暂停
          </button>
        )}
        {job.status === 'paused' && (
          <button
            className="btn btn-sm btn-primary"
            onClick={() => act.mutate({ id: job.id, action: 'resume' })}
            disabled={act.isPending}
            title="继续任务"
          >
            <Play size={12} />继续
          </button>
        )}
        <button
          className="btn btn-sm btn-danger"
          onClick={() => confirm(`确定取消「${job.label}」任务？`) && act.mutate({ id: job.id, action: 'cancel' })}
          disabled={act.isPending}
          title="取消任务"
        >
          <Square size={11} />取消
        </button>
      </div>
    </aside>
  );
}
