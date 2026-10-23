/**
 * WP485（决策 1672）：第三栏是**浮层**时（浏览器里、桌面窗口最大化 / 右边没地方，见 WP481），中栏不再被一层透明的底整块挡住。
 *
 * - 点中栏里能点的东西（收件箱的行、看板 / 卡片流里的项、按钮、链接……）照常生效：会开第三栏的，第三栏直接换成那一件；
 *   不开第三栏的普通按钮，浮层保持不收。
 * - 点中栏**空白处**（不是能点的东西）→ 收起浮层。Esc 收起另在宿主里管。
 * - 并排（桌面加宽）时不挂这一套。
 *
 * 「能点的东西」= 按钮、链接、输入框、带交互角色的元素，或者鼠标放上去是小手的地方（`cursor: pointer`，整行可点的那种 div）。
 * 点在空白处、但那一下其实开了 / 换了第三栏（少数没写成按钮的可点区域）也不收：点完看一眼第三栏变没变。
 */
import { type RefObject, useEffect, useRef } from 'react'

/** 能点的东西：点到它（或它里面）不算「点空白处」。 */
const INTERACTIVE = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  'video',
  'audio',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="combobox"]',
  '[role="treeitem"]',
  '.cursor-pointer',
].join(', ')

/** 浮在页面上的别的层（弹窗、菜单、下拉、看板「看一眼」）：点在里面跟第三栏无关。 */
const LAYERS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-radix-popper-content-wrapper]',
  '[data-testid="rail-board-peek"]',
].join(', ')

/** 这一下点的是不是「能点的东西」。 */
export function isInteractiveTarget(target: Element): boolean {
  if (target.closest(INTERACTIVE) != null) return true
  // 整行可点、但没写成按钮的地方：鼠标是小手（`cursor` 会继承，看点到的那个元素就够）
  const view = target.ownerDocument?.defaultView
  const cursor = view?.getComputedStyle?.(target).cursor
  return cursor === 'pointer'
}

/**
 * 浮层开着时挂上：点浮层外面的空白处收起（`onDismiss`）。
 *
 * - `frame`：浮层那一格（点在里面、或从里面按下拖出来——拖宽把手——都不算）。
 * - `openKey`：第三栏现在开的是哪一件；点空白处之后它变了 = 那一下其实开了别的，不收。
 * - 浮层顶边以上（顶栏）不管，跟原来那层透明底一样只管顶栏以下。
 */
export function useOverlayOutsideClick({
  enabled,
  frame,
  openKey,
  onDismiss,
}: {
  enabled: boolean
  frame: RefObject<HTMLElement | null>
  openKey: string
  onDismiss: () => void
}): void {
  const key = useRef(openKey)
  key.current = openKey
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => {
    if (!enabled) return
    const doc = globalThis.document
    if (doc === undefined) return
    let down: Node | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const onDown = (e: Event): void => {
      down = e.target instanceof Node ? e.target : null
    }
    const onClick = (e: MouseEvent): void => {
      const from = down
      down = null
      if (e.button !== 0) return
      const box = frame.current
      const target = e.target
      if (box == null || !(target instanceof Element)) return
      if (box.contains(target) || (from !== null && box.contains(from))) return
      // 按下和松开不在同一处（拖着选字、拖宽把手）：不算点
      if (from !== null && from !== target) return
      if (e.clientY < box.getBoundingClientRect().top) return
      if (target.closest(LAYERS) != null) return
      if (doc.querySelector('[aria-modal="true"]') != null) return
      if (isInteractiveTarget(target)) return
      // 刚拖着选了一段字：不收
      const selection = globalThis.getSelection?.()
      if (selection != null && !selection.isCollapsed && selection.toString().trim() !== '') return
      const before = key.current
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (key.current === before) dismiss.current()
      }, 0)
    }
    doc.addEventListener('pointerdown', onDown, true)
    doc.addEventListener('click', onClick, true)
    return () => {
      clearTimeout(timer)
      doc.removeEventListener('pointerdown', onDown, true)
      doc.removeEventListener('click', onClick, true)
    }
  }, [enabled, frame])
}
