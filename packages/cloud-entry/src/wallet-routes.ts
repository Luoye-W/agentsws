/**
 * `/v1/wallet/*`：余额、用量、价目表、充值（49 §3 M4）。
 *
 * 四条路由的共同点：**它们只读账本，不读正文**。用量那条聚合的是计量事件
 * （八个字段），所以无论怎么分组、怎么筛，都不可能漏出一句 prompt 或一条订单。
 *
 * 权限：owner 那把令牌（scope 里有 `wallet:admin`）看整个组织；
 * 成员那把只看自己工作区那一份——同一条路由，按 scope 裁，不另开一条"成员版"。
 */
import type { UsageGroup } from '@agentsws/contracts'
import { TOPUP_TIERS_FILE, topupTierById } from '@agentsws/metering'
import type { Context } from 'hono'
import {
  createCheckoutSession,
  handleStripeWebhook,
  notImplementedProvider,
  topupOrderOf,
} from './stripe.js'
import type { EntryDeps, EntryEnv, EntryRoute } from './types.js'
import { EntryError } from './types.js'

/** 有它才看得到整个组织的用量；没有就只看自己那个工作区。 */
export const WALLET_ADMIN_SCOPE = 'wallet:admin'

const ok = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const groupOf = (raw: string | undefined): UsageGroup => {
  if (raw === undefined || raw === '') return 'capability'
  if (raw === 'capability' || raw === 'workspace' || raw === 'day') return raw
  throw new EntryError('invalid_input', 'group 只能是 capability / workspace / day')
}

/** 本月一号零点（用量那条的默认起点）。 */
export function monthStart(at: string): string {
  return `${at.slice(0, 7)}-01T00:00:00.000Z`
}

function nowOf(deps: EntryDeps): string {
  return deps.now?.() ?? new Date().toISOString()
}

export function walletRoutes(deps: EntryDeps): EntryRoute[] {
  const fetchLike =
    deps.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init))

  return [
    {
      method: 'get',
      path: '/v1/wallet',
      auth: 'bearer',
      scope: 'wallet:read',
      summary: '余额：永不过期的 / 有期限的 / 即将过期的 / 预扣中的',
      handler: async (c: Context<EntryEnv>) => ok(deps.wallet.balance(c.get('principal').org_id)),
    },
    {
      method: 'get',
      path: '/v1/wallet/usage',
      auth: 'bearer',
      scope: 'wallet:read',
      summary: '用量明细（按能力 / 按工作区 / 按天）。**只聚合计量事件**，聚合不出正文',
      handler: async (c: Context<EntryEnv>) => {
        const principal = c.get('principal')
        const at = nowOf(deps)
        const group = groupOf(c.req.query('group'))
        const admin = principal.scopes.includes(WALLET_ADMIN_SCOPE)
        return ok(
          deps.wallet.usage({
            org_id: principal.org_id,
            group,
            from: c.req.query('from') ?? monthStart(at),
            to: c.req.query('to') ?? at,
            // 不是 owner 的令牌只看自己那个工作区（同一条路由，按 scope 裁）
            ...(admin ? {} : { workspace_id: principal.workspace_id }),
          }),
        )
      },
    },
    {
      method: 'get',
      path: '/v1/wallet/pricing',
      auth: 'bearer',
      scope: 'wallet:read',
      summary: '价目表（能力 → 单位 → 积分）。对用户只显示最终积分价',
      handler: async () => ok(deps.pricing),
    },
    {
      method: 'get',
      path: '/v1/wallet/topup/tiers',
      auth: 'bearer',
      scope: 'wallet:read',
      summary: '充值四档（usd / credits）。价目数据化：改档位是出一个版本，不是改代码',
      handler: async () => ok(TOPUP_TIERS_FILE),
    },
    {
      method: 'post',
      path: '/v1/wallet/topup',
      auth: 'bearer',
      scope: 'wallet:topup',
      summary: '建一笔充值单（按四档之一；这一版只做 Stripe，微信 / 支付宝回一句人话）',
      handler: async (c: Context<EntryEnv>) => {
        const principal = c.get('principal')
        const raw = await c.req.text()
        let body: { provider?: unknown; credits?: unknown; tier_id?: unknown } = {}
        if (raw.trim() !== '') {
          try {
            body = JSON.parse(raw) as typeof body
          } catch {
            throw new EntryError('invalid_input', '请求体不是合法 JSON')
          }
        }
        const provider = typeof body.provider === 'string' ? body.provider : 'stripe'
        if (provider === 'wechat' || provider === 'alipay') notImplementedProvider(provider)
        if (provider !== 'stripe') {
          throw new EntryError('invalid_input', `不认识的支付渠道：${provider}`)
        }
        /*
         * WP118：**按档充**。档位 id 不给就只剩一条老路——任意金额，而那一条
         * 现在只有运营后台走得通（`wallet:admin`）。
         *
         * 为什么把任意金额收掉：它要用户在付款之前先做一道除法（"我要多少积分？
         * 那是多少钱？"），而四张卡他扫一眼就选完。留给 admin 是因为补偿、
         * 试用、人工充值这些场合本来就不该受档位限制。
         */
        const tierId = typeof body.tier_id === 'string' ? body.tier_id.trim() : ''
        let credits: number
        let usd: number | undefined
        let tier_id: string | undefined
        if (tierId !== '') {
          const tier = topupTierById(tierId)
          // 认不出就回一句人话，**绝不退到某个默认档**：猜错的后果是用户按
          // US$20 那张卡付了钱，到账却是别的数
          if (tier === undefined)
            throw new EntryError('invalid_input', `没有这一档充值：${tierId}`)
          credits = tier.credits
          usd = tier.usd
          tier_id = tier.id
        } else {
          if (!principal.scopes.includes(WALLET_ADMIN_SCOPE))
            throw new EntryError(
              'invalid_input',
              '请从四个充值档位里挑一个（tier_id）。任意金额充值已经收掉了。',
            )
          credits = Number(body.credits)
          if (!Number.isFinite(credits) || credits <= 0)
            throw new EntryError('invalid_input', 'credits 必须是大于 0 的数（1 积分 = ¥1）')
        }
        const session = await createCheckoutSession({
          config: deps.stripe ?? {},
          fetch: fetchLike,
          org_id: principal.org_id,
          credits,
          ...(usd === undefined ? {} : { usd }),
          ...(tier_id === undefined ? {} : { tier_id }),
        })
        return ok(
          topupOrderOf({
            id: session.session_id,
            org_id: principal.org_id,
            credits,
            url: session.url,
            at: nowOf(deps),
            ...(usd === undefined ? {} : { usd }),
            ...(tier_id === undefined ? {} : { tier_id }),
          }),
          201,
        )
      },
    },
    {
      /*
       * Stripe 自己打过来的那条。**不带我们的令牌**——它带的是签名，
       * 所以 `auth: 'public'`，但正文必须原样验签（parse 再 stringify 一趟签名就废了）。
       */
      method: 'post',
      path: '/v1/wallet/topup/stripe/webhook',
      auth: 'public',
      summary: 'Stripe webhook：付成功 → 入一笔永不过期的积分。同一个 session_id 只入一次',
      handler: async (c: Context<EntryEnv>) => {
        const payload = await c.req.text()
        const outcome = handleStripeWebhook({
          wallet: deps.wallet,
          payload,
          signature: c.req.header('Stripe-Signature'),
          config: deps.stripe ?? {},
          nowSeconds: Math.floor(Date.parse(nowOf(deps)) / 1000),
        })
        return ok(outcome)
      },
    },
  ]
}
