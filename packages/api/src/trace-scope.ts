/**
 * 28 §1：trace_id 贯穿 run→tool→action→apply→delivery。
 * 网关把请求的 trace_id 放进异步上下文，宿主的 eventSink 写事件时取同一个值，
 * 于是「入站请求 → 事件日志」在日志里连成一条（28 §4 用例 6）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { TraceScope } from './types.js'

export function createAsyncTraceScope(): TraceScope {
  const storage = new AsyncLocalStorage<string>()
  return {
    run<T>(trace_id: string, fn: () => T): T {
      return storage.run(trace_id, fn)
    },
    current(): string | undefined {
      return storage.getStore()
    },
  }
}

/** 不做传播的空实现（单元测试或不需要串联时用）。 */
export function createNoopTraceScope(): TraceScope {
  return {
    run: (_trace_id, fn) => fn(),
    current: () => undefined,
  }
}
