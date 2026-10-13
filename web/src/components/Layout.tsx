import { NavLink, Outlet } from 'react-router-dom';
import { Gauge, Gamepad2, ListTree, HardDrive, SlidersHorizontal, X, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useLive } from '../lib/live';
import { useAccount, useOverview } from '../lib/hooks';
import { bytes } from '../lib/format';
import { Bar, cx } from './ui';

const NAV = [
  { to: '/', label: '总览', icon: Gauge, end: true },
  { to: '/games', label: '游戏库', icon: Gamepad2 },
  { to: '/jobs', label: '任务', icon: ListTree },
  { to: '/storage', label: '网盘', icon: HardDrive },
  { to: '/settings', label: '设置', icon: SlidersHorizontal },
];

export function Layout() {
  const { connected, toasts, dismiss } = useLive();
  const { data: acc } = useAccount();
  const { data: ov } = useOverview();
  const running = ov?.active_jobs.filter(j => j.status === 'running').length || 0;
  const q = acc?.quota;

  return (
    <div className="flex h-full">
      <aside className="sticky top-0 flex h-screen w-[208px] shrink-0 flex-col bg-shell text-white max-md:hidden">
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-6">
          <svg viewBox="0 0 32 32" className="size-7" aria-hidden><rect width="32" height="32" rx="7" fill="#262C38" /><path d="M7 15.5h18M7 24h18" stroke="#6E98FF" strokeWidth="2.2" strokeLinecap="round" /><rect x="9.5" y="8" width="4" height="7.5" rx="1" fill="#6E98FF" /><rect x="15" y="10" width="4" height="5.5" rx="1" fill="#6E98FF" opacity=".6" /><rect x="11" y="18.5" width="4" height="5.5" rx="1" fill="#6E98FF" opacity=".6" /><rect x="17.5" y="17" width="4" height="7" rx="1" fill="#6E98FF" /></svg>
          <div>
            <div className="font-display text-[17px] font-semibold leading-none tracking-tight">盘架</div>
            <div className="mt-1 text-[11px] text-white/45">PanShelf · 游戏按需入盘</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-3">
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] transition-colors',
                isActive ? 'bg-white/10 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white')}>
              <n.icon size={17} strokeWidth={1.8} />
              <span className="flex-1">{n.label}</span>
              {n.to === '/jobs' && running > 0 && <span className="num rounded-full bg-[#6E98FF] px-1.5 text-[11px] leading-[18px] text-shell">{running}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto space-y-3 px-5 pb-5 text-[12px]">
          {q?.total ? (
            <div>
              <div className="mb-1.5 flex justify-between text-white/55"><span>网盘剩余</span><span className="num text-white">{bytes(q.free)}</span></div>
              <Bar value={q.used} max={q.total} color={q.free < 300 * 1024 ** 3 ? 'bg-[#FF8A75]' : 'bg-[#6E98FF]'} className="bg-white/10" />
            </div>
          ) : null}
          <div className="flex items-center gap-2 text-white/55">
            <span className={cx('size-2 rounded-full', connected ? 'bg-[#4FD1A5]' : 'bg-[#FF8A75] pulse')} />
            {connected ? '已连接服务' : '正在重连服务…'}
          </div>
          {acc && (
            <div className="flex items-center gap-2 text-white/55">
              {acc.user?.avatar && <img src={acc.user.avatar} alt="" className="size-5 rounded-full" referrerPolicy="no-referrer" />}
              <span className="truncate">{acc.transfer_login.ok ? acc.transfer_login.name : <span className="text-[#FF8A75]">网盘未登录</span>}</span>
            </div>
          )}
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <nav className="flex gap-1 overflow-x-auto bg-shell px-3 py-2 md:hidden">
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('rounded-md px-3 py-1.5 text-[13px] whitespace-nowrap', isActive ? 'bg-white/12 text-white' : 'text-white/60')}>{n.label}</NavLink>
          ))}
        </nav>
        <main className="mx-auto max-w-[1280px] px-6 py-7 max-md:px-4">
          <Outlet />
        </main>
      </div>

      <div className="fixed right-5 bottom-5 z-40 flex w-[340px] flex-col gap-2" aria-live="polite">
        {toasts.map(t => {
          const Icon = { error: CircleAlert, warn: TriangleAlert, success: CircleCheck, info: Info }[t.level] || Info;
          const color = { error: 'text-bad', warn: 'text-warn', success: 'text-ok', info: 'text-signal' }[t.level];
          return (
            <div key={t.id} className="panel flex gap-3 p-3 shadow-lg">
              <Icon size={18} className={cx('mt-0.5 shrink-0', color)} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{t.title}</div>
                {t.body && <div className="mt-0.5 text-xs text-muted">{t.body}</div>}
              </div>
              <button className="btn btn-ghost btn-sm -mr-1 -mt-1" onClick={() => dismiss(t.id)} aria-label="关闭"><X size={14} /></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
