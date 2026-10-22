/**
 * WP372（决策 1004 / 1019）：**产出**——原来第三栏的「记录 / 发出记录 / 证据」三个图标合成一个面板的三个标签
 * （与 WP208 把五个设置合成「设定」同一个做法）。旧 id 留作别名：`show('records')` 开到「记录」这一格，
 * `show('evidence')`（卡上的「证据 N」）开到「证据」。报表不在这里（决策 1019：报表单独一张卡）。
 * 「文件」还是占位（`builtin-panels.tsx` 的 `UNBUILT_PANELS`），做好了加成第四个标签。
 */
import { type ComponentType, type LazyExoticComponent, lazy, type ReactNode, Suspense } from 'react'
import { Segmented } from '@/components/design/segmented'
import { useRailState } from '@/components/rail/rail-state'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { useApp } from '@/lib/app-context'

export const OUTPUT_TABS = ['records', 'outbound', 'evidence'] as const
type OutputTab = (typeof OUTPUT_TABS)[number]

/** WP456-T3：「记录」那一格最上面是 AI 写的报告文档（「产出」卡合进清单卡后从卡上挪过来）。 */
const Docs = lazy(async () => ({
  default: (await import('@/components/rail/cards/card-bodies')).OutputDocs,
}))

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
  // 记录跟着岗位 / 职责走：这一页还定位不到岗位就照实说（证据看的是被点的那张卡，发出记录是整个品牌的）
  const needsScope = tab === 'records' && props.scope === undefined
  return (
    <div className="flex flex-col gap-3" data-testid="outputs-panel" data-tab={tab}>
      {/* WP456-T2：全站唯一那种分段切换（页签语义） */}
      <Segmented
        kind="tabs"
        size="sm"
        className="self-start"
        label={t('rail.panel.outputs')}
        value={tab}
        options={OUTPUT_TABS.map((value) => ({
          value,
          label: t(`outputs.tab.${value}`),
          testId: `outputs-tab-${value}`,
        }))}
        onChange={(value) => {
          // 标签就是旧 id：交给右栏，别名把它落回这里的这个标签
          rail.show(value)
        }}
      />
      <div role="tabpanel" data-testid={`outputs-panel-${tab}`}>
        <Suspense
          fallback={
            <p className="text-muted-foreground" data-testid="rail-panel-loading">
              {t('rail.loading')}
            </p>
          }
        >
          {needsScope ? (
            <p className="text-muted-foreground" data-testid="rail-no-scope">
              {t('rail.no_scope')}
            </p>
          ) : (
            <>
              {tab === 'records' ? <Docs {...props} /> : null}
              <Body {...props} />
            </>
          )}
        </Suspense>
      </div>
    </div>
  )
}
