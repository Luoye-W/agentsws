/**
 * Stripe Checkout（49 §3「支付：先 Stripe（境外）+ 微信 / 支付宝（境内，经聚合商）」）。
 *
 * 这个文件里**没有任何密钥**：`secret_key` 与 `webhook_secret` 都是取值回调，
 * 值只从环境变量来（`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`），
 * 取回来直接进头 / 进 HMAC，不落变量、不进日志、不进响应。
 *
 * 只做两件事：
 * 1. **创建一笔 Checkout Session** —— 回一个 URL，本地工作台新窗口打开它；
 * 2. **收 webhook** —— 验签名 → `checkout.session.completed` → 入一笔 `purchased` lot。
 *    幂等靠 `session_id`：Stripe 会重投，重投不该变成重复充值。
 *
 * 我们不碰卡号、不存支付凭据、不做退款——那些都在 Stripe 自己的界面里。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { TopupOrder } from '@agentsws/contracts'
import type { Wallet } from '@agentsws/metering'
import type { FetchLike, StripeConfig } from './types.js'
import { EntryError, secretOf } from './types.js'

export const STRIPE_API_BASE = 'https://api.stripe.com'

/** webhook 签名容忍的时间差（秒）。Stripe 自己的建议值。 */
export const WEBHOOK_TOLERANCE_SECONDS = 300

/**
 * 验 Stripe 的 `Stripe-Signature` 头。
 *
 * 头长这样：`t=1699999999,v1=<hex>,v1=<hex>`。签的是 `${t}.${原始 body}`，
 * HMAC-SHA256，密钥是 webhook secret。**必须用原始 body**——
 * `JSON.parse` 再 `stringify` 一趟，键序一变签名就对不上。
 */
export function verifyStripeSignature(args: {
  payload: string
  header: string | undefined
  secret: string
  nowSeconds: number
  toleranceSeconds?: number
}): void {
  if (args.header === undefined || args.header.trim() === '') {
    throw new EntryError('forbidden', 'webhook 缺 Stripe-Signature 头')
  }
  const parts = new Map<string, string[]>()
  for (const piece of args.header.split(',')) {
    const at = piece.indexOf('=')
    if (at <= 0) continue
    const key = piece.slice(0, at).trim()
    const value = piece.slice(at + 1).trim()
    parts.set(key, [...(parts.get(key) ?? []), value])
  }
  const timestamp = parts.get('t')?.[0]
  const signatures = parts.get('v1') ?? []
  if (timestamp === undefined || signatures.length === 0) {
    throw new EntryError('forbidden', 'webhook 签名格式不对')
  }
  const age = Math.abs(args.nowSeconds - Number(timestamp))
  if (!Number.isFinite(age) || age > (args.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) {
    throw new EntryError('forbidden', 'webhook 签名太旧了（重放保护）')
  }
  const expected = createHmac('sha256', args.secret)
    .update(`${timestamp}.${args.payload}`)
    .digest('hex')
  const expectedBuf = Buffer.from(expected, 'utf8')
  const matched = signatures.some((candidate) => {
    const buf = Buffer.from(candidate, 'utf8')
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf)
  })
  if (!matched) throw new EntryError('forbidden', 'webhook 签名对不上')
}

interface StripeSession {
  id?: string
  url?: string
  metadata?: { org_id?: string; credits?: string }
  amount_total?: number
  payment_status?: string
}

/**
 * 建一笔 Checkout Session。
 *
 * **按档收美元**（WP118 / 67 §2，Luoye 2026-09-19 定四档）：US$20 → 140 积分，
 * 1 美元 = 7 积分。`usd` 给了就按美元收，没给就退回老路（按人民币，1 积分 = ¥1）
 * ——那条老路现在只剩运营后台在用（用户界面上只有四张档位卡）。
 *
 * 为什么按美元定价而不是"积分数 × 当日汇率"：后者会让同一张卡上的价钱每天变
 * 一点，用户第二次充值时会以为我们偷偷涨价了。
 *
 * `metadata` 里只放组织号、积分数与档位——**没有账号、没有邮箱、没有工作区名字**：
 * 支付渠道那边不需要知道我们的用户是谁。
 */
export async function createCheckoutSession(args: {
  config: StripeConfig
  fetch: FetchLike
  org_id: string
  credits: number
  /** 按档充的那些：收多少美元。不给就按人民币收（1 积分 = ¥1）。 */
  usd?: number
  /** 按哪一档（`usd20` / `usd50` …）。只进 metadata，不参与算钱。 */
  tier_id?: string
}): Promise<{ session_id: string; url: string }> {
  const key = secretOf(args.config.secret_key)
  if (key === undefined) {
    throw new EntryError('not_implemented', '云侧还没配 Stripe（环境变量 STRIPE_SECRET_KEY）')
  }
  const byUsd = args.usd !== undefined && args.usd > 0
  const amountCents = Math.round((byUsd ? (args.usd as number) : args.credits) * 100)
  const form = new URLSearchParams()
  form.set('mode', 'payment')
  form.set('line_items[0][quantity]', '1')
  form.set('line_items[0][price_data][currency]', byUsd ? 'usd' : 'cny')
  form.set('line_items[0][price_data][unit_amount]', String(amountCents))
  form.set(
    'line_items[0][price_data][product_data][name]',
    `Agents 工坊积分 × ${String(args.credits)}`,
  )
  form.set('metadata[org_id]', args.org_id)
  form.set('metadata[credits]', String(args.credits))
  if (args.tier_id !== undefined) form.set('metadata[tier_id]', args.tier_id)
  if (byUsd) form.set('metadata[usd]', String(args.usd))
  const back = args.config.return_url
  if (back !== undefined) {
    form.set('success_url', `${back}?topup=ok`)
    form.set('cancel_url', `${back}?topup=cancelled`)
  }
  const res = await args.fetch(`${args.config.api_base ?? STRIPE_API_BASE}/v1/checkout/sessions`, {
    method: 'POST',
    headers: {
      // key 只在这一行出现，进头即忘
      Authorization: `Bearer ${key}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  })
  if (!res.ok) {
    throw new EntryError('provider_error', '支付渠道暂时建不了订单，稍后再试。', {
      details: { status: res.status },
    })
  }
  const session = (await res.json()) as StripeSession
  if (session.id === undefined || session.url === undefined) {
    throw new EntryError('provider_error', '支付渠道回的订单缺 id 或链接')
  }
  return { session_id: session.id, url: session.url }
}

export interface WebhookOutcome {
  /** 处理了没有（不是我们关心的事件类型就是 `ignored`）。 */
  handled: boolean
  /** 这一笔是不是之前已经入过账（幂等命中）。 */
  duplicate: boolean
  credits?: number
  org_id?: string
}

/**
 * 收一条 webhook。
 *
 * 只认 `checkout.session.completed` 且 `payment_status === 'paid'`。
 * 入账用 `session.id` 当 `source_ref`——{@link Wallet.topup} 靠它幂等。
 */
export function handleStripeWebhook(args: {
  wallet: Wallet
  payload: string
  signature: string | undefined
  config: StripeConfig
  nowSeconds: number
}): WebhookOutcome {
  const secret = secretOf(args.config.webhook_secret)
  if (secret === undefined) {
    throw new EntryError('not_implemented', '云侧还没配 Stripe webhook（STRIPE_WEBHOOK_SECRET）')
  }
  verifyStripeSignature({
    payload: args.payload,
    header: args.signature,
    secret,
    nowSeconds: args.nowSeconds,
  })
  let event: { type?: string; data?: { object?: StripeSession } }
  try {
    event = JSON.parse(args.payload) as typeof event
  } catch {
    throw new EntryError('invalid_input', 'webhook 正文不是合法 JSON')
  }
  if (event.type !== 'checkout.session.completed') return { handled: false, duplicate: false }
  const session = event.data?.object
  if (session?.payment_status !== 'paid') return { handled: false, duplicate: false }
  const org_id = session.metadata?.org_id
  const credits = Number(session.metadata?.credits)
  const session_id = session.id
  if (
    org_id === undefined ||
    session_id === undefined ||
    !Number.isFinite(credits) ||
    credits <= 0
  ) {
    throw new EntryError('invalid_input', 'webhook 里缺 org_id / credits / session id')
  }
  const before = args.wallet.balance(org_id).purchased
  args.wallet.topup({ org_id, credits, kind: 'purchased', source_ref: session_id })
  const after = args.wallet.balance(org_id).purchased
  return { handled: true, duplicate: after === before, credits, org_id }
}

/** 微信 / 支付宝这一版不做——回一句人话，不回 500。 */
export function notImplementedProvider(provider: string): never {
  const label = provider === 'wechat' ? '微信支付' : '支付宝'
  throw new EntryError(
    'not_implemented',
    `${label}还没接上（要过境内聚合商，正在办）。现在先用 Stripe 充，或者联系我们人工充值。`,
  )
}

/** 建单的结果（对外那份，**没有任何支付凭据**）。 */
export function topupOrderOf(args: {
  id: string
  org_id: string
  credits: number
  url: string
  at: string
  usd?: number
  tier_id?: string
}): TopupOrder {
  return {
    id: args.id,
    org_id: args.org_id,
    provider: 'stripe',
    credits: args.credits,
    // 1 积分 = ¥1
    amount_cny: args.credits,
    ...(args.usd === undefined ? {} : { amount_usd: args.usd }),
    ...(args.tier_id === undefined ? {} : { tier_id: args.tier_id }),
    checkout_url: args.url,
    status: 'created',
    created_at: args.at,
  }
}
