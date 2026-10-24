import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Folder, File, ScanSearch, RefreshCw, FolderInput, Merge, Trash2, PencilLine, CircleCheck, CircleAlert, FolderTree } from 'lucide-react';
import { api, type DuRow, type InPanBadGame, type NormalizePlan, type ReviewStatus, type Source } from '../lib/api';
import { RemoveDialog } from './Games';
import { useAccount, useOverview, useSources, useStartJob } from '../lib/hooks';
import { JobCard } from '../components/JobCard';
import { Bar, Chip, Empty, ErrorNote, PageHeader, cx } from '../components/ui';
import { bytes, dateTime } from '../lib/format';

export function Storage() {
  const { tab = 'usage' } = useParams();
  return (
    <>
      <PageHeader title="网盘" desc="查看网盘空间都用在了哪里，并把转存进来的游戏目录整理成统一的 serial 命名。" />
      <div className="mb-5 flex gap-1 border-b border-line">
        {[{ id: 'usage', label: '空间与用量' }, { id: 'normalize', label: '目录规整' }].map(t => (
          <Link key={t.id} to={`/storage/${t.id === 'usage' ? '' : t.id}`}
            className={cx('-mb-px border-b-2 px-3 pb-2 text-[14px]', tab === t.id ? 'border-ink font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}>{t.label}</Link>
        ))}
      </div>
      {tab === 'normalize' ? <Normalize /> : <Usage />}
    </>
  );
}

// ---------- 用量 ----------
function Usage() {
  const [sp, setSp] = useSearchParams();
  const path = sp.get('path') || '/';
  const { data: acc } = useAccount();
  const { data: ov } = useOverview();
  const start = useStartJob();
  const du = useQuery({ queryKey: ['du', path], queryFn: () => api.get<{ rows: DuRow[]; total: number; scanned_at: string }>(`/storage/du?path=${encodeURIComponent(path)}`) });
  const q = acc?.quota;
  const job = ov?.active_jobs.find(j => j.type === 'du');
  const rows = du.data?.rows || [];
  const max = Math.max(1, ...rows.map(r => r.size));
  const crumbs = path === '/' ? [] : path.split('/').filter(Boolean);
  const go = (p: string) => setSp(p === '/' ? {} : { path: p });

  return (
    <div className="space-y-5">
      {q?.total ? (
        <section className="panel p-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-[13px] text-muted">可用空间</div>
              <div className="num mt-1 text-[36px] leading-none font-semibold">{bytes(q.free)}</div>
            </div>
            <div className="text-right text-[13px] text-muted">已用 <span className="num text-ink">{bytes(q.used)}</span>，共 <span className="num text-ink">{bytes(q.total)}</span>（{((q.used / q.total) * 100).toFixed(1)}%）</div>
          </div>
          <Bar className="mt-4 h-2.5" value={q.used} max={q.total} color={q.free < 300 * 1024 ** 3 ? 'bg-bad' : 'bg-ink-2'} />
        </section>
      ) : null}

      {job && <JobCard job={job} />}

      <ReviewsPanel />

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-2 px-4 py-3">
          <nav className="flex flex-wrap items-center gap-1 text-[13px]">
            <button className="hover:underline" onClick={() => go('/')}>网盘根目录</button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight size={13} className="text-muted" />
                <button className="hover:underline" onClick={() => go('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button>
              </span>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {du.data?.scanned_at && <span className="text-xs text-muted">统计于 {dateTime(du.data.scanned_at)}</span>}
            <button className="btn btn-sm" disabled={!!job || start.isPending} onClick={() => start.mutate({ type: 'du', params: { path } })}><ScanSearch size={12} />{rows.length ? '补扫未统计的' : '扫描此目录'}</button>
            {rows.length > 0 && <button className="btn btn-sm" disabled={!!job || start.isPending} onClick={() => start.mutate({ type: 'du', params: { path, force: true } })}><RefreshCw size={12} />全部重新扫描</button>}
          </div>
        </div>
        <ErrorNote error={start.error} />
        {rows.length === 0 ? (
          <Empty icon={<ScanSearch size={28} />} title="这个目录还没统计过">点击「扫描此目录」统计每个子目录的大小。大目录可能需要几分钟，扫描期间不影响采集和转存。</Empty>
        ) : (
          <table className="w-full text-[13px]">
            <tbody>
              {rows.map(r => (
                <tr key={r.path} className="border-b border-line-2 last:border-0 hover:bg-paper/50">
                  <td className="w-[45%] py-2 pl-4">
                    {r.is_dir ? (
                      <button className="flex items-center gap-2 text-left hover:underline" onClick={() => go(r.path)}><Folder size={15} className="shrink-0 text-ink-2" />{r.name}</button>
                    ) : <span className="flex items-center gap-2 text-ink-2"><File size={15} className="shrink-0 text-muted" />{r.name}</span>}
                  </td>
                  <td className="py-2 pr-4"><Bar value={r.size} max={max} color="bg-ink-2" /></td>
                  <td className="num w-28 py-2 pr-4 text-right text-[14px]">{bytes(r.size)}</td>
                  <td className="w-28 py-2 pr-4 text-right text-xs text-muted max-md:hidden">{r.is_dir ? `${r.files.toLocaleString()} 个文件` : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="bg-paper/60 text-xs text-muted"><td className="py-2 pl-4">合计（已统计部分）</td><td /><td className="num py-2 pr-4 text-right text-[13px] text-ink">{bytes(du.data?.total)}</td><td className="max-md:hidden" /></tr></tfoot>
          </table>
        )}
      </section>
    </div>
  );
}

// ---------- 盘游评价 ----------
function ReviewsPanel() {
  const { data: sources } = useSources();
  const sid = sources?.find(s => s.enabled)?.id || sources?.[0]?.id || '';
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['reviews'], queryFn: () => api.get<ReviewStatus>('/reviews') });
  const sync = useMutation({
    mutationFn: () => api.post<ReviewStatus>('/reviews/sync'),
    onSuccess: s => { qc.setQueryData(['reviews'], s); qc.invalidateQueries({ queryKey: ['in-pan-bad'] }); },
  });
  const s = status.data;
  const bad = useQuery({
    queryKey: ['in-pan-bad', sid],
    queryFn: () => api.get<{ games: InPanBadGame[] }>(`/reviews/in-pan-bad?source_id=${sid}`),
    enabled: !!sid && (s?.bad ?? 0) > 0,
  });
  const [removing, setRemoving] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = bad.data?.games || [];
  const removable = list.filter(g => g.post_id);
  const totalBytes = list.reduce((n, g) => n + g.size, 0);

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-medium">盘游评价</div>
          <div className="mt-1 text-[13px] text-muted">
            {!s ? '正在读取…' : s.total === 0
              ? '还没读到盘游的评价。在盘游里给下载过的游戏标记能不能玩，评价会存到网盘 /盘游/评价，这里随后就能看到。'
              : <>
                  共 <span className="num text-ink">{s.total}</span> 条评价，其中 <span className="num text-bad">{s.bad}</span> 条不能玩
                  {s.devices.length > 0 && <>，来自{s.devices.map(d => `${d.name}（${d.count}）`).join('、')}</>}
                  {s.at && <>。读取于 {dateTime(s.at)}</>}
                </>}
          </div>
          {s?.error && <div className="mt-1 text-xs text-warn">上次读取失败：{s.error}</div>}
        </div>
        <button className="btn btn-sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
          <RefreshCw size={12} className={cx(sync.isPending && 'animate-spin')} />立即同步
        </button>
      </div>
      <ErrorNote error={sync.error || bad.error} />
      {notice && <div className="mt-3 text-[13px] text-ok">{notice}</div>}

      {bad.isFetching && !bad.data && <div className="mt-4 text-[13px] text-muted">正在核对网盘里的游戏是不是评过不能玩的那份…</div>}
      {list.length > 0 && (
        <div className="mt-4 rounded-lg border border-bad/40">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-2 px-4 py-2.5">
            <span className="text-[13px]">
              网盘里有 <span className="num text-bad">{list.length}</span> 个盘游标记过不能玩的游戏，占用 <span className="num text-ink">{bytes(totalBytes)}</span>
            </span>
            {removable.length > 0 && (
              <button className="btn btn-sm btn-danger" onClick={() => setRemoving(removable.map(g => g.post_id!))}>
                <Trash2 size={12} />全部退出网盘
              </button>
            )}
          </div>
          <div className="divide-y divide-line-2">
            {list.map(g => (
              <div key={g.path} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{g.title}</span>
                    <span className="num text-xs text-muted">{g.serial}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">
                    {g.review.device || '盘游'} 上 {new Date(g.review.at * 1000).toLocaleDateString('zh-CN')} 标记不能玩{g.review.note ? `：${g.review.note}` : ''} · <span className="font-mono">{g.path}</span>
                  </div>
                </div>
                <span className="num shrink-0">{bytes(g.size)}</span>
                {g.post_id
                  ? <button className="btn btn-sm shrink-0" onClick={() => setRemoving([g.post_id!])}>退出网盘</button>
                  : <span className="shrink-0 text-xs text-muted" title="游戏库里没找到这个编号的帖子，可以在下面的目录里手动删除">不在游戏库</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {removing && sid && (
        <RemoveDialog
          sourceId={sid}
          postIds={removing}
          onClose={() => setRemoving(null)}
          onDone={msg => {
            setRemoving(null);
            setNotice(msg);
            qc.invalidateQueries({ queryKey: ['in-pan-bad'] });
          }}
        />
      )}
    </section>
  );
}

// ---------- 规整 ----------
function Normalize() {
  const { data: sources } = useSources();
  const { data: ov } = useOverview();
  const [sid, setSid] = useState('');
  useEffect(() => { if (!sid && sources?.length) setSid(sources.find(s => s.enabled)?.id || sources[0].id); }, [sources, sid]);
  const source = sources?.find(s => s.id === sid);
  const plans = useQuery({ queryKey: ['plans', sid], queryFn: () => api.get<{ id: number; status: string; created_at: string }[]>(`/normalize/plans?source_id=${sid}`), enabled: !!sid });
  const latest = plans.data?.find(p => ['ready', 'executing', 'executed'].includes(p.status));
  const plan = useQuery({ queryKey: ['plans', 'detail', latest?.id], queryFn: () => api.get<NormalizePlan>(`/normalize/plans/${latest!.id}`), enabled: !!latest });
  const start = useStartJob();
  const job = ov?.active_jobs.find(j => (j.type === 'normalize_plan' || j.type === 'normalize_exec') && j.source_id === sid);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px]">
          {sources && sources.length > 1 && (
            <select className="field w-auto" value={sid} onChange={e => setSid(e.target.value)}>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          )}
          {source && <span className="text-muted">整理目录 <span className="font-medium text-ink">{source.dest_dir}</span></span>}
        </div>
        <button className="btn" disabled={!!job || start.isPending || !sid} onClick={() => start.mutate({ type: 'normalize_plan', source_id: sid })}><RefreshCw size={14} />重新生成预览</button>
      </div>
      <ErrorNote error={start.error} />
      {job && <JobCard job={job} />}
      {!latest && !job && (
        <div className="panel"><Empty icon={<FolderTree size={28} />} title="还没有规整预览">点击「重新生成预览」分析目录。生成预览只读取网盘，不会做任何改动。</Empty></div>
      )}
      {plan.data && source && <PlanView plan={plan.data} source={source} busy={!!job} />}
    </div>
  );
}

function PlanView({ plan, source, busy }: { plan: NormalizePlan; source: Source; busy: boolean }) {
  const groups = plan.plan.groups;
  const [checked, setChecked] = useState<Set<string>>(() => new Set(groups.map(g => g.target)));
  useEffect(() => setChecked(new Set(groups.map(g => g.target))), [plan.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const qc = useQueryClient();
  const nav = useNavigate();
  const exec = useMutation({
    mutationFn: () => api.post<{ id: number }>(`/normalize/plans/${plan.id}/execute`, { targets: [...checked] }),
    onSuccess: (j) => { qc.invalidateQueries({ queryKey: ['plans'] }); nav(`/jobs/${j.id}`); },
  });
  const discard = useMutation({
    mutationFn: () => api.post(`/normalize/plans/${plan.id}/discard`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plans'] }),
  });
  const ops = useMemo(() => {
    let rename = 0, move = 0, del = 0;
    groups.filter(g => checked.has(g.target)).forEach(g => g.steps.forEach(s => {
      if (s.op === 'rename') rename++;
      if (s.op === 'move_file') move++;
      if (s.op === 'delete_dup') del++;
      if (s.op === 'merge') { move += s.move?.length || 0; del += s.dup?.length || 0; }
      if (s.op === 'into_format') move += s.move?.length || 0;
    }));
    return { rename, move, del };
  }, [groups, checked]);
  const resultByTarget = new Map(plan.result?.results.map(r => [r.target, r]) || []);
  const ready = plan.status === 'ready';

  return (
    <>
      <section className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[13px] text-muted">
              {ready ? `预览生成于 ${dateTime(plan.created_at)}` : plan.status === 'executing' ? '正在执行这份预览' : `已于 ${dateTime(plan.executed_at)} 执行`}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
              <Stat n={plan.plan.total} label="目录里的条目" />
              <Stat n={plan.plan.standard} label="已是标准命名" />
              <Stat n={groups.length} label="待规整的目标" accent />
              <Stat n={plan.plan.anomalies.length} label="无法推导，保持原样" />
            </div>
          </div>
          {ready && groups.length > 0 && (
            <div className="flex flex-col items-end gap-2">
              <div className="flex gap-2">
                <button className="btn" onClick={() => discard.mutate()} disabled={discard.isPending}>放弃此预览</button>
                <button className="btn btn-primary" disabled={busy || checked.size === 0 || exec.isPending}
                  onClick={() => confirm(`将在 ${source.dest_dir} 执行：改名 ${ops.rename} 个目录，移动 ${ops.move} 项，删除重复文件 ${ops.del} 个。源目录只有在确认清空后才会删除。继续吗？`) && exec.mutate()}>
                  执行所选（{checked.size}）
                </button>
              </div>
              <div className="text-xs text-muted">改名 {ops.rename}，移动 {ops.move}，删除重复 {ops.del}</div>
            </div>
          )}
        </div>
        <ErrorNote error={exec.error} />
      </section>

      {groups.length > 0 && (
        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-line-2 px-4 py-2.5 text-[13px]">
            <span className="font-medium">规整计划</span>
            {ready && (
              <span className="flex gap-3 text-xs">
                <button className="text-muted hover:text-ink" onClick={() => setChecked(new Set(groups.map(g => g.target)))}>全选</button>
                <button className="text-muted hover:text-ink" onClick={() => setChecked(new Set())}>全不选</button>
              </span>
            )}
          </div>
          <div className="divide-y divide-line-2">
            {groups.map(g => {
              const res = resultByTarget.get(g.target);
              return (
                <label key={g.target} className={cx('flex gap-3 px-4 py-3', ready && 'cursor-pointer hover:bg-paper/50')}>
                  {ready ? <input type="checkbox" className="mt-1" checked={checked.has(g.target)} onChange={() => setChecked(s => { const n = new Set(s); n.has(g.target) ? n.delete(g.target) : n.add(g.target); return n; })} />
                    : res ? (res.ok ? <CircleCheck size={16} className="mt-0.5 text-ok" /> : <CircleAlert size={16} className="mt-0.5 text-warn" />) : <span className="w-4" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="num text-[16px] font-semibold">{g.target}</span>
                      <Chip cls={g.target_exists ? 'bg-normalize-soft text-normalize' : 'bg-line-2 text-ink-2'}>{g.target_exists ? '合并进已有目录' : '新建标准目录'}</Chip>
                      {res && !res.ok && <span className="text-xs text-warn">部分操作未成功，详见任务日志</span>}
                    </div>
                    <ul className="mt-1.5 space-y-1 text-[13px] text-ink-2">
                      {g.steps.map((s, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <StepIcon op={s.op} />
                          <span className="min-w-0">
                            {s.op === 'rename' && <>把 <b className="font-medium">{s.from}</b> 改名为 {g.target}</>}
                            {s.op === 'move_file' && <>把文件 <b className="font-medium">{s.from}</b> 移入 {g.target}</>}
                            {s.op === 'delete_dup' && <>删除 <b className="font-medium">{s.from}</b>（{g.target} 里已有同名文件）</>}
                            {s.op === 'merge' && <>把 <b className="font-medium">{s.from}</b> 的内容并入：移入 {s.move?.length || 0} 项{s.dup?.length ? `，${s.dup.length} 个同名文件判重删除` : ''}，清空后删除源目录</>}
                            {s.op === 'into_format' && <>按格式分目录：把 <b className="font-medium">{s.from}</b> 里的 {s.move?.length || 0} 项移入 {g.target}</>}
                            {s.by && <span className="ml-1.5 text-xs text-muted">（依据{s.by}推导）</span>}
                            {s.op === 'merge' && !!s.dup?.length && <span className="block truncate text-xs text-muted">重复：{s.dup.join('、')}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </label>
              );
            })}
          </div>
        </section>
      )}

      {plan.plan.anomalies.length > 0 && (
        <section className="panel overflow-hidden">
          <div className="border-b border-line-2 px-4 py-2.5 text-[13px] font-medium">无法推导 serial，保持原名</div>
          <div className="divide-y divide-line-2">
            {plan.plan.anomalies.map(a => (
              <div key={a.name} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">
                {a.isdir ? <Folder size={15} className="mt-0.5 shrink-0 text-muted" /> : <File size={15} className="mt-0.5 shrink-0 text-muted" />}
                <div><div>{a.name}</div><div className="text-xs text-muted">{a.reason}</div></div>
              </div>
            ))}
          </div>
        </section>
      )}

      {groups.length === 0 && ready && (
        <div className="panel"><Empty icon={<CircleCheck size={28} className="text-ok" />} title="目录已经很整齐了">除了上面列出的例外，所有条目都是标准 serial 命名。</Empty></div>
      )}
    </>
  );
}

const Stat = ({ n, label, accent }: { n: number; label: string; accent?: boolean }) => (
  <div><div className={cx('num text-[28px] leading-none font-semibold', accent && 'text-normalize')}>{n}</div><div className="mt-1 text-xs text-muted">{label}</div></div>
);

function StepIcon({ op }: { op: string }) {
  const I = { rename: PencilLine, move_file: FolderInput, delete_dup: Trash2, merge: Merge }[op] || FolderInput;
  return <I size={14} className={cx('mt-[3px] shrink-0', op === 'delete_dup' ? 'text-bad' : 'text-normalize')} />;
}
