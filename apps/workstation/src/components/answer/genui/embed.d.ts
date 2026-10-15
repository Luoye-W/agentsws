/**
 * WP336：`@changfenhuang/dsh-genui/embed` 的类型（只写工作台用到的那几样）。
 *
 * 这个入口发的是 TypeScript **源码**（`src/client/embed.ts`），直接让 tsc 去查会按我们的严格选项
 * （exactOptionalPropertyTypes 等）连它的源码一起查。所以 tsconfig 的 `paths` 把这个入口指到这份声明，
 * 打包（vite）照常用它的源码。签名对照 0.12.0 的 `src/client/{GenuiBlock,guard,blocks/state}.ts`。
 */
declare module '@changfenhuang/dsh-genui/embed' {
  import type { ComponentType } from 'react'

  /** 渲染层认的描述（这里只当不透明对象传；内容由契约 `filterGenuiSpec` 过滤过）。 */
  export interface GenuiSpec {
    title?: string
    items: unknown[]
  }

  export interface BlockInteractionState {
    answers: Record<string, string>
    locked: boolean
  }

  export interface GenuiBlockProps {
    spec: GenuiSpec
    onAction?: ((action: string, payload: Record<string, unknown>) => void) | undefined
    stateKey?: string | undefined
    animateEntrance?: boolean | undefined
    initialState?: BlockInteractionState | undefined
    onStateChange?: ((state: BlockInteractionState) => void) | undefined
  }

  export const GenuiBlock: ComponentType<GenuiBlockProps>

  export interface GenuiProcessResult {
    spec: GenuiSpec | null
    errors: string[]
    warnings: string[]
  }

  export function processGenuiSpec(value: unknown): GenuiProcessResult
  export function isRenderableProcess(processed: GenuiProcessResult): boolean
}
