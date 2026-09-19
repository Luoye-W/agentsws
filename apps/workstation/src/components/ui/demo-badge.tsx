/**
 * WP125（72 §3 的 07-28 那一条「引以为戒」/ 本单交付 4）：**「演示数据」标记**。
 *
 * KefuAgent 在 2026-07-28 栽过一个 P0：生产后台把演示假数据当真实数据显示。
 * 工坊的 `agentsws demo` 跑的是同一套界面、同一条路由，只是背后换成了合成世界
 * （`packages/simulation/src/world.ts`）——同样的坑就在前面。
 *
 * 所以这个标记有两条要求，缺一不可：
 *
 * 1. **不显眼**。它不是横幅、不是弹窗、不遮任何东西——演示的时候它不该抢镜头；
 * 2. **始终在**。它不能被关掉、不随路由消失、不等某个请求回来才出现。
 *    一个"可以关掉的真实性提示"等于没有。
 *
 * 判据来自服务进程自己（`/app/bootstrap.json` 的 `demo`，由 `mount !== undefined`
 * 算出来，也就是"这个进程挂了合成世界"）——**不看前端的任何开关或环境变量**，
 * 那些是声明，而声明对"这些数字是不是真的"一文不值。
 *
 * 反过来的那一半（真实工作区里绝不出现合成数据）由服务进程保证：所有
 * `seedDemo*` 都写成 `if (mount !== undefined)`，一个都不例外。
 */
import { type ReactNode, useEffect, useState } from 'react'
import { bootstrapHint } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 整个前端只问一次：它在一次会话里不会变（换了就是换了个进程）。 */
let asked: Promise<boolean> | undefined

function isDemo(): Promise<boolean> {
  asked ??= bootstrapHint()
    .then((config) => config.demo === true)
    .catch(() => false)
  return asked
}

/**
 * 顶栏上那一小片字。不是 demo 就**什么都不渲染**（真实工作区里连一个空节点都没有）。
 */
export function DemoBadge(): ReactNode {
  const { t } = useApp()
  const [demo, setDemo] = useState(false)

  useEffect(() => {
    let alive = true
    void isDemo().then((yes) => {
      if (alive) setDemo(yes)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!demo) return null
  return (
    <span
      data-testid="demo-badge"
      title={t('demo.badge.hint')}
      className="rounded-full border border-ws-line px-2 py-0.5 text-[11px] text-ws-muted-fg"
    >
      {t('demo.badge')}
    </span>
  )
}
