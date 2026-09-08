/**
 * Cordis 上下文的类型增强（09 §0「我们的内核用 dsh 同一套插件模型」）。
 * 内核四个服务以 Cordis 服务的形式挂在根上下文上，模块用 `inject` 声明依赖。
 */
import type { Halt } from '@agentsws/contracts'
import type { Context } from '@deepseek-ai/cordis'
import type { SqliteEventLog } from './event-log.js'
import type { ModuleRegistry } from './modules.js'
import type { KernelTrace } from './trace.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    eventLog: SqliteEventLog
    halt: Halt
    trace: KernelTrace
    modules: ModuleRegistry
  }
}

/** 内核提供的服务名（模块 `inject` 用）。 */
export const KERNEL_SERVICES = ['eventLog', 'halt', 'trace', 'modules'] as const
export type KernelServiceName = (typeof KERNEL_SERVICES)[number]

export type { Context }
