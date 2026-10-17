/**
 * WP372（决策 1004 / 1019）：**产出**——原来第三栏的「记录 / 发出记录 / 证据」三个图标合成一个面板的三个标签
 * （与 WP208 把五个设置合成「设定」同一个做法）。旧 id 留作别名：`show('records')` 开到「记录」这一格，
 * `show('evidence')`（卡上的「证据 N」）开到「证据」。报表不在这里（决策 1019：报表单独一张卡）。
 * 「文件」还是占位（`builtin-panels.tsx` 的 `UNBUILT_PANELS`），做好了加成第四个标签。
 */
import { type ComponentType, type LazyExoticComponent, lazy, type ReactNode, Suspense } from 'react'
import { useRailState } from '@/components/rail/rail-state'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export const OUTPUT_TABS = ['records', 'outbound', 'evidence'] as const
type OutputTab = (typeof OUTPUT_TABS)[number]

const BODIES: Record<OutputTab, LazyExoticComponent<ComponentType<RailPanelBodyProps>>> = {
  records: lazy(async () => ({ default: (await import('./records-panel')).RecordsPanel })),
  outbound: lazy(async () => ({ default: (await import('./outbound-panel')).OutboundPanel })),
  evidence: lazy(async () => ({ default: (await import('./evidence-panel')).EvidencePanel })),
}

export function OutputsPanel(props: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const tab: OutputTab = (OUTPUT_TABS as readonly string[]).includes(props.sub ?? '')
    ? (props.sub as OutputTab)
    : 'records'
  const Body = BODIES[tab]
  return (
    <div className="flex flex-col gap-3" data-testid="outputs-panel" data-tab={tab}>
      <div
        role="tablist"
        aria-label={t('rail.panel.outputs')}
        className="-mx-1 flex flex-wrap items-center gap-1 border-b pb-2"
      >
        {OUTPUT_TABS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            data-testid={`outputs-tab-${value}`}
            className={cn(
              'rounded-md px-2 py-0.5 text-xs',
              tab === value
                ? 'bg-secondary font-medium text-secondary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
            onClick={() => {
              // 标签就是旧 id：别名把它落回这里的这个标签
              if (tab !== value) rail.show(value)
            }}
          >
            {t(`outputs.tab.${value}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-testid={`outputs-panel-${tab}`}>
        <Suspense
          fallback={
            <p className="text-muted-foreground" data-testid="rail-panel-loading">
              {t('rail.loading')}
            </p>
          }
        >
          <Body {...props} />
        </Suspense>
      </div>
    </div>
  )
}
