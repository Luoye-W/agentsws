/**
 * 会议记录处理管线（37 §4.1）。一条线走完：
 *
 * ```
 * 来源扩展点 → 受控原始材料区（18 §2.1）→ 转写（经模型网关的 ASR 槽）
 *   → 围栏包裹（Model-visible ⟺ logged）→ 处理器扩展点 → MeetingOutputs
 *   → 认领卡 claim / 知识 knowledge_update / 边界 policy_change
 * ```
 *
 * 四条守住的：
 * - **原始音视频永不进模型**：进模型的只有转写文本，且先过 `EXTERNAL_FENCE`。
 * - **音频与转写正文永不进事件日志**：事件里只有哈希、时长、条数。
 * - **外部人在场且没告知录音 → 拒绝转写**，出一张系统卡（不是审批项：它没有"通过后施行什么"）。
 * - **产出不落库成待办**：只发认领卡，本人确认前不形成责任（31 I13）。
 */
import type {
  Clock,
  EventEnvelope,
  Meeting,
  MeetingOutputs,
  MeetingProcessor,
  MeetingRecord,
  MeetingRecordDraft,
  MeetingRecordSourceKind,
  MeetingSourceContext,
  MeetingStore,
  MeetingTranscript,
  ModelMeta,
  PersonId,
  Sensitivity,
  Transcription,
  WorkspaceId,
} from '@agentsws/contracts'
import { EXTERNAL_FENCE, type Fence } from '@agentsws/core'
import { defaultMeetingAssistant } from './assistant/processor.js'
import { MeetingError } from './errors.js'
import { createIdFactory, type IdFactory } from './ids.js'
import { approvalRequestsFor, type MeetingApprovalRequests } from './outputs.js'
import { bytesOf, type MeetingRawKind, type MeetingRawStore } from './raw-store.js'
import { createSourceRegistry, type MeetingSourceRegistry } from './sources/index.js'
import { hasExternalParticipant } from './store-logic.js'

/* ------------------------------------------------------------------ */
/* 事件与系统卡                                                          */
/* ------------------------------------------------------------------ */

export type MeetingEventType =
  | 'meeting.record.ingested'
  | 'meeting.record.blocked'
  | 'meeting.record.transcribed'
  | 'meeting.record.processed'
  | 'meeting.record.failed'

export type MeetingEvent = Omit<EventEnvelope<MeetingEventType, unknown>, 'id'>
export type MeetingEventSink = (event: MeetingEvent) => void

export type MeetingBlockReason = 'consent_missing' | 'no_transcriber' | 'transcribe_failed'

/**
 * 系统卡：不是审批项（14 §1「通过后施行什么」答不上来的就不是审批项，是通知）。
 * 工作台把它渲染在告警区，人处理完即消失。
 */
export interface MeetingSystemCard {
  id: string
  kind: 'system_alert'
  reason: MeetingBlockReason
  title: string
  body: string
  meeting_id: string
  record_id: string
  actions: { id: string; label: string }[]
}

const BLOCK_CARDS: Readonly<Record<MeetingBlockReason, { title: string; body: string }>> = {
  consent_missing: {
    title: '这段录音还不能转写：外部参与者没有录音告知',
    body:
      '这个会有公司外的人参加，而这份记录上没有记到「已告知录音」。' +
      '先补上告知（或确认对方已同意），再点一次处理；也可以只留原始文件不转写。',
  },
  no_transcriber: {
    title: '这段录音还不能转写：没有配置 ASR',
    body: '这个发行版没有装语音转写 provider。可以先粘贴 / 上传已有的转写文本。',
  },
  transcribe_failed: {
    title: '这段录音转写失败',
    body: '转写服务没有返回结果。原始文件还在受控材料区里，稍后可以再试一次。',
  },
}

/* ------------------------------------------------------------------ */
/* 管线                                                                 */
/* ------------------------------------------------------------------ */

/** 网关 `transcribe` 的最小投影：管线不认识网关，只认识这个函数。 */
export type TranscribeFn = (
  audio: { bytes: Uint8Array; mime: string; language?: string; duration_ms?: number },
  meta: ModelMeta,
) => Promise<Transcription>

export interface MeetingPipelineOptions {
  store: MeetingStore
  raw: MeetingRawStore
  clock: Clock
  sources?: MeetingSourceRegistry
  processor?: MeetingProcessor
  /** 不给就只能处理"已经带转写"的记录（发行版没装 ASR 时的免费默认档）。 */
  transcribe?: TranscribeFn
  /** 记账用的 meta（22 §3 按 (workspace, assignment, role, run) 记账）。 */
  modelMeta?: (input: { meeting: Meeting; record: MeetingRecord }) => ModelMeta
  eventSink?: MeetingEventSink
  random?: () => number
  /** 默认 `EXTERNAL_FENCE`；测试里可以换一个 label 验证围栏确实包了。 */
  fence?: Fence
}

export interface IngestInput {
  workspace_id: WorkspaceId
  meeting_id: string
  actor: PersonId
  source: MeetingRecordSourceKind
  payload: unknown
}

export interface ProcessResult {
  record: MeetingRecord
  outputs?: MeetingOutputs
  approvals?: MeetingApprovalRequests
  /** 被拦下来时给的系统卡（外部人没告知录音 / 没装 ASR / 转写失败）。 */
  system_card?: MeetingSystemCard
}

const RAW_KIND: Readonly<Record<string, MeetingRawKind>> = {
  audio: 'audio',
  video: 'video',
  text: 'document',
  application: 'document',
}

function rawKindOf(mime: string | undefined, hasTranscript: boolean): MeetingRawKind {
  if (hasTranscript) return 'transcript'
  const top = (mime ?? '').split('/')[0] ?? ''
  return RAW_KIND[top] ?? 'document'
}

export class MeetingPipeline {
  readonly #o: MeetingPipelineOptions
  readonly #id: IdFactory
  readonly #sources: MeetingSourceRegistry
  readonly #processor: MeetingProcessor
  readonly #fence: Fence

  constructor(options: MeetingPipelineOptions) {
    this.#o = options
    this.#id = createIdFactory(options)
    this.#sources = options.sources ?? createSourceRegistry()
    this.#processor = options.processor ?? defaultMeetingAssistant()
    this.#fence = options.fence ?? EXTERNAL_FENCE
  }

  get processor(): MeetingProcessor {
    return this.#processor
  }

  get sources(): MeetingSourceRegistry {
    return this.#sources
  }

  #emit(type: MeetingEventType, meeting: Meeting, record: MeetingRecord, payload: unknown): void {
    this.#o.eventSink?.({
      schema_version: 1,
      workspace_id: meeting.workspace_id,
      type,
      at: this.#o.clock.now(),
      actor: { kind: record.ingested_by.kind, id: record.ingested_by.id },
      subject: { type: 'meeting_record', id: record.id },
      correlation: { trace_id: record.id },
      payload,
    })
  }

  /** 来源扩展点 → 受控原始材料区 → `MeetingRecord`（还没转写、没处理）。 */
  async ingest(input: IngestInput): Promise<MeetingRecord[]> {
    const meeting = await this.#requireMeeting(input.meeting_id)
    if (meeting.workspace_id !== input.workspace_id)
      throw new MeetingError('forbidden', '会议不属于这个工作区', { meeting_id: meeting.id })
    const source = this.#sources.get(input.source)
    if (source.accept === undefined)
      throw new MeetingError('not_implemented', `这个来源不接受直接投递：${input.source}`, {
        source: input.source,
      })
    const ctx: MeetingSourceContext = {
      workspace_id: input.workspace_id,
      actor: input.actor,
      now: this.#o.clock.now(),
    }
    const drafts = await source.accept(input.payload, ctx)
    const out: MeetingRecord[] = []
    for (const draft of drafts) out.push(await this.#store(meeting, draft, input.actor))
    return out
  }

  /** 已经是草稿（轮询 / 设备同步拿到的）→ 落库。 */
  async ingestDraft(
    meeting_id: string,
    draft: MeetingRecordDraft,
    actor: PersonId,
  ): Promise<MeetingRecord> {
    return this.#store(await this.#requireMeeting(meeting_id), draft, actor)
  }

  async #store(
    meeting: Meeting,
    draft: MeetingRecordDraft,
    actor: PersonId,
  ): Promise<MeetingRecord> {
    const now = this.#o.clock.now()
    let media = draft.media
    if (media === undefined && draft.bytes !== undefined) {
      const kind = rawKindOf(draft.mime, draft.transcript !== undefined)
      const ref = await this.#o.raw.put({
        workspace_id: meeting.workspace_id,
        kind,
        stored_at: now,
        payload: draft.bytes,
        ...(draft.mime === undefined ? {} : { mime: draft.mime }),
        ...(draft.name === undefined ? {} : { name: draft.name }),
      })
      media = {
        kind,
        raw_ref: ref,
        ...(draft.mime === undefined ? {} : { mime: draft.mime }),
        ...(draft.name === undefined ? {} : { name: draft.name }),
        bytes: draft.bytes.byteLength,
      }
    }
    // 记录的敏感级不低于会议本身（外部人在场 → restricted）
    const sensitivity: Sensitivity = draft.sensitivity ?? meeting.sensitivity
    const record = await this.#o.store.addRecord({
      workspace_id: meeting.workspace_id,
      meeting_id: meeting.id,
      source: draft.source,
      ...(media === undefined ? {} : { media }),
      ...(draft.transcript === undefined ? {} : { transcript: draft.transcript }),
      consent: draft.consent,
      status: draft.transcript === undefined ? 'ingested' : 'transcribed',
      sensitivity,
      ingested_by: { kind: 'person', id: actor },
    })
    this.#emit('meeting.record.ingested', meeting, record, {
      source: record.source,
      // 正文不进日志：只报有没有、多长
      has_transcript: record.transcript !== undefined,
      transcript_chars: record.transcript?.text.length ?? 0,
      media_kind: media?.kind,
      media_bytes: media?.bytes,
      raw_ref: media?.raw_ref,
      notice_given: record.consent.notice_given,
      sensitivity,
    })
    return record
  }

  /** 转写 → 围栏 → 处理器 → 产出 + 认领卡。 */
  async process(record_id: string): Promise<ProcessResult> {
    const record = await this.#o.store.getRecord(record_id)
    if (record === undefined)
      throw new MeetingError('not_found', `会议记录不存在：${record_id}`, { record_id })
    const meeting = await this.#requireMeeting(record.meeting_id)

    let current = record
    if (current.transcript === undefined) {
      const blocked = this.#blockReason(meeting, current)
      if (blocked !== undefined) return this.#block(meeting, current, blocked)
      const transcribed = await this.#transcribe(meeting, current)
      if ('card' in transcribed) return transcribed.result
      current = transcribed.record
    }

    const transcript = current.transcript as MeetingTranscript
    // 进模型的一切外部文本都在这里包上围栏（Commerce Agents 移植版）
    const fenced_text = this.#fence.fencePayload(transcript.text)
    const now = this.#o.clock.now()
    const produced = await this.#processor.process({
      meeting,
      record: current,
      transcript,
      fenced_text,
      now,
    })
    const outputs: MeetingOutputs = {
      ...produced,
      meeting_id: meeting.id,
      record_id: current.id,
      processor: this.#processor.id,
      produced_at: now,
    }
    await this.#o.store.putOutputs(outputs)
    current = await this.#o.store.updateRecord(current.id, { status: 'processed' })
    const approvals = approvalRequestsFor(outputs, meeting)
    this.#emit('meeting.record.processed', meeting, current, {
      processor: this.#processor.id,
      // 条数进日志，正文不进
      decisions: outputs.decisions.length,
      todos: outputs.todos.length,
      boundary_answers: outputs.boundary_answers.length,
      knowledge: outputs.knowledge.length,
      claims: approvals.claims.length,
      speech_states: outputs.todos.map((t) => t.speech_state),
    })
    return { record: current, outputs, approvals }
  }

  #blockReason(meeting: Meeting, record: MeetingRecord): MeetingBlockReason | undefined {
    // 37 §4 C4：外部人在场 + 没有录音告知 → 不转写
    if (hasExternalParticipant(meeting) && !record.consent.notice_given) return 'consent_missing'
    if (record.media === undefined) return 'no_transcriber'
    if (this.#o.transcribe === undefined) return 'no_transcriber'
    return undefined
  }

  #block(meeting: Meeting, record: MeetingRecord, reason: MeetingBlockReason): ProcessResult {
    const copy = BLOCK_CARDS[reason]
    const card: MeetingSystemCard = {
      id: this.#id('mcard'),
      kind: 'system_alert',
      reason,
      title: copy.title,
      body: copy.body,
      meeting_id: meeting.id,
      record_id: record.id,
      actions:
        reason === 'consent_missing'
          ? [
              { id: 'mark_notice_given', label: '已经告知过了，继续转写' },
              { id: 'keep_raw_only', label: '只留原始文件，不转写' },
            ]
          : [{ id: 'dismiss', label: '知道了' }],
    }
    this.#emit('meeting.record.blocked', meeting, record, { reason })
    return { record, system_card: card }
  }

  async #transcribe(
    meeting: Meeting,
    record: MeetingRecord,
  ): Promise<{ record: MeetingRecord } | { card: true; result: ProcessResult }> {
    const transcribe = this.#o.transcribe as TranscribeFn
    const media = record.media
    if (media === undefined)
      return { card: true, result: this.#block(meeting, record, 'no_transcriber') }
    const raw = await this.#o.raw.get(media.raw_ref)
    if (raw === undefined)
      throw new MeetingError('not_found', `原始材料不在受控区里：${media.raw_ref}`, {
        raw_ref: media.raw_ref,
      })
    const meta = this.#o.modelMeta?.({ meeting, record }) ?? {
      workspace_id: meeting.workspace_id,
      assignment_id: meeting.position_id ?? 'unassigned',
      role_id: 'common.member',
      run_id: record.id,
      purpose: 'transcription',
    }
    let result: Transcription
    try {
      result = await transcribe(
        {
          bytes: bytesOf(raw),
          mime: media.mime ?? raw.mime ?? 'application/octet-stream',
          ...(media.language === undefined ? {} : { language: media.language }),
          ...(media.duration_ms === undefined ? {} : { duration_ms: media.duration_ms }),
        },
        meta,
      )
    } catch (e) {
      const failed = await this.#o.store.updateRecord(record.id, {
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
      })
      this.#emit('meeting.record.failed', meeting, failed, {
        reason: 'transcribe_failed',
        message: failed.error,
      })
      return { card: true, result: this.#block(meeting, failed, 'transcribe_failed') }
    }
    const transcript: MeetingTranscript = {
      text: result.text,
      segments: result.segments,
      ...(result.speakers === undefined ? {} : { speakers: result.speakers }),
      ...(result.language === undefined ? {} : { language: result.language }),
    }
    const updated = await this.#o.store.updateRecord(record.id, {
      transcript,
      status: 'transcribed',
      media: {
        ...media,
        sha256: result.audio.sha256,
        duration_ms: result.audio.duration_ms,
        bytes: result.audio.bytes,
      },
    })
    this.#emit('meeting.record.transcribed', meeting, updated, {
      // 21 §1「秘密从不进」的音频版：只有摘要与统计，没有字节也没有正文
      audio: result.audio,
      model: result.model,
      segments: result.segments.length,
      transcript_chars: result.text.length,
      speakers: result.speakers?.length ?? 0,
    })
    return { record: updated }
  }

  async #requireMeeting(id: string): Promise<Meeting> {
    const meeting = await this.#o.store.getMeeting(id)
    if (meeting === undefined)
      throw new MeetingError('not_found', `会议不存在：${id}`, { meeting_id: id })
    return meeting
  }
}

export function createMeetingPipeline(options: MeetingPipelineOptions): MeetingPipeline {
  return new MeetingPipeline(options)
}
