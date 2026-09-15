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
  CloudUnlinkResult,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  Clock,
  CloudAccountLinkedPayload,
  CloudAccountUnlinkedPayload,
  CloudScope,
  EventEnvelope,
  WorkspaceId,
} from '@agentsws/contracts'
import { emailDomain } from '@agentsws/contracts'
import type { SecretStore } from './secret-store.js'

/** 本机加密库里的 key 名。与连接面（`conn:*`）、模型面（`model:*`）同库不同前缀。 */
export const CLOUD_TOKEN_SECRET_ID = 'cloud.workspace_token'

/** 云的地址；全仓唯一真源在这里解析。 */
export const CLOUD_BASE_URL_ENV = 'AGENTSWS_CLOUD_BASE_URL'
export const DEFAULT_CLOUD_BASE_URL = 'https://cloud.agentsws.app'

/** 一次关联最多挂多久没人点（超了就作废，免得一条 state 永远有效）。 */
export const LINK_PENDING_TTL_MS = 30 * 60 * 1000

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
  /** 本机服务进程的对外地址（回调落点）。listen 之后才知道端口，所以是取值函数。 */
  localBaseUrl: () => string | undefined
  /** 一次性 state 的随机源（测试注入）。 */
  randomBytes?: (n: number) => Buffer
}

export interface CloudAccountAssembly {
  port: CloudAccountPort
  /** 还没点的那次关联（测试与诊断用；**不含任何 token**）。 */
  pending(): { state: string; email: string; started_at: string } | undefined
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
    }
  }

  /** 向云侧发一次请求；错误翻成网关的信封，**原文里绝不回显任何令牌**。 */
  const call = async <T>(
    path: string,
    init: { method?: string; token?: string; body?: unknown } = {},
  ): Promise<T> => {
    let res: Awaited<ReturnType<CloudFetch>>
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.token === undefined ? {} : { Authorization: `Bearer ${init.token}` }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    } catch (err) {
      throw new ApiError('provider_unavailable', `连不上 agentsws 云（${base}）`, { cause: err })
    }
    const text = await res.text()
    const parsed: unknown = text === '' ? {} : JSON.parse(text)
    if (!res.ok) {
      const body = parsed as { message?: string }
      throw new ApiError(
        res.status === 401 || res.status === 403 ? 'forbidden' : 'provider_error',
        body.message ?? `agentsws 云回了 ${String(res.status)}`,
      )
    }
    return (parsed as { data: T }).data
  }

  const port: CloudAccountPort = {
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

      const workspace_id = options.workspace_id()
      try {
        const issued = await call<{
          link: { expires_at: string; scopes: CloudScope[]; cloud_org_id: string }
          token: string
        }>('/v1/cloud/links', {
          method: 'POST',
          token: verified.session_token,
          body: { workspace_id, label: workspace_id },
        })
        options.secrets.put(CLOUD_TOKEN_SECRET_ID, {
          token: issued.token,
          email: verified.account.email,
          org_id: verified.org.id,
          org_name: verified.org.name,
          expires_at: issued.link.expires_at,
          scopes: issued.link.scopes.join(','),
          linked_at: options.clock.now(),
        })
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
          correlation: { trace_id: `tr_cloud_link_${state.slice(0, 8)}` },
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
      options.secrets.remove(CLOUD_TOKEN_SECRET_ID)
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

  return { port, pending: () => pending }
}
