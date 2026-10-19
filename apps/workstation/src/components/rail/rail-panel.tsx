/**
 * WP71（36 §9）：第三栏里**一个面板的壳**——上下文、层切换。
 *
 * 面板本身只管"这是什么、看的是哪一层"；里面的内容各面板自己长。
 * 单开一格（记忆、浏览器、教程……）时标题永远带上下文（"记忆 · 店铺管理"），因为第三栏最容易出的错就是
 * 人看着一栏数字却不知道它说的是哪个岗位（36 §9：面板内容永远按当前岗位取）。
 *
 * WP431（Luoye 10-19，照 Claude 桌面版右侧那一栏）：面板是**并排的一栏**，没有自己的标题条、关闭叉和放大钮——
 * 开关只在顶栏那颗面板图标上。
 * - 卡片堆（{@link RailPanel} 不给 `onBack`）：顶上只有一个轻的「岗位层 / 职责层」分段切换（两层都有时），
 *   下面直接是一张张卡；
 * - 从卡里「显示更多」进来的一格：一行细的「← 名字 · 哪一层」，点「←」回到卡片堆。
 */
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RailScope, RailTier } from '@/components/rail/rail-scope'
import { DutyIcon, PositionIcon } from '@/components/role-icons/role-icon'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 「岗位层 / 职责层」分段切换（只有一层可选时整条不出——没得选的开关只是噪音）。 */
function TierSwitch({
  tier,
  onTier,
}: {
  tier: RailTier
  onTier: (tier: RailTier) => void
}): ReactNode {
  const { t } = useApp()
  return (
    <fieldset
      aria-label={t('rail.tier.label')}
      className="m-0 inline-flex shrink-0 items-center gap-0.5 rounded-lg border-0 bg-muted/70 p-0.5"
      data-testid="rail-tier-switch"
    >
      {(['position', 'role'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={tier === value}
          data-testid={`rail-tier-${value}`}
          className={cn(
            'rounded-md px-2.5 py-0.5 text-[12px] transition-colors',
            tier === value
              ? 'bg-background font-medium text-foreground shadow-xs'
              : 'text-ws-muted-fg hover:text-foreground',
          )}
          onClick={() => {
            onTier(value)
          }}
        >
          {t(`rail.tier.${value}`)}
        </button>
      ))}
    </fieldset>
  )
}

export function RailPanel({
  title,
  scope,
  tier,
  onTier,
  hasPosition,
  hasRole,
  children,
  testId,
  onBack,
}: {
  /** 面板名（"记忆" / "技能" / "知识" / "额度"）。卡片堆不画它。 */
  title: string
  /** 现在看的是哪一层；没有就说明这一页还定位不到岗位。 */
  scope?: RailScope
  tier: RailTier
  onTier: (tier: RailTier) => void
  hasPosition: boolean
  hasRole: boolean
  children: ReactNode
  testId: string
  /** WP372：回到卡片堆（从一张卡「显示更多」进来的那一格）。不给 = 这就是卡片堆。 */
  onBack?: () => void
}): ReactNode {
  const { t } = useApp()
  const both = hasPosition && hasRole
  return (
    <section className="flex h-full min-h-0 flex-col" data-testid={testId} data-tier={tier}>
      {onBack === undefined ? (
        both ? (
          <div className="flex items-center px-3 pt-3">
            <TierSwitch tier={tier} onTier={onTier} />
          </div>
        ) : null
      ) : (
        <header className="flex h-10 shrink-0 items-center gap-1.5 px-2">
          <button
            type="button"
            aria-label={t('rail.back')}
            title={t('rail.back')}
            data-testid="rail-panel-back"
            className="flex size-7 items-center justify-center rounded-md text-ws-muted-fg hover:bg-foreground/[0.06] hover:text-foreground"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden className="size-4" />
          </button>
          {/* WP213：这一格说的是哪个岗位 / 哪条职责，先用图标认（docs/36 §8.3） */}
          {scope === undefined ? null : scope.tier === 'role' ? (
            <DutyIcon role_id={scope.scope_id} className="text-ws-muted-fg" />
          ) : (
            <PositionIcon position_id={scope.scope_id} className="text-ws-muted-fg" />
          )}
          <h2
            className="min-w-0 flex-1 truncate text-[13px] font-medium"
            data-testid="rail-panel-title"
          >
            {scope === undefined ? title : `${title} · ${scope.name}`}
          </h2>
          {both ? <TierSwitch tier={tier} onTier={onTier} /> : null}
        </header>
      )}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto text-sm',
          onBack === undefined ? 'p-3' : 'px-3 pt-1 pb-3',
        )}
      >
        {children}
      </div>
    </section>
  )
}
