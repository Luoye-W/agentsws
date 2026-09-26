/**
 * WP154：`beforeStage` 改写口（发布前内容质检用它把"发布"改回"草稿"）。
 *
 * 三件事：装了就按改写后的走（仍过 guardrail）；不装一个字节不变；口子自己挂了按原样走。
 */
import type { ObjectRef } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { ASG, harness, provenanceState, refundStage, WS } from './helpers.js'

const ARTICLE: ObjectRef = { type: 'article', id: 'art_1' }

const publish = () =>
  refundStage({
    kind: 'publish_post',
    target: ARTICLE,
    before: { title: '快充头怎么挑', published: false },
    after: { title: '快充头怎么挑', published: true, body: '全网最好的快充头。' },
    money: undefined,
    requester: undefined,
    target_owner: undefined,
    mandate: { caps: { max_posts_per_day: 2 } },
    level: 'L2',
    provenance: provenanceState({ seen: { article: [ARTICLE.id] } }),
    approval: {
      title: '发布文章：快充头怎么挑',
      summary: '这篇会出现在店里的博客上。',
      recipients: [{ person: 'p_li', via: 'scope_manager' }],
      proposer: { kind: 'agent', id: 'agent_content', assignment_id: ASG },
      separation_of_duties: true,
    },
  })

describe('beforeStage：stage 之前的改写口', () => {
  it('质检没过 → 改回草稿、拉回 L1、卡上换成说明', async () => {
    const h = harness({
      beforeStage: (input) => ({
        ...input,
        after: {
          ...(input.after as object),
          published: false,
          quality_gate: {
            passed: false,
            issues: [{ rule: 'banned_claim', sentence: '全网最好的快充头。' }],
          },
        },
        level: 'L1',
        approval: { ...input.approval, title: '没过质检，先留在草稿：快充头怎么挑' },
      }),
    })
    const out = await h.txn.ledger.stage(publish())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect((out.change.after as { published: boolean }).published).toBe(false)
    expect(out.approval.title).toBe('没过质检，先留在草稿：快充头怎么挑')
    expect(out.approval.automation.auto_approved).toBe(false)
  })

  it('改写后的入参照样过 guardrail（改不出一条绕过门的路）', async () => {
    const h = harness({
      beforeStage: (input) => ({
        ...input,
        after: { ...(input.after as object), quality_gate: { passed: false, issues: [] } },
      }),
    })
    const out = await h.txn.ledger.stage(publish())
    expect(out.ok).toBe(false)
    expect(await h.txn.ledger.list({ workspace_id: WS })).toHaveLength(0)
  })

  it('不装 = 原样；口子自己抛错 = 当它不存在', async () => {
    const plain = await harness().txn.ledger.stage(publish())
    expect(plain.ok).toBe(true)
    const broken = await harness({
      beforeStage: () => {
        throw new Error('知识库挂了')
      },
    }).txn.ledger.stage(publish())
    expect(broken.ok).toBe(true)
  })
})
