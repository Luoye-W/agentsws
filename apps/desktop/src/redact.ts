/**
 * 日志脱敏（13 §4.3「凭据永远不进对话、不进模型、不进日志」）。
 *
 * **表不在这里**——WP31 把秘密模式表收敛到 `@agentsws/core` 的 `secret-patterns.ts`。
 * 桌面壳只保留自己的名字（`createRedactor` / `defaultRedactor` / `REDACTED`），
 * 两层遮罩的实现（我们自己生成的几把密钥逐字替换 + `标签: 值` 与长不透明串的形态兜底）
 * 都在那一份表里。
 */

import { createLogRedactor, defaultLogRedactor, REDACTED, type Redactor } from '@agentsws/core'

export type { Redactor }
export { REDACTED }

/**
 * @param literals 已知密钥原文；太短的会被忽略（否则正则会炸成逐字符替换）。
 */
export const createRedactor: (literals?: readonly string[]) => Redactor = createLogRedactor

/** 不带字面量的默认脱敏器（还没读出密钥时也要能记日志）。 */
export const defaultRedactor: Redactor = defaultLogRedactor
