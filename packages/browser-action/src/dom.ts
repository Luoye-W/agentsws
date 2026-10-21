/**
 * 页面里那一半：认选择器、点、填、放文件、粘贴、读字、看页面迹象。
 *
 * 插件的页面脚本直接调这些（只碰 `document`，不碰 `chrome.*`），测试在 jsdom 里调同一份。
 *
 * 选择器 = CSS，可在末尾带 `>> text=…`：元素的文字（去首尾空白、压空白）要**完全等于**它。
 * 只认完全相等，不认「包含」：「暂停」与「暂停所有」差一个字就是两个按钮。
 *
 * WP432：选择器里可以有 ` >>> `：前一段找到的组件，**进它的 shadow root** 里再找后一段（新版 Reddit 的
 * 标题框长在 `faceplate-textarea-input` 的 shadow root 里）。没有 shadow root 就在它自己里面找。
 */

import type { PageLook } from './walls.js'

const TEXT_SPLIT = /\s*>>\s*text=/u

function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/gu, ' ').trim()
}

const SHADOW_SPLIT = /\s+>>>\s+/u

/** 一段 CSS 在这些根里找（进 shadow root 用）。写错了回空，不抛。 */
function queryIn(roots: readonly ParentNode[], css: string): Element[] {
  const out: Element[] = []
  for (const root of roots) {
    try {
      out.push(...Array.from(root.querySelectorAll(css)))
    } catch {
      return []
    }
  }
  return out
}

/** 选择器 → 全部匹配的元素（按文档顺序）。 */
export function resolveAll(doc: Document, selector: string): Element[] {
  const [css, text] = selector.split(TEXT_SPLIT, 2)
  const hops = (css ?? '').split(SHADOW_SPLIT)
  let found: Element[] = queryIn([doc], hops[0] ?? '')
  for (const hop of hops.slice(1)) {
    const roots = found.map((el) => (el.shadowRoot ?? el) as ParentNode)
    found = queryIn(roots, hop)
  }
  if (text === undefined) return found
  const want = norm(text)
  return found.filter((el) => norm(el.textContent) === want)
}

/** 选择器 → **唯一**那一个。零个或多个都回 `undefined`：点之前对不上就不点。 */
export function resolveOne(doc: Document, selector: string): Element | undefined {
  const all = resolveAll(doc, selector)
  return all.length === 1 ? all[0] : undefined
}

function visible(el: Element): boolean {
  if (el.closest('[hidden],[aria-hidden="true"]') !== null) return false
  if (el.getAttribute('aria-disabled') === 'true') return false
  return (el as HTMLButtonElement).disabled !== true
}

export type DomOpResult = { ok: true } | { ok: false; why: string }

const MISSING = (selector: string): DomOpResult => ({
  ok: false,
  why: `页面上找不到要点的那一个（或者有好几个对得上）：${selector}`,
})

export function domClick(doc: Document, selector: string): DomOpResult {
  const el = resolveOne(doc, selector)
  if (el === undefined) return MISSING(selector)
  if (!visible(el)) return { ok: false, why: '那个按钮现在点不了（被隐藏或是灰的）。' }
  ;(el as HTMLElement).click()
  return { ok: true }
}

/** 用原生 setter 写值再发 input / change：React 一类的页面只认这样改的值。 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter !== undefined) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function textField(
  doc: Document,
  selector: string,
): HTMLInputElement | HTMLTextAreaElement | undefined {
  const el = resolveOne(doc, selector)
  const view = doc.defaultView
  if (el === undefined || view === null) return undefined
  if (
    el instanceof view.HTMLInputElement ||
    el instanceof view.HTMLTextAreaElement ||
    // shadow root 里的元素：跨 realm 的 instanceof 也可能对不上，按标签名认
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'INPUT'
  )
    return el as HTMLInputElement | HTMLTextAreaElement
  return undefined
}

/** WP432：填好的框描一圈（人一眼看到填在哪）。只改这个框的样式，不碰别的。 */
export const FILL_HIGHLIGHT = '3px solid #f59e0b'

function highlight(el: Element): void {
  const h = el as HTMLElement
  h.style.outline = FILL_HIGHLIGHT
  h.style.outlineOffset = '2px'
  h.setAttribute('data-agentsws-filled', '1')
  try {
    h.scrollIntoView?.({ block: 'center' })
  } catch {
    // 老页面不认参数：不滚也行
  }
}

/**
 * WP432：富文本编辑框（新版 Reddit 的评论框是 contenteditable）——聚焦、全选、按「输入文字」写进去
 * （编辑器认 `insertText`，和人打字走同一条路）；浏览器不认就直接写字再发一个 input。
 */
function fillEditable(doc: Document, el: HTMLElement, value: string): void {
  el.focus()
  const sel = doc.defaultView?.getSelection?.()
  if (sel !== null && sel !== undefined) {
    const range = doc.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  let done = false
  try {
    done = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, value)
  } catch {
    done = false
  }
  if (!done || (el.textContent ?? '').trim() === '') {
    el.textContent = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

export function domFill(
  doc: Document,
  selector: string,
  value: string,
  options?: { highlight?: boolean },
): DomOpResult {
  const field = textField(doc, selector)
  if (field !== undefined) {
    field.focus()
    setNativeValue(field, value)
    if (options?.highlight === true) highlight(field)
    return { ok: true }
  }
  const el = resolveOne(doc, selector)
  if (el === undefined || el.getAttribute('contenteditable') !== 'true') return MISSING(selector)
  fillEditable(doc, el as HTMLElement, value)
  if (options?.highlight === true) highlight(el)
  return { ok: true }
}

/** 粘贴整段文字（Meta 导入框）。与 fill 一样写值，再补一个 paste 事件给认它的页面。 */
export function domPaste(doc: Document, selector: string, text: string): DomOpResult {
  const el = textField(doc, selector)
  if (el === undefined) return MISSING(selector)
  el.focus()
  setNativeValue(el, text)
  return { ok: true }
}

/** 把一份文件放进 `<input type=file>`（DataTransfer 做法；两家后台能不能认，真站首跑时核）。 */
export function domSetFile(
  doc: Document,
  selector: string,
  file: { name: string; mime: string; bytes: Uint8Array },
): DomOpResult {
  const el = resolveOne(doc, selector)
  const view = doc.defaultView
  if (
    el === undefined ||
    view === null ||
    !(el instanceof view.HTMLInputElement) ||
    el.type !== 'file'
  )
    return MISSING(selector)
  const copy = new Uint8Array(file.bytes.byteLength)
  copy.set(file.bytes)
  const f = new view.File([copy], file.name, { type: file.mime })
  const DT = (view as unknown as { DataTransfer?: typeof DataTransfer }).DataTransfer
  if (DT !== undefined) {
    const dt = new DT()
    dt.items.add(f)
    el.files = dt.files
  } else {
    // jsdom 没有 DataTransfer：直接把 files 换成一个只读列表（只为测试走得通）
    Object.defineProperty(el, 'files', { configurable: true, value: [f] })
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
}

export function domText(doc: Document, selector: string): string {
  return resolveAll(doc, selector)
    .map((el) => norm(el.textContent))
    .join('\n')
}

export function domCount(doc: Document, selector: string): number {
  return resolveAll(doc, selector).length
}

/** 页面迹象（认验证码 / 登录 / 被限）。只取开头一截字，不整页抄。 */
export function domLook(doc: Document, url: string): PageLook {
  const frames = Array.from(doc.querySelectorAll('iframe[src],script[src]'))
    .map((el) => el.getAttribute('src') ?? '')
    .slice(0, 50)
  return {
    url,
    title: doc.title,
    text: norm(doc.body?.textContent).slice(0, 2_000),
    frameSources: frames,
    passwordInputs: doc.querySelectorAll('input[type="password"]').length,
  }
}

/** WP329：页面上认出来的「发出去的那一条」。 */
export interface PostedHit {
  /** `t1_…`（评论）/ `t3_…`（帖子）。 */
  fullname?: string
  /** 站内相对链接（`/r/x/comments/…`）。 */
  permalink?: string
  /** WP432：谁发的（页面上标的用户名）。 */
  author?: string
  /** WP432：页面上它的正文（读回人真发出去的字；外部文本，只当文字）。 */
  text?: string
}

/**
 * 比对用的键：只留字母和数字、转小写。Reddit 会把 Markdown 渲染掉（`**粗**`、`[字](链接)`、换行变段落），
 * 页面上的字和草稿原文不会一字不差；去掉符号与空白之后再比「包含」，渲染前后才对得上。
 */
export function postedKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * 草稿 → 用来认「发出去的那一条」的那一截：去掉 Markdown 记号，取第一段非空的字，最多 80 个字母数字。
 * 太短（少于 4 个）就整段用（一句「谢谢」也认得出来）。
 */
export function sentSnippet(draft: string): string {
  const plain = draft
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[*_~`>#|]/gu, ' ')
    .split(/\n\s*\n|\n/u)
    .map((line) => postedKey(line))
    .find((line) => line !== '')
  const key = plain ?? postedKey(draft)
  return key.slice(0, 80)
}

const THING = /^t[13]_[a-z0-9]+$/u

/** 一条的编号：old.reddit 的 `data-fullname`、新版评论的 `thingid`、新版帖子的 `id`。 */
function fullnameOf(item: Element): string | undefined {
  for (const a of ['data-fullname', 'thingid', 'id']) {
    const v = item.getAttribute(a)
    if (v !== null && THING.test(v)) return v
  }
  return undefined
}

const attrOf = (item: Element, names: readonly string[]): string | undefined => {
  for (const a of names) {
    const v = item.getAttribute(a)
    if (v !== null && v !== '') return v
  }
  return undefined
}

/**
 * 找页面上「发出去的那一条」的候选（插件的页面脚本调；`body` 相对每一条自己）：正文含这段字的；
 * WP432：给了 `author`（品牌号）时，这个号发的也算（人在页面上改了字再发）。
 * 回它们的编号、链接、作者与正文（old.reddit 带 `data-fullname` / `data-permalink` / `data-author`，
 * 新版带 `thingid` / `permalink` / `author`）。
 */
export function domFindPosted(
  doc: Document,
  selector: string,
  body: string,
  text: string,
  author?: string,
): PostedHit[] {
  const want = sentSnippet(text)
  const who = author?.trim().toLowerCase()
  if (want === '' && (who === undefined || who === '')) return []
  let items: Element[]
  try {
    items = Array.from(doc.querySelectorAll(selector))
  } catch {
    return []
  }
  const out: PostedHit[] = []
  for (const item of items) {
    let part: Element | null = null
    try {
      part = item.querySelector(body)
    } catch {
      part = null
    }
    const said = part === null ? '' : norm(part.textContent)
    const by = attrOf(item, ['data-author', 'author'])
    const textHit = part !== null && want !== '' && postedKey(said).includes(want)
    const authorHit =
      who !== undefined && who !== '' && by !== undefined && by.toLowerCase() === who
    if (!textHit && !authorHit) continue
    const fullname = fullnameOf(item)
    const permalink = attrOf(item, ['data-permalink', 'permalink'])
    out.push({
      ...(fullname === undefined ? {} : { fullname }),
      ...(permalink === undefined ? {} : { permalink }),
      ...(by === undefined ? {} : { author: by }),
      ...(said === '' ? {} : { text: said.slice(0, 10_000) }),
    })
  }
  return out
}
