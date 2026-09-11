/**
 * 岗位页 = 该岗位的世界（36 §3）：卡片 / 面板 / 记录 三个 Tab。
 *
 * 面板按数据源分块（店铺后台 / GA4 / Search Console / 广告后台）；
 * 数据源没接时出「去连接」，不出空图。
 */
import type { RangeName } from '@agentsws/deck'
import { useQuery } from '@tanstack/react-query'
import { Link2Off, ScanSearch } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { BlockCard } from '@/components/blocks/block-view'
import { connectPathFor } from '@/components/connections/links'
import { DeckSection } from '@/components/deck'
import { ScheduleList } from '@/components/schedule-list'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getPositionRecords, getPositions, getPositionView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'

const RANGES: RangeName[] = ['yesterday', 'last_7d']

/**
 * 44 / 09-11 真店验收的后置项：**没挂范围的岗位要明说**。
 *
 * 那次验收里岗位的 `ranges: []`，于是 19 §3 的过滤下推把整个「店铺后台」分块
 * 静默去掉了——页面上什么都没有，也没有一个字解释为什么。现在这里说人话，
 * 并且给 owner 一个"去分配"的按钮（不是 owner 的人点不到，只看到那句话）。
 */
function NoRangeNotice({ id, isOwner }: { id: string; isOwner: boolean }): React.ReactNode {
  const { t } = useApp()
  return (
    <Card data-testid="no-range-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <ScanSearch className="size-4" aria-hidden />
          {t('view.no_range')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p>{t('view.no_range.detail')}</p>
        {isOwner ? (
          <div>
            <Button size="sm" variant="outline" asChild>
              <Link to="/org?tab=positions" data-testid="no-range-assign">
                {t('view.no_range.action')}
              </Link>
            </Button>
          </div>
        ) : (
          <p data-testid="no-range-ask-owner">{t('view.no_range.ask_owner')}</p>
        )}
      </CardContent>
    </Card>
  )
}

function ViewTab({ id }: { id: string }): React.ReactNode {
  const { t } = useApp()
  const [range, setRange] = useState<RangeName>('yesterday')
  const view = useQuery({
    queryKey: ['view', id, range],
    queryFn: () => getPositionView(id, range),
  })
  // 左栏那份岗位清单里就有 ranges 与 role_id，不用为这一句再加一条接口
  const mine = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const here = mine.data?.positions.find((p) => p.position_id === id)
  const isOwner = (mine.data?.positions ?? []).some((p) => p.role_id === 'common.owner')
  if (view.isPending) return <Skeleton className="h-64 w-full" />
  if (here !== undefined && here.ranges.length === 0)
    return <NoRangeNotice id={id} isOwner={isOwner} />
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-1">
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
      </div>
      {(view.data?.sections ?? []).map((section) => (
        <section key={section.source} data-testid="view-section" data-source={section.source}>
          <h3 className="mb-2 text-sm font-medium">{section.label}</h3>
          {section.connected ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {section.blocks.map((block) => (
                <BlockCard key={block.id} block={block} range={range} assignment={id} />
              ))}
            </div>
          ) : (
            <Card data-testid="connect-card">
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <Link2Off className="size-4" aria-hidden />
                  {t('view.not_connected', { source: section.label })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Button size="sm" variant="outline" asChild>
                  {/* WP20 §C：直接落到那一个 provider 的卡片上，不让用户自己找 */}
                  <Link to={connectPathFor(section.source)}>{t('view.connect')}</Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </section>
      ))}
    </div>
  )
}

function RecordsTab({ id }: { id: string }): React.ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <RecordRows id={id} />
      {/* 25 §3：机器在替你定时做哪几件事，这里看得见也停得掉 */}
      <ScheduleList positionId={id} />
    </div>
  )
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
            <span className="font-mono">{row.state}</span>
          </div>
          <div className="text-sm">{row.title}</div>
          <p className="text-xs text-muted-foreground">{row.summary}</p>
        </li>
      ))}
    </ol>
  )
}

export function PositionPage(): React.ReactNode {
  const { t, selectPosition } = useApp()
  const params = useParams<{ id: string }>()
  const [search, setSearch] = useSearchParams()
  const id = params.id ?? ''
  const tab = search.get('tab') ?? 'cards'

  // 进岗位页就把当前 Assignment 切过去（31 §3.1 一次请求一个 Assignment）
  useEffect(() => {
    if (id !== '') selectPosition(id)
  }, [id, selectPosition])

  return (
    <div className="flex flex-col gap-4" data-testid="position-page" data-position={id}>
      <Tabs
        value={tab}
        onValueChange={(next) => {
          setSearch((prev) => {
            const params = new URLSearchParams(prev)
            params.set('tab', next)
            return params
          })
        }}
      >
        <TabsList>
          <TabsTrigger value="cards">{t('position.tab.cards')}</TabsTrigger>
          <TabsTrigger value="view">{t('position.tab.view')}</TabsTrigger>
          <TabsTrigger value="records">{t('position.tab.records')}</TabsTrigger>
        </TabsList>
        <TabsContent value="cards">
          {/* 37 §1：与首页同一副牌，只是钉死在这个岗位上 */}
          <DeckSection positionId={id} onOpen={() => {}} />
        </TabsContent>
        <TabsContent value="view">
          <ViewTab id={id} />
        </TabsContent>
        <TabsContent value="records">
          <RecordsTab id={id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
