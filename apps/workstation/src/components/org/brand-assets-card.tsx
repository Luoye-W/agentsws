/**
 * WP268（决策 213）：「公司 → 品牌」里的**品牌素材库**小卡：几张最近的图 + 「打开素材库」。
 * 与设计规范同一层（一个品牌一份）；整页在 `/brand-assets`。
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { AuthedImage } from '@/components/images/authed-image'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { listBrandAssets } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function BrandAssetsCard(): React.ReactNode {
  const { t } = useApp()
  const list = useQuery({
    queryKey: ['brand-assets', 'card'],
    queryFn: () => listBrandAssets({ limit: 6 }),
  })
  const rows = list.data?.rows ?? []
  return (
    <Card data-testid="org-brand-assets">
      <CardHeader className="flex flex-row items-center gap-2">
        <CardTitle className="flex items-center gap-1 text-sm">
          {t('assets.title')}
          <Hint text={t('assets.hint')} testId="org-brand-assets-hint" />
        </CardTitle>
        <Button size="sm" variant="outline" className="ml-auto" asChild>
          <Link to="/brand-assets" data-testid="org-brand-assets-open">
            {t('assets.card.open')}
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-[12.5px] text-ws-muted-fg">{t('assets.empty')}</p>
        ) : (
          <div className="grid grid-cols-6 gap-2">
            {rows.map((r) => (
              <AuthedImage
                key={r.id}
                src={r.file_url}
                alt={r.source_label}
                className="aspect-square w-full rounded-lg ring-1 ring-ws-line"
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
