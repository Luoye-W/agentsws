/**
 * WP433（Luoye 10-20 问题 8：「进行中 / 卡住了」那些不是报表，归到「计划」里）：「计划」卡的「显示更多」。
 *
 * 上面是这一层的定时任务（原来那一格，`SchedulesPanel`，一个字没改）；下面是这一层的**进度**——
 * 岗位层是「工作」（进行中 / 卡住了 / 排着的 / 等别人 / 已完成，列表 / 看板 / 日历 / 表格），
 * 职责层是那条职责自己的排期、群发、开发信、素材流水线（原来摊在「报表 → 显示更多」下半截，`scope-boards.tsx`）。
 */
import { lazy, type ReactNode, Suspense } from 'react'
import { SchedulesPanel } from '@/components/rail/panels/schedules-panel'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { useApp } from '@/lib/app-context'

const ScopeWorkBoards = lazy(async () => ({
  default: (await import('@/components/reports/scope-boards')).ScopeWorkBoards,
}))

export function PlansPanel(props: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  return (
    <div className="flex flex-col gap-5" data-testid="plans-panel">
      <section className="flex flex-col gap-2" data-testid="plans-schedules">
        <h3 className="text-xs tracking-wider text-ws-muted-fg uppercase">
          {t('rail.panel.schedules')}
        </h3>
        <SchedulesPanel {...props} />
      </section>
      {props.scope?.assignment === undefined ? null : (
        <section className="flex flex-col gap-2" data-testid="plans-boards">
          <h3 className="text-xs tracking-wider text-ws-muted-fg uppercase">
            {t('plans.progress')}
          </h3>
          <Suspense fallback={null}>
            <ScopeWorkBoards {...props} />
          </Suspense>
        </section>
      )}
    </div>
  )
}
