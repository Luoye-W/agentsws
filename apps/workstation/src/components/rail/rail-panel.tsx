/**
 * WP71（36 §9）：第三栏里**一个面板的壳**——上下文、层切换。
 *
 * 面板本身只管"这是什么、看的是哪一层"；里面的内容各面板自己长。
 * 单开一格（记忆、浏览器、教程……）时标题永远带上下文（"记忆 · 店铺管理"），因为第三栏最容易出的错就是
 * 人看着一栏数字却不知道它说的是哪个岗位（36 §9：面板内容永远按当前岗位取）。
 *
 * WP431（Luoye 10-19，照 Claude 桌面版右侧那一栏）：面板是**并排的一栏**，没有自己的标题条、关闭叉和放大钮——
 * 开关只在顶栏那颗面板图标上。
 * - 卡片堆（{@link RailPanel} 不给 `onClose`）：顶上只有一个轻的「岗位层 / 职责层」分段切换（两层都有时），
 *   下面直接是一张张卡；
 * - 从卡里「显示更多」进来的一格：一行细的「← 名字 · 哪一层」，点「←」回到卡片堆。
 *
 * WP433（Luoye 10-20 问题 6）：「岗位层 / 职责层」切换去掉——岗位页就是岗位层的卡，职责页就是职责层的卡，不能切。
 * WP433（Luoye 10-21 澄清）：卡片列属于中栏、不再用这个壳；这个壳只给**第三栏**那一格用：头上「名字 · 哪一层」+ 右边 ×。
 */
import { X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { InRightPaneContext } from '@/components/rail/in-right-pane'
import { PanelHeaderContext, type PanelHeaderHost } from '@/components/rail/panel-header'
import type { RailScope, RailTier } from '@/components/rail/rail-scope'
import { DutyIcon, PositionIcon } from '@/components/role-icons/role-icon'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export function RailPanel({
  title,
  scope,
  tier,
  children,
  testId,
  onClose,
}: {
  /** 面板名（"记忆" / "技能" / "知识" / "额度"）。卡片堆不画它。 */
  title: string
  /** 现在看的是哪一层；没有就说明这一页还定位不到岗位。 */
  scope?: RailScope
  tier: RailTier
  children: ReactNode
  testId: string
  /** WP433：收起这一格（第三栏右上角的 ×）。不给 = 没有头。 */
  onClose?: () => void
}): ReactNode {
  const { t } = useApp()
  /*
   * WP504：头里留一格给面板自己（库面板的「红人库 · 红人营销」+ ↑ ⋯、详情的「← 红人库 / 名字」）；
   * 有面板往里送东西时默认标题让位。
   */
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [claims, setClaims] = useState(0)
  const host = useMemo<PanelHeaderHost>(
    () => ({
      slot,
      claim: () => {
        setClaims((n) => n + 1)
        return () => {
          setClaims((n) => n - 1)
        }
      },
    }),
    [slot],
  )
  const custom = claims > 0
  return (
    <section className="flex h-full min-h-0 flex-col" data-testid={testId} data-tier={tier}>
      {onClose === undefined ? null : (
        <header className="flex h-10 shrink-0 items-center gap-1.5 px-3">
          {/* WP213：这一格说的是哪个岗位 / 哪条职责，先用图标认（docs/36 §8.3） */}
          {custom || scope === undefined ? null : scope.tier === 'role' ? (
            <DutyIcon role_id={scope.scope_id} className="text-ws-muted-fg" />
          ) : (
            <PositionIcon position_id={scope.scope_id} className="text-ws-muted-fg" />
          )}
          {custom ? null : (
            <h2
              className="min-w-0 flex-1 truncate text-[13px] font-medium"
              data-testid="rail-panel-title"
            >
              {scope === undefined ? title : `${title} · ${scope.name}`}
            </h2>
          )}
          <div
            ref={setSlot}
            className={cn('flex min-w-0 items-center gap-1', custom ? 'flex-1' : 'hidden')}
            data-testid="rail-panel-head-slot"
          />
          {/* WP433：第三栏是点了才弹出的一格，右上角一个 × 收起（卡片列一直在中栏里，不用「←」回去） */}
          <button
            type="button"
            aria-label={t('rail.close')}
            title={t('rail.close')}
            data-testid="rail-panel-close"
            className="flex size-7 items-center justify-center rounded-md text-ws-muted-fg hover:bg-foreground/[0.06] hover:text-foreground"
            onClick={onClose}
          >
            <X aria-hidden className="size-4" />
          </button>
        </header>
      )}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto text-sm',
          onClose === undefined ? 'p-3' : 'px-3 pt-1 pb-3',
        )}
      >
        {/* WP500：里面的东西知道自己已经在第三栏里（再开详情就在自己里面叠一层，不去换掉自己） */}
        <InRightPaneContext.Provider value={true}>
          {onClose === undefined ? (
            children
          ) : (
            <PanelHeaderContext.Provider value={host}>{children}</PanelHeaderContext.Provider>
          )}
        </InRightPaneContext.Provider>
      </div>
    </section>
  )
}
