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
  domFill,
  domFindPosted,
  domLook,
  domPaste,
  domSetFile,
  domText,
  type PageLook,
  type PostedHit,
} from '@agentsws/browser-action'

export type AdsDomRequest =
  | { type: 'ads-dom'; op: 'look' }
  | { type: 'ads-dom'; op: 'count' | 'text' | 'click'; selector: string }
  | { type: 'ads-dom'; op: 'fill' | 'paste'; selector: string; value: string }
  | { type: 'ads-dom'; op: 'file'; selector: string; name: string; mime: string; base64: string }
  /** WP329：认「人点发送之后新出现的那一条」（Reddit 写的读回）。 */
  | { type: 'ads-dom'; op: 'find-posted'; selector: string; body: string; text: string }

export type AdsDomResponse = PageLook | DomOpResult | number | string | PostedHit[]

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
}

export type AdsBannerRequest = { type: 'ads-banner'; state: BannerState | null }

/** 页面脚本 → service worker：横条上点了什么。 */
export type AdsBannerEvent = { type: 'ads-stop' } | { type: 'ads-confirm'; answer: 'yes' | 'no' }

/** 页面脚本里真正干活的那一个（测试在 jsdom 里直接调）。 */
export function handleDomRequest(doc: Document, url: string, req: AdsDomRequest): AdsDomResponse {
  switch (req.op) {
    case 'look':
      return domLook(doc, url)
    case 'count':
      return domCount(doc, req.selector)
    case 'text':
      return domText(doc, req.selector)
    case 'click':
      return domClick(doc, req.selector)
    case 'fill':
      return domFill(doc, req.selector, req.value)
    case 'paste':
      return domPaste(doc, req.selector, req.value)
    case 'find-posted':
      return domFindPosted(doc, req.selector, req.body, req.text)
    case 'file':
      return domSetFile(doc, req.selector, {
        name: req.name,
        mime: req.mime,
        bytes: base64ToBytes(req.base64),
      })
  }
}
