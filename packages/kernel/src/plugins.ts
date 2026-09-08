/**
 * 内核插件（28 §1「每个契约模块是一个 Cordis 插件：inject 依赖、provide 服务、
 * Config 用 Schemastery 校验、ctx.effect() 注册回收」）。
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import './context.js'
import { KERNEL_SERVICES } from './context.js'
import type { SqliteEventLog } from './event-log.js'
import type { MemoryHalt } from './halt.js'
import type { ModuleRegistry } from './modules.js'
import type { KernelTrace } from './trace.js'

export interface KernelServicesConfig {
  eventLog: SqliteEventLog
  halt: MemoryHalt
  trace: KernelTrace
  modules: ModuleRegistry
}

/** 把四个内核服务 provide 到根上下文；fiber 卸载时自动摘除（ctx.provide 的回收语义）。 */
export const kernelServices: Plugin.Object<KernelServicesConfig> = {
  name: 'agentsws-kernel',
  provide: [...KERNEL_SERVICES],
  apply(ctx: Context, config: KernelServicesConfig) {
    ctx.provide('eventLog', config.eventLog)
    ctx.provide('halt', config.halt)
    ctx.provide('trace', config.trace)
    ctx.provide('modules', config.modules)
  },
}

export interface HelloConfig {
  workspace_id: string
  greeting: string
}

const HelloSchema = Schema.object({
  workspace_id: Schema.string().required(),
  greeting: Schema.string().default('hello'),
})

/** 示例插件的活动实例：apply 时登记，fiber 卸载时由 `ctx.effect` 的 disposer 摘除。 */
export const helloInstances = new Map<string, { greeting: string; event_id: string }>()

/**
 * 示例插件：`inject` 依赖 EventLog / Trace，启动时写一条事件，`ctx.effect()` 注册回收。
 * 它演示的是模块作者要遵守的形状——业务代码只经服务契约拿 EventLog，不自己开 SQLite。
 */
export const hello: Plugin.Object<HelloConfig> = {
  name: 'hello',
  inject: ['eventLog', 'trace'],
  Config: HelloSchema as unknown as NonNullable<Plugin.Base<HelloConfig>['Config']>,
  async apply(ctx: Context, config: HelloConfig) {
    const event = await ctx.trace.spanEvent({
      workspace_id: config.workspace_id,
      type: 'kernel.hello',
      actor: { kind: 'system', id: 'plugin:hello' },
      payload: { greeting: config.greeting },
    })
    helloInstances.set(config.workspace_id, { greeting: config.greeting, event_id: event.id })
    ctx.effect(
      () => () => {
        helloInstances.delete(config.workspace_id)
      },
      'hello:teardown',
    )
  },
}
