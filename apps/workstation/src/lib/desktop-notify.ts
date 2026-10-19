/**
 * WP429：桌面壳的系统通知（13 §5 桥接层，特性检测；普通浏览器里没有就不弹——站内铃铛照常）。
 *
 * - `notify({ title, body, path })`：弹一条系统通知；新壳认 `path`，点了把窗口叫到前面、跳到那一页；
 * - `onNotificationClick(listener)`：新壳点了通知时把 `path` 交回来（旧壳没有这一项：只弹不跳）。
 */
export interface NotifyBridge {
  notify(input: { title: string; body?: string; path?: string }): Promise<boolean>
  onNotificationClick?(listener: (path: string) => void): () => void
}

export function notifyBridge(): NotifyBridge | undefined {
  const w = globalThis.window as unknown as { agentsws?: Partial<NotifyBridge> } | undefined
  const b = w?.agentsws
  if (b === undefined || typeof b.notify !== 'function') return undefined
  return b as NotifyBridge
}
