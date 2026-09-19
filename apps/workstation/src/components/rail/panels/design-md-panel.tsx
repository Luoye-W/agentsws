/**
 * 右栏「设计规范」面板（71 §4，WP122）。
 *
 * 设计 / 建站 / 社媒 / 投放四个岗位干活时**随手能查**：这个品牌的色板是哪几个、
 * 字体是哪两种、logo 最小多大。
 *
 * 它是一个**只读的速查表**，不是那一页的缩小版：
 *
 * - 没有编辑、没有抓取按钮——那两件事有后果，后果应该发生在一个用户特地去到的
 *   页面上，而不是一个他干别的活时顺手划开的抽屉里。
 * - 没有出处、没有冲突角标——右栏宽度只有那么点，塞进去的每一样都在挤掉色块。
 *   要核对就点最底下那一行去那一页。
 *
 * 归「这一层的」那一组（`layer`）：它答的是"这个品牌长什么样"，与当前打开的是
 * 哪张卡无关。
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Skeleton } from '@/components/ui/skeleton'
import { getBrandDesign } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function DesignMdPanel(): React.ReactElement {
  const { t } = useApp()
  const doc = useQuery({ queryKey: ['brand-design'], queryFn: getBrandDesign })

  if (doc.isLoading) return <Skeleton className="h-40 w-full" />

  const profile = doc.data?.profile
  if (profile === undefined)
    return (
      <div className="flex flex-col gap-2 p-3" data-testid="design-md-panel-empty">
        <p className="text-sm text-ws-muted-fg">{t('design.md.empty')}</p>
        <Link className="text-sm text-ws-accent underline" to="/brand-design">
          {t('design.md.title')}
        </Link>
      </div>
    )

  const colors = Object.entries(profile.colors ?? {})
  const fonts = [
    ...new Set(
      Object.values(profile.typography ?? {})
        .map((v) => v.value.fontFamily)
        .filter((x): x is string => x !== undefined),
    ),
  ]
  const logo = profile.logos?.value[0]

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="design-md-panel">
      <section className="flex flex-col gap-1.5">
        <h4 className="font-medium text-ws-muted-fg text-xs uppercase tracking-wide">
          {t('design.md.section.colors')}
        </h4>
        <div className="flex flex-wrap gap-1.5">
          {colors.map(([token, v]) => (
            <div key={token} className="flex flex-col items-center gap-0.5">
              <div
                className="h-7 w-7 rounded-[--ws-radius-sm] border border-ws-border"
                style={{ backgroundColor: v.value }}
                title={`${token} ${v.value}`}
              />
              <span className="text-[10px] text-ws-muted-fg">{token}</span>
            </div>
          ))}
        </div>
      </section>

      {fonts.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h4 className="font-medium text-ws-muted-fg text-xs uppercase tracking-wide">
            {t('design.md.section.typography')}
          </h4>
          {fonts.map((f) => (
            <p key={f} className="text-sm" style={{ fontFamily: f }}>
              {f}
            </p>
          ))}
        </section>
      )}

      {logo?.min_width_px === undefined ? null : (
        <section className="flex flex-col gap-1">
          <h4 className="font-medium text-ws-muted-fg text-xs uppercase tracking-wide">
            {t('design.md.section.logo')}
          </h4>
          <p className="text-sm">≥ {logo.min_width_px}px</p>
        </section>
      )}

      <Link className="text-sm text-ws-accent underline" to="/brand-design">
        {t('design.md.title')}
      </Link>
    </div>
  )
}
