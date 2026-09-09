/**
 * `MeetingStore` 的 SQLite 档。与内存档跑同一份契约一致性套件。
 * 本包只用自己这张库里的表，不共享其他包的表（35 §2）；同一个库开两次幂等。
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
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { MeetingError } from './errors.js'
import { createIdFactory, type IdFactory } from './ids.js'
import { type Migration, migrate, schemaVersion } from './migrations.js'
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

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meetings (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  start_ms     INTEGER NOT NULL,
  status       TEXT NOT NULL,
  doc          TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS meetings_by_ws ON meetings (workspace_id, start_ms DESC);

CREATE TABLE IF NOT EXISTS meeting_records (
  id         TEXT PRIMARY KEY NOT NULL,
  meeting_id TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  doc        TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS meeting_records_by_meeting ON meeting_records (meeting_id, ordinal);

CREATE TABLE IF NOT EXISTS meeting_outputs (
  meeting_id TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  doc        TEXT NOT NULL,
  PRIMARY KEY (meeting_id, record_id)
) STRICT;
CREATE INDEX IF NOT EXISTS meeting_outputs_by_meeting ON meeting_outputs (meeting_id, ordinal);
`,
  },
]

export interface SqliteMeetingStoreOptions {
  dbPath?: string
  clock: Clock
  random?: () => number
}

const EPOCH = '1970-01-01T00:00:00.000Z'

export class SqliteMeetingStore implements MeetingStore {
  readonly #db: Db
  readonly #clock: Clock
  readonly #id: IdFactory
  #closed = false
  #ordinal = 0

  constructor(options: SqliteMeetingStoreOptions) {
    this.#clock = options.clock
    this.#id = createIdFactory(options)
    this.#db = new Database(options.dbPath ?? ':memory:')
    this.#db.pragma('journal_mode = WAL')
    migrate(this.#db, MIGRATIONS, options.clock.now() ?? EPOCH)
    this.#ordinal =
      this.#db
        .prepare<[], { n: number | null }>('SELECT MAX(ordinal) AS n FROM meeting_records')
        .get()?.n ?? 0
  }

  get schemaVersion(): number {
    return schemaVersion(this.#db)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  #putMeeting(m: Meeting): void {
    this.#db
      .prepare(
        `INSERT INTO meetings (id, workspace_id, start_ms, status, doc) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id,
           start_ms = excluded.start_ms, status = excluded.status, doc = excluded.doc`,
      )
      .run(m.id, m.workspace_id, Date.parse(m.start), m.status, JSON.stringify(m))
  }

  #putRecord(r: MeetingRecord, ordinal?: number): void {
    if (ordinal === undefined) {
      this.#db
        .prepare('UPDATE meeting_records SET doc = ? WHERE id = ?')
        .run(JSON.stringify(r), r.id)
      return
    }
    this.#db
      .prepare('INSERT INTO meeting_records (id, meeting_id, ordinal, doc) VALUES (?,?,?,?)')
      .run(r.id, r.meeting_id, ordinal, JSON.stringify(r))
  }

  createMeeting(input: MeetingCreateInput): Meeting {
    const now = this.#clock.now()
    const id = input.id ?? this.#id('mtg')
    if (this.getMeeting(id) !== undefined)
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
    this.#putMeeting(meeting)
    return meeting
  }

  getMeeting(id: MeetingId): Meeting | undefined {
    const row = this.#db
      .prepare<[string], { doc: string }>('SELECT doc FROM meetings WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : (JSON.parse(row.doc) as Meeting)
  }

  listMeetings(filter: MeetingFilter): Meeting[] {
    const rows = this.#db
      .prepare<[string], { doc: string }>('SELECT doc FROM meetings WHERE workspace_id = ?')
      .all(filter.workspace_id)
      .map((r) => JSON.parse(r.doc) as Meeting)
      .filter((m) => matchesFilter(m, filter))
    rows.sort(byStartDesc)
    return filter.limit === undefined ? rows : rows.slice(0, filter.limit)
  }

  updateMeeting(id: MeetingId, patch: MeetingPatch): Meeting {
    const current = this.#require(id)
    const next: Meeting = { ...current, ...patch, updated_at: this.#clock.now() }
    if (patch.participants !== undefined && patch.sensitivity === undefined)
      next.sensitivity = defaultSensitivity(patch.participants)
    this.#putMeeting(next)
    return next
  }

  deleteMeeting(id: MeetingId): boolean {
    const meeting = this.getMeeting(id)
    if (meeting === undefined) return false
    return this.#db.transaction((): boolean => {
      this.#db.prepare('DELETE FROM meeting_records WHERE meeting_id = ?').run(id)
      this.#db.prepare('DELETE FROM meeting_outputs WHERE meeting_id = ?').run(id)
      this.#db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
      return true
    })()
  }

  addRecord(input: MeetingRecordCreateInput): MeetingRecord {
    const meeting = this.#require(input.meeting_id)
    const now = this.#clock.now()
    const id = input.id ?? this.#id('mrec')
    if (this.getRecord(id) !== undefined)
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
    this.#ordinal += 1
    const ordinal = this.#ordinal
    this.#db.transaction(() => {
      this.#putRecord(record, ordinal)
      this.#putMeeting({ ...meeting, records: [...meeting.records, id], updated_at: now })
    })()
    return record
  }

  getRecord(id: MeetingRecordId): MeetingRecord | undefined {
    const row = this.#db
      .prepare<[string], { doc: string }>('SELECT doc FROM meeting_records WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : (JSON.parse(row.doc) as MeetingRecord)
  }

  records(meeting_id: MeetingId): MeetingRecord[] {
    return this.#db
      .prepare<[string], { doc: string }>(
        'SELECT doc FROM meeting_records WHERE meeting_id = ? ORDER BY ordinal',
      )
      .all(meeting_id)
      .map((r) => JSON.parse(r.doc) as MeetingRecord)
  }

  updateRecord(id: MeetingRecordId, patch: MeetingRecordPatch): MeetingRecord {
    const current = this.getRecord(id)
    if (current === undefined)
      throw new MeetingError('not_found', `会议记录不存在：${id}`, { record_id: id })
    const next: MeetingRecord = { ...current, ...patch, updated_at: this.#clock.now() }
    this.#putRecord(next)
    return next
  }

  putOutputs(outputs: MeetingOutputs): MeetingOutputs {
    const meeting = this.#require(outputs.meeting_id)
    this.#ordinal += 1
    const ordinal = this.#ordinal
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO meeting_outputs (meeting_id, record_id, ordinal, doc) VALUES (?,?,?,?)
           ON CONFLICT(meeting_id, record_id) DO UPDATE SET doc = excluded.doc`,
        )
        .run(outputs.meeting_id, outputs.record_id, ordinal, JSON.stringify(outputs))
      this.#putMeeting({ ...meeting, outputs, updated_at: this.#clock.now() })
    })()
    return outputs
  }

  outputs(meeting_id: MeetingId): MeetingOutputs[] {
    return this.#db
      .prepare<[string], { doc: string }>(
        'SELECT doc FROM meeting_outputs WHERE meeting_id = ? ORDER BY ordinal',
      )
      .all(meeting_id)
      .map((r) => JSON.parse(r.doc) as MeetingOutputs)
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
    if (Object.keys(subject).length === 0)
      throw new MeetingError('invalid_input', 'eraseParticipant 至少要给一个身份字段')
    const result: MeetingEraseResult = {
      meetings: [],
      records: [],
      raw_refs: [],
      outputs_redacted: 0,
    }
    const now = this.#clock.now()
    const meetings = this.#db
      .prepare<[string], { doc: string }>('SELECT doc FROM meetings WHERE workspace_id = ?')
      .all(input.workspace_id)
      .map((r) => JSON.parse(r.doc) as Meeting)

    this.#db.transaction(() => {
      for (const meeting of meetings) {
        const aliases = subjectAliases(subject, meeting.participants)
        const kept = meeting.participants.filter((p) => !matchesSubject(p, subject))
        const isParticipant = kept.length !== meeting.participants.length
        const records = this.records(meeting.id)
        const ownRecords = records.filter(
          (r) => subject.person_id !== undefined && r.consent.recorded_by === subject.person_id,
        )
        if (!isParticipant && ownRecords.length === 0) continue

        result.meetings.push(meeting.id)
        let next: Meeting = { ...meeting, participants: kept, updated_at: now }

        for (const record of records) {
          const redacted = redactRecord(record, subject, aliases)
          if (!redacted.changed) continue
          this.#putRecord({ ...redacted.record, updated_at: now })
          result.records.push(record.id)
          if (redacted.raw_ref !== undefined) result.raw_refs.push(redacted.raw_ref)
        }

        const rows = this.#db
          .prepare<[string], { record_id: string; doc: string }>(
            'SELECT record_id, doc FROM meeting_outputs WHERE meeting_id = ? ORDER BY ordinal',
          )
          .all(meeting.id)
        let latest: MeetingOutputs | undefined
        for (const row of rows) {
          const r = redactOutputs(JSON.parse(row.doc) as MeetingOutputs, aliases)
          result.outputs_redacted += r.removed
          this.#db
            .prepare('UPDATE meeting_outputs SET doc = ? WHERE meeting_id = ? AND record_id = ?')
            .run(JSON.stringify(r.outputs), meeting.id, row.record_id)
          latest = r.outputs
        }
        if (latest !== undefined) next = { ...next, outputs: latest }
        this.#putMeeting(next)
      }
    })()
    return result
  }

  #require(id: MeetingId): Meeting {
    const meeting = this.getMeeting(id)
    if (meeting === undefined)
      throw new MeetingError('not_found', `会议不存在：${id}`, { meeting_id: id })
    return meeting
  }
}

export function createSqliteMeetingStore(options: SqliteMeetingStoreOptions): SqliteMeetingStore {
  return new SqliteMeetingStore(options)
}
