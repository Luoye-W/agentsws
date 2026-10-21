/**
 * WP353（Luoye 10-16）：联网搜索**要人介入**的那一页——平时搜索在后台静默跑，第三栏不出现、不抢焦点；
 * 只有被 Google 人机验证拦下（或网站要登录）时，桌面壳把那一页交过来：第三栏「浏览器」自动打开，
 * 这里给出一块地方，壳把那一页挂上去，人自己点验证。**AI 不碰验证码**。人点过、离开验证页，壳自己收起。
 *
 * 只在桌面壳里有（`window.agentsws.searchBrowser`）；普通浏览器里这一块不出现。
 */
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useRailState } from '@/components/rail/rail-state'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'

/** 桌面壳给的那一页（形状与 `@agentsws/desktop/bridge` 的 `DesktopSearchHandover` 一致）。 */
export interface SearchHandover {
  workspace_id: string
  reason: 'captcha' | 'login' | 'consent'
  message: string
  url: string
}

interface SearchBridge {
  pending(): Promise<SearchHandover | null>
  onChange(listener: (h: SearchHandover | null) => void): () => void
  place(rect: { x: number; y: number; width: number; height: number } | null): Promise<boolean>
  dismiss(): Promise<boolean>
}

function bridge(): SearchBridge | undefined {
  const w = globalThis as { agentsws?: { searchBrowser?: SearchBridge } }
  return w.agentsws?.searchBrowser
}

/** 现在有没有要人介入的那一页（没有桌面壳 = 永远没有）。 */
export function useSearchHandover(): SearchHandover | null {
  const [handover, setHandover] = useState<SearchHandover | null>(null)
  useEffect(() => {
    const b = bridge()
    if (b === undefined) return
    let live = true
    // 先到的变化为准：开头那一问回来得晚，不能把刚推过来的那一页盖掉
    let changed = false
    void b.pending().then((h) => {
      if (live && !changed) setHandover(h)
    })
    const off = b.onChange((h) => {
      changed = true
      setHandover(h)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return handover
}

/** 有一页要人点时自动打开第三栏「浏览器」（挂在第三栏外壳上，平时什么都不做）。 */
export function useOpenBrowserOnHandover(): void {
  const handover = useSearchHandover()
  const rail = useRailState()
  const shown = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (handover === null) {
      shown.current = undefined
      return
    }
    if (shown.current === handover.url) return
    shown.current = handover.url
    rail.show('browser')
  }, [handover, rail])
}

/** 第三栏「浏览器」顶上那一块：一句话 + 那一页（壳挂上来）+「先不管了」。 */
export function SearchHandoverView(): ReactNode {
  const { t } = useApp()
  const handover = useSearchHandover()
  const slot = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const b = bridge()
    const el = slot.current
    if (b === undefined || handover === null || el === null) return
    const send = (): void => {
      const r = el.getBoundingClientRect()
      void b.place({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    send()
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(send)
    ro?.observe(el)
    globalThis.addEventListener?.('resize', send)
    return () => {
      ro?.disconnect()
      globalThis.removeEventListener?.('resize', send)
      void b.place(null)
    }
  }, [handover])

  if (handover === null) return null
  return (
    <section className="flex flex-col gap-2" data-testid="search-handover">
      <p className="text-xs font-medium text-ws-warn" data-testid="search-handover-message">
        {handover.message}
      </p>
      <div
        ref={slot}
        className="h-[420px] w-full rounded-md border border-border bg-muted"
        data-testid="search-handover-slot"
      />
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        data-testid="search-handover-dismiss"
        onClick={() => void bridge()?.dismiss()}
      >
        {t('rail.browser.handover.dismiss')}
      </Button>
    </section>
  )
}
