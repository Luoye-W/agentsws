/**
 * 页面里那一半：认选择器、点、填、放文件、粘贴、读字、看页面迹象。
 *
 * 插件的页面脚本直接调这些（只碰 `document`，不碰 `chrome.*`），测试在 jsdom 里调同一份。
 *
 * 选择器 = CSS，可在末尾带 `>> text=…`：元素的文字（去首尾空白、压空白）要**完全等于**它。
 * 只认完全相等，不认「包含」：「暂停」与「暂停所有」差一个字就是两个按钮。
 */

import type { PageLook } from './walls.js'

const TEXT_SPLIT = /\s*>>\s*text=/u

function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/gu, ' ').trim()
}

/** 选择器 → 全部匹配的元素（按文档顺序）。 */
export function resolveAll(doc: Document, selector: string): Element[] {
  const [css, text] = selector.split(TEXT_SPLIT, 2)
  let found: Element[]
  try {
    found = Array.from(doc.querySelectorAll(css ?? ''))
  } catch {
    return []
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
  if (el instanceof view.HTMLInputElement || el instanceof view.HTMLTextAreaElement) return el
  return undefined
}

export function domFill(doc: Document, selector: string, value: string): DomOpResult {
  const el = textField(doc, selector)
  if (el === undefined) return MISSING(selector)
  el.focus()
  setNativeValue(el, value)
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
