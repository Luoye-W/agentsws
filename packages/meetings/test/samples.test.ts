/**
 * 14 份合成样本跑完整管线。两条红线各一组断言：
 * - **注入不产生待办**（也不产生知识、也不进纪要）
 * - **假指派只到 `suggested`**（不在场的人 / 高风险动作）
 */
import { describe, expect, it } from 'vitest'
import { MEETING_SAMPLES, sampleById } from '../src/fixtures.js'
import { renderMinutes } from '../src/minutes.js'
import { makeHarness } from './helpers.js'

const SOURCE_OF = {
  online_meeting: 'online_meeting',
  in_app_recording: 'in_app_recording',
  device: 'device',
  third_party: 'third_party',
  handed_over: 'handed_over',
  manual_notes: 'manual_notes',
} as const

describe('合成样本 × 完整管线', () => {
  it('14 份样本，三种格式、六种来源都覆盖到', () => {
    expect(MEETING_SAMPLES).toHaveLength(14)
    expect(new Set(MEETING_SAMPLES.map((s) => s.format)).size).toBeGreaterThanOrEqual(3)
    expect(new Set(MEETING_SAMPLES.map((s) => s.source))).toEqual(new Set(Object.keys(SOURCE_OF)))
    expect(sampleById('s01_weekly_zh').format).toBe('plain')
    expect(() => sampleById('没有这个')).toThrow(/没有这份样本/)
  })

  for (const sample of MEETING_SAMPLES) {
    it(`${sample.id}：${sample.title}`, async () => {
      const h = makeHarness({ participants: sample.participants, title: sample.title })
      // 一律走"文本类"投递：录音那一路在 pipeline.test.ts 里单测
      const source = sample.source === 'in_app_recording' ? 'manual_notes' : sample.source
      const records = await h.pipeline.ingest({
        workspace_id: 'ws_1',
        meeting_id: h.meeting.id,
        actor: 'per_luo',
        source,
        payload: {
          text: sample.text,
          mime: sample.mime,
          format: sample.format,
          notice_given: true,
        },
      })
      expect(records).toHaveLength(1)
      const result = await h.pipeline.process((records[0] as { id: string }).id)
      const outputs = result.outputs
      expect(outputs).toBeDefined()
      if (outputs === undefined) return
      const e = sample.expect

      if (e.decisions_at_least !== undefined)
        expect(outputs.decisions.length).toBeGreaterThanOrEqual(e.decisions_at_least)
      if (e.boundary_at_least !== undefined)
        expect(outputs.boundary_answers.length).toBeGreaterThanOrEqual(e.boundary_at_least)
      if (e.knowledge_at_least !== undefined)
        expect(outputs.knowledge.length).toBeGreaterThanOrEqual(e.knowledge_at_least)
      if (e.next_meeting === true) expect(outputs.next_meeting).toBeDefined()

      if (e.no_todos === true) {
        expect(outputs.todos).toEqual([])
        expect(result.approvals?.claims).toEqual([])
      }
      for (const forbidden of e.todos_must_not_contain ?? []) {
        const blob = JSON.stringify(outputs)
        expect(blob).not.toContain(forbidden)
      }
      for (const want of e.todo_states ?? []) {
        const todo = outputs.todos.find((t) => t.text.includes(want.contains))
        expect(todo, `没抽到含「${want.contains}」的待办`).toBeDefined()
        expect(todo?.speech_state).toBe(want.state)
        if (want.reason !== undefined) expect(todo?.speech_state_reasons).toContain(want.reason)
      }
      // 纪要能渲染出来，且注入的字面量不在里面
      const md = renderMinutes({
        meeting: (await h.store.getMeeting(h.meeting.id)) as never,
        records: await h.store.records(h.meeting.id),
        outputs: await h.store.outputs(h.meeting.id),
      })
      for (const forbidden of e.todos_must_not_contain ?? []) expect(md).not.toContain(forbidden)
    })
  }

  it('全部样本合起来：没有任何一条待办是 assigned 却涉及钱', async () => {
    for (const sample of MEETING_SAMPLES) {
      const h = makeHarness({ participants: sample.participants })
      const source = sample.source === 'in_app_recording' ? 'manual_notes' : sample.source
      const [record] = await h.pipeline.ingest({
        workspace_id: 'ws_1',
        meeting_id: h.meeting.id,
        actor: 'per_luo',
        source,
        payload: {
          text: sample.text,
          mime: sample.mime,
          format: sample.format,
          notice_given: true,
        },
      })
      const { outputs } = await h.pipeline.process((record as { id: string }).id)
      for (const todo of outputs?.todos ?? []) {
        if (/转账|打款|wire|refund/i.test(`${todo.text} ${todo.provenance.quote}`))
          expect(todo.speech_state).toBe('suggested')
      }
    }
  })
})
