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
  AllocationRosterChange,
  AllocationRosterRequest,
  AllocationRow,
  AllocationSubjectKind,
  Clock,
  MemberUsageReport,
  MemberUsageRow,
  MyAllocation,
  PricingBlock,
  ServiceView,
  UsageReport,
  WalletBalance,
} from '@agentsws/contracts'
import {
  ALLOCATION_BUCKETS,
  ALLOCATION_EXHAUSTED_MESSAGE,
  allocationRosterGuarded,
  attributionIdOk,
  CLOUD_LINK_UPGRADE_PATH,
  DEFAULT_ALLOCATION_TIMEZONE,
  DEFAULT_CLOUD_SCOPES,
  emptyMemberUsageBlocks,
  LEGAL_TERMS_VERSION,
  MEMBER_HEADER,
  MEMBER_LEFT_MESSAGE,
  POSITION_HEADER,
  PRICING_CATALOG_PATH,
  pricingBlockOf,
} from '@agentsws/contracts'
import {
  DataServiceStandIn,
  SAMPLE_PRICING_CATALOG,
  ServiceOrdersStandIn,
  StandInDataError,
  StandInWallet,
} from '@agentsws/stand-ins'
import {
  type OfficialContentStandInOptions,
  officialContentStandIn,
} from './official-content-stand-in.js'
import { type PremiumThemeStandIn, premiumThemeStandIn } from './premium-theme-stand-in.js'
import {
  type ShopifyCloudStandIn,
  type ShopifyCloudStandInOptions,
  shopifyCloudStandIn,
} from './shopify-cloud-stand-in.js'

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
  /** WP265：Shopify 一键授权那几条的替身设置（默认 1.5 秒后像店主点了「安装」）。 */
  shopify?: ShopifyCloudStandInOptions
  /**
   * WP304：高级主题那三条（`/v1/themes/premium/*`）。默认开着（演得出「选高级主题 → 买 → 下载」）；
   * `false` = 像还没上线的云一样回 404（卡上「即将开放」）。`extra_credits` = 给合成余额多加一点（演买成）。
   */
  premiumTheme?: false | { extra_credits?: number }
  /**
   * WP418（自查 A6）：替身签的工作区令牌带哪几项动作集。不给 = 老样子（`ai` + `wallet:read`，演「老令牌要补签」）；
   * demo 给默认全集——否则选主题卡上高级主题永远是「登录后可买」，买卡演不出来。
   */
  linkScopes?: readonly string[]
  /**
   * WP390：工坊服务（`/v1/services*`）那几条。`scope_missing` = 演老令牌缺 `services` 动作集（403 +
   * `required_scope`，决策 1098）；`services` = 换一份目录（默认示意三项）。
   */
  /**
   * WP406（私有 docs/107）：云上「岗位更新」那几条（`/v1/content/*`）。截图脚本现打、现签一份包传进来；
   * 不给 = 像还没开通的云一样回 404。
   */
  officialContent?: OfficialContentStandInOptions
  services?: {
    scope_missing?: boolean
    catalog?: ServiceView[]
    autopilot?: boolean
    /** 演示多给的充值积分（截图要走完一整单建站时用；默认 0，余额与平时一样）。 */
    extra_credits?: number
  }
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
  /** WP304：回字节的那几条（高级主题下载是 zip 流）才有。 */
  arrayBuffer?(): Promise<ArrayBuffer>
  headers?: { get(name: string): string | null }
}

export type CloudStandInFetch = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    /** WP403：传订单附件时是文件的字节。 */
    body?: string | Uint8Array
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
  /**
   * WP194：demo 的官方模型替身在答之前问这一声——这个人（`X-Agentsws-Member`）本月额度到了就回
   * 402 + 「本月额度用完了，找管理员加。」（与真云同一个信封），没到回 `undefined`。
   */
  aiGate(headers: Record<string, string>): { status: number; body: unknown } | undefined
  seedAllocation(input: {
    usage?: CloudStandInUsageSeed[]
    limits?: { kind: AllocationSubjectKind; subject_id: string; monthly_limit: number | null }[]
  }): void
  /** WP206：本机推上来的最近一份名册（没推过是 `undefined`）。测试与 demo 看一眼用。 */
  roster(): AllocationRosterRequest | undefined
  /** 等替身那一下「点链接」做完（测试用）。没有在途的就立刻回。 */
  settled(): Promise<void>
  /** WP265：Shopify 一键授权那几条（测试推状态用）。 */
  shopify: ShopifyCloudStandIn
  /** WP304：高级主题那三条（没开就是 undefined）。 */
  premiumTheme?: PremiumThemeStandIn
  /**
   * WP390：工坊服务的云上替身（测试 / demo 直接调「服务方 / 运营」那一侧：报价、接单、交付、说话、判争议）。
   * `scopeMissing(true)` 演老令牌缺 `services`。
   */
  services: ServiceOrdersStandIn & { scopeMissing(on: boolean): void }
  /**
   * WP475：反馈那两条——测试 / 演示截图里扮「运营」那一侧（改状态、回一句）。替身自己从不回复。
   * `list()` 看收到了哪些（编号 + 一句话）。
   */
  feedback: {
    list(): { id: string; message: string }[]
    reply(id: string, text: string, status?: 'new' | 'in_progress' | 'fixed' | 'wont_fix'): boolean
  }
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

/** WP304：回字节 + 响应头（高级主题下载那条 zip 流）。 */
function respondBytes(
  status: number,
  bytes: Uint8Array,
  headers: Record<string, string>,
): CloudStandInResponse {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => Buffer.from(bytes).toString('latin1'),
    json: async () => {
      throw new Error('不是 JSON')
    },
    // WP406：`Buffer#slice` 是视图、`.buffer` 会带上整个内存池——拷一份正好这么长的
    arrayBuffer: async () => new Uint8Array(bytes).buffer as ArrayBuffer,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
  }
}

const ok = (data: unknown): CloudStandInResponse => respond(200, { data })
const fail = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): CloudStandInResponse =>
  respond(status, { code, message, ...(details === undefined ? {} : { details }) })

/**
 * WP231：demo 里「已经注册过」的那个邮箱（拿它点「注册」就看得到「这个邮箱注册过了」）。
 * 合成的地址，`example.com` 保留域。
 */
export const CLOUD_STAND_IN_REGISTERED_EMAIL = 'demo@example.com'
/** WP231：demo 里那个已注册邮箱的密码（演示「密码登录」用；合成的，不是谁的真密码）。 */
export const CLOUD_STAND_IN_PASSWORD = 'demo-pass-2026'
/**
 * WP231：demo 没有真邮箱，验证码**任意 6 位都过**；只有这一串故意算「不对」，
 * 好让人看到「验证码不对」长什么样。
 */
export const CLOUD_STAND_IN_WRONG_CODE = '000000'

/** 替身账号的样子（邮箱用信里填的那个；公司名是合成的）。 */
const STAND_IN_ORG = { id: 'org_demo', name: '演示公司' }

/** WP142：demo 里点充值的那一句（界面原样显示）。 */
export const DEMO_TOPUP_MESSAGE =
  '这是演示环境，不真收钱。正式版里点这一档会打开收款方的付款页，付完积分当场到账。'
/** 替身余额：140 买的 + 5 注册赠送，本月用掉 12.4。 */
const PURCHASED = 140
const GRANTED = 5
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
  /** WP267：补签过的令牌（再点一次 = `added: []`）。 */
  const upgradedTokens = new Set<string>()
  const mint = (prefix: string): string => `${prefix}_${randomBytes(12).toString('hex')}`
  const shopify = shopifyCloudStandIn({ now, ...options.shopify })
  /** WP475：收下的反馈（设备号:client_id → 回执）。 */
  const feedback = new Map<
    string,
    {
      submitted: { id: string; ticket: string; status: string; created_at: string }
      kind: string
      message: string
      replies: { at: string; text: string }[]
      updated_at: string
    }
  >()
  /** WP231：已注册的邮箱 → 密码（替身只在内存里，demo 一关就没了）。 */
  const registered = new Map<string, string>([
    [CLOUD_STAND_IN_REGISTERED_EMAIL, CLOUD_STAND_IN_PASSWORD],
  ])
  /** WP231：发过验证码、还没验的（邮箱 → 用途 + 注册时填的密码）。 */
  const codes = new Map<string, { purpose: 'signup' | 'login' | 'reset'; password?: string }>()
  const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '')
  const codeSent = (): CloudStandInResponse =>
    ok({
      expires_at: new Date(Date.parse(now()) + 5 * 60_000).toISOString(),
      delivered: 'email',
    })
  const sessionFor = (email: string, extra: Record<string, unknown> = {}): CloudStandInResponse => {
    const session = mint('cst')
    sessions.set(session, email)
    return ok({
      account: { id: 'acct_demo', email },
      org: STAND_IN_ORG,
      session_token: session,
      expires_at: new Date(Date.parse(now()) + 12 * 3600_000).toISOString(),
      ...extra,
    })
  }
  const badCode = (): CloudStandInResponse =>
    fail(401, 'unauthenticated', '验证码不对，再看一眼邮件。', { reason: 'invalid_code' })
  /** 验一次码：任意 6 位都过，只有 {@link CLOUD_STAND_IN_WRONG_CODE} 不过。 */
  const takeCode = (
    email: string,
    code: unknown,
    purpose: 'signup' | 'login' | 'reset',
  ): { password?: string } | undefined => {
    const row = codes.get(email)
    if (row === undefined || row.purpose !== purpose) return undefined
    if (typeof code !== 'string' || !/^\d{6}$/u.test(code) || code === CLOUD_STAND_IN_WRONG_CODE)
      return undefined
    codes.delete(email)
    return row.password === undefined ? {} : { password: row.password }
  }

  /* ── WP194：成员 / 岗位额度（替身版：内存里一张表，数字是合成的）── */
  const usageCells: CloudStandInUsageSeed[] = []
  let timezone = DEFAULT_ALLOCATION_TIMEZONE
  let notifyEmails: string[] = []
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
    timezone,
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
  /* ── WP206：名册（替身版：只记最近一份；名册里没了的成员 / 岗位停用）── */
  let roster: AllocationRosterRequest | undefined
  const gone = new Set<string>()
  const syncRoster = (incoming: AllocationRosterRequest, actor: string) => {
    let next = incoming
    const before = new Set<string>([
      ...(roster?.members ?? []).map((m) => limitKey('member', m.id)),
      ...(roster?.positions ?? []).map((p) => limitKey('position', p.id)),
    ])
    const after = new Set<string>([
      ...next.members.map((m) => limitKey('member', m.id)),
      ...next.positions.map((p) => limitKey('position', p.id)),
    ])
    // 与真云同一道保护：一下子没了一半以上（且至少 3 人）→ 这次谁都不收回，没了的照旧留着
    const beforeMembers = (roster?.members ?? []).map((m) => m.id)
    const missingMembers = beforeMembers.filter((id) => !after.has(limitKey('member', id)))
    const guarded = allocationRosterGuarded(missingMembers.length, beforeMembers.length)
    if (guarded) {
      const kept = (roster?.members ?? []).filter((m) => missingMembers.includes(m.id))
      next = { ...next, members: [...next.members, ...kept] }
      for (const m of kept) after.add(limitKey('member', m.id))
      for (const p of roster?.positions ?? [])
        if (!after.has(limitKey('position', p.id))) {
          next = { ...next, positions: [...next.positions, p] }
          after.add(limitKey('position', p.id))
        }
    }
    const reclaimed: AllocationRosterChange[] = []
    const returned: AllocationRosterChange[] = []
    const change = (key: string): AllocationRosterChange => {
      const [kind, id] = key.split(/:(.*)/s) as [AllocationSubjectKind, string]
      return { kind, subject_id: id }
    }
    const log = (c: AllocationRosterChange, action: 'auto_reclaim' | 'returned') => {
      audits.unshift({ id: mint('alc'), at: now(), actor, action, ...c })
    }
    for (const key of before)
      if (!after.has(key) && !gone.has(key)) {
        gone.add(key)
        reclaimed.push(change(key))
        log(change(key), 'auto_reclaim')
      }
    for (const key of after)
      if (gone.delete(key)) {
        returned.push(change(key))
        log(change(key), 'returned')
      }
    roster = {
      members: next.members.map((m) => ({ ...m, positions: [...(m.positions ?? [])] })),
      positions: next.positions.map((p) => ({ ...p })),
    }
    return {
      members: next.members.length,
      positions: next.positions.length,
      reclaimed,
      returned,
      synced_at: now(),
      ...(guarded ? { guarded: { missing: missingMembers.length, of: beforeMembers.length } } : {}),
    }
  }
  const aiGate = (
    headers: Record<string, string> | undefined,
  ): { status: number; body: unknown } | undefined => {
    const member = headerOf(headers, MEMBER_HEADER)
    if (member !== undefined && gone.has(limitKey('member', member)))
      return {
        status: 402,
        body: {
          code: 'insufficient_credits',
          message: MEMBER_LEFT_MESSAGE,
          details: { reason: 'member_left' },
        },
      }
    const row = member === undefined ? undefined : rowOf('member', member)
    if (row?.monthly_limit === undefined || row.used < row.monthly_limit) return undefined
    return {
      status: 402,
      body: {
        code: 'insufficient_credits',
        message: ALLOCATION_EXHAUSTED_MESSAGE,
        details: { reason: 'member_limit', monthly_limit: row.monthly_limit, used: row.used },
      },
    }
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
  /*
   * WP192：官方数据接口统一能力口（`/v1/data/capabilities`、`/v1/data/call/*`、`/v1/data/tasks*`）。
   * 数据是编的、价是示意价，扣的是替身自己的一小本账（与上面那个合成余额分开，不互相影响）。
   */
  let idSeq = 0
  const dataWallet = new StandInWallet({ now, newId: (p) => `${p}_${String(++idSeq)}` })
  dataWallet.topup({ org_id: STAND_IN_ORG.id, credits: PURCHASED, kind: 'purchased' })
  const dataService = new DataServiceStandIn({
    wallet: dataWallet,
    now,
    newId: (p) => `${p}_${String(++idSeq)}`,
  })
  const dataPrincipal = {
    account_id: 'acct_demo',
    org_id: STAND_IN_ORG.id,
    workspace_id: 'ws_demo',
    scopes: ['data'],
  }
  const days = (n: number): string => new Date(Date.parse(now()) + n * 86_400_000).toISOString()
  const monthStart = (): string => `${now().slice(0, 7)}-01T00:00:00.000Z`

  const issueLink = (): unknown => {
    const token = mint('cwt')
    workspaceTokens.add(token)
    return {
      link: {
        expires_at: days(90),
        scopes: [...(options.linkScopes ?? ['ai', 'wallet:read'])],
        cloud_org_id: STAND_IN_ORG.id,
      },
      token,
    }
  }

  /** WP194：种过额度用量就以它为准（本月已用、余额与「积分」页同一个数）。 */
  const monthUsed = (): number =>
    usageCells.length === 0 ? MONTH_USED : round(usageCells.reduce((sum, c) => sum + c.credits, 0))

  /** WP304：替身里买高级主题花掉的（从可用里扣）。 */
  let premiumSpent = 0
  /** WP390：工坊服务扣进托管、还没退回的（从可用里扣；退回就加回来）。 */
  let servicesSpent = 0
  const servicesExtra = Math.max(0, options.services?.extra_credits ?? 0)
  const premiumExtra =
    options.premiumTheme === false ? 0 : (options.premiumTheme?.extra_credits ?? 0)
  const balance = (): WalletBalance => ({
    org_id: STAND_IN_ORG.id,
    purchased: PURCHASED + premiumExtra + servicesExtra,
    granted: GRANTED,
    available: round(
      Math.max(
        0,
        PURCHASED +
          premiumExtra +
          servicesExtra +
          GRANTED -
          monthUsed() -
          premiumSpent -
          servicesSpent,
      ),
    ),
    reserved: 0,
    expiring: [{ credits: GRANTED, expires_at: days(30) }],
    low_balance_threshold: 20,
    low_balance: false,
    at: now(),
  })

  /** WP304：高级主题那三条（买的钱从上面那份合成余额里扣）。 */
  const premium: PremiumThemeStandIn | undefined =
    options.premiumTheme === false
      ? undefined
      : premiumThemeStandIn({
          available: () => balance().available,
          spend: (credits) => {
            premiumSpent = round(premiumSpent + credits)
          },
        })

  /** WP406：岗位更新（订阅、清单、签名、文件、摘要）。 */
  const official =
    options.officialContent === undefined
      ? undefined
      : officialContentStandIn(options.officialContent, now)

  /** WP390：工坊服务（示意目录；托管从上面那份合成余额里扣、退回加回）。 */
  let servicesScopeMissing = options.services?.scope_missing === true
  const services = new ServiceOrdersStandIn({
    now,
    newId: (p) => `${p}_${String(++idSeq)}`,
    available: () => balance().available,
    spend: (c) => {
      servicesSpent = round(servicesSpent + c)
    },
    refund: (c) => {
      servicesSpent = round(servicesSpent - c)
    },
    ...(options.services?.catalog === undefined ? {} : { services: options.services.catalog }),
    ...(options.services?.autopilot === true ? { autopilot: true } : {}),
  })
  /** 工坊服务那三行（托管 / 完成 / 退回）按能力名合计（用量明细「按能力」那一切）。 */
  const serviceUsageRows = () => {
    const by = new Map<string, { key: string; credits: number; quantity: number; calls: number }>()
    for (const r of services.ledger()) {
      const row = by.get(r.capability) ?? { key: r.capability, credits: 0, quantity: 0, calls: 0 }
      row.credits = round(row.credits + r.credits)
      row.quantity = round(row.quantity + r.quantity)
      row.calls += 1
      by.set(r.capability, row)
    }
    return [...by.values()]
  }

  /** 本月用量：三块各挑一项能力（价目表里真有的），数字是合成的。 */
  const usage = (group: string): UsageReport => {
    const pricing = SAMPLE_PRICING_CATALOG.pricing
    const pick = (block: string): string | undefined =>
      pricing.entries.find((e) => pricingBlockOf(e) === block)?.capability
    const seeded = (bucket: AllocationBucket): [number, number] => {
      const cells = usageCells.filter((c) => c.bucket === bucket)
      return [
        round(cells.reduce((sum, c) => sum + c.credits, 0)),
        cells.reduce((n, c) => n + c.calls, 0),
      ]
    }
    const split: [string | undefined, number, number][] =
      usageCells.length === 0
        ? [
            [pick('ai'), 8.2, 41],
            [pick('data'), 3.2, 16],
            [pick('service'), 1, 1],
          ]
        : ([
            [pick('ai'), ...seeded('ai')],
            [pick('data'), ...seeded('data')],
            [pick('service'), ...seeded('other')],
          ].filter((row) => (row[2] as number) > 0) as [string | undefined, number, number][])
    const rows =
      group === 'capability'
        ? [
            ...split.flatMap(([key, credits, calls]) =>
              key === undefined ? [] : [{ key, credits, quantity: calls, calls }],
            ),
            // WP390：工坊服务那一块（每单三行：托管 / 完成 / 退回）
            ...serviceUsageRows(),
          ]
        : [{ key: now().slice(0, 10), credits: monthUsed(), quantity: 58, calls: 58 }]
    return {
      group: group === 'workspace' || group === 'day' ? group : 'capability',
      from: monthStart(),
      to: now(),
      rows,
      total_credits: monthUsed(),
    }
  }

  /**
   * WP282：按人（`group=member`，WP279 那一份的替身）：种过的用量里带了「谁」的按人合计，三块按价目表分
   * （额度四格 → 三块：任务归数据、其它归增值服务，与上面 `usage` 同一个对照），没带的进「没标注」。
   * 名字取本机推上来的名册；只回有用量的人。合成数字都算「本月」：问别的月份就是空的。
   */
  const usageByMember = (q: { member?: string | undefined; month?: string | undefined }) => {
    const blockOfBucket = (bucket: AllocationBucket): PricingBlock =>
      bucket === 'ai' ? 'ai' : bucket === 'other' ? 'service' : 'data'
    const thisMonth = now().slice(0, 7)
    const cells = (q.month === undefined || q.month === thisMonth ? usageCells : []).filter(
      (c) => q.member === undefined || c.member_id === q.member,
    )
    const names = new Map((roster?.members ?? []).map((m) => [m.id, m.name] as const))
    const people = new Map<string, MemberUsageRow>()
    const rest: MemberUsageReport['unattributed'] = {
      credits: 0,
      quantity: 0,
      calls: 0,
      blocks: emptyMemberUsageBlocks(),
    }
    for (const c of cells) {
      let target: MemberUsageRow | MemberUsageReport['unattributed'] = rest
      if (c.member_id !== undefined) {
        const id = c.member_id
        const row = people.get(id) ?? {
          key: id,
          ...(names.has(id) ? { name: names.get(id) as string } : {}),
          credits: 0,
          quantity: 0,
          calls: 0,
          blocks: emptyMemberUsageBlocks(),
        }
        people.set(id, row)
        target = row
      }
      const block = target.blocks[blockOfBucket(c.bucket)]
      target.credits = round(target.credits + c.credits)
      target.quantity += c.calls
      target.calls += c.calls
      block.credits = round(block.credits + c.credits)
      block.calls += c.calls
    }
    // WP390：工坊服务那一块（替身不记是谁下的单，进「没标注」）
    if (q.month === undefined || q.month === thisMonth)
      for (const r of services.ledger()) {
        const block = rest.blocks.workshop_service
        rest.credits = round(rest.credits + r.credits)
        rest.calls += 1
        rest.quantity += 1
        block.credits = round(block.credits + r.credits)
        block.calls += 1
      }
    const rows = [...people.values()].sort((a, b) => b.credits - a.credits)
    const report: MemberUsageReport = {
      group: 'member',
      from:
        q.month === undefined || q.month === thisMonth
          ? monthStart()
          : `${q.month}-01T00:00:00.000Z`,
      to: now(),
      timezone,
      rows,
      unattributed: rest,
      total_credits: round(rows.reduce((sum, r) => sum + r.credits, 0) + rest.credits),
    }
    return report
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
    raw?: Uint8Array,
  ): CloudStandInResponse => {
    const path = url.pathname
    const token = bearer(headers)
    // ── WP165：公开价目（不要令牌；价目表 + 充值四档，固定样例）
    if (method === 'GET' && path === PRICING_CATALOG_PATH) return ok(SAMPLE_PRICING_CATALOG)
    // ── WP231：注册与登录（密码 + 邮箱验证码）
    if (method === 'GET' && path === '/v1/cloud/auth/config')
      return ok({
        password_min: 8,
        otp_length: 6,
        otp_ttl_seconds: 300,
        terms_version: LEGAL_TERMS_VERSION,
      })
    if (method === 'POST' && path === '/v1/cloud/auth/signup') {
      const email = lower(body.email)
      const password = typeof body.password === 'string' ? body.password : ''
      if (!email.includes('@') || password.length < 8)
        return fail(400, 'invalid_input', '邮箱或密码不对')
      if (registered.has(email))
        return fail(409, 'conflict', '这个邮箱注册过了，直接登录。', {
          reason: 'already_registered',
        })
      codes.set(email, { purpose: 'signup', password })
      return codeSent()
    }
    if (method === 'POST' && path === '/v1/cloud/auth/signup/verify') {
      const email = lower(body.email)
      const got = takeCode(email, body.code, 'signup')
      if (got === undefined) return badCode()
      registered.set(email, got.password ?? '')
      return sessionFor(email, {
        registered: true,
        bonus: { granted: true, credits: GRANTED },
      })
    }
    if (
      method === 'POST' &&
      (path === '/v1/cloud/auth/otp' || path === '/v1/cloud/auth/password/forgot')
    ) {
      const email = lower(body.email)
      if (!email.includes('@')) return fail(400, 'invalid_input', '邮箱不对')
      // 没注册的邮箱：静默成功、不发（与真云同一条）
      if (registered.has(email))
        codes.set(email, { purpose: path.endsWith('/otp') ? 'login' : 'reset' })
      return codeSent()
    }
    if (method === 'POST' && path === '/v1/cloud/auth/otp/verify') {
      const email = lower(body.email)
      if (takeCode(email, body.code, 'login') === undefined) return badCode()
      return sessionFor(email)
    }
    if (method === 'POST' && path === '/v1/cloud/auth/password') {
      const email = lower(body.email)
      const known = registered.get(email)
      if (known === undefined || known === '' || known !== body.password)
        return fail(401, 'unauthenticated', '邮箱或密码不对。没设过密码的话用验证码登录。', {
          reason: 'bad_credentials',
        })
      return sessionFor(email)
    }
    if (method === 'POST' && path === '/v1/cloud/auth/password/reset') {
      const email = lower(body.email)
      const next = typeof body.new_password === 'string' ? body.new_password : ''
      if (next.length < 8)
        return fail(400, 'invalid_input', '新密码至少 8 位', { reason: 'weak_password' })
      if (takeCode(email, body.code, 'reset') === undefined) return badCode()
      registered.set(email, next)
      return sessionFor(email)
    }
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
    // WP267：一点补签（私有云 WP266）——替身签的令牌是 `ai` + `wallet:read`，补上默认集里别的那几项（再点 = 已经齐了）
    if (method === 'POST' && path === CLOUD_LINK_UPGRADE_PATH) {
      if (token === undefined || !workspaceTokens.has(token))
        return fail(401, 'unauthenticated', '令牌无效')
      const added = upgradedTokens.has(token)
        ? []
        : DEFAULT_CLOUD_SCOPES.filter((x) => x !== 'ai' && x !== 'wallet:read')
      upgradedTokens.add(token)
      return ok({ scopes: [...DEFAULT_CLOUD_SCOPES], added })
    }
    // ── 钱包那一面（49 M4）：只认替身签过的工作区令牌
    if (path.startsWith('/v1/wallet')) {
      if (token === undefined || !workspaceTokens.has(token))
        return fail(401, 'unauthenticated', '令牌无效')
      if (method === 'GET' && path === '/v1/wallet') return ok(balance())
      if (method === 'GET' && path === '/v1/wallet/usage') {
        const q = url.searchParams
        const member = q.get('member') ?? undefined
        const month = q.get('month') ?? undefined
        if (member !== undefined && !attributionIdOk(member))
          return fail(400, 'invalid_input', 'member 要是本机的成员 id（字母数字与 _ - . : @）')
        if (month !== undefined && (q.has('from') || q.has('to')))
          return fail(400, 'invalid_input', 'month 与 from / to 只能给一样')
        if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
          return fail(400, 'invalid_input', 'month 要写成 YYYY-MM')
        const group = q.get('group') ?? 'capability'
        if (group === 'member') return ok(usageByMember({ member, month }))
        return ok(usage(group))
      }
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
      if (method === 'POST' && path === '/v1/wallet/allocation/settings') {
        if (typeof body.timezone === 'string') timezone = body.timezone
        if (Array.isArray(body.notify_emails))
          notifyEmails = body.notify_emails.filter((e): e is string => typeof e === 'string')
        return ok({ timezone, notify_recipients: notifyEmails.length })
      }
      if (method === 'POST' && path === '/v1/wallet/allocation/members/remove') {
        const member = typeof body.member_id === 'string' ? body.member_id : ''
        const had = limits.delete(limitKey('member', member))
        // WP206：从名册移除 + 停用（与真云同一条：之后带他的头的新预扣一律拒）
        if (attributionIdOk(member)) gone.add(limitKey('member', member))
        if (roster !== undefined)
          roster = { ...roster, members: roster.members.filter((m) => m.id !== member) }
        return ok({ member_id: member, cleared: had ? 1 : 0 })
      }
      if (method === 'POST' && path === '/v1/wallet/allocation/roster') {
        const members = Array.isArray(body.members) ? body.members : []
        const positions = Array.isArray(body.positions) ? body.positions : []
        const cleanMembers = members.flatMap((m) => {
          const r = m as { id?: unknown; name?: unknown; positions?: unknown }
          if (typeof r.id !== 'string' || !attributionIdOk(r.id)) return []
          const held = Array.isArray(r.positions)
            ? r.positions.filter((p): p is string => typeof p === 'string' && attributionIdOk(p))
            : []
          return [{ id: r.id, name: typeof r.name === 'string' ? r.name : r.id, positions: held }]
        })
        const cleanPositions = positions.flatMap((p) => {
          const r = p as { id?: unknown; name?: unknown }
          if (typeof r.id !== 'string' || !attributionIdOk(r.id)) return []
          return [{ id: r.id, name: typeof r.name === 'string' ? r.name : r.id }]
        })
        if (cleanMembers.length === 0) return fail(400, 'invalid_input', '名册里至少要有一个成员')
        const actor = headerOf(headers, MEMBER_HEADER) ?? 'account:acct_demo'
        return ok(syncRoster({ members: cleanMembers, positions: cleanPositions }, actor))
      }
    }
    // WP194：官方模型口在 demo 里不真跑；只演「额度到了」那一句（其余照旧说演示里没有）
    if (method === 'POST' && path === '/v1/ai/chat/completions') {
      if (token === undefined || !workspaceTokens.has(token))
        return fail(401, 'unauthenticated', '令牌无效')
      const blocked = aiGate(headers)
      if (blocked !== undefined) return respond(blocked.status, blocked.body)
    }
    // ── WP192：官方数据接口统一能力口（只认替身签过的工作区令牌）
    if (
      path === '/v1/data/capabilities' ||
      path.startsWith('/v1/data/call/') ||
      path === '/v1/data/tasks' ||
      path.startsWith('/v1/data/tasks/')
    ) {
      if (token === undefined || !workspaceTokens.has(token))
        return fail(401, 'unauthenticated', '令牌无效')
      try {
        if (method === 'GET' && path === '/v1/data/capabilities')
          return ok(dataService.capabilities())
        if (method === 'POST' && path.startsWith('/v1/data/call/'))
          return ok(
            dataService.call(
              dataPrincipal,
              decodeURIComponent(path.slice('/v1/data/call/'.length)),
              { input: body.input, ...(body.fresh === true ? { fresh: true } : {}) },
            ),
          )
        if (method === 'POST' && path === '/v1/data/tasks') {
          const out = dataService.submit(dataPrincipal, body)
          return respond(out.created ? 202 : 200, { data: out.task })
        }
        const m = /^\/v1\/data\/tasks\/([^/]+)(\/items|\/cancel)?$/u.exec(path)
        if (m !== null) {
          const id = decodeURIComponent(m[1] as string)
          if (method === 'GET' && m[2] === undefined) return ok(dataService.task(dataPrincipal, id))
          if (method === 'GET' && m[2] === '/items')
            return ok(
              dataService.items(dataPrincipal, id, url.searchParams.get('cursor') ?? undefined),
            )
          if (method === 'POST' && m[2] === '/cancel')
            return ok(dataService.cancel(dataPrincipal, id))
        }
      } catch (err) {
        if (err instanceof StandInDataError) return fail(err.status, err.code, err.message)
        throw err
      }
    }
    // ── WP304：高级主题（只认替身签过的工作区令牌；包是手写的占位主题）
    if (path.startsWith('/v1/themes/premium/') && premium !== undefined) {
      if (token === undefined || !workspaceTokens.has(token))
        return fail(401, 'unauthenticated', '令牌无效')
      const out = premium.handle(method, path, url.searchParams, body)
      if (out?.bytes !== undefined) return respondBytes(out.status, out.bytes, out.headers ?? {})
      if (out !== undefined) return respond(out.status, out.body)
    }
    // ── WP406：岗位更新（只认替身签过的工作区令牌）
    if (path.startsWith('/v1/content/') && official !== undefined) {
      if (token === undefined || !workspaceTokens.has(token))
        return fail(401, 'unauthenticated', '令牌无效')
      const out = official.handle(method, path, url.searchParams)
      if (out?.bytes !== undefined) return respondBytes(out.status, out.bytes, out.headers ?? {})
      if (out !== undefined) return respond(out.status, out.body)
    }
    // ── WP475：反馈（不要令牌；收下、给编号与 ticket。替身自己不回复——测试 / 演示经 `feedback.reply` 扮运营）
    if (method === 'POST' && path === '/v1/feedback') {
      const client = typeof body.client_id === 'string' ? body.client_id : ''
      const device = typeof body.device_id === 'string' ? body.device_id : ''
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      if (client === '' || device === '' || message === '')
        return fail(400, 'invalid_input', '反馈缺东西')
      const key = `${device}:${client}`
      const prev = feedback.get(key)
      if (prev !== undefined) return ok(prev.submitted)
      const submitted = {
        id: `fb_${randomBytes(6).toString('hex')}`,
        ticket: `fbt_${randomBytes(16).toString('hex')}`,
        status: 'new',
        created_at: now(),
      }
      feedback.set(key, {
        submitted,
        kind: typeof body.kind === 'string' ? body.kind : 'bug',
        message,
        replies: [],
        updated_at: submitted.created_at,
      })
      return ok(submitted)
    }
    if (method === 'POST' && path === '/v1/feedback/status') {
      const tickets = new Set(Array.isArray(body.tickets) ? body.tickets : [])
      const items = [...feedback.values()]
        .filter((f) => tickets.has(f.submitted.ticket))
        .map((f) => ({
          id: f.submitted.id,
          kind: f.kind,
          status: f.submitted.status,
          message: f.message,
          created_at: f.submitted.created_at,
          updated_at: f.updated_at,
          replies: f.replies,
        }))
      return ok({ items })
    }
    // ── WP265：Shopify 一键授权（只认替身签过的工作区令牌；授权页是 .invalid 假地址）
    if (path.startsWith('/v1/shopify/')) {
      if (token === undefined || !workspaceTokens.has(token))
        return fail(401, 'unauthenticated', '令牌无效')
      const out = shopify.handle(method, path, body)
      if (out !== undefined) return respond(out.status, out.body)
    }
    // ── WP390：工坊服务（只认替身签过的工作区令牌；示意目录、订单、托管）
    if (path === '/v1/services' || path.startsWith('/v1/services/')) {
      if (token === undefined || !workspaceTokens.has(token))
        return fail(401, 'unauthenticated', '令牌无效')
      if (servicesScopeMissing)
        return fail(403, 'forbidden', '令牌没有这条路由要的动作', { required_scope: 'services' })
      const type = Object.entries(headers ?? {}).find(
        ([k]) => k.toLowerCase() === 'content-type',
      )?.[1]
      const out = services.handle(
        method,
        path,
        url.searchParams,
        body,
        raw === undefined
          ? undefined
          : { bytes: raw, ...(type === undefined ? {} : { contentType: type }) },
      )
      if (out?.bytes !== undefined) return respondBytes(out.status, out.bytes, out.headers ?? {})
      if (out !== undefined) return respond(out.status, out.body)
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
      // WP403：订单附件的正文是文件本身（不是 JSON）
      if (init?.body instanceof Uint8Array) return route(method, url, init.headers, {}, init.body)
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
    aiGate: (headers) => aiGate(headers),
    roster: () => roster,
    seedAllocation(input) {
      for (const cell of input.usage ?? []) usageCells.push({ ...cell })
      for (const l of input.limits ?? [])
        setLimit(l.kind, l.subject_id, l.monthly_limit, 'account:acct_demo')
    },
    ...(premium === undefined ? {} : { premiumTheme: premium }),
    async settled() {
      await Promise.all([...inFlight])
    },
    shopify,
    services: Object.assign(services, {
      scopeMissing(on: boolean) {
        servicesScopeMissing = on
      },
    }),
    feedback: {
      list: () => [...feedback.values()].map((f) => ({ id: f.submitted.id, message: f.message })),
      reply(id, text, status) {
        const f = [...feedback.values()].find((x) => x.submitted.id === id)
        if (f === undefined) return false
        const at = now()
        if (text.trim() !== '') f.replies.push({ at, text: text.trim() })
        if (status !== undefined) f.submitted.status = status
        f.updated_at = at
        return true
      },
    },
  }
}
