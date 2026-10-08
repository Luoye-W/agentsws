/**
 * 49 M1 的本地那一半：把这台机器上的工作区关联到一个 agentsws 云账号。
 *
 * 一次关联走这么几跳（**一次性登录 token 从头到尾没进过这个进程的日志**）：
 *
 * ```
 * 工作台「发登录邮件」
 *   → 本地 POST 云侧 /v1/cloud/auth/magic-link  { email, callback_url: 本机回环, state }
 *   → 用户在自己邮箱里点那条链接
 *   → 浏览器落回本机 GET /v1/cloud/account/callback?token=…&state=…
 *   → 本地 POST 云侧 /v1/cloud/auth/verify      → 云账号会话
 *   → 本地 POST 云侧 /v1/cloud/links            → 工作区服务令牌（明文只回这一次）
 *   → 令牌进本机加密库（cloud.workspace_token），云侧会话当场注销
 * ```
 *
 * 四条纪律：
 *
 * 1. **令牌只进本机加密库**（`secret-store`，AES-256-GCM、AAD 绑 id）。这个模块里
 *    没有任何一处把它写进日志、事件或响应体；`status()` 端出去的是元信息。
 * 2. **云侧会话不留**：拿到工作区令牌就注销掉。留着它等于在本机多存一把能管账号的钥匙，
 *    而关联之后一件也用不着（续期走工作台，重新走一遍登录）。
 * 3. **`state` 对不上就当没发生**：回调那条路是公开的（浏览器不带 Bearer），
 *    挡住"别人塞给你一条回调"的就是这个一次性随机串。
 * 4. 事件里只有邮箱**域名**与组织 id（`CloudAccountLinkedPayload`）。
 */

import { randomBytes } from 'node:crypto'
import type {
  BeginCloudLinkInput,
  BeginCloudLinkResult,
  CloudAccountPort,
  CloudAccountView,
  CloudAuthDoneView,
  CloudAuthPort,
  CloudCodeSentView,
  CloudUnlinkResult,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  Clock,
  CloudAccountLinkedPayload,
  CloudAccountUnlinkedPayload,
  CloudAuthConfig,
  CloudLinkUpgrade,
  CloudScope,
  CloudSessionIssued,
  EventEnvelope,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  CLOUD_BASE_URL_ENV,
  CLOUD_LINK_UPGRADE_PATH,
  CLOUD_OTP_LENGTH,
  CLOUD_OTP_TTL_SECONDS,
  CLOUD_PASSWORD_MIN,
  CLOUD_SCOPES,
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_CLOUD_SCOPES,
  emailDomain,
  LEGAL_TERMS_VERSION,
} from '@agentsws/contracts'
import type { SecretStore } from './secret-store.js'

/** 本机加密库里的 key 名。与连接面（`conn:*`）、模型面（`model:*`）同库不同前缀。 */
export const CLOUD_TOKEN_SECRET_ID = 'cloud.workspace_token'

/** 云的地址；全仓唯一真源在 `@agentsws/contracts`（WP110），这里只转出去。 */
export { CLOUD_BASE_URL_ENV, DEFAULT_CLOUD_BASE_URL }

/** 一次关联最多挂多久没人点（超了就作废，免得一条 state 永远有效）。 */
export const LINK_PENDING_TTL_MS = 30 * 60 * 1000

/** WP142：关联那一跳最多等多久（超了就说连不上、给「再试一次」）。 */
export const CLOUD_LINK_TIMEOUT_MS = 12_000

/** WP231：云那头还没有注册 / 登录这几条（老版本的云）时那一句。 */
export const CLOUD_AUTH_OUTDATED_MESSAGE =
  'Agents 工坊云还没更新到这一版的注册 / 登录，过一会儿再试。'

/** WP267：云上没有补签这一条（老版本的云）或令牌已经不认——界面退回「重新登录」。 */
export const CLOUD_UPGRADE_UNAVAILABLE_MESSAGE =
  '这一下没能直接更新授权，重新登录一次 Agents 工坊账号就好。'

/** WP142（docs/78 #6）：连不上云时那一句——说人话、给下一步，不报网址。 */
export const CLOUD_OFFLINE_MESSAGE = '网络不通，这一下没连上 Agents 工坊云。检查一下网络再试一次。'

export type CloudFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface CloudAccountOptions {
  secrets: SecretStore
  clock: Clock
  env?: Record<string, string | undefined>
  /** 出站 fetch；测试注入内存云服务端。 */
  fetch?: CloudFetch
  appendEvent: (e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }) => void
  workspace_id: () => WorkspaceId
  /**
   * WP66（52 O1）：这家公司下**所有**品牌工作区。
   *
   * 云上那把令牌是**按工作区签**的（`POST /v1/cloud/links` 的 body 就是
   * `workspace_id`），而 49 M1 的账号与余额在组织级——所以关联一次要给每个品牌
   * 各签一把，解除时各撤一把。不给就只有当前这一个（单品牌，与这一版之前一样）。
   */
  brands?: () => WorkspaceId[]
  /**
   * WP66：某个品牌那一段加密库（key 名已按品牌加过前缀）。
   *
   * 每把令牌存进**自己那个品牌**的库位下：品牌 A 的模型面取不到 B 的令牌，
   * 49 M2「用 agentsws 的」也就不会串着花另一个品牌的积分。
   * 不给就全部落在 `options.secrets` 上（单品牌）。
   */
  secretsFor?: (workspace_id: WorkspaceId) => SecretStore
  /** 本机服务进程的对外地址（回调落点）。listen 之后才知道端口，所以是取值函数。 */
  localBaseUrl: () => string | undefined
  /** 一次性 state 的随机源（测试注入）。 */
  randomBytes?: (n: number) => Buffer
}

export interface CloudAccountAssembly {
  port: CloudAccountPort
  /** 还没点的那次关联（测试与诊断用；**不含任何 token**）。 */
  pending(): { state: string; email: string; started_at: string } | undefined
  /**
   * WP66（52 O1）：给一个**新建的**品牌补签一把工作区服务令牌。
   *
   * 加品牌时调它：这家公司已经关联过账号的话，新品牌当场就能用积分；
   * 没关联过（或者补签被云侧拒了）就什么也不发生——加品牌不该因为云不在而失败。
   * 回 `true` 表示真签下来了一把。
   */
  ensureBrandToken(workspace_id: WorkspaceId): Promise<boolean>
  /**
   * WP267（决策 208，接私有云 WP266）：**一点补签**。拿这个品牌那把工作区令牌打
   * `POST /v1/cloud/links/current/upgrade`，云上就地补上后来才进默认集的动作集（`store` / `kol`）——
   * 不换令牌、不用重新登录。成了就把本机记的动作集跟着改（`missing_scopes` 随之消失），
   * 再顺手给同一家公司别的品牌也补一次（补不上不算失败）。
   *
   * 失败带 `details.reason`：`not_linked`（没令牌）/ `offline`（连不上）/ `upgrade_unavailable`
   * （云上没这一条，或令牌已经不认）——后两种以外界面都退回「重新登录」。
   */
  upgradeScopes(workspace_id: WorkspaceId): Promise<{ scopes: string[]; added: string[] }>
  /**
   * WP272：这个品牌本机记的令牌比现在的默认动作集少了哪几项（只读本机加密库，不打云）。
   * 没令牌 / 读不出签发时的动作集 = 空（不凭空补）。启动时后台自动补签用它挑品牌。
   */
  missingScopesOf(workspace_id: WorkspaceId): string[]
}

interface StoredLink {
  token: string
  email: string
  org_id: string
  org_name: string
  expires_at: string
  scopes: string
  linked_at: string
}

export function cloudBaseUrl(env: Record<string, string | undefined>): string {
  const raw = env[CLOUD_BASE_URL_ENV]
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_CLOUD_BASE_URL : raw.trim()
  return value.replace(/\/+$/, '')
}

/**
 * WP231：云回的注册 / 登录错误 → 本机网关的错误（码、`details.reason`、等多久）。
 *
 * 云的 401（验证码不对、密码不对）**不当 401 往回传**：本机的 401 在工作台上是
 * 「登录过期了，刷新一下」——那是本机会话的事，不是这一次填错了。所以翻成 400，
 * `details.reason` 照带，界面按它说人话。云那头没有这条路（老版本的云，404 not_found
 * 且没有 reason）时说「云还没更新」。
 */
export function passThroughError(
  status: number,
  body: { message?: string; code?: string; details?: unknown },
): ApiError {
  const details =
    body.details !== null && typeof body.details === 'object'
      ? (body.details as Record<string, unknown>)
      : undefined
  const reason = typeof details?.reason === 'string' ? details.reason : undefined
  const message = body.message ?? `Agents 工坊云回了 ${String(status)}，再试一次。`
  const keep = reason === undefined ? undefined : { details: { ...details, reason } }
  if (status === 404 && reason === undefined)
    return new ApiError('not_implemented', CLOUD_AUTH_OUTDATED_MESSAGE)
  if (status === 429) {
    const retry = typeof details?.retry_after === 'number' ? details.retry_after : undefined
    return new ApiError('rate_limited', message, {
      details: { ...(details ?? {}), ...(reason === undefined ? {} : { reason }) },
      ...(retry === undefined ? {} : { headers: { 'Retry-After': String(retry) } }),
    })
  }
  if (status === 409 && body.code === 'conflict')
    return new ApiError('conflict', message, keep ?? {})
  if (status === 400 || status === 401 || status === 403 || status === 404)
    return new ApiError('invalid_input', message, keep ?? {})
  return new ApiError('provider_error', message, keep ?? {})
}

export function createCloudAccount(options: CloudAccountOptions): CloudAccountAssembly {
  const env = options.env ?? process.env
  const base = cloudBaseUrl(env)
  const rand = options.randomBytes ?? randomBytes
  const doFetch: CloudFetch =
    options.fetch ??
    (async (input, init) => {
      const res = await globalThis.fetch(input, {
        method: init?.method ?? 'GET',
        ...(init?.headers === undefined ? {} : { headers: init.headers }),
        ...(init?.body === undefined ? {} : { body: init.body }),
      })
      return { ok: res.ok, status: res.status, text: () => res.text() }
    })

  let pending: { state: string; email: string; started_at: string } | undefined

  /** 这家公司下有哪些品牌（不给就只有当前这一个）。 */
  const brandsOf = (): WorkspaceId[] => {
    const rows = options.brands?.() ?? []
    const current = options.workspace_id()
    return rows.length === 0 ? [current] : rows
  }
  /** 某个品牌那一段加密库（不给就是同一个库，单品牌那一档）。 */
  const vaultOf = (ws: WorkspaceId): SecretStore => options.secretsFor?.(ws) ?? options.secrets

  /** 读加密库里那条；没有就是没关联。**返回值里有令牌明文，只在本模块内部流转。** */
  const stored = (): StoredLink | undefined => {
    if (!options.secrets.available) return undefined
    const fields = options.secrets.get(CLOUD_TOKEN_SECRET_ID)
    if (fields === undefined) return undefined
    const { token, email, org_id, org_name, expires_at, scopes, linked_at } = fields
    if (token === undefined || email === undefined) return undefined
    return {
      token,
      email,
      org_id: org_id ?? '',
      org_name: org_name ?? email,
      expires_at: expires_at ?? '',
      scopes: scopes ?? '',
      linked_at: linked_at ?? '',
    }
  }

  const parseScopes = (raw: string): CloudScope[] =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is CloudScope => s === 'ai' || s === 'wallet:read' || s === 'standby')

  /**
   * WP265（决策 186）：这把令牌比现在的默认动作集少了哪几项。签发时的动作集读不出来（很老的
   * 存档没记）就当不知道、不报——宁可让云上那一跳照实回 403，也不凭空吓人。
   */
  const missingScopes = (raw: string): CloudScope[] => {
    const have = new Set(
      raw
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x !== ''),
    )
    if (have.size === 0) return []
    return DEFAULT_CLOUD_SCOPES.filter((x) => !have.has(x) && CLOUD_SCOPES.includes(x))
  }

  const view = (): CloudAccountView => {
    const link = stored()
    if (link === undefined)
      return {
        linked: false,
        cloud_base_url: base,
        // 没有秘密库密钥就存不下令牌——先说清楚，别让人点完才发现失败
        ...(options.secrets.available
          ? {}
          : { blocked_reason: '这台机器还没有秘密库密钥，令牌无处安全存放' }),
      }
    return {
      linked: true,
      email: link.email,
      org_name: link.org_name,
      expires_at: link.expires_at,
      scopes: parseScopes(link.scopes),
      linked_at: link.linked_at,
      cloud_base_url: base,
      ...(missingScopes(link.scopes).length === 0
        ? {}
        : { missing_scopes: missingScopes(link.scopes) }),
    }
  }

  /** 向云侧发一次请求；错误翻成网关的信封，**原文里绝不回显任何令牌**。 */
  const call = async <T>(
    path: string,
    init: {
      method?: string
      token?: string
      body?: unknown
      /**
       * WP231：把云回的错误码与 `details.reason` 原样带回界面（已注册 / 验证码不对 / 锁定…）。
       * 只给注册 / 登录那几条用；老的几条照旧翻成 `provider_error`。
       */
      passThrough?: boolean
    } = {},
  ): Promise<T> => {
    let res: Awaited<ReturnType<CloudFetch>>
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      /*
       * WP142（docs/78 #6）：**等多久有个头**。以前断网时这一跳要等系统层超时，
       * 向导上只有一个变灰的按钮；现在 12 秒没回就当连不上，界面给「再试一次」。
       */
      res = await Promise.race([
        doFetch(`${base}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(init.token === undefined ? {} : { Authorization: `Bearer ${init.token}` }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('timeout'))
          }, CLOUD_LINK_TIMEOUT_MS)
        }),
      ])
    } catch (err) {
      // WP142：说人话、给下一步，不报网址（网址在设置页「连到 …」那一行里本来就看得见）
      throw new ApiError('provider_unavailable', CLOUD_OFFLINE_MESSAGE, { cause: err })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    const text = await res.text()
    let parsed: unknown = {}
    try {
      parsed = text === '' ? {} : JSON.parse(text)
    } catch {
      // 云那头回了一页 HTML（网关报错页）：当成连不上，而不是把解析错误甩给用户
      parsed = {}
    }
    if (!res.ok) {
      const body = parsed as { message?: string; code?: string; details?: unknown }
      if (res.status >= 500 && body.message === undefined)
        throw new ApiError('provider_unavailable', CLOUD_OFFLINE_MESSAGE)
      if (init.passThrough === true) throw passThroughError(res.status, body)
      throw new ApiError(
        res.status === 401 || res.status === 403 ? 'forbidden' : 'provider_error',
        body.message ?? `Agents 工坊云回了 ${String(res.status)}，这一次没关联上。再试一次。`,
      )
    }
    return (parsed as { data: T }).data
  }

  /**
   * 拿到一张云账号会话之后的那一串（邮件链接、WP231 的验证码 / 密码都走这里）：
   * 每个品牌各签一把工作区令牌进本机加密库、记一条关联事件、云侧会话当场注销。
   */
  const bind = async (
    verified: {
      account: { id: string; email: string }
      org: { id: string; name: string }
      session_token: string
    },
    traceKey: string,
    /**
     * WP265：已关联、同一账号再登录一次换新令牌（老令牌缺新动作集）。新的全存好了，再用**这张会话**
     * 按 id 撤掉这几个品牌之前的关联——不能拿老令牌打 `links/current/revoke`：云上「当前那条」
     * 是这个工作区最新的一条，撤的会是刚签的新令牌。
     */
    opts: { replace?: boolean } = {},
  ): Promise<void> => {
    const workspace_id = options.workspace_id()
    const fresh = new Set<string>()
    /** 真签到新令牌的品牌（只撤这几个的老关联：没签上的那个还靠老令牌活着）。 */
    const renewed = new Set<string>()
    try {
      /*
       * WP66（52 O1）：云上那把令牌是**按工作区签**的，而账号与余额在组织级
       * （49 M1）——所以这家公司下**每个品牌各签一把**。当前这个品牌先签
       * （它的那一把决定这次关联的回执长什么样）；别的品牌签不下来不算失败：
       * 关联本身已经成了，补签走"加品牌"那条路（`ensureBrandToken`）。
       */
      const issued = await call<{
        link: { id?: string; expires_at: string; scopes: CloudScope[]; cloud_org_id: string }
        token: string
      }>('/v1/cloud/links', {
        method: 'POST',
        token: verified.session_token,
        body: { workspace_id, label: workspace_id },
      })
      if (issued.link.id !== undefined) fresh.add(issued.link.id)
      renewed.add(workspace_id)
      const fieldsOf = (t: string, expires_at: string, scopes: string) => ({
        token: t,
        email: verified.account.email,
        org_id: verified.org.id,
        org_name: verified.org.name,
        expires_at,
        scopes,
        linked_at: options.clock.now(),
      })
      vaultOf(workspace_id).put(
        CLOUD_TOKEN_SECRET_ID,
        fieldsOf(issued.token, issued.link.expires_at, issued.link.scopes.join(',')),
      )
      for (const ws of brandsOf()) {
        if (ws === workspace_id) continue
        try {
          const extra = await call<{
            link: { id?: string; expires_at: string; scopes: CloudScope[] }
            token: string
          }>('/v1/cloud/links', {
            method: 'POST',
            token: verified.session_token,
            body: { workspace_id: ws, label: ws },
          })
          if (extra.link.id !== undefined) fresh.add(extra.link.id)
          renewed.add(ws)
          vaultOf(ws).put(
            CLOUD_TOKEN_SECRET_ID,
            fieldsOf(extra.token, extra.link.expires_at, extra.link.scopes.join(',')),
          )
        } catch {
          // 这个品牌没签上：它的"用 agentsws 的"暂时不可用，别的品牌照常
        }
      }
      if (opts.replace === true) await revokeOlder(verified.session_token, fresh, renewed)
      const payload: CloudAccountLinkedPayload = {
        email_domain: emailDomain(verified.account.email),
        cloud_org_id: verified.org.id,
        scopes: issued.link.scopes,
        expires_at: issued.link.expires_at,
      }
      options.appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'cloud.account_linked',
        actor: { kind: 'system', id: 'cloud-account' },
        correlation: { trace_id: `tr_cloud_link_${traceKey}` },
        payload,
      })
    } finally {
      // 云侧会话用完就注销：本机不留第二把能管账号的钥匙
      pending = undefined
      try {
        await call('/v1/cloud/auth/logout', { method: 'POST', token: verified.session_token })
      } catch {
        // 注销失败不影响关联本身（那张会话 12 小时后自己过期）
      }
    }
  }

  /**
   * WP265：换新令牌之后把这几个品牌之前的关联撤掉（按 id、用会话）。撤不掉不算失败——
   * 新令牌已经在用了，老的那把本机已经没有了，到期自己作废；云那头没有列关联这一条也一样。
   */
  const revokeOlder = async (
    session: string,
    fresh: Set<string>,
    mine: Set<string>,
  ): Promise<void> => {
    let links: { id: string; workspace_id: string; revoked_at?: string }[] = []
    try {
      const listed = await call<{
        links?: { id: string; workspace_id: string; revoked_at?: string }[]
      }>('/v1/cloud/links', { token: session })
      links = listed.links ?? []
    } catch {
      return
    }
    for (const l of links) {
      if (!mine.has(l.workspace_id) || fresh.has(l.id) || l.revoked_at !== undefined) continue
      try {
        await call(`/v1/cloud/links/${encodeURIComponent(l.id)}/revoke`, {
          method: 'POST',
          token: session,
        })
      } catch {
        // 同上：撤不掉就等它到期
      }
    }
  }

  /**
   * WP231：注册与登录（密码 + 邮箱验证码）。**密码与验证码只在这一跳的请求体里**（HTTPS 到云）：
   * 不落盘、不进事件、不进日志；出错信息里也不回显。拿到会话之后走同一个 {@link bind}。
   */
  /** `refresh`（WP265）：已关联时同一账号再登录一次，换一把带新动作集的令牌——这时不挡。 */
  const guardLinkable = (refresh = false): void => {
    if (!options.secrets.available)
      throw new ApiError(
        'not_implemented',
        '这台机器没有秘密库密钥（AGENTSWS_SECRETS_KEY），令牌无处安全存放',
      )
    if (stored() !== undefined && !refresh)
      throw new ApiError('conflict', '这个工作区已经关联过了，先解除再关联别的账号')
  }
  const sendCode = async (
    path: string,
    body: unknown,
    refresh = false,
  ): Promise<CloudCodeSentView> => {
    guardLinkable(refresh)
    const out = await call<{ expires_at: string }>(path, {
      method: 'POST',
      body,
      passThrough: true,
    })
    return { expires_at: out.expires_at, delivered: 'email' }
  }
  const finish = async (
    path: string,
    body: unknown,
    refresh = false,
  ): Promise<CloudAuthDoneView> => {
    guardLinkable(refresh)
    const before = stored()
    const verified = await call<CloudSessionIssued>(path, {
      method: 'POST',
      body,
      passThrough: true,
    })
    // WP265：换新令牌只许同一个账号（换账号要先解除——钱从哪个账号出不能悄悄变）
    if (
      refresh &&
      before !== undefined &&
      before.email.trim().toLowerCase() !== verified.account.email.trim().toLowerCase()
    ) {
      try {
        await call('/v1/cloud/auth/logout', { method: 'POST', token: verified.session_token })
      } catch {
        // 会话 12 小时后自己过期
      }
      throw new ApiError(
        'conflict',
        '这是另一个 Agents 工坊账号。要换账号，先在设置里解除关联再登录。',
        { details: { reason: 'other_account' } },
      )
    }
    await bind(verified, rand(4).toString('hex'), { replace: refresh && before !== undefined })
    const granted = verified.bonus?.granted === true ? verified.bonus.credits : undefined
    return {
      ...view(),
      ...(verified.registered === undefined ? {} : { registered: verified.registered }),
      ...(granted === undefined ? {} : { bonus_credits: granted }),
    }
  }
  const auth: CloudAuthPort = {
    async authConfig(): Promise<CloudAuthConfig> {
      try {
        return await call<CloudAuthConfig>('/v1/cloud/auth/config', { passThrough: true })
      } catch {
        // 云不在 / 老版本：界面照默认值画（Turnstile 不出），真发的时候再说人话
        return {
          password_min: CLOUD_PASSWORD_MIN,
          otp_length: CLOUD_OTP_LENGTH,
          otp_ttl_seconds: CLOUD_OTP_TTL_SECONDS,
          terms_version: LEGAL_TERMS_VERSION,
        }
      }
    },
    signup: (input) =>
      sendCode('/v1/cloud/auth/signup', {
        name: input.name,
        email: input.email,
        password: input.password,
        consent: { accepted: true, terms_version: input.terms_version },
        source: 'workstation',
        locale: input.locale,
      }),
    verifySignup: (input) => finish('/v1/cloud/auth/signup/verify', input),
    sendLoginCode: (input) =>
      sendCode(
        '/v1/cloud/auth/otp',
        { email: input.email, locale: input.locale },
        input.refresh === true,
      ),
    verifyLoginCode: (input) =>
      finish(
        '/v1/cloud/auth/otp/verify',
        { email: input.email, code: input.code },
        input.refresh === true,
      ),
    passwordLogin: (input) =>
      finish(
        '/v1/cloud/auth/password',
        { email: input.email, password: input.password },
        input.refresh === true,
      ),
    forgotPassword: (input) => sendCode('/v1/cloud/auth/password/forgot', input),
    resetPassword: (input) => finish('/v1/cloud/auth/password/reset', input),
  }

  const port: CloudAccountPort = {
    auth,
    async status() {
      return view()
    },

    async begin(input: BeginCloudLinkInput): Promise<BeginCloudLinkResult> {
      if (!options.secrets.available)
        throw new ApiError(
          'not_implemented',
          '这台机器没有秘密库密钥（AGENTSWS_SECRETS_KEY），令牌无处安全存放',
        )
      if (stored() !== undefined)
        throw new ApiError('conflict', '这个工作区已经关联过了，先解除再关联别的账号')
      const local = options.localBaseUrl()
      if (local === undefined)
        throw new ApiError('not_implemented', '服务进程还没监听，拿不到回调地址')
      const state = rand(16).toString('hex')
      const out = await call<{ expires_at: string; delivered: 'email' }>(
        '/v1/cloud/auth/magic-link',
        {
          method: 'POST',
          body: {
            email: input.email,
            callback_url: `${local}/v1/cloud/account/callback`,
            state,
          },
        },
      )
      pending = { state, email: input.email, started_at: options.clock.now() }
      return { expires_at: out.expires_at, delivered: 'email' }
    },

    async complete({ token, state }): Promise<CloudAccountView> {
      const waiting = pending
      // state 对不上 / 过期 / 压根没起过关联：一律同一句话，不区分
      if (
        waiting === undefined ||
        waiting.state !== state ||
        Date.parse(options.clock.now()) - Date.parse(waiting.started_at) > LINK_PENDING_TTL_MS
      )
        throw new ApiError('not_found', '这条关联链接已经失效了，回工作台重新发一次')

      const verified = await call<{
        account: { id: string; email: string }
        org: { id: string; name: string }
        session_token: string
      }>('/v1/cloud/auth/verify', { method: 'POST', body: { token } })
      await bind(verified, state.slice(0, 8))
      return view()
    },

    async unlink({ workspace_id }): Promise<CloudUnlinkResult> {
      const link = stored()
      if (link === undefined) return { unlinked: false, revoked_on_cloud: false }
      let revoked = false
      let reason: string | undefined
      try {
        await call('/v1/cloud/links/current/revoke', { method: 'POST', token: link.token })
        revoked = true
      } catch (err) {
        // 网络不通照样本地断开——用户按的是"解除"，不能因为云不在就不解除；
        // 但必须说出来：云侧那条还活着，联网后要再撤一次。
        reason =
          err instanceof ApiError
            ? `本地已断开，云侧那条没撤掉：${err.message}`
            : '本地已断开，云侧那条没撤掉'
      }
      /*
       * WP66：解除是**整家公司**的事（账号在组织级），所以每个品牌那把也一起撤。
       * 撤不掉的照样本地删——留一把本地读不出、云上还活着的令牌最糟。
       */
      for (const ws of brandsOf()) {
        if (ws === workspace_id) continue
        const other = vaultOf(ws)
        let token: string | undefined
        try {
          token = other.get(CLOUD_TOKEN_SECRET_ID)?.token
        } catch {
          token = undefined
        }
        if (token !== undefined && token !== '') {
          try {
            await call('/v1/cloud/links/current/revoke', { method: 'POST', token })
          } catch {
            // 同上：本地照删，云侧那条等联网后再撤
          }
        }
        other.remove(CLOUD_TOKEN_SECRET_ID)
      }
      vaultOf(workspace_id).remove(CLOUD_TOKEN_SECRET_ID)
      const payload: CloudAccountUnlinkedPayload = {
        email_domain: emailDomain(link.email),
        cloud_org_id: link.org_id,
        revoked_on_cloud: revoked,
      }
      options.appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'cloud.account_unlinked',
        actor: { kind: 'system', id: 'cloud-account' },
        correlation: { trace_id: `tr_cloud_unlink_${link.org_id}` },
        payload,
      })
      return {
        unlinked: true,
        revoked_on_cloud: revoked,
        ...(reason === undefined ? {} : { reason }),
      }
    },
  }

  return {
    port,
    pending: () => pending,
    async ensureBrandToken(workspace_id): Promise<boolean> {
      const current = stored()
      // 这家公司还没关联过账号：没什么可补签的（新品牌跟着一起等关联）
      if (current === undefined) return false
      const vault = vaultOf(workspace_id)
      try {
        if (vault.record(CLOUD_TOKEN_SECRET_ID) !== undefined) return false
      } catch {
        // 读不出来（换过密钥）：当成没有，重新签一把
      }
      try {
        /*
         * 补签用**当前品牌那把工作区令牌**换一把新的：本机没有第二把能管账号的
         * 钥匙（关联时那张云侧会话用完就注销了，见 `complete` 的 finally）。
         * 云侧不认这条路就什么也不发生——加品牌不该因为云不在而失败。
         */
        const issued = await call<{
          link: { expires_at: string; scopes: CloudScope[] }
          token: string
        }>('/v1/cloud/links/sibling', {
          method: 'POST',
          token: current.token,
          body: { workspace_id, label: workspace_id },
        })
        vault.put(CLOUD_TOKEN_SECRET_ID, {
          token: issued.token,
          email: current.email,
          org_id: current.org_id,
          org_name: current.org_name,
          expires_at: issued.link.expires_at,
          scopes: issued.link.scopes.join(','),
          linked_at: options.clock.now(),
        })
        return true
      } catch {
        return false
      }
    },
    missingScopesOf(workspace_id) {
      let fields: Record<string, string> | undefined
      try {
        fields = vaultOf(workspace_id).get(CLOUD_TOKEN_SECRET_ID)
      } catch {
        return []
      }
      if (fields?.token === undefined || fields.token === '') return []
      return missingScopes(fields.scopes ?? '')
    },
    async upgradeScopes(workspace_id) {
      const tokenOf = (ws: WorkspaceId): { token: string; fields: Record<string, string> } => {
        let fields: Record<string, string> | undefined
        try {
          fields = vaultOf(ws).get(CLOUD_TOKEN_SECRET_ID)
        } catch {
          fields = undefined
        }
        const token = fields?.token
        if (fields === undefined || token === undefined || token === '')
          throw new ApiError('forbidden', '先登录 Agents 工坊账号。', {
            details: { reason: 'not_linked' },
          })
        return { token, fields }
      }
      /** 打一次补签；成了就把本机记的动作集改成云上回的那一份（令牌不变）。 */
      const upgradeOne = async (ws: WorkspaceId): Promise<CloudLinkUpgrade> => {
        const { token, fields } = tokenOf(ws)
        let res: Awaited<ReturnType<CloudFetch>>
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          res = await Promise.race([
            doFetch(`${base}${CLOUD_LINK_UPGRADE_PATH}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(new Error('timeout'))
              }, CLOUD_LINK_TIMEOUT_MS)
            }),
          ])
        } catch (err) {
          throw new ApiError('provider_unavailable', CLOUD_OFFLINE_MESSAGE, {
            cause: err,
            details: { reason: 'offline' },
          })
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
        let parsed: { data?: Partial<CloudLinkUpgrade> } = {}
        try {
          const text = await res.text()
          parsed = text === '' ? {} : (JSON.parse(text) as typeof parsed)
        } catch {
          parsed = {}
        }
        const data = parsed.data
        if (!res.ok || data === undefined || !Array.isArray(data.scopes)) {
          if (res.status >= 500 && res.status !== 501)
            throw new ApiError('provider_unavailable', CLOUD_OFFLINE_MESSAGE, {
              details: { reason: 'offline' },
            })
          // 404 / 405 / 501（老版本的云没这一条）、401 / 403（令牌不认）、回包不对：都退回重新登录
          throw new ApiError('not_implemented', CLOUD_UPGRADE_UNAVAILABLE_MESSAGE, {
            details: { reason: 'upgrade_unavailable', status: res.status },
          })
        }
        const scopes = data.scopes.filter((x): x is string => typeof x === 'string')
        const added = Array.isArray(data.added)
          ? data.added.filter((x): x is string => typeof x === 'string')
          : []
        vaultOf(ws).put(CLOUD_TOKEN_SECRET_ID, { ...fields, scopes: scopes.join(',') })
        return { scopes, added }
      }
      const out = await upgradeOne(workspace_id)
      // 同一家公司的别的品牌：本机记的动作集也缺的话顺手补（补不上不算失败，卡上再点一次就好）
      for (const ws of brandsOf()) {
        if (ws === workspace_id) continue
        let have = ''
        try {
          have = vaultOf(ws).get(CLOUD_TOKEN_SECRET_ID)?.scopes ?? ''
        } catch {
          continue
        }
        if (missingScopes(have).length === 0) continue
        try {
          await upgradeOne(ws)
        } catch {
          // 那个品牌的卡上会照实说，再点一次
        }
      }
      return { scopes: out.scopes, added: out.added }
    },
  }
}
