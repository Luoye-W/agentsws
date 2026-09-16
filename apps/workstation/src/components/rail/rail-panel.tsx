/**
 * WP71（36 §9）：第三栏里**一个面板的壳**——标题行、上下文、层切换、关闭。
 *
 * 面板本身只管"这是什么、看的是哪一层"；里面的内容各面板自己长。
 * 标题永远带上下文（"记忆 · 店铺管理"），因为第三栏最容易出的错就是
 * 人看着一栏数字却不知道它说的是哪个岗位（36 §9：面板内容永远按当前岗位取）。
 */
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RailScope, RailTier } from '@/components/rail/rail-scope'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export function RailPanel({
  title,
  scope,
  tier,
  onTier,
  hasPosition,
  hasRole,
  onClose,
  children,
  testId,
}: {
  /** 面板名（"记忆" / "技能" / "知识" / "额度"）。 */
  title: string
  /** 现在看的是哪一层；没有就说明这一页还定位不到岗位。 */
  scope?: RailScope
  tier: RailTier
  onTier: (tier: RailTier) => void
  hasPosition: boolean
  hasRole: boolean
  onClose: () => void
  children: ReactNode
  testId: string
}): ReactNode {
  const { t } = useApp()
  return (
    <section className="flex h-full min-h-0 flex-col" data-testid={testId} data-tier={tier}>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="rail-panel-title">
          {scope === undefined ? title : `${title} · ${scope.name}`}
        </h2>
        <button
          type="button"
          aria-label={t('rail.close')}
          data-testid="rail-panel-close"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onClose}
        >
          <X aria-hidden className="size-4" />
        </button>
      </header>
      {/*
        层切换：一个岗位下的这条职责在两层都有自己的一份，看哪一层是人的选择。
        只有一层可选时整条不出——没得选的开关只是噪音。
      */}
      {hasPosition && hasRole ? (
        <div
          className="flex items-center gap-1 border-b px-3 py-1.5"
          data-testid="rail-tier-switch"
        >
          {(['position', 'role'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={tier === value}
              data-testid={`rail-tier-${value}`}
              className={cn(
                'rounded px-2 py-0.5 text-xs',
                tier === value
                  ? 'bg-secondary font-medium text-secondary-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
              onClick={() => {
                onTier(value)
              }}
            >
              {t(`rail.tier.${value}`)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">{children}</div>
    </section>
  )
}
