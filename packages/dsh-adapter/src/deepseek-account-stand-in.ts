/**
 * DeepSeek 账号登录的**替身**（WP134）：测试、demo、截图用，**一个字节都不出网**。
 *
 * 三样东西，各管一层：
 *
 * - {@link createFakeDeepSeekPlatform}：平台那一头的替身（`auth_init` / `auth_exchange` /
 *   `auth_cancel` / `users/current` / `get_user_summary` / `users/logout`）。它只是一个
 *   `fetch` 形状的函数——测试把它装到 `globalThis.fetch` 上，**官方模块原样跑**，
 *   我们验的就是官方那套状态机本身。
 * - {@link MemoryDeepSeekCredentials}：dsh `ctx.credentials` 的内存版（语义同官方
 *   `dsh-credentials-local`：记录经 JSON 往返、写完发 `credentials/record-updated`）。
 * - {@link createStandInDeepSeekAccountHost}：整个宿主的替身（**不挂官方模块**），给 demo 用：
 *   点"登录"拿到的授权地址就是本机回调本身，打开即登录成功，账号与余额是写死的替身数据。
 *
 * 这个文件不 import 任何官方账号模块的运行时代码（只有 `dsh-credentials` 的基类）。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  AccountDetails,
  AccountView,
  SignInAttemptId,
  SignInAttemptView,
} from '@deepseek-ai/dsh-deepseek-account'
import type { DeepSeekAccountHost } from './deepseek-account.js'

// ── dsh 凭据库的内存版 ────────────────────────────────────────────────

/**
 * 一个内存 `CredentialProvider`。`records` 是**类上的静态表**之外的一份实例表——
 * 测试要在挂树之前预先塞一条（issuer 不匹配那一组），所以用 {@link withRecords} 造一个
 * 带初始内容的子类。
 */
export class MemoryDeepSeekCredentials extends CredentialProvider {
  readonly records: Map<string, CredentialRecord>

  constructor(ctx: Context, initial?: Map<string, CredentialRecord>) {
    super(ctx)
    this.records = initial ?? new Map()
  }

  /** 造一个共享给定表的子类（表由调用方持有，挂树之后也能从外面看）。 */
  static withRecords(records: Map<string, CredentialRecord>): typeof MemoryDeepSeekCredentials {
    return class extends MemoryDeepSeekCredentials {
      constructor(ctx: Context) {
        super(ctx, records)
      }
    }
  }

  async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return undefined
  }
  async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: false, writable: false }
  }
  async set(): Promise<void> {
    throw new Error('memory credentials: references are read-only')
  }
  async unset(): Promise<void> {
    throw new Error('memory credentials: references are read-only')
  }
  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const hit = this.records.get(key)
    return hit === undefined ? undefined : (JSON.parse(JSON.stringify(hit)) as CredentialRecord)
  }
  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const hit = this.records.get(key)
    return {
      configured: hit !== undefined,
      writable: true,
      ...(hit === undefined ? {} : { kind: hit.kind }),
    }
  }
  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [...this.records.entries()].map(([key, value]) => ({
      key: key as CredentialKey,
      kind: value.kind,
    }))
  }
  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = await this.readRecord(key)
    const next = await mutate(current)
    if (next === undefined) return current
    this.records.set(key, JSON.parse(JSON.stringify(next)) as CredentialRecord)
    this.notifyRecordUpdated(key)
    return this.readRecord(key)
  }
  async deleteRecord(key: CredentialKey): Promise<void> {
    if (!this.records.delete(key)) return
    this.notifyRecordUpdated(key)
  }
}

// ── 平台那一头的替身 ─────────────────────────────────────────────────

/** 替身平台记下的一次请求。**body 原样留着**，守卫测试拿它查令牌有没有混进去。 */
export interface FakePlatformRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export interface FakeDeepSeekPlatformOptions {
  /** 平台源（必须 https；官方只在显式开 `allowLoopbackHttp` 时才收 http）。 */
  origin?: string
  /** 交换成功时发的令牌。测试用一个醒目的串，便于全文搜。 */
  token?: string
  /** `auth_init` 回的有效期（秒）。 */
  expiresIn?: number
  /** 余额查询回什么：`ok` 正常、`fail` 回 500。 */
  balance?: 'ok' | 'fail'
  /** `auth_exchange` 回的 `user`（缺省给一份替身账号）。 */
  user?: unknown
}

export interface FakeDeepSeekPlatform {
  readonly origin: string
  readonly token: string
  readonly requests: FakePlatformRequest[]
  /** 上一次 `auth_init` 里的 state / redirect_uri（模拟"浏览器回调"要用）。 */
  lastInit(): { state: string; redirect_uri: string; login_source: string } | undefined
  /** 改余额查询的回法（测试"查不到余额说人话"）。 */
  setBalance(mode: 'ok' | 'fail'): void
  /** 只处理平台源的请求；别的源回 `undefined`，调用方自己决定放行还是抛。 */
  handle(url: string, init?: RequestInit): Response | undefined
}

/** 替身账号（**不是真人**）：截图与测试里出现的就是它。 */
export const STAND_IN_DEEPSEEK_USER = {
  id: 'stand-in-user',
  email: 'de***@example.com',
  id_profile: { name: '替身账号', picture: null },
} as const

const ok = (bizData: unknown): Response =>
  new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: bizData } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/** 平台那一头：六个端点，状态全在内存里。 */
export function createFakeDeepSeekPlatform(
  options: FakeDeepSeekPlatformOptions = {},
): FakeDeepSeekPlatform {
  const origin = options.origin ?? 'https://platform.deepseek.stand-in'
  const token = options.token ?? `dsk_stand_in_${randomUUID().replace(/-/g, '')}`
  const requests: FakePlatformRequest[] = []
  let init: { state: string; redirect_uri: string; login_source: string } | undefined
  let balance = options.balance ?? 'ok'
  return {
    origin,
    token,
    requests,
    lastInit: () => init,
    setBalance(mode) {
      balance = mode
    },
    handle(url, requestInit) {
      const target = new URL(url)
      if (target.origin !== origin) return undefined
      const headers = Object.fromEntries(new Headers(requestInit?.headers).entries())
      const body = typeof requestInit?.body === 'string' ? requestInit.body : ''
      requests.push({ url, method: requestInit?.method ?? 'GET', headers, body })
      switch (target.pathname) {
        case '/auth-api/v0/dsh/auth_init': {
          const parsed = JSON.parse(body) as {
            state: string
            redirect_uri: string
            login_source: string
          }
          init = parsed
          return ok({
            authorize_url: `${origin}/dsh/authorize?authorize_id=az_1`,
            authorize_id: 'az_1',
            expires_in: options.expiresIn ?? 600,
          })
        }
        case '/auth-api/v0/dsh/auth_exchange':
          return ok({
            token,
            authorized_url: `${origin}/dsh/authorized`,
            user: options.user ?? STAND_IN_DEEPSEEK_USER,
          })
        case '/auth-api/v0/dsh/auth_cancel':
          return ok({})
        case '/auth-api/v0/users/current':
          return ok(options.user ?? STAND_IN_DEEPSEEK_USER)
        case '/api/v0/users/get_user_summary':
          if (balance === 'fail') return new Response('upstream down', { status: 500 })
          return ok({
            normal_wallets: [{ currency: 'CNY', balance: '42.50' }],
            bonus_wallets: [{ currency: 'CNY', balance: '10.00' }],
          })
        case '/auth-api/v0/users/logout':
          return ok({})
        default:
          return new Response('not found', { status: 404 })
      }
    },
  }
}

// ── 整个宿主的替身（demo 用，不挂官方模块）──────────────────────────────

export interface StandInDeepSeekAccountHostOptions {
  /** 余额查询是不是查不到（截图"说人话"那一张用）。 */
  balance?: 'ok' | 'fail'
}

/**
 * demo 里的「用我的 DeepSeek 账号登录」：授权地址就是本机的回调地址，打开即登录成功。
 * 回调页只回一句白话（替身，不是官方完成页）；令牌是一个不出这个进程的替身串。
 */
export function createStandInDeepSeekAccountHost(
  options: StandInDeepSeekAccountHostOptions = {},
): DeepSeekAccountHost & { setBalance(mode: 'ok' | 'fail'): void } {
  const token = `dsk_stand_in_${randomUUID().replace(/-/g, '')}`
  let signedIn = false
  let attempt: (SignInAttemptView & { state: string }) | null = null
  let balance = options.balance ?? 'ok'
  const listeners = new Set<() => void>()
  const links = {
    usageUrl: 'https://platform.deepseek.com/usage',
    topUpUrl: 'https://platform.deepseek.com/top_up',
  }
  const view = (): AccountView => ({
    status: signedIn ? 'credential-stored' : 'signed-out',
    links,
    attempt:
      attempt === null
        ? null
        : (({ state: _state, ...rest }) => rest)(attempt as SignInAttemptView & { state: string }),
  })
  const changed = (): void => {
    for (const l of listeners) l()
  }
  return {
    setBalance(mode) {
      balance = mode
    },
    state: async () => view(),
    profile: async () =>
      signedIn
        ? {
            status: 'ready',
            value: {
              id: null,
              name: STAND_IN_DEEPSEEK_USER.id_profile.name,
              contact: STAND_IN_DEEPSEEK_USER.email,
              avatarUrl: null,
            },
          }
        : null,
    balance: async (): Promise<AccountDetails['balance'] | null> => {
      if (!signedIn) return null
      if (balance === 'fail') return { status: 'failed' }
      return {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '42.50' }],
        bonusWallets: [{ currency: 'CNY', balance: '10.00' }],
      }
    },
    async startSignIn(input) {
      const state = randomUUID()
      attempt = {
        id: randomUUID() as SignInAttemptId,
        phase: 'waiting-browser',
        authorizeUrl: `${input.callbackOrigin}/oauth/callback?code=stand-in&state=${state}`,
        state,
      }
      changed()
      return view()
    },
    async cancelSignIn(id) {
      if (attempt?.id === id && attempt.phase === 'waiting-browser') {
        attempt = { id: attempt.id, phase: 'cancelled', state: attempt.state }
        changed()
      }
      return view()
    },
    async signOut() {
      signedIn = false
      attempt = null
      changed()
      return view()
    },
    async resolveToken(url) {
      return signedIn && new URL(url).origin === 'https://api.deepseek.com' ? token : undefined
    },
    async *watch(signal) {
      let dirty = true
      let wake: (() => void) | undefined
      const mark = (): void => {
        dirty = true
        wake?.()
      }
      listeners.add(mark)
      signal.addEventListener('abort', mark, { once: true })
      try {
        while (!signal.aborted) {
          if (dirty) {
            dirty = false
            yield view()
            continue
          }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      } finally {
        listeners.delete(mark)
      }
    },
    handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/oauth/callback') return false
      if (attempt?.phase !== 'waiting-browser' || url.searchParams.get('state') !== attempt.state) {
        res.writeHead(400, { 'cache-control': 'no-store' }).end()
        return true
      }
      signedIn = true
      attempt = { id: attempt.id, phase: 'succeeded', state: attempt.state }
      changed()
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .end(
          '<!doctype html><meta charset="utf-8"><title>已登录</title><p>（替身）DeepSeek 账号已登录，回到 Agents 工坊继续。</p>',
        )
      return true
    },
    async dispose() {
      listeners.clear()
    },
  }
}
