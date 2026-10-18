/**
 * WP420（自查 ads-amazon B1）：Listing 体检的**取数链**——以前只走内置浏览器，国内 IP / 走代理的机器一打开
 * Amazon 就弹人机验证，体检就停 24 小时，没有备用路。现在照竞品读数那条链（WP402）：
 *
 * 1. 内置浏览器（没在被拦后的暂停里才用）；
 * 2. 被拦 / 暂停 / 额度满了 → **你自己的浏览器**（插件；第一次先出卡问同意；每个 ASIN 每天至多一次）；
 * 3. 都不行 → 照实说：「Amazon 要人机验证，内置浏览器停到几点；同意用你的浏览器读就能接着体检」。
 *
 * 工坊云端（`amazon.product`）**不进这条链**：它只回标题 / 价格 / 评分几格，体检要整页（五点、图、A+、卖家……），
 * 拿几格去判会把没读到的当成「没写」，判出一堆假问题。
 */

import type { AmazonOwnBrowser } from '../amazon-front/own-browser.js'
import type { AmazonFrontReader } from '../amazon-front/reader.js'
import type { AmazonListingReader, ListingPageRead } from './reader.js'

export interface ListingChainDeps {
  front(): AmazonFrontReader | undefined
  own(): AmazonOwnBrowser | undefined
  /** 品牌时区（「停到几点」那句用）。 */
  tzOffsetMinutes(): number
}

const hhmm = (ms: number, tz: number): string =>
  new Date(ms + tz * 60_000).toISOString().slice(11, 16)

/** 内置浏览器读不了时那一句（带「停到几点」）。 */
export function frontStoppedMessage(pausedUntil: number | undefined, tz: number): string {
  return pausedUntil === undefined
    ? 'Amazon 出了验证页，内置浏览器这一轮停了（不过验证码、不重试）。'
    : `Amazon 要人机验证，内置浏览器先停到 ${hhmm(pausedUntil, tz)}（不过验证码、不重试）。`
}

export function createListingChain(deps: ListingChainDeps): AmazonListingReader | undefined {
  const front = deps.front()
  const own = deps.own()
  if (front === undefined && own?.available() !== true) return undefined
  const viaOwn = async (
    input: { marketplace: string; asin: string },
    why: string,
  ): Promise<ListingPageRead> => {
    const route = own?.available() === true ? own.rawProduct : undefined
    if (own === undefined || route === undefined)
      return {
        status: 'blocked',
        url: '',
        message: `${why}装好插件、同意之后可以用你自己的浏览器读。`,
      }
    const r = await route(`listing:${input.asin.trim().toUpperCase()}`, input)
    if (r.status === 'ok') return r
    if (r.status === 'needs_consent') {
      void own.needConsent()
      return {
        status: 'blocked',
        url: '',
        message: `${why}已出一张卡问你：同意用你自己的浏览器读，体检就能接着做。`,
      }
    }
    if (r.status === 'limited')
      return {
        status: 'blocked',
        url: '',
        message: `${why}今天已经用你的浏览器读过这一款了，明天再试。`,
      }
    const message = 'message' in r ? r.message : '没读成'
    return r.status === 'blocked'
      ? { status: 'blocked', url: '', message: `${why}${message}。` }
      : { status: 'failed', url: '', message }
  }
  return {
    async readProduct(input) {
      const tz = deps.tzOffsetMinutes()
      if (front?.ready()) {
        const got = await front.readProduct(input)
        if (got.status === 'ok' || got.status === 'failed') return got
        // 被拦 / 额度满了：换你自己的浏览器
        return viaOwn(
          input,
          got.status === 'quota'
            ? '内置浏览器这一小时的额度用完了；'
            : frontStoppedMessage(front.pausedUntil(), tz),
        )
      }
      return viaOwn(
        input,
        front === undefined ? '这台没有内置浏览器；' : frontStoppedMessage(front.pausedUntil(), tz),
      )
    },
    ...(front === undefined
      ? {}
      : {
          search: (input: { marketplace: string; query: string }) => front.search(input),
        }),
  }
}
