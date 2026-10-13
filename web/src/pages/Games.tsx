import { Fragment, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, RotateCcw, Search, SkipForward, Undo2, CloudDownload, Radar, Copy, Trash2, AlertTriangle, Folder, File } from 'lucide-react';
import { api, type Game, type Job, type RemovalPreview } from '../lib/api';
import { useSources } from '../lib/hooks';
import { Chip, Empty, ErrorNote, Modal, PageHeader, cx, linkStatus, postStatus } from '../components/ui';
import { bytes, dateTime } from '../lib/format';

const VIEWS: { id: string; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'available', label: '未入盘' },
  { id: 'pending_transfer', label: '待转存' },
  { id: 'transferred', label: '已入盘' },
  { id: 'pending_detail', label: '待抓详情' },
  { id: 'transfer_failed', label: '转存失败' },
  { id: 'detail_failed', label: '抓取失败' },
  { id: 'invalid', label: '链接失效' },
  { id: 'no_link', label: '没有链接' },
  { id: 'skipped', label: '已跳过' },
];

const PAGE_SIZE = 50;

export function Games() {
  const [sp, setSp] = useSearchParams();
  const { data: sources } = useSources();
  const sourceId = sp.get('source') || sources?.find(s => s.enabled)?.id || sources?.[0]?.id || '';
  const view = sp.get('view') || 'all';
  const page = Number(sp.get('page') || 1);
  const [q, setQ] = useState(sp.get('q') || '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const qc = useQueryClient();

  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp);
    Object.entries(patch).forEach(([k, v]) => (v ? n.set(k, v) : n.delete(k)));
    if (!('page' in patch)) n.delete('page');
    setSp(n, { replace: true });
  };

  useEffect(() => {
    const t = setTimeout(() => { if ((sp.get('q') || '') !== q) set({ q: q || null }); }, 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setSelected(new Set()), [view, sourceId, page, sp.get('q')]); // eslint-disable-line react-hooks/exhaustive-deps

  const facets = useQuery({ queryKey: ['facets', sourceId], queryFn: () => api.get<Record<string, number>>(`/games/facets?source_id=${sourceId}`), enabled: !!sourceId });
  const games = useQuery({
    queryKey: ['games', sourceId, view, sp.get('q'), page],
    queryFn: () => api.get<{ total: number; rows: Game[] }>(`/games?source_id=${sourceId}&view=${view}&page=${page}&size=${PAGE_SIZE}&q=${encodeURIComponent(sp.get('q') || '')}`),
    enabled: !!sourceId,
    placeholderData: keepPreviousData,
  });

  const refresh = () => { qc.invalidateQueries({ queryKey: ['games'] }); qc.invalidateQueries({ queryKey: ['facets'] }); qc.invalidateQueries({ queryKey: ['overview'] }); };
  const action = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ job?: Job; changed?: number; reset_links?: number; reset_posts?: number; games?: number }>('/games/actions', { source_id: sourceId, ...body }),
    onSuccess: (r, body) => {
      setSelected(new Set());
      refresh();
      const a = body.action;
      setNotice(
        a === 'retry_failed' ? `已重置 ${r.reset_links} 条失败链接、${r.reset_posts} 个抓取失败的游戏${r.job ? '，转存任务已启动' : ''}`
          : a === 'add' ? `已把 ${r.games} 个游戏加入转存队列，进度在「任务」页查看`
            : a === 'skip' ? `已跳过 ${r.changed} 条链接，之后的转存不会再处理它们`
              : a === 'unskip' ? `已恢复 ${r.changed} 条链接`
                : r.job ? `已创建任务 #${r.job.id}` : '已完成');
    },
  });
  const [removing, setRemoving] = useState<string[] | null>(null);

  const rows = games.data?.rows || [];
  const total = games.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allChecked = rows.length > 0 && rows.every(r => selected.has(r.post_id));
  const toggle = (set: Set<string>, id: string) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); return n; };
  const ids = [...selected];
  const failedCount = (facets.data?.transfer_failed || 0) + (facets.data?.detail_failed || 0);

  return (
    <>
      <PageHeader title="游戏库" desc="每个游戏对应站点上的一个帖子。采集负责抓详情页拿到网盘链接，转存负责把链接存进网盘。"
        actions={failedCount > 0 && (
          <button className="btn" onClick={() => action.mutate({ action: 'retry_failed' })} disabled={action.isPending}><RotateCcw size={14} />重试全部失败（{failedCount}）</button>
        )} />

      {sources && sources.length > 1 && (
        <select className="field mb-3 w-auto" value={sourceId} onChange={e => set({ source: e.target.value })}>
          {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {VIEWS.map(v => {
          const n = facets.data?.[v.id];
          if (v.id !== 'all' && !n && view !== v.id) return null;
          return (
            <button key={v.id} onClick={() => set({ view: v.id === 'all' ? null : v.id })}
              className={cx('rounded-full border px-3 py-1 text-[13px]', view === v.id ? 'border-ink bg-ink text-white' : 'border-line bg-panel hover:border-ink-2')}>
              {v.label} <span className={cx('num ml-0.5', view === v.id ? 'text-white/70' : 'text-muted')}>{n ?? ''}</span>
            </button>
          );
        })}
        <div className="relative ml-auto w-64 max-sm:w-full">
          <Search size={14} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input className="field pl-8" placeholder="搜索游戏名或游戏编号（如 PPSA01593）" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>

      {notice && <div className="mb-3 flex items-center justify-between rounded-lg bg-ok-soft px-3 py-2 text-[13px] text-ok">{notice}<button className="text-xs underline" onClick={() => setNotice(null)}>知道了</button></div>}
      <ErrorNote error={action.error} />

      {selected.size > 0 && (
        <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-shell px-4 py-2.5 text-white shadow-lg">
          <span className="mr-2 text-[13px]">已选 <span className="num">{selected.size}</span> 个游戏</span>
          <button className="btn btn-sm" onClick={() => action.mutate({ action: 'add', post_ids: ids })}><CloudDownload size={12} />加入网盘</button>
          <button className="btn btn-sm btn-danger" onClick={() => setRemoving(ids)}><Trash2 size={12} />从网盘删除</button>
          <button className="btn btn-sm" onClick={() => action.mutate({ action: 'recrawl', post_ids: ids })}><Radar size={12} />重新采集</button>
          <button className="btn btn-sm" onClick={() => action.mutate({ action: 'skip', post_ids: ids })}><SkipForward size={12} />跳过转存</button>
          <button className="btn btn-sm" onClick={() => action.mutate({ action: 'unskip', post_ids: ids })}><Undo2 size={12} />取消跳过</button>
          <button className="ml-auto text-xs text-white/60 hover:text-white" onClick={() => setSelected(new Set())}>清除选择</button>
        </div>
      )}

      <div className="panel overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="border-b border-line bg-paper/60 text-left text-xs text-muted">
            <tr>
              <th className="w-10 py-2.5 pl-4"><input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map(r => r.post_id)))} aria-label="全选本页" /></th>
              <th className="py-2.5 font-medium">游戏</th>
              <th className="w-28 py-2.5 font-medium">采集</th>
              <th className="w-44 py-2.5 font-medium">转存</th>
              <th className="w-32 py-2.5 pr-4 font-medium max-md:hidden">更新时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(g => {
              const ps = postStatus(g.status);
              const isOpen = open.has(g.post_id);
              return (
                <Fragment key={g.post_id}>
                  <tr className={cx('border-b border-line-2 hover:bg-paper/50', selected.has(g.post_id) && 'bg-signal-soft/40')}>
                    <td className="py-2.5 pl-4"><input type="checkbox" checked={selected.has(g.post_id)} onChange={() => setSelected(s => toggle(s, g.post_id))} aria-label={`选择 ${g.title || g.post_id}`} /></td>
                    <td className="py-2.5 pr-3">
                      <button className="flex items-start gap-1.5 text-left" onClick={() => setOpen(s => toggle(s, g.post_id))}>
                        {isOpen ? <ChevronDown size={14} className="mt-0.5 shrink-0 text-muted" /> : <ChevronRight size={14} className="mt-0.5 shrink-0 text-muted" />}
                        <span>
                          <span className="font-medium">{g.title || <span className="text-muted">（标题待采集）</span>}</span>
                          {g.serial && <span className="num ml-2 font-mono text-xs text-ink-2">{g.serial}</span>}
                          <span className="num ml-2 text-xs text-muted">#{g.post_id}</span>
                        </span>
                      </button>
                    </td>
                    <td className="py-2.5"><Chip cls={ps.cls}>{ps.label}</Chip>{g.fail_count > 0 && g.status !== 'failed' && <span className="ml-1 text-xs text-warn">失败 {g.fail_count} 次</span>}</td>
                    <td className="py-2.5">
                      <div className="flex flex-wrap items-center gap-1">
                        {g.links.length === 0 ? <span className="text-xs text-muted">-</span> : summarizeLinks(g).map(([label, cls, n]) => <Chip key={label} cls={cls}>{label}{n > 1 ? ` ×${n}` : ''}</Chip>)}
                        {inPan(g) === 'available' && (
                          <button className="btn btn-sm ml-1 px-2 py-0.5 text-xs" onClick={() => action.mutate({ action: 'add', post_ids: [g.post_id] })} disabled={action.isPending}><CloudDownload size={12} />加入网盘</button>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-muted max-md:hidden">{dateTime(g.links.map(l => l.transferred_at).filter(Boolean).sort().pop() || g.crawled_at || g.discovered_at)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-line-2 bg-paper/40">
                      <td />
                      <td colSpan={4} className="py-3 pr-4">
                        <GameDetail g={g} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && !games.isLoading && <Empty title="这个分类下没有游戏">{sp.get('q') ? '换个关键词试试。' : '切换上方的分类查看其他游戏。'}</Empty>}
        {games.isLoading && <div className="py-10 text-center text-muted">加载中…</div>}
      </div>

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-[13px] text-muted">
          <span>共 <span className="num">{total}</span> 个，第 {page}/{pages} 页</span>
          <div className="flex gap-1.5">
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>上一页</button>
            <button className="btn btn-sm" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>下一页</button>
          </div>
        </div>
      )}

      {removing && (
        <RemoveDialog sourceId={sourceId} postIds={removing} onClose={() => setRemoving(null)}
          onDone={job => { setRemoving(null); setSelected(new Set()); refresh(); setNotice(`删除任务 #${job.id} 已开始，删掉的文件会进百度网盘回收站；之后这些游戏会回到「未入盘」，随时可以再加入`); }} />
      )}
    </>
  );
}

function inPan(g: Game): 'in' | 'queued' | 'available' | null {
  const st = new Set(g.links.map(l => l.status));
  if (st.has('saved') || st.has('exists')) return 'in';
  if (st.has('pending')) return 'queued';
  if (st.has('available')) return 'available';
  return null;
}

function RemoveDialog({ sourceId, postIds, onClose, onDone }: { sourceId: string; postIds: string[]; onClose: () => void; onDone: (job: Job) => void }) {
  const preview = useQuery({
    queryKey: ['remove-preview', sourceId, postIds],
    queryFn: () => api.post<{ games: RemovalPreview[] }>('/games/remove-preview', { source_id: sourceId, post_ids: postIds }),
    gcTime: 0, staleTime: 0,
  });
  const run = useMutation({
    mutationFn: () => api.post<{ job: Job }>('/games/remove', { source_id: sourceId, post_ids: [...found, ...missing].map(g => g.post_id) }),
    onSuccess: r => onDone(r.job),
  });
  const list = preview.data?.games || [];
  const found = list.filter(g => g.targets.length);
  const missing = list.filter(g => g.missing);
  const skipped = list.length - found.length - missing.length;
  const total = found.reduce((s, g) => s + g.targets.reduce((t, x) => t + (x.size || 0), 0), 0);
  const unknown = found.some(g => g.targets.some(t => t.size == null));

  return (
    <Modal open onClose={onClose} title="从网盘删除游戏" width="max-w-2xl"
      footer={<>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn border-bad bg-bad text-white hover:opacity-90" disabled={!(found.length + missing.length) || run.isPending} onClick={() => run.mutate()}>
          <Trash2 size={14} />
          {found.length > 0 && <>删除 {found.length} 个游戏{total > 0 && `（${bytes(total)}${unknown ? '+' : ''}）`}</>}
          {found.length > 0 && missing.length > 0 && '，'}
          {missing.length > 0 && `${found.length ? '' : '把 '}${missing.length} 个改回未入盘`}
        </button>
      </>}>
      {preview.isLoading && <div className="py-8 text-center text-muted">正在网盘里查找这些游戏的文件夹…</div>}
      <ErrorNote error={preview.error || run.error} />
      {preview.data && (
        <div className="space-y-3 text-[13px]">
          <p className="text-muted">按游戏编号在网盘目录里找到下面这些文件夹，确认后会删除。删掉的内容先进百度网盘回收站（回收站清空后才真正腾出空间），游戏本身仍保留在游戏库，标记为「未入盘」，想要时再加入。</p>
          <div className="max-h-[50vh] space-y-2 overflow-auto">
            {list.map(g => (
              <div key={g.post_id} className="rounded-lg border border-line-2 p-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{g.title || `#${g.post_id}`}</span>
                  {g.serial && <span className="font-mono text-xs text-ink-2">{g.serial}</span>}
                </div>
                {g.targets.map(t => (
                  <div key={t.path} className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                    {t.isdir ? <Folder size={12} /> : <File size={12} />}
                    <span className="truncate font-mono">{t.path}</span>
                    <span className="num ml-auto shrink-0">{t.size != null ? bytes(t.size) : '大小未知'}</span>
                  </div>
                ))}
                {g.problem && <div className={cx('mt-1 flex items-center gap-1 text-xs', g.missing ? 'text-muted' : 'text-warn')}><AlertTriangle size={12} />{g.problem}</div>}
              </div>
            ))}
          </div>
          {missing.length > 0 && <p className="text-xs text-muted">有 {missing.length} 个游戏网盘里其实已经没有了（可能之前被清理过），确认后只把它们的记录改回「未入盘」，不删任何文件。</p>}
          {skipped > 0 && <p className="text-xs text-warn">有 {skipped} 个游戏不会处理，原因见上面的提示。</p>}
        </div>
      )}
    </Modal>
  );
}

function summarizeLinks(g: Game): [string, string, number][] {
  const m = new Map<string, [string, string, number]>();
  g.links.forEach(l => {
    const s = linkStatus(l.status);
    const cur = m.get(s.label);
    m.set(s.label, [s.label, s.cls, (cur?.[2] || 0) + 1]);
  });
  return [...m.values()];
}

const FORMAT = {
  exfat: { label: 'exFAT', cls: 'bg-ok-soft text-ok' },
  folder: { label: '文件夹', cls: 'bg-line-2 text-ink-2' },
  pkg: { label: 'PKG', cls: 'bg-bad-soft text-bad' },
  unknown: { label: '未标注', cls: 'bg-line-2 text-muted' },
};

function GameDetail({ g }: { g: Game }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <a className="inline-flex items-center gap-1 hover:text-ink" href={g.url} target="_blank" rel="noreferrer"><ExternalLink size={12} />打开帖子</a>
        <span>发现于 {dateTime(g.discovered_at)}</span>
        {g.crawled_at && <span>采集于 {dateTime(g.crawled_at)}</span>}
        {g.last_error && <span className="text-bad">最近错误：{g.last_error}</span>}
      </div>
      {g.links.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-left text-muted">
            <tr><th className="py-1 font-normal">网盘链接</th><th className="py-1 font-normal">版本</th><th className="py-1 font-normal">提取码</th><th className="py-1 font-normal">状态</th><th className="py-1 font-normal">转存时间</th><th className="py-1 font-normal max-md:hidden">说明</th></tr>
          </thead>
          <tbody>
            {g.links.map(l => {
              const s = linkStatus(l.status);
              const href = `https://pan.baidu.com/s/${l.surl}${l.pwd ? `?pwd=${l.pwd}` : ''}`;
              return (
                <tr key={l.surl} className="border-t border-line-2">
                  <td className="py-1.5"><a className="font-mono hover:underline" href={href} target="_blank" rel="noreferrer">{l.surl}</a></td>
                  <td className="py-1.5">
                    {l.format && l.format !== 'unknown' && <Chip cls={FORMAT[l.format].cls}>{FORMAT[l.format].label}</Chip>}
                    {l.remark && <span className="ml-1 text-muted" title={l.remark}>{l.remark.length > 28 ? l.remark.slice(0, 28) + '…' : l.remark}</span>}
                    {!l.format && !l.remark && <span className="text-muted">-</span>}
                  </td>
                  <td className="py-1.5 font-mono">
                    {l.pwd || '-'}
                    {l.pwd && <button className="ml-1 text-muted hover:text-ink" title="复制链接和提取码" onClick={() => navigator.clipboard.writeText(`${href} 提取码: ${l.pwd}`)}><Copy size={11} /></button>}
                  </td>
                  <td className="py-1.5"><Chip cls={s.cls}>{s.label}</Chip>{l.attempts > 1 && <span className="ml-1 text-muted">试过 {l.attempts} 次</span>}</td>
                  <td className="py-1.5 text-muted">{l.transferred_at ? `${dateTime(l.transferred_at)} → ${l.dest_dir}` : '-'}</td>
                  <td className="py-1.5 text-muted max-md:hidden">{l.last_error || (l.status.startsWith('err_') ? l.status : '')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
