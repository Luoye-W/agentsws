/**
 * 云端 HTTP 面的**契约替身**（WP165，docs/83 §2 第 5 条）：账号与关联、公共红人库、公开价目。
 *
 * `apps/server` 的测试以前起一个内存版的真云进程（`apps/cloud` 的 `createCloudServer`）来测
 * 「本机那一半」。云端代码要搬去私有仓，开源这一侧改打这一份：路径、请求体、`{ data }` /
 * `{ code, message, details }` 信封、状态码都照契约（`@agentsws/contracts` 与 OpenAPI），
 * 云上那几条规矩（一次性链接只能用一次、令牌库里只存哈希、撤销是一列不是删行、少了 `data`
 * 动作集回 403 + `required_scope`）替身也守，因为本机那一半的行为靠它们。
 *
 * 真云那一半的行为测试（限流、白名单、会话过期、审计……）留在云端那一侧。
 */
import { createHash, randomBytes } from 'node:crypto'
import type {
  CloudScope,
  KolChannel,
  PublicContentObservation,
  PublicCreatorObservation,
} from '@agentsws/contracts'
import {
  DEFAULT_CLOUD_SCOPES,
  DEFAULT_WORKSPACE_TOKEN_TTL_MS,
  KOL_PUBLIC_SCOPE,
  PRICING_CATALOG_PATH,
  type PricingCatalog,
  WORKSPACE_TOKEN_PREFIX,
} from '@agentsws/contracts'
import { type KolPublicStandIn, StandInKolError, type StandInKolPrincipal } from './kol-public.js'
import { SAMPLE_PRICING_CATALOG } from './pricing-sample.js'

/** 替身回的响应：本机各处 fetch 注入点要的那一小面（`text()` / `json()`）都有。 */
export interface StandInHttpResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}

export type StandInHttpFetch = (
  input: string,
  init?: { method?: string; headers?: unknown; body?: unknown; signal?: unknown },
) => Promise<StandInHttpResponse>

const respond = (status: number, payload: unknown): StandInHttpResponse => {
  const text = JSON.stringify(payload)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  }
}
const ok = (data: unknown, status = 200): StandInHttpResponse => respond(status, { data })
const fail = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): StandInHttpResponse =>
  respond(status, { code, message, ...(details === undefined ? {} : { details }) })

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const mint = (prefix: string): string => `${prefix}${randomBytes(18).toString('base64url')}`

/** 一封「信」：只有收件人与正文（正文里那条链接就是用户要点的）。 */
export interface StandInMail {
  to: string
  text: string
}

/** 一条工作区关联（与云上那张表同形；**没有令牌明文**，只有哈希）。 */
export interface StandInLink {
  id: string
  workspace_id: string
  cloud_org_id: string
  created_by: string
  scopes: CloudScope[]
  token_sha256: string
  created_at: string
  expires_at: string
  revoked_at?: string
}

/**
 * 账号与关联（49 M1）：发信 → 点链接（一次性） → 会话 → 按工作区签令牌 / 补签 / 自撤。
 */
export class CloudAccountsStandIn {
  readonly mails: StandInMail[] = []
  private readonly onceTokens = new Map<string, { email: string; used: boolean }>()
  private readonly sessions = new Map<string, string>()
  private readonly accounts = new Map<string, { account_id: string; org_id: string }>()
  private readonly linkRows = new Map<string, StandInLink>()
  private seq = 0
  private readonly now: () => string

  constructor(options: { now: () => string }) {
    this.now = options.now
  }

  /** 这个邮箱的账号与组织（第一次见就隐式建一个，组织名 = 邮箱）。 */
  ensureAccount(email: string): { account_id: string; org_id: string } {
    const key = email.trim().toLowerCase()
    const found = this.accounts.get(key)
    if (found !== undefined) return found
    this.seq += 1
    const made = { account_id: `acc_${String(this.seq)}`, org_id: `org_${String(this.seq)}` }
    this.accounts.set(key, made)
    return made
  }

  /** 直接签一把（测试里造「少了某个动作集」的令牌用）。回明文——只此一次。 */
  issue(input: {
    workspace_id: string
    cloud_org_id: string
    created_by: string
    scopes?: readonly CloudScope[]
  }): { link: StandInLink; token: string } {
    const active = this.activeLinkOfWorkspace(input.workspace_id)
    if (active !== undefined && active.cloud_org_id !== input.cloud_org_id)
      throw new Error(`workspace_already_linked:${input.workspace_id}`)
    this.seq += 1
    const token = mint(WORKSPACE_TOKEN_PREFIX)
    const at = this.now()
    const link: StandInLink = {
      id: `lnk_${String(this.seq)}`,
      workspace_id: input.workspace_id,
      cloud_org_id: input.cloud_org_id,
      created_by: input.created_by,
      scopes: [...(input.scopes ?? DEFAULT_CLOUD_SCOPES)],
      token_sha256: sha256(token),
      created_at: at,
      expires_at: new Date(Date.parse(at) + DEFAULT_WORKSPACE_TOKEN_TTL_MS).toISOString(),
    }
    this.linkRows.set(link.id, link)
    return { link: { ...link }, token }
  }

  activeLinkOfWorkspace(workspace_id: string): StandInLink | undefined {
    const at = this.now()
    for (const l of this.linkRows.values())
      if (l.workspace_id === workspace_id && l.revoked_at === undefined && l.expires_at > at)
        return { ...l }
    return undefined
  }

  link(id: string): StandInLink | undefined {
    const found = this.linkRows.get(id)
    return found === undefined ? undefined : { ...found }
  }

  /** 库里存的只有哈希——测试拿它钉「明文不落库」。 */
  linkHashes(): string[] {
    return [...this.linkRows.values()].map((l) => l.token_sha256)
  }

  /** 验一把工作区令牌：回主体；撤了 / 过期 / 不认识都回 `undefined`（撤销立刻生效）。 */
  verify(token: string | undefined): (StandInKolPrincipal & { link_id: string }) | undefined {
    if (token === undefined || !token.startsWith(WORKSPACE_TOKEN_PREFIX)) return undefined
    const hash = sha256(token)
    const at = this.now()
    for (const l of this.linkRows.values())
      if (l.token_sha256 === hash && l.revoked_at === undefined && l.expires_at > at)
        return {
          account_id: l.created_by,
          org_id: l.cloud_org_id,
          workspace_id: l.workspace_id,
          scopes: [...l.scopes],
          region: 'global',
          link_id: l.id,
        }
    return undefined
  }

  private linkView(l: StandInLink): Record<string, unknown> {
    return {
      id: l.id,
      workspace_id: l.workspace_id,
      cloud_org_id: l.cloud_org_id,
      scopes: [...l.scopes],
      created_at: l.created_at,
      expires_at: l.expires_at,
      ...(l.revoked_at === undefined ? {} : { revoked_at: l.revoked_at }),
      active: l.revoked_at === undefined && l.expires_at > this.now(),
    }
  }

  /** 路由：认得就回响应，不认得回 `undefined`（交给别的替身）。 */
  handle(
    method: string,
    path: string,
    token: string | undefined,
    body: Record<string, unknown>,
  ): StandInHttpResponse | undefined {
    if (method === 'POST' && path === '/v1/cloud/auth/magic-link') {
      const email = typeof body.email === 'string' ? body.email : ''
      const callback = typeof body.callback_url === 'string' ? body.callback_url : ''
      const state = typeof body.state === 'string' ? body.state : ''
      if (email === '' || callback === '' || state === '')
        return fail(400, 'invalid_input', '邮箱、回调地址、state 都要有')
      const once = mint('mlt_')
      this.onceTokens.set(once, { email, used: false })
      const url = new URL(callback)
      url.searchParams.set('token', once)
      url.searchParams.set('state', state)
      this.mails.push({ to: email, text: `点这里登录：${url.toString()}` })
      return ok({
        expires_at: new Date(Date.parse(this.now()) + 15 * 60_000).toISOString(),
        delivered: 'email',
      })
    }
    if (method === 'POST' && path === '/v1/cloud/auth/verify') {
      const once = typeof body.token === 'string' ? body.token : ''
      const row = this.onceTokens.get(once)
      // 一次性：用过的与不认识的同一句话
      if (row === undefined || row.used)
        return fail(401, 'unauthenticated', '这条登录链接已经失效了')
      row.used = true
      const { account_id, org_id } = this.ensureAccount(row.email)
      const session = mint('cst_')
      this.sessions.set(session, row.email)
      return ok({
        account: { id: account_id, email: row.email },
        org: { id: org_id, name: row.email },
        session_token: session,
      })
    }
    if (method === 'POST' && path === '/v1/cloud/auth/logout') {
      if (token !== undefined) this.sessions.delete(token)
      return ok({ logged_out: true })
    }
    if (method === 'POST' && path === '/v1/cloud/links') {
      const email = token === undefined ? undefined : this.sessions.get(token)
      if (email === undefined) return fail(401, 'unauthenticated', '会话无效')
      const who = this.ensureAccount(email)
      const workspace_id = typeof body.workspace_id === 'string' ? body.workspace_id : ''
      if (workspace_id === '') return fail(400, 'invalid_input', '缺 workspace_id')
      try {
        const issued = this.issue({
          workspace_id,
          cloud_org_id: who.org_id,
          created_by: who.account_id,
        })
        return ok({ link: this.linkView(issued.link), token: issued.token }, 201)
      } catch {
        return fail(409, 'conflict', '这个工作区已经关联到另一个账号了，先在那边解除')
      }
    }
    if (method === 'POST' && path === '/v1/cloud/links/sibling') {
      const mine = this.verify(token)
      if (mine === undefined) return fail(401, 'unauthenticated', '令牌无效')
      const workspace_id = typeof body.workspace_id === 'string' ? body.workspace_id : ''
      if (workspace_id === mine.workspace_id)
        return fail(409, 'conflict', '这就是调用者自己那个工作区，它已经有一把了')
      try {
        // 组织与动作集从调用者那条关联上取，请求体说了不算
        const issued = this.issue({
          workspace_id,
          cloud_org_id: mine.org_id,
          created_by: mine.account_id,
          scopes: mine.scopes as CloudScope[],
        })
        return ok({ link: this.linkView(issued.link), token: issued.token }, 201)
      } catch {
        return fail(409, 'conflict', '这个工作区已经关联到另一个账号了，先在那边解除')
      }
    }
    if (method === 'POST' && path === '/v1/cloud/links/current/revoke') {
      const mine = this.verify(token)
      if (mine === undefined) return fail(401, 'unauthenticated', '令牌无效')
      const row = this.linkRows.get(mine.link_id)
      // 撤销是一列不是删行
      if (row !== undefined) row.revoked_at = this.now()
      return ok({ revoked: true })
    }
    return undefined
  }
}

/** 公共红人库的 HTTP 面（`/v1/data/kol/*`，只做本机那一半会打的几条）。 */
export function kolPublicHttp(
  service: KolPublicStandIn,
  principalOf: (token: string | undefined) => StandInKolPrincipal | undefined,
): (
  method: string,
  url: URL,
  token: string | undefined,
  body: Record<string, unknown>,
) => StandInHttpResponse | undefined {
  const prefix = '/v1/data/kol'
  return (method, url, token, body) => {
    const path = url.pathname
    if (!path.startsWith(`${prefix}/`)) return undefined
    const principal = principalOf(token)
    if (principal === undefined) return fail(401, 'unauthenticated', '令牌无效')
    if (!principal.scopes.includes(KOL_PUBLIC_SCOPE))
      return fail(403, 'forbidden', '这把令牌没有「数据服务」这一项权限。', {
        required_scope: KOL_PUBLIC_SCOPE,
      })
    const rest = path.slice(prefix.length)
    try {
      if (method === 'GET' && rest === '/creators') {
        const channel = url.searchParams.get('channel')
        const q = url.searchParams.get('q')
        const limit = url.searchParams.get('limit')
        return ok(
          service.browse(principal, {
            ...(channel === null || channel === '' ? {} : { channel: channel as KolChannel }),
            ...(q === null ? {} : { q }),
            ...(limit === null ? {} : { limit: Number(limit) }),
          }),
        )
      }
      if (method === 'POST' && rest === '/content-observations') {
        const rows = Array.isArray(body.observations) ? body.observations : []
        return ok(
          { accepted: service.contributeContentAs(principal, rows as PublicContentObservation[]) },
          201,
        )
      }
      const m = /^\/creators\/([^/]+)\/([^/]+)\/(reveal|audit|observations)$/u.exec(rest)
      if (m !== null) {
        const key = {
          channel: decodeURIComponent(m[1] as string) as KolChannel,
          handle: decodeURIComponent(m[2] as string),
        }
        if (method === 'POST' && m[3] === 'reveal') return ok(service.reveal(principal, key))
        if (method === 'GET' && m[3] === 'audit') return ok(service.audit(principal, key))
        if (method === 'POST' && m[3] === 'observations') {
          const raw = Array.isArray(body.observations) ? body.observations : [body]
          // 路径里的自足键就是权威
          const rows = (raw as Record<string, unknown>[]).map(
            (one) =>
              ({ ...one, channel: key.channel, handle: key.handle }) as PublicCreatorObservation,
          )
          const via = body.via === 'extension' ? ({ via: 'extension' } as const) : {}
          return ok({ accepted: service.contributeAs(principal, rows, via) }, 201)
        }
      }
    } catch (err) {
      if (err instanceof StandInKolError)
        return fail(
          err.code === 'insufficient_credits' ? 402 : err.code === 'not_found' ? 404 : 400,
          err.code,
          err.message,
        )
      throw err
    }
    return fail(404, 'not_found', `替身里没有这条路：${method} ${path}`)
  }
}

/**
 * 把几块替身拼成一个 fetch（本机各处的 `cloudFetch` / `KolPublicFetch` 注入点都认它）。
 * `/v1/pricing` 永远在（公开价目，默认那份固定样例）。`down` 置真 = 拔网线（抛错）。
 */
export function cloudStandInFetch(parts: {
  accounts?: CloudAccountsStandIn
  kolPublic?: KolPublicStandIn
  pricing?: PricingCatalog
}): { fetch: StandInHttpFetch; calls: string[]; down: boolean } {
  const kol =
    parts.kolPublic === undefined
      ? undefined
      : kolPublicHttp(parts.kolPublic, (t) =>
          parts.accounts === undefined ? undefined : parts.accounts.verify(t),
        )
  const state = {
    calls: [] as string[],
    down: false,
    fetch: (async () => respond(500, {})) as StandInHttpFetch,
  }
  state.fetch = async (input, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const url = new URL(input)
    state.calls.push(`${method} ${url.pathname}`)
    if (state.down) throw new Error('ECONNREFUSED')
    const headers = new Headers(init.headers as HeadersInit | undefined)
    const auth = headers.get('Authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : undefined
    let body: Record<string, unknown> = {}
    if (typeof init.body === 'string' && init.body.trim() !== '') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>
      } catch {
        return fail(400, 'invalid_input', '请求体不是合法 JSON')
      }
    }
    if (method === 'GET' && url.pathname === PRICING_CATALOG_PATH)
      return ok(parts.pricing ?? SAMPLE_PRICING_CATALOG)
    const fromAccounts = parts.accounts?.handle(method, url.pathname, token, body)
    if (fromAccounts !== undefined) return fromAccounts
    const fromKol = kol?.(method, url, token, body)
    if (fromKol !== undefined) return fromKol
    return fail(404, 'not_found', `替身里没有这条路：${method} ${url.pathname}`)
  }
  return state
}
