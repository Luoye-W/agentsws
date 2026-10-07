/**
 * WP246：取数路线一个品牌一份的装配——体检、设置、Reddit 读号、两个零配置工具。
 *
 * 出网读（YouTube 字幕、网页转文字、体检探测）**给了 `net` 才装**：生产入口给 `{}`（用 `globalThis.fetch`），
 * 测试塞指向本地假站点的 fetch；测试 / 模拟 / 演示不给就不出网，工具照实说「没装」。
 */
import type {
  ReadRoutesSettings,
  ReadRoutesView,
  RedditReadAccountStatus,
} from '@agentsws/contracts'
import type { ToolExecutor } from '@agentsws/stand-ins'
import type { CloudAssembly } from '../cloud.js'
import type { RedditReadAccount } from '../readonly-browser/account.js'
import type { ReadonlyBrowser } from '../readonly-browser/index.js'
import { runReadRoutesDoctor } from './doctor.js'
import { getPublicPage, type ReadFetch } from './fetch.js'
import type { ReadRoutesStore } from './store.js'
import { createReadToolExecutor } from './tools.js'

export { redditBrowserCheck } from './doctor.js'
export { createReadRoutesStore, type ReadRoutesStore } from './store.js'
export { chainResearchTools, READ_ROUTE_TOOL_NAMES } from './tools.js'

/** 出网读的配置（生产给 `{}`）。 */
export interface ReadNetOptions {
  fetch?: ReadFetch
  lookup?: (host: string) => Promise<string[]>
  /** 测试用：放行本地假站点的主机。 */
  allowHosts?: readonly string[]
  youtubeBase?: string
  thirdPartyBase?: string
}

export interface ReadRoutesOptions {
  store: ReadRoutesStore
  nowMs(): number
  cloud: Pick<CloudAssembly, 'redditReadRoute' | 'linked' | 'priceOf'>
  hosted: boolean
  browser?: ReadonlyBrowser
  account?: RedditReadAccount
  net?: ReadNetOptions
}

export interface ReadRoutesAssembly {
  readonly store: ReadRoutesStore
  readonly account?: RedditReadAccount
  /** `read_youtube_transcript` / `read_webpage` 的执行器。 */
  tools: ToolExecutor
  view(): Promise<ReadRoutesView>
  /** 重新体检（真去连网）。 */
  doctor(): Promise<ReadRoutesView>
  setSettings(patch: Partial<ReadRoutesSettings>): Promise<ReadRoutesView>
  openRedditLogin(): Promise<RedditReadAccountStatus>
  checkRedditAccount(): Promise<RedditReadAccountStatus>
  close(): Promise<void>
}

const defaultFetch: ReadFetch = (url, init) =>
  globalThis.fetch(url, init) as unknown as ReturnType<ReadFetch>

export function createReadRoutes(options: ReadRoutesOptions): ReadRoutesAssembly {
  const { store, account, browser } = options
  const net = options.net
  const base =
    net === undefined
      ? undefined
      : {
          fetch: net.fetch ?? defaultFetch,
          ...(net.lookup === undefined ? {} : { lookup: net.lookup }),
          ...(net.allowHosts === undefined ? {} : { allowHosts: net.allowHosts }),
        }
  const tools = createReadToolExecutor({
    store,
    nowMs: options.nowMs,
    ...(base === undefined
      ? {}
      : {
          youtube: {
            ...base,
            ...(net?.youtubeBase === undefined ? {} : { base: net.youtubeBase }),
          },
          web: {
            ...base,
            thirdParty: () => store.settings().web_third_party_reader,
            ...(net?.thirdPartyBase === undefined ? {} : { thirdPartyBase: net.thirdPartyBase }),
          },
        }),
  })
  const ports = {
    nowMs: options.nowMs,
    store,
    redditRoute: () => options.cloud.redditReadRoute(),
    linked: () => options.cloud.linked(),
    hosted: options.hosted,
    workshopPrice: async (c: string) => (await options.cloud.priceOf(c))?.credits,
    ...(browser === undefined ? {} : { browser }),
    ...(account === undefined ? {} : { account }),
    ...(base === undefined
      ? {}
      : {
          probe: async (url: string) => {
            const got = await getPublicPage(
              url,
              { ...base, timeoutMs: 6_000, maxChars: 2_000 },
              '*/*',
            )
            // 404 也算连得上（对方回话了）；连不上 / 超时 / 被拦才算不通
            return got.ok || got.kind === 'http'
              ? { ok: true, message: '' }
              : { ok: false, message: got.message }
          },
        }),
    ...(net?.youtubeBase === undefined ? {} : { youtubeBase: net.youtubeBase }),
    ...(net?.thirdPartyBase === undefined ? {} : { thirdPartyBase: net.thirdPartyBase }),
  }
  const viewOf = async (deep: boolean): Promise<ReadRoutesView> => ({
    doctor: await runReadRoutesDoctor(ports, deep),
    settings: store.settings(),
    ...(account === undefined ? {} : { reddit_account: account.status() }),
  })
  return {
    store,
    ...(account === undefined ? {} : { account }),
    tools,
    view: () => viewOf(false),
    doctor: () => viewOf(true),
    async setSettings(patch) {
      const before = store.settings()
      const next = store.setSettings(patch)
      // 换了开法：正开着的那个浏览器关掉，下次按新的起
      if (before.reddit_browser_window !== next.reddit_browser_window) await browser?.close()
      return viewOf(false)
    },
    async openRedditLogin() {
      if (account === undefined)
        return { state: 'none', message: '这台机器没装本机只读浏览器（云上托管实例没有浏览器）。' }
      return account.openLogin()
    },
    async checkRedditAccount() {
      if (account === undefined)
        return { state: 'none', message: '这台机器没装本机只读浏览器（云上托管实例没有浏览器）。' }
      return account.check()
    },
    close: async () => {
      await account?.close()
    },
  }
}
