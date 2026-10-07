/**
 * 岗位页 v2（WP241，设计稿 `docs/design/position`，docs/54 §7）：**先急后缓**。
 *
 * 页头（图标 + 名字 + 一行能点的状态；右边「⋯ 岗位设置」；真缺必需连接时一行细横幅）
 * → 三个页签：**工作**（默认）/ 记录 / 设置。
 *
 * 工作页签从上往下：
 * 1. 交给它：一行输入，聚焦才展开（提交 / 路由沿用 54 §2、WP237）；
 * 2. 要你处理 = 首页那副牌钉在这个岗位上（`DeckSection` 原样，37 §1）——**唯一要你决定的地方**；
 * 3. 工作 = AI 在做什么、做到哪（`GET /v1/positions/:id/work`），不放决定按钮；
 * 4. 数据看板：每条职责几个数，「看图表」才展开原来的面板。
 *
 * 老地址兼容（只加不删）：`?tab=cards` → 工作（卡片流）；`?tab=view` → 工作，数据看板展开图表，
 * 职责有「面板」类快捷视图（红人工作台 / B2B / 在线客服）就打开它（`&kol=` 那几条链接照旧落到红人工作台）；
 * `?tab=memory` → 设置 · 记忆。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2Off, MoreHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { DeckSection } from '@/components/deck'
import { DataBoard } from '@/components/position/data-board'
import { PositionHandoff } from '@/components/position/position-handoff'
import { PositionSettings } from '@/components/position/position-settings'
import { WorkSection } from '@/components/position/work-section'
import { PositionIcon } from '@/components/role-icons/role-icon'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  getPosition,
  getPositionConnections,
  getPositionRecords,
  getPositions,
  getPositionWork,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'
import { approvalStateLabel } from '@/lib/humanize'
import {
  loadWorkPrefs,
  NO_FILTERS,
  PANEL_QUICK_KINDS,
  quickViewsOf,
  saveWorkPrefs,
  type WorkPrefs,
} from '@/lib/position-work'
import { assignmentForPosition, myAssignments } from '@/lib/positions'
import { matterUrl } from '@/lib/work'

// 老入口与别处还从这里拿它（WP138）；实现挪到了数据看板
export { NoRangeNotice } from '@/components/position/data-board'

type TabId = 'work' | 'records' | 'settings'

/** 滚到某一块（jsdom 没有 `scrollIntoView`，所以可选调用）。 */
function scrollTo(el: HTMLElement | null): void {
  el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

/** 老地址 `?tab=` → 新页签（只加不删：老链接照样能用）。 */
function tabOf(raw: string | null): TabId {
  if (raw === 'records') return 'records'
  if (raw === 'settings' || raw === 'memory') return 'settings'
  return 'work'
}

function RecordRows({ id }: { id: string }): React.ReactNode {
  const { t, lang } = useApp()
  const records = useQuery({ queryKey: ['records', id], queryFn: () => getPositionRecords(id) })
  if (records.isPending) return <Skeleton className="h-40 w-full" />
  const rows = records.data?.payload?.rows ?? []
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">—</p>
  return (
    <ol className="flex flex-col gap-3" data-testid="records">
      {rows.map((row) => (
        <li key={row.id} className="border-l pl-3">
          <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
            <time dateTime={row.at}>{formatDate(row.at, lang)}</time>
            <span>{t(`kind.${row.kind}`)}</span>
            <span>{approvalStateLabel(row.state, lang)}</span>
          </div>
          <div className="text-sm">{row.title}</div>
          <p className="text-xs text-muted-foreground">{row.summary}</p>
        </li>
      ))}
    </ol>
  )
}

export function PositionPage(): React.ReactNode {
  const { t, lang, selectPosition, position } = useApp()
  const params = useParams<{ id: string }>()
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const id = params.id ?? ''
  const rawTab = search.get('tab')
  const tab = tabOf(rawTab)

  // WP70：当前分配跟着**岗位**走，所以要知道这条 id 属于哪个岗位（左栏那份就够）
  const mine = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const entry = mine.data?.instances?.find((p) => myAssignments(p).includes(id))
  const deckIds = entry === undefined ? [id] : myAssignments(entry)
  const here = mine.data?.positions.find((p) => p.position_id === id)
  const ownerAssignment = (mine.data?.positions ?? []).find(
    (p) => p.role_id === 'common.owner',
  )?.position_id

  /*
   * 进岗位页就把当前 Assignment 切过去（31 §3.1 一次请求一个 Assignment）。
   * WP70（54 §4）：切的粒度是**岗位**——当前分配已经属于这个岗位就不动它。
   */
  useEffect(() => {
    if (id === '') return
    const next = assignmentForPosition(mine.data?.instances, id, position)
    if (next !== position) selectPosition(next)
  }, [id, mine.data?.instances, position, selectPosition])

  const instance = useQuery({
    queryKey: ['position-instance', id],
    queryFn: () => getPosition(id),
    enabled: id !== '',
  })
  const work = useQuery({
    queryKey: ['position-work', id],
    queryFn: () => getPositionWork(id),
    enabled: id !== '',
  })
  const connections = useQuery({
    queryKey: ['position-connections', id],
    queryFn: () => getPositionConnections(id),
    enabled: id !== '',
  })
  const view = instance.data

  /*
   * 本人在这个岗位做的几条职责：岗位实体里本人那几条；地址栏这一条万一不在里面
   * （老服务端 / 没装岗位面），就用左栏那份补上——这一条永远在。
   */
  const duties = useMemo(() => {
    const out = (view?.roles ?? []).flatMap((r) =>
      r.my_assignment_id === undefined
        ? []
        : [{ role_id: r.role_id, role_name: r.role_name, assignment_id: r.my_assignment_id }],
    )
    if (here !== undefined && !out.some((d) => d.assignment_id === here.position_id))
      out.push({
        role_id: here.role_id,
        role_name: here.role_name,
        assignment_id: here.position_id,
      })
    return out
  }, [view, here])
  const quickViews = useMemo(() => quickViewsOf(duties), [duties])
  const boardDuties = duties.map((d) => {
    const summary = mine.data?.positions.find((p) => p.position_id === d.assignment_id)
    return summary === undefined ? d : { ...d, ranges: summary.ranges }
  })

  // ── 工作的看法：记在这个岗位上（本机） ──
  const prefsKey = view?.position_id ?? id
  const [prefs, setPrefsState] = useState<WorkPrefs>(() => loadWorkPrefs(prefsKey))
  useEffect(() => {
    setPrefsState(loadWorkPrefs(prefsKey))
  }, [prefsKey])
  const setPrefs = useCallback(
    (next: WorkPrefs, persist = true): void => {
      setPrefsState(next)
      if (persist) saveWorkPrefs(prefsKey, next)
    },
    [prefsKey],
  )
  const [charts, setCharts] = useState(rawTab === 'view')

  // 老地址 `?tab=view`：图表展开；「面板」类快捷视图（`kol=` 指名就是红人工作台）打开——不记进偏好
  const legacyView = rawTab === 'view'
  const kolParam = search.get('kol')
  useEffect(() => {
    if (!legacyView || quickViews.length === 0) return
    const panel =
      quickViews.find((q) => kolParam !== null && q.kind === 'kol') ??
      quickViews.find((q) => (PANEL_QUICK_KINDS as readonly string[]).includes(q.kind))
    if (panel !== undefined) setPrefsState((p) => ({ ...p, view: panel.id }))
  }, [legacyView, kolParam, quickViews])

  // 卡片流翻到哪张（工作行尾「N 张卡等你」点过来的）
  const [focus, setFocus] = useState<{ card_id: string; nonce: number } | undefined>(undefined)
  const deckRef = useRef<HTMLDivElement | null>(null)
  const workRef = useRef<HTMLDivElement | null>(null)
  const boardRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (rawTab === 'view') scrollTo(boardRef.current)
  }, [rawTab])

  const setTab = (next: string): void => {
    setSearch((prev) => {
      const p = new URLSearchParams(prev)
      p.set('tab', next)
      return p
    })
  }

  const counts = work.data?.counts
  const pending = view?.pending_cards ?? 0
  const missing = new Set(connections.data?.missing_required ?? [])
  const missingItems = (connections.data?.items ?? []).filter(
    (i) => i.required && missing.has(i.kind),
  )
  const firstMissing = missingItems[0]
  // 新岗位、什么都还没有：交给它放大当主角（`position-v2-empty.html`）
  const fresh =
    view !== undefined && work.data !== undefined && work.data.items.length === 0 && pending === 0

  const refreshWork = (): void => {
    void client.invalidateQueries({ queryKey: ['position-work'] })
    void client.invalidateQueries({ queryKey: ['position-instance', id] })
  }

  return (
    <div
      className="mx-auto flex w-full max-w-[780px] flex-col gap-4"
      data-testid="position-page"
      data-position={id}
    >
      {/* ── 页头 ── */}
      <header className="flex items-start gap-3" data-testid="position-header">
        {view === undefined ? null : (
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-ws-surface">
            <PositionIcon
              position_id={view.position_id}
              icon={view.icon}
              role_ids={view.roles.map((r) => r.role_id)}
              size={22}
              selected
            />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="ws-display truncate text-[26px] leading-tight" data-testid="position-name">
            {view === undefined
              ? (here?.role_name ?? '')
              : lang === 'en'
                ? view.name.en
                : view.name.zh}
          </h1>
          {view === undefined ? null : fresh ? (
            <p className="text-xs text-ws-muted-fg" data-testid="position-status">
              {t('pos2.status.new', { n: view.roles.length })}
            </p>
          ) : (
            <p
              className="flex flex-wrap items-center gap-x-1.5 text-xs text-ws-muted-fg"
              data-testid="position-status"
            >
              <button
                type="button"
                data-testid="status-cards"
                className="inline-flex items-center gap-1 hover:text-foreground"
                onClick={() => {
                  setTab('work')
                  scrollTo(deckRef.current)
                }}
              >
                <span className="size-1.5 rounded-full bg-ws-warn" aria-hidden />
                {t('pos2.status.cards', { n: pending })}
              </button>
              <span aria-hidden>·</span>
              <button
                type="button"
                data-testid="status-doing"
                className="inline-flex items-center gap-1 hover:text-foreground"
                onClick={() => {
                  setTab('work')
                  setPrefs(
                    { ...prefs, view: 'list', filters: { ...NO_FILTERS, group: ['doing'] } },
                    false,
                  )
                  scrollTo(workRef.current)
                }}
              >
                <span className="size-1.5 rounded-full bg-ws-good" aria-hidden />
                {t('pos2.status.doing', { n: counts?.doing ?? view.open_matters })}
              </button>
              {/* WP244：卡住了的单独说出来（点了筛到「卡住了」那一组） */}
              {counts?.stuck === undefined || counts.stuck === 0 ? null : (
                <>
                  <span aria-hidden>·</span>
                  <button
                    type="button"
                    data-testid="status-stuck"
                    className="inline-flex items-center gap-1 text-ws-warn hover:text-foreground"
                    onClick={() => {
                      setTab('work')
                      setPrefs(
                        { ...prefs, view: 'list', filters: { ...NO_FILTERS, group: ['stuck'] } },
                        false,
                      )
                      scrollTo(workRef.current)
                    }}
                  >
                    <span className="size-1.5 rounded-full bg-ws-warn" aria-hidden />
                    {t('pos2.status.stuck', { n: counts.stuck })}
                  </button>
                </>
              )}
              {counts === undefined || counts.todos_today === 0 ? null : (
                <>
                  <span aria-hidden>·</span>
                  <button
                    type="button"
                    data-testid="status-today"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => {
                      setTab('work')
                      // WP248（决策 79）：数里含已过期的，筛选也用「今天及已过期」
                      setPrefs(
                        { ...prefs, view: 'list', filters: { ...NO_FILTERS, due: 'by_today' } },
                        false,
                      )
                      scrollTo(workRef.current)
                    }}
                  >
                    <span
                      className={`size-1.5 rounded-full ${(counts.todos_overdue ?? 0) > 0 ? 'bg-ws-bad' : 'bg-ws-info'}`}
                      aria-hidden
                    />
                    {(counts.todos_overdue ?? 0) > 0
                      ? t('pos2.status.today_overdue', {
                          n: counts.todos_today,
                          m: counts.todos_overdue ?? 0,
                        })
                      : t('pos2.status.today', { n: counts.todos_today })}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
        <button
          type="button"
          data-testid="position-settings-link"
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs hover:bg-accent"
          onClick={() => {
            setTab('settings')
          }}
        >
          <MoreHorizontal className="size-4" aria-hidden />
          {t('pos2.settings')}
        </button>
      </header>

      {/* WP238：只在真缺**必需**的连接时出一行；补上了自己消失 */}
      {firstMissing === undefined ? null : (
        <div
          className="flex items-center gap-2 rounded-lg bg-ws-warn-bg px-3 py-2 text-sm"
          data-testid="position-missing-banner"
          data-slot="status"
        >
          <Link2Off className="size-4 shrink-0 text-ws-warn" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {t('pos2.banner.missing', {
              names: missingItems.map((i) => (lang === 'en' ? i.name.en : i.name.zh)).join('、'),
            })}
          </span>
          {firstMissing.connect_service === undefined ? null : (
            <Link
              to={`/connections?service=${encodeURIComponent(firstMissing.connect_service)}`}
              className="shrink-0 rounded-md bg-card px-2 py-0.5 text-xs font-medium shadow-xs hover:bg-accent"
              data-testid="position-missing-go"
            >
              {t('pos2.banner.go')}
            </Link>
          )}
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="work">{t('pos2.tab.work')}</TabsTrigger>
          <TabsTrigger value="records">{t('pos2.tab.records')}</TabsTrigger>
          <TabsTrigger value="settings">{t('pos2.tab.settings')}</TabsTrigger>
        </TabsList>

        <TabsContent value="work" className="flex flex-col gap-7 pt-2">
          {view === undefined ? null : <PositionHandoff id={id} view={view} hero={fresh} />}

          <div
            ref={deckRef}
            className="flex scroll-mt-4 flex-col gap-2"
            data-testid="position-deck"
          >
            <h3 className="flex items-center gap-2">
              <span className="ws-display text-[17px]">{t('pos2.deck.title')}</span>
              {pending === 0 ? null : (
                <span className="ws-num text-xs text-ws-muted-fg">
                  {t('pos2.deck.count', { n: pending })}
                </span>
              )}
              <Hint text={t('pos2.deck.hint')} />
            </h3>
            {fresh ? (
              <p className="text-sm text-muted-foreground" data-testid="position-deck-empty">
                ✓ {t('pos2.deck.empty')}
              </p>
            ) : (
              /*
               * 37 §1：与首页同一副牌，只是钉死在这个岗位上（原样，不另画样式）。
               * WP141：合的是本人在这个岗位下的每一条职责——与页头「N 张等你定」同一个口径。
               */
              <DeckSection
                positionId={id}
                positionIds={deckIds}
                {...(focus === undefined ? {} : { focus })}
                onOpen={(card) => {
                  navigate(matterUrl(card))
                }}
              />
            )}
          </div>

          <div ref={workRef} className="scroll-mt-4">
            <WorkSection
              data={work.data}
              pending={work.isPending}
              error={work.error}
              quickViews={quickViews}
              prefs={prefs}
              onPrefs={(next) => {
                setPrefs(next)
              }}
              onJump={(card_id) => {
                setFocus({ card_id, nonce: Date.now() })
                scrollTo(deckRef.current)
              }}
              onRefresh={refreshWork}
            />
          </div>

          <div ref={boardRef} className="scroll-mt-4">
            <DataBoard
              duties={boardDuties}
              expanded={charts}
              onExpanded={setCharts}
              owner={ownerAssignment}
              empty={fresh}
            />
          </div>
        </TabsContent>

        <TabsContent value="records" className="pt-2">
          <RecordRows id={id} />
        </TabsContent>

        <TabsContent value="settings" className="pt-2">
          <PositionSettings id={id} view={view} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
