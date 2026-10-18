/**
 * WP415（自查 R1，决策 1236）：**执行链的兜底**——谁都不认的卡最后落到哪。
 *
 * 以前一律落进内存空桩（`MemoryBackend`），空桩回 ok，于是「批了显示办好了，实际没发、没改」。
 * 现在按运行形态分三种：
 *
 * - `live`（真用：`index.ts` 起的服务进程、托管实例）：**不进空桩**，回 failed + 「还没接通」，
 *   卡上照实写「没做：这一步还没接通」，发出记录不记；
 * - `demo`（演示：接了模拟世界）：照走空桩，回读结论标 `demo`——卡上写「演示」，不写「办好了」；
 * - `memory`（测试与一次性任务）：老行为，一个字节不变。
 */
import type { ApprovalItem, ExecutionMode, StagedChange } from '@agentsws/contracts'
import { NOT_WIRED_ERROR_PREFIX, NOT_WIRED_TEXT } from '@agentsws/contracts'
import type { ApplyCallbackOptions, BackendResult } from '@agentsws/txn'
import type { MemoryBackend } from '../backend.js'

type Opts = Partial<ApplyCallbackOptions> & { attempt: number }

/** 没接通时执行器那条失败的原话（前缀让界面认得出「没接通」，不是「这一次失败」）。 */
export const NOT_WIRED_APPLY_MESSAGE = `${NOT_WIRED_ERROR_PREFIX}${NOT_WIRED_TEXT.zh}`

/** 对外发信没有渠道接得住时那一句（邮箱没连、认不出线程、这个渠道还不能发）。 */
export const NOT_DELIVERED_MESSAGE = `${NOT_WIRED_ERROR_PREFIX}没发出去：这条消息的渠道还没连好（或者认不出该回到哪），工坊没有替你发。`

export interface ExecutionFallback {
  readonly mode: ExecutionMode
  apply(change: StagedChange, opts: Opts): BackendResult
  deliver(item: ApprovalItem, opts: Opts): BackendResult
}

export function createExecutionFallback(
  mode: ExecutionMode,
  backend: Pick<MemoryBackend, 'apply' | 'deliver'>,
): ExecutionFallback {
  return {
    mode,
    apply(change, opts) {
      if (mode === 'live')
        return {
          status: 'failed',
          not_wired: true,
          error: { message: NOT_WIRED_APPLY_MESSAGE, retryable: false },
        }
      const res = backend.apply(change, opts)
      return mode === 'demo' && res.status === 'ok' ? { ...res, readback: 'demo' } : res
    },
    deliver(item, opts) {
      if (mode === 'live')
        return {
          status: 'failed',
          not_wired: true,
          error: { message: NOT_DELIVERED_MESSAGE, retryable: false },
        }
      const res = backend.deliver(item, opts)
      return mode === 'demo' && res.status === 'ok' ? { ...res, readback: 'demo' } : res
    },
  }
}

/**
 * 这个进程的运行形态：显式给了就用它；接了模拟世界 = 演示；别的（测试、一次性任务）= 老行为。
 * 生产入口（`index.ts`）显式给 `live`——守卫测试会盯着那一行。
 */
export function resolveExecutionMode(input: {
  execution?: ExecutionMode | undefined
  mounted: boolean
}): ExecutionMode {
  if (input.execution !== undefined) return input.execution
  return input.mounted ? 'demo' : 'memory'
}
