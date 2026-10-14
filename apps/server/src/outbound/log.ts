/**
 * WP323（docs/102 §5，决策 665 / 666 / 667）：**发出记录**（固定能力）+ **记录去处**（通用机制）。
 *
 * 发出记录：
 * 1. 写入点（`server.ts` 的出站那一跳、社媒执行器、定时发布 / 群发）在**发送确认成功**那一刻调 {@link OutboundLog.record}；
 *    同一条（`source_key`）只记一次，不出卡。
 * 2. 对方的回复挂在那一行下面（{@link OutboundLog.addFollowUp}，按平台 id 认）；对方删了原话我们也清掉（667）。
 * 3. 查询 / 导出（CSV / JSON）。我们自己发的内容永远保留。
 *
 * 记录去处：
 * 1. 交代：AI 在运行里调工具（`tools.ts`）→ {@link OutboundLog.inspect} 读表头 → {@link OutboundLog.propose} 生成对照、
 *    用最近一条真实记录出一行预览、出一张「定规矩」卡（`policy_change` + `form: record_sink`）。
 * 2. 人点「记下」→ {@link OutboundLog.onDecided} 生效；之后每记一条，命中筛选的就排一笔写入。
 * 3. 写：临时错误自动退避重试；没权限 / 表没了 / 列对不上 → 停下、照实说、留在本地「待补写」，人点「补写」再来；
 *    列对不上时自动重读表头、重出一张「定规矩」卡。
 * 4. 停 / 开 / 删：删了连带清掉它排着的写入（不会再写）。
 */
import {
  type ApprovalItem,
  type Iso8601,
  type OutboundQuery,
  type OutboundRecord,
  type OutboundRecordInput,
  RECORD_SINK_FORM,
  type RecordSink,
  type RecordSinkView,
  type SinkErrorCode,
  type SinkFilter,
  type WorkspaceId,
} from '@agentsws/contracts'
import type { SinkAdapters } from './adapters.js'
import type { TargetColumn } from './mapping.js'
import type { OutboundStore } from './store.js'

/** 交代去处的那个人（卡发给谁、之后重出卡发给谁）。 */
export interface SinkActor {
  person_id: string
  assignment_id?: string
  role_id?: string
  matter_id?: string
}

/** 「定规矩」卡要的那一份（由宿主建卡：路由、额度、去重归它）。 */
export interface SinkCardInput {
  workspace_id: WorkspaceId
  sink: RecordSink
  actor: SinkActor
  /** 预览那一行：[列名, 值]。 */
  preview: [string, string][]
  /** 预览用的是真实记录还是示例。 */
  sample: boolean
  /** 改规矩（已有的去处出新对照）。 */
  revision: boolean
  /** 列变了自动重出的那种。 */
  reason?: 'columns_changed'
}

export interface OutboundLogOptions {
  store: OutboundStore
  adapters: SinkAdapters
  now(): Iso8601
  /** 新 id（`prefix` + 随机）。 */
  newId(prefix: string): string
  /** 本地时区（分钟；东八区 480）。日期列按它排。 */
  tzOffsetMinutes?(workspace_id: WorkspaceId): number
  /** 记一条事件（只有 id 与种类，不含正文）。 */
  emit?(workspace_id: WorkspaceId, type: string, payload: Record<string, unknown>): void
  /** 出「定规矩」卡；回卡 id（没出成 = undefined）。 */
  stageCard?(input: SinkCardInput): Promise<string | undefined>
  /** 撤掉一张还没定的卡（删去处时）。 */
  withdrawCard?(card_id: string): Promise<void>
}

export type InspectResult =
  | {
      ok: true
      adapter: string
      title?: string
      columns: TargetColumn[]
      samples: string[][]
      fields: { id: string; zh: string }[]
    }
  | { ok: false; code: SinkErrorCode | 'unknown_link'; message: string; hint?: string }

export interface ProposeInput {
  url: string
  instruction: string
  name?: string
  /** AI 给的对照（列名 → `{ field, format? }` / `{ value }` / `{ empty: true }`）。不给 = 按表头猜。 */
  columns?: { column: string; source: unknown }[]
  filter?: SinkFilter
  /** 改哪一个已有的去处（不给就按链接认：同一张表就是改）。 */
  sink_id?: string
  actor: SinkActor
}

export type ProposeResult =
  | {
      ok: true
      sink_id: string
      name: string
      revision: boolean
      card_id?: string
      columns: { column: string; fill: string }[]
      unknown: string[]
      empty: string[]
      preview: [string, string][]
      sample: boolean
    }
  | {
      ok: false
      code: SinkErrorCode | 'unknown_link' | 'no_columns'
      message: string
      hint?: string
    }

export interface OutboundLog {
  record(workspace_id: WorkspaceId, input: OutboundRecordInput): OutboundRecord
  get(workspace_id: WorkspaceId, id: string): OutboundRecord | undefined
  list(workspace_id: WorkspaceId, query?: OutboundQuery): OutboundRecord[]
  export(
    workspace_id: WorkspaceId,
    format: 'csv' | 'json',
    query?: OutboundQuery,
  ): { filename: string; content: string; count: number }
  addFollowUp(
    workspace_id: WorkspaceId,
    input: {
      parent_external_id: string
      author?: string
      text?: string
      url?: string
      external_id?: string
      at?: Iso8601
      approval_item_id?: string
    },
  ): OutboundRecord | undefined
  /** 对方删了原话（平台 id）→ 清掉我们这边存的原话，标「对方已删」。回改了几行。 */
  counterpartDeleted(workspace_id: WorkspaceId, external_id: string): number
  sinks(workspace_id: WorkspaceId): RecordSinkView[]
  inspect(workspace_id: WorkspaceId, url: string): Promise<InspectResult>
  propose(workspace_id: WorkspaceId, input: ProposeInput): Promise<ProposeResult>
  /** 「定规矩」卡被决定了（不是这种卡什么都不做）。 */
  onDecided(item: ApprovalItem): Promise<void>
  pause(workspace_id: WorkspaceId, id: string): RecordSinkView | undefined
  resume(workspace_id: WorkspaceId, id: string): RecordSinkView | undefined
  remove(workspace_id: WorkspaceId, id: string): Promise<boolean>
  /** 补写：把待补写的全部再试一次。回这一次写进去几条。 */
  retry(workspace_id: WorkspaceId, id: string): Promise<number>
  /** 写到点了的（定时那一拍与记一条之后都会调）。回写进去几条。 */
  flush(): Promise<number>
  /** 开定时（每分钟看一次到点的写入）。 */
  start(intervalMs?: number): void
  close(): void
}

/** 临时错误的退避（毫秒）：30 秒、2 分、10 分、30 分、2 小时，之后每 6 小时。 */
export const SINK_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000]

export const isRecordSinkCard = (item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean =>
  item.kind === 'policy_change' &&
  typeof item.payload === 'object' &&
  item.payload !== null &&
  (item.payload as Record<string, unknown>).form === RECORD_SINK_FORM

export { createOutboundLog } from './log-impl.js'
