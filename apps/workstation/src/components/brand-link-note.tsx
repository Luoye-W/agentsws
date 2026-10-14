/**
 * WP311（决策 507）：带品牌的链接切不过去时，主区顶上照实说一句（不存在 / 没权限 / 没切成）。
 * 一行字 + 关掉；不弹窗、不加说明段（界面少字）。
 */
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp } from '@/lib/app-context'
import { closeBrandLinkNotice, useBrandLinkNotice } from '@/lib/brand-link'

export function BrandLinkNote({ brand }: { brand: string }): ReactNode {
  const { t } = useApp()
  const notice = useBrandLinkNotice()
  if (notice === undefined) return null
  return (
    <div
      role="status"
      data-testid="brand-link-note"
      data-reason={notice}
      className="mb-4 flex items-center gap-2 rounded-lg bg-ws-card px-3 py-2 text-sm text-ws-ink shadow-[inset_0_0_0_1px_var(--ws-line)]"
    >
      <span className="min-w-0 flex-1">
        {notice === 'missing' ? t('brand.link.missing', { brand }) : t('brand.link.failed')}
      </span>
      <button
        type="button"
        aria-label={t('answer.close')}
        title={t('answer.close')}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ws-muted-fg hover:bg-ws-surface hover:text-ws-ink"
        onClick={closeBrandLinkNotice}
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}
