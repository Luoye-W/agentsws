/**
 * WP179（Luoye 09-29「官方功能优先」）：**用你的 DeepSeek 账号搜索**——一个开关。
 *
 * 是数据接口路由（docs/75）里 `web.search` 这一项能力的第一级（`deepseek_native`）：
 * 开着 = 查资料的岗位（内容与搜索、B2B、红人、店铺、投放）干活时能上网搜索；
 * 用你登录的 DeepSeek 账号（没登录就用你填的 DeepSeek 官方 key）付这次搜索的钱，工坊不扣积分。
 * 关掉 = 不上网搜（抓指定网页照旧可以）。
 *
 * 界面少字：卡面上一行开关 + 一句状态，细节进问号。这一项现在只有一级，所以不画顺序箭头
 * （以后多一级再画，存的形状已经是 `order` + `disabled`）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Hint } from '@/components/ui/hint'
import { Switch } from '@/components/ui/switch'
import { getCapabilitySources, setCapabilitySources } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 数据接口路由里网页搜索那一项的键（与契约 `WEB_SEARCH_ROUTE_KEY` 同一个）。 */
const ROUTE_KEY = 'web.search'

export function WebSearchToggle({
  assignment,
  ready,
}: {
  assignment?: string | undefined
  /** 手上有没有能搜的凭据（登录了 DeepSeek 账号，或填了 DeepSeek 官方 key）。 */
  ready: boolean
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const sources = useQuery({
    queryKey: ['capability-sources', assignment],
    queryFn: () => getCapabilitySources(assignment),
    retry: false,
  })
  const save = useMutation({
    mutationFn: (on: boolean) =>
      setCapabilitySources(sources.data?.capability_sources ?? {}, assignment, {
        [ROUTE_KEY]: { order: ['deepseek_native'], disabled: on ? [] : ['deepseek_native'] },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['capability-sources'] }),
  })
  if (sources.isLoading) return null
  const on = !(sources.data?.data_source_routing?.[ROUTE_KEY]?.disabled ?? []).includes(
    'deepseek_native',
  )
  const status = !on ? t('web.search.off') : ready ? t('web.search.on') : t('web.search.no_key')
  return (
    <section className="flex flex-col gap-1" data-testid="web-search-toggle">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1 font-medium">
          {t('web.search.title')}
          <Hint text={t('web.search.hint')} testId="web-search-hint" />
        </span>
        <Switch
          checked={on}
          disabled={save.isPending || sources.isPending}
          data-testid="web-search-switch"
          aria-label={t('web.search.title')}
          onCheckedChange={(checked) => save.mutate(checked)}
        />
      </div>
      <p className="text-[11px] text-muted-foreground" data-slot="status">
        {status}
      </p>
      {save.error === null || save.error === undefined ? null : (
        <p className="text-[11px] text-destructive">{save.error.message}</p>
      )}
    </section>
  )
}
