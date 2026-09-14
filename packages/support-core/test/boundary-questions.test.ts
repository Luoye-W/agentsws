/**
 * WP56 第 5 件之三（48 §4 #9 / 36 §2.2）：**15 条业务边界，第一次撞到就出一张
 * `policy_change` 问句卡。**
 *
 * 这条链本来就在（`findUnansweredBoundaries` → `policyQuestionRequest` →
 * runtime-direct 的 `createPolicyQuestion`），但没有一处测试把"15 条**每一条**
 * 都问得出来"钉住——于是加一条边界、忘了写 `applies_when`，没有任何红灯。
 */
import { describe, expect, it } from 'vitest'
import {
  boundaryDedupeKey,
  findUnansweredBoundaries,
  policyQuestionRequest,
  SUPPORT_BOUNDARIES,
} from '../src/index.js'

const WS = 'ws_1'

describe('业务边界 → 问句卡', () => {
  it('十五条一条不少，每条都能做出一张选择题卡', () => {
    expect(SUPPORT_BOUNDARIES).toHaveLength(15)
    for (const boundary of SUPPORT_BOUNDARIES) {
      const card = policyQuestionRequest(boundary, { workspace_id: WS })
      expect(card.kind).toBe('policy_change')
      expect(card.payload.form).toBe('policy_question')
      expect(card.payload.boundary_id).toBe(boundary.id)
      // 选择题：选项原样带过来，而且 id 不许改名（已答行按它关联）
      expect(card.payload.options.map((o) => o.id)).toEqual(boundary.options.map((o) => o.id))
      expect(card.payload.options.length).toBeGreaterThanOrEqual(2)
      expect(card.title.length).toBeGreaterThan(0)
      // 卡上要说清"为什么现在问"
      expect(card.payload.context).toContain(boundary.label)
    }
  })

  it('每条 enforced 的边界都有触发条件——否则它永远问不出来', () => {
    for (const boundary of SUPPORT_BOUNDARIES.filter((b) => b.wiring === 'enforced')) {
      const t = boundary.applies_when
      const any =
        (t.intents?.length ?? 0) + (t.risk_terms?.length ?? 0) + (t.change_kinds?.length ?? 0)
      expect(any, `${boundary.id} 没有任何触发条件`).toBeGreaterThan(0)
    }
  })

  it('每条 enforced 的边界都能被它自己声明的意图触发', () => {
    for (const boundary of SUPPORT_BOUNDARIES.filter(
      (b) => b.wiring === 'enforced' && (b.applies_when.intents?.length ?? 0) > 0,
    )) {
      const intent = boundary.applies_when.intents?.[0] as never
      const missing = findUnansweredBoundaries(intent, [])
      expect(
        missing.map((b) => b.id),
        `${boundary.id} 撞不到`,
      ).toContain(boundary.id)
    }
  })

  it('答过一次就不再问（去重键按工作区 + 边界 id）', () => {
    const boundary = SUPPORT_BOUNDARIES.find((b) => b.id === 'policy.refund_window') as never
    const intent = 'returns_refunds' as const
    expect(findUnansweredBoundaries(intent, []).map((b) => b.id)).toContain('policy.refund_window')
    expect(
      findUnansweredBoundaries(intent, [{ boundary_id: 'policy.refund_window' }]).map((b) => b.id),
    ).not.toContain('policy.refund_window')
    // 同一条边界在同一个工作区只有一个去重键 → 宿主拿它挡住第二张卡
    expect(policyQuestionRequest(boundary, { workspace_id: WS }).dedupe_key).toBe(
      boundaryDedupeKey(WS, 'policy.refund_window'),
    )
    expect(boundaryDedupeKey(WS, 'policy.refund_window')).not.toBe(
      boundaryDedupeKey('ws_2', 'policy.refund_window'),
    )
  })

  it('没撞到的边界不问——业务边界不预收集（product-principles-v2）', () => {
    const missing = findUnansweredBoundaries('product_question', [])
    expect(missing.map((b) => b.id)).not.toContain('policy.refund_window')
  })
})
