/**
 * 打开外部链接（13 §5「原生增强经一个很小的桥接层，做特性检测，浏览器里自动退化」）。
 *
 * 工作台**不 import 任何 electron 东西**，也不依赖桌面壳这个包：这里只在运行时看一眼
 * `window.agentsws` 在不在。Electron 壳里走它的 `openExternal`（授权页开在系统浏览器里，
 * 不在应用窗口里，用户能看见地址栏），普通浏览器里就是一个新标签页。
 *
 * 凭据类的东西一概不走桥接——授权页是对方网站，密码只输在那边。
 */
interface DesktopBridgeLike {
  openExternal(url: string): Promise<boolean>
}

function bridge(): DesktopBridgeLike | undefined {
  const w = globalThis.window as unknown as { agentsws?: DesktopBridgeLike } | undefined
  return w?.agentsws
}

export function openExternal(url: string): void {
  const native = bridge()
  if (native !== undefined) {
    void native.openExternal(url)
    return
  }
  globalThis.window?.open(url, '_blank', 'noopener,noreferrer')
}
