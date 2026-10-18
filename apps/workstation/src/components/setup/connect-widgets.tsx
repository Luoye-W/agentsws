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
 * | `im:wecom` | 企业微信机器人那张本机原生表单（与消息渠道页同一个件；WP334） |
 * | `im:wechat` | 个人微信扫码（与消息渠道页同一个件；WP334） |
 * | `model` | 接模型（与开工向导第 ① 步同一个件：工坊接口 / DeepSeek 官方 / 自己的 key 走本机原生表单；WP334） |
 * | `deepseek_account` | DeepSeek 账号登录（与设置页同一个件；WP334） |
 * | `chatgpt_subscription` | ChatGPT 订阅登录（与设置页那张订阅卡同一个件；WP362） |
 * | `workshop_account` | 关联 Agents 工坊账号（与设置页同一个注册 / 登录表单；WP334） |
 * | `extension` | 浏览器插件：随工坊带的插件装一次（打开文件夹 / 扩展页 + 三步，WP345）+ 配对码；只缺配对时是少字版（WP360） |
 * | 认不出 / 要下载连接器 | 「去连接页 / 消息渠道」一个链接（那一页仍是总览） |
 *
 * 每一样还要说「现在连上了没有」（{@link useNeedConnected}）：`true` / `false`；查不了回 `undefined`。
 */

import type { ConnectNeed } from '@agentsws/contracts'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CloudAuthForm } from '@/components/cloud/cloud-auth-form'
import { BrowserExtensionSection } from '@/components/connections/browser-extension'
import { ExtensionInstallAndPair } from '@/components/connections/extension-onboard-card'
import { SecureForm } from '@/components/connections/secure-form'
import { ShopifyConnect } from '@/components/connections/shopify-connect'
import { TestResultLine } from '@/components/connections/test-result'
import { TeamBotCard } from '@/components/im/team-bot-card'
import { WechatBind } from '@/components/im/wechat-bind'
import { WecomBotForm } from '@/components/im/wecom-bot-form'
import { DeepSeekAccountLogin } from '@/components/models/deepseek-account-login'
import { SubscriptionPlan } from '@/components/models/subscription-plan'
import { AiStep } from '@/components/onboarding/ai-step'
import { ShopAdminBanner, shopAdminQuery } from '@/components/position/shop-admin-banner'
import { SiteThemeBanner } from '@/components/position/site-theme-banner'
import {
  GoogleAccountStep,
  PrWatchSources,
  useMonitorAssignment,
} from '@/components/pr/pr-watch-sources'
import { Button } from '@/components/ui/button'
import { SafetyNote } from '@/components/ui/hint'
import {
  getCloudAccount,
  getDeepSeekAccount,
  getImStatus,
  getModelSubscription,
  getSiteTheme,
  listExtensionTokens,
  listModelProviders,
  type ProviderView,
} from '@/lib/api'
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

const SPECIAL = new Set([
  'site_theme',
  'shop_admin',
  'extension',
  'im:wechat',
  'google_account',
  'google_alerts',
])
/** WP334：消息渠道四条（团队三条 + 个人微信）都问同一个状态。 */
const IM_SERVICES = new Set(['im:feishu', 'im:dingtalk', 'im:wecom', 'im:wechat'])
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
    enabled: IM_SERVICES.has(service ?? ''),
    refetchInterval: 3000,
  })
  // WP334：模型 / DeepSeek 账号 / 工坊账号（模型与账号是所有者的事：问不到就当查不了）
  const models = useQuery({
    queryKey: ['model-providers', ctx.owner],
    queryFn: () => listModelProviders(ctx.owner),
    enabled: service === 'model' && ctx.owner !== undefined,
    retry: false,
    refetchInterval: 3000,
  })
  const deepseek = useQuery({
    queryKey: ['deepseek-account', ctx.owner],
    queryFn: () => getDeepSeekAccount(ctx.owner),
    enabled: service === 'deepseek_account' && ctx.owner !== undefined,
    retry: false,
    refetchInterval: 3000,
  })
  const chatgpt = useQuery({
    queryKey: ['model-subscription', 'openai-codex', ctx.owner],
    queryFn: () => getModelSubscription('openai-codex', ctx.owner),
    enabled: service === 'chatgpt_subscription' && ctx.owner !== undefined,
    retry: false,
    refetchInterval: 3000,
  })
  const cloud = useQuery({
    queryKey: ['cloud-account', ctx.owner],
    queryFn: () => getCloudAccount(ctx.owner),
    enabled: service === 'workshop_account' && ctx.owner !== undefined,
    retry: false,
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
  if (service === 'im:wecom')
    return im.data === undefined ? undefined : im.data.wecom.configured && im.data.wecom.connected
  if (service === 'im:wechat') return im.data === undefined ? undefined : im.data.wechat.bound
  if (service === 'model')
    return models.data === undefined ? undefined : models.data.providers.some((p) => p.active)
  if (service === 'deepseek_account')
    return deepseek.data === undefined ? undefined : deepseek.data.signed_in
  /*
   * WP362：ChatGPT 订阅——没登录就是「没连上」；登着却说不准（过期的记录还在、被限流时也登着），
   * 回 `undefined`：卡不自己接着跑，人登好了点「接着做」。
   */
  if (service === 'chatgpt_subscription')
    return chatgpt.data === undefined || chatgpt.data.signed_in ? undefined : false
  if (service === 'workshop_account')
    return cloud.data === undefined ? undefined : cloud.data.linked
  if (service === 'extension')
    // WP345：撤掉的那把不算「配上了」（装好并配对之后卡才自己收起）
    return ext.data === undefined
      ? undefined
      : ext.data.tokens.some((t) => t.revoked_at === undefined)
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
  // WP360：只缺「配上插件」这一样 → 少字版（装 + 配对码）；要连广告后台那种（`ads_backend`）仍给完整那一节（同意与开关在里面）
  if (service === 'extension' && need.kind === 'extension')
    return <ExtensionInstallAndPair owner={ctx.owner} />
  if (service === 'extension')
    return (
      <BrowserExtensionSection {...(ctx.owner === undefined ? {} : { assignment: ctx.owner })} />
    )
  const team = teamChannel(service)
  if (team !== undefined) return <TeamBotWidget channel={team} />
  // WP334（决策 725）：企业微信表单 / 微信扫码就在卡里（与消息渠道页同一个件）
  if (service === 'im:wecom') return <WecomWidget />
  if (service === 'im:wechat') return <WechatWidget />
  // WP334（决策 726）：接模型 / DeepSeek 账号登录 / 关联工坊账号（与向导、设置页同一个件）
  if (service === 'model')
    return (
      <AiStep
        {...(ctx.owner === undefined ? {} : { assignment: ctx.owner })}
        onConnected={ctx.refresh}
      />
    )
  if (service === 'deepseek_account')
    return (
      <DeepSeekAccountLogin
        {...(ctx.owner === undefined ? {} : { assignment: ctx.owner })}
        onConnected={ctx.refresh}
      />
    )
  // WP362：ChatGPT 订阅过期 / 被限流——卡里就是设置页那块订阅登录（重登、换账号都在这里）
  if (service === 'chatgpt_subscription')
    return (
      <SubscriptionPlan
        provider="openai-codex"
        {...(ctx.owner === undefined ? {} : { assignment: ctx.owner })}
      />
    )
  if (service === 'workshop_account')
    return (
      <CloudAuthForm
        {...(ctx.owner === undefined ? {} : { assignment: ctx.owner })}
        testPrefix="setup-cloud"
        onDone={ctx.refresh}
      />
    )
  // WP386：信息监控——Google 账号这一步、多条 Google Alerts / 网站 RSS 就在卡里贴
  if (service === 'google_account') return <GoogleAccountStep />
  if (service === 'google_alerts') return <PrWatchInCard />
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

/** WP334：企业微信机器人表单（只有负责人 / 公司管理员能填；别人看到一句「由负责人来连」）。 */
function WecomWidget(): ReactNode {
  const { t } = useApp()
  const status = useQuery({ queryKey: ['im', 'status'], queryFn: getImStatus })
  if (status.data === undefined) return null
  const view = status.data.wecom
  if (view.configured && view.state === 'failed' && view.error !== undefined)
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-ws-bad">{view.error}</p>
        <WecomBotForm canManage={status.data.can_manage === true} />
      </div>
    )
  if (view.configured) return <p className="text-xs text-ws-muted-fg">{t('im.state.connecting')}</p>
  return status.data.can_manage === true ? (
    <WecomBotForm canManage />
  ) : (
    <p className="text-xs text-ws-muted-fg">{t('setup.connect.owner_only')}</p>
  )
}

/** WP334：个人微信扫码（跟人走：谁的卡谁扫）。条款风险那一句进问号。 */
function WechatWidget(): ReactNode {
  const { t } = useApp()
  const status = useQuery({ queryKey: ['im', 'status'], queryFn: getImStatus })
  return (
    <div className="flex flex-col gap-2">
      <SafetyNote text={t('im.wechat.terms.short')} hint={t('im.wechat.terms')} />
      <WechatBind wechat={status.data?.wechat} compact />
    </div>
  )
}

/** WP386：对话里的连接卡上那一版（少字：不出「现在拉一轮」）。 */
function PrWatchInCard(): ReactNode {
  return <PrWatchSources assignment={useMonitorAssignment()} compact />
}
