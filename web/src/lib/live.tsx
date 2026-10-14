import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AppEvent, Job, LogLine, Progress } from './api';

// ---------- 进度 / 日志的轻量 store ----------
type Listener = () => void;
class Store<T> {
  map = new Map<number, T>();
  listeners = new Map<number, Set<Listener>>();
  set(id: number, v: T) {
    this.map.set(id, v);
    this.listeners.get(id)?.forEach(l => l());
  }
  sub(id: number, l: Listener) {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id)!.add(l);
    return () => { this.listeners.get(id)?.delete(l); };
  }
}

const progressStore = new Store<Progress>();
const logStore = new Store<LogLine[]>();
const MAX_LOGS = 3000;

export function useLiveProgress(job: Pick<Job, 'id' | 'progress'>): Progress {
  const live = useSyncExternalStore(l => progressStore.sub(job.id, l), () => progressStore.map.get(job.id));
  return live ?? job.progress;
}

export function seedLogs(jobId: number, lines: LogLine[]) {
  const cur = logStore.map.get(jobId) || [];
  const lastId = lines.length ? lines[lines.length - 1].id : 0;
  const merged = [...lines, ...cur.filter(l => l.id > lastId)];
  logStore.set(jobId, merged.slice(-MAX_LOGS));
}

const EMPTY: LogLine[] = [];
export function useLiveLogs(jobId: number) {
  return useSyncExternalStore(l => logStore.sub(jobId, l), () => logStore.map.get(jobId) ?? EMPTY);
}

// ---------- 连接 + 站内提示 ----------
interface LiveCtx { connected: boolean; toasts: AppEvent[]; dismiss: (id: number) => void }
const Ctx = createContext<LiveCtx>({ connected: false, toasts: [], dismiss: () => {} });
export const useLive = () => useContext(Ctx);

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<AppEvent[]>([]);
  const pendingInvalidate = useRef(new Set<string>());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const invalidate = (...keys: string[]) => {
      keys.forEach(k => pendingInvalidate.current.add(k));
      if (timer.current) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const ks = [...pendingInvalidate.current];
        pendingInvalidate.current.clear();
        ks.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      }, 400);
    };

    const es = new EventSource('/api/stream');
    es.onopen = () => { setConnected(true); invalidate('overview', 'jobs', 'job'); };
    es.onerror = () => setConnected(false);
    const on = (type: string, fn: (d: any) => void) => es.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data)));

    let lastStatsRefresh = 0;
    on('progress', (d: { id: number; progress: Progress }) => {
      progressStore.set(d.id, d.progress);
      if (Date.now() - lastStatsRefresh > 3000) { lastStatsRefresh = Date.now(); invalidate('overview', 'games', 'facets', 'du'); }
    });
    on('log', (l: LogLine & { job_id: number }) => {
      const cur = logStore.map.get(l.job_id);
      if (!cur) return; // 还没人打开过这个任务的日志，打开时会从接口加载
      logStore.set(l.job_id, [...cur, l].slice(-MAX_LOGS));
    });
    on('job', (j: Job) => {
      if (j?.progress) progressStore.set(j.id, j.progress);
      qc.setQueryData(['job', j.id], j);
      invalidate('overview', 'jobs', 'games', 'facets', 'plans', 'du');
    });
    on('event', (ev: AppEvent | null) => {
      invalidate('overview', 'events');
      if (ev) {
        setToasts(t => [ev, ...t].slice(0, 4));
        setTimeout(() => setToasts(t => t.filter(x => x.id !== ev.id)), 8000);
      }
    });
    on('site', () => invalidate('overview'));
    on('login', () => invalidate('account'));
    on('account-changed', () => invalidate('account', 'overview'));
    on('settings', () => invalidate('settings', 'overview'));
    on('pan_inventory', () => invalidate('games', 'facets', 'overview', 'game-detail'));
    let metaTimer: number | null = null;
    on('meta', () => {
      invalidate('game-detail');
      if (metaTimer) return;
      metaTimer = window.setTimeout(() => { metaTimer = null; invalidate('games'); }, 2000);
    });
    return () => { es.close(); if (metaTimer) clearTimeout(metaTimer); };
  }, [qc]);

  const dismiss = (id: number) => setToasts(t => t.filter(x => x.id !== id));
  return <Ctx.Provider value={{ connected, toasts, dismiss }}>{children}</Ctx.Provider>;
}
