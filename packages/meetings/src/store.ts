/**
 * `MeetingStore` 的内存档。SQLite 档（`sqlite-store.ts`）跑同一份一致性套件。
 * 时间经注入的 `Clock`，id 经注入的 seed（35 §2）。
 */
import type {
  Clock,
  Meeting,
  MeetingCreateInput,
  MeetingEraseResult,
  MeetingFilter,
  MeetingId,
  MeetingOutputs,
  MeetingPatch,
  MeetingRecord,
  MeetingRecordCreateInput,
  MeetingRecordId,
  MeetingRecordPatch,
  MeetingStore,
  WorkspaceId,
} from '@agentsws/contracts'
import { MeetingError } from './errors.js'
import { createIdFactory, type IdFactory } from './ids.js'
import {
  byStartDesc,
  defaultSensitivity,
  type EraseSubject,
  matchesFilter,
  matchesSubject,
  redactOutputs,
  redactRecord,
  subjectAliases,
} from './store-logic.js'

export interface MeetingStoreOptions {
  clock: Clock
  random?: () => number
}

export class MemoryMeetingStore implements MeetingStore {
  readonly #meetings = new Map<MeetingId, Meeting>()
  readonly #records = new Map<MeetingRecordId, MeetingRecord>()
  /** meeting_id → 该会议历次产出（按落库顺序）。 */
  readonly #outputs = new Map<MeetingId, MeetingOutputs[]>()
  readonly #clock: Clock
  readonly #id: IdFactory

  constructor(options: MeetingStoreOptions) {
    this.#clock = options.clock
    this.#id = createIdFactory(options)
  }

  createMeeting(input: MeetingCreateInput): Meeting {
    const now = this.#clock.now()
    const id = input.id ?? this.#id('mtg')
    if (this.#meetings.has(id))
      throw new MeetingError('conflict', `会议已存在：${id}`, { meeting_id: id })
    const { id: _drop, sensitivity, ...rest } = input
    const meeting: Meeting = {
      ...rest,
      id,
      schema_version: 1,
      records: [],
      sensitivity: sensitivity ?? defaultSensitivity(input.participants),
      created_at: now,
      updated_at: now,
    }
    this.#meetings.set(id, meeting)
    return meeting
  }

  getMeeting(id: MeetingId): Meeting | undefined {
    return this.#meetings.get(id)
  }

  listMeetings(filter: MeetingFilter): Meeting[] {
    const rows = [...this.#meetings.values()].filter((m) => matchesFilter(m, filter))
    rows.sort(byStartDesc)
    return filter.limit === undefined ? rows : rows.slice(0, filter.limit)
  }

  updateMeeting(id: MeetingId, patch: MeetingPatch): Meeting {
    const current = this.#require(id)
    const next: Meeting = { ...current, ...patch, updated_at: this.#clock.now() }
    // 改了与会者又没显式给敏感级 → 重算（外部人进来就升到 restricted）
    if (patch.participants !== undefined && patch.sensitivity === undefined)
      next.sensitivity = defaultSensitivity(patch.participants)
    this.#meetings.set(id, next)
    return next
  }

  deleteMeeting(id: MeetingId): boolean {
    const meeting = this.#meetings.get(id)
    if (meeting === undefined) return false
    for (const rid of meeting.records) this.#records.delete(rid)
    this.#outputs.delete(id)
    this.#meetings.delete(id)
    return true
  }

  addRecord(input: MeetingRecordCreateInput): MeetingRecord {
    const meeting = this.#require(input.meeting_id)
    const now = this.#clock.now()
    const id = input.id ?? this.#id('mrec')
    if (this.#records.has(id))
      throw new MeetingError('conflict', `会议记录已存在：${id}`, { record_id: id })
    const { id: _drop, status, ...rest } = input
    const record: MeetingRecord = {
      ...rest,
      id,
      schema_version: 1,
      status: status ?? 'ingested',
      created_at: now,
      updated_at: now,
    }
    this.#records.set(id, record)
    this.#meetings.set(meeting.id, {
      ...meeting,
      records: [...meeting.records, id],
      updated_at: now,
    })
    return record
  }

  getRecord(id: MeetingRecordId): MeetingRecord | undefined {
    return this.#records.get(id)
  }

  records(meeting_id: MeetingId): MeetingRecord[] {
    const meeting = this.#meetings.get(meeting_id)
    if (meeting === undefined) return []
    return meeting.records
      .map((rid) => this.#records.get(rid))
      .filter((r): r is MeetingRecord => r !== undefined)
  }

  updateRecord(id: MeetingRecordId, patch: MeetingRecordPatch): MeetingRecord {
    const current = this.#records.get(id)
    if (current === undefined)
      throw new MeetingError('not_found', `会议记录不存在：${id}`, { record_id: id })
    const next: MeetingRecord = { ...current, ...patch, updated_at: this.#clock.now() }
    this.#records.set(id, next)
    return next
  }

  putOutputs(outputs: MeetingOutputs): MeetingOutputs {
    const meeting = this.#require(outputs.meeting_id)
    const list = this.#outputs.get(outputs.meeting_id) ?? []
    // 同一条记录重复处理 → 覆盖它自己那条，不叠加
    const idx = list.findIndex((o) => o.record_id === outputs.record_id)
    if (idx >= 0) list[idx] = outputs
    else list.push(outputs)
    this.#outputs.set(outputs.meeting_id, list)
    this.#meetings.set(meeting.id, { ...meeting, outputs, updated_at: this.#clock.now() })
    return outputs
  }

  outputs(meeting_id: MeetingId): MeetingOutputs[] {
    return [...(this.#outputs.get(meeting_id) ?? [])]
  }

  eraseParticipant(input: {
    workspace_id: WorkspaceId
    person_id?: string
    email?: string
    name?: string
  }): MeetingEraseResult {
    const subject: EraseSubject = {
      ...(input.person_id === undefined ? {} : { person_id: input.person_id }),
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.name === undefined ? {} : { name: input.name }),
    }
    const result: MeetingEraseResult = {
      meetings: [],
      records: [],
      raw_refs: [],
      outputs_redacted: 0,
    }
    if (Object.keys(subject).length === 0)
      throw new MeetingError('invalid_input', 'eraseParticipant 至少要给一个身份字段')
    const now = this.#clock.now()
    for (const meeting of this.#meetings.values()) {
      if (meeting.workspace_id !== input.workspace_id) continue
      const aliases = subjectAliases(subject, meeting.participants)
      const kept = meeting.participants.filter((p) => !matchesSubject(p, subject))
      const isParticipant = kept.length !== meeting.participants.length
      // 不是与会者但当过录音人（把录音交上来的人）也要走
      const ownRecords = this.records(meeting.id).filter(
        (r) => subject.person_id !== undefined && r.consent.recorded_by === subject.person_id,
      )
      if (!isParticipant && ownRecords.length === 0) continue

      result.meetings.push(meeting.id)
      this.#meetings.set(meeting.id, { ...meeting, participants: kept, updated_at: now })

      for (const record of this.records(meeting.id)) {
        const redacted = redactRecord(record, subject, aliases)
        if (!redacted.changed) continue
        this.#records.set(record.id, { ...redacted.record, updated_at: now })
        result.records.push(record.id)
        if (redacted.raw_ref !== undefined) result.raw_refs.push(redacted.raw_ref)
      }

      const list = this.#outputs.get(meeting.id)
      if (list !== undefined) {
        const next = list.map((o) => {
          const r = redactOutputs(o, aliases)
          result.outputs_redacted += r.removed
          return r.outputs
        })
        this.#outputs.set(meeting.id, next)
        const latest = next[next.length - 1]
        const current = this.#meetings.get(meeting.id)
        if (latest !== undefined && current !== undefined)
          this.#meetings.set(meeting.id, { ...current, outputs: latest })
      }
    }
    return result
  }

  #require(id: MeetingId): Meeting {
    const meeting = this.#meetings.get(id)
    if (meeting === undefined)
      throw new MeetingError('not_found', `会议不存在：${id}`, { meeting_id: id })
    return meeting
  }
}

export function createMemoryMeetingStore(options: MeetingStoreOptions): MemoryMeetingStore {
  return new MemoryMeetingStore(options)
}
