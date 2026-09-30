/**
 * WP208（Luoye 09-30）：第三栏的 **「设定」**——角色 / 记忆 / 知识 / 技能 / 额度合进一个图标。
 *
 * Luoye 看截图说"侧边栏图标有点太多了"：这五样答的都是"这个岗位 / 这条职责是谁、会什么、
 * 能花多少"，是同一类"这一层的设置"（36 §10），于是合成一个图标，进去用顶上一排标签切。
 *
 * 几条：
 *
 * - **五个面板原样搬进来**（`role-panel` / `memory-panel` / …），一个字没改；每个标签的身体
 *   照旧 `lazy()`——点到哪个才下载哪个。
 * - **标签就是旧 id**（`memory` / `skills` …）。切标签 = `show('<旧 id>')`，旧 id 由注册表的别名
 *   （`registerPanelAlias`）落回这个面板的那个标签。于是：职责页头部那几个按钮、本机存着的旧布局、
 *   别处写死的 `show('memory')` 全都照旧开得到对的地方；"上次开的是哪个标签"也跟着布局一起记住
 *   （它是结构，不是内容，#5）。
 * - 「岗位层 / 职责层」切换在面板壳上（`rail-panel.tsx`），五个标签共用，这里不另做一份。
 */
import { type ComponentType, type LazyExoticComponent, lazy, type ReactNode, Suspense } from 'react'
import type { RailScope } from '@/components/rail/rail-scope'
import { useRailState } from '@/components/rail/rail-state'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 顶上那一排的顺序（Fable 定：先"是谁"，再"记得什么 / 知道什么 / 会什么"，最后"能花多少"）。 */
export const SETTINGS_TABS = ['role', 'memory', 'knowledge', 'skills', 'caps'] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]

export function isSettingsTab(value: string | undefined): value is SettingsTab {
  return value !== undefined && (SETTINGS_TABS as readonly string[]).includes(value)
}

type ScopedBody = ComponentType<{ scope: RailScope }>

const BODIES: Record<SettingsTab, LazyExoticComponent<ScopedBody>> = {
  role: lazy(async () => ({ default: (await import('./role-panel')).RolePanel })),
  memory: lazy(async () => ({ default: (await import('./memory-panel')).MemoryPanel })),
  knowledge: lazy(async () => ({ default: (await import('./knowledge-panel')).KnowledgePanel })),
  skills: lazy(async () => ({ default: (await import('./skills-panel')).SkillsPanel })),
  caps: lazy(async () => ({ default: (await import('./caps-panel')).CapsPanel })),
}

export function SettingsPanel({ scope, sub }: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  // 这一格由右栏保证有（`scoped`：定位不到岗位时壳子自己说那一句）
  if (scope === undefined) return null
  const tab: SettingsTab = isSettingsTab(sub) ? sub : 'role'
  const Body = BODIES[tab]
  return (
    <div className="flex flex-col gap-3" data-testid="settings-panel" data-tab={tab}>
      <div
        role="tablist"
        aria-label={t('rail.panel.settings')}
        className="-mx-1 flex flex-wrap items-center gap-1 border-b pb-2"
      >
        {SETTINGS_TABS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            data-testid={`settings-tab-${value}`}
            className={cn(
              'rounded-md px-2 py-0.5 text-xs',
              tab === value
                ? 'bg-secondary font-medium text-secondary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
            onClick={() => {
              // 标签就是旧 id：交给右栏，别名把它落回这里的这个标签，顺手记进布局
              if (tab !== value) rail.show(value)
            }}
          >
            {t(`rail.panel.${value}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-testid={`settings-panel-${tab}`}>
        <Suspense
          fallback={
            <p className="text-muted-foreground" data-testid="rail-panel-loading">
              {t('rail.loading')}
            </p>
          }
        >
          <Body scope={scope} />
        </Suspense>
      </div>
    </div>
  )
}
