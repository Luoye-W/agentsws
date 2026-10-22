/**
 * service worker ↔ 广告后台页面脚本的消息（WP313）。
 *
 * 执行器在 service worker 里（换页之后页面脚本会被浏览器整个扔掉，步骤表走到哪儿得有人记着）；
 * 页面脚本只做「手」：认选择器、点、填、放文件、读字、看页面迹象，外加顶上那条横条。
 * 判断（白名单、指纹、不碰的区域、被拦就停）全在执行器里，页面脚本一条都不做。
 */

import {
  base64ToBytes,
  type DomOpResult,
  domClick,
  domCount,
  domFillAsync,
  domFindPosted,
  domLook,
  domPaste,
  domReveal,
  domSetFile,
  domText,
  type PageLook,
  type PostedHit,
} from '@agentsws/browser-action'

export type AdsDomRequest =
  | { type: 'ads-dom'; op: 'look' }
  | { type: 'ads-dom'; op: 'count' | 'text' | 'click'; selector: string }
  /** WP467：把这一个滚到眼前（新版 Reddit 的评论按钮行滚到看得见才长出来）。只滚不点。 */
  | { type: 'ads-dom'; op: 'reveal'; selector: string }
  | {
      type: 'ads-dom'
      op: 'fill' | 'paste'
      selector: string
      value: string
      /** WP432：填完描一圈、滚到眼前。 */
      highlight?: boolean
    }
  | { type: 'ads-dom'; op: 'file'; selector: string; name: string; mime: string; base64: string }
  /** WP329：认「人点发送之后新出现的那一条」（Reddit 写的读回）。 */
  | {
      type: 'ads-dom'
      op: 'find-posted'
      selector: string
      body: string
      text: string
      /** WP432：品牌号（人改了字再发也认得出）。 */
      author?: string
    }

export type AdsDomResponse = PageLook | DomOpResult | number | string | boolean | PostedHit[]

/** 横条上显示什么（`null` = 收起来）。 */
export interface BannerState {
  title: string
  step: number
  of: number
  label: string
  /** 有它就显示「确认提交 / 不提交」两个按钮。 */
  confirm?: string
  /** 截图那一下先把横条藏起来（截的是后台本身）。 */
  hidden?: boolean
  /**
   * WP445：Reddit / 社媒发帖这条路——插件只是把草稿填好、发送由人点，横条用中性色、说「草稿已填好，请检查后自己点发送」，
   * 不说「AI 正在操作」（广告那边真在操作的保持原样）。
   */
  assist?: boolean
}

export type AdsBannerRequest = { type: 'ads-banner'; state: BannerState | null }

/** 页面脚本 → service worker：横条上点了什么。 */
export type AdsBannerEvent = { type: 'ads-stop' } | { type: 'ads-confirm'; answer: 'yes' | 'no' }

/**
 * 页面脚本里真正干活的那一个（测试在 jsdom 里直接调）。WP467：填框要等编辑器一拍（新版 Reddit 的 Lexical），
 * 所以回的可能是 Promise。
 */
export function handleDomRequest(
  doc: Document,
  url: string,
  req: AdsDomRequest,
): AdsDomResponse | Promise<AdsDomResponse> {
  switch (req.op) {
    case 'look':
      return domLook(doc, url)
    case 'count':
      return domCount(doc, req.selector)
    case 'text':
      return domText(doc, req.selector)
    case 'click':
      return domClick(doc, req.selector)
    case 'reveal':
      return domReveal(doc, req.selector)
    case 'fill':
      return domFillAsync(
        doc,
        req.selector,
        req.value,
        req.highlight === true ? { highlight: true } : undefined,
      )
    case 'paste':
      return domPaste(doc, req.selector, req.value)
    case 'find-posted':
      return domFindPosted(doc, req.selector, req.body, req.text, req.author)
    case 'file':
      return domSetFile(doc, req.selector, {
        name: req.name,
        mime: req.mime,
        bytes: base64ToBytes(req.base64),
      })
  }
}
