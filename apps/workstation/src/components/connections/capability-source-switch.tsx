/**
 * 连接页每张数据类卡上的那一个开关：**用我的 / 用 agentsws 的**（49 M2）。
 *
 * 默认永远是"用我的"——开源本地优先（40 §1）：填自己的 token、本地直连、一分不扣。
 * 拨到"用 agentsws 的"就是走云上的配额池，按次计价。
 *
 * **不是每张卡都有这个开关**，只有"我们真有第二条路"的那几张才有：
 *
 * | 卡 | 有没有 | 为什么 |
 * |---|---|---|
 * | Meta 广告（Facebook / Instagram） | 有 | 社媒平台数据，我们有配额池（49 M2 表里那一行） |
 * | Shopify 店铺 | 没有 | 那是**你自己店里**的数据，我们没有第二条路可走 |
 * | Google Analytics / Search Console | 没有 | 同上：你自己账号里的数据，没有你的授权谁也读不到 |
 * | 任意邮箱 / Gmail | 没有 | 收发信必须用你自己的邮箱，代收是另一回事 |
 *
 * 给一张没有第二条路的卡画一个灰着的开关，比不画更糟——它在暗示"充钱就能用"。
 * 所以这里是一张**显式的对照表**，加一家就在这里补一行。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Switch } from '@/components/ui/switch'
import type { CapabilitySource } from '@/lib/api'
import { getCapabilitySources, setCapabilitySources } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/**
 * 连接目录里的 `service` → 价目表里的能力名。没有对应项的卡不出开关。
 *
 * WP68 加了红人那五条渠道（49 M2 表里「公共红人库 / 邮箱抓取 / 体检报告」那一行）：
 * 拨到"用 agentsws 的"之后，这条渠道的**找人**改查云端公共红人库——
 * 浏览免费，取回一个邮箱才扣积分（`data.kol.lookup`），而且**在点之前就把数说出来**。
 * 键用 `kol.<channel>` 而不是 `data.kol.lookup`：五条渠道各拨各的
 * （只有 TikTok 没申请下来、只想那一条走公共库，是个很正常的用法）。
 */
export const CAPABILITY_BY_SERVICE: Record<string, string> = {
  meta_ads: 'social.fetch',
  youtube_data: 'kol.youtube',
  instagram_graph: 'kol.instagram',
  facebook_graph: 'kol.facebook',
  tiktok_research: 'kol.tiktok',
  x_api: 'kol.x',
}

export function capabilityOf(service: string): string | undefined {
  return CAPABILITY_BY_SERVICE[service]
}

export function CapabilitySourceSwitch({
  service,
  /** 这张卡用户自己连上没有——没连上时多说一句"可以用 agentsws 的"。 */
  connected,
  assignment,
}: {
  service: string
  connected: boolean
  assignment?: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const capability = capabilityOf(service)

  const sources = useQuery({
    queryKey: ['capability-sources', assignment],
    queryFn: () => getCapabilitySources(assignment),
    retry: false,
  })

  const save = useMutation({
    mutationFn: (next: Record<string, CapabilitySource>) => setCapabilitySources(next, assignment),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['capability-sources'] })
      // 切换即时生效：数据源状态跟着变，首页与岗位面板要重画
      void client.invalidateQueries({ queryKey: ['home'] })
      void client.invalidateQueries({ queryKey: ['view'] })
    },
  })

  if (capability === undefined) return null

  const current = sources.data?.capability_sources[capability] ?? 'mine'
  const useOurs = current === 'agentsws'

  return (
    <div className="flex flex-col gap-1" data-testid="capability-source" data-service={service}>
      {/*
        用 div 而不是 label：Radix 的 Switch 渲染成 <button>，label 包一个 button
        既不合 a11y 规则，点标签文字也不会切换。开关自己带 aria-label。
      */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={useOurs ? 'text-muted-foreground' : 'font-medium'}>
          {t('capability.mine')}
        </span>
        <Switch
          checked={useOurs}
          disabled={save.isPending || sources.isPending}
          data-testid="capability-source-switch"
          data-capability={capability}
          aria-label={t('capability.aria', { capability })}
          onCheckedChange={(checked) => {
            const next = { ...(sources.data?.capability_sources ?? {}) }
            next[capability] = checked ? 'agentsws' : 'mine'
            save.mutate(next)
          }}
        />
        <span className={useOurs ? 'font-medium' : 'text-muted-foreground'}>
          {t('capability.ours')}
        </span>
      </div>
      {/*
        没配自己的 token 时那句提示（49 M2 末段）。已经连上的不出——
        连上了还劝人花钱是推销，不是帮忙。
      */}
      {!connected && !useOurs ? (
        <p className="text-[11px] text-muted-foreground" data-testid="capability-source-nudge">
          {t('capability.nudge')}
        </p>
      ) : null}
      {useOurs ? (
        <p className="text-[11px] text-muted-foreground" data-testid="capability-source-billing">
          {t('capability.billing')}
        </p>
      ) : null}
      {save.error === null || save.error === undefined ? null : (
        <p className="text-[11px] text-destructive">{save.error.message}</p>
      )}
    </div>
  )
}
