/**
 * 岗位页 v2（WP241，设计稿 `docs/design/position`，docs/54 §7）：**先急后缓**。
 *
 * 页头（图标 + 名字 + 连接正常时一个绿勾；右边「⋯ 岗位设置」；出问题时才一行醒目提示）
 * → 直接是工作（WP288，决策 326：没有「工作 / 记录 / 设置」页签了——记录在第三栏「记录」，
 * 设置走右上「⋯ 岗位设置」，点了这一页换成设置、再点「返回」回来）。
 *
 * 工作从上往下：
 * 1. 交给它：一行输入，聚焦才展开（提交 / 路由沿用 54 §2、WP237）；
 * 2. 要你处理 = 首页那副牌钉在这个岗位上（`DeckSection` 原样，37 §1）——**唯一要你决定的地方**；
 * 3. 工作 = AI 在做什么、做到哪（`GET /v1/positions/:id/work`），不放决定按钮；
 * 4. 数据看板：每条职责几个数，「看图表」才展开原来的面板。
 *
 * 老地址兼容（只加不删）：`?tab=cards` → 工作（卡片流）；`?tab=view` → 工作，数据看板展开图表，
 * 职责有「面板」类快捷视图（红人工作台 / B2B / 在线客服）就打开它（`&kol=` 那几条链接照旧落到红人工作台）；
 * `?tab=memory` / `?tab=settings` → 岗位设置；`?tab=records` → 工作 + 第三栏打开「记录」。
 *
 * WP288：标题下那行「N 张等你定 · N 件在办」去掉（下面「要你处理 N」就是它）；卡住了 / 今天的待办
 * 这两样有才出（它们是要人留意的事，点了筛到下面「工作」那一组）。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Link2Off, MoreHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ModeNotice } from '@/components/company/company-mode'
import { DeckSection } from '@/components/deck'
import { HandoffNotices } from '@/components/peers/handoff-strip'
import { ConnectionTick } from '@/components/position/connection-tick'
import { DataBoard } from '@/components/position/data-board'
import { PositionHandoff } from '@/components/position/position-handoff'
import { PositionSettings } from '@/components/position/position-settings'
import { ShopAdminBanner } from '@/components/position/shop-admin-banner'
import { SiteThemeBanner } from '@/components/position/site-theme-banner'
import { WorkSection } from '@/components/position/work-section'
import { useRailState } from '@/components/rail/rail-state'
import { PositionIcon } from '@/components/role-icons/role-icon'
import { Hint } from '@/components/ui/hint'
import { getPosition, getPositionConnections, getPositions, getPositionWork } from '@/lib/api'
import { useApp } from '@/lib/app-context'
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

type View = 'work' | 'settings'

/** 滚到某一块（jsdom 没有 `scrollIntoView`，所以可选调用）。 */
function scrollTo(el: HTMLElement | null): void {
  el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

/** 老地址 `?tab=` → 这一页看工作还是设置（只加不删：老链接照样能用）。 */
function viewOf(raw: string | null): View {
  return raw === 'settings' || raw === 'memory' ? 'settings' : 'work'
}

export function PositionPage(): React.ReactNode {
  const { t, lang, selectPosition, position } = useApp()
  const params = useParams<{ id: string }>()
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const id = params.id ?? ''
  const rawTab = search.get('tab')
  const tab = viewOf(rawTab)
  const rail = useRailState()

  // WP70：当前分配跟着**岗位**走，所以要知道这条 id 属于哪个岗位（左栏那份就够）
  const mine = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const entry = mine.data?.instances?.find((p) => myAssignments(p).includes(id))
  const deckIds = entry === undefined ? [id] : myAssignments(entry)
  const here = mine.data?.positions.find((p) => p.position_id === id)
  /** WP278：只有一个岗位（首页就是这一页，与首页跳转同一个判据）。 */
  const sole = entry !== undefined && mine.data?.instances?.length === 1
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

  const setTab = (next: View): void => {
    setSearch((prev) => {
      const p = new URLSearchParams(prev)
      if (next === 'work') p.delete('tab')
      else p.set('tab', next)
      return p
    })
  }
  // WP288：老地址 `?tab=records` → 记录在第三栏了，打开它（地址栏收回到工作）
  useEffect(() => {
    if (rawTab !== 'records') return
    rail.show('records')
    setSearch(
      (prev) => {
        const p = new URLSearchParams(prev)
        p.delete('tab')
        return p
      },
      { replace: true },
    )
  }, [rawTab, rail, setSearch])

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

  /** 卡住了 / 今天的待办：有才出（点了筛到下面「工作」那一组）。 */
  const stuck = counts?.stuck ?? 0
  const today = counts?.todos_today ?? 0
  const filterWork = (filters: WorkPrefs['filters']): void => {
    setTab('work')
    setPrefs({ ...prefs, view: 'list', filters }, false)
    scrollTo(workRef.current)
  }

  return (
    <div
      className="mx-auto flex w-full max-w-[780px] flex-col gap-4"
      data-testid="position-page"
      data-position={id}
      data-view={tab}
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
          <div className="flex min-w-0 items-center gap-2">
            <h1
              className="ws-display truncate text-[26px] leading-tight"
              data-testid="position-name"
            >
              {view === undefined
                ? (here?.role_name ?? '')
                : lang === 'en'
                  ? view.name.en
                  : view.name.zh}
            </h1>
            {/* WP288：连接正常 = 一个绿勾（悬停说连了什么、点了去连接页）；出问题时不画，下面出提示行 */}
            <ConnectionTick id={id} duties={duties} />
          </div>
          {view === undefined ? null : fresh ? (
            <p className="text-xs text-ws-muted-fg" data-testid="position-status">
              {t('pos2.status.new', { n: view.roles.length })}
            </p>
          ) : stuck === 0 && today === 0 ? null : (
            <p
              className="flex flex-wrap items-center gap-x-1.5 text-xs text-ws-muted-fg"
              data-testid="position-status"
            >
              {/* WP244：卡住了的单独说出来（点了筛到「卡住了」那一组） */}
              {stuck === 0 ? null : (
                <button
                  type="button"
                  data-testid="status-stuck"
                  className="inline-flex items-center gap-1 text-ws-warn hover:text-foreground"
                  onClick={() => {
                    filterWork({ ...NO_FILTERS, group: ['stuck'] })
                  }}
                >
                  <span className="size-1.5 rounded-full bg-ws-warn" aria-hidden />
                  {t('pos2.status.stuck', { n: stuck })}
                </button>
              )}
              {stuck === 0 || today === 0 ? null : <span aria-hidden>·</span>}
              {counts === undefined || today === 0 ? null : (
                <button
                  type="button"
                  data-testid="status-today"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  onClick={() => {
                    // WP248（决策 79）：数里含已过期的，筛选也用「今天及已过期」
                    filterWork({ ...NO_FILTERS, due: 'by_today' })
                  }}
                >
                  <span
                    className={`size-1.5 rounded-full ${(counts.todos_overdue ?? 0) > 0 ? 'bg-ws-bad' : 'bg-ws-info'}`}
                    aria-hidden
                  />
                  {(counts.todos_overdue ?? 0) > 0
                    ? t('pos2.status.today_overdue', {
                        n: today,
                        m: counts.todos_overdue ?? 0,
                      })
                    : t('pos2.status.today', { n: today })}
                </button>
              )}
            </p>
          )}
        </div>
        {/* WP288：设置只有这一个入口（没有「设置」页签了）；在设置里它变成「返回」 */}
        <button
          type="button"
          data-testid="position-settings-link"
          aria-pressed={tab === 'settings'}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs hover:bg-accent"
          onClick={() => {
            setTab(tab === 'settings' ? 'work' : 'settings')
          }}
        >
          {tab === 'settings' ? (
            <>
              <ChevronLeft className="size-4" aria-hidden />
              {t('pos2.settings.back')}
            </>
          ) : (
            <>
              <MoreHorizontal className="size-4" aria-hidden />
              {t('pos2.settings')}
            </>
          )}
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

      {/* WP253：建站岗位「让 AI 改网站还差哪一步」（没装 CLI / 没登录 / 没店铺地址）；补上就消失 */}
      <SiteThemeBanner positionId={view?.position_id} duties={duties} />
      {/* WP261：店铺管理 / 整站搭建 / 网页模板所在的岗位「授权管理商品和页面」——WP288 起只在出问题时出 */}
      <ShopAdminBanner duties={duties} />
      {/*
        WP277：只有一个岗位的人首页就是这一页（WP69）——首页那几行通知（交接结果、上级派活、
        改回同事互联）在这里也出，不然他永远看不到。两个及以上岗位的人在首页看。
      */}
      {mine.data?.instances?.length === 1 ? (
        <>
          <HandoffNotices />
          <ModeNotice />
        </>
      ) : null}

      {tab === 'settings' ? (
        <PositionSettings id={id} view={view} />
      ) : (
        <div className="flex flex-col gap-7">
          {view === undefined ? null : <PositionHandoff id={id} view={view} hero={fresh} />}

          <div
            ref={deckRef}
            className="flex scroll-mt-4 flex-col gap-2"
            data-testid="position-deck"
          >
            {fresh ? (
              <>
                <h3 className="ws-display text-[17px]">{t('pos2.deck.title')}</h3>
                <p className="text-sm text-muted-foreground" data-testid="position-deck-empty">
                  ✓ {t('pos2.deck.empty')}
                </p>
              </>
            ) : (
              /*
               * 37 §1：与首页同一副牌，只是钉死在这个岗位上（原样，不另画样式）。
               * WP141：合的是本人在这个岗位下的每一条职责。
               * WP288：「要你处理 N」交进去，与筛选图标、翻页同一行。
               */
              <DeckSection
                positionId={id}
                positionIds={deckIds}
                // WP278（决策 284）：只有一个岗位的人首页就是这里——也收挂在底座职责上的卡
                withBase={sole}
                {...(focus === undefined ? {} : { focus })}
                onOpen={(card) => {
                  navigate(matterUrl(card))
                }}
                title={
                  <h3 className="flex min-w-0 items-center gap-2" data-testid="position-deck-title">
                    <span className="ws-display text-[17px]">{t('pos2.deck.title')}</span>
                    {pending === 0 ? null : (
                      <span className="ws-num text-xs text-ws-muted-fg">{pending}</span>
                    )}
                    <Hint text={t('pos2.deck.hint')} />
                  </h3>
                }
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
        </div>
      )}
    </div>
  )
}
