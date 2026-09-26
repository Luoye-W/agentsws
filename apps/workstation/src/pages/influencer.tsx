/**
 * WP119c：**插件深链的落点**（docs/76 §10）。
 *
 * 完整版面板的「去工作台看」会打开这五条路径里的前两条：
 *
 * - `/influencer/creators?creator=<handle|id>`——落到红人面板，能带出那一个人的
 *   详情（认得 handle 也认得 creator_id）；
 * - `/influencer/setup`——同一条面板，默认落在「导入与 campaign」那一格。
 * - `/influencer/creators?batch=<bt_…>[&channel=<渠道>]`（WP131）——插件列表采集完点
 *   「回作战室看这批」：候选池只列这一次收进来的人；带了 `channel` 就落到那条渠道的职责上。
 *
 * `/settings/credits`、`/settings/billing`、`/settings/apikeys` 三条直接复用设置页
 * 的「账号与积分」那一档（App.tsx 里接的），不经过这个文件。
 *
 * 深链的对象是**从插件跳过来的人**：他刚在页面上存了一个红人，想看工作台里
 * 长什么样。所以这里的空态要说清"为什么这里没有东西、去哪儿配"，而不是一张
 * 干巴巴的 404。
 */
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { channelOfRole, KolPanel } from '@/components/kol/kol-panel'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { getKolCreators, getPositions } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function InfluencerPage({ setup = false }: { setup?: boolean }): React.ReactNode {
  const { t } = useApp()
  const [search] = useSearchParams()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })

  if (positions.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  // 红人面板按渠道分职责（kol.youtube → youtube）。有多条就取第一条——
  // 深链要的是一个"能看"的地方，不是一道选择题。WP131：深链带了 `channel`
  // （插件那一批来自哪条渠道）就先找那条渠道的职责，找不到再退回第一条。
  const wanted = search.get('channel')
  const kolPositions = (positions.data?.positions ?? []).filter(
    (p) => channelOfRole(p.role_id) !== undefined,
  )
  const kol =
    kolPositions.find((p) => wanted !== null && channelOfRole(p.role_id) === wanted) ??
    kolPositions[0]
  if (kol === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('influencer.empty.title')}</CardTitle>
        </CardHeader>
        {/* WP157：写死的中文走 i18n；空态那一句不再露职责 id */}
        <CardContent className="text-sm text-muted-foreground">{t('influencer.empty')}</CardContent>
      </Card>
    )
  }

  const channel = channelOfRole(kol.role_id)
  if (channel === undefined) return null

  return (
    <KolPanelLoader
      assignment={kol.position_id}
      channel={channel}
      {...(search.get('creator') === null ? {} : { focusCreator: search.get('creator') as string })}
      {...(setup ? { defaultSubview: 'campaign' as const } : {})}
    />
  )
}

/**
 * 深链里的 `?creator=` 可能是 handle（插件那边的习惯）也可能是 creator_id
 * （工作台数据那边的习惯）。这里对一次红人库清单，把两种都翻成 creator_id；
 * 对不上就当没给——面板照常打开，比报错有用。
 */
function KolPanelLoader({
  assignment,
  channel,
  focusCreator,
  defaultSubview,
}: {
  assignment: string
  channel: 'youtube' | 'facebook' | 'instagram' | 'tiktok' | 'x'
  focusCreator?: string
  defaultSubview?: 'pool' | 'campaign' | 'threads'
}): React.ReactNode {
  const library = useQuery({
    queryKey: ['kol-creators', assignment, channel],
    queryFn: () => getKolCreators({ channel }, assignment),
  })
  const rows = library.data?.rows ?? []
  const needle = focusCreator?.trim().toLowerCase()
  const resolved =
    needle === undefined || needle === ''
      ? undefined
      : (
          rows.find((r) => r.creator_id.toLowerCase() === needle) ??
          rows.find((r) => r.handle.replace(/^@+/, '').toLowerCase() === needle)
        )?.creator_id

  return (
    <KolPanel
      assignment={assignment}
      channel={channel}
      {...(resolved === undefined ? {} : { initialOpenCreator: resolved })}
      {...(defaultSubview === undefined ? {} : { defaultSubview })}
    />
  )
}
