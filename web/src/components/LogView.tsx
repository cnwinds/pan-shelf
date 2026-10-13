import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type LogLine } from '../lib/api';
import { seedLogs, useLiveLogs } from '../lib/live';
import { clock } from '../lib/format';
import { cx } from './ui';

export function LogView({ jobId, className }: { jobId: number; className?: string }) {
  const lines = useLiveLogs(jobId);
  const [filter, setFilter] = useState<'all' | 'warn'>('all');
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    api.get<LogLine[]>(`/jobs/${jobId}/logs?tail=2000`).then(l => seedLogs(jobId, l));
  }, [jobId]);

  useLayoutEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, filter]);

  const shown = filter === 'warn' ? lines.filter(l => l.level !== 'info') : lines;
  const warnCount = lines.filter(l => l.level !== 'info').length;

  return (
    <div className={cx('flex flex-col overflow-hidden rounded-xl bg-shell text-[#D5DAE3]', className)}>
      <div className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5 text-xs">
        <button className={cx('rounded px-2 py-0.5', filter === 'all' ? 'bg-white/12 text-white' : 'text-white/55 hover:text-white')} onClick={() => setFilter('all')}>全部 {lines.length}</button>
        <button className={cx('rounded px-2 py-0.5', filter === 'warn' ? 'bg-white/12 text-white' : 'text-white/55 hover:text-white')} onClick={() => setFilter('warn')}>警告和错误 {warnCount}</button>
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.7]"
        onScroll={e => { const t = e.currentTarget; stick.current = t.scrollHeight - t.scrollTop - t.clientHeight < 40; }}>
        {shown.length === 0 && <div className="py-6 text-center text-white/40">暂无日志</div>}
        {shown.map(l => (
          <div key={l.id} className="flex gap-3 whitespace-pre-wrap break-all">
            <span className="shrink-0 text-white/35">{clock(l.ts)}</span>
            <span className={cx(l.level === 'warn' && 'text-[#F5B85B]', l.level === 'error' && 'text-[#FF8A75]')}>{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
