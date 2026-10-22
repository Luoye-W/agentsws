/**
 * WP179：**联网搜索**——一个开关。WP353（决策 911 / 912）起不再用 DeepSeek 自带搜索：
 * 用工坊自己的内置浏览器搜 Google（回退 Bing → 云端搜索 → 公开搜索服务），不花积分、不要任何账号或 key。
 *
 * 存的仍是数据接口路由（docs/75）里 `web.search` 这一项的第一级（键名 `deepseek_native` 是历史名字，
 * 存的形状不改）：开着 = 查资料的岗位与随便聊能上网搜索；关掉 = 不上网搜（抓指定网页照旧可以）。
 *
 * 界面少字：卡面上一行开关 + 一句状态，细节进问号。这一项现在只有一级，所以不画顺序箭头
 * （以后多一级再画，存的形状已经是 `order` + `disabled`）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { StatusIcons } from '@/components/design'
import { Hint } from '@/components/ui/hint'
import { Switch } from '@/components/ui/switch'
import { getCapabilitySources, setCapabilitySources } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 数据接口路由里网页搜索那一项的键（与契约 `WEB_SEARCH_ROUTE_KEY` 同一个）。 */
const ROUTE_KEY = 'web.search'

export function WebSearchToggle({
  assignment,
  ready = true,
}: {
  assignment?: string | undefined
  /** 这里能不能搜（WP353 起不再看 DeepSeek 凭据；缺省能）。 */
  ready?: boolean
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
        <span className="flex items-center gap-2">
          <StatusIcons
            testId="web-search-state"
            items={[
              {
                key: 'search',
                label: t('web.search.title'),
                state: !on ? 'unknown' : ready ? 'ok' : 'fail',
                stateText: status,
                icon: Search,
              },
            ]}
          />
          <Switch
            checked={on}
            disabled={save.isPending || sources.isPending}
            data-testid="web-search-switch"
            aria-label={t('web.search.title')}
            onCheckedChange={(checked) => save.mutate(checked)}
          />
        </span>
      </div>
      {/*
        WP214（36 §7 第四档）：开关本身已经说了开 / 关，那一整句不再常显——
        开着能搜 / 关着：一个小图标（状态那句在 tooltip）；开着但搜不了：原因常显一句人话。
      */}
      {on && !ready ? (
        <p className="text-xs text-ws-warn" data-slot="status" data-testid="web-search-reason">
          {status}
        </p>
      ) : null}
      {save.error === null || save.error === undefined ? null : (
        <p className="text-xs text-destructive">{save.error.message}</p>
      )}
    </section>
  )
}
