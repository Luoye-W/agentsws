/**
 * WP372（决策 1019，Luoye 10-17「中间栏回到普通对话框形态」）：原来摊在岗位页 / 职责页中间栏的**看板**，
 * 搬进右侧面板「报表 → 显示更多」的下半截。中间栏只剩标题 + 对话框 + 快捷按钮 + 要你拍板的卡。
 *
 * - 岗位层：「工作」（AI 在做什么、做到哪；列表 / 看板 / 表格 / 日历 / 快捷视图，WP241）+ 数据看板（每条职责几个数）；
 * - 职责层：这条职责自己的那几块（社媒内容日历与群发、B2B 开发信 / 业务、投放素材与改动、内容与搜索的 AI 回答监测）。
 *
 * 组件本身一个没改，只是换了地方；与中间栏要互相够得着的两件事走 `position-bridge.ts`。
 * 面板窄，看这些时点面板头的「加宽」（宽度记住）。
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
import { DataBoard } from '@/components/position/data-board'
import { WorkSection } from '@/components/position/work-section'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { requestCardJump, useWorkFilterRequest } from '@/components/reports/position-bridge'
import { GeoBoard } from '@/components/seo/geo-board'
import { GoogleSourcePicker } from '@/components/seo/google-source-picker'
import { SocialBroadcast } from '@/components/social/social-broadcast'
import { SocialCalendar, socialChannelOfRole } from '@/components/social/social-calendar'
import { getPosition, getPositions, getPositionWork } from '@/lib/api'
import {
  loadWorkPrefs,
  PANEL_QUICK_KINDS,
  quickViewsOf,
  saveWorkPrefs,
  type WorkPrefs,
} from '@/lib/position-work'

export function ScopeBoards({ scope }: RailPanelBodyProps): ReactNode {
  if (scope?.assignment === undefined) return null
  return scope.tier === 'role' ? (
    <DutyBoards assignment={scope.assignment} role_id={scope.scope_id} />
  ) : (
    <PositionBoards id={scope.assignment} />
  )
}

/** 岗位层：工作 + 数据看板（原来岗位页中间栏的下半截，逻辑原样搬来）。 */
export function PositionBoards({ id }: { id: string }): ReactNode {
  const client = useQueryClient()
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  const rawTab = params.get('tab')
  const kolParam = params.get('kol')
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

  // WP395：岗位里有亚马逊店铺运营 → Amazon 那四块（每日巡检 / 竞品动向 / Listing 体检 / 词库）
  const amazon = duties.find((d) => d.role_id === AMAZON_STORE_ROLE)
  const adsDuties = duties.filter((d) => adCreativePlatformOf(d.role_id) !== undefined)
  const pending = view?.pending_cards ?? 0
  const fresh =
    view !== undefined && work.data !== undefined && work.data.items.length === 0 && pending === 0

  return (
    <div className="flex flex-col gap-6" data-testid="position-boards">
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
      {amazon === undefined ? null : <AmazonOpsBoard assignment={amazon.assignment_id} />}
      {/* WP420（自查 A6）：岗位里有投放职责 → 每条一块「今天」看板（数从广告库来） */}
      {adsDuties.map((d) => {
        const platform = adCreativePlatformOf(d.role_id)
        return (
          <div key={d.assignment_id} className="flex flex-col gap-4">
            <AdsOverview assignment={d.assignment_id} />
            {/* WP420（自查 A16 / U7）：岗位页「素材流水线」点了打开的就是这里 */}
            {platform === undefined ? null : (
              <AdCreativePanel assignment={d.assignment_id} platform={platform} />
            )}
          </div>
        )
      })}
      <DataBoard
        duties={boardDuties}
        expanded={charts}
        onExpanded={setCharts}
        owner={ownerAssignment}
        empty={fresh}
      />
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

/** 这条职责有没有自己的看板（职责页决定要不要提示「看板在右侧报表里」）。 */
export function dutyHasBoards(role_id: string): boolean {
  return (
    socialChannelOfRole(role_id) !== undefined ||
    role_id === 'b2b.outbound' ||
    role_id === 'b2b.sales' ||
    adCreativePlatformOf(role_id) !== undefined ||
    role_id === 'dtc.content' ||
    role_id === AMAZON_STORE_ROLE
  )
}

/** 职责层：这条职责自己的那几块（原来职责页中间栏，原样搬来）。 */
export function DutyBoards({
  assignment,
  role_id,
}: {
  assignment: string
  role_id: string
}): ReactNode {
  const socialChannel = socialChannelOfRole(role_id)
  const platform = adCreativePlatformOf(role_id)
  return (
    <div className="flex flex-col gap-4" data-testid="duty-boards" data-duty={role_id}>
      {socialChannel === undefined ? null : (
        <>
          <SocialCalendar assignment={assignment} channel={socialChannel} />
          {COMMUNITY_CHANNELS.includes(socialChannel) ? (
            <SocialBroadcast assignment={assignment} channel={socialChannel} />
          ) : null}
        </>
      )}
      {role_id === 'b2b.outbound' ? <B2bOutboundPanel assignment={assignment} /> : null}
      {role_id === 'b2b.sales' ? <B2bSalesPanel assignment={assignment} /> : null}
      {platform === undefined ? null : (
        <>
          <AdsOverview assignment={assignment} />
          <AdCreativePanel assignment={assignment} platform={platform} />
          <AdChangesPanel assignment={assignment} />
        </>
      )}
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
