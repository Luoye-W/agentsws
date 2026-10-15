/**
 * WP336：dsh-genui 的 `/embed` 从 `@deepseek-ai/dsh-client-ui-primitives` 借 CodeBlock / DiffBlock /
 * JsonTree / writeClipboard——只给「代码 / 差异 / JSON」三种组件和表格的「复制」用，这几样白名单里全关。
 * 真包会拖进 shiki、simple-icons 一大摞（而且它没声明自己的运行依赖），所以打包时（vite.config.ts）把它
 * 换成这份空壳：组件不画，复制回「没复制」。不导出 `GenuiActionContext` / `getGenuiComponent`——
 * 渲染层因此用它自己的本地 action 上下文（我们不给处理器）、不画任何宿主自定义组件。
 */
import type { ReactNode } from 'react'

export function CodeBlock(): ReactNode {
  return null
}

export function DiffBlock(): ReactNode {
  return null
}

export function JsonTree(): ReactNode {
  return null
}

export async function writeClipboard(_text: string): Promise<boolean> {
  return false
}
