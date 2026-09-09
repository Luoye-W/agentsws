/**
 * dsh headless（WP30 A）：一份组合，两种宿主。
 *
 * `in-process` 与 `subprocess` 装的是**同一棵 Cordis 树**（`harness.ts` + `gate.ts`），
 * 只是树跑在哪个进程里不同；`createDshRuntime` 按 `mode` 选，缺省按能力探测。
 */
import type { RuntimeAdapter } from '@agentsws/contracts'
import { createInProcessDshRuntime } from '../runtime.js'
import type { DshRuntimeMode, DshRuntimeOptions } from '../types.js'
import { createSubprocessDshRuntime, defaultChildEntry, subprocessAvailable } from './subprocess.js'

export * from './protocol.js'
export { createSubprocessDshRuntime, defaultChildEntry, subprocessAvailable }

/** `mode: 'auto'` 的探测结果（编译产物在不在 = 能不能起子进程）。 */
export function resolveMode(options: DshRuntimeOptions): Exclude<DshRuntimeMode, 'auto'> {
  const mode = options.mode ?? 'auto'
  if (mode !== 'auto') return mode
  return subprocessAvailable(options.childEntry ?? defaultChildEntry())
    ? 'subprocess'
    : 'in-process'
}

/**
 * 17 §4 的 dsh 运行时。`mode` 决定装配形态，其余一切（语义、事件序列、`capabilities()`）相同。
 */
export function createDshRuntime(options: DshRuntimeOptions): RuntimeAdapter {
  return resolveMode(options) === 'subprocess'
    ? createSubprocessDshRuntime(options)
    : createInProcessDshRuntime(options)
}
