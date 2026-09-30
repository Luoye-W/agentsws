/**
 * WP208（Luoye 09-30）：**设计规范搬到「公司 → 品牌」**。
 *
 * Luoye：「设计规范也不应该放在第三栏，它应该在设置或者公司里去设置。」
 *
 * 设计规范（71，DESIGN.md）是**品牌**的事：一个品牌一份（52：品牌是顶层，一个品牌一个工作区），
 * 与当前在哪个岗位、哪条职责上无关——放在跟着岗位走的第三栏里本来就不对位。
 *
 * - 卡上是原来第三栏那张**速查表**（色板 / 字体 / logo 最小宽度，`DesignMdPanel`），能力照旧：
 *   只读速查 + 「查看 / 编辑」进 `/brand-design` 那一页（抓取、上传、改令牌、下载都在那一页）；
 * - 看的是**当前品牌**那一份；要看另一个品牌的，先在上面那张表里切过去（切品牌 = 整站换工作区）；
 * - 设计岗的职责照旧读得到：Agent 那一侧读的是服务端的 `/v1/brand-design`，与这张卡放哪无关。
 */
import { Link } from 'react-router-dom'
import { useBrands } from '@/components/brand-switcher'
import { DesignMdPanel } from '@/components/rail/panels/design-md-panel'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'

export function BrandDesignCard(): React.ReactNode {
  const { t } = useApp()
  const { brands } = useBrands()
  const current = brands.find((b) => b.current)
  return (
    <Card data-testid="org-brand-design">
      <CardHeader className="flex flex-row items-center gap-2">
        <CardTitle className="flex items-center gap-1 text-sm">
          {current === undefined
            ? t('org.brands.design.title')
            : `${t('org.brands.design.title')} · ${current.name}`}
          <Hint text={t('org.brands.design.hint')} testId="org-brand-design-hint" />
        </CardTitle>
        <Button size="sm" variant="outline" className="ml-auto" asChild>
          <Link to="/brand-design" data-testid="org-brand-design-open">
            {t('org.brands.design.open')}
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <DesignMdPanel hideLink />
      </CardContent>
    </Card>
  )
}
