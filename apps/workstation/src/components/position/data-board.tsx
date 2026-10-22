/**
 * WP241 岗位页「数据看板」（原「面板」页签，设计稿里叫「数字」→ Luoye 10-06 改名）。
 *
 * 每条职责一行、3–4 个关键数 + 涨跌（读的就是原来面板上那几个 `stat_tile` 积木，同一条
 * `GET /v1/blocks/:id/data`，一个数都不在前端算）；「看图表」才展开原来的整块面板
 * （数字块 + 图与表，`StoreSections`，长相不变）。
 *
 * 取数已由接口中台满足的源照 WP238 口径：一行灰字说数据从哪来，不催连接。
 * 没挂范围的职责：说人话（`NoRangeNotice`，44 / WP138），不出一个假的 0。
 */
import type { RangeName } from '@agentsws/deck'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { BarChart3, Link2Off, ScanSearch } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { BlockCard } from '@/components/blocks/block-view'
import { connectServiceFor } from '@/components/connections/links'
import { DeltaPill, Segmented } from '@/components/design'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { GoogleSourcePicker } from '@/components/seo/google-source-picker'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyLine } from '@/components/ui/empty-line'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { currentSession, getBlockData, getPositionView, updateAssignmentRanges } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatValue } from '@/lib/format'
import { useMode } from '@/lib/mode'

const RANGES: RangeName[] = ['yesterday', 'last_7d']
/** 一行最多几个数（设计稿：3–4 个，再多就是第二张面板了）。 */
const MAX_TILES = 4

/** WP96：数字块单独排一行（画布第一屏那四块）。 */
const isTile = (block: { component: string }): boolean => block.component === 'stat_tile'

type ViewResult = Awaited<ReturnType<typeof getPositionView>>
type Section = ViewResult['sections'][number]
type Block = Section['blocks'][number]

/**
 * 44 / 09-11 真店验收的后置项：**没挂范围的岗位要明说**（WP138：只替换店铺数字那几块）。
 * WP241 从 `pages/position.tsx` 挪来，长相与行为不变（那边仍从这里再导出一份）。
 */
export function NoRangeNotice({
  id,
  isOwner,
  ownerAssignment,
}: {
  id: string
  isOwner: boolean
  /** 店主那条分配（`common.owner`）；给了才出一键挂品牌。 */
  ownerAssignment?: string | undefined
}): ReactNode {
  /*
   * WP271（docs/95 §2.4）：① 个人——不挑范围本来就是整个品牌，只有老分配会走到这里：
   * 只给一键「挂上整个品牌」，不出「去分配 / 找负责人」。
   */
  const { t, mode } = useMode()
  const client = useQueryClient()
  const assign = useMutation({
    mutationFn: async () => {
      const me = await currentSession()
      return updateAssignmentRanges(id, [{ kind: 'brand', id: me.workspace.id }], ownerAssignment)
    },
    // 范围一变，面板、左栏、红人工作台读到的东西全变——整个缓存作废最省心
    onSuccess: () => client.invalidateQueries(),
  })
  return (
    <Card data-testid="no-range-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <ScanSearch className="size-4" aria-hidden />
          {t('view.no_range')}
          <Hint text={t('view.no_range.detail')} testId="no-range-why" />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p data-slot="status">{t('view.no_range.stores')}</p>
        {isOwner ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {ownerAssignment === undefined ? null : (
                <Button
                  size="sm"
                  data-testid="no-range-self-assign"
                  disabled={assign.isPending}
                  onClick={() => {
                    assign.mutate()
                  }}
                >
                  {assign.isPending ? t('view.no_range.self.pending') : t('view.no_range.self')}
                </Button>
              )}
              {ownerAssignment === undefined ? null : (
                <Hint text={t('view.no_range.self.hint')} testId="no-range-self-hint" />
              )}
              {/* WP277（docs/95 §6.3）：范围只在 ③——① ② 不叫人去分配 */}
              {mode !== 'company' ? null : (
                <Button size="sm" variant="outline" asChild>
                  <Link to="/org?tab=positions" data-testid="no-range-assign">
                    {t('view.no_range.action')}
                  </Link>
                </Button>
              )}
            </div>
            {assign.error === null ? null : (
              <p className="text-xs text-destructive" data-testid="no-range-self-error">
                {t('view.no_range.self.error', { message: assign.error.message })}
              </p>
            )}
          </div>
        ) : (
          <p data-testid="no-range-ask-owner">{t('view.no_range.ask_owner')}</p>
        )}
      </CardContent>
    </Card>
  )
}

/** 没连 / 取数另有来路 / 还没做的那一行（WP238 口径，原 `StoreSections` 里那一段）。 */
function SectionStatus({ section }: { section: Section }): ReactNode {
  const { t } = useApp()
  const openConnect = useOpenConnect()
  if (section.via !== undefined)
    return (
      <p
        className="flex items-center gap-1.5 text-sm text-muted-foreground"
        data-testid="source-via"
        data-via={section.via}
        data-slot="status"
      >
        {t(`view.via.${section.via}`)}
        <Hint text={t('view.via.hint', { source: section.label })} testId="source-via-why" />
      </p>
    )
  return (
    <EmptyLine
      icon={<Link2Off className="size-4" aria-hidden />}
      testId="connect-card"
      text={section.note ?? t('view.not_connected', { source: section.label })}
      {...(section.note === undefined
        ? {
            // WP324（决策 690）：在第三栏就地连，不跳到连接页
            action: {
              label: t('view.connect'),
              connect: connectServiceFor(section.source),
              onClick: () => {
                openConnect(connectServiceFor(section.source))
              },
            },
          }
        : {})}
    />
  )
}

/** 原来面板上的整块：按数据源分块，数字块一排、图表两列（展开「看图表」时出）。 */
export function StoreSections({
  id,
  range,
  view,
  skip,
}: {
  id: string
  range: RangeName
  view: ViewResult | undefined
  /**
   * WP295：这几块数字已经摆在职责那一行上了，展开图表时不再大块摆一遍（同一屏不说两遍）。
   */
  skip?: ReadonlySet<string>
}): ReactNode {
  const isShownTile = (b: Block): boolean => isTile(b) && skip?.has(b.id) !== true
  return (
    <>
      {(view?.sections ?? []).map((section) => (
        <section key={section.source} data-testid="view-section" data-source={section.source}>
          <h3 className="ws-display mb-2.5 text-[14px]">{section.label}</h3>
          {section.connected ? (
            <div className="flex flex-col gap-4">
              {section.source === 'gsc' || section.source === 'ga4' ? (
                <GoogleSourcePicker assignment={id} source={section.source} />
              ) : null}
              {section.blocks.filter(isShownTile).length === 0 ? null : (
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="view-tiles">
                  {section.blocks.filter(isShownTile).map((block) => (
                    <BlockCard key={block.id} block={block} range={range} assignment={id} />
                  ))}
                </div>
              )}
              {section.blocks.filter((b) => !isTile(b)).length === 0 ? null : (
                <div className="grid auto-rows-min gap-4 lg:grid-cols-2">
                  {section.blocks
                    .filter((b) => !isTile(b))
                    .map((block) => (
                      <BlockCard key={block.id} block={block} range={range} assignment={id} />
                    ))}
                </div>
              )}
            </div>
          ) : (
            <SectionStatus section={section} />
          )}
        </section>
      ))}
    </>
  )
}

/** 数据看板里的一个数：标签 · 大数 · 涨跌（同一条积木数据，只换了排版）。 */
function MiniTile({ block, range, id }: { block: Block; range: RangeName; id: string }): ReactNode {
  const { lang } = useApp()
  const query = useQuery({
    queryKey: ['block', block.id, range, id],
    queryFn: () => getBlockData(block.id, range, id),
  })
  const data: Awaited<ReturnType<typeof getBlockData>> | undefined = query.data
  const payload =
    data?.status === 'ok'
      ? (data.payload as { value?: number; delta_pct?: number; currency?: string } | undefined)
      : undefined
  const delta = payload?.delta_pct
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="data-tile" data-block-id={block.id}>
      {/* WP416（自查 kol U2）：窄栏里标签整句换行显示，不截成「在…」「等…」 */}
      <span className="line-clamp-2 text-xs leading-snug text-ws-muted-fg">{block.title}</span>
      {query.isPending ? (
        <Skeleton className="h-6 w-16" />
      ) : (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="ws-display ws-num text-[22px] leading-none">
            {payload?.value === undefined
              ? '—'
              : formatValue(
                  payload.value,
                  payload.currency === undefined ? 'count' : 'money',
                  lang,
                  payload.currency,
                  true,
                )}
          </span>
          {delta === undefined || !Number.isFinite(delta) || delta === 0 ? null : (
            <DeltaPill direction={delta > 0 ? 'up' : 'down'}>
              {`${Math.abs(Math.round(delta * 10) / 10)}%`}
            </DeltaPill>
          )}
        </span>
      )}
    </div>
  )
}

export interface BoardDuty {
  role_id: string
  role_name: string
  assignment_id: string
  /** 这条分配挂的范围（左栏那份 `/v1/positions` 里就有）；空 = 没挂范围 */
  ranges?: readonly unknown[]
}

function DutyRow({
  duty,
  range,
  expanded,
  taken,
}: {
  duty: BoardDuty
  range: RangeName
  expanded: boolean
  /** 前面几行已经摆过的数字块 → 摆它的那条职责名（同一份店铺数据不在每条职责下各摆一遍） */
  taken: ReadonlyMap<string, string>
}): ReactNode {
  const { t } = useApp()
  const view = useQuery({
    queryKey: ['view', duty.assignment_id, range],
    queryFn: () => getPositionView(duty.assignment_id, range),
  })
  const sections = view.data?.sections ?? []
  const all = sections.filter((s) => s.connected).flatMap((s) => s.blocks.filter(isTile))
  const tiles = all.filter((b) => !taken.has(b.id))
  const sharedWith = all.length > 0 && tiles.length === 0 ? taken.get(all[0]?.id ?? '') : undefined
  if (sharedWith !== undefined)
    return (
      <div
        className="grid grid-cols-1 items-center gap-3 border-b px-4 py-3 last:border-b-0 md:grid-cols-[10rem_minmax(0,1fr)]"
        data-testid="data-row"
        data-role={duty.role_id}
        data-shared="true"
      >
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <DutyIcon role_id={duty.role_id} size={15} />
          <span className="truncate">{duty.role_name}</span>
        </div>
        <span className="text-xs text-ws-muted-fg">
          {t('pos2.data.shared', { duty: sharedWith })}
        </span>
      </div>
    )
  const offline = sections.filter((s) => !s.connected)
  return (
    <div
      className="flex flex-col gap-3 border-b px-4 py-3 last:border-b-0"
      data-testid="data-row"
      data-role={duty.role_id}
    >
      <div className="@container grid grid-cols-1 items-start gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <DutyIcon role_id={duty.role_id} size={15} />
          <span className="truncate">{duty.role_name}</span>
        </div>
        {view.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : tiles.length > 0 ? (
          // WP416（自查 kol U2）：按这一块自己的宽度排（右栏窄时两列），不按整个窗口宽
          <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
            {tiles.slice(0, MAX_TILES).map((b) => (
              <MiniTile key={b.id} block={b} range={range} id={duty.assignment_id} />
            ))}
          </div>
        ) : expanded ? (
          <span className="text-xs text-ws-muted-fg">{t('pos2.data.none')}</span>
        ) : sections.length === 0 ? (
          <span className="text-xs text-ws-muted-fg">{t('pos2.data.none')}</span>
        ) : (
          // 没有数字：直接说这几个源是怎么回事（取数另有来路 / 去连 / 还没做）
          <div className="flex flex-col gap-1.5">
            {offline.map((s) => (
              <section key={s.source} data-testid="view-section" data-source={s.source}>
                <SectionStatus section={s} />
              </section>
            ))}
            {offline.length === 0 ? (
              <span className="text-xs text-ws-muted-fg">{t('pos2.data.empty')}</span>
            ) : null}
          </div>
        )}
      </div>
      {expanded ? (
        <div className="flex flex-col gap-4" data-testid="data-charts" data-role={duty.role_id}>
          <StoreSections
            id={duty.assignment_id}
            range={range}
            view={view.data}
            skip={new Set(tiles.slice(0, MAX_TILES).map((b) => b.id))}
          />
        </div>
      ) : null}
    </div>
  )
}

export function DataBoard({
  duties,
  expanded,
  onExpanded,
  owner,
  empty = false,
}: {
  duties: readonly BoardDuty[]
  expanded: boolean
  onExpanded(next: boolean): void
  /** 新岗位、还没开工：不画空图表，只留一行（`position-v2-empty.html`） */
  empty?: boolean
  /** 店主那条分配；有 = 看的人是店主（没挂范围时给一键挂品牌） */
  owner?: string | undefined
}): ReactNode {
  const { t } = useApp()
  const [range, setRange] = useState<RangeName>('yesterday')
  const noRange = duties.filter((d) => d.ranges !== undefined && d.ranges.length === 0)
  const shown = duties.filter((d) => !noRange.includes(d))
  const first = noRange[0]
  // 同一个数字块谁先摆：按职责顺序，第一条拥有它（与各行自己的查询同一把缓存键，不多发请求）
  const views = useQueries({
    queries: shown.map((d) => ({
      queryKey: ['view', d.assignment_id, range],
      queryFn: () => getPositionView(d.assignment_id, range),
    })),
  })
  const takenBefore: Map<string, string>[] = []
  const seen = new Map<string, string>()
  shown.forEach((d, i) => {
    takenBefore.push(new Map(seen))
    for (const s of views[i]?.data?.sections ?? [])
      if (s.connected)
        for (const b of s.blocks) if (isTile(b) && !seen.has(b.id)) seen.set(b.id, d.role_name)
  })
  /*
   * WP295（docs/96 P3「没有内容不出」）：几条职责还没动静，就并成一行说一次。
   *
   * 红人营销五条渠道职责：以前「开工后这里出数」一行一遍摆五遍；有了数字块之后，
   * 没用的那几条渠道又是一排一排的 0。现在：有数的职责照常一行；其余（还没有数字块、
   * 也没有要连的源，或者几个数全是 0）收成一行「X、Y：还没有数」。一条都没动静时留第一条
   * 那一行（看得见这个岗位看的是哪几个数），其余照样并起来。只有一条职责的岗位不受影响。
   * 展开「看图表」时同样并（没动静的职责展开来只是一摞空表）。
   * 数字块的取数与 `MiniTile` 同一把缓存键，不多发请求。
   */
  const tileIds = shown.map((d, i) => {
    const mine = (views[i]?.data?.sections ?? [])
      .filter((s) => s.connected)
      .flatMap((s) => s.blocks.filter(isTile))
      .filter((b) => !(takenBefore[i] ?? new Map()).has(b.id))
    return mine.slice(0, MAX_TILES).map((b) => ({ id: b.id, assignment: d.assignment_id }))
  })
  const tileData = useQueries({
    queries: tileIds.flat().map((tile) => ({
      queryKey: ['block', tile.id, range, tile.assignment],
      queryFn: () => getBlockData(tile.id, range, tile.assignment),
    })),
  })
  const tileValue = new Map<string, { done: boolean; value: number | undefined }>()
  tileIds.flat().forEach((tile, k) => {
    const q = tileData[k]
    const payload =
      q?.data?.status === 'ok' ? (q.data.payload as { value?: number } | undefined) : undefined
    tileValue.set(`${tile.assignment}/${tile.id}`, {
      done: q !== undefined && !q.isPending,
      value: payload?.value,
    })
  })
  const quiet = shown.map((d, i) => {
    const view = views[i]
    if (view === undefined || view.isPending) return false
    const sections = view.data?.sections ?? []
    const tiles = tileIds[i] ?? []
    if (tiles.length === 0) {
      // 和别的职责共用同一份数的那一行（「和 X 看的是同一份数」）照旧出
      const all = sections.filter((s) => s.connected).flatMap((s) => s.blocks.filter(isTile))
      if (all.length > 0) return false
      // 没有数字块：只有「也没有要连的源」才算没动静（要连的源那一行是有用的提示）
      return sections.every((s) => s.connected)
    }
    return tiles.every((tile) => {
      const v = tileValue.get(`${d.assignment_id}/${tile.id}`)
      return v?.done === true && (v.value === undefined || v.value === 0)
    })
  })
  // 展开图表时也并：没动静的职责展开来是一摞空表，看了也白看
  const merge = shown.length > 1
  const active = merge ? shown.filter((_, i) => quiet[i] !== true) : shown
  const keep = merge && active.length === 0 ? shown.slice(0, 1) : active
  const resting = merge ? shown.filter((d) => !keep.includes(d)) : []
  if (empty && first === undefined)
    return (
      <section className="flex flex-col gap-2" data-testid="data-board" data-empty="true">
        <h3 className="ws-display text-base">{t('pos2.data.title')}</h3>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-slot="status">
          <BarChart3 className="size-4" aria-hidden />
          {t('pos2.data.empty')}
        </p>
      </section>
    )
  return (
    <section className="flex flex-col gap-3" data-testid="data-board">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="ws-display text-base">{t('pos2.data.title')}</h3>
        <Hint text={t('pos2.data.hint')} />
        <span className="ml-auto flex items-center gap-1">
          <Segmented
            size="sm"
            label={t('pos2.data.title')}
            value={range}
            reselect
            options={RANGES.map((r) => ({ value: r, label: t(`range.${r}`) }))}
            onChange={setRange}
          />
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            data-testid="data-charts-toggle"
            onClick={() => {
              onExpanded(!expanded)
            }}
          >
            <BarChart3 className="size-3.5" aria-hidden />
            {expanded ? t('pos2.data.charts.hide') : t('pos2.data.charts')}
          </Button>
        </span>
      </div>
      {first === undefined ? null : (
        <NoRangeNotice
          id={first.assignment_id}
          isOwner={owner !== undefined}
          ownerAssignment={owner}
        />
      )}
      {shown.length === 0 ? null : (
        <div className="rounded-xl border bg-card">
          {keep.map((d) => (
            <DutyRow
              key={d.assignment_id}
              duty={d}
              range={range}
              expanded={expanded}
              taken={takenBefore[shown.indexOf(d)] ?? new Map()}
            />
          ))}
          {resting.length === 0 ? null : (
            <div
              className="flex items-center gap-1.5 px-4 py-3 text-xs text-ws-muted-fg"
              data-testid="data-row-quiet"
            >
              <BarChart3 className="size-3.5 shrink-0" aria-hidden />
              <span>
                {t('pos2.data.quiet', { duties: resting.map((d) => d.role_name).join('、') })}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
