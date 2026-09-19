/**
 * WP119（68 / 48 §5）：**浏览器插件的配对与令牌**。
 *
 * 插件不是第四种「人」，它是一台设备上的一个只读采集口。所以它既不走
 * `identity.issue`（那些 token 能干的事太多），也不走云端（数据本来就该先落本机）。
 * 它走这里：一把只有三个动作的令牌，绑死一个扩展 id，在工作台上看得见、撤得掉。
 *
 * 四条纪律：
 *
 * 1. **配对码是 6 位数字、5 分钟、一次性**。短是因为用户要用眼睛读、用手打；
 *    5 分钟与一次性是因为短的东西必须短命。码只存哈希——工作台那一屏之后，
 *    这台机器上就没有任何地方还留着明文。
 * 2. **扩展 id 从 `Origin` 头里来，不从请求体里来**。请求体里的 id 是插件说的，
 *    `Origin` 是浏览器说的；一个能被伪造，另一个不能（浏览器不让页面自己改它）。
 *    于是「谁在配对」这件事不由被配对方自己回答。
 * 3. **令牌明文只在兑换那一次响应里出现**，库里只有 `sha256`。撤销是写
 *    `revoked_at` 而不是删行——用户要看得见「这把是什么时候撤的」。
 * 4. **scope 是白名单里的三个**（`kol.observe` / `kol.capture` / `kol.read`），
 *    没有第四个。插件拿不到别的东西，不是因为路由没写，是因为令牌上没有。
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { Clock, Iso8601, PersonId, WorkspaceId } from '@agentsws/contracts'

/** 插件令牌上允许出现的全部动作（只加不删；加一个要同时改工作台的说明文案）。 */
export const EXTENSION_SCOPES = ['kol.observe', 'kol.capture', 'kol.read'] as const

export type ExtensionScope = (typeof EXTENSION_SCOPES)[number]

/** 配对码有效期：5 分钟。 */
export const PAIRING_TTL_MS = 5 * 60 * 1000

/** 插件令牌有效期：30 天（与云端 `kol_plugin_tokens` 同一个数）。 */
export const EXTENSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** `chrome-extension://<id>` / `moz-extension://<uuid>` 之外的 Origin 一律不认。 */
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension):\/\/([a-zA-Z0-9-]{8,64})\/?$/

/** 一把令牌在工作台上的样子——**没有明文那一格**。 */
export interface ExtensionTokenView {
  id: string
  /** 用户能认出来的名字（默认「浏览器插件」）。 */
  label: string
  /** 绑死的扩展 id（Origin 的 host 部分）。 */
  extension_id: string
  scopes: ExtensionScope[]
  created_at: Iso8601
  expires_at: Iso8601
  /** 最近一次真的用它发过请求。没用过就没有这一格。 */
  last_used_at?: Iso8601
  revoked_at?: Iso8601
}

/** 认证成功后挂在请求上的东西（插件没有 person 之外的身份）。 */
export interface ExtensionSession {
  token_id: string
  workspace_id: WorkspaceId
  person_id: PersonId
  extension_id: string
  scopes: ExtensionScope[]
}

export interface PairingView {
  /** 6 位数字，只在这一次响应里出现。 */
  code: string
  expires_at: Iso8601
}

export interface RedeemedToken {
  /** 明文令牌，只在这一次响应里出现。 */
  token: string
  token_id: string
  workspace_id: WorkspaceId
  scopes: ExtensionScope[]
  expires_at: Iso8601
}

/** 兑换失败的原因——都给人话，不给码。 */
export type RedeemFailure = 'bad_origin' | 'bad_code' | 'expired' | 'used' | 'no_pairing'

export interface ExtensionStore {
  /** 工作台按一下「生成配对码」。同一个工作区再按一下，上一码立刻作废。 */
  createPairing(input: {
    workspace_id: WorkspaceId
    person_id: PersonId
    label?: string | undefined
  }): PairingView
  /** 插件把码送回来换令牌。`origin` 必须是扩展自己的 Origin 头。 */
  redeem(input: {
    code: string
    origin: string | undefined
  }): { ok: true; issued: RedeemedToken } | { ok: false; reason: RedeemFailure }
  list(workspace_id: WorkspaceId): ExtensionTokenView[]
  revoke(workspace_id: WorkspaceId, id: string): ExtensionTokenView | undefined
  /** 令牌 + Origin 双校验；通过就顺手记一次 `last_used_at`。 */
  authenticate(raw: string, origin: string | undefined): ExtensionSession | undefined
}

/** `chrome-extension://abc/` → `abc`；不是扩展 Origin 就 undefined。 */
export function extensionIdOfOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined
  const match = EXTENSION_ORIGIN.exec(origin.trim())
  return match?.[2]
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function fixedTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

interface PairingRow {
  code_hash: string
  workspace_id: WorkspaceId
  person_id: PersonId
  label: string
  expires_at_ms: number
  used: boolean
}

interface TokenRow {
  id: string
  token_hash: string
  label: string
  extension_id: string
  workspace_id: WorkspaceId
  person_id: PersonId
  scopes: ExtensionScope[]
  created_at: Iso8601
  expires_at: Iso8601
  last_used_at?: Iso8601
  revoked_at?: Iso8601
}

export interface MemoryExtensionStoreOptions {
  clock: Clock
  /** 注入的随机源（seed 化），不用裸 Math.random。 */
  random: () => number
  pairingTtlMs?: number
  tokenTtlMs?: number
}

/** 配对码：6 位数字，前导零保留（`000123` 也是一个码）。 */
function sixDigits(random: () => number): string {
  let out = ''
  for (let i = 0; i < 6; i += 1) out += String(Math.floor(random() * 10) % 10)
  return out
}

function hex(random: () => number, bytes: number): string {
  let out = ''
  for (let i = 0; i < bytes; i += 1) {
    out += Math.floor(random() * 256)
      .toString(16)
      .padStart(2, '0')
  }
  return out
}

const viewOf = (row: TokenRow): ExtensionTokenView => ({
  id: row.id,
  label: row.label,
  extension_id: row.extension_id,
  scopes: [...row.scopes],
  created_at: row.created_at,
  expires_at: row.expires_at,
  ...(row.last_used_at === undefined ? {} : { last_used_at: row.last_used_at }),
  ...(row.revoked_at === undefined ? {} : { revoked_at: row.revoked_at }),
})

/**
 * 本地档实现（内存）。
 *
 * 换 SQLite 只要换这一个类：路由层只认 {@link ExtensionStore} 这个口。
 * 内存档丢了令牌 = 用户重新配一次对，代价是 20 秒——所以这一版先不落盘。
 */
export class MemoryExtensionStore implements ExtensionStore {
  #pairings = new Map<WorkspaceId, PairingRow>()
  #tokens: TokenRow[] = []
  #seq = 0

  constructor(private readonly options: MemoryExtensionStoreOptions) {}

  #nowMs(): number {
    return Date.parse(this.options.clock.now())
  }

  createPairing(input: {
    workspace_id: WorkspaceId
    person_id: PersonId
    label?: string | undefined
  }): PairingView {
    const ttl = this.options.pairingTtlMs ?? PAIRING_TTL_MS
    const code = sixDigits(this.options.random)
    const expires_at_ms = this.#nowMs() + ttl
    // 一个工作区同时只有一个待用的码：再按一下「生成」，上一码当场作废。
    this.#pairings.set(input.workspace_id, {
      code_hash: sha256(code),
      workspace_id: input.workspace_id,
      person_id: input.person_id,
      label: input.label ?? '浏览器插件',
      expires_at_ms,
      used: false,
    })
    return { code, expires_at: new Date(expires_at_ms).toISOString() as Iso8601 }
  }

  redeem(input: {
    code: string
    origin: string | undefined
  }): { ok: true; issued: RedeemedToken } | { ok: false; reason: RedeemFailure } {
    const extension_id = extensionIdOfOrigin(input.origin)
    if (extension_id === undefined) return { ok: false, reason: 'bad_origin' }

    const code = input.code.trim()
    if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'bad_code' }
    const hash = sha256(code)

    const now = this.#nowMs()
    let hit: PairingRow | undefined
    for (const row of this.#pairings.values()) {
      if (fixedTimeEquals(row.code_hash, hash)) {
        hit = row
        break
      }
    }
    if (hit === undefined) return { ok: false, reason: 'no_pairing' }
    if (hit.used) return { ok: false, reason: 'used' }
    if (hit.expires_at_ms <= now) return { ok: false, reason: 'expired' }

    hit.used = true
    this.#seq += 1
    const id = `ext_${String(this.#seq).padStart(4, '0')}`
    const token = `ext_${hex(this.options.random, 24)}`
    const expires_at = new Date(
      now + (this.options.tokenTtlMs ?? EXTENSION_TOKEN_TTL_MS),
    ).toISOString() as Iso8601
    this.#tokens.push({
      id,
      token_hash: sha256(token),
      label: hit.label,
      extension_id,
      workspace_id: hit.workspace_id,
      person_id: hit.person_id,
      scopes: [...EXTENSION_SCOPES],
      created_at: this.options.clock.now(),
      expires_at,
    })
    return {
      ok: true,
      issued: {
        token,
        token_id: id,
        workspace_id: hit.workspace_id,
        scopes: [...EXTENSION_SCOPES],
        expires_at,
      },
    }
  }

  list(workspace_id: WorkspaceId): ExtensionTokenView[] {
    return this.#tokens.filter((r) => r.workspace_id === workspace_id).map(viewOf)
  }

  revoke(workspace_id: WorkspaceId, id: string): ExtensionTokenView | undefined {
    const row = this.#tokens.find((r) => r.workspace_id === workspace_id && r.id === id)
    if (row === undefined) return undefined
    if (row.revoked_at === undefined) row.revoked_at = this.options.clock.now()
    return viewOf(row)
  }

  authenticate(raw: string, origin: string | undefined): ExtensionSession | undefined {
    const token = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw.trim()
    if (token === '') return undefined
    const extension_id = extensionIdOfOrigin(origin)
    if (extension_id === undefined) return undefined
    const hash = sha256(token)
    const row = this.#tokens.find((r) => fixedTimeEquals(r.token_hash, hash))
    if (row === undefined) return undefined
    if (row.revoked_at !== undefined) return undefined
    // Origin 与令牌绑的那个扩展不是一个 = 这把令牌被搬到别的扩展里去了，不认。
    if (row.extension_id !== extension_id) return undefined
    if (Date.parse(row.expires_at) <= this.#nowMs()) return undefined
    row.last_used_at = this.options.clock.now()
    return {
      token_id: row.id,
      workspace_id: row.workspace_id,
      person_id: row.person_id,
      extension_id: row.extension_id,
      scopes: [...row.scopes],
    }
  }
}

export function createMemoryExtensionStore(
  options: MemoryExtensionStoreOptions,
): MemoryExtensionStore {
  return new MemoryExtensionStore(options)
}
