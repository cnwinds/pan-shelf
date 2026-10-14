export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch('/api' + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(data?.error || `请求失败（HTTP ${r.status}）`, r.status);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, body: unknown = {}) => request<T>('POST', p, body),
  put: <T>(p: string, body: unknown) => request<T>('PUT', p, body),
  del: <T>(p: string) => request<T>('DELETE', p),
};

// ---------- 类型 ----------
export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export type JobType = 'crawl' | 'transfer' | 'normalize_plan' | 'normalize_exec' | 'du' | 'probe' | 'prune' | 'dedupe' | 'remove';

export interface Progress {
  phase?: string; done?: number; total?: number; current?: string | null;
  rate?: number | null; eta_sec?: number | null; pause_reason?: string | null;
  page?: number; pages?: number;
  counters?: Record<string, number>; counts?: Record<string, number>;
  stats?: Record<string, number>;
  quota?: Quota; free?: number | null;
}

export interface Job {
  id: number; type: JobType; source_id: string | null; params: Record<string, any>;
  status: JobStatus; trigger: string; progress: Progress; summary: Record<string, any> | null;
  error: string | null; created_at: string; started_at: string | null; finished_at: string | null;
  label: string; lane: string;
}

export interface LogLine { id: number; ts: string; level: 'info' | 'warn' | 'error'; msg: string; job_id?: number }

export interface SourceStats {
  posts: { total: number; pending: number; done: number; no_link: number; failed: number };
  links: { total: number; pending: number; available: number; saved: number; exists: number; invalid: number; skipped: number; failed: number };
  games: { in_pan: number; available: number; with_links: number };
}

export interface RemovalPreview {
  post_id: string; title: string | null; serial: string | null; problem: string | null; missing?: boolean;
  targets: { path: string; name: string; isdir: boolean; size: number | null }[];
}

export interface Source {
  id: string; name: string; adapter: string; base_url: string; category_path: string; dest_dir: string;
  enabled: boolean; options: Record<string, string>; created_at: string; stats?: SourceStats;
}

export interface Quota { total: number; used: number; free: number; error?: string }

export interface SiteHealth { source_id: string; base_url: string; host: string; ok_at: string | null; fail_streak: number; blocked: boolean; last_error: string | null; checked_at: string | null }

export interface AppEvent { id: number; ts: string; kind: string; level: 'info' | 'success' | 'warn' | 'error'; title: string; body: string | null; read: number }

export interface Overview {
  sources: Source[]; active_jobs: Job[]; sites: SiteHealth[]; next_runs: string[]; schedule_enabled: boolean;
  unread_events: number; recent_events: AppEvent[];
  pending_plan: { id: number; dest_dir: string; created_at: string; groups: number } | null;
  last_done: Record<string, { id: number; source_id: string | null; finished_at: string; status: JobStatus; summary: Record<string, number> | null } | null>;
}

export interface Account {
  transfer_login: { ok: boolean; uid?: string; name?: string };
  quota: Quota; user: { name: string; avatar: string; vip_type: number } | null;
  checked_at: string; login: LoginState;
}
export interface LoginState {
  status: 'idle' | 'starting' | 'waiting' | 'scanned' | 'success' | 'failed' | 'cancelled';
  message: string;
  at: string | null;
  qrcode_url?: string;
  expires_at?: string;
}
export type PanState = 'in_pan' | 'queued' | 'available' | 'pending_detail' | 'failed' | 'no_link';

export interface GameLink { surl: string; pwd: string; status: string; attempts: number; last_error: string | null; dest_dir: string | null; transferred_at: string | null; remark: string | null; format: 'exfat' | 'folder' | 'pkg' | 'unknown' | null }
export interface Game {
  source_id: string;
  post_id: string;
  url: string;
  title: string | null;
  serial: string | null;
  status: string;
  fail_count: number;
  last_error: string | null;
  discovered_at: string;
  crawled_at: string | null;
  links: GameLink[];
  // Enriched catalog & store metadata fields
  concept_id?: number;
  platform?: 'PS5' | 'PS4' | string;
  region?: string;
  display_name?: string;
  auto_name?: string;
  custom_name?: string;
  cn_title?: string;
  en_title?: string;
  store_name?: string;
  catalog_name?: string;
  cover_url?: string;
  has_cached_cover?: boolean;
  publisher?: string;
  genres?: string;
  release_date?: string;
  description?: string;
  meta_state?: 'ready' | 'pending' | 'missing';
  pan_state?: PanState;
  pan_size?: number | null;
}

export interface Settings {
  crawl: { detail_interval_sec: number; jitter_sec: number; list_pages_default: number; list_pages_max: number; stop_after_empty_pages: number; timeout_sec: number; retries: number; backlog_per_run: number; max_detail_failures: number; block_threshold: number };
  transfer: { auto: boolean; interval_ms: number; timeout_sec: number; reserve_gb: number; quota_check_every: number; max_per_run: number; follow_crawl: boolean; pick_one: boolean; exclude_enabled: boolean; exclude_pattern: string };
  normalize: { serial_prefixes: string; op_interval_ms: number; auto_plan_after_transfer: boolean };
  schedule: { enabled: boolean; times: string[]; steps: string[]; probe_enabled: boolean; probe_interval_min: number };
  notify: { toast: boolean; webhook_url: string; webhook_format: string; on: Record<string, boolean> };
  server: { port: number };
}

export interface PlanStep { op: 'rename' | 'merge' | 'move_file' | 'delete_dup'; from: string; by?: string; move?: string[]; dup?: string[] }
export interface PlanGroup { target: string; target_exists: boolean; steps: PlanStep[] }
export interface NormalizePlan {
  id: number; source_id: string; dest_dir: string; status: string; created_at: string; executed_at: string | null;
  plan: { dest_dir: string; total: number; standard: number; groups: PlanGroup[]; anomalies: { name: string; isdir: boolean; reason: string }[] };
  result: { targets: string[]; results: { target: string; ok: boolean; ops: any[] }[]; counts: Record<string, number> } | null;
}

export interface DuRow { path: string; parent: string; name: string; is_dir: number; size: number; files: number; dirs: number; fails: number; scanned_at: string }
