/**
 * WP493（决策 1718）：**读页选路**——把 ego、插件（BrowserSkill）、内置浏览器排成一条链，对外还是同一个读页接口。
 *
 * 顺序跟浏览器设置走（`browser-settings.ts` 的 `readRoute()`）：
 * - 选了 ego（或没选过、默认 ego）且探得到 → **先 ego**；
 * - ego 没成（没装 / 没开 / 那一趟没跑完）→ 插件（装着才有）→ 内置浏览器（宿主给了才有）。
 *
 * 读回来的东西照原样交回，判登录墙 / 解析都在调用方（与老的读页口一样）；多一格 `via` 说是哪条路读的。
 */
import type { BrowserTextRead } from '@agentsws/brand-intake'
import type { OwnBrowserReader } from '../web-browser/own-browser.js'
import type { EgoPageReader } from './reader.js'

export type PageReadVia = 'ego' | 'plugin' | 'builtin'

type TextRead = Awaited<ReturnType<BrowserTextRead>>

/**
 * 读一页的结果——与 WP489 `@agentsws/kol-core` 的 `OnlinePageRead` 同形（集成时直接当它用），多一格 `via`。
 */
export interface ChainPageRead {
  ok: boolean
  final_url?: string
  html?: string
  text?: string
  password_inputs?: number
  message?: string
  via?: PageReadVia
}

export interface PageReadChainOptions {
  /** ego 读页口（能用才给；不给 / `available()` 为假 = 跳过）。 */
  ego(): Pick<EgoPageReader, 'available' | 'read' | 'page'> | undefined
  /** 插件那一口（装着才给）。 */
  plugin(): Pick<OwnBrowserReader, 'read'> | undefined
  /** 内置浏览器（宿主给；按「页面上的字」或原文读）。 */
  builtin?(url: string, as: 'page' | 'html'): Promise<ChainPageRead>
  log?(message: string, fields?: Record<string, unknown>): void
}

export interface PageReadChain {
  /** 这会儿会按什么顺序试。 */
  route(): PageReadVia[]
  /** 与插件那一口同形（`data` / `html`），多一格 `via`。 */
  read(url: string, kind: 'data' | 'html'): Promise<TextRead & { via?: PageReadVia }>
  /** WP489 的 `KolPageReader` 同形：`page` = 页面上的字，`html` = 原文。 */
  readPage(url: string, as: 'page' | 'html'): Promise<ChainPageRead>
}

export function createPageReadChain(options: PageReadChainOptions): PageReadChain {
  const ego = () => {
    const e = options.ego()
    return e?.available() ? e : undefined
  }
  const route = (): PageReadVia[] => [
    ...(ego() === undefined ? [] : (['ego'] as const)),
    ...(options.plugin() === undefined ? [] : (['plugin'] as const)),
    ...(options.builtin === undefined ? [] : (['builtin'] as const)),
  ]
  return {
    route,
    async read(url, kind) {
      const misses: string[] = []
      const e = ego()
      if (e !== undefined) {
        const got = await e.read(url, kind)
        if (got.ok) return { ...got, via: 'ego' }
        misses.push(got.message)
      }
      const p = options.plugin()
      if (p !== undefined) {
        const got = await p.read(url, kind)
        if (got.ok) return { ...got, via: 'plugin' }
        misses.push(got.message)
      }
      if (options.builtin !== undefined) {
        const got = await options.builtin(url, kind === 'html' ? 'html' : 'page')
        if (got.ok)
          return {
            ok: true,
            status: 0,
            final_url: got.final_url ?? url,
            text: got.html ?? got.text ?? '',
            via: 'builtin',
          }
        if (got.message !== undefined) misses.push(got.message)
      }
      if (misses.length > 0) options.log?.('读页这几条路都没成', { misses })
      return { ok: false, message: misses.at(-1) ?? '没有能用的浏览器' }
    },
    async readPage(url, as) {
      const misses: string[] = []
      const e = ego()
      if (e !== undefined) {
        const got = await e.page(url, { html: as === 'html' })
        if (got.ok)
          return {
            ok: true,
            final_url: got.page.final_url,
            text: got.page.text,
            ...(got.page.html === undefined ? {} : { html: got.page.html }),
            password_inputs: got.page.password_inputs,
            via: 'ego',
          }
        misses.push(got.message)
      }
      const p = options.plugin()
      if (p !== undefined) {
        const got = await p.read(url, 'html')
        if (got.ok) return { ok: true, final_url: got.final_url, html: got.text, via: 'plugin' }
        misses.push(got.message)
      }
      if (options.builtin !== undefined) {
        const got = await options.builtin(url, as)
        if (got.ok) return { ...got, via: 'builtin' }
        if (got.message !== undefined) misses.push(got.message)
      }
      return { ok: false, message: misses.at(-1) ?? '没有能用的浏览器' }
    },
  }
}
