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
// WP83（54（将改号 55）§4 第二层）：「连上这 N 个就能开工」
import { PositionConnections } from '@/components/connections/position-connections'
import { DeckSection } from '@/components/deck'
import { channelOfRole, KolPanel } from '@/components/kol/kol-panel'
import { ScheduleList } from '@/components/schedule-list'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LayerMemory } from '@/components/work/layer-memory'
import { PositionEntry } from '@/components/work/position-entry'
import { getPosition, getPositionRecords, getPositions, getPositionView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'
import { assignmentForPosition } from '@/lib/positions'

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

/**
 * WP57（48 §3 L1）：网站在线客服这条岗位的面板入口。
 *
 * 它与别的面板块不是一类东西——别的块是数字，这一块是一扇门：在线客服的产出
 * 不在图表里，在对话里。所以它只出现在 `dtc.live-chat` 上，而且排在最前面。
 */
function ChatSandboxEntry(): React.ReactNode {
  const { t } = useApp()
  return (
    <Card data-testid="chat-sandbox-entry">
      <CardHeader>
        <CardTitle className="text-sm">{t('chat.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p>{t('chat.subtitle')}</p>
        <div>
          <Button size="sm" variant="outline" asChild>
            <Link to="/chat">{t('chat.entry.open')}</Link>
          </Button>
        </div>
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
  const isLiveChat = here?.role_id === 'dtc.live-chat'
  /*
   * WP68（48 §5.1）：红人那五条渠道职责的面板上多一块**能动手的**——
   * 找人 / 建联 / 合作三件事在 deck 的只读表格里做不了。它排在数字块之前，
   * 与在线客服那一张同一个道理：这条职责的产出不在图表里，在这些动作里。
   */
  const kolChannel = channelOfRole(here?.role_id)
  if (view.isPending) return <Skeleton className="h-64 w-full" />
  if (here !== undefined && here.ranges.length === 0)
    return <NoRangeNotice id={id} isOwner={isOwner} />
  return (
    <div className="flex flex-col gap-6">
      {/* WP57：在线客服的入口排在最前——它的产出在对话里，不在数字块里 */}
      {isLiveChat ? <ChatSandboxEntry /> : null}
      {kolChannel === undefined ? null : <KolPanel assignment={id} channel={kolChannel} />}
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
              <CardContent className="flex flex-col gap-2">
                {/*
                  WP62 / WP63（36 §3）：**没连**与**还没做**是两回事。
                  有 `note` 就是后者（这个平台我们还没接 / 这个连接器还没做）——
                  照实说那句话，并且**不给「去连接」按钮**：点进去无处可点的按钮，
                  会让人在连接页上反复找、以为是自己哪里填错了。
                */}
                {section.note === undefined ? (
                  <div>
                    <Button size="sm" variant="outline" asChild>
                      {/* WP20 §C：直接落到那一个 provider 的卡片上，不让用户自己找 */}
                      <Link to={connectPathFor(section.source)}>{t('view.connect')}</Link>
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground" data-testid="source-note">
                    {section.note}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </section>
      ))}
    </div>
  )
}

/**
 * WP69（54 §3）「记忆」tab：岗位层那一份在上，这个岗位下每条职责那一份在下。
 *
 * 两层分开列，不合成一份——合起来就说不清"这句话是这家公司的网站运营都这么做，
 * 还是只有店铺管理这条活儿才这样"。
 */
function MemoryTab({ id }: { id: string }): React.ReactNode {
  const { t } = useApp()
  const position = useQuery({
    queryKey: ['position-instance', id],
    queryFn: () => getPosition(id),
    enabled: id !== '',
  })
  if (position.isPending) return <Skeleton className="h-40 w-full" />
  if (position.error !== null || position.data === undefined)
    return <p className="text-sm text-muted-foreground">—</p>
  const view = position.data
  return (
    <div className="flex flex-col gap-6" data-testid="position-memory">
      <section>
        <h3 className="mb-2 text-sm font-medium">{t('memory.position', { name: view.name.zh })}</h3>
        <LayerMemory tier="position" scopeId={view.position_id} />
      </section>
      {view.roles.map((r) => (
        <section key={r.role_id} data-testid="role-memory" data-role={r.role_id}>
          <h3 className="mb-2 text-sm font-medium">{t('memory.role', { name: r.role_name })}</h3>
          <LayerMemory tier="role" scopeId={r.role_id} />
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
  const { t, selectPosition, position } = useApp()
  const params = useParams<{ id: string }>()
  const [search, setSearch] = useSearchParams()
  const id = params.id ?? ''
  const tab = search.get('tab') ?? 'cards'
  // WP70：当前分配跟着**岗位**走，所以要知道这条 id 属于哪个岗位（左栏那份就够）
  const mine = useQuery({ queryKey: ['positions'], queryFn: getPositions })

  /*
   * 进岗位页就把当前 Assignment 切过去（31 §3.1 一次请求一个 Assignment）。
   *
   * WP70（54 §4）：切的粒度是**岗位**——当前分配已经属于这个岗位就不动它
   * （职责层的切换只在岗位页折叠层里做，点一下左栏不该把人顶回第一条职责）；
   * 不属于就换成地址栏这条。
   */
  useEffect(() => {
    if (id === '') return
    const next = assignmentForPosition(mine.data?.instances, id, position)
    if (next !== position) selectPosition(next)
  }, [id, mine.data?.instances, position, selectPosition])

  return (
    <div className="flex flex-col gap-4" data-testid="position-page" data-position={id}>
      {/*
        WP69（54 §2 / §4）：岗位页顶部那个按钮 + 折叠着的职责层。
        它排在 Tab 之上，因为"交给这个岗位一件事"不属于任何一个 Tab——
        卡片 / 面板 / 记录 / 记忆都是"看"，只有它是"做"。
      */}
      <PositionEntry id={id} />
      {/*
        WP83（54 §4 第二层）：这个岗位还缺哪几个连接。
        排在入口按钮之下、Tab 之上——它既不属于"看"（那四个 Tab），也不是"做"，
        而是"还开不了工"；连完最后一个它自己消失，不占地方。
      */}
      <PositionConnections id={id} />
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
          {/* WP69（54 §3）：这个岗位攒下来的规矩 */}
          <TabsTrigger value="memory">{t('position.tab.memory')}</TabsTrigger>
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
        <TabsContent value="memory">
          <MemoryTab id={id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
