import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Folder, File, ScanSearch, RefreshCw, Sparkles } from 'lucide-react';
import { api, type DuListing, type InPanBadGame, type PanplayLibraryStatus, type RecentPlan, type ReviewStatus } from '../lib/api';
import { PlanSummary, RemoveDialog } from './Games';
import { useAccount, useOverview, useSources, useStartJob } from '../lib/hooks';
import { JobCard } from '../components/JobCard';
import { Bar, Empty, ErrorNote, PageHeader, cx } from '../components/ui';
import { bytes, dateTime } from '../lib/format';

export function Storage() {
  return (
    <>
      <PageHeader title="网盘" desc="查看网盘空间都用在了哪里，管理盘游资源库。" />
      <Usage />
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
  const du = useQuery({
    queryKey: ['du', path],
    queryFn: () => api.get<DuListing>(`/storage/du?path=${encodeURIComponent(path)}`),
  });
  const q = acc?.quota;
  const job = ov?.active_jobs.find(j => j.type === 'du');
  const rows = du.data?.rows || [];
  const live = !!du.data?.live;
  const missing = !!du.data?.missing;
  const unscanned = !!du.data?.unscanned || (live && rows.some(r => r.is_dir && r.size == null));
  const max = Math.max(1, ...rows.map(r => r.size || 0));
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

      <PanplayLibraryPanel />

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
            {du.data?.scanned_at && !live && !du.data?.unscanned && <span className="text-xs text-muted">统计于 {dateTime(du.data.scanned_at)}</span>}
            {unscanned && !job && rows.length > 0 && <span className="text-xs text-muted">尚未统计大小</span>}
            <button className="btn btn-sm" disabled={!!job || start.isPending || missing} onClick={() => start.mutate({ type: 'du', params: { path } })}><ScanSearch size={12} />{live || unscanned || !rows.length ? '扫描此目录' : '补扫未统计的'}</button>
            {!live && !unscanned && rows.length > 0 && <button className="btn btn-sm" disabled={!!job || start.isPending} onClick={() => start.mutate({ type: 'du', params: { path, force: true } })}><RefreshCw size={12} />全部重新扫描</button>}
          </div>
        </div>
        <ErrorNote error={start.error} />
        <ErrorNote error={du.error} />
        {missing ? (
          <Empty icon={<Folder size={28} />} title="网盘里没有这个目录">可能已经删掉或改名了，回上一级看看。</Empty>
        ) : rows.length === 0 && (du.isLoading || du.isFetching) ? (
          <Empty icon={<ScanSearch size={28} />} title="正在读取目录…" />
        ) : rows.length === 0 && unscanned ? (
          <Empty icon={<ScanSearch size={28} />} title="这个目录还没统计过">点击「扫描此目录」列出并统计子项大小。大目录可能需要几分钟，扫描期间不影响采集和转存。</Empty>
        ) : rows.length === 0 ? (
          <Empty icon={<Folder size={28} />} title="这个目录是空的" />
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
                  <td className="py-2 pr-4">{r.size != null ? <Bar value={r.size} max={max} color="bg-ink-2" /> : null}</td>
                  <td className="num w-28 py-2 pr-4 text-right text-[14px]">{r.size != null ? bytes(r.size) : <span className="text-muted">—</span>}</td>
                  <td className="w-28 py-2 pr-4 text-right text-xs text-muted max-md:hidden">{r.is_dir ? (r.files != null ? `${r.files.toLocaleString()} 个文件` : '未统计') : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="bg-paper/60 text-xs text-muted"><td className="py-2 pl-4">{live ? '合计（仅已有大小的项）' : '合计（已统计部分）'}</td><td /><td className="num py-2 pr-4 text-right text-[13px] text-ink">{bytes(du.data?.total)}</td><td className="max-md:hidden" /></tr></tfoot>
          </table>
        )}
      </section>
    </div>
  );
}

// ---------- 盘游资源库 ----------
function PanplayLibraryPanel() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['panplay-library'],
    queryFn: () => api.get<PanplayLibraryStatus>('/panplay-library'),
    refetchInterval: q => (q.state.data?.links.running || q.state.data?.publish.running ? 5000 : 60_000),
  });
  const publish = useMutation({
    mutationFn: () => api.post<PanplayLibraryStatus>('/panplay-library/publish'),
    onSuccess: s => qc.setQueryData(['panplay-library'], s),
  });
  const check = useMutation({
    mutationFn: () => api.post<PanplayLibraryStatus>('/panplay-library/check-links'),
    onSuccess: s => qc.setQueryData(['panplay-library'], s),
  });
  const analyze = useMutation({
    mutationFn: () => api.post<PanplayLibraryStatus>('/panplay-library/analyze'),
    onSuccess: s => qc.setQueryData(['panplay-library'], s),
  });
  const s = status.data;
  const p = s?.publish;
  const l = s?.links;
  const a = s?.plans;

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-medium">盘游资源库</div>
          <div className="mt-1 text-[13px] text-muted">
            {!p ? '正在读取…' : p.at
              ? <>已发布 <span className="num text-ink">{p.count}</span> 个游戏到 <span className="font-mono">{p.path}</span>，更新于 {dateTime(p.at)}。盘游据此列出全部游戏，点安装时自己转存。</>
              : <>还没发布。发布后盘游能直接看到这里的全部游戏，点安装时自己转存到网盘，不用先在这里加入网盘。</>}
          </div>
          {l && (
            <div className="mt-1 text-[13px] text-muted">
              链接检查：已查 <span className="num text-ink">{l.checked_total}</span> / {l.total} 条，失效 <span className="num text-bad">{l.dead_total}</span> 条
              {l.running ? '，正在检查…' : l.at ? `，上次 ${dateTime(l.at)}` : ''}。每条链接 7 天复查一次。
            </div>
          )}
          {a && (
            <div className="mt-1 text-[13px] text-muted">
              {a.ready
                ? <>安装编排：<span className="num text-ink">{a.ok}</span> / {a.total} 条已排好，失败 <span className="num text-bad">{a.failed}</span>，等盘游反馈后重排 <span className="num text-ink">{a.queued}</span>{a.running ? `，正在分析 ${a.current || ''}…` : ''}。</>
                : <>安装编排：没开大模型分析，盘游按固定规则装。可以在 <Link to="/settings/llm" className="underline hover:text-ink">设置 › 大模型分析</Link> 打开。</>}
              {s?.feedback.received ? <> 收到盘游反馈 {s.feedback.received} 条。</> : null}
            </div>
          )}
          {a?.recent_errors.length ? (
            <div className="mt-1 text-xs text-warn">最近失败：{a.recent_errors.map(e => e.error).filter(Boolean).slice(0, 2).join('；')}</div>
          ) : null}
          {p?.error && <div className="mt-1 text-xs text-warn">上次发布失败：{p.error}</div>}
          {l?.error && <div className="mt-1 text-xs text-warn">链接检查中途停下：{l.error}，下一轮再继续</div>}
        </div>
        <div className="flex gap-2">
          <button className="btn btn-sm" disabled={check.isPending || l?.running} onClick={() => check.mutate()}>
            <ScanSearch size={12} />检查链接
          </button>
          {a && (a.ready
            ? (
              <button className="btn btn-sm" disabled={analyze.isPending || a.running} onClick={() => analyze.mutate()} title="分析还没排的，失败的也重来一遍">
                <Sparkles size={12} />分析编排
              </button>
            )
            : (
              <Link to="/settings/llm" className="btn btn-sm" title="先在设置里填大模型接口并打开分析">
                <Sparkles size={12} />分析编排
              </Link>
            ))}
          <button className="btn btn-sm" disabled={publish.isPending || p?.running} onClick={() => publish.mutate()}>
            <RefreshCw size={12} className={cx((publish.isPending || p?.running) && 'animate-spin')} />立即发布
          </button>
        </div>
      </div>
      <ErrorNote error={status.error || publish.error || check.error || analyze.error} />
      {a && (a.ok > 0 || a.failed > 0) && <RecentPlans running={a.running} done={a.ok + a.failed} />}
    </section>
  );
}

const PLAN_FORMAT: Record<string, string> = { folder: '文件夹', zstd: 'ZSTD', exfat: 'exFAT', unknown: '未标注' };

// 最近分析出来的编排：点开看内容，点名字到游戏库打开那个游戏
function RecentPlans({ running, done }: { running: boolean; done: number }) {
  const recent = useQuery({
    queryKey: ['recent-plans', done],
    queryFn: () => api.get<{ plans: RecentPlan[] }>('/panplay-library/plans?limit=30'),
    refetchInterval: running ? 15_000 : false,
  });
  const list = recent.data?.plans || [];
  return (
    <details className="mt-4 rounded-lg border border-line-2">
      <summary className="cursor-pointer px-4 py-2.5 text-[13px]">最近分析的 {list.length} 条（点开看编排）</summary>
      <div className="divide-y divide-line-2">
        {list.map(p => {
          const plan = p.plan;
          const brief = plan
            ? [`主游戏 ${plan.layers[0]?.files.length || 0} 卷`, plan.layers.length > 1 && `补丁 ${plan.layers.length - 1} 组`,
               plan.copies.length > 0 && `放 ${plan.copies.length} 个文件`, plan.notes.length > 0 && `提醒 ${plan.notes.length} 条`].filter(Boolean).join(' · ')
            : `失败：${p.error || '原因不明'}`;
          return (
            <details key={p.surl} className="px-4 py-2 text-[13px]">
              <summary className="flex cursor-pointer items-center gap-2">
                <Link to={`/games?game=${encodeURIComponent(p.post_id)}&source=${encodeURIComponent(p.source_id)}`} className="min-w-0 truncate font-medium hover:underline"
                  onClick={e => e.stopPropagation()}>{p.title}</Link>
                <span className="shrink-0 text-xs text-muted">{PLAN_FORMAT[p.format || ''] || p.format || ''}</span>
                <span className={cx('min-w-0 flex-1 truncate text-xs', plan ? 'text-muted' : 'text-warn')}>{brief}</span>
                {p.analyzed_at && <span className="shrink-0 text-[11px] text-muted">{dateTime(p.analyzed_at)}</span>}
              </summary>
              <div className="mt-2 pl-1"><PlanSummary lp={p} /></div>
            </details>
          );
        })}
      </div>
      <ErrorNote error={recent.error} />
    </details>
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

