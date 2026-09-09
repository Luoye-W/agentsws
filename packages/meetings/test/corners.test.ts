/** 边角：工厂函数、观察面、迁移器、几条只在特殊输入下才走到的分支。 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { extractTodos, utterances } from '../src/assistant/extract.js'
import { migrate, schemaVersion } from '../src/migrations.js'
import { createMeetingPipeline } from '../src/pipeline.js'
import { bytesOf, MemoryMeetingRawStore } from '../src/raw-store.js'
import { parseTranscript } from '../src/sources/formats.js'
import { createSqliteMeetingRawStore } from '../src/sqlite-raw-store.js'
import { createSqliteMeetingStore } from '../src/sqlite-store.js'
import { createMemoryMeetingStore } from '../src/store.js'
import { redactOutputs, redactTranscript } from '../src/store-logic.js'
import { makeClock, seeded, T0 } from './helpers.js'

describe('边角', () => {
  it('工厂函数与观察面：内存档 / SQLite 档都能建、能数、能关', () => {
    const clock = makeClock()
    const mem = createMemoryMeetingStore({ clock, random: seeded() })
    expect(mem.listMeetings({ workspace_id: 'ws_1' })).toEqual([])

    const sqliteStore = createSqliteMeetingStore({ clock, random: seeded() })
    expect(sqliteStore.schemaVersion).toBe(1)
    sqliteStore.close()
    sqliteStore.close() // 关两次幂等

    const memRaw = new MemoryMeetingRawStore()
    memRaw.put({ workspace_id: 'ws_1', kind: 'document', stored_at: T0, payload: '甲' })
    expect(memRaw.all()).toHaveLength(1)
    expect(memRaw.size).toBe(1)

    const sqliteRaw = createSqliteMeetingRawStore({ clock })
    expect(sqliteRaw.schemaVersion).toBe(2)
    sqliteRaw.put({ workspace_id: 'ws_1', kind: 'document', stored_at: T0, payload: '甲' })
    expect(sqliteRaw.all()).toHaveLength(1)
    expect(sqliteRaw.size).toBe(1)
    sqliteRaw.close()
    sqliteRaw.close()
  })

  it('迁移器：同一个库跑两次幂等；空库版本 0', () => {
    const db = new Database(':memory:')
    expect(schemaVersion(db)).toBe(0)
    const sql = 'CREATE TABLE IF NOT EXISTS t (a TEXT) STRICT;'
    expect(migrate(db, [{ version: 1, sql }], T0)).toEqual([1])
    expect(migrate(db, [{ version: 1, sql }], T0)).toEqual([])
    expect(schemaVersion(db)).toBe(1)
    db.close()
  })

  it('bytesOf：文本按 UTF-8 编码，字节原样', () => {
    expect(
      bytesOf({ ref: 'r', workspace_id: 'w', kind: 'document', stored_at: T0, payload: 'A' }),
    ).toEqual(new Uint8Array([65]))
    const raw = new Uint8Array([1, 2])
    expect(
      bytesOf({ ref: 'r', workspace_id: 'w', kind: 'audio', stored_at: T0, payload: raw }),
    ).toBe(raw)
  })

  it('擦除：没有 segments 的转写按说话人前缀删行；一行都不命中就不动', () => {
    const t = { text: '罗野：甲\n张三：乙' }
    const hit = redactTranscript(t, ['张三'])
    expect(hit.changed).toBe(true)
    expect(hit.transcript.text).toBe('罗野：甲')
    const miss = redactTranscript(t, ['王五'])
    expect(miss.changed).toBe(false)
    expect(miss.transcript).toBe(t)
    // 有 segments 但一段都不命中
    const withSegs = {
      text: 'x',
      segments: [{ start_ms: 0, end_ms: 1, speaker: '罗野', text: '甲' }],
    }
    expect(redactTranscript(withSegs, ['张三']).changed).toBe(false)
  })

  it('擦除：产出里的「下次会议」也按发言人摘掉', () => {
    const provenance = { record_id: 'r', quote: 'q', speaker: '张三' }
    const r = redactOutputs(
      {
        meeting_id: 'm',
        record_id: 'r',
        decisions: [],
        todos: [],
        boundary_answers: [],
        knowledge: [],
        next_meeting: { note: '周五', provenance },
        processor: 'p',
        produced_at: T0,
      },
      ['张三'],
    )
    expect(r.removed).toBe(1)
    expect(r.outputs.next_meeting).toBeUndefined()
  })

  it('cue 正文有多行时，第二行不再当说话人前缀', () => {
    const t = parseTranscript(
      ['1', '00:00:01,000 --> 00:00:04,000', '罗野：第一行', '第二行'].join('\n'),
    )
    expect(t?.segments?.[0]).toEqual({
      start_ms: 1000,
      end_ms: 4000,
      speaker: '罗野',
      text: '第一行 第二行',
    })
  })

  it('自认待办但转写没有说话人 → 降级 suggested，理由 speaker_unknown', () => {
    const us = utterances([{ start_ms: 0, end_ms: 1, text: '我来跟进落地页。' }])
    const todos = extractTodos(us, {
      record_id: 'r',
      participants: [{ person_id: 'per_luo', name: '罗野' }],
      now: T0,
      id: (n) => `t${n}`,
    })
    expect(todos[0]?.speech_state).toBe('suggested')
    expect(todos[0]?.speech_state_reasons).toEqual(['speaker_unknown'])
  })

  it('转写时把记录上已有的语言与时长透给 provider', async () => {
    const clock = makeClock()
    const store = createMemoryMeetingStore({ clock, random: seeded() })
    const raw = new MemoryMeetingRawStore()
    const seen: { mime: string; language?: string; duration_ms?: number }[] = []
    const pipeline = createMeetingPipeline({
      store,
      raw,
      clock,
      transcribe: async (audio) => {
        seen.push(audio)
        return {
          text: '罗野：好。',
          segments: [{ start_ms: 0, end_ms: 1, speaker: '罗野', text: '好。' }],
          usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
          model: { provider: 'stub' as const, model: 'stub-asr-v1' },
          audio: { sha256: 'b'.repeat(64), duration_ms: 42, bytes: 1, mime: audio.mime },
        }
      },
    })
    const meeting = store.createMeeting({
      workspace_id: 'ws_1',
      title: 'x',
      start: T0,
      end: T0,
      participants: [],
      status: 'done',
      created_by: 'per_luo',
    })
    const ref = raw.put({
      workspace_id: 'ws_1',
      kind: 'audio',
      stored_at: T0,
      payload: new Uint8Array([1]),
      mime: 'audio/ogg',
    })
    const record = store.addRecord({
      workspace_id: 'ws_1',
      meeting_id: meeting.id,
      source: 'device',
      // 没有 mime 时退到受控区那条记录上的 mime；语言与时长也透过去
      media: { kind: 'audio', raw_ref: ref, duration_ms: 4200, language: 'zh' },
      consent: { recorded_by: 'per_luo', notice_given: true },
      sensitivity: 'internal',
      ingested_by: { kind: 'person', id: 'per_luo' },
    })
    await pipeline.process(record.id)
    expect(seen[0]?.mime).toBe('audio/ogg')
    expect(seen[0]?.duration_ms).toBe(4200)
    expect(seen[0]?.language).toBe('zh')
  })
})
