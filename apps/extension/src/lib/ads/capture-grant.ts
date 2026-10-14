/**
 * 截图授权（WP313 实测出来的）：`captureVisibleTab` **只凭站点权限截不了**，要么 `<all_urls>`，
 * 要么 `activeTab`——而 `activeTab` 只在用户「调用插件」时给（点工具栏图标 / 快捷键 / 右键菜单），
 * 页面里横条上的点击**不算**（docs/101 §1.4 原来的设想在这一点上不成立）。
 *
 * 所以截不到时：横条上请用户点一下右上角的插件图标，图标被点 = 这个标签页拿到 `activeTab`，再截一次。
 * 这里只是一个「谁在等哪个标签页被点」的登记处，background 的 `action.onClicked` 来敲。
 */

const waiting = new Map<number, () => void>()

/** 等这个标签页上的插件图标被点一下。点了回 true，超时回 false。 */
export function waitForActionClick(tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(tabId)
      resolve(false)
    }, timeoutMs)
    waiting.set(tabId, () => {
      clearTimeout(timer)
      waiting.delete(tabId)
      resolve(true)
    })
  })
}

/** 工具栏图标被点了（background 调）。回「是不是有人在等它」。 */
export function noteActionClick(tabId: number): boolean {
  const hit = waiting.get(tabId)
  if (hit === undefined) return false
  hit()
  return true
}
