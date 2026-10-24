import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CloudDownload,
  Trash2,
  RotateCcw,
  ExternalLink,
  Copy,
  Check,
  AlertTriangle,
  Folder,
  File,
  RefreshCw,
  X,
  CheckSquare,
  Radar,
  SkipForward,
  Undo2,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { api, type BlockedAdd, type Game, type GameReview, type Job, type PanState, type RemovalPreview, type Review, type ReviewBrief } from '../lib/api';
import { useAccount, useSetup, useSources } from '../lib/hooks';
import { Dropdown } from '../components/Dropdown';
import { Chip, Empty, ErrorNote, Modal, cx, linkStatus } from '../components/ui';
import { bytes, dateTime } from '../lib/format';

const PRIMARY_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'transferred', label: '已入盘' },
  { id: 'pending_transfer', label: '转存中' },
  { id: 'available', label: '未入盘' },
];

const SORT_OPTIONS = [
  { value: 'pan_first', label: '已入盘优先' },
  { value: 'newest', label: '最新收录' },
  { value: 'updated', label: '最近更新' },
  { value: 'rating', label: '评分最高' },
  { value: 'release', label: '发售日期（新→旧）' },
  { value: 'title', label: '按名称' },
];

const EXTRA_FILTERS: { id: string; label: string }[] = [
  { id: 'pending_detail', label: '待抓详情' },
  { id: 'transfer_failed', label: '转存失败' },
  { id: 'detail_failed', label: '抓取失败' },
  { id: 'no_link', label: '无网盘链接' },
  { id: 'skipped', label: '已跳过' },
  { id: 'reviewed', label: '盘游评过' },
];

const REGION_NAMES: Record<string, string> = {
  UP: '美服',
  EP: '欧服',
  JP: '日服',
  HP: '港服',
  KP: '韩服',
  IP: '国服',
  AS: '亚服',
};

const FORMAT_LABELS: Record<string, { label: string; cls: string }> = {
  exfat: { label: 'exFAT', cls: 'bg-ok-soft text-ok' },
  folder: { label: '文件夹', cls: 'bg-line-2 text-ink-2' },
  pkg: { label: 'PKG', cls: 'bg-bad-soft text-bad' },
  unknown: { label: '未标注', cls: 'bg-line-2 text-muted' },
};

// 每页大约这么多个，实际取「列数 × 行数」，保证每页最后一行是满的
const TARGET_PAGE_SIZE = 120;

// 读取封面墙实际排出的列数（用一个同样式、零高度的探针网格，随窗口宽度变化）
function useShelfColumns() {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const tracks = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length;
      setCols(Math.max(1, tracks));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, cols] as const;
}


const LANG_NAMES: Record<string, string> = {
  zh: '中文', ch: '中文', en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', it: '意大利语',
  pt: '葡萄牙语', ru: '俄语', ar: '阿拉伯语', pl: '波兰语', nl: '荷兰语', th: '泰语', tr: '土耳其语', sv: '瑞典语',
  da: '丹麦语', fi: '芬兰语', no: '挪威语', cs: '捷克语', hu: '匈牙利语', el: '希腊语', id: '印尼语', vi: '越南语', uk: '乌克兰语',
};
function langLabels(codes: string[]): string {
  const names = codes.map(c => LANG_NAMES[c.toLowerCase().split('-')[0]] || c);
  return [...new Set(names)].join('、');
}
const CLASS_NAMES: Record<string, string> = { GAME_BUNDLE: '捆绑包', PREMIUM_EDITION: '高级版', ADD_ON_PACK: '附加内容', DEMO: '试玩版' };
const classLabel = (c: string) => CLASS_NAMES[c] || c;

function hueFrom(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

function splitSerial(serial: string | null | undefined, postId: string): [string, string] {
  const s = (serial || '').trim().toUpperCase();
  const m = s.match(/^([A-Z]{4})(\d{5})$/);
  if (m) return [m[1], m[2]];
  return ['POST', postId.slice(-5).padStart(5, '0')];
}

function getPanState(g: Game): PanState {
  if (g.pan_state) return g.pan_state;
  const st = new Set(g.links.map(l => l.status));
  if (st.has('saved') || st.has('exists')) return 'in_pan';
  if (st.has('pending')) return 'queued';
  if (st.has('available')) return 'available';
  if (g.status === 'pending_detail') return 'pending_detail';
  if (g.status === 'failed' || g.links.some(l => l.status.startsWith('err_') || l.status === 'exc')) return 'failed';
  return 'no_link';
}

// 「PS5 上 2026/10/18」
export function reviewWhere(r: Review): string {
  return `${r.device || '盘游'} 上 ${new Date(r.at * 1000).toLocaleDateString('zh-CN')}`;
}
export function reviewVerdict(r: Review): string {
  return `${r.playable ? '能正常玩' : '不能玩'}${r.note ? `：${r.note}` : ''}${r.firmware ? `（固件 ${r.firmware}）` : ''}`;
}

function TileReview({ r }: { r: ReviewBrief }) {
  const title = r.exact
    ? `盘游里评过这份资源：${reviewWhere(r)}标记${reviewVerdict(r)}`
    : `盘游评过这个游戏（${reviewWhere(r)}标记${reviewVerdict(r)}），但不一定是这里的这份资源`;
  return (
    <span className={cx('tile-review', r.playable ? 'ok' : 'bad', !r.exact && 'loose')} title={title}>
      {r.playable ? <Check size={11} strokeWidth={3} /> : <X size={11} strokeWidth={3} />}
      {r.playable ? '能玩' : '有问题'}
    </span>
  );
}

export function Games() {
  const [sp, setSp] = useSearchParams();
  const { data: sources } = useSources();
  const { data: acc } = useAccount();
  const setup = useSetup();
  const sourceId = sp.get('source') || sources?.find(s => s.enabled)?.id || sources?.[0]?.id || '';
  const view = sp.get('view') || 'all';
  const sort = sp.get('sort') || 'pan_first';
  const page = Math.max(1, Number(sp.get('page') || 1));
  const q = sp.get('q') || '';
  const cnOnly = sp.get('cn') === '1';
  const multiOnly = sp.get('multi') === '1';

  const [probeRef, cols] = useShelfColumns();
  const pageSize = cols ? cols * Math.max(3, Math.round(TARGET_PAGE_SIZE / cols)) : 0;

  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activePostId, setActivePostId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const qc = useQueryClient();

  const updateParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!('page' in patch)) next.delete('page');
    setSp(next, { replace: true });
  };

  useEffect(() => {
    setSelected(new Set());
  }, [view, sourceId, page, q, cnOnly, multiOnly]);

  const facets = useQuery({
    queryKey: ['facets', sourceId],
    queryFn: () => api.get<Record<string, number>>(`/games/facets?source_id=${sourceId}`),
    enabled: !!sourceId,
  });
  const narrowed = !!q || cnOnly || multiOnly;
  const narrowedFacets = useQuery({
    queryKey: ['facets', sourceId, q, cnOnly, multiOnly],
    queryFn: () =>
      api.get<Record<string, number>>(
        `/games/facets?source_id=${sourceId}&q=${encodeURIComponent(q)}${cnOnly ? '&cn=1' : ''}${multiOnly ? '&multi=1' : ''}`
      ),
    enabled: !!sourceId && narrowed,
    placeholderData: keepPreviousData,
  });
  const viewCounts = narrowed ? narrowedFacets.data : facets.data;

  const games = useQuery({
    queryKey: ['games', sourceId, view, sort, q, page, pageSize, cnOnly, multiOnly],
    queryFn: () =>
      api.get<{ total: number; rows: Game[] }>(
        `/games?source_id=${sourceId}&view=${view}&sort=${sort}&page=${page}&size=${pageSize}&q=${encodeURIComponent(q)}` +
          `${cnOnly ? '&cn=1' : ''}${multiOnly ? '&multi=1' : ''}`
      ),
    enabled: !!sourceId && pageSize > 0,
    placeholderData: keepPreviousData,
  });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['games'] });
    qc.invalidateQueries({ queryKey: ['game-detail'] });
    qc.invalidateQueries({ queryKey: ['facets'] });
    qc.invalidateQueries({ queryKey: ['overview'] });
  };

  const [blocked, setBlocked] = useState<BlockedAdd[] | null>(null);

  const action = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ job?: Job | null; changed?: number; cancelled?: number; reset_links?: number; reset_posts?: number; games?: number; blocked?: BlockedAdd[] }>(
        '/games/actions',
        { source_id: sourceId, ...body }
      ),
    onSuccess: (r, body) => {
      setSelected(new Set());
      refreshAll();
      const a = body.action;
      if (a === 'add' && r.blocked?.length) {
        setBlocked(r.blocked);
        if (!r.games) return setNotice(null);
      }
      setNotice(
        a === 'retry_failed'
          ? `已重置 ${r.reset_links} 条失败链接、${r.reset_posts} 个抓取失败的游戏${r.job ? '，转存任务已启动' : ''}`
          : a === 'add'
            ? `已把 ${r.games} 个游戏加入转存队列，正在后台转存入盘${r.blocked?.length ? `；另外 ${r.blocked.length} 个盘游标记过不能玩，没有加入` : ''}`
            : a === 'cancel_transfer'
              ? `已取消 ${r.cancelled} 条待转存链接的排队`
              : a === 'skip'
                ? `已跳过 ${r.changed} 条链接`
                : a === 'unskip'
                  ? `已恢复 ${r.changed} 条链接`
                  : r.job
                    ? `已启动任务 #${r.job.id}`
                    : '操作已完成'
      );
    },
  });

  const rows = games.data?.rows || [];
  const total = games.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / (pageSize || TARGET_PAGE_SIZE)));

  // 窗口变宽变窄导致每页数量变化时，换算页码，让当前看到的第一个游戏仍在当前页
  const prevSize = useRef(0);
  useEffect(() => {
    const before = prevSize.current;
    prevSize.current = pageSize;
    if (!before || !pageSize || before === pageSize || page <= 1) return;
    const firstIndex = (page - 1) * before;
    updateParams({ page: String(Math.floor(firstIndex / pageSize) + 1) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize]);

  // 页码超出范围（比如筛选后总数变少）时回到最后一页
  useEffect(() => {
    if (games.data && !games.isPlaceholderData && page > pages) updateParams({ page: pages > 1 ? String(pages) : null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games.data, pages, page]);

  const goPage = (n: number) => {
    const target = Math.min(pages, Math.max(1, Math.round(n)));
    if (target === page) return;
    updateParams({ page: target > 1 ? String(target) : null });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const queuedCount = facets.data?.pending_transfer ?? 0;
  const failedCount = (facets.data?.transfer_failed || 0) + (facets.data?.detail_failed || 0);

  const toggleSelect = (postId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  };

  const selectedIds = [...selected];
  const activeGameFromList = rows.find(r => r.post_id === activePostId) || null;
  const isExtraView = EXTRA_FILTERS.some(f => f.id === view);

  return (
    <>
      <div className="library-toolbar">
        <div className="toolbar-group">
          <h1 className="library-title">
            游戏库 {games.data && <span className="count">{total}</span>}
          </h1>
          {sources && sources.length > 1 && (
            <Dropdown
              className="dropdown-field"
              value={sourceId}
              onChange={v => updateParams({ source: v })}
              options={sources.map(s => ({ value: s.id, label: s.name }))}
              ariaLabel="选择来源"
            />
          )}

          <div className="filters" role="tablist" aria-label="网盘状态筛选">
            {PRIMARY_FILTERS.map(f => {
              const count = viewCounts?.[f.id];
              if (f.id === 'pending_transfer' && !queuedCount && view !== 'pending_transfer') return null;
              const isOn = view === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={isOn}
                  className={cx(isOn && 'on')}
                  onClick={() => updateParams({ view: f.id === 'all' ? null : f.id })}
                >
                  <span>{f.label}</span>
                  {count !== undefined && <span className="f-num">{count}</span>}
                </button>
              );
            })}
            <Dropdown
              className={cx('filters-more', isExtraView && 'on')}
              value={isExtraView ? view : ''}
              onChange={v => updateParams({ view: v || null })}
              placeholder="更多状态"
              ariaLabel="更多状态筛选"
              options={[
                ...(isExtraView ? [{ value: '', label: '全部状态' }] : []),
                ...EXTRA_FILTERS.map(f => ({ value: f.id, label: f.label, hint: viewCounts?.[f.id] ?? 0 })),
              ]}
            />
          </div>
        </div>

        <div className="toolbar-group">
          <button
            type="button"
            className={cx('chip-toggle', cnOnly && 'on')}
            onClick={() => updateParams({ cn: cnOnly ? null : '1' })}
            title="只看 PS Store 标注有中文字幕或中文语音的游戏"
            aria-pressed={cnOnly}
          >
            {cnOnly && <Check size={12} strokeWidth={3} />}
            有中文
          </button>
          <button
            type="button"
            className={cx('chip-toggle', multiOnly && 'on')}
            onClick={() => updateParams({ multi: multiOnly ? null : '1' })}
            title="只看支持 2 人及以上同屏游玩的游戏"
            aria-pressed={multiOnly}
          >
            {multiOnly && <Check size={12} strokeWidth={3} />}
            多人同屏
          </button>

          <span className="toolbar-divider" aria-hidden="true" />

          <Dropdown
            className="dropdown-field"
            align="right"
            icon={<ArrowUpDown size={13} />}
            value={sort}
            onChange={v => updateParams({ sort: v === 'pan_first' ? null : v })}
            ariaLabel="排序方式"
            options={SORT_OPTIONS}
          />

          <span className="toolbar-divider" aria-hidden="true" />

          {failedCount > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => action.mutate({ action: 'retry_failed' })}
              disabled={action.isPending}
              title="重试所有抓取失败或转存失败的游戏"
            >
              <RotateCcw size={13} />
              重试失败 <span className="num opacity-70">{failedCount}</span>
            </button>
          )}
          <button
            type="button"
            className={cx('btn btn-sm toolbar-btn', batchMode && 'btn-primary')}
            onClick={() => {
              setBatchMode(v => !v);
              setSelected(new Set());
            }}
          >
            <CheckSquare size={14} />
            {batchMode ? '退出批量' : '批量管理'}
          </button>
        </div>
      </div>

      {notice && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-[#5fd3a0]/30 bg-[#5fd3a0]/10 px-4 py-2.5 text-[13px] text-[#5fd3a0]">
          <span>{notice}</span>
          <button className="text-xs underline opacity-80 hover:opacity-100" onClick={() => setNotice(null)}>
            知道了
          </button>
        </div>
      )}
      <ErrorNote error={action.error} />

      {batchMode && (
        <div className="sticky top-[72px] z-20 mb-5 flex flex-wrap items-center gap-2.5 rounded-xl border border-[#4d8bff]/40 bg-[#1a2232]/95 px-4 py-3 shadow-xl backdrop-blur">
          <span className="mr-1 text-[13px]">
            已选 <strong className="num text-[#4d8bff]">{selected.size}</strong> 款游戏
          </span>
          <button
            className="btn btn-sm"
            onClick={() =>
              setSelected(selected.size === rows.length ? new Set() : new Set(rows.map(r => r.post_id)))
            }
          >
            {selected.size === rows.length && rows.length > 0 ? '取消全选本页' : '全选本页'}
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={!selectedIds.length || action.isPending}
            onClick={() => action.mutate({ action: 'add', post_ids: selectedIds })}
          >
            <CloudDownload size={13} />
            加入网盘
          </button>
          <button
            className="btn btn-sm btn-danger"
            disabled={!selectedIds.length || action.isPending}
            onClick={() => setRemoving(selectedIds)}
          >
            <Trash2 size={13} />
            退出网盘（释放空间）
          </button>
          <button
            className="btn btn-sm"
            disabled={!selectedIds.length || action.isPending}
            onClick={() => action.mutate({ action: 'recrawl', post_ids: selectedIds })}
          >
            <Radar size={13} />
            重新采集
          </button>
          <button
            className="ml-auto text-xs text-muted hover:text-white"
            onClick={() => {
              setSelected(new Set());
              setBatchMode(false);
            }}
          >
            完成批量管理
          </button>
        </div>
      )}

      {games.isPending ? (
        <div className="shelf" aria-busy="true" aria-label="正在加载游戏库">
          {Array.from({ length: cols ? cols * 2 : 14 }, (_, i) => (
            <div key={i} className="tile-skel" aria-hidden="true">
              <div className="skel skel-art" />
              <div className="skel skel-line" />
              <div className="skel skel-line short" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 && setup.ready && !setup.done && !q ? (
        <div className="panel py-16">
          <Empty title="先完成初始设置">
            登录百度网盘、添加采集来源、确认转存目录，三步就能开始采集游戏。
            <div className="mt-4"><Link to="/settings" className="btn btn-primary">去设置（已完成 {setup.count}/3）</Link></div>
          </Empty>
        </div>
      ) : rows.length === 0 ? (
        <div className="panel py-16">
          <Empty title="没有找到匹配的游戏">
            {q ? '试试更换搜索关键词或清空顶部搜索框。' : '切换右上方的筛选条件查看其它状态的游戏。'}
          </Empty>
        </div>
      ) : (
        <div className="shelf" role="list">
          {rows.map(g => (
            <GameTile
              key={g.post_id}
              game={g}
              batchMode={batchMode}
              selected={selected.has(g.post_id)}
              onSelect={() => toggleSelect(g.post_id)}
              onOpen={() => setActivePostId(g.post_id)}
              onQuickAdd={() => action.mutate({ action: 'add', post_ids: [g.post_id] })}
              onQuickRemove={() => setRemoving([g.post_id])}
              onQuickCancel={() => action.mutate({ action: 'cancel_transfer', post_ids: [g.post_id] })}
              busy={action.isPending}
            />
          ))}
        </div>
      )}

      <div ref={probeRef} className="shelf shelf-probe" aria-hidden="true" />

      {pages > 1 && (
        <Pager
          page={page}
          pages={pages}
          total={total}
          pageSize={pageSize}
          queuedCount={queuedCount}
          onGo={goPage}
        />
      )}

      {activePostId && (
        <GameDrawer
          sourceId={sourceId}
          postId={activePostId}
          initialGame={activeGameFromList}
          quotaFree={acc?.quota?.free}
          onClose={() => setActivePostId(null)}
          onAdd={force => action.mutate({ action: 'add', post_ids: [activePostId], force })}
          onCancelTransfer={() => action.mutate({ action: 'cancel_transfer', post_ids: [activePostId] })}
          onRemove={() => setRemoving([activePostId])}
          onRecrawl={() => action.mutate({ action: 'recrawl', post_ids: [activePostId] })}
          onLinkAction={(act, surl, force) => action.mutate({ action: act, surls: [surl], force })}
          busy={action.isPending}
          onUpdated={refreshAll}
        />
      )}

      {removing && (
        <RemoveDialog
          sourceId={sourceId}
          postIds={removing}
          onClose={() => setRemoving(null)}
          onDone={msg => {
            setRemoving(null);
            setSelected(new Set());
            refreshAll();
            setNotice(msg);
          }}
        />
      )}

      {blocked && (
        <BlockedDialog
          items={blocked}
          busy={action.isPending}
          onClose={() => setBlocked(null)}
          onForce={() => {
            action.mutate({ action: 'add', post_ids: blocked.map(b => b.post_id), force: true });
            setBlocked(null);
          }}
        />
      )}
    </>
  );
}

function BlockedDialog({ items, busy, onClose, onForce }: { items: BlockedAdd[]; busy: boolean; onClose: () => void; onForce: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title={items.length > 1 ? `${items.length} 个游戏盘游标记过不能玩` : '盘游标记过这个游戏不能玩'}
      footer={
        <>
          <button className="btn" onClick={onClose}>不加了</button>
          <button className="btn btn-danger" disabled={busy} onClick={onForce}>仍然加入</button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p className="text-muted">
          要转存的分享和你在盘游里评过的那份资源是同一份（文件完全一样），转存下来多半还是玩不了。
          如果后来换了固件或者想再试一次，可以仍然加入。
        </p>
        <div className="max-h-[48vh] space-y-2 overflow-auto pr-1">
          {items.map(b => (
            <div key={b.post_id} className="rounded-lg border border-line bg-[#131a27] p-3">
              <div className="font-medium text-ink">{b.title}</div>
              <div className="mt-1 text-xs text-[#ff8a7a]">{reviewWhere(b.review)}标记{reviewVerdict(b.review)}</div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// 页码按钮：首尾页 + 当前页附近，中间用省略号
function pageItems(page: number, pages: number): (number | 'gap')[] {
  const set = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach(n => set.add(n));
  if (page >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach(n => set.add(n));
  const nums = [...set].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1] > 1) out.push(n - nums[i - 1] === 2 ? n - 1 : 'gap');
    out.push(n);
  });
  return out;
}

function Pager({
  page,
  pages,
  total,
  pageSize,
  queuedCount,
  onGo,
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  queuedCount: number;
  onGo: (n: number) => void;
}) {
  const [jump, setJump] = useState('');
  const submitJump = () => {
    const n = Number(jump);
    if (Number.isFinite(n) && n >= 1) onGo(n);
    setJump('');
  };
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <nav className="pager" aria-label="翻页">
      <span className="pager-info">
        第 <strong className="num text-ink">{from}–{to}</strong> 款，共 <strong className="num text-ink">{total}</strong> 款
        {queuedCount > 0 && ` · ${queuedCount} 款正在转存`}
      </span>

      <div className="pager-nav">
        <button type="button" className="pager-btn" disabled={page <= 1} onClick={() => onGo(1)} title="首页" aria-label="首页">
          <ChevronsLeft size={15} />
        </button>
        <button type="button" className="pager-btn" disabled={page <= 1} onClick={() => onGo(page - 1)} title="上一页" aria-label="上一页">
          <ChevronLeft size={15} />
        </button>
        {pageItems(page, pages).map((it, i) =>
          it === 'gap' ? (
            <span key={`gap${i}`} className="pager-gap">…</span>
          ) : (
            <button
              key={it}
              type="button"
              className={cx('pager-btn num', it === page && 'on')}
              aria-current={it === page ? 'page' : undefined}
              onClick={() => onGo(it)}
            >
              {it}
            </button>
          )
        )}
        <button type="button" className="pager-btn" disabled={page >= pages} onClick={() => onGo(page + 1)} title="下一页" aria-label="下一页">
          <ChevronRight size={15} />
        </button>
        <button type="button" className="pager-btn" disabled={page >= pages} onClick={() => onGo(pages)} title="尾页" aria-label="尾页">
          <ChevronsRight size={15} />
        </button>

        <form
          className="pager-jump"
          onSubmit={e => {
            e.preventDefault();
            submitJump();
          }}
        >
          跳至
          <input
            className="num"
            inputMode="numeric"
            value={jump}
            onChange={e => setJump(e.target.value.replace(/\D/g, ''))}
            placeholder={String(page)}
            aria-label="跳转页码"
          />
          页
          <button type="submit" className="pager-btn" disabled={!jump}>
            Go
          </button>
        </form>
      </div>
    </nav>
  );
}

function GameTile({
  game,
  batchMode,
  selected,
  onSelect,
  onOpen,
  onQuickAdd,
  onQuickRemove,
  onQuickCancel,
  busy,
}: {
  game: Game;
  batchMode: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onQuickAdd: () => void;
  onQuickRemove: () => void;
  onQuickCancel: () => void;
  busy: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setImgFailed(false);
  }, [game.cover_url]);

  const panState = getPanState(game);
  const isInPan = panState === 'in_pan';
  const isQueued = panState === 'queued';
  const isDim = !isInPan && !isQueued;

  const hue = hueFrom(game.serial || game.display_name || game.post_id);
  const [prefix, digits] = splitSerial(game.serial, game.post_id);
  const displayName = game.display_name || game.title || `游戏 #${game.post_id}`;
  const showCover = Boolean(game.cover_url) && !imgFailed;

  const handleClick = () => {
    if (batchMode) onSelect();
    else onOpen();
  };

  return (
    <div
      role="listitem"
      tabIndex={0}
      className={cx(
        'tile',
        isInPan && 'is-in-pan',
        isQueued && 'is-queued',
        isDim && 'is-dim',
        selected && 'is-selected'
      )}
      onClick={handleClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      <div className="art" style={{ '--hue': hue } as React.CSSProperties}>
        <div className="art-id">
          <span>{prefix}</span>
          <strong>{digits}</strong>
        </div>

        {showCover && (
          <img
            src={game.cover_url}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        )}

        {batchMode && (
          <div className="tile-check" aria-hidden="true">
            {selected && <Check size={14} strokeWidth={3} />}
          </div>
        )}

        {isInPan && (
          <span className="corner done">
            {game.pan_size ? bytes(game.pan_size) : '已入盘'}
          </span>
        )}
        {isQueued && <span className="corner live">转存中</span>}
        {game.review && !batchMode && <TileReview r={game.review} />}
        {panState === 'failed' && <span className="corner err">异常</span>}
        {panState === 'pending_detail' && <span className="corner warn">待抓详情</span>}

        {isQueued && (
          <div className="fill">
            <span className="w-2/5 animate-pulse" />
          </div>
        )}

        {!batchMode && (
          <>
            {isInPan ? (
              <button
                type="button"
                className="tile-quick-action remove"
                disabled={busy}
                onClick={e => {
                  e.stopPropagation();
                  onQuickRemove();
                }}
                title="从百度网盘移除以释放空间"
              >
                退出网盘
              </button>
            ) : isQueued ? (
              <button
                type="button"
                className="tile-quick-action"
                disabled={busy}
                onClick={e => {
                  e.stopPropagation();
                  onQuickCancel();
                }}
                title="取消转存排队"
              >
                取消排队
              </button>
            ) : (
              <button
                type="button"
                className="tile-quick-action add"
                disabled={busy || panState === 'no_link' || panState === 'pending_detail'}
                onClick={e => {
                  e.stopPropagation();
                  onQuickAdd();
                }}
                title="将此游戏转存加入百度网盘"
              >
                + 加入网盘
              </button>
            )}
          </>
        )}
      </div>

      <div className="tile-name" title={displayName}>
        {displayName}
      </div>

      <div className="tile-sub">
        <span className="plat">{game.platform || 'PS5'}</span>
        <span className="num">{game.serial || `#${game.post_id}`}</span>
        {(game.has_cn_sub || game.has_cn_voice) && (
          <span className="tile-cn" title={game.has_cn_voice ? '有中文语音' : '有中文字幕'}>中</span>
        )}
        {game.rating != null && (
          <span className="tile-rating" title={`PS Store 评分 ${game.rating}（${game.rating_count} 人评分）`}>
            ★ {game.rating.toFixed(1)}
          </span>
        )}
      </div>
    </div>
  );
}

function GameDrawer({
  sourceId,
  postId,
  initialGame,
  quotaFree,
  onClose,
  onAdd,
  onCancelTransfer,
  onRemove,
  onRecrawl,
  onLinkAction,
  busy,
  onUpdated,
}: {
  sourceId: string;
  postId: string;
  initialGame: Game | null;
  quotaFree?: number;
  onClose: () => void;
  onAdd: (force?: boolean) => void;
  onCancelTransfer: () => void;
  onRemove: () => void;
  onRecrawl: () => void;
  onLinkAction: (action: string, surl: string, force?: boolean) => void;
  busy: boolean;
  onUpdated: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const detail = useQuery({
    queryKey: ['game-detail', sourceId, postId],
    queryFn: () =>
      api.get<{ game: Game }>(`/games/detail?source_id=${encodeURIComponent(sourceId)}&post_id=${encodeURIComponent(postId)}`),
    enabled: !!sourceId && !!postId,
  });

  const game = detail.data?.game || initialGame;
  const [imgFailed, setImgFailed] = useState(false);
  const [customName, setCustomName] = useState('');
  const [copiedSurl, setCopiedSurl] = useState<string | null>(null);
  const [coverVersion, setCoverVersion] = useState(0);
  const [introOpen, setIntroOpen] = useState(false);

  useEffect(() => {
    if (game) {
      setCustomName(game.custom_name || '');
      setImgFailed(false);
    }
  }, [game?.post_id, game?.custom_name]);

  useEffect(() => setIntroOpen(false), [postId]);

  // 盘游评过同编号的游戏、但还没核对分享内容时，打开详情就列一遍分享看是不是同一份资源
  const needsCheck = !!detail.data?.game.reviews?.some(r => r.match === 'unknown');
  const checkReviews = useMutation({
    mutationFn: () => api.post<{ reviews: GameReview[]; reviews_checked: boolean; errors: string[] }>('/games/check-reviews', { source_id: sourceId, post_id: postId }),
    onSuccess: () => { detail.refetch(); onUpdated(); },
  });
  const checkedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!needsCheck || checkedFor.current === postId) return;
    checkedFor.current = postId;
    checkReviews.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsCheck, postId]);

  const refreshMeta = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; game?: Game }>('/games/meta-refresh', {
        source_id: sourceId,
        post_id: postId,
        concept_id: game?.concept_id,
      }),
    onSuccess: () => {
      setImgFailed(false);
      setCoverVersion(v => v + 1);
      detail.refetch();
      onUpdated();
    },
  });

  const renameMut = useMutation({
    mutationFn: (name: string) =>
      api.post<{ ok: boolean; game: Game }>('/games/rename', {
        source_id: sourceId,
        post_id: postId,
        name,
      }),
    onSuccess: () => {
      detail.refetch();
      onUpdated();
    },
  });

  if (!game) return null;

  const panState = getPanState(game);
  const isInPan = panState === 'in_pan';
  const isQueued = panState === 'queued';
  const knownBad = game.reviews?.find(r => r.match === 'this' && !r.playable);
  const hue = hueFrom(game.serial || game.display_name || game.post_id);
  const [prefix, digits] = splitSerial(game.serial, game.post_id);
  const coverSrc = game.cover_url
    ? `${game.cover_url}${coverVersion ? `${game.cover_url.includes('?') ? '&' : '?'}r=${coverVersion}` : ''}`
    : '';
  const hasCover = Boolean(coverSrc) && !imgFailed;

  const displayName = game.display_name || game.title || `游戏 #${game.post_id}`;
  const subTitle =
    game.en_title && game.en_title !== displayName
      ? game.en_title
      : game.store_name && game.store_name !== displayName
        ? game.store_name
        : '';

  const savedLink = game.links.find(l => l.status === 'saved' || l.status === 'exists');
  const panPath = game.pan_paths?.length ? game.pan_paths.join('、') : savedLink?.dest_dir || '';
  const preferredLink =
    savedLink ||
    game.links.find(l => l.status === 'available' || l.status === 'pending') ||
    game.links[0];
  const primaryFormat =
    preferredLink?.format && preferredLink.format !== 'unknown'
      ? FORMAT_LABELS[preferredLink.format]?.label
      : null;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={displayName}>
        <div className="drawer-hero">
          <div
            className="hero-backdrop"
            style={hasCover ? { backgroundImage: `url("${coverSrc}")` } : undefined}
          />

          {game.concept_id ? (
            <button
              type="button"
              className="drawer-refresh"
              onClick={() => refreshMeta.mutate()}
              disabled={refreshMeta.isPending}
              title="重新从 PlayStation 商店获取封面与中文简介"
            >
              <RefreshCw size={15} className={cx(refreshMeta.isPending && 'animate-spin')} />
            </button>
          ) : null}

          <button type="button" className="drawer-x" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>

          <div className="hero-main">
            <div className="art hero-art" style={{ '--hue': hue } as React.CSSProperties}>
              <div className="art-id">
                <span>{prefix}</span>
                <strong>{digits}</strong>
              </div>
              {hasCover && (
                <img
                  src={coverSrc}
                  alt=""
                  onError={() => setImgFailed(true)}
                />
              )}
            </div>

            <div className="hero-meta">
              <h2>{displayName}</h2>
              {subTitle && (
                <p className="hero-sub" title={subTitle}>
                  {subTitle}
                </p>
              )}
              <div className="facts">
                {isInPan ? (
                  <span className="ok">已在网盘</span>
                ) : isQueued ? (
                  <span className="live">转存排队中</span>
                ) : (
                  <span>未入盘</span>
                )}
                {game.serial && <span className="num">{game.serial}</span>}
                <span>{game.platform || 'PS5'}</span>
                {game.region && REGION_NAMES[game.region] && <span>{REGION_NAMES[game.region]}</span>}
                {primaryFormat && <span>{primaryFormat}</span>}
                {game.pan_size ? <span className="num">{bytes(game.pan_size)}</span> : null}
              </div>
            </div>
          </div>
        </div>

        <div className="drawer-body">
          {/* 核心网盘操作区：加入网盘 / 退出网盘 */}
          <section className={cx('install-box', isInPan && 'in-pan')}>
            {isInPan ? (
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[14px] font-semibold text-[#5fd3a0]">
                    <span className="size-2 rounded-full bg-[#5fd3a0]" />
                    已加入百度网盘
                  </div>
                  <div className="mt-1 break-all text-xs text-muted">
                    {panPath ? `路径：${panPath}` : '已在目标网盘目录中'}
                    {game.pan_size ? ` · 占用 ${bytes(game.pan_size)}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="cta danger shrink-0"
                  disabled={busy}
                  onClick={onRemove}
                >
                  <Trash2 size={15} />
                  退出网盘
                </button>
              </div>
            ) : isQueued ? (
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[14px] font-semibold text-[#7aa8ff]">
                    <span className="size-2 rounded-full bg-[#4d8bff] pulse" />
                    正在排队转存入盘…
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    后台转存完成后封面将自动点亮为亮色
                  </div>
                </div>
                <button
                  type="button"
                  className="cta ghost shrink-0"
                  disabled={busy}
                  onClick={onCancelTransfer}
                >
                  取消排队
                </button>
              </div>
            ) : knownBad && !game.links.some(l => l.status === 'available' && l.surl !== knownBad.surl) ? (
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[14px] font-semibold text-[#ff8a7a]">
                    <AlertTriangle size={15} />
                    盘游标记过这份资源不能玩
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {reviewWhere(knownBad)}标记{reviewVerdict(knownBad)}。分享里的文件和那次一模一样，自动转存会跳过它
                  </div>
                </div>
                <button type="button" className="cta ghost shrink-0" disabled={busy} onClick={() => onAdd(true)}>
                  仍然加入
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold text-[#e8edf5]">
                    尚未加入网盘（暗色状态）
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {game.links.length > 0
                      ? `共 ${game.links.length} 条百度盘分享${primaryFormat ? ` · 优选 ${primaryFormat}` : ''}`
                      : '当前暂无可用分享链接，可尝试重新采集'}
                    {quotaFree != null ? ` · 剩余空间 ${bytes(quotaFree)}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="cta shrink-0"
                  disabled={busy || game.links.length === 0}
                  onClick={() => onAdd()}
                >
                  <CloudDownload size={16} />
                  加入网盘
                </button>
              </div>
            )}
          </section>

          {!!game.reviews?.length && (
            <ReviewSection reviews={game.reviews} checking={checkReviews.isPending} checkErrors={checkReviews.data?.errors || []} />
          )}

          {/* 游戏介绍与规格 */}
          {(Number(game.concept_id) > 0 || game.description) && (
            <section className="intro">
              <h3 className="intro-title">游戏介绍</h3>
              {game.description ? (
                <>
                  <p className={cx('intro-text', !introOpen && 'is-clamped')}>{game.description}</p>
                  {game.description.length > 160 && (
                    <button type="button" className="intro-more" onClick={() => setIntroOpen(v => !v)}>
                      {introOpen ? '收起' : '展开全部'}
                    </button>
                  )}
                </>
              ) : game.meta_state === 'pending' || detail.isFetching || refreshMeta.isPending ? (
                <p className="intro-empty">正在从 PlayStation 商店获取游戏介绍…</p>
              ) : (
                <p className="intro-empty">
                  商店暂无这款游戏的介绍，可点右上角
                  <RefreshCw size={11} className="mx-1 inline align-[-1px]" />
                  重新获取。
                </p>
              )}

              {game.rating != null && (
                <div className="rating-box mb-3">
                  <div className="rating-score">
                    <strong>{game.rating.toFixed(2)}</strong>
                    <span>{(game.rating_count || 0).toLocaleString()} 人评分</span>
                  </div>
                  {game.rating_dist && (
                    <div className="rating-bars">
                      {game.rating_dist.map((pct, i) => (
                        <div key={i}>
                          <span>{5 - i}★</span>
                          <i><b style={{ width: `${pct}%` }} /></i>
                          <span className="text-right">{pct}%</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {(game.publisher || game.genres || game.release_date || game.screen_langs?.length) && (
                <dl className="specs">
                  {game.publisher && (
                    <div>
                      <dt>发行商</dt>
                      <dd>{game.publisher}</dd>
                    </div>
                  )}
                  {game.genres && (
                    <div>
                      <dt>类型</dt>
                      <dd>{game.genres}</dd>
                    </div>
                  )}
                  {game.release_date && (
                    <div>
                      <dt>发售日</dt>
                      <dd className="num">{game.release_date}</dd>
                    </div>
                  )}
                  {!!game.store_platforms?.length && (
                    <div>
                      <dt>平台</dt>
                      <dd>{game.store_platforms.join(' / ')}</dd>
                    </div>
                  )}
                  {game.edition && (
                    <div>
                      <dt>版本</dt>
                      <dd>{game.edition}{game.classification && game.classification !== 'FULL_GAME' ? `（${classLabel(game.classification)}）` : ''}</dd>
                    </div>
                  )}
                  {!!game.screen_langs?.length && (
                    <div>
                      <dt>字幕语言</dt>
                      <dd>{langLabels(game.screen_langs)}</dd>
                    </div>
                  )}
                  {!!game.spoken_langs?.length && (
                    <div>
                      <dt>语音语言</dt>
                      <dd>{langLabels(game.spoken_langs)}</dd>
                    </div>
                  )}
                  {game.players != null && (
                    <div>
                      <dt>本地玩家</dt>
                      <dd>{game.players > 1 ? `1–${game.players} 人` : '单人'}</dd>
                    </div>
                  )}
                  {(game.online_play || game.ps_plus_required || game.in_game_purchases) && (
                    <div>
                      <dt>联机与付费</dt>
                      <dd>
                        {[
                          game.online_play === 'REQUIRED' ? '需联网' : game.online_play === 'OPTIONAL' ? '可联机' : '',
                          game.ps_plus_required ? '联机需 PS Plus' : '',
                          game.in_game_purchases ? '含内购' : '',
                        ].filter(Boolean).join(' · ') || '—'}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
            </section>
          )}

          {/* 百度网盘分享链接明细 */}
          <section className="space-y-2">
            <div className="flex items-center justify-between text-xs font-medium text-muted">
              <span>百度网盘资源链接（{game.links.length}）</span>
              <div className="flex items-center gap-3">
                <a
                  href={game.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-white"
                >
                  <ExternalLink size={12} />
                  源站帖子 #{game.post_id}
                </a>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-white"
                  onClick={onRecrawl}
                  disabled={busy}
                >
                  <Radar size={12} />
                  重新采集
                </button>
              </div>
            </div>

            {game.links.length === 0 ? (
              <div className="rounded-lg border border-line bg-[#131a27] p-4 text-center text-xs text-muted">
                该帖子尚未提取到百度网盘链接，可点击右上角「重新采集」尝试。
              </div>
            ) : (
              <div className="divide-y divide-line rounded-lg border border-line bg-[#131a27]">
                {game.links.map(l => {
                  const st = linkStatus(l.status);
                  const href = `https://pan.baidu.com/s/${l.surl}${l.pwd ? `?pwd=${l.pwd}` : ''}`;
                  const fmt = l.format ? FORMAT_LABELS[l.format] : null;
                  return (
                    <div key={l.surl} className="p-3 text-xs space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-[#7aa8ff] hover:underline truncate"
                          >
                            {l.surl}
                          </a>
                          {l.pwd && (
                            <span className="font-mono text-muted">
                              提取码: <strong className="text-ink">{l.pwd}</strong>
                            </span>
                          )}
                          <button
                            type="button"
                            className="text-muted hover:text-white"
                            title="复制分享链接与提取码"
                            onClick={() => {
                              navigator.clipboard.writeText(`${href} 提取码: ${l.pwd || ''}`);
                              setCopiedSurl(l.surl);
                              setTimeout(() => setCopiedSurl(null), 1500);
                            }}
                          >
                            {copiedSurl === l.surl ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                          </button>
                        </div>
                        <Chip cls={st.cls}>{st.label}</Chip>
                      </div>

                      {(fmt || l.remark) && (
                        <div className="flex flex-wrap items-center gap-1.5 text-muted">
                          {fmt && l.format !== 'unknown' && <Chip cls={fmt.cls}>{fmt.label}</Chip>}
                          {l.remark && <span className="break-all">{l.remark}</span>}
                        </div>
                      )}

                      {(() => {
                        const r = game.reviews?.find(x => x.surl === l.surl);
                        return r ? (
                          <div className={cx('text-[11px]', r.playable ? 'text-ok' : 'text-bad')}>
                            盘游评过这份：{reviewVerdict(r)}
                          </div>
                        ) : null;
                      })()}

                      <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px] text-muted">
                        {(() => {
                          const text = l.transferred_at
                            ? `转存于 ${dateTime(l.transferred_at)} → ${(l.status === 'saved' || l.status === 'exists') && panPath ? panPath : l.dest_dir}`
                            : l.last_error || '';
                          return <span className="min-w-0 break-all">{text}</span>;
                        })()}
                        <div className="flex shrink-0 items-center gap-1.5">
                          {l.status !== 'saved' && l.status !== 'exists' && (
                            <button
                              type="button"
                              className="btn btn-sm h-6! px-2! text-[11px]!"
                              disabled={busy}
                              title={l.status === 'bad' ? '盘游标记过这份资源不能玩，仍然转存它' : undefined}
                              onClick={() => onLinkAction('transfer', l.surl, l.status === 'bad' || undefined)}
                            >
                              {l.status === 'bad' ? '仍然转存' : '单独转存'}
                            </button>
                          )}
                          {l.status === 'skipped' ? (
                            <button
                              type="button"
                              className="btn btn-sm h-6! px-2! text-[11px]!"
                              disabled={busy}
                              onClick={() => onLinkAction('unskip', l.surl)}
                            >
                              <Undo2 size={10} />
                              取消跳过
                            </button>
                          ) : l.status !== 'saved' && l.status !== 'exists' ? (
                            <button
                              type="button"
                              className="btn btn-sm h-6! px-2! text-[11px]!"
                              disabled={busy}
                              onClick={() => onLinkAction('skip', l.surl)}
                            >
                              <SkipForward size={10} />
                              跳过
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 自定义名称编辑器 */}
          <details className="rounded-lg border border-line bg-[#131a27] px-3.5 py-2.5 text-xs">
            <summary className="cursor-pointer font-medium text-muted select-none hover:text-white">
              自定义显示名称
            </summary>
            <div className="mt-3 space-y-2.5">
              <div>
                <span className="mb-1 block text-muted">
                  显示名称（留空使用自动名称：{game.auto_name || game.cn_title}）
                </span>
                <input
                  className="field h-8! text-xs!"
                  value={customName}
                  placeholder={game.auto_name || ''}
                  onChange={e => setCustomName(e.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2">
                {game.custom_name && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={renameMut.isPending}
                    onClick={() => {
                      setCustomName('');
                      renameMut.mutate('');
                    }}
                  >
                    恢复自动名称
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={renameMut.isPending}
                  onClick={() => renameMut.mutate(customName)}
                >
                  保存名称
                </button>
              </div>
            </div>
          </details>
        </div>
      </aside>
    </>
  );
}

const MATCH_LABEL: Record<GameReview['match'], string> = {
  this: '就是这里的资源',
  other: '另一份资源',
  unknown: '同一个游戏',
};

function ReviewSection({ reviews, checking, checkErrors }: { reviews: GameReview[]; checking: boolean; checkErrors: string[] }) {
  const unknown = reviews.some(r => r.match === 'unknown');
  return (
    <section className="intro">
      <h3 className="intro-title">盘游评价</h3>
      <div className="space-y-2">
        {reviews.map(r => (
          <div key={r.fingerprint} className={cx('review-item', r.playable ? 'ok' : 'bad', r.match === 'other' && 'other')}>
            <div className="flex items-center gap-2">
              <strong>{r.playable ? '能正常玩' : '不能玩'}</strong>
              <span className="review-match">{MATCH_LABEL[r.match]}</span>
              <span className="ml-auto text-[11px] text-muted">{reviewWhere(r)}</span>
            </div>
            {(r.note || r.firmware || (r.match !== 'this' && r.name)) && (
              <div className="mt-1 text-xs text-[#c3ccdb]">
                {[r.note, r.firmware && `固件 ${r.firmware}`, r.match !== 'this' && r.name && `评的是「${r.name}」`].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        ))}
      </div>
      {unknown && (
        <p className="intro-empty">
          {checking
            ? '正在核对分享里的文件，看是不是评过的那份…'
            : checkErrors.length
              ? `没能列出分享里的文件，暂时认不出是不是评过的那份（${checkErrors[0]}）`
              : '评价里没有记分卷信息，认不出是不是这份资源；在盘游里打开一次这个游戏的详情就会补上'}
        </p>
      )}
    </section>
  );
}

export function RemoveDialog({
  sourceId,
  postIds,
  onClose,
  onDone,
}: {
  sourceId: string;
  postIds: string[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const preview = useQuery({
    queryKey: ['remove-preview', sourceId, postIds],
    queryFn: () =>
      api.post<{ games: RemovalPreview[] }>('/games/remove-preview', {
        source_id: sourceId,
        post_ids: postIds,
      }),
    gcTime: 0,
    staleTime: 0,
  });

  const list = preview.data?.games || [];
  const found = list.filter(g => g.targets.length > 0);
  const missing = list.filter(g => g.missing);
  const skipped = list.length - found.length - missing.length;
  const totalBytes = found.reduce(
    (s, g) => s + g.targets.reduce((t, x) => t + (x.size || 0), 0),
    0
  );
  const unknownSize = found.some(g => g.targets.some(t => t.size == null));

  const run = useMutation({
    mutationFn: (resetOnly: boolean) =>
      api.post<{ job?: Job; reset?: number }>('/games/remove', {
        source_id: sourceId,
        post_ids: resetOnly ? postIds : [...found, ...missing].map(g => g.post_id),
        reset_only: resetOnly,
      }),
    onSuccess: (r, resetOnly) => {
      if (resetOnly) {
        onDone(`已将 ${r.reset || postIds.length} 款游戏标记回「未入盘」（暗色状态）`);
      } else if (r.job) {
        onDone(
          `退出网盘任务 #${r.job.id} 已启动，网盘文件将移入百度网盘回收站（要求安全验证时移到 /盘架待删除），游戏恢复为暗色「未入盘」状态`
        );
      } else {
        onDone('已退出网盘并恢复为「未入盘」状态');
      }
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="退出网盘（释放网盘空间）"
      width="max-w-2xl"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          {preview.error && (
            <button
              className="btn btn-danger"
              disabled={run.isPending}
              onClick={() => run.mutate(true)}
            >
              仅重置为「未入盘」状态
            </button>
          )}
          <button
            className="btn btn-danger bg-[#ff8a7a]! text-[#131a27]! font-semibold!"
            disabled={!(found.length + missing.length) || run.isPending}
            onClick={() => run.mutate(false)}
          >
            <Trash2 size={14} />
            {found.length > 0 && (
              <>
                确认从网盘删除 {found.length} 款游戏
                {totalBytes > 0 && `（释放约 ${bytes(totalBytes)}${unknownSize ? '+' : ''}）`}
              </>
            )}
            {found.length > 0 && missing.length > 0 && '，'}
            {missing.length > 0 && `${found.length ? '' : '将 '}${missing.length} 款恢复为未入盘`}
          </button>
        </>
      }
    >
      {preview.isLoading && (
        <div className="py-8 text-center text-muted">
          正在扫描百度网盘目录，定位这些游戏的文件夹与占用空间…
        </div>
      )}
      <ErrorNote error={preview.error || run.error} />
      {preview.data && (
        <div className="space-y-3 text-[13px]">
          <p className="text-muted">
            按游戏编号（Title ID）在网盘目录中找到以下文件夹。确认后将从网盘删除并移入百度网盘回收站；游戏本身仍保留在封面墙上并变为
            <strong className="text-ink">暗色（未入盘）</strong>，以后随时可以再次加入网盘。
            如果百度要求安全验证、不能直接删除，会改为移到网盘根目录的 <span className="font-mono">/盘架待删除</span>，需要你在百度网盘 App 里删除它才会释放空间。
          </p>
          <div className="max-h-[48vh] space-y-2 overflow-auto pr-1">
            {list.map(g => (
              <div key={g.post_id} className="rounded-lg border border-line bg-[#131a27] p-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-ink">{g.title || `#${g.post_id}`}</span>
                  {g.serial && <span className="num font-mono text-xs text-muted">{g.serial}</span>}
                </div>
                {g.targets.map(t => (
                  <div key={t.path} className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                    {t.isdir ? <Folder size={13} className="text-[#4d8bff]" /> : <File size={13} />}
                    <span className="truncate font-mono">{t.path}</span>
                    <span className="num ml-auto shrink-0 text-ink">
                      {t.size != null ? bytes(t.size) : '大小待统计'}
                    </span>
                  </div>
                ))}
                {g.problem && (
                  <div
                    className={cx(
                      'mt-1.5 flex items-center gap-1.5 text-xs',
                      g.missing ? 'text-muted' : 'text-warn'
                    )}
                  >
                    <AlertTriangle size={13} className="shrink-0" />
                    <span>{g.problem}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          {missing.length > 0 && (
            <p className="text-xs text-muted">
              注：有 {missing.length} 款游戏在网盘目录中未找到对应文件夹（可能已被手动清理），确认后将直接把状态恢复为「未入盘」。
            </p>
          )}
          {skipped > 0 && (
            <p className="text-xs text-warn">
              有 {skipped} 款游戏无法自动匹配网盘目录，请根据上方提示检查。
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
