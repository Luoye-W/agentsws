/**
 * 冷启动那一瞬的首屏（WP112）。
 *
 * 取数完成前工作台本来是一块灰色 `Skeleton`——它在"这一屏马上就要长出内容"的时候
 * 是对的，但整个应用还没起来的时候它说的是"有东西在加载"，而不是"这是什么软件"。
 * 换成母品牌那段**集结**：六块依次落位，说的正是"这套东西正在起来"。
 *
 * 两条纪律：
 *
 * 1. **≥ 300ms 才显示**。取数在本机通常几十毫秒就回来了，那时候闪一下动效比什么都
 *    不做更糟。300ms 之内回来 → 这个组件一个像素都不画。
 * 2. **播完即走，不人为拖时间**。数据到了就换页面，动效播到哪一帧就停在哪一帧——
 *    为了"让动效播完"而多等半秒，是拿品牌换用户的时间。
 */
import { type ReactNode, useEffect, useState } from 'react'
import { BrandMark } from '@/components/design'
import { useApp } from '@/lib/app-context'

/** 低于这个时长的等待不配有首屏——闪一下比没有更烦。 */
export const BOOT_SPLASH_DELAY_MS = 300

export function BootSplash(): ReactNode {
  const { t } = useApp()
  const [show, setShow] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => {
      setShow(true)
    }, BOOT_SPLASH_DELAY_MS)
    return () => {
      clearTimeout(id)
    }
  }, [])

  if (!show) return null
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ws-paper"
      data-testid="boot-splash"
    >
      <BrandMark size={72} motion="assemble" label={t('app.title')} />
      <p className="text-[13px] text-ws-muted-fg">{t('app.boot')}</p>
    </div>
  )
}
