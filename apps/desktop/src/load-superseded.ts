/**
 * 窗口 `loadURL` 被「更新的一次加载」顶掉时，Electron 用 ERR_ABORTED（-3）拒掉前一次。
 *
 * 首次启动时壳自己会开一次窗口，同时托盘 / 第二个实例 / 测试也可能叫一次 `openWorkstation`：
 * 后一次 `loadURL` 会让前一次报 -3。窗口最后照样落在要去的页面上，这不是错，别往外抛
 * （beta.7 发版时 Windows 安装冒烟就是被它卡住的）。别的加载错误照旧抛。
 */
export function isSupersededLoad(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as { code?: unknown; errno?: unknown; message?: unknown }
  if (e.code === 'ERR_ABORTED' || e.errno === -3) return true
  return typeof e.message === 'string' && /\(-3\) loading /u.test(e.message)
}
