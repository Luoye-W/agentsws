/**
 * `MeetingStore` 与 `MeetingRawStore` 的**契约一致性套件**：接受任意实现，
 * 对内存档与 SQLite 档各跑一遍（WP18 的做法）。
 */
import type {
  MeetingCreateInput,
  MeetingOutputs,
  MeetingRecordCreateInput,
  MeetingStore,
} from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { isMeetingError } from '../src/errors.js'
import type { MeetingRawStore } from '../src/raw-store.js'
import { T0 } from './helpers.js'

export function meetingInput(over: Partial<MeetingCreateInput> = {}): MeetingCreateInput {
  return {
    workspace_id: 'ws_1',
    title: '周会',
    start: T0,
    end: '2026-09-09T10:00:00.000Z',
    participants: [
      { person_id: 'per_luo', name: '罗野' },
      { person_id: 'per_zhang', name: '张三' },
    ],
    status: 'scheduled',
    created_by: 'per_luo',
    ...over,
  }
}

/** `exactOptionalPropertyTypes` 下不能写 `transcript: undefined`，只能不写这个键。 */
function withoutTranscript(input: MeetingRecordCreateInput): MeetingRecordCreateInput {
  const { transcript: _drop, ...rest } = input
  return rest
}

export function recordInput(
  meeting_id: string,
  over: Partial<MeetingRecordCreateInput> = {},
): MeetingRecordCreateInput {
  return {
    workspace_id: 'ws_1',
    meeting_id,
    source: 'manual_notes',
    transcript: { text: '罗野：我们决定上线。', segments: [] },
    consent: { recorded_by: 'per_luo', notice_given: true },
    sensitivity: 'internal',
    ingested_by: { kind: 'person', id: 'per_luo' },
    ...over,
  }
}

function outputs(meeting_id: string, record_id: string, speaker?: string): MeetingOutputs {
  const provenance = {
    record_id,
    quote: '我们决定上线',
    ...(speaker === undefined ? {} : { speaker }),
  }
  return {
    meeting_id,
    record_id,
    decisions: [{ id: 'd1', text: '上线', provenance }],
    todos: [
      {
        id: 't1',
        text: '写公告',
        speech_state: 'suggested',
        speech_state_reasons: [],
        provenance,
      },
    ],
    boundary_answers: [],
    knowledge: [],
    processor: 'test/processor',
    produced_at: T0,
  }
}

export interface StoreHarness {
  name: string
  make(): MeetingStore
  dispose?(store: MeetingStore): void
}

export function runMeetingStoreConformance(h: StoreHarness): void {
  const opened: MeetingStore[] = []
  const make = (): MeetingStore => {
    const s = h.make()
    opened.push(s)
    return s
  }
  afterEach(() => {
    // 注意：`h.dispose?.(opened.pop())` 在 dispose 缺省时**不会求值实参**，会死循环
    for (const s of opened.splice(0)) h.dispose?.(s)
  })

  describe(`MeetingStore 一致性 · ${h.name}`, () => {
    it('建会议：默认敏感级 internal，records 空，时间戳来自 Clock', async () => {
      const store = make()
      const m = await store.createMeeting(meetingInput())
      expect(m.sensitivity).toBe('internal')
      expect(m.records).toEqual([])
      expect(m.created_at).toBe(T0)
      expect(m.schema_version).toBe(1)
      expect(await store.getMeeting(m.id)).toEqual(m)
    })

    it('有外部参与者 → 默认 restricted（37 §4 C4）', async () => {
      const store = make()
      const m = await store.createMeeting(
        meetingInput({ participants: [{ name: '客户 A', external: true }] }),
      )
      expect(m.sensitivity).toBe('restricted')
    })

    it('显式给了敏感级就不覆盖', async () => {
      const store = make()
      const m = await store.createMeeting(meetingInput({ sensitivity: 'confidential' }))
      expect(m.sensitivity).toBe('confidential')
    })

    it('同 id 建两次 → conflict', async () => {
      const store = make()
      await store.createMeeting(meetingInput({ id: 'mtg_x' }))
      await expect(async () => store.createMeeting(meetingInput({ id: 'mtg_x' }))).rejects.toThrow(
        /已存在/,
      )
    })

    it('取不存在的会议 → undefined；改不存在的 → not_found', async () => {
      const store = make()
      expect(await store.getMeeting('nope')).toBeUndefined()
      await expect(async () => store.updateMeeting('nope', { title: 'x' })).rejects.toThrow(
        /不存在/,
      )
    })

    it('改与会者会重算敏感级；显式给了就不重算', async () => {
      const store = make()
      const m = await store.createMeeting(meetingInput())
      const withExternal = await store.updateMeeting(m.id, {
        participants: [{ name: '客户', external: true }],
      })
      expect(withExternal.sensitivity).toBe('restricted')
      const pinned = await store.updateMeeting(m.id, {
        participants: [{ name: '客户', external: true }],
        sensitivity: 'internal',
      })
      expect(pinned.sensitivity).toBe('internal')
    })

    it('列表：按工作区 / 与会者 / 状态 / 时间窗筛，开始时间倒序，limit 生效', async () => {
      const store = make()
      const a = await store.createMeeting(meetingInput({ title: 'A', start: T0 }))
      const b = await store.createMeeting(
        meetingInput({
          title: 'B',
          start: '2026-09-10T09:00:00.000Z',
          end: '2026-09-10T10:00:00.000Z',
          status: 'done',
        }),
      )
      await store.createMeeting(meetingInput({ workspace_id: 'ws_2', title: 'C' }))

      const all = await store.listMeetings({ workspace_id: 'ws_1' })
      expect(all.map((m) => m.id)).toEqual([b.id, a.id])
      expect(await store.listMeetings({ workspace_id: 'ws_1', limit: 1 })).toHaveLength(1)
      expect((await store.listMeetings({ workspace_id: 'ws_1', participant: '罗野' })).length).toBe(
        2,
      )
      expect(
        await store.listMeetings({ workspace_id: 'ws_1', participant: 'per_zhang' }),
      ).toHaveLength(2)
      expect(await store.listMeetings({ workspace_id: 'ws_1', participant: '查无此人' })).toEqual(
        [],
      )
      expect(
        (await store.listMeetings({ workspace_id: 'ws_1', status: ['done'] })).map((m) => m.id),
      ).toEqual([b.id])
      expect(
        (await store.listMeetings({ workspace_id: 'ws_1', from: '2026-09-10T00:00:00.000Z' })).map(
          (m) => m.id,
        ),
      ).toEqual([b.id])
      expect(
        (await store.listMeetings({ workspace_id: 'ws_1', to: '2026-09-09T23:00:00.000Z' })).map(
          (m) => m.id,
        ),
      ).toEqual([a.id])
    })

    it('加记录：回填到会议的 records，按加入顺序', async () => {
      const store = make()
      const m = await store.createMeeting(meetingInput())
      const r1 = await store.addRecord(recordInput(m.id))
      const r2 = await store.addRecord(recordInput(m.id, { source: 'handed_over' }))
      expect((await store.getMeeting(m.id))?.records).toEqual([r1.id, r2.id])
      expect((await store.records(m.id)).map((r) => r.id)).toEqual([r1.id, r2.id])
      expect(await store.getRecord(r1.id)).toEqual(r1)
      // 存储不猜状态：默认 ingested，是不是 transcribed 由管线定
      expect(r1.status).toBe('ingested')
      expect((await store.addRecord(recordInput(m.id, { status: 'processed' }))).status).toBe(
        'processed',
      )
    })

    it('加记录到不存在的会议 → not_found；同 id 两次 → conflict；记录不存在 → undefined', async () => {
      const store = make()
      const m = await store.createMeeting(meetingInput())
      await expect(async () => store.addRecord(recordInput('nope'))).rejects.toThrow(/不存在/)
      await store.addRecord(recordInput(m.id, { id: 'mrec_x' }))
      await expect(async () =>
        store.addRecord(recordInput(m.id, { id: 'mrec_x' })),
      ).rejects.toThrow(/已存在/)
      const updated = await store.updateRecord((await store.getRecord('mrec_x'))?.id as string, {
        status: 'processed',
        error: 'x',
      })
      expect(updated.status).toBe('processed')
      expect((await store.getRecord('mrec_x'))?.error).toBe('x')
      expect(await store.getRecord('nope')).toBeUndefined()
      expect(await store.records('nope')).toEqual([])
      await expect(async () => store.updateRecord('nope', { status: 'failed' })).rejects.toThrow(
        /不存在/,
      )
    })

    it('产出：同一条记录重复处理覆盖自己那条，不叠加；会议上挂最新一份', async () => {
      const store = make()
      const m = await store.createMeeting(meetingInput())
      const r = await store.addRecord(recordInput(m.id))
      await store.putOutputs(outputs(m.id, r.id))
      await store.putOutputs(outputs(m.id, r.id))
      expect(await store.outputs(m.id)).toHaveLength(1)
      expect((await store.getMeeting(m.id))?.outputs?.record_id).toBe(r.id)
      const r2 = await store.addRecord(recordInput(m.id))
      await store.putOutputs(outputs(m.id, r2.id))
      expect(await store.outputs(m.id)).toHaveLength(2)
      await expect(async () => store.putOutputs(outputs('nope', r.id))).rejects.toThrow(/不存在/)
      expect(await store.outputs('nope')).toEqual([])
    })

    it('删会议：记录与产出一并没了；删不存在的回 false', async () => {
      const store = make()
      const m = await store.createMeeting(meetingInput())
      const r = await store.addRecord(recordInput(m.id))
      await store.putOutputs(outputs(m.id, r.id))
      expect(await store.deleteMeeting(m.id)).toBe(true)
      expect(await store.getMeeting(m.id)).toBeUndefined()
      expect(await store.getRecord(r.id)).toBeUndefined()
      expect(await store.outputs(m.id)).toEqual([])
      expect(await store.deleteMeeting(m.id)).toBe(false)
    })

    it('随主体删除：摘掉与会者、按说话人删转写段与产出，交出要抹的 raw_ref', async () => {
      const store = make()
      const m = await store.createMeeting(meetingInput())
      const own = await store.addRecord(
        withoutTranscript({
          ...recordInput(m.id),
          media: { kind: 'audio', raw_ref: 'raw://x/1' },
          consent: { recorded_by: 'per_zhang', notice_given: true },
          status: 'ingested',
        }),
      )
      const shared = await store.addRecord(
        recordInput(m.id, {
          transcript: {
            text: '罗野：甲。\n张三：乙。',
            segments: [
              { start_ms: 0, end_ms: 1, speaker: '罗野', text: '甲。' },
              { start_ms: 1, end_ms: 2, speaker: '张三', text: '乙。' },
            ],
            speakers: ['罗野', '张三'],
          },
        }),
      )
      await store.putOutputs(outputs(m.id, shared.id, '张三'))

      const result = await store.eraseParticipant({ workspace_id: 'ws_1', person_id: 'per_zhang' })
      expect(result.meetings).toEqual([m.id])
      expect(result.raw_refs).toEqual(['raw://x/1'])
      expect(result.records.sort()).toEqual([own.id, shared.id].sort())
      expect(result.outputs_redacted).toBe(2)

      const after = await store.getMeeting(m.id)
      expect(after?.participants.map((p) => p.person_id)).toEqual(['per_luo'])
      const ownAfter = await store.getRecord(own.id)
      expect(ownAfter?.media).toBeUndefined()
      expect(ownAfter?.error).toBe('subject_erased')
      const sharedAfter = await store.getRecord(shared.id)
      expect(sharedAfter?.transcript?.text).toBe('罗野：甲。')
      expect(sharedAfter?.transcript?.segments).toHaveLength(1)
      const outs = await store.outputs(m.id)
      expect(outs[0]?.decisions).toEqual([])
      expect(outs[0]?.todos).toEqual([])
    })

    it('随主体删除：不给任何身份字段 → invalid_input；不相干的会议不动', async () => {
      const store = make()
      const m = await store.createMeeting(meetingInput())
      await expect(async () => store.eraseParticipant({ workspace_id: 'ws_1' })).rejects.toSatisfy(
        (e: unknown) => isMeetingError(e) && e.code === 'invalid_input',
      )
      const r = await store.eraseParticipant({ workspace_id: 'ws_1', email: 'nobody@x.example' })
      expect(r.meetings).toEqual([])
      expect((await store.getMeeting(m.id))?.participants).toHaveLength(2)
    })

    it('随主体删除：按 email / name 也能命中，跨工作区不误伤', async () => {
      const store = make()
      const m = await store.createMeeting(
        meetingInput({ participants: [{ name: '客户', email: 'a@b.example', external: true }] }),
      )
      await store.createMeeting(
        meetingInput({
          workspace_id: 'ws_2',
          participants: [{ name: '客户', email: 'a@b.example', external: true }],
        }),
      )
      const r = await store.eraseParticipant({ workspace_id: 'ws_1', email: 'A@B.example' })
      expect(r.meetings).toEqual([m.id])
      expect((await store.getMeeting(m.id))?.participants).toEqual([])
    })
  })
}

export function runRawStoreConformance(h: {
  name: string
  make(): MeetingRawStore
  dispose?(store: MeetingRawStore): void
}): void {
  const opened: MeetingRawStore[] = []
  const make = (): MeetingRawStore => {
    const s = h.make()
    opened.push(s)
    return s
  }
  afterEach(() => {
    for (const s of opened.splice(0)) h.dispose?.(s)
  })

  describe(`MeetingRawStore 一致性 · ${h.name}`, () => {
    it('文本与字节都存得下，ref 带工作区与类别', async () => {
      const store = make()
      const textRef = await store.put({
        workspace_id: 'ws_1',
        kind: 'document',
        stored_at: T0,
        payload: '纪要正文',
        mime: 'text/plain',
        name: 'notes.txt',
      })
      const bytesRef = await store.put({
        workspace_id: 'ws_1',
        kind: 'audio',
        stored_at: T0,
        payload: new Uint8Array([1, 2, 3]),
        mime: 'audio/webm',
      })
      expect(textRef).toContain('raw://meetings/ws_1/document/')
      expect((await store.get(textRef))?.payload).toBe('纪要正文')
      expect((await store.get(textRef))?.name).toBe('notes.txt')
      expect((await store.get(bytesRef))?.payload).toEqual(new Uint8Array([1, 2, 3]))
      expect(await store.get('raw://nope')).toBeUndefined()
    })

    it('保留期：过期的丢掉，没过期的留着', async () => {
      const store = make()
      const old = await store.put({
        workspace_id: 'ws_1',
        kind: 'audio',
        stored_at: '2026-09-01T00:00:00.000Z',
        payload: new Uint8Array([9]),
      })
      const fresh = await store.put({
        workspace_id: 'ws_1',
        kind: 'audio',
        stored_at: T0,
        payload: new Uint8Array([9]),
      })
      expect(await store.prune(3 * 86_400_000, T0)).toBe(1)
      expect(await store.get(old)).toBeUndefined()
      expect(await store.get(fresh)).toBeDefined()
    })

    it('随主体删除：按 ref 硬删；空入参回 0', async () => {
      const store = make()
      const ref = await store.put({
        workspace_id: 'ws_1',
        kind: 'audio',
        stored_at: T0,
        payload: new Uint8Array([1]),
      })
      expect(await store.erase()).toBe(0)
      expect(await store.erase(ref, 'raw://nope')).toBe(1)
      expect(await store.get(ref)).toBeUndefined()
    })

    it('落库后脱敏：文本改写并打标；二进制不动；不存在 → not_found', async () => {
      const store = make()
      const textRef = await store.put({
        workspace_id: 'ws_1',
        kind: 'document',
        stored_at: T0,
        payload: 'token=abcdefgh',
      })
      const binRef = await store.put({
        workspace_id: 'ws_1',
        kind: 'audio',
        stored_at: T0,
        payload: new Uint8Array([7]),
      })
      await store.scrub?.(textRef, () => '[redacted]')
      expect((await store.get(textRef))?.payload).toBe('[redacted]')
      expect((await store.get(textRef))?.secrets_scrubbed).toBe(true)
      await store.scrub?.(binRef, () => '[redacted]')
      expect((await store.get(binRef))?.payload).toEqual(new Uint8Array([7]))
      await expect(async () => store.scrub?.('raw://nope', (t) => t)).rejects.toThrow(/不存在/)
    })
  })
}
