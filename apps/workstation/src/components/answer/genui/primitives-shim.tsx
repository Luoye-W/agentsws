/**
 * WP336：dsh-genui 的 `/embed` 从 `@deepseek-ai/dsh-client-ui-primitives` 借 CodeBlock / DiffBlock / JsonTree /
 * writeClipboard。真包会拖进 shiki、simple-icons 一大摞（而且它没声明自己的运行依赖），所以打包时（vite.config.ts）
 * 把它换成这份本地壳。
 *
 * WP341（决策 847）：代码 / 差异 / JSON / 复制放开了——壳里给最朴素的画法（不高亮，字原样当字），复制走浏览器剪贴板。
 * `getGenuiComponent`：宿主自己画的两种组件（口令格 `ws-secret`、「点开看」的外部媒体 `ws-media`）由渲染层那一块
 * 登记进来（这一份不反过来引宿主的大件，免得主包变重）。不导出 `GenuiActionContext`——渲染层用它自己的本地上下文，
 * 宿主在外面包一层给处理器（genui-view.tsx）。
 */
import type { ComponentType, ReactNode } from 'react'

const PRE =
  'max-h-[360px] overflow-auto rounded-md bg-ws-surface px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre'

export function CodeBlock({ code, lang }: { code: string; lang?: string }): ReactNode {
  return (
    <pre className={PRE} data-slot="genui-code" data-lang={lang}>
      <code>{code}</code>
    </pre>
  )
}

interface DiffHunk {
  path: string
  oldText: string | null
  newText: string
}

export function DiffBlock({ diffs }: { diffs: DiffHunk[] }): ReactNode {
  return (
    <div className="flex flex-col gap-2" data-slot="genui-diff">
      {diffs.map((d) => (
        <div key={d.path} className="flex flex-col gap-1">
          <span className="text-xs text-ws-muted-fg">{d.path}</span>
          {d.oldText === null ? null : (
            <pre className={`${PRE} text-ws-bad line-through`}>{d.oldText}</pre>
          )}
          <pre className={`${PRE} text-ws-good`}>{d.newText}</pre>
        </div>
      ))}
    </div>
  )
}

export function JsonTree({ data }: { data: unknown }): ReactNode {
  return (
    <pre className={PRE} data-slot="genui-json">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await globalThis.navigator?.clipboard?.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 宿主组件拿到的东西（同插件 `GenuiCustomProps`）。 */
export interface HostGenuiProps {
  node: { type: string; [key: string]: unknown }
  onAction?: ((action: string, payload: Record<string, unknown>) => void) | undefined
  renderChildren: (nodes: unknown[], keyBase: string) => unknown
}

const hostComponents = new Map<string, ComponentType<HostGenuiProps>>()

/** 渲染层那一块加载时登记宿主组件。 */
export function registerHostGenuiComponent(type: string, c: ComponentType<HostGenuiProps>): void {
  hostComponents.set(type, c)
}

/** 插件画到不认识的类型时来问（只认宿主登记过的那几种）。 */
export function getGenuiComponent(type: string): ComponentType<HostGenuiProps> | undefined {
  return hostComponents.get(type)
}
