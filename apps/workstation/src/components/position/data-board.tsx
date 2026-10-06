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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BarChart3, Link2Off, ScanSearch } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { BlockCard } from '@/components/blocks/block-view'
import { connectPathFor } from '@/components/connections/links'
import { DeltaPill } from '@/components/design'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { GoogleSourcePicker } from '@/components/seo/google-source-picker'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyLine } from '@/components/ui/empty-line'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { currentSession, getBlockData, getPositionView, updateAssignmentRanges } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatValue } from '@/lib/format'

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
  const { t } = useApp()
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
              <Button size="sm" variant="outline" asChild>
                <Link to="/org?tab=positions" data-testid="no-range-assign">
                  {t('view.no_range.action')}
                </Link>
              </Button>
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
        ? { action: { label: t('view.connect'), to: connectPathFor(section.source) } }
        : {})}
    />
  )
}

/** 原来面板上的整块：按数据源分块，数字块一排、图表两列（展开「看图表」时出）。 */
export function StoreSections({
  id,
  range,
  view,
}: {
  id: string
  range: RangeName
  view: ViewResult | undefined
}): ReactNode {
  return (
    <>
      {(view?.sections ?? []).map((section) => (
        <section key={section.source} data-testid="view-section" data-source={section.source}>
          <h3 className="ws-display mb-2.5 text-[15px]">{section.label}</h3>
          {section.connected ? (
            <div className="flex flex-col gap-4">
              {section.source === 'gsc' || section.source === 'ga4' ? (
                <GoogleSourcePicker assignment={id} source={section.source} />
              ) : null}
              {section.blocks.filter(isTile).length === 0 ? null : (
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="view-tiles">
                  {section.blocks.filter(isTile).map((block) => (
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
      <span className="truncate text-xs text-ws-muted-fg">{block.title}</span>
      {query.isPending ? (
        <Skeleton className="h-6 w-16" />
      ) : (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="ws-display ws-num text-[20px] leading-none">
            {payload?.value === undefined
              ? '—'
              : formatValue(
                  payload.value,
                  payload.currency === undefined ? 'count' : 'money',
                  lang,
                  payload.currency,
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
}: {
  duty: BoardDuty
  range: RangeName
  expanded: boolean
}): ReactNode {
  const { t } = useApp()
  const view = useQuery({
    queryKey: ['view', duty.assignment_id, range],
    queryFn: () => getPositionView(duty.assignment_id, range),
  })
  const sections = view.data?.sections ?? []
  const tiles = sections.filter((s) => s.connected).flatMap((s) => s.blocks.filter(isTile))
  const offline = sections.filter((s) => !s.connected)
  return (
    <div
      className="flex flex-col gap-3 border-b px-4 py-3 last:border-b-0"
      data-testid="data-row"
      data-role={duty.role_id}
    >
      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <DutyIcon role_id={duty.role_id} size={15} />
          <span className="truncate">{duty.role_name}</span>
        </div>
        {view.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : tiles.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
          <StoreSections id={duty.assignment_id} range={range} view={view.data} />
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
  if (empty && first === undefined)
    return (
      <section className="flex flex-col gap-2" data-testid="data-board" data-empty="true">
        <h3 className="ws-display text-[17px]">{t('pos2.data.title')}</h3>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-slot="status">
          <BarChart3 className="size-4" aria-hidden />
          {t('pos2.data.empty')}
        </p>
      </section>
    )
  return (
    <section className="flex flex-col gap-3" data-testid="data-board">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="ws-display text-[17px]">{t('pos2.data.title')}</h3>
        <Hint text={t('pos2.data.hint')} />
        <span className="ml-auto flex items-center gap-1">
          {RANGES.map((r) => (
            <Button
              key={r}
              size="xs"
              variant={range === r ? 'secondary' : 'ghost'}
              aria-pressed={range === r}
              onClick={() => {
                setRange(r)
              }}
            >
              {t(`range.${r}`)}
            </Button>
          ))}
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
          {shown.map((d) => (
            <DutyRow key={d.assignment_id} duty={d} range={range} expanded={expanded} />
          ))}
        </div>
      )}
    </section>
  )
}
