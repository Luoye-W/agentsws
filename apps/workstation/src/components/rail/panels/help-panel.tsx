/**
 * WP156（36 §7 第三档）：右栏「教程」面板。
 *
 * 两种打开法：
 *
 * - 卡片上点「看教程」→ 为 `agentsws://help/<slug>` 打开（注册表 `resolvePanel()` 排到这里），
 *   直接显示那一篇，顶上一个「全部教程」回目录；
 * - 人点图标轨打开（没有地址）→ 显示目录，点一篇在同一个面板里换过去。
 *
 * 不跟岗位 / 职责走（`scoped` 不给）：教程讲的是"怎么接"，与当前在哪个岗位无关。
 */
import { ChevronLeft } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { HelpBody } from '@/components/help/help-body'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { useApp } from '@/lib/app-context'
import { HELP_SLUGS, type HelpSlug, helpSlugOf } from '@/lib/help'

export function HelpPanel({ address }: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  /**
   * 人在面板里点过的（目录里挑了一篇 / 点了「全部教程」）。记着是**在哪个地址下**点的：
   * 又点了另一张卡的「看教程」（地址换了）就以地址为准。
   */
  const [picked, setPicked] = useState<{ for: string | undefined; view: HelpSlug | 'index' }>()
  const view: HelpSlug | 'index' =
    picked !== undefined && picked.for === address ? picked.view : (helpSlugOf(address) ?? 'index')
  const go = (next: HelpSlug | 'index'): void => {
    setPicked({ for: address, view: next })
  }

  if (view === 'index')
    return (
      <nav className="flex flex-col gap-1 p-3" data-testid="help-panel" data-slug="">
        <p className="pb-1 text-xs text-ws-muted-fg">{t('help.index')}</p>
        {HELP_SLUGS.map((slug) => (
          <button
            key={slug}
            type="button"
            data-testid="help-index-item"
            data-slug={slug}
            className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              go(slug)
            }}
          >
            {t(`help.${slug}.title`)}
          </button>
        ))}
      </nav>
    )

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="help-panel" data-slug={view}>
      <button
        type="button"
        data-testid="help-back"
        className="inline-flex items-center gap-0.5 self-start text-xs text-ws-muted-fg hover:text-foreground"
        onClick={() => {
          go('index')
        }}
      >
        <ChevronLeft aria-hidden className="size-3.5" />
        {t('help.index')}
      </button>
      <HelpBody slug={view} />
    </div>
  )
}
