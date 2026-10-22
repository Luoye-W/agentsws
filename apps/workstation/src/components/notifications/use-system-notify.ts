/**
 * WP429：新来的通知怎么处理（铃铛每次问回来一份「未读」都过一遍）。
 *
 * - 头一次拿到的那一份只当底（打开应用之前来的都在铃铛里，不一口气弹一串）；
 * - 之后新来的（或同一件事又来了一次）：**正看着那一页**（窗口在前台）→ 直接算已读、不弹；
 *   否则类别开了「系统」的 → 桌面版弹一条系统通知（普通浏览器里没有就不弹）；
 * - 新壳点了系统通知 → 窗口叫到前面、跳到那一页（`onNotificationClick`）。
 */
import { useEffect, useRef } from 'react'
import type { InboxNotification } from '@/lib/api-notifications'
import { notifyBridge } from '@/lib/desktop-notify'

/** 系统通知的标题（正文是那一行字）。 */
export const SYSTEM_NOTIFY_TITLE = 'Agents 工坊'

/** 地址是不是这一页（只比路径，不看 `?` 与 `#`）。 */
export function isSamePage(href: string, pathname: string): boolean {
  // WP475：`?feedback=mine` 打开的是反馈框（盖在任何一页上），不是一页——人在首页也不能当「看过了」
  if (/[?&]feedback=/.test(href)) return false
  const path = href.split(/[?#]/)[0] ?? href
  return path === pathname
}

function windowInFront(): boolean {
  const d = globalThis.document
  if (d === undefined) return false
  if (d.visibilityState !== 'visible') return false
  return typeof d.hasFocus === 'function' ? d.hasFocus() : true
}

export function useSystemNotify(
  items: readonly InboxNotification[] | undefined,
  options: {
    pathname: string
    onSeenHere: (ids: string[]) => void
    onOpen: (path: string) => void
  },
): void {
  const seen = useRef<Map<string, string> | undefined>(undefined)
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    const off = notifyBridge()?.onNotificationClick?.((path) => {
      if (path.startsWith('/')) latest.current.onOpen(path)
    })
    return () => {
      off?.()
    }
  }, [])

  useEffect(() => {
    if (items === undefined) return
    const first = seen.current === undefined
    const map = seen.current ?? new Map<string, string>()
    const here: string[] = []
    const pop: InboxNotification[] = []
    for (const n of items) {
      const prev = map.get(n.id)
      map.set(n.id, n.updated_at)
      if (first || prev === n.updated_at) continue
      if (n.href !== undefined && isSamePage(n.href, latest.current.pathname) && windowInFront()) {
        here.push(n.id)
        continue
      }
      if (n.system) pop.push(n)
    }
    seen.current = map
    if (here.length > 0) latest.current.onSeenHere(here)
    const bridge = notifyBridge()
    if (bridge === undefined) return
    for (const n of pop)
      void bridge
        .notify({
          title: SYSTEM_NOTIFY_TITLE,
          body: n.text,
          ...(n.href === undefined ? {} : { path: n.href }),
        })
        .catch(() => false)
  }, [items])
}
