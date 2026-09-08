/**
 * Trace（28 §1「trace_id 贯穿 run→tool→action→apply→delivery」）。
 * v1 不引 OpenTelemetry：只做 id 生成 / 派生，加一个把 span 写进事件日志的辅助方法；
 * 采用 OTel 兼容的形状（32 hex 的 root，16 hex 的 span 段），将来换 OTel 不用改 id。
 */
import type {
  EventEnvelope,
  EventLog,
  ObjectRef,
  RunId,
  Trace,
  WorkspaceId,
} from '@agentsws/contracts'
import type { Random } from './clock.js'
import { KernelError } from './errors.js'
import { EVENT_SCHEMA_VERSION } from './event-log.js'

const HEX = [...'0123456789abcdef']
const ROOT_LEN = 32
const SPAN_LEN = 16
const SEPARATOR = '.'

export interface SpanEventInput<P = unknown> {
  workspace_id: WorkspaceId
  type: string
  payload: P
  /** 缺省新建一个 root trace_id。 */
  trace_id?: string
  actor?: EventEnvelope['actor']
  subject?: ObjectRef
  run_id?: RunId
  work_item_id?: string
  change_id?: string
  execution_id?: string
  schema_version?: number
}

export interface KernelTraceOptions {
  random: Random
  eventLog: EventLog
  schemaVersion?: number
}

export class KernelTrace implements Trace {
  private readonly random: Random
  private readonly eventLog: EventLog
  private readonly schemaVersion: number

  constructor(options: KernelTraceOptions) {
    this.random = options.random
    this.eventLog = options.eventLog
    this.schemaVersion = options.schemaVersion ?? EVENT_SCHEMA_VERSION
  }

  newTraceId(): string {
    return this.hex(ROOT_LEN)
  }

  /** 派生子 trace：保留 root 段，追加一个 span 段；多层派生不会丢 root。 */
  child(parent: string): string {
    if (typeof parent !== 'string' || parent.length === 0) {
      throw new KernelError('invalid_input', 'trace.child requires a non-empty parent trace id')
    }
    return `${rootOf(parent)}${SEPARATOR}${this.hex(SPAN_LEN)}`
  }

  /** 一条 span = 一条事件（09 §0「Model-visible ⟺ logged」）。返回写入后的信封。 */
  async spanEvent<P>(input: SpanEventInput<P>): Promise<EventEnvelope<string, P>> {
    const trace_id = input.trace_id ?? this.newTraceId()
    return this.eventLog.append<string, P>({
      schema_version: input.schema_version ?? this.schemaVersion,
      workspace_id: input.workspace_id,
      type: input.type,
      actor: input.actor ?? { kind: 'system', id: 'kernel' },
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      correlation: {
        trace_id,
        ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
        ...(input.work_item_id === undefined ? {} : { work_item_id: input.work_item_id }),
        ...(input.change_id === undefined ? {} : { change_id: input.change_id }),
        ...(input.execution_id === undefined ? {} : { execution_id: input.execution_id }),
      },
      payload: input.payload,
    })
  }

  private hex(length: number): string {
    let out = ''
    for (let i = 0; i < length; i++) {
      const r = this.random()
      if (!(r >= 0 && r < 1)) {
        throw new KernelError('invalid_input', `random source must return [0, 1), got ${r}`)
      }
      out += HEX[Math.floor(r * HEX.length)] ?? '0'
    }
    return out
  }
}

/** 取一条 trace id 的 root 段（同一条链上的所有 id root 相同）。 */
export function rootOf(traceId: string): string {
  const [root] = traceId.split(SEPARATOR)
  return root ?? traceId
}

/** 两个 trace id 是否属于同一条链。 */
export function sameTrace(a: string, b: string): boolean {
  return rootOf(a) === rootOf(b)
}
