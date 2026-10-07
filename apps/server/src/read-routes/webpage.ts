/**
 * WP246：**网页转文字**——任意网址 → 干净正文 markdown。两级：
 *
 * 1. `local_extract`（零配置，默认）：本机取页面、本机抽正文（`@agentsws/brand-intake` 的 `htmlToReadable`），
 *    不经任何第三方；
 * 2. `third_party_reader`（**默认关**）：本机抽不出（多半是靠脚本现画的页面）时转给 Jina Reader。
 *    开了这一级，**网址会发给对方的服务器**——设置里、体检里、每次结果里都照实说。
 *
 * 内网 / 本机地址两级都不读（本机那一级拒了，也不会转给第三方）。
 */
import { htmlToReadable } from '@agentsws/brand-intake'
import type { ReadLevel } from '@agentsws/contracts'
import { getPublicPage, type PublicGetOptions } from './fetch.js'

/** 少于这么多字就算「本机抽不出正文」。 */
export const MIN_READABLE_CHARS = 200
export const JINA_READER_BASE = 'https://r.jina.ai'
const MAX_MARKDOWN = 40_000

export interface WebReadOptions extends PublicGetOptions {
  /** 第三方那一级开没开（设置里来，默认关）。 */
  thirdParty(): boolean
  /** 第三方服务的根（测试指向本地假站点）。 */
  thirdPartyBase?: string
}

export interface WebReadAttempt {
  level: ReadLevel
  ok: boolean
  message?: string
}

export interface WebReadResult {
  ok: boolean
  url: string
  final_url?: string
  title?: string
  markdown?: string
  chars?: number
  truncated?: boolean
  /** 最后成了的那一级。 */
  via?: ReadLevel
  attempts: WebReadAttempt[]
  /** 没成时一句人话；成了但经过第三方时也有一句。 */
  message?: string
}

const isHtml = (ct: string, body: string): boolean =>
  /html|xml/iu.test(ct) || (ct === '' && /^\s*</u.test(body))

async function viaThirdParty(
  options: WebReadOptions,
  url: string,
): Promise<{ ok: true; markdown: string; title?: string } | { ok: false; message: string }> {
  const base = options.thirdPartyBase ?? JINA_READER_BASE
  const got = await getPublicPage(
    `${base}/${url}`,
    options,
    'text/plain,text/markdown;q=0.9,*/*;q=0.5',
  )
  if (!got.ok) return { ok: false, message: `第三方转文字也没成：${got.message}` }
  const text = got.body.trim()
  if (text.length < 50) return { ok: false, message: '第三方转文字回来是空的。' }
  const title = /^Title:\s*(.+)$/mu.exec(text)?.[1]?.trim()
  // Jina 的回包前几行是「Title: / URL Source: / Markdown Content:」，正文在后面
  const body = text.includes('Markdown Content:')
    ? text.slice(text.indexOf('Markdown Content:') + 17).trim()
    : text
  return {
    ok: true,
    markdown: body.slice(0, MAX_MARKDOWN),
    ...(title === undefined ? {} : { title }),
  }
}

/** 读一个网页的正文。永不抛。 */
export async function readWebpage(
  options: WebReadOptions,
  input: { url: string },
): Promise<WebReadResult> {
  const url = input.url.trim()
  const attempts: WebReadAttempt[] = []
  const page = await getPublicPage(url, options)
  let localWhy: string
  if (page.ok) {
    if (isHtml(page.contentType, page.body)) {
      const r = htmlToReadable(page.body, page.url, MAX_MARKDOWN)
      if (r.chars >= MIN_READABLE_CHARS) {
        attempts.push({ level: 'local_extract', ok: true })
        return {
          ok: true,
          url,
          final_url: page.url,
          ...(r.title === undefined ? {} : { title: r.title }),
          markdown: r.markdown,
          chars: r.chars,
          truncated: r.truncated,
          via: 'local_extract',
          attempts,
        }
      }
      localWhy = '本机抽不出正文（页面多半是靠脚本现画的，或者正文很短）'
    } else if (/^text\/(plain|markdown)/iu.test(page.contentType)) {
      attempts.push({ level: 'local_extract', ok: true })
      const md = page.body.slice(0, MAX_MARKDOWN)
      return {
        ok: true,
        url,
        final_url: page.url,
        markdown: md,
        chars: md.length,
        truncated: page.body.length > MAX_MARKDOWN,
        via: 'local_extract',
        attempts,
      }
    } else {
      localWhy = `这不是网页（${page.contentType.split(';')[0] || '未知类型'}），本机这一级只读网页`
    }
  } else {
    localWhy = page.message
    // 地址本身不能读（内网 / 不是网址）：不转给第三方
    if (page.kind === 'bad_url' || page.kind === 'blocked_host') {
      attempts.push({ level: 'local_extract', ok: false, message: localWhy })
      return { ok: false, url, attempts, message: localWhy }
    }
  }
  attempts.push({ level: 'local_extract', ok: false, message: localWhy })
  if (!options.thirdParty()) {
    attempts.push({ level: 'third_party_reader', ok: false, message: '第三方转文字没开（默认关）' })
    return {
      ok: false,
      url,
      attempts,
      message: `${localWhy}。第三方转文字没开（默认关；在连接页「取数路线」可以打开，开了网址会经过 Jina Reader）。`,
    }
  }
  const third = await viaThirdParty(options, url)
  if (!third.ok) {
    attempts.push({ level: 'third_party_reader', ok: false, message: third.message })
    return { ok: false, url, attempts, message: `${localWhy}；${third.message}` }
  }
  attempts.push({ level: 'third_party_reader', ok: true })
  return {
    ok: true,
    url,
    ...(third.title === undefined ? {} : { title: third.title }),
    markdown: third.markdown,
    chars: third.markdown.length,
    truncated: third.markdown.length >= MAX_MARKDOWN,
    via: 'third_party_reader',
    attempts,
    message: '本机抽不出，这次经过了第三方（Jina Reader）转文字：网址发给了对方的服务器。',
  }
}
