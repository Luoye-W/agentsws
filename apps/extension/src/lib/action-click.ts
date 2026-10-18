/**
 * WP413（T-INMO 10-18 #4、R1 决策 a）：点工具栏上的插件图标做什么。
 *
 * - 执行器正在这个标签页上等截图授权 → 这一下就是授权（WP313），别的都不做；
 * - 在 YouTube / Instagram / TikTok 页面上 → 照旧开 / 关页面上那块红人面板（要一边看主页一边看体检）；
 * - 别的页面 → 打开 Chrome 侧边栏（进度 / 要你处理 / 记录），换标签页也不消失。
 *   `chrome.sidePanel.open` 只认用户手势，所以必须在点击回调里**同步**调，不能先 await 别的；
 *   打不开（老 Chrome 没有侧边栏）退回打开设置页。
 */

/** 有红人面板的三个平台。 */
export const KOL_HOSTS = ['youtube.com', 'instagram.com', 'tiktok.com'] as const

export function isKolPage(url: string | undefined): boolean {
  if (url === undefined || url === '') return false
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  return KOL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

export interface ActionClickDeps {
  /** WP313：执行器在等这个标签页的截图授权——回 true 表示这一下被它用掉了。 */
  noteActionClick(tabId: number): boolean
  /** 让页面上的红人面板开 / 关。 */
  togglePanel(tabId: number): Promise<unknown>
  /** 打开这个窗口的侧边栏（要在用户手势里同步调）。 */
  openSidePanel(windowId: number): Promise<unknown>
  openOptions(): void
}

export type ActionClickOutcome = 'capture' | 'kol' | 'side' | 'options'

export function onActionClick(
  tab: { id?: number | undefined; windowId?: number | undefined; url?: string | undefined },
  deps: ActionClickDeps,
): ActionClickOutcome {
  if (tab.id !== undefined && deps.noteActionClick(tab.id)) return 'capture'
  if (tab.id !== undefined && isKolPage(tab.url)) {
    void deps.togglePanel(tab.id).catch(() => deps.openOptions())
    return 'kol'
  }
  if (tab.windowId === undefined) {
    deps.openOptions()
    return 'options'
  }
  void deps.openSidePanel(tab.windowId).catch(() => deps.openOptions())
  return 'side'
}
