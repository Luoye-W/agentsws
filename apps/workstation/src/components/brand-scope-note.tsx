/**
 * WP66（52 O1）：一句"这一页只管当前这个品牌"。
 *
 * 为什么要有它：连接与模型设置从这一版起**按品牌各一份**，而界面上这两页看着
 * 与单品牌时一模一样——不说一句，用户会以为自己在改"这台机器"的设置，
 * 然后奇怪为什么切过去之后邮箱又不见了。
 *
 * **个人用户不出**（一个人、一个品牌）：对他来说没有第二个品牌，这句话只是噪音。
 */
import { useBrands } from '@/components/brand-switcher'
import { useApp } from '@/lib/app-context'

export function BrandScopeNote({ testId }: { testId?: string }): React.ReactNode {
  const { t } = useApp()
  const { brands, solo } = useBrands()
  if (solo || brands.length <= 1) return null
  const current = brands.find((b) => b.current)
  if (current === undefined) return null
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid={testId ?? 'brand-scope-note'}
      // 这一句是页面的副标题，不是提示条：不加边框、不抢眼，看一眼知道就行
    >
      {t('brand.scope', { brand: current.name })}
    </p>
  )
}
