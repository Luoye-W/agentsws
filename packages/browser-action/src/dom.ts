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
 *
 * WP445（决策 1323）：选择器里可以有 ` || `：先按前一个找，**一个都没找到**再按后一个找（一律新版 Reddit，
 * 旧版 old.reddit 的选择器只作页面兜底——品牌号设了旧版界面、www 被跳到 old 时照样认得出框）。
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

const ALT_SPLIT = /\s+\|\|\s+/u

/** 选择器 → 全部匹配的元素（按文档顺序）。` || ` 分开的几个按顺序试，第一个找得到的为准。 */
export function resolveAll(doc: Document, selector: string): Element[] {
  const alts = selector.split(ALT_SPLIT)
  if (alts.length > 1) {
    for (const alt of alts) {
      const found = resolveAll(doc, alt)
      if (found.length > 0) return found
    }
    return []
  }
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
  // WP467：先聚焦再点（和人按下鼠标一样）——新版 Reddit 的「Join the conversation」只认聚焦才展开评论框
  try {
    ;(el as HTMLElement).focus?.()
  } catch {
    // 聚焦不了也照样点
  }
  ;(el as HTMLElement).click()
  return { ok: true }
}

/** WP467：把这一个滚到眼前（新版 Reddit 的评论按钮滚到看得见才长出来）。只滚，不点。回找没找到。 */
export function domReveal(doc: Document, selector: string): boolean {
  const el = resolveAll(doc, selector)[0]
  if (el === undefined) return false
  try {
    ;(el as HTMLElement).scrollIntoView?.({ block: 'center' })
  } catch {
    // 老页面不认参数：不滚也行
  }
  return true
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

/** 草稿 → 富文本框认的段落：每一行一段，空行不另起空段（编辑器把每个换行都当一段）。 */
export function editorParagraphs(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n')
}

const pause = (doc: Document, ms: number): Promise<void> =>
  new Promise((resolve) => (doc.defaultView ?? globalThis).setTimeout(resolve, ms))

function selectAllIn(doc: Document, el: HTMLElement): void {
  el.focus()
  const sel = doc.defaultView?.getSelection?.()
  if (sel === null || sel === undefined) return
  const range = doc.createRange()
  range.selectNodeContents(el)
  sel.removeAllRanges()
  sel.addRange(range)
}

function caretToEnd(doc: Document, el: HTMLElement): void {
  try {
    el.focus()
    const sel = doc.defaultView?.getSelection?.()
    if (sel === null || sel === undefined) return
    const range = doc.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  } catch {
    // 放不了光标也不要紧
  }
}

/** 框里的字和要填的一样吗（去掉标点空白比；编辑器把段落渲染成 `<p>`）。 */
const editorHas = (el: Element, want: string): boolean =>
  postedKey(el.textContent ?? '') === postedKey(want)

/** 等编辑器把字渲染出来（它在下一拍才改页面）。 */
async function settled(doc: Document, el: Element, want: string): Promise<boolean> {
  // 只有编辑器要等它下一拍渲染；普通可编辑块写了就是写了
  const tries = el.getAttribute('data-lexical-editor') === 'true' ? 12 : 1
  for (let i = 0; i < tries; i += 1) {
    if (editorHas(el, want)) return true
    await pause(doc, 120)
  }
  return editorHas(el, want)
}

/**
 * WP467：富文本框（新版 Reddit 的评论框是 Lexical 编辑器）——**按「粘贴」交给编辑器**：
 * 聚焦、全选（等一拍让编辑器同步选区，原来有字就整段换掉）、发一个带纯文字的粘贴事件，编辑器自己拆段落、
 * 自己更新状态，Reddit 的「Comment」按钮照常可点。编辑器不认粘贴就退回「按行输入文字」；
 * 普通的 contenteditable（不是编辑器）最后直接写字。都不认就照实说，交给人粘贴。
 * 真站 10-22 核过（公开帖子，只填不发）：直接 `insertText` 会把换行吃掉，粘贴不会。
 */
async function fillEditor(doc: Document, el: HTMLElement, value: string): Promise<boolean> {
  const text = editorParagraphs(value)
  const view = doc.defaultView as (Window & typeof globalThis) | null
  selectAllIn(doc, el)
  await pause(doc, 60)
  const DT = view?.DataTransfer
  const CE = view?.ClipboardEvent
  if (DT !== undefined && CE !== undefined) {
    try {
      const dt = new DT()
      dt.setData('text/plain', text)
      el.dispatchEvent(new CE('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    } catch {
      // 造不出粘贴事件：下面按行输入
    }
    if (await settled(doc, el, text)) return true
  }
  // 编辑器不认粘贴：全选、一行一行「输入文字」，行与行之间另起一段
  selectAllIn(doc, el)
  await pause(doc, 60)
  try {
    if (typeof doc.execCommand === 'function') {
      const lines = text.split('\n')
      for (const [i, line] of lines.entries()) {
        if (i > 0) doc.execCommand('insertParagraph', false)
        doc.execCommand('insertText', false, line)
      }
    }
  } catch {
    // 不认：下面再看
  }
  if (await settled(doc, el, text)) return true
  // 不是编辑器的普通可编辑块（本地假页面、老页面）：直接写字。编辑器上不这么做（会和它自己的状态打架）
  if (el.getAttribute('data-lexical-editor') !== 'true') {
    el.textContent = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  return false
}

/**
 * WP467：填一个框（插件页面脚本用这一个）。普通输入框与 {@link domFill} 一样；富文本框走
 * {@link fillEditor}（要等编辑器一拍，所以是异步的）。
 */
export async function domFillAsync(
  doc: Document,
  selector: string,
  value: string,
  options?: { highlight?: boolean },
): Promise<DomOpResult> {
  if (textField(doc, selector) !== undefined) return domFill(doc, selector, value, options)
  const el = resolveOne(doc, selector)
  if (el === undefined || el.getAttribute('contenteditable') !== 'true') return MISSING(selector)
  const ok = await fillEditor(doc, el as HTMLElement, value)
  if (!ok) return { ok: false, why: 'Reddit 的评论框没认我们填的字，可能改版了。' }
  // 填完：光标放在框里字的末尾（人接着改、接着点发送），描一圈并滚到眼前
  caretToEnd(doc, el as HTMLElement)
  if (options?.highlight === true) highlight(el)
  // 编辑器展开时页面还会动一下：等一拍再滚一次，保证看得见
  await pause(doc, 150)
  try {
    ;(el as HTMLElement).scrollIntoView?.({ block: 'center' })
  } catch {
    // 不滚也行
  }
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
  /** WP467：页面上标的发出时间（毫秒；新版 `created`、旧版 `data-timestamp`）。认「草稿出来之后才发的」用。 */
  created_ms?: number
}

/** 一条的发出时间（毫秒）。 */
function createdOf(item: Element): number | undefined {
  const iso = item.getAttribute('created')
  if (iso !== null) {
    const t = Date.parse(iso)
    if (Number.isFinite(t)) return t
  }
  const ms = Number(item.getAttribute('data-timestamp') ?? Number.NaN)
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
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

/**
 * WP467（10-22 真站核过）：用户装的网页翻译插件（如「沉浸式翻译」）会把译文**插进**评论正文里——读回「真发出去的字」
 * 时把这些插进来的节点去掉，只留页面原文。
 */
const TRANSLATION_NODES =
  '.immersive-translate-target-wrapper, [data-immersive-translate-translation-element-mark]'

function ownText(el: Element): string {
  if (el.querySelector(TRANSLATION_NODES) === null) return el.textContent ?? ''
  const copy = el.cloneNode(true) as Element
  for (const n of Array.from(copy.querySelectorAll(TRANSLATION_NODES))) n.remove()
  return copy.textContent ?? ''
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
    // WP445：` || `（新版 / 旧版兜底）在这里两边都算（页面上只会有一种）
    items = Array.from(doc.querySelectorAll(selector.split(ALT_SPLIT).join(', ')))
  } catch {
    return []
  }
  const out: PostedHit[] = []
  for (const item of items) {
    let part: Element | null = null
    try {
      part = item.querySelector(body.split(ALT_SPLIT).join(', '))
    } catch {
      part = null
    }
    const said = part === null ? '' : norm(ownText(part))
    const by = attrOf(item, ['data-author', 'author'])
    const textHit = part !== null && want !== '' && postedKey(said).includes(want)
    const authorHit =
      who !== undefined && who !== '' && by !== undefined && by.toLowerCase() === who
    if (!textHit && !authorHit) continue
    const fullname = fullnameOf(item)
    const permalink = attrOf(item, ['data-permalink', 'permalink'])
    const created_ms = createdOf(item)
    out.push({
      ...(created_ms === undefined ? {} : { created_ms }),
      ...(fullname === undefined ? {} : { fullname }),
      ...(permalink === undefined ? {} : { permalink }),
      ...(by === undefined ? {} : { author: by }),
      ...(said === '' ? {} : { text: said.slice(0, 10_000) }),
    })
  }
  return out
}
