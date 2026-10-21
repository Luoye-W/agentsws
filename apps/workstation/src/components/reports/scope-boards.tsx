/**
 * WP372（决策 1019，Luoye 10-17「中间栏回到普通对话框形态」）：原来摊在岗位页 / 职责页中间栏的**看板**，
 * 搬进右侧面板「报表 → 显示更多」的下半截。中间栏只剩标题 + 对话框 + 快捷按钮 + 要你拍板的卡。
 *
 * - 岗位层：「工作」（AI 在做什么、做到哪；列表 / 看板 / 表格 / 日历 / 快捷视图，WP241）+ 数据看板（每条职责几个数）；
 * - 职责层：这条职责自己的那几块（社媒内容日历与群发、B2B 开发信 / 业务、投放素材与改动、内容与搜索的 AI 回答监测）。
 *
 * 组件本身一个没改，只是换了地方；与中间栏要互相够得着的两件事走 `position-bridge.ts`。
 * 面板窄，看这些时点面板头的「加宽」（宽度记住）。
 *
 * WP433（Luoye 10-20 问题 8：「这不是报表」）：报表里只放报表。这些看板按性质分成三份——
 *
 * | 哪一份 | 岗位层 | 职责层 | 放在哪 |
 * |---|---|---|---|
 * | **进度**（{@link ScopeWorkBoards}）：在做什么、做到哪、排着什么 | 「工作」（进行中 / 卡住了 / 排着的…，列表 / 看板 / 日历 / 表格）、投放素材流水线 | 社媒排期与群发、B2B 开发信 / 业务、投放素材与改动 | 「计划」卡的「显示更多」 |
 * | **报表类**（{@link ScopeReportBoards}）：看数、看结果 | Amazon 运营四块、投放「今天」 | 投放「今天」、Amazon 运营、内容与搜索的数据源与 AI 回答监测 | 「报表」卡的「显示更多」（原样不动，WP434 重做报表时接） |
 * | **数据看板**（{@link PositionDataBoard}） | 每条职责几个数 + 看图表 | — | **先不挂**：WP434 把它做成一份真正的报表时从这里接，数据源一个没删 |
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { AdChangesPanel } from '@/components/ads/ad-changes-panel'
import { AdCreativePanel, adCreativePlatformOf } from '@/components/ads/ad-creative-panel'
import { AdsOverview } from '@/components/ads/ads-overview'
import { AMAZON_STORE_ROLE, AmazonOpsBoard } from '@/components/amazon/amazon-ops-board'
// WP394：「竞品动向」块（模块里自己登记进 Amazon 运营面板）
import '@/components/amazon/amazon-competitors'
// WP396：「Listing 体检」块的身体（导入即注册进上面那块面板）
import '@/components/amazon/listing-checkup'
import { B2bOutboundPanel } from '@/components/b2b/outbound-panel'
import { B2bSalesPanel } from '@/components/b2b/sales-panel'
import { type BoardDuty, DataBoard } from '@/components/position/data-board'
import { WorkSection } from '@/components/position/work-section'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { requestCardJump, useWorkFilterRequest } from '@/components/reports/position-bridge'
import { GeoBoard } from '@/components/seo/geo-board'
import { GoogleSourcePicker } from '@/components/seo/google-source-picker'
import { SocialBroadcast } from '@/components/social/social-broadcast'
import { socialChannelOfRole } from '@/components/social/social-calendar'
import { SocialCalendarSummary } from '@/components/social/social-calendar-summary'
import { getPosition, getPositions, getPositionWork } from '@/lib/api'
import {
  loadWorkPrefs,
  PANEL_QUICK_KINDS,
  quickViewsOf,
  saveWorkPrefs,
  type WorkPrefs,
} from '@/lib/position-work'

/** 「计划 → 显示更多」下半截：这一层的进度看板（岗位层「工作」等；职责层那条职责自己的排期 / 流水线）。 */
export function ScopeWorkBoards({ scope }: RailPanelBodyProps): ReactNode {
  if (scope?.assignment === undefined) return null
  return scope.tier === 'role' ? (
    <DutyWorkBoards assignment={scope.assignment} role_id={scope.scope_id} />
  ) : (
    <PositionWork id={scope.assignment} />
  )
}

/** 「报表 → 显示更多」下半截：这一层看数的那几块（WP434 接手前原样摆着）。 */
export function ScopeReportBoards({ scope }: RailPanelBodyProps): ReactNode {
  if (scope?.assignment === undefined) return null
  return scope.tier === 'role' ? (
    <DutyReportBoards assignment={scope.assignment} role_id={scope.scope_id} />
  ) : (
    <PositionReportBoards id={scope.assignment} />
  )
}

/** 这个岗位里本人持有的职责（带分配与范围）。几块看板共用一份。 */
function usePositionDuties(id: string): {
  duties: BoardDuty[]
  ownerAssignment: string | undefined
  fresh: boolean
} {
  const mine = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const here = mine.data?.positions.find((p) => p.position_id === id)
  const ownerAssignment = (mine.data?.positions ?? []).find(
    (p) => p.role_id === 'common.owner',
  )?.position_id
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
  const view = instance.data
  const duties = useMemo(() => {
    const out: BoardDuty[] = (view?.roles ?? []).flatMap((r) =>
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
    return out.map((d) => {
      const summary = mine.data?.positions.find((p) => p.position_id === d.assignment_id)
      return summary === undefined ? d : { ...d, ranges: summary.ranges }
    })
  }, [view, here, mine.data])
  const pending = view?.pending_cards ?? 0
  const fresh =
    view !== undefined && work.data !== undefined && work.data.items.length === 0 && pending === 0
  return { duties, ownerAssignment, fresh }
}

/** 岗位层「工作」（AI 在做什么、做到哪）+ 投放素材流水线。原来岗位页中间栏的下半截，逻辑原样搬来。 */
export function PositionWork({ id }: { id: string }): ReactNode {
  const client = useQueryClient()
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  const rawTab = params.get('tab')
  const kolParam = params.get('kol')
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
  const { duties } = usePositionDuties(id)
  const quickViews = useMemo(() => quickViewsOf(duties), [duties])

  // ── 工作的看法：记在这个岗位上（本机） ──
  const prefsKey = instance.data?.position_id ?? id
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

  // 老地址 `?tab=view`：「面板」类快捷视图（`kol=` 指名就是红人工作台）打开——不记进偏好
  const legacyView = rawTab === 'view'
  useEffect(() => {
    if (!legacyView || quickViews.length === 0) return
    const panel =
      quickViews.find((q) => kolParam !== null && q.kind === 'kol') ??
      quickViews.find((q) => (PANEL_QUICK_KINDS as readonly string[]).includes(q.kind))
    if (panel !== undefined) setPrefsState((p) => ({ ...p, view: panel.id }))
  }, [legacyView, kolParam, quickViews])

  // 页头「卡住了 / 今天的待办」点过来的：筛到那一组（不记进偏好）
  const filter = useWorkFilterRequest(id)
  useEffect(() => {
    if (filter === undefined) return
    setPrefsState((p) => ({ ...p, view: 'list', filters: filter.filters }))
  }, [filter])

  const adsDuties = duties.filter((d) => adCreativePlatformOf(d.role_id) !== undefined)
  return (
    <div className="flex flex-col gap-6" data-testid="position-work-boards">
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
          requestCardJump(id, card_id)
        }}
        onRefresh={() => {
          void client.invalidateQueries({ queryKey: ['position-work'] })
          void client.invalidateQueries({ queryKey: ['position-instance', id] })
        }}
      />
      {/* WP420（自查 A16 / U7）：岗位页「素材流水线」点了打开的就是这里 */}
      {adsDuties.map((d) => {
        const platform = adCreativePlatformOf(d.role_id)
        return platform === undefined ? null : (
          <AdCreativePanel key={d.assignment_id} assignment={d.assignment_id} platform={platform} />
        )
      })}
    </div>
  )
}

/** 岗位层里看数的那几块：Amazon 运营（每日巡检 / 竞品动向 / Listing 体检 / 词库）、投放「今天」。 */
export function PositionReportBoards({ id }: { id: string }): ReactNode {
  const { duties } = usePositionDuties(id)
  // WP395：岗位里有亚马逊店铺运营 → Amazon 那四块
  const amazon = duties.find((d) => d.role_id === AMAZON_STORE_ROLE)
  // WP420（自查 A6）：岗位里有投放职责 → 每条一块「今天」看板（数从广告库来）
  const adsDuties = duties.filter((d) => adCreativePlatformOf(d.role_id) !== undefined)
  if (amazon === undefined && adsDuties.length === 0) return null
  return (
    <div className="flex flex-col gap-6" data-testid="position-report-boards">
      {amazon === undefined ? null : <AmazonOpsBoard assignment={amazon.assignment_id} />}
      {adsDuties.map((d) => (
        <AdsOverview key={d.assignment_id} assignment={d.assignment_id} />
      ))}
    </div>
  )
}

/**
 * WP433：岗位层「数据看板」（每条职责几个数 + 看图表）——**现在哪儿都没挂**。
 * Luoye 10-20：它不该是报表卡里的一块看板，而是「报表」下面一份能自由建立的报表；WP434 重做报表时从这里接
 * （数据源 `GET /v1/blocks/:id/data`、范围、没挂范围的提示都还在 `DataBoard` 里，一个没删）。
 */
export function PositionDataBoard({ id }: { id: string }): ReactNode {
  const { search } = useLocation()
  const { duties, ownerAssignment, fresh } = usePositionDuties(id)
  const [charts, setCharts] = useState(new URLSearchParams(search).get('tab') === 'view')
  return (
    <DataBoard
      duties={duties}
      expanded={charts}
      onExpanded={setCharts}
      owner={ownerAssignment}
      empty={fresh}
    />
  )
}

/**
 * 岗位层的全部看板摆在一起（工作 + 看数的几块 + 数据看板）。**应用里不再这样挂**（WP433 拆成上面三份），
 * 留给老用例（它们测的是同一页上的那几块）。
 */
export function PositionBoards({ id }: { id: string }): ReactNode {
  return (
    <div className="flex flex-col gap-6" data-testid="position-boards">
      <PositionWork id={id} />
      <PositionReportBoards id={id} />
      <PositionDataBoard id={id} />
    </div>
  )
}

/** 社群组五条（56 §0）。真源是契约的 `SOCIAL_CHANNELS[].group`，这里照抄一份（原在职责页）。 */
const COMMUNITY_CHANNELS: readonly string[] = [
  'facebook_group',
  'reddit',
  'discord',
  'telegram_group',
  'whatsapp',
]

/** WP433：这条职责有没有「进度」那一类看板（社媒排期 / 群发、B2B、投放素材流水线）。 */
export function dutyHasWorkBoards(role_id: string): boolean {
  return (
    socialChannelOfRole(role_id) !== undefined ||
    role_id === 'b2b.outbound' ||
    role_id === 'b2b.sales' ||
    adCreativePlatformOf(role_id) !== undefined
  )
}

/** WP433：这条职责有没有「看数」那一类看板（投放「今天」、Amazon 运营、内容与搜索）。 */
export function dutyHasReportBoards(role_id: string): boolean {
  return (
    adCreativePlatformOf(role_id) !== undefined ||
    role_id === 'dtc.content' ||
    role_id === AMAZON_STORE_ROLE
  )
}

/** 这条职责有没有自己的看板（两类任一）。 */
export function dutyHasBoards(role_id: string): boolean {
  return dutyHasWorkBoards(role_id) || dutyHasReportBoards(role_id)
}

/** 职责层「进度」：社媒排期与群发、B2B 开发信 / 业务、投放素材与改动（原来职责页中间栏，原样搬来）。 */
export function DutyWorkBoards({
  assignment,
  role_id,
}: {
  assignment: string
  role_id: string
}): ReactNode {
  const socialChannel = socialChannelOfRole(role_id)
  const platform = adCreativePlatformOf(role_id)
  if (!dutyHasWorkBoards(role_id)) return null
  return (
    <div className="flex flex-col gap-4" data-testid="duty-work-boards" data-duty={role_id}>
      {socialChannel === undefined ? null : (
        <>
          {/* WP419（自查 U4）：窄栏只放一行摘要 + 去日历；要在这里排再展开 */}
          <SocialCalendarSummary
            assignment={assignment}
            channel={socialChannel}
            role_id={role_id}
          />
          {COMMUNITY_CHANNELS.includes(socialChannel) ? (
            <SocialBroadcast assignment={assignment} channel={socialChannel} />
          ) : null}
        </>
      )}
      {role_id === 'b2b.outbound' ? <B2bOutboundPanel assignment={assignment} /> : null}
      {role_id === 'b2b.sales' ? <B2bSalesPanel assignment={assignment} /> : null}
      {platform === undefined ? null : (
        <>
          <AdCreativePanel assignment={assignment} platform={platform} />
          <AdChangesPanel assignment={assignment} />
        </>
      )}
    </div>
  )
}

/** 职责层「看数」：投放「今天」、Amazon 运营、内容与搜索的数据源与 AI 回答监测（WP434 接手前原样摆着）。 */
export function DutyReportBoards({
  assignment,
  role_id,
}: {
  assignment: string
  role_id: string
}): ReactNode {
  const platform = adCreativePlatformOf(role_id)
  if (!dutyHasReportBoards(role_id)) return null
  return (
    <div className="flex flex-col gap-4" data-testid="duty-report-boards" data-duty={role_id}>
      {platform === undefined ? null : <AdsOverview assignment={assignment} />}
      {role_id === AMAZON_STORE_ROLE ? <AmazonOpsBoard assignment={assignment} /> : null}
      {role_id === 'dtc.content' ? (
        <>
          <GoogleSourcePicker assignment={assignment} source="gsc" />
          <GoogleSourcePicker assignment={assignment} source="ga4" />
          <GeoBoard assignment={assignment} />
        </>
      ) : null}
    </div>
  )
}

/** 职责层的全部看板（两类摆在一起）。应用里不这样挂，留给老用例。 */
export function DutyBoards({
  assignment,
  role_id,
}: {
  assignment: string
  role_id: string
}): ReactNode {
  return (
    <div className="flex flex-col gap-4" data-testid="duty-boards" data-duty={role_id}>
      <DutyWorkBoards assignment={assignment} role_id={role_id} />
      <DutyReportBoards assignment={assignment} role_id={role_id} />
    </div>
  )
}
