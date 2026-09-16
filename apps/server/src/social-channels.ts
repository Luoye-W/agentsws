/**
 * WP73（56 §6）：九条社媒渠道**真打出去的那一跳**。
 *
 * `@agentsws/social-core` 的适配器是纯的（自己拼 URL 与 body，但没有 fetch、
 * 碰不到凭据）；真 HTTP 与真凭据在这里。与红人那一侧的 `kol-channels.ts`
 * 是同一条路，只是分工切得更干净：那边的 transport 还要替五条渠道拼请求，
 * 这边**一行请求都不拼**——"这家的接口长什么样"整个留在 `social-core` 里，
 * 这个文件只回答四个问题：
 *
 * | 问题 | 怎么答 |
 * |---|---|
 * | 这条渠道连上了没有 | 这个品牌现在真有没有那条连接（`connections()`） |
 * | 凭据是什么 | 本品牌加密库按连接 id 取（{@link SocialChannelsOptions.secrets}） |
 * | 现在几点 | 注入的 `clock`（`social-core` 里没有 `Date.now()`） |
 * | 请求怎么发出去 | 注入的 fetch + 超时 |
 *
 * 五条纪律（与 `kol-channels.ts` 逐字相同，因为它们是同一件事）：
 *
 * 1. **不带任何真 key**：token 只从 `SecretStore` 那一段按连接 id 取，取出来
 *    直接交给适配器放进请求头，函数返回之后没人再引用它。这个文件里没有一处
 *    `console`，也没有一处把凭据放进返回值。
 * 2. **没连就是没连**：`connected()` 只看这个品牌现在真有没有那条连接。
 * 3. **Facebook 群组不看连接看浏览器**：它没有连接卡（Groups API 已停），
 *    "连上了"= 第三栏那个受控浏览器装配好了（55 §3 / WP82）。
 * 4. **取不到凭据 = 没连**：换过秘密库密钥时当成"没连"——那正是用户看到的
 *    现象，而且他修得好（重填一次）。
 * 5. **一跳最多等 12 秒**：卡住不该拖着整张面板。
 */
import type { Clock, SocialChannel, WorkspaceId } from '@agentsws/contracts'
import { SOCIAL_CHANNELS } from '@agentsws/contracts'
import type { BrowserExecutor, SocialChannelAdapter, SocialTransport } from '@agentsws/social-core'
import { createSocialAdapters } from '@agentsws/social-core'
import type { SecretStore } from './secret-store.js'

/** 注入的 fetch（测试塞一个假的；生产用全局那一个）。 */
export type SocialFetch = (
  input: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** 打一跳最多等多久。 */
export const SOCIAL_HTTP_TIMEOUT_MS = 12_000

/** 渠道 → 连接器 kind（`meta` → `meta_graph`）。Facebook 群组没有，所以是可选的。 */
export const SOCIAL_CONNECTOR_OF_CHANNEL: Readonly<Partial<Record<SocialChannel, string>>> =
  Object.fromEntries(
    SOCIAL_CHANNELS.filter((c) => c.connector_kind !== undefined).map((c) => [
      c.id,
      c.connector_kind as string,
    ]),
  )

/** 这个进程看得到的一条连接（只有 id / service / 状态，**没有凭据**）。 */
export interface SocialConnectionRef {
  id: string
  service: string
  status: string
}

export interface SocialChannelsOptions {
  workspace_id: WorkspaceId
  clock: Clock
  /** 现在这个品牌真有哪些连接。 */
  connections(): SocialConnectionRef[]
  /** 这个品牌那一段加密库（凭据按连接 id 取）。 */
  secrets: SecretStore
  fetch?: SocialFetch
  /**
   * 受控浏览器执行器（55 §3 / WP82）。**只有 Facebook 群组用得上**。
   *
   * 不给 = 那条渠道还是"只出脚本描述、不假装点过了"（WP72 那个样子）。
   */
  browser?: BrowserExecutor
}

export interface SocialChannelsAssembly {
  transport: SocialTransport
  /** 九条渠道的适配器（按渠道分派只有 `social-core` 的 `createSocialAdapters` 一处）。 */
  adapters: Record<SocialChannel, SocialChannelAdapter>
  /** 这条渠道现在挂着哪条连接（发出去那一跳要把连接 id 记进账本）。 */
  connectionOf(channel: SocialChannel): SocialConnectionRef | undefined
}

export function createSocialChannels(options: SocialChannelsOptions): SocialChannelsAssembly {
  const doFetch: SocialFetch =
    options.fetch ??
    ((input, init) => globalThis.fetch(input, init as RequestInit) as ReturnType<SocialFetch>)

  const connectionOf = (channel: SocialChannel): SocialConnectionRef | undefined => {
    const kind = SOCIAL_CONNECTOR_OF_CHANNEL[channel]
    if (kind === undefined) return undefined
    return options
      .connections()
      .find((c) => c.service === kind && (c.status === 'connected' || c.status === 'ok'))
  }

  const transport: SocialTransport = {
    connected: (channel) => {
      // 纪律 3：这条渠道没有连接卡，"连上了"= 浏览器装配好了
      if (channel === 'facebook_group') return options.browser !== undefined
      return connectionOf(channel) !== undefined
    },
    now: () => options.clock.now(),
    credential: async (channel) => {
      const connection = connectionOf(channel)
      if (connection === undefined) throw new Error(`${channel} 现在没有连上`)
      if (!options.secrets.available)
        throw new Error(`取不到 ${channel} 这条连接的凭据（这台机器的加密库没开）`)
      try {
        return options.secrets.get(connection.id) ?? {}
      } catch {
        // 纪律 4：换过秘密库密钥 = 当成"没连"（用户重填一次就好）
        throw new Error(`取不到 ${channel} 这条连接的凭据（加密库换过密钥）。去连接页重填一次。`)
      }
    },
    fetch: async (url, init) => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, SOCIAL_HTTP_TIMEOUT_MS)
      try {
        const res = await doFetch(url, {
          ...(init?.method === undefined ? {} : { method: init.method }),
          ...(init?.headers === undefined ? {} : { headers: init.headers }),
          ...(init?.body === undefined ? {} : { body: init.body }),
          signal: controller.signal,
        })
        return { ok: res.ok, status: res.status, text: () => res.text() }
      } finally {
        clearTimeout(timer)
      }
    },
  }

  return {
    transport,
    adapters: createSocialAdapters(
      transport,
      options.browser === undefined ? {} : { browser: options.browser },
    ),
    connectionOf,
  }
}
