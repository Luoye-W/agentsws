/**
 * 17 §4 的运行时名字（模拟回路侧）。
 *
 * `dsh` 按能力探测选装配形态（编译产物在就起 headless 子进程，否则进程内装配）；
 * `dsh-in-process` / `dsh-subprocess` 是显式指定那一档——三者的语义、事件序列、指标完全一致，
 * 所以基线也共用 `dsh` 那一档（`baselineRuntime`）。
 */
export type RuntimeName = 'stub' | 'dsh' | 'dsh-in-process' | 'dsh-subprocess' | 'direct'

/** 全部运行时名（CLI 的 `--runtime` 与测试矩阵用）。 */
export const RUNTIME_NAMES: readonly RuntimeName[] = [
  'stub',
  'dsh',
  'dsh-in-process',
  'dsh-subprocess',
  'direct',
]

/** 基线分档的键：三个 dsh 变体共用一档（同一份组合，只是宿主进程不同）。 */
export type BaselineRuntime = 'stub' | 'dsh' | 'direct'

export function baselineRuntime(name: RuntimeName | undefined): BaselineRuntime {
  if (name === undefined || name === 'stub') return 'stub'
  if (name === 'direct') return 'direct'
  return 'dsh'
}

export function isRuntimeName(value: string): value is RuntimeName {
  return (RUNTIME_NAMES as readonly string[]).includes(value)
}
