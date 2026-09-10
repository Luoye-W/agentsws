/**
 * `@agentsws/kernel` —— 内核（28 §1）。
 *
 * 一个 Cordis 根上下文 + 四个内核服务：event-log（21）、halt、trace、模块清单。
 * 每个契约模块是一个 Cordis 插件，`inject` 这些服务；内核自己不含业务。
 */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Clock, Random } from './clock.js'
import { systemClock, systemRandom } from './clock.js'
import './context.js'
import { KernelError } from './errors.js'
import { SqliteEventLog } from './event-log.js'
import type { HaltEnv } from './halt.js'
import { haltFileAt, MemoryHalt } from './halt.js'
import type { ModuleLoaderOptions } from './modules.js'
import { ModuleRegistry } from './modules.js'
import { kernelServices } from './plugins.js'
import { KernelTrace } from './trace.js'

export * from './clock.js'
export * from './context.js'
export * from './errors.js'
export * from './event-log.js'
export * from './halt.js'
export * from './modules.js'
export * from './plugins.js'
export * from './sql-event-log.js'
export * from './trace.js'
export * from './ulid.js'

export interface KernelOptions {
  /** 事件日志的 SQLite 路径；缺省 `:memory:`。 */
  dbPath?: string
  /** 时间注入点；缺省系统时钟。 */
  clock?: Clock
  /** 随机注入点；缺省 `Math.random`。 */
  random?: Random
  /** 环境变量来源（急停初值）；缺省 `process.env`。 */
  env?: HaltEnv
  /** 模块清单装载选项；不给则内核不带外部模块。 */
  modules?: ModuleLoaderOptions
  /** 事件信封版本，缺省 `EVENT_SCHEMA_VERSION`；只有一致性测试才该动它。 */
  schemaVersion?: number
}

export interface Kernel {
  ctx: Context
  eventLog: SqliteEventLog
  halt: MemoryHalt
  trace: KernelTrace
  modules: ModuleRegistry
  /** 卸载全部插件并关掉事件日志连接。 */
  dispose(): Promise<void>
}

/** 只校验可序列化的那部分选项（注入的 clock / random 是函数，不进 schema）。 */
const KernelConfigSchema = Schema.object({
  dbPath: Schema.string().default(':memory:'),
  schemaVersion: Schema.natural(),
  modules: Schema.object({
    manifestPath: Schema.string(),
    allowedPublishers: Schema.array(Schema.string()),
    requireSignature: Schema.boolean().default(true),
  }),
})

/** 装配内核。返回的服务同时挂在 `ctx` 上（`ctx.eventLog` 等），供 Cordis 插件 inject。 */
export async function createKernel(options: KernelOptions = {}): Promise<Kernel> {
  let validated: { dbPath: string; schemaVersion?: number }
  try {
    validated = KernelConfigSchema({
      ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
      ...(options.schemaVersion === undefined ? {} : { schemaVersion: options.schemaVersion }),
      ...(options.modules === undefined
        ? {}
        : {
            modules: {
              ...(options.modules.manifestPath === undefined
                ? {}
                : { manifestPath: options.modules.manifestPath }),
              ...(options.modules.allowedPublishers === undefined
                ? {}
                : { allowedPublishers: [...options.modules.allowedPublishers] }),
              ...(options.modules.requireSignature === undefined
                ? {}
                : { requireSignature: options.modules.requireSignature }),
            },
          }),
    }) as { dbPath: string; schemaVersion?: number }
  } catch (cause) {
    throw new KernelError('invalid_input', `invalid kernel options: ${String(cause)}`, { cause })
  }

  const clock = options.clock ?? systemClock
  const random = options.random ?? systemRandom

  const eventLog = new SqliteEventLog({
    dbPath: validated.dbPath,
    clock,
    random,
    ...(options.schemaVersion === undefined ? {} : { schemaVersion: options.schemaVersion }),
  })
  // 13 §5：`AGENTSWS_HALT_FILE` 是桌面壳与服务进程共用的急停真源（启动读、变更写回）
  const haltEnv = options.env ?? process.env
  const haltPath = haltEnv.AGENTSWS_HALT_FILE
  const halt = new MemoryHalt(
    haltEnv,
    haltPath === undefined || haltPath.trim() === '' ? {} : { file: haltFileAt(haltPath.trim()) },
  )
  const trace = new KernelTrace({
    random,
    eventLog,
    ...(options.schemaVersion === undefined ? {} : { schemaVersion: options.schemaVersion }),
  })
  const modules = new ModuleRegistry(options.modules ?? {})

  const ctx = new Context()
  const fiber = await ctx.plugin(kernelServices, { eventLog, halt, trace, modules })

  let disposed = false
  return {
    ctx,
    eventLog,
    halt,
    trace,
    modules,
    async dispose() {
      if (disposed) return
      disposed = true
      await fiber.dispose()
      eventLog.close()
    },
  }
}
