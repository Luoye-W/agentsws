/**
 * WP125（72 §1.I / §P0-1 / §P0-2 / §P0-3）：客服判断层。
 *
 * 这一组钉的是「真邮件路径上**有门**」这件事本身——72 的头号发现是它以前没有。
 * 每一条都对应亲测脚本（72 §8.1）里的一步。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ApprovalItem,
  CreateApprovalInput,
  EventEnvelope,
  KnowledgeGapWaiter,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { bandOf, createSupportJudgment, type SupportJudgment } from '../src/support-judgment.js'

/** 判断层源码的路径（两条 grep 级断言读它；`cwd` 在仓库根上跑时不一定是 apps/server）。 */
const JUDGMENT_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'support-judgment.ts',
)

const ws = 'ws_demo'
const position = {
  person_id: 'p_wang' as const,
  assignment_id: 'asg_support',
  role_id: 'dtc.support' as const,
}

interface Rig {
  judgment: SupportJudgment
  cards: CreateApprovalInput<unknown>[]
  events: (Omit<EventEnvelope, 'id' | 'at'> & { at?: string })[]
  gaps: Map<
    string,
    { id: string; question: string; waiting: KnowledgeGapWaiter[]; answer?: string }
  >
}

function rig(
  over: Partial<Parameters<typeof createSupportJudgment>[0]> = {},
  at = '2026-09-19T02:00:00.000Z',
): Rig {
  const cards: CreateApprovalInput<unknown>[] = []
  const events: (Omit<EventEnvelope, 'id' | 'at'> & { at?: string })[] = []
  const gaps = new Map<
    string,
    { id: string; question: string; waiting: KnowledgeGapWaiter[]; answer?: string }
  >()
  let now = at
  const judgment = createSupportJudgment({
    workspace_id: ws,
    clock: { now: () => now },
    appendEvent: (e) => {
      events.push(e)
    },
    approvals: {
      create: async <P>(input: CreateApprovalInput<P>) => {
        cards.push(input as CreateApprovalInput<unknown>)
        return { ...input, id: `ap_${cards.length}`, state: 'pending_review' } as ApprovalItem<P>
      },
    },
    position: () => position,
    gaps: {
      openGap: (input) => {
        const id = `gap_${input.subject_key}`
        if (!gaps.has(id)) gaps.set(id, { id, question: input.question, waiting: [] })
        return id
      },
      addWaiter: (gap_id, waiter) => {
        const gap = gaps.get(gap_id)
        if (gap === undefined) return
        if (!gap.waiting.some((w) => w.thread_id === waiter.thread_id)) gap.waiting.push(waiter)
      },
      getGap: (gap_id) => gaps.get(gap_id),
      answerGap: (gap_id, input) => {
        const gap = gaps.get(gap_id)
        if (gap !== undefined) gap.answer = input.answer
      },
    },
    ...over,
  })
  return {
    judgment,
    cards,
    events,
    gaps,
    // 测试里要推时钟就改这个闭包（SLA 那一组用）
    ...({
      advance: (to: string) => {
        now = to
      },
    } as Record<string, unknown>),
  } as Rig
}

const inbound = (text: string, thread_id = 'th_1') => ({
  thread_id,
  text,
  subject: 'Order #1001',
  from: 'ann@customer.example',
})

describe('六个纯函数的生产引用（72 §1.I 的验收）', () => {
  it('apps/server 里真的引用了这六个（可 grep 断言）', () => {
    const src = readFileSync(JUDGMENT_SRC, 'utf8')
    for (const name of [
      'draftReply',
      'computeSla',
      'shouldEscalate',
      'evaluateAutonomyGates',
      'findUnansweredBoundary',
      'knowledgeCandidate',
    ]) {
      expect(src).toContain(name)
    }
  })

  it('补完缺口那条路径里**零发送函数**（72 §P0-3 ③ 的 import 级断言）', () => {
    const src = readFileSync(JUDGMENT_SRC, 'utf8')
    const body = src.slice(
      src.indexOf('const fulfillGap'),
      src.indexOf('  return {\n    judgeInbound'),
    )
    expect(body.length).toBeGreaterThan(100)
    for (const forbidden of ['sendMail', 'adapter.send', '.deliver(', 'say(']) {
      expect(body).not.toContain(forbidden)
    }
    // 它只会建卡
    expect(body).toContain('approvals.create')
  })
})

describe('入站判断：四条出口', () => {
  it('第一次撞到未答边界 → 出一张选择题卡，且不自作主张', async () => {
    const r = rig()
    const out = await r.judgment.judgeInbound(
      inbound('Tracking says delivered but I never received the package. Please refund.'),
    )
    expect(out.boundary).toBeDefined()
    expect(out.action).toBe('boundary_question')
    const card = r.cards.find((c) => c.kind === 'policy_change')
    expect(card).toBeDefined()
    // 是**选择题**，不是空白输入框
    expect((card?.options ?? []).length).toBeGreaterThan(0)
    // 草稿里不提赔偿金额
    expect(out.draft.body).not.toMatch(/\$\s?\d/)
  })

  it('同一条边界只问一次（`boundaryDedupeKey`）', async () => {
    const r = rig()
    await r.judgment.judgeInbound(inbound('delivered but never received, refund please', 'th_a'))
    await r.judgment.judgeInbound(inbound('delivered but never received, refund please', 'th_b'))
    expect(r.cards.filter((c) => c.kind === 'policy_change')).toHaveLength(1)
  })

  it('威胁差评 / 法务 → handoff（severity high）', async () => {
    const r = rig()
    const out = await r.judgment.judgeInbound(
      inbound('If you do not refund me I will leave a 1 star review and contact my lawyer.'),
    )
    expect(out.action).toBe('handoff')
    expect(out.escalation.reasons.some((x) => x.startsWith('manual_review:'))).toBe(true)
    expect(out.band).toBe('P0')
  })

  it('门的结论进事件，**被扫的文本一个字都不进**', async () => {
    const r = rig()
    await r.judgment.judgeInbound(inbound('I want a refund for order #1001'))
    const gate = r.events.find((e) => e.type === 'guardrail.gate_decided')
    expect(gate).toBeDefined()
    const payload = JSON.stringify(gate?.payload ?? {})
    expect(payload).toContain('l3_denylist')
    expect(payload).not.toContain('#1001')
    expect(payload).not.toContain('refund for order')
  })
})

describe('出站判断：三道门 + 泄漏守卫', () => {
  it('L3 黑名单：退款类意图不自主', () => {
    const r = rig()
    const out = r.judgment.judgeDraft({
      channel: 'email',
      thread_id: 'th_1',
      inbound_text: 'I want a refund',
      reply_text: 'We will look into it.',
      classification: undefined,
    })
    expect(out.gates.results.map((g) => g.gate)).toEqual([
      'l3_denylist',
      'draft_origin',
      'commitment_scan',
    ])
    expect(out.action).toBe('card')
    expect(out.gates.blocking_gate).toBe('l3_denylist')
  })

  it('草稿来源：人写的那份不走自主发送', () => {
    const r = rig()
    const out = r.judgment.judgeDraft({
      channel: 'email',
      thread_id: 'th_1',
      inbound_text: 'where is my order',
      reply_text: 'It shipped yesterday.',
      generated_by: 'human',
    })
    expect(out.action).toBe('card')
    expect(out.gates.results.find((g) => g.gate === 'draft_origin')?.status).toBe('fail')
  })

  it('承诺扫描：草稿里出现第一人称承诺 → 不自主', () => {
    const r = rig()
    const out = r.judgment.judgeDraft({
      channel: 'email',
      thread_id: 'th_1',
      inbound_text: 'my package is late',
      reply_text: 'I will personally refund you 20% as compensation today.',
    })
    expect(out.action).toBe('card')
    expect(out.gates.autonomous).toBe(false)
  })

  it('泄漏守卫：照抄商家那句中文 → 打回重写；证据里只有长度', () => {
    const instruction = '按 14 天窗口跟他说，别提退款金额'
    const r = rig({ instructions: () => [instruction] })
    const out = r.judgment.judgeDraft({
      channel: 'email',
      thread_id: 'th_1',
      inbound_text: 'can I return this',
      reply_text: `好的，${instruction}。`,
    })
    expect(out.action).toBe('rewrite')
    expect(out.rewrite_instruction).toBeDefined()
    const guard = r.events.find((e) => e.payload?.guard === 'instruction_leak')
    expect(guard?.payload).toMatchObject({ action: 'rewrite' })
    expect(JSON.stringify(guard?.payload)).not.toContain('14 天窗口')
  })
})

describe('知识缺口：3 个人在等 → 补完出 3 张草稿卡', () => {
  it('按线程去重、补完一人一张、路径里零直发', async () => {
    const r = rig()
    let gap_id: string | undefined
    for (const thread of ['th_1', 'th_2', 'th_3', 'th_1']) {
      gap_id = r.judgment.recordGap({
        thread_id: thread,
        channel: 'email',
        question: '德国退货运费谁出',
        subject_key: 'return_shipping_de',
        language: 'de',
      })
    }
    expect(gap_id).toBeDefined()
    expect(r.gaps.get(gap_id as string)?.waiting).toHaveLength(3)

    const out = await r.judgment.fulfillGap({
      gap_id: gap_id as string,
      answer: '德国境内退货运费由我们承担。',
      by: 'p_wang',
    })
    expect(out.drafted).toBe(3)
    const drafts = r.cards.filter((c) => c.kind === 'outbound_draft')
    expect(drafts).toHaveLength(3)
    // 每一张都是**等人点头**的草稿卡，且按线程各一张
    expect(new Set(drafts.map((d) => (d.payload as { thread_ref: string }).thread_ref))).toEqual(
      new Set(['th_1', 'th_2', 'th_3']),
    )
    // 事件里只有人数
    const answered = r.events.find((e) => e.type === 'knowledge.gap.answered')
    expect(answered?.payload).toMatchObject({ waiting_count: 3, drafted: 3 })
  })
})

describe('SLA：超时进面板与通知，**不出卡**', () => {
  it('过了首响时限 → overdue() 有它、一条通知，卡片一张都不多', async () => {
    const r = rig({}, '2026-09-21T01:00:00.000Z')
    await r.judgment.judgeInbound(inbound('where is my order'))
    const before = r.cards.length
    // 把时钟推到两天后：首响窗口（缺省 24 小时工作分钟）早就过了
    ;(r as unknown as { advance(to: string): void }).advance('2026-09-25T09:00:00.000Z')
    const report = await r.judgment.sweepSla()
    expect(report.scanned).toBe(1)
    expect(report.reminded).toBe(1)
    expect(r.judgment.overdue()).toHaveLength(1)
    // **不出卡**（36 §2.2b：超时要的是"去看一眼"，不是"挑一个选项"）
    expect(r.cards.length).toBe(before)
    expect(r.events.some((e) => e.type === 'notification.sent')).toBe(true)
  })

  it('同一个锚点只提醒一次', async () => {
    const r = rig({}, '2026-09-21T01:00:00.000Z')
    await r.judgment.judgeInbound(inbound('where is my order'))
    ;(r as unknown as { advance(to: string): void }).advance('2026-09-25T09:00:00.000Z')
    await r.judgment.sweepSla()
    expect((await r.judgment.sweepSla()).reminded).toBe(0)
  })

  it('我们回过了就停表', async () => {
    const r = rig({}, '2026-09-21T01:00:00.000Z')
    await r.judgment.judgeInbound(inbound('where is my order'))
    ;(r as unknown as { advance(to: string): void }).advance('2026-09-25T09:00:00.000Z')
    r.judgment.noteOutbound('th_1')
    expect(r.judgment.overdue()).toHaveLength(0)
  })
})

describe('教一句 → 知识候选', () => {
  it('承诺类永不自动发布', () => {
    const r = rig()
    const out = r.judgment.teachCandidate({
      thread_id: 'th_1',
      instruction: '以后这类问题就说我们会全额退款，不用再问我。',
      question: '超过窗口还能退吗',
    })
    expect(out?.candidate).toBeDefined()
    expect(out?.auto_proposable).toBe(false)
  })

  it('太短的句子成不了知识', () => {
    expect(
      rig().judgment.teachCandidate({ thread_id: 'th_1', instruction: '好的' }),
    ).toBeUndefined()
  })
})

describe('优先级带（派生不存列）', () => {
  it('四条出口各落一带；破线一律 P0', () => {
    const ok = { first_response_breached: false } as never
    const late = { first_response_breached: true } as never
    expect(bandOf('handoff', ok)).toBe('P0')
    expect(bandOf('pending_review', ok)).toBe('P1')
    expect(bandOf('auto_reply', ok)).toBe('P2')
    expect(bandOf('boundary_question', ok)).toBe('P3')
    expect(bandOf('boundary_question', late)).toBe('P0')
  })
})
