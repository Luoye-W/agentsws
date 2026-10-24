/**
 * WP504（决策 1779 A，归属表「品牌素材」那一行）：**设计岗位第三栏的「素材」面板**——同一个素材库组件
 * （`BrandAssetsPage embedded`），头换成库面板那种「素材 · 设计」；全局页 `/brand-assets` 照旧当总库
 * （四个岗位共用一套图，没有总库会找不到「上个月那张图在哪个岗位传的」）。
 */
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Images } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { HEAD_ICON, LibraryHead } from '@/components/library/library-kit'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { getPositions } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { BrandAssetsPage } from '@/pages/brand-assets'

export const BRAND_ASSETS_LIBRARY = 'brand-assets-library'

export function BrandAssetsLibraryPanel({ scope }: RailPanelBodyProps): ReactNode {
  const { t, lang } = useApp()
  const navigate = useNavigate()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const inst = positions.data?.instances?.find((i) => i.position_id === 'design')
  const where = inst === undefined ? scope?.name : lang === 'en' ? inst.name.en : inst.name.zh
  return (
    <div className="flex flex-col gap-3" data-testid="brand-assets-library">
      <LibraryHead
        icon={<Images aria-hidden className="size-4" />}
        title={t('rail.panel.brand-assets-library')}
        where={where}
        actions={
          <button
            type="button"
            className={HEAD_ICON}
            aria-label={t('assets.library.all')}
            title={t('assets.library.all')}
            data-testid="brand-assets-library-all"
            onClick={() => {
              void navigate('/brand-assets')
            }}
          >
            <ExternalLink aria-hidden className="size-4" />
          </button>
        }
      />
      <BrandAssetsPage embedded />
    </div>
  )
}
