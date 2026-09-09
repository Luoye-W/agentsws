/**
 * 会议内核（37 §4）。
 *
 * 四条纪律，写在类型上：
 * ① **记录先进受控原始材料区**（18 §2.1：加密、保留期、随主体删除）——`MeetingRecordMedia.raw_ref`
 *    指向它；原始音视频永不进模型，进模型的只有转写文本，且必须**围栏包裹**。
 * ② **音频永不进事件日志**：只记 `sha256` / `duration_ms` / `bytes`（22 的 ASR 槽同此约束）。
 * ③ **有外部参与者默认 `restricted`**；`consent.notice_given === false` 时拒绝转写外部人的录音。
 * ④ **产出不直接落库**：待办以 `claim` 审批项（06 §2 认领管道）发出，本人确认前不形成责任
 *    （31 I13）；知识走 `knowledge_update`；边界答案走 `policy_change`。
 *
 * 功能分三层（37 §4.2）：内核自带的免费默认会议助手 / 我们的付费增强 / 第三方应用；
 * 三层共用 `MeetingRecordSource`（记录从哪来）与 `MeetingProcessor`（转写 → 产出）两个扩展点，
 * 免费默认版就是用同一套扩展点实现的第一个应用，保证第三方能替换或叠加（23）。
 */

import type {
  Iso8601,
  MaybePromise,
  ObjectRef,
  PersonId,
  PositionId,
  RangeRef,
  Sensitivity,
  WorkspaceId,
} from './common.js'
import type { KnowledgeLayer } from './knowledge.js'
import type { MatterId } from './work.js'

export type MeetingId = string
export type MeetingRecordId = string
/** 37 §2.2b 事项（= 正名后的 work_item）；会议跟进的「事项」由 WP22 承接，这里只留可空引用。 */

/* ------------------------------------------------------------------ */
/* 会议                                                                 */
/* ------------------------------------------------------------------ */

export interface MeetingParticipant {
  person_id?: PersonId
  name?: string
  email?: string
  /** 公司外的人。任一为 true → 会议默认 `restricted`（37 §4 C4）。 */
  external?: boolean
}

export type MeetingLocation = string | { online: string }

export interface MeetingCalendarRef {
  source: 'google' | 'outlook' | 'feishu' | 'ics' | 'local'
  event_id: string
}

export type MeetingStatus = 'scheduled' | 'in_progress' | 'done' | 'cancelled'

export interface Meeting {
  id: MeetingId
  schema_version: 1
  workspace_id: WorkspaceId
  position_id?: PositionId
  title: string
  start: Iso8601
  end: Iso8601
  location?: MeetingLocation
  participants: MeetingParticipant[]
  agenda?: string
  /**
   * 记录 id 列表。记录本体（可能带大段转写）经 `MeetingStore.records()` 单独取，
   * 列表响应不驮着它们走（37 §4.1 的 `records: MeetingRecord[]` 在读模型里才组装）。
   */
  records: MeetingRecordId[]
  /** 最近一次处理的产出；每条记录的历史产出在 `MeetingStore.outputs()` 里。 */
  outputs?: MeetingOutputs
  calendar_ref?: MeetingCalendarRef
  sensitivity: Sensitivity
  scope?: RangeRef[]
  /** 会议跟进的事项（37 §2.2b）；WP22 的对象承接，可空。 */
  matter_id?: MatterId
  status: MeetingStatus
  created_by: PersonId
  created_at: Iso8601
  updated_at: Iso8601
}

/* ------------------------------------------------------------------ */
/* 记录：六种来源                                                        */
/* ------------------------------------------------------------------ */

/** 37 §4.1 六种记录来源。 */
export type MeetingRecordSourceKind =
  /** 线上会议平台：飞书 / 腾讯会议 / Zoom / Teams 的录制与转写导出 */
  | 'online_meeting'
  /** 我们自己录：桌面壳 / 浏览器 MediaRecorder → 转写 */
  | 'in_app_recording'
  /** 外出开会：Plaud 等录音设备 / 手机录音 */
  | 'device'
  /** Plaud / Otter / 妙记 等第三方工具的接入 */
  | 'third_party'
  /** 别人给过来的会议记录（文档、消息粘贴） */
  | 'handed_over'
  /** 人手写的笔记 */
  | 'manual_notes'

export const MEETING_RECORD_SOURCES: readonly MeetingRecordSourceKind[] = [
  'online_meeting',
  'in_app_recording',
  'device',
  'third_party',
  'handed_over',
  'manual_notes',
]

export interface MeetingRecordMedia {
  kind: 'audio' | 'video' | 'transcript' | 'document'
  /** 受控原始材料区（18 §2.1）的引用；**内容永不进模型，也永不进事件日志**。 */
  raw_ref: string
  mime?: string
  name?: string
  /** 已知语种（BCP-47 / 'zh' / 'en'）；转写时透给 ASR provider。 */
  language?: string
  /** 音频指纹：事件日志里只允许出现它，不允许出现字节（22 ASR 槽）。 */
  sha256?: string
  duration_ms?: number
  bytes?: number
}

export interface TranscriptSegment {
  start_ms: number
  end_ms: number
  speaker?: string
  text: string
}

export interface MeetingTranscript {
  /** 已围栏之前的原文；进模型前必须经 `Fence.fencePayload` 包裹。 */
  text: string
  segments?: TranscriptSegment[]
  speakers?: string[]
  language?: string
}

/** 录外部人要有告知（37 §4.1）。`notice_given === false` 时拒绝转写。 */
export interface MeetingConsent {
  recorded_by: PersonId
  notice_given: boolean
  notice_at?: Iso8601
}

export type MeetingRecordStatus = 'ingested' | 'transcribed' | 'processed' | 'failed'

export interface MeetingRecord {
  id: MeetingRecordId
  schema_version: 1
  workspace_id: WorkspaceId
  meeting_id: MeetingId
  source: MeetingRecordSourceKind
  media?: MeetingRecordMedia
  transcript?: MeetingTranscript
  consent: MeetingConsent
  status: MeetingRecordStatus
  /** `status === 'failed'` 时的人话原因（如 `consent_missing`）。 */
  error?: string
  sensitivity: Sensitivity
  /** 谁 / 哪个扩展点送进来的。 */
  ingested_by: { kind: 'person' | 'agent' | 'system'; id: string }
  created_at: Iso8601
  updated_at: Iso8601
}

/* ------------------------------------------------------------------ */
/* 产出                                                                 */
/* ------------------------------------------------------------------ */

/** 06 §2 认领管道的言语状态（31 I13）：本人确认前都不形成责任，也不进考核。 */
export type SpeechState = 'suggested' | 'confirmed' | 'assigned'

/** 每条产出都带出处（19 §1.1 provenance 的会议形态：会议 + 时间点 + 原话）。 */
export interface MeetingProvenance {
  record_id: MeetingRecordId
  /** 原话；已经过围栏清洗，可以直接显示给人。 */
  quote: string
  speaker?: string
  at_ms?: number
}

export interface MeetingDecision {
  id: string
  text: string
  provenance: MeetingProvenance
}

/** 待办**提案**，不是待办。落地要经 `claim` 审批项，本人确认才形成责任。 */
export interface MeetingTodoProposal {
  id: string
  text: string
  /** 原文点到的人（名字 / 邮箱 / person_id 任一命中）。 */
  assignee_hint?: string
  assignee_person_id?: PersonId
  speech_state: SpeechState
  /** 为什么只到这个状态（如 `assignee_not_in_meeting`、`high_risk_action`）。 */
  speech_state_reasons: string[]
  due?: Iso8601
  provenance: MeetingProvenance
}

export interface MeetingBoundaryAnswer {
  id: string
  /** 会上被问到的业务边界问题。 */
  question: string
  answer: string
  provenance: MeetingProvenance
}

export interface MeetingKnowledgeCandidate {
  id: string
  layer: KnowledgeLayer
  question: string
  statement: string
  /** 非空即必须人审（19 §2 三层三种更新权限）。 */
  hold_reasons: string[]
  provenance: MeetingProvenance
}

export interface MeetingNextMeeting {
  title?: string
  start?: Iso8601
  note?: string
  provenance: MeetingProvenance
}

/** 37 §4.1 `Meeting.outputs`：决定 / 待办提案 / 边界答案 / 知识候选 / 下次会议。 */
export interface MeetingOutputs {
  meeting_id: MeetingId
  record_id: MeetingRecordId
  decisions: MeetingDecision[]
  todos: MeetingTodoProposal[]
  boundary_answers: MeetingBoundaryAnswer[]
  knowledge: MeetingKnowledgeCandidate[]
  next_meeting?: MeetingNextMeeting
  /** 哪个 `MeetingProcessor` 产的（免费默认版 = `agentsws/default-meeting-assistant`）。 */
  processor: string
  produced_at: Iso8601
}

/* ------------------------------------------------------------------ */
/* 存储                                                                 */
/* ------------------------------------------------------------------ */

export interface MeetingFilter {
  workspace_id: WorkspaceId
  /** 与会者（person_id / email / name 任一命中）。 */
  participant?: string
  status?: MeetingStatus[]
  from?: Iso8601
  to?: Iso8601
  limit?: number
}

export type MeetingCreateInput = Omit<
  Meeting,
  'id' | 'schema_version' | 'records' | 'outputs' | 'created_at' | 'updated_at' | 'sensitivity'
> & { id?: MeetingId; sensitivity?: Sensitivity }

export type MeetingPatch = Partial<
  Pick<
    Meeting,
    | 'title'
    | 'start'
    | 'end'
    | 'location'
    | 'participants'
    | 'agenda'
    | 'calendar_ref'
    | 'sensitivity'
    | 'matter_id'
    | 'status'
    | 'position_id'
    | 'scope'
  >
>

export type MeetingRecordCreateInput = Omit<
  MeetingRecord,
  'id' | 'schema_version' | 'status' | 'created_at' | 'updated_at'
> & { id?: MeetingRecordId; status?: MeetingRecordStatus }

export type MeetingRecordPatch = Partial<
  Pick<MeetingRecord, 'media' | 'transcript' | 'status' | 'error' | 'sensitivity' | 'consent'>
>

/** 主体删除（21 §4）的会议侧结果：改了哪些会议、抹了哪些原始材料。 */
export interface MeetingEraseResult {
  meetings: MeetingId[]
  records: MeetingRecordId[]
  raw_refs: string[]
  /** 从产出里摘掉的条目数（发言人是该主体的决定 / 待办提案 / 知识候选）。 */
  outputs_redacted: number
}

export interface MeetingStore {
  createMeeting(input: MeetingCreateInput): MaybePromise<Meeting>
  getMeeting(id: MeetingId): MaybePromise<Meeting | undefined>
  listMeetings(filter: MeetingFilter): MaybePromise<Meeting[]>
  updateMeeting(id: MeetingId, patch: MeetingPatch): MaybePromise<Meeting>
  deleteMeeting(id: MeetingId): MaybePromise<boolean>

  addRecord(input: MeetingRecordCreateInput): MaybePromise<MeetingRecord>
  getRecord(id: MeetingRecordId): MaybePromise<MeetingRecord | undefined>
  records(meeting_id: MeetingId): MaybePromise<MeetingRecord[]>
  updateRecord(id: MeetingRecordId, patch: MeetingRecordPatch): MaybePromise<MeetingRecord>

  putOutputs(outputs: MeetingOutputs): MaybePromise<MeetingOutputs>
  outputs(meeting_id: MeetingId): MaybePromise<MeetingOutputs[]>

  /** 21 §4 随主体删除。 */
  eraseParticipant(input: {
    workspace_id: WorkspaceId
    person_id?: PersonId
    email?: string
    name?: string
  }): MaybePromise<MeetingEraseResult>
}

/* ------------------------------------------------------------------ */
/* 扩展点 ①：记录来源（23 `meeting.record_source`）                       */
/* ------------------------------------------------------------------ */

/** 一份还没落库的记录（扩展点产出这个，宿主负责落受控区并建 `MeetingRecord`）。 */
export interface MeetingRecordDraft {
  source: MeetingRecordSourceKind
  /** 二选一：给字节（宿主落受控区）或给已经落好的 `media`。 */
  bytes?: Uint8Array
  mime?: string
  name?: string
  media?: MeetingRecordMedia
  transcript?: MeetingTranscript
  consent: MeetingConsent
  sensitivity?: Sensitivity
  /** 命中的会议（外部日历事件 id / 我们的 meeting id）；没有则由宿主决定挂到哪。 */
  meeting_id?: MeetingId
  calendar_ref?: MeetingCalendarRef
  /** 扩展点想附的说明（导入的文件名、设备型号……），只作展示。 */
  note?: string
}

export interface MeetingSourceContext {
  workspace_id: WorkspaceId
  /** 谁在拉 / 谁上传的；进 `consent.recorded_by` 的默认值。 */
  actor: PersonId
  now: Iso8601
}

export type MeetingRecordSourceMode = 'poll' | 'push' | 'device_sync' | 'manual'

/**
 * 记录来源扩展点。轮询（`poll`）/ 推送（`accept`）/ 设备同步（`sync`）三种拿法，
 * 一个实现按自己的形态挑着实现；宿主只认这三个方法。
 */
export interface MeetingRecordSource {
  /** 扩展点实例 id（付费增强与第三方包用 `<publisher>/<name>`）。 */
  id: string
  kind: MeetingRecordSourceKind
  mode: MeetingRecordSourceMode
  /** 轮询档：拉一批新记录（外部平台 / 第三方工具）。 */
  poll?(ctx: MeetingSourceContext): MaybePromise<MeetingRecordDraft[]>
  /** 推送 / 上传 / 粘贴档：外部投进来的载荷 → 草稿。 */
  accept?(payload: unknown, ctx: MeetingSourceContext): MaybePromise<MeetingRecordDraft[]>
  /** 设备同步档：从一个目录 / 挂载点里同步（Plaud 等）。 */
  sync?(ctx: MeetingSourceContext): MaybePromise<MeetingRecordDraft[]>
  health?(): MaybePromise<{ ok: boolean; detail?: string }>
}

/* ------------------------------------------------------------------ */
/* 扩展点 ②：处理器（23 `meeting.processor`）                             */
/* ------------------------------------------------------------------ */

/**
 * 处理器的入参。`fenced_text` 是**已经过围栏包裹**的转写（Model-visible ⟺ logged），
 * 处理器要么用规则读 `transcript`，要么把 `fenced_text` 原样喂给模型——两条路都不许
 * 把围栏拆掉，也不许把 `media` 的字节读进模型。
 */
export interface MeetingProcessorInput {
  meeting: Meeting
  record: MeetingRecord
  transcript: MeetingTranscript
  fenced_text: string
  now: Iso8601
}

/** 产出去掉宿主负责补的四个字段。 */
export type MeetingProcessorOutput = Omit<
  MeetingOutputs,
  'meeting_id' | 'record_id' | 'processor' | 'produced_at'
>

export interface MeetingProcessor {
  /** 扩展点实例 id；免费默认版 = `agentsws/default-meeting-assistant`。 */
  id: string
  name?: { zh: string; en: string }
  process(input: MeetingProcessorInput): MaybePromise<MeetingProcessorOutput>
}

/* ------------------------------------------------------------------ */
/* 产出 → 审批项 payload（14 §3）                                        */
/* ------------------------------------------------------------------ */

/**
 * 14 §3 `claim` 的 payload（`source: 'meeting'`）。
 * `speech_state` 是 31 I13 的三态：建议 / 已确认 / 明确指派；**本人确认前不形成责任**，
 * 路由结果也不得用于考核。
 */
export interface ClaimPayload {
  form: 'claim'
  claim_kind: 'action_item' | 'decision' | 'question' | 'data_request'
  source: 'meeting' | 'group' | 'email' | 'review'
  source_id: string
  text: string
  quote: string
  speaker?: string
  speech_state: SpeechState
  speech_state_reasons: string[]
  route_confidence: number
  due?: Iso8601
  /** 会议跟进的事项（WP22 承接后回填）。 */
  matter_id?: MatterId
  subject_ref?: ObjectRef
}
