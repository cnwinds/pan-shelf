import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { JobStatus, JobType } from '../lib/api';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

// ---------- 状态词表 ----------
export const JOB_STATUS: Record<JobStatus, { label: string; cls: string }> = {
  queued: { label: '排队中', cls: 'bg-line-2 text-ink-2' },
  running: { label: '进行中', cls: 'bg-signal-soft text-signal' },
  paused: { label: '已暂停', cls: 'bg-warn-soft text-warn' },
  done: { label: '完成', cls: 'bg-ok-soft text-ok' },
  failed: { label: '失败', cls: 'bg-bad-soft text-bad' },
  cancelled: { label: '已取消', cls: 'bg-line-2 text-muted' },
  interrupted: { label: '已中断', cls: 'bg-warn-soft text-warn' },
};

export const STAGE: Record<string, { color: string; soft: string; text: string }> = {
  crawl: { color: 'bg-crawl', soft: 'bg-crawl-soft', text: 'text-crawl' },
  probe: { color: 'bg-crawl', soft: 'bg-crawl-soft', text: 'text-crawl' },
  transfer: { color: 'bg-transfer', soft: 'bg-transfer-soft', text: 'text-transfer' },
  prune: { color: 'bg-transfer', soft: 'bg-transfer-soft', text: 'text-transfer' },
  dedupe: { color: 'bg-transfer', soft: 'bg-transfer-soft', text: 'text-transfer' },
  remove: { color: 'bg-bad', soft: 'bg-bad-soft', text: 'text-bad' },
  normalize_plan: { color: 'bg-normalize', soft: 'bg-normalize-soft', text: 'text-normalize' },
  normalize_exec: { color: 'bg-normalize', soft: 'bg-normalize-soft', text: 'text-normalize' },
  du: { color: 'bg-ink-2', soft: 'bg-line-2', text: 'text-ink-2' },
};
export const stageOf = (t: JobType | string) => STAGE[t] || STAGE.du;

export function linkStatus(s: string): { label: string; cls: string } {
  if (s === 'pending') return { label: '待转存', cls: 'bg-transfer-soft text-transfer' };
  if (s === 'available') return { label: '可入盘', cls: 'bg-line-2 text-ink-2' };
  if (s === 'saved') return { label: '已转存', cls: 'bg-ok-soft text-ok' };
  if (s === 'exists') return { label: '盘里已有', cls: 'bg-ok-soft text-ok' };
  if (s === 'invalid') return { label: '链接失效', cls: 'bg-line-2 text-muted' };
  if (s === 'skipped') return { label: '已跳过', cls: 'bg-line-2 text-muted' };
  if (s === 'err_quota') return { label: '空间不足', cls: 'bg-bad-soft text-bad' };
  if (s === 'err_pwd') return { label: '提取码错误', cls: 'bg-bad-soft text-bad' };
  if (s.startsWith('err_') || s === 'exc') return { label: '转存失败', cls: 'bg-bad-soft text-bad' };
  return { label: s, cls: 'bg-line-2 text-ink-2' };
}

export function postStatus(s: string): { label: string; cls: string } {
  return ({
    pending_detail: { label: '待抓详情', cls: 'bg-crawl-soft text-crawl' },
    links_done: { label: '已采集', cls: 'bg-ok-soft text-ok' },
    no_link: { label: '无网盘链接', cls: 'bg-line-2 text-muted' },
    failed: { label: '抓取失败', cls: 'bg-bad-soft text-bad' },
  } as Record<string, { label: string; cls: string }>)[s] || { label: s, cls: 'bg-line-2 text-ink-2' };
}

export function Chip({ cls, children, dot }: { cls: string; children: ReactNode; dot?: boolean }) {
  return <span className={cx('chip', cls)}>{dot && <span className="size-1.5 rounded-full bg-current pulse" />}{children}</span>;
}

export function JobStatusChip({ status }: { status: JobStatus }) {
  const s = JOB_STATUS[status];
  return <Chip cls={s.cls} dot={status === 'running'}>{s.label}</Chip>;
}

export function Bar({ value, max, color = 'bg-signal', live, className }: { value: number; max: number; color?: string; live?: boolean; className?: string }) {
  const p = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={cx('h-1.5 rounded-full bg-line-2 overflow-hidden', className)} role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <div className={cx('h-full rounded-full transition-[width] duration-500', color, live && max === 0 && 'w-1/3 animate-pulse')} style={max > 0 ? { width: `${p}%` } : undefined} />
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start gap-3 cursor-pointer select-none', disabled && 'opacity-50 cursor-not-allowed')}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cx('mt-0.5 relative block h-5 w-9 shrink-0 rounded-full p-0 transition-colors', checked ? 'bg-ink' : 'bg-line')}>
        <span className={cx('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-4' : 'translate-x-0')} />
      </button>
      <span>
        <span className="block text-[13px] font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div className={cx('panel w-full shadow-xl', width)} onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="font-display text-[17px] font-semibold">{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <div className="px-5 pb-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line-2 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, desc, actions }: { title: string; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-[26px] font-semibold leading-tight tracking-tight">{title}</h1>
        {desc && <p className="mt-1 text-[13px] text-muted max-w-[70ch]">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon && <div className="text-muted/70">{icon}</div>}
      <div className="font-medium">{title}</div>
      {children && <div className="text-[13px] text-muted max-w-[46ch]">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">{(error as Error).message || String(error)}</div>;
}

export function Field({ label, hint, children, unit }: { label: ReactNode; hint?: ReactNode; children: ReactNode; unit?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium">{label}</span>
      <span className="flex items-center gap-2">
        {children}
        {unit && <span className="shrink-0 text-xs text-muted">{unit}</span>}
      </span>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}
