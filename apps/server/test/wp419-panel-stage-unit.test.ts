/**
 * WP419（自查 R5 / U17）：起草卡在哪一步的判定（纯函数）——顺序就是起草那一头真正的先后。
 */
import { describe, expect, it } from 'vitest'
import { repliedBefore, stageOf } from '../src/extension-panel.js'

const base = { open: 2, conflicts: 0, queued: 0, reading_threads: false, plugin_ready: true }
const gate = { has_owner: true, persona_needed: false }

describe('WP419 起草卡在哪一步', () => {
  it('没有要回的 / 全出卡了：不说', () => {
    expect(stageOf({ ...base, open: 0 })).toBeUndefined()
  })
  it('没人担：读到的不会起草', () => {
    expect(stageOf({ ...base, gate: { ...gate, has_owner: false } })).toMatchObject({
      kind: 'no_owner',
      count: 2,
    })
  })
  it('等读整串（插件在读）/ 插件读不了照实说为什么', () => {
    expect(stageOf({ ...base, queued: 2, reading_threads: true, gate })).toMatchObject({
      kind: 'reading_thread',
    })
    const s = stageOf({
      ...base,
      queued: 1,
      plugin_ready: false,
      plugin_why: 'Chrome 没开着（插件这一阵没来问）',
      gate,
    })
    expect(s?.kind).toBe('needs_plugin')
    expect(s?.text).toContain('Chrome 没开着')
  })
  it('口吻没定：带卡；定了 → 起草中', () => {
    expect(
      stageOf({ ...base, gate: { ...gate, persona_needed: true, persona_card_id: 'ap_p' } }),
    ).toMatchObject({ kind: 'needs_persona', count: 2, card_id: 'ap_p' })
    expect(stageOf({ ...base, gate })).toMatchObject({ kind: 'drafting', count: 2 })
  })
  it('起草没成：照实说第一条原因；只剩矛盾的：等你在工坊里看', () => {
    expect(
      stageOf({ ...base, failed: 1, failed_why: '到了你设的每天上限（5 条）', gate }),
    ).toMatchObject({
      kind: 'draft_failed',
      count: 1,
      text: '1 条没起草成：到了你设的每天上限（5 条）',
    })
    expect(stageOf({ ...base, open: 0, conflicts: 1, gate })).toMatchObject({
      kind: 'conflict',
      count: 1,
    })
  })
  it('最近 7 天品牌号已经回过的几条', () => {
    const now = '2026-10-19T00:00:00.000Z'
    expect(
      repliedBefore(
        [
          { replied_before: true, status_at: '2026-10-18T00:00:00.000Z' },
          { replied_before: true, status_at: '2026-10-01T00:00:00.000Z' },
          { status_at: '2026-10-18T00:00:00.000Z' },
        ],
        now,
      ),
    ).toBe(1)
  })
})
