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
 *
 * **WP372（决策 1019，Luoye 10-17）：中间栏回到普通对话框形态**——页头 + 对话框 + 按状态现出的快捷按钮 +
 * 「要你拍板」的卡。上面 3、4 两块（工作、数据看板）和报表块都搬进右侧面板「报表」
 * （`components/reports/scope-boards.tsx`）；`?tab=view` 打开那一格，页头「卡住了 / 今天的待办」点了也打开它并筛好。
 *
 * **WP431（Luoye 10-19，照 Claude 桌面版）**：主区不再有页头——岗位名进**顶栏左边**（名字 + 下拉箭头：改名、岗位设置、
 * 换职责；连接正常的绿勾跟在名字后面），「岗位设置」是顶栏右边那排里的一颗滑杆图标；名字下面那行小字
 * （「刚建好，还没开工 · N 条职责」）去掉。「卡住了 / 今天的待办」是要人留意的事，有才出，挪到主区顶上那一行提醒里。
 */
import { useQuery } from '@tanstack/react-query'
import { Link2Off, PencilLine, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AdCreativeEntry } from '@/components/ads/ad-creative-entry'
import { ExtensionOnboardCard } from '@/components/connections/extension-onboard-card'
import { PlatformChooseBanner } from '@/components/connections/platform-cli-card'
import { DeckSection } from '@/components/deck'
import { NoticeLine } from '@/components/design/kit'
import { ConnectionTick } from '@/components/position/connection-tick'
import { PositionHandoff } from '@/components/position/position-handoff'
import { PositionSettings } from '@/components/position/position-settings'
import { ShopAdminBanner } from '@/components/position/shop-admin-banner'
import { SiteThemeBanner } from '@/components/position/site-theme-banner'
import { useRailState } from '@/components/rail/rail-state'
import { requestWorkFilter, useCardJumpRequest } from '@/components/reports/position-bridge'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { settingsHref } from '@/components/settings-panel/route'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { DOCK_PAGE } from '@/components/shell/composer-dock'
import {
  TitleMenu,
  TitleMenuItem,
  TitleMenuLabel,
  TitleMenuSeparator,
  TOPBAR_ICON,
  TOPBAR_ICON_ACTIVE,
  TOPBAR_ICON_IDLE,
  TopBarAction,
  TopBarTitle,
} from '@/components/shell/top-bar-slots'
import { RedditWatchAlertNotice } from '@/components/social/reddit-watch-alert'
import { RedditWriteNotice } from '@/components/social/reddit-write-notice'
import { Hint } from '@/components/ui/hint'
import { getPosition, getPositionConnections, getPositions, getPositionWork } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { dutyHref } from '@/lib/duty-href'
import { NO_FILTERS, type WorkPrefs } from '@/lib/position-work'
import { assignmentForPosition, myAssignments } from '@/lib/positions'
import { cn } from '@/lib/utils'
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
  const openConnect = useOpenConnect()
  const params = useParams<{ id: string }>()
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()
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
  // 卡片流翻到哪张（右侧面板「计划 → 工作」行尾「N 张卡等你」点过来的，WP372 起隔着一栏传）
  const [focus, setFocus] = useState<{ card_id: string; nonce: number } | undefined>(undefined)
  const deckRef = useRef<HTMLDivElement | null>(null)
  const jump = useCardJumpRequest(id)
  useEffect(() => {
    if (jump === undefined) return
    setFocus({ card_id: jump.card_id, nonce: jump.nonce })
    scrollTo(deckRef.current)
  }, [jump])

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
  // WP372：老地址 `?tab=view`（看板 / 红人工作台那几条链接）→ 右侧面板里的看板
  // WP433：「工作」与快捷视图（红人工作台……）挪去「计划」的完整一格
  useEffect(() => {
    if (rawTab === 'view') rail.show('schedules')
  }, [rawTab, rail])

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

  /** 卡住了 / 今天的待办：有才出（点了打开右侧「计划」，「工作」筛到那一组）。 */
  const stuck = counts?.stuck ?? 0
  const today = counts?.todos_today ?? 0
  const name =
    view === undefined ? (here?.role_name ?? '') : lang === 'en' ? view.name.en : view.name.zh
  const filterWork = (filters: WorkPrefs['filters']): void => {
    setTab('work')
    requestWorkFilter(id, filters)
    // WP433：「工作」在「计划」的完整一格里（原在「报表」）
    rail.show('schedules')
  }

  return (
    <div
      className={cn(DOCK_PAGE, 'mx-auto w-full max-w-[780px] gap-4')}
      data-testid="position-page"
      data-position={id}
      data-view={tab}
    >
      {/* ── 顶栏：岗位名 + 下拉（WP431，照 Claude；没有外壳时就地画） ── */}
      <TopBarTitle>
        <div className="flex min-w-0 items-center gap-1" data-testid="position-header">
          <TitleMenu
            title={name}
            testId="position-name"
            menuTestId="position-title-menu"
            menuLabel={t('topbar.menu.position', { name })}
            after={<ConnectionTick id={id} duties={duties} />}
            menu={(close) => (
              <>
                <TitleMenuItem
                  icon={PencilLine}
                  label={t('topbar.position.rename')}
                  testId="position-menu-rename"
                  onSelect={() => {
                    close()
                    navigate(settingsHref('positions'))
                  }}
                />
                <TitleMenuItem
                  icon={SlidersHorizontal}
                  label={t(
                    tab === 'settings' ? 'topbar.settings.close' : 'topbar.position.settings',
                  )}
                  testId="position-menu-settings"
                  onSelect={() => {
                    close()
                    setTab(tab === 'settings' ? 'work' : 'settings')
                  }}
                />
                {duties.length === 0 ? null : (
                  <>
                    <TitleMenuSeparator />
                    <TitleMenuLabel>{t('topbar.position.duties')}</TitleMenuLabel>
                    {duties.map((d) => (
                      <TitleMenuItem
                        key={d.role_id}
                        label={
                          <span className="inline-flex items-center gap-1.5">
                            <DutyIcon role_id={d.role_id} size={14} />
                            {d.role_name}
                          </span>
                        }
                        testId="position-menu-duty"
                        onSelect={() => {
                          close()
                          navigate(dutyHref(d.assignment_id, d.role_id))
                        }}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          />
        </div>
      </TopBarTitle>
      {/* WP431：「岗位设置」进顶栏右边那排图标（滑杆）；在设置里再点一次回到工作 */}
      <TopBarAction>
        <button
          type="button"
          data-testid="position-settings-link"
          aria-pressed={tab === 'settings'}
          title={t(tab === 'settings' ? 'pos2.settings.back' : 'pos2.settings')}
          className={cn(TOPBAR_ICON, tab === 'settings' ? TOPBAR_ICON_ACTIVE : TOPBAR_ICON_IDLE)}
          onClick={() => {
            setTab(tab === 'settings' ? 'work' : 'settings')
          }}
        >
          <SlidersHorizontal aria-hidden className="size-4" />
          <span className="sr-only">
            {t(tab === 'settings' ? 'pos2.settings.back' : 'pos2.settings')}
          </span>
        </button>
      </TopBarAction>

      {/* WP244 / WP431：卡住了、今天的待办——有才出（点了打开右侧「报表」，「工作」筛到那一组） */}
      {view === undefined || (stuck === 0 && today === 0) ? null : (
        <p
          className="flex flex-wrap items-center gap-x-1.5 text-xs text-ws-muted-fg"
          data-testid="position-status"
        >
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

      {/* WP238：只在真缺要连的连接时出一行；补上了自己消失（WP431：不再说「必需」，邮件营销按档案说过的那家才算） */}
      {firstMissing === undefined ? null : (
        // WP456-T2：缺连接只说一行（浅底、黄图标、右边一个「去连接」链接）
        <NoticeLine
          icon={Link2Off}
          data-testid="position-missing-banner"
          {...(firstMissing.connect_service === undefined
            ? {}
            : {
                // WP324（决策 690）：缺的那几样在第三栏一张连接卡里就地连
                action: {
                  label: t('pos2.banner.go'),
                  testId: 'position-missing-go',
                  data: {
                    'data-connect': missingItems.flatMap((i) => i.connect_service ?? []).join('+'),
                  },
                  onClick: () => {
                    openConnect(missingItems.flatMap((i) => i.connect_service ?? []))
                  },
                },
              })}
        >
          {t('pos2.banner.missing', {
            names: missingItems.map((i) => (lang === 'en' ? i.name.en : i.name.zh)).join('、'),
          })}
        </NoticeLine>
      )}

      {/*
        WP360（决策 947）：要浏览器插件的岗位（职责定义推出来）、插件还没配上 → 顶上常驻装插件卡；
        配上后换成「还差一步」（插件里连 Reddit / 广告后台）、再接方案卡；都好了就不画。「稍后」当天收起。
      */}
      {tab === 'settings' ? null : (
        <ExtensionOnboardCard
          roleIds={duties.map((d) => d.role_id)}
          assignment={duties[0]?.assignment_id}
          mode="position"
        />
      )}
      {/* WP418（自查 A1）：建站平台还没选 → 顶上一行「先选建站平台」+ 下拉（设置页签里那张 CLI 卡自己会出） */}
      {tab === 'settings' ? null : (
        <PlatformChooseBanner
          {...(view?.position_id === undefined ? {} : { positionId: view.position_id })}
          {...(duties[0]?.assignment_id === undefined
            ? {}
            : { assignment: duties[0].assignment_id })}
        />
      )}
      {/* WP253：建站岗位「让 AI 改网站还差哪一步」（没装 CLI / 没登录 / 没店铺地址）；补上就消失 */}
      <SiteThemeBanner positionId={view?.position_id} duties={duties} />
      {/* WP261：店铺管理 / 整站搭建 / 网页模板所在的岗位「授权管理商品和页面」——WP288 起只在出问题时出 */}
      <ShopAdminBanner duties={duties} />
      {/* WP332（决策 762）：社媒岗位上 Reddit 那一条没发出去 → 一行提醒 +「再填一次」；正常时不画 */}
      <RedditWriteNotice duties={duties} />
      {/* WP340：巡查抓到命中告警词的 → 一行「优先」提醒（同一条只一次）；没有就不画 */}
      <RedditWatchAlertNotice duties={duties} />
      {/* WP317（决策 629）：投放岗位上素材流水线的快捷入口（点进 Google / Meta 职责页那一块） */}
      <AdCreativeEntry duties={duties} />
      {/* WP429：交接结果、上级派活、改回同事互联都进顶栏铃铛（站内通知），这一页不再单出一行 */}

      {tab === 'settings' ? (
        <PositionSettings id={id} view={view} />
      ) : (
        <div className="flex flex-1 flex-col gap-7">
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
                // WP372（决策 1019）：报表进右侧面板「报表」卡，这里只放要你拍板的卡
                withReports={false}
                {...(focus === undefined ? {} : { focus })}
                onOpen={(card) => {
                  navigate(matterUrl(card))
                }}
                title={(total) => {
                  // WP416（自查 kol U7）：数跟下面这副牌走（还没取到时先用岗位视图那个数）
                  const n = total ?? pending
                  return (
                    <h3
                      className="flex min-w-0 items-center gap-2"
                      data-testid="position-deck-title"
                    >
                      <span className="ws-display text-[17px]">{t('pos2.deck.title')}</span>
                      {n === 0 ? null : (
                        <span className="ws-num text-xs text-ws-muted-fg">{n}</span>
                      )}
                      <Hint text={t('pos2.deck.hint')} />
                    </h3>
                  )
                }}
              />
            )}
          </div>
          {/* WP437：对话框在中栏底部居中、悬浮在内容之上（放在内容最后） */}
          {view === undefined ? null : <PositionHandoff id={id} view={view} hero={fresh} />}
        </div>
      )}
    </div>
  )
}
