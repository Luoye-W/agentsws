/**
 * WP288（决策 326，Luoye 10-09）：**连接正常 = 标题旁一个绿色小勾**，不再在标题下铺一行
 * 「已授权管理商品和页面 · 会自动续期 · 重新授权」。
 *
 * - 悬停 tooltip 说连上了什么（「Shopify 已连接 · 会自动续期」/「已连接：店铺后台、GA4」）；
 * - 点它去连接页（Shopify 那一路直接落到那张卡）；
 * - **出问题时不画勾**：缺必需连接、授权过期 / 缺权限 / 没授权、建站还差一步——那几种由页上那一行
 *   醒目提示说（`position-missing-banner` / `ShopAdminBanner` / `SiteThemeBanner`），勾与提示不同时出。
 * - 一个连接都不需要的岗位（设计…）不画：没有「连接正常」这回事。
 *
 * 数据与那三行读同一把缓存（同一个 key），不多发请求。
 */
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { getPositionConnections, getSiteTheme } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { shopAdminQuery, shopAdminUntil } from './shop-admin-banner'

/** 网页模板那条职责（与 `SiteThemeBanner` 同一张表）。 */
const THEME_ROLES = ['site.shopify-theme', 'site.builder']

export function ConnectionTick({
  id,
  duties,
}: {
  id: string
  duties: readonly { role_id: string; assignment_id: string }[]
}): ReactNode {
  const { t, lang } = useApp()
  const connections = useQuery({
    queryKey: ['position-connections', id],
    queryFn: () => getPositionConnections(id),
    enabled: id !== '',
  })
  const sa = shopAdminQuery(duties)
  const shop = useQuery({
    queryKey: sa.queryKey,
    queryFn: sa.queryFn,
    enabled: sa.enabled,
    retry: false,
  })
  const themeAssignment = duties.find((d) => THEME_ROLES.includes(d.role_id))?.assignment_id
  const theme = useQuery({
    queryKey: ['site-theme', themeAssignment ?? ''],
    queryFn: () => getSiteTheme(themeAssignment ?? ''),
    enabled: themeAssignment !== undefined,
    retry: false,
  })

  const data = connections.data
  if (data === undefined) return null
  // 还在问的不先画勾（免得画了又收）
  if (sa.enabled && shop.isPending) return null
  if (themeAssignment !== undefined && theme.isPending) return null

  const missing = new Set(data.missing_required)
  if (data.items.some((i) => i.required && missing.has(i.kind))) return null
  const s = shop.data
  const shopHere = s?.applicable === true && s.state !== undefined
  if (s !== undefined && shopHere && s.state !== 'authorized') return null
  if (theme.data?.applicable === true && theme.data.next !== undefined) return null

  const connected = data.items.filter((i) => i.connected)
  if (!shopHere && connected.length === 0) return null

  const lines: string[] = []
  if (s !== undefined && shopHere) {
    const until = shopAdminUntil(s, t, lang)
    lines.push(
      until === undefined ? t('pos2.tick.shopify') : `${t('pos2.tick.shopify')} · ${until}`,
    )
  }
  const names = connected
    .filter((i) => !(shopHere && i.connect_service === 'shopify_admin'))
    .map((i) => (lang === 'en' ? i.name.en : i.name.zh))
  if (names.length > 0)
    lines.push(t('pos2.tick.connected', { names: names.join(lang === 'en' ? ', ' : '、') }))
  const text = lines.join('\n')
  const service = shopHere
    ? 'shopify_admin'
    : connected.length === 1
      ? connected[0]?.connect_service
      : undefined
  const to =
    service === undefined ? '/connections' : `/connections?service=${encodeURIComponent(service)}`

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={to}
            data-testid="position-connected"
            data-hint={text}
            aria-label={text}
            className="inline-flex shrink-0 items-center justify-center rounded-full text-ws-good hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          >
            <CheckCircle2 className="size-4" aria-hidden />
          </Link>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-line">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
