/**
 * WP140（docs/78 阻断 #6 最后一段）：demo 里「官方云那一跳」的替身。**一个字节都不出网。**
 *
 * 之前 demo 点「发登录信」会真的打 `https://cloud.agentsws.com`——合成世界去敲生产云，
 * 既不该（演示数据进了真账号系统）也不稳（没网就演不出来）。现在 demo 把
 * `AGENTSWS_CLOUD_BASE_URL` 换成 {@link CLOUD_STAND_IN_BASE_URL}（`.invalid` 保留域，
 * 永远解析不出来），再把 `ServerOptions.cloudFetch` 换成这里的 {@link cloudStandIn}：
 *
 * - 「发登录信」→ 回「信发出去了」；过一小会儿（默认 1.5 秒）替身**自己点一下信里的链接**
 *   （GET 本机回环口的 `/v1/cloud/account/callback`），于是 demo 里能看到「已关联」；
 * - 价目与充值四档：公开的 `/v1/pricing`（WP165：一份固定样例，`@agentsws/stand-ins` 的
 *   `SAMPLE_PRICING_CATALOG`；关联前后都看得到，和真云一样不要令牌）；
 * - 关联之后：积分余额、本月用量都有；
 * - 真收钱的那一跳（`POST /v1/wallet/topup`）不做：回一句人话，界面上是「建不了充值单」；
 * - 其余没列到的路径一律 404「演示里没有这一项」，不编数据。
 *
 * 生产路径从不调它（与 `deepseekAccountStandIn` 同一个口径）。
 */

import { randomBytes } from 'node:crypto'
import type {
  AllocationAuditEntry,
  AllocationBucket,
  AllocationNotice,
  AllocationReport,
  AllocationRow,
  AllocationSubjectKind,
  Clock,
  MyAllocation,
  UsageReport,
  WalletBalance,
} from '@agentsws/contracts'
import {
  ALLOCATION_BUCKETS,
  ALLOCATION_EXHAUSTED_MESSAGE,
  attributionIdOk,
  DEFAULT_ALLOCATION_TIMEZONE,
  MEMBER_HEADER,
  POSITION_HEADER,
  PRICING_CATALOG_PATH,
  pricingBlockOf,
} from '@agentsws/contracts'
import { SAMPLE_PRICING_CATALOG } from '@agentsws/stand-ins'

/** demo 用的云地址：`.invalid` 是保留顶级域（RFC 2606），任何请求漏出去都只会解析失败。 */
export const CLOUD_STAND_IN_BASE_URL = 'https://cloud.demo.invalid'

export interface CloudStandInOptions {
  /** 时间戳用哪个钟（demo 传合成时钟，与世界一致）；不给就是系统时钟。 */
  clock?: Clock
  /**
   * 「发登录信」之后多久替身替用户点链接（毫秒）。默认 1500；给负数就不自动点
   * （测试想自己控制那一步时用）。
   */
  autoLinkAfterMs?: number
  /** 替用户「点链接」的那一下。默认只对本机回环口发 GET，别的地址一律不点。 */
  click?: (url: string) => Promise<void>
}

/** 替身收到过的一次请求（测试用：断言走的是替身，而不是别处）。 */
export interface CloudStandInRequest {
  method: string
  url: string
}

export interface CloudStandInResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}

export type CloudStandInFetch = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<CloudStandInResponse>

/** WP194：demo 里种的一格本月用量（成员 × 岗位 × 能力）。 */
export interface CloudStandInUsageSeed {
  member_id?: string
  position_id?: string
  bucket: AllocationBucket
  credits: number
  calls: number
}

export interface CloudStandIn {
  fetch: CloudStandInFetch
  requests(): CloudStandInRequest[]
  /**
   * WP194：给 demo 种本月的用量与上限（替身不真扣钱，数字是合成的）。上限按 `null` 清。
   * 种完「积分」页就有人有岗位、「我的额度」就有数，能演示「额度到了」。
   */
  seedAllocation(input: {
    usage?: CloudStandInUsageSeed[]
    limits?: { kind: AllocationSubjectKind; subject_id: string; monthly_limit: number | null }[]
  }): void
  /** 等替身那一下「点链接」做完（测试用）。没有在途的就立刻回。 */
  settled(): Promise<void>
}

/** 只点本机回环口：替身绝不替用户去访问别的网址。 */
async function clickLoopback(url: string): Promise<void> {
  const host = new URL(url).hostname
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return
  const res = await globalThis.fetch(url)
  await res.text()
}

function respond(status: number, body: unknown): CloudStandInResponse {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  }
}

const ok = (data: unknown): CloudStandInResponse => respond(200, { data })
const fail = (status: number, code: string, message: string): CloudStandInResponse =>
  respond(status, { code, message })

/** 替身账号的样子（邮箱用信里填的那个；公司名是合成的）。 */
const STAND_IN_ORG = { id: 'org_demo', name: '演示公司' }

/** WP142：demo 里点充值的那一句（界面原样显示）。 */
export const DEMO_TOPUP_MESSAGE =
  '这是演示环境，不真收钱。正式版里点这一档会打开 Stripe 的付款页，付完积分当场到账。'
/** 替身余额：140 买的 + 10 注册赠送，本月用掉 12.4。 */
const PURCHASED = 140
const GRANTED = 10
const MONTH_USED = 12.4

export function cloudStandIn(options: CloudStandInOptions = {}): CloudStandIn {
  const now = (): string => options.clock?.now() ?? new Date().toISOString()
  const autoLinkAfterMs = options.autoLinkAfterMs ?? 1500
  const click = options.click ?? clickLoopback
  const seen: CloudStandInRequest[] = []
  const inFlight = new Set<Promise<void>>()
  /** 发出去还没点的登录信：一次性 token → 邮箱。 */
  const mailed = new Map<string, string>()
  /** 替身签过的会话 / 工作区令牌（只认自己签的）。 */
  const sessions = new Map<string, string>()
  const workspaceTokens = new Set<string>()
  const mint = (prefix: string): string => `${prefix}_${randomBytes(12).toString('hex')}`

  /* ── WP194：成员 / 岗位额度（替身版：内存里一张表，数字是合成的）── */
  const usageCells: CloudStandInUsageSeed[] = []
  const limits = new Map<string, { monthly_limit: number; updated_at: string }>()
  const audits: AllocationAuditEntry[] = []
  const limitKey = (kind: AllocationSubjectKind, id: string): string => `${kind}:${id}`
  const round = (n: number): number => Math.round(n * 10_000) / 10_000
  const rowOf = (kind: AllocationSubjectKind, id: string): AllocationRow => {
    const cells = usageCells.filter((c) => (kind === 'member' ? c.member_id : c.position_id) === id)
    const used = round(cells.reduce((sum, c) => sum + c.credits, 0))
    const limit = limits.get(limitKey(kind, id))
    return {
      kind,
      subject_id: id,
      used,
      reserved: 0,
      calls: cells.reduce((sum, c) => sum + c.calls, 0),
      ...(limit === undefined
        ? {}
        : {
            monthly_limit: limit.monthly_limit,
            percent:
              limit.monthly_limit <= 0 ? 100 : Math.floor((used / limit.monthly_limit) * 100),
            updated_at: limit.updated_at,
          }),
    }
  }
  const noticesOf = (): AllocationNotice[] => {
    const out: AllocationNotice[] = []
    for (const [key, limit] of limits) {
      const [kind, id] = key.split(/:(.*)/s) as [AllocationSubjectKind, string]
      const row = rowOf(kind, id)
      for (const level of [80, 100] as const)
        if ((row.percent ?? 0) >= level)
          out.push({ kind, subject_id: id, level, month: now().slice(0, 7), at: limit.updated_at })
    }
    return out
  }
  const subjects = (kind: AllocationSubjectKind): AllocationRow[] => {
    const ids = new Set<string>()
    for (const c of usageCells) {
      const id = kind === 'member' ? c.member_id : c.position_id
      if (id !== undefined) ids.add(id)
    }
    for (const key of limits.keys())
      if (key.startsWith(`${kind}:`)) ids.add(key.slice(kind.length + 1))
    return [...ids].map((id) => rowOf(kind, id)).sort((a, b) => b.used - a.used)
  }
  const report = (): AllocationReport => ({
    month: now().slice(0, 7),
    timezone: DEFAULT_ALLOCATION_TIMEZONE,
    from: monthStart(),
    to: now(),
    members: subjects('member'),
    positions: subjects('position'),
    buckets: ALLOCATION_BUCKETS.map((bucket) => {
      const cells = usageCells.filter((c) => c.bucket === bucket)
      return {
        bucket,
        credits: round(cells.reduce((sum, c) => sum + c.credits, 0)),
        calls: cells.reduce((sum, c) => sum + c.calls, 0),
      }
    }),
    cells: usageCells.map((c) => ({ ...c })),
    total_credits: round(usageCells.reduce((sum, c) => sum + c.credits, 0)),
    unattributed_credits: round(
      usageCells.filter((c) => c.member_id === undefined).reduce((sum, c) => sum + c.credits, 0),
    ),
    notices: noticesOf(),
  })
  const headerOf = (
    headers: Record<string, string> | undefined,
    name: string,
  ): string | undefined => {
    const raw = Object.entries(headers ?? {}).find(
      ([k]) => k.toLowerCase() === name.toLowerCase(),
    )?.[1]
    return attributionIdOk(raw) ? raw : undefined
  }
  const setLimit = (
    kind: AllocationSubjectKind,
    subject_id: string,
    monthly_limit: number | null,
    actor: string,
  ): AllocationAuditEntry => {
    const prev = limits.get(limitKey(kind, subject_id))
    if (monthly_limit === null) limits.delete(limitKey(kind, subject_id))
    else limits.set(limitKey(kind, subject_id), { monthly_limit, updated_at: now() })
    const entry: AllocationAuditEntry = {
      id: mint('alc'),
      at: now(),
      actor,
      action: monthly_limit === null ? 'clear' : 'set',
      kind,
      subject_id,
      ...(prev === undefined ? {} : { from: prev.monthly_limit }),
      ...(monthly_limit === null ? {} : { to: monthly_limit }),
    }
    audits.unshift(entry)
    return entry
  }

  const bearer = (headers: Record<string, string> | undefined): string | undefined => {
    const raw = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')
    const value = raw?.[1].replace(/^Bearer\s+/i, '').trim()
    return value === undefined || value === '' ? undefined : value
  }
  const days = (n: number): string => new Date(Date.parse(now()) + n * 86_400_000).toISOString()
  const monthStart = (): string => `${now().slice(0, 7)}-01T00:00:00.000Z`

  const issueLink = (): unknown => {
    const token = mint('cwt')
    workspaceTokens.add(token)
    return {
      link: { expires_at: days(90), scopes: ['ai', 'wallet:read'], cloud_org_id: STAND_IN_ORG.id },
      token,
    }
  }

  const balance = (): WalletBalance => ({
    org_id: STAND_IN_ORG.id,
    purchased: PURCHASED,
    granted: GRANTED,
    available: PURCHASED + GRANTED - MONTH_USED,
    reserved: 0,
    expiring: [{ credits: GRANTED, expires_at: days(30) }],
    low_balance_threshold: 20,
    low_balance: false,
    at: now(),
  })

  /** 本月用量：三块各挑一项能力（价目表里真有的），数字是合成的。 */
  const usage = (group: string): UsageReport => {
    const pricing = SAMPLE_PRICING_CATALOG.pricing
    const pick = (block: string): string | undefined =>
      pricing.entries.find((e) => pricingBlockOf(e) === block)?.capability
    const split: [string | undefined, number, number][] = [
      [pick('ai'), 8.2, 41],
      [pick('data'), 3.2, 16],
      [pick('service'), 1, 1],
    ]
    const rows =
      group === 'capability'
        ? split.flatMap(([key, credits, calls]) =>
            key === undefined ? [] : [{ key, credits, quantity: calls, calls }],
          )
        : [{ key: now().slice(0, 10), credits: MONTH_USED, quantity: 58, calls: 58 }]
    return {
      group: group === 'workspace' || group === 'day' ? group : 'capability',
      from: monthStart(),
      to: now(),
      rows,
      total_credits: MONTH_USED,
    }
  }

  /** 替用户点一下信里的链接（本机回调）。点不通就算了——界面上照样是「信发出去了」。 */
  const scheduleClick = (callback: string, token: string, state: string): void => {
    if (autoLinkAfterMs < 0) return
    const url = new URL(callback)
    url.searchParams.set('token', token)
    url.searchParams.set('state', state)
    const run = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        click(url.toString())
          .catch(() => undefined)
          .finally(() => {
            resolve()
          })
      }, autoLinkAfterMs)
      timer.unref?.()
    })
    inFlight.add(run)
    void run.finally(() => inFlight.delete(run))
  }

  const route = (
    method: string,
    url: URL,
    headers: Record<string, string> | undefined,
    body: Record<string, unknown>,
  ): CloudStandInResponse => {
    const path = url.pathname
    const token = bearer(headers)
    // ── WP165：公开价目（不要令牌；价目表 + 充值四档，固定样例）
    if (method === 'GET' && path === PRICING_CATALOG_PATH) return ok(SAMPLE_PRICING_CATALOG)
    // ── 账号那一跳（49 M1）
    if (method === 'POST' && path === '/v1/cloud/auth/magic-link') {
      const email = typeof body.email === 'string' ? body.email : ''
      const callback = typeof body.callback_url === 'string' ? body.callback_url : ''
      const state = typeof body.state === 'string' ? body.state : ''
      if (email === '' || callback === '' || state === '')
        return fail(400, 'invalid_input', '邮箱不对')
      const once = mint('mlt')
      mailed.set(once, email)
      scheduleClick(callback, once, state)
      return ok({
        expires_at: new Date(Date.parse(now()) + 15 * 60_000).toISOString(),
        delivered: 'email',
      })
    }
    if (method === 'POST' && path === '/v1/cloud/auth/verify') {
      const once = typeof body.token === 'string' ? body.token : ''
      const email = mailed.get(once)
      if (email === undefined) return fail(401, 'unauthenticated', '这条登录链接已经失效了')
      mailed.delete(once)
      const session = mint('cst')
      sessions.set(session, email)
      return ok({
        account: { id: 'acct_demo', email },
        org: STAND_IN_ORG,
        session_token: session,
      })
    }
    if (method === 'POST' && path === '/v1/cloud/auth/logout') {
      if (token !== undefined) sessions.delete(token)
      return ok({ logged_out: true })
    }
    if (method === 'POST' && path === '/v1/cloud/links') {
      if (token === undefined || !sessions.has(token))
        return fail(401, 'unauthenticated', '会话无效')
      return ok(issueLink())
    }
    if (method === 'POST' && path === '/v1/cloud/links/sibling') {
      if (token === undefined || !workspaceTokens.has(token))
        return fail(401, 'unauthenticated', '令牌无效')
      return ok(issueLink())
    }
    if (method === 'POST' && path === '/v1/cloud/links/current/revoke') {
      if (token === undefined || !workspaceTokens.delete(token))
        return fail(401, 'unauthenticated', '令牌无效')
      return ok({ revoked: true })
    }
    // ── 钱包那一面（49 M4）：只认替身签过的工作区令牌
    if (path.startsWith('/v1/wallet')) {
      if (token === undefined || !workspaceTokens.has(token))
        return fail(401, 'unauthenticated', '令牌无效')
      if (method === 'GET' && path === '/v1/wallet') return ok(balance())
      if (method === 'GET' && path === '/v1/wallet/usage')
        return ok(usage(url.searchParams.get('group') ?? 'capability'))
      if (method === 'GET' && path === '/v1/wallet/pricing')
        return ok(SAMPLE_PRICING_CATALOG.pricing)
      if (method === 'GET' && path === '/v1/wallet/topup/tiers')
        return ok(SAMPLE_PRICING_CATALOG.topup_tiers)
      if (method === 'POST' && path === '/v1/wallet/topup')
        // WP142：demo 里点充值那一句——说清这是演示、正式版里会发生什么
        return fail(503, 'provider_unavailable', DEMO_TOPUP_MESSAGE)
      // ── WP194：成员 / 岗位额度
      if (method === 'GET' && path === '/v1/wallet/allocation') return ok(report())
      if (method === 'GET' && path === '/v1/wallet/allocation/me') {
        const member = headerOf(headers, MEMBER_HEADER)
        const position = headerOf(headers, POSITION_HEADER)
        const row = member === undefined ? undefined : rowOf('member', member)
        const top = noticesOf()
          .filter((n) => n.kind === 'member' && n.subject_id === member)
          .reduce<80 | 100 | undefined>(
            (hi, n) => (hi === undefined || n.level > hi ? n.level : hi),
            undefined,
          )
        const mine: MyAllocation = {
          month: now().slice(0, 7),
          timezone: DEFAULT_ALLOCATION_TIMEZONE,
          ...(member === undefined ? {} : { member_id: member }),
          used: row?.used ?? 0,
          reserved: 0,
          ...(row?.monthly_limit === undefined ? {} : { monthly_limit: row.monthly_limit }),
          ...(row?.percent === undefined ? {} : { percent: row.percent }),
          ...(position === undefined ? {} : { position: rowOf('position', position) }),
          ...(top === undefined ? {} : { notice: top }),
        }
        return ok(mine)
      }
      if (method === 'GET' && path === '/v1/wallet/allocation/audit') return ok({ entries: audits })
      if (method === 'POST' && path === '/v1/wallet/allocation/limits') {
        const kind =
          body.kind === 'position' ? 'position' : body.kind === 'member' ? 'member' : undefined
        const subject = typeof body.subject_id === 'string' ? body.subject_id : ''
        const limit = body.monthly_limit
        if (kind === undefined || !attributionIdOk(subject))
          return fail(400, 'invalid_input', '要给 kind（member / position）与 subject_id')
        if (limit !== null && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0))
          return fail(400, 'invalid_input', 'monthly_limit 要么是不小于 0 的数，要么是 null')
        const actor = headerOf(headers, MEMBER_HEADER) ?? 'account:acct_demo'
        const audit = setLimit(kind, subject, limit, actor)
        return ok({ row: rowOf(kind, subject), audit })
      }
      if (method === 'POST' && path === '/v1/wallet/allocation/settings')
        return ok({
          timezone: typeof body.timezone === 'string' ? body.timezone : DEFAULT_ALLOCATION_TIMEZONE,
        })
      if (method === 'POST' && path === '/v1/wallet/allocation/members/remove') {
        const member = typeof body.member_id === 'string' ? body.member_id : ''
        const had = limits.delete(limitKey('member', member))
        return ok({ member_id: member, cleared: had ? 1 : 0 })
      }
    }
    // WP194：官方模型口在 demo 里不真跑；只演「额度到了」那一句（其余照旧说演示里没有）
    if (method === 'POST' && path === '/v1/ai/chat/completions') {
      if (token === undefined || !workspaceTokens.has(token))
        return fail(401, 'unauthenticated', '令牌无效')
      const member = headerOf(headers, MEMBER_HEADER)
      const row = member === undefined ? undefined : rowOf('member', member)
      if (row?.monthly_limit !== undefined && row.used >= row.monthly_limit)
        return respond(402, {
          code: 'insufficient_credits',
          message: ALLOCATION_EXHAUSTED_MESSAGE,
          details: { reason: 'member_limit', monthly_limit: row.monthly_limit, used: row.used },
        })
    }
    return fail(404, 'not_found', '演示里没有这一项（demo 不连真云）')
  }

  return {
    async fetch(input, init) {
      const method = (init?.method ?? 'GET').toUpperCase()
      seen.push({ method, url: input })
      const url = new URL(input)
      if (url.origin !== new URL(CLOUD_STAND_IN_BASE_URL).origin)
        return fail(404, 'not_found', '演示里没有这一项（demo 不连真云）')
      let body: Record<string, unknown> = {}
      if (init?.body !== undefined && init.body !== '') {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>
        } catch {
          return fail(400, 'invalid_input', '请求体不是 JSON')
        }
      }
      return route(method, url, init?.headers, body)
    },
    requests: () => [...seen],
    seedAllocation(input) {
      for (const cell of input.usage ?? []) usageCells.push({ ...cell })
      for (const l of input.limits ?? [])
        setLimit(l.kind, l.subject_id, l.monthly_limit, 'account:acct_demo')
    },
    async settled() {
      await Promise.all([...inFlight])
    },
  }
}
