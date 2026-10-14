/**
 * WP324（决策 690）：连接卡上**每一样**用哪种现成的接法——按 `service` 挑，不为哪一家写专属界面：
 *
 * | service | 接法（都是已有组件，原样复用） |
 * |---|---|
 * | 连接目录里的 provider（`ga4` / `gsc` / `meta_ads` / `google_ads` / …） | 授权页 / 本机原生表单（{@link useConnectFlow}） |
 * | `shopify_admin` | 连接页那一块「连接 Shopify」一键授权 |
 * | `site_theme` | 建站岗位页那一行（一键安装 CLI / 登录 Shopify / 选店） |
 * | `shop_admin` | 管店授权那一行 |
 * | `im:feishu` / `im:dingtalk` | 消息渠道页那张团队机器人卡 |
 * | `extension` | 浏览器插件配对码 |
 * | 认不出 / 要下载连接器 / 企业微信 / 微信 | 「去连接页 / 消息渠道」一个链接（那一页仍是总览） |
 *
 * 每一样还要说「现在连上了没有」（{@link useNeedConnected}）：`true` / `false`；查不了回 `undefined`。
 */
import type { ConnectNeed } from '@agentsws/contracts'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BrowserExtensionSection } from '@/components/connections/browser-extension'
import { SecureForm } from '@/components/connections/secure-form'
import { ShopifyConnect } from '@/components/connections/shopify-connect'
import { TestResultLine } from '@/components/connections/test-result'
import { TeamBotCard } from '@/components/im/team-bot-card'
import { ShopAdminBanner, shopAdminQuery } from '@/components/position/shop-admin-banner'
import { SiteThemeBanner } from '@/components/position/site-theme-banner'
import { Button } from '@/components/ui/button'
import { getImStatus, getSiteTheme, listExtensionTokens, type ProviderView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { useConnectFlow } from './use-connect-flow'

/** 卡上要用到的上下文（谁在连、这件事是哪条职责）。 */
export interface ConnectContext {
  /** 连接用的分配（所有者那条）；没有 = 这个人管不了连接。 */
  owner: string | undefined
  /** 这件事所在的职责与分配（建站 / 管店那一行要它）；第三栏单独开时可能没有。 */
  duty?: { role_id: string; assignment_id: string } | undefined
  providers: ProviderView[] | undefined
  isConnected(service: string): boolean
  refresh(): void
}

const SPECIAL = new Set(['site_theme', 'shop_admin', 'extension'])
const teamChannel = (service: string | undefined): 'feishu' | 'dingtalk' | undefined =>
  service === 'im:feishu' ? 'feishu' : service === 'im:dingtalk' ? 'dingtalk' : undefined

/** 这一样现在连上了没有（查不了回 `undefined`）。 */
export function useNeedConnected(need: ConnectNeed, ctx: ConnectContext): boolean | undefined {
  const service = need.service
  const duty = ctx.duty
  const theme = useQuery({
    queryKey: ['site-theme', duty?.assignment_id, 'setup-card'],
    enabled: service === 'site_theme' && duty !== undefined,
    queryFn: () => getSiteTheme(duty?.assignment_id ?? '', true),
    refetchInterval: 4000,
  })
  const shopQ = shopAdminQuery(duty === undefined ? [] : [duty])
  const shop = useQuery({
    queryKey: shopQ.queryKey,
    queryFn: shopQ.queryFn,
    enabled: service === 'shop_admin' && shopQ.enabled,
    refetchInterval: 4000,
  })
  const team = teamChannel(service)
  const im = useQuery({
    queryKey: ['im', 'status'],
    queryFn: getImStatus,
    enabled: team !== undefined,
    refetchInterval: 3000,
  })
  const ext = useQuery({
    queryKey: ['extension-tokens', ctx.owner, 'setup-card'],
    queryFn: () => listExtensionTokens(ctx.owner),
    enabled: service === 'extension' && ctx.owner !== undefined,
    refetchInterval: 3000,
  })
  if (service === undefined) return undefined
  if (service === 'site_theme')
    return theme.data === undefined
      ? undefined
      : theme.data.applicable && theme.data.next === undefined
  if (service === 'shop_admin')
    return shop.data === undefined ? undefined : shop.data.state === 'authorized'
  if (team !== undefined) {
    const v = im.data?.[team]
    return im.data === undefined ? undefined : v?.state === 'connected'
  }
  if (service === 'extension')
    return ext.data === undefined ? undefined : ext.data.tokens.length > 0
  if (ctx.providers?.some((p) => p.service === service) === true) return ctx.isConnected(service)
  return undefined
}

/** 一个 provider 的就地连接（卡里那一小块：一个按钮 / 一张原生表单 / 等授权）。 */
function ProviderConnect({
  provider,
  ctx,
}: {
  provider: ProviderView
  ctx: ConnectContext
}): ReactNode {
  const { t } = useApp()
  const flow = useConnectFlow(provider.service, ctx.owner, ctx.refresh)
  if (flow.phase === 'form' || flow.phase === 'saving')
    return (
      <SecureForm
        service={provider.service}
        fields={flow.fields ?? provider.fields}
        busy={flow.phase === 'saving'}
        {...(ctx.owner === undefined ? {} : { assignment: ctx.owner })}
        onCancel={flow.cancel}
        onSubmit={flow.submit}
      />
    )
  return (
    <div className="flex flex-col gap-1.5">
      {flow.phase === 'authorizing' ? (
        <p
          className="flex items-center gap-2 text-xs text-ws-muted-fg"
          data-testid="setup-oauth-waiting"
        >
          {t('connections.oauth.opened')}
          {flow.oauthUrl === undefined ? null : (
            <a
              href={flow.oauthUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-ws-brand"
            >
              {t('connections.oauth.manual')}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
          <Button size="xs" variant="ghost" onClick={flow.cancel}>
            {t('connections.cancel')}
          </Button>
        </p>
      ) : (
        <div>
          <Button
            size="sm"
            data-testid="setup-connect-start"
            data-service={provider.service}
            disabled={!provider.available}
            onClick={flow.start}
          >
            {provider.auth === 'oauth2' ? t('connections.authorize') : t('connections.connect')}
          </Button>
        </div>
      )}
      {flow.result === undefined ? null : <TestResultLine result={flow.result} />}
    </div>
  )
}

/** 去总览页的那一个链接（认不出 / 要先下载连接器 / 企业微信 / 微信扫码）。 */
function ElsewhereLink({ service }: { service: string | undefined }): ReactNode {
  const { t } = useApp()
  const im = service?.startsWith('im:') === true
  const to = im
    ? '/im-channels'
    : service === undefined
      ? '/connections'
      : `/connections?service=${encodeURIComponent(service)}`
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-xs text-ws-brand underline-offset-4 hover:underline"
      data-testid="setup-connect-elsewhere"
    >
      {t(im ? 'setup.connect.im_page' : 'setup.connect.page')}
    </Link>
  )
}

/** 一样「要连的」在卡上的那一块接法。 */
export function ConnectWidget({
  need,
  ctx,
}: {
  need: ConnectNeed
  ctx: ConnectContext
}): ReactNode {
  const { t } = useApp()
  const service = need.service
  if (ctx.owner === undefined && !SPECIAL.has(service ?? ''))
    return <p className="text-xs text-ws-muted-fg">{t('setup.connect.owner_only')}</p>
  if (service === 'site_theme' && ctx.duty !== undefined)
    return <SiteThemeBanner positionId={undefined} duties={[ctx.duty]} />
  if (service === 'shop_admin' && ctx.duty !== undefined)
    return <ShopAdminBanner duties={[ctx.duty]} />
  if (service === 'extension')
    return (
      <BrowserExtensionSection {...(ctx.owner === undefined ? {} : { assignment: ctx.owner })} />
    )
  const team = teamChannel(service)
  if (team !== undefined) return <TeamBotWidget channel={team} />
  if (service === 'shopify_admin')
    return (
      <ShopifyConnect
        {...(ctx.owner === undefined ? {} : { assignment: ctx.owner })}
        onChanged={ctx.refresh}
      />
    )
  const provider = ctx.providers?.find((p) => p.service === service)
  if (provider === undefined || provider.needs_download === true || provider.planned === true)
    return <ElsewhereLink service={service} />
  return <ProviderConnect provider={provider} ctx={ctx} />
}

function TeamBotWidget({ channel }: { channel: 'feishu' | 'dingtalk' }): ReactNode {
  const status = useQuery({ queryKey: ['im', 'status'], queryFn: getImStatus })
  const view = status.data?.[channel]
  const accountId =
    channel === 'feishu' ? status.data?.feishu?.app_id : status.data?.dingtalk?.client_id
  return (
    <TeamBotCard
      channel={channel}
      view={view}
      accountId={accountId}
      canManage={status.data?.can_manage === true}
    />
  )
}
