import type { LessonPool, Skill } from '@agentsws/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Actor, MemoryLessonPool, MemorySkillRegistry, PoolInput } from '../src/index.js'
import { CUSTOMER_CARE_V1, type FakeClock, headingId, makeSkills } from './helpers.js'

const ACTOR: Actor = { person_id: 'p1', workspace_id: 'ws1' }

let registry: MemorySkillRegistry
let lessons: MemoryLessonPool
let clock: FakeClock
let base: Skill
let greeting: string
let policySection: string

async function setup(policySkills?: string[]): Promise<void> {
  const made = makeSkills(policySkills === undefined ? {} : { policySkills })
  registry = made.skills.registry
  lessons = made.skills.lessons
  clock = made.clock
  await registry.putFromMarkdown({
    markdown: CUSTOMER_CARE_V1,
    tier: 'package',
    owner: 'package',
    version: '1.0',
  })
  const stored = await registry.get('customer-care', 'package')
  if (stored === undefined) throw new Error('夹具未就绪')
  base = stored
  greeting = headingId(base.sections, '回答顺序')
  policySection = headingId(base.sections, '额度与策略')
}

function correction(overrides: Partial<PoolInput> = {}): PoolInput {
  return {
    run_id: 'run-1',
    assignment_id: 'asg-1',
    workspace_id: 'ws1',
    skill: 'customer-care',
    section_id: greeting,
    signal: 'edit_diff',
    strength: 'strong',
    text: '开头用 Hi there，不要用 Dear customer',
    ...overrides,
  }
}

beforeEach(async () => {
  await setup()
})

describe('契约一致性', () => {
  it('lessons 与 LessonPool 同形', () => {
    const conforming: LessonPool = lessons
    expect(typeof conforming.consolidate).toBe('function')
  })
})

describe('24 §6.3 五次相同纠正 = 一条 lesson，次日一条提议，夜里无 overlay 变化', () => {
  it('confirmations=5、置信度封顶、consolidate 产出一条提议且不写任何 overlay', async () => {
    const before = await registry.resolve('customer-care', ACTOR)
    for (let i = 1; i <= 5; i++) {
      clock.advance(3_600_000)
      await lessons.pool(correction({ run_id: `run-${i}` }))
    }
    const pooled = lessons.list({ workspace_id: 'ws1', status: 'pooled' })
    expect(pooled).toHaveLength(1)
    expect(pooled[0]?.confirmations).toBe(5)
    // 0.6 + 4 × 0.15 = 1.2 → 封顶 0.99
    expect(pooled[0]?.confidence).toBe(0.99)
    expect(pooled[0]?.runs).toEqual(['run-1', 'run-2', 'run-3', 'run-4', 'run-5'])

    clock.advanceDays(1)
    const { proposals } = await lessons.consolidate('ws1', { now: clock.now() })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.skill).toBe('customer-care')
    expect(proposals[0]?.section_id).toBe(greeting)
    expect(proposals[0]?.proposed_text).toBe('开头用 Hi there，不要用 Dear customer')
    expect(proposals[0]?.lessons).toEqual([pooled[0]?.id])
    expect(lessons.list({ status: 'proposed' })).toHaveLength(1)

    // 夜里没有任何 overlay 变化
    expect(registry.listOverlays('customer-care')).toEqual([])
    const after = await registry.resolve('customer-care', ACTOR)
    expect(after?.markdown).toBe(before?.markdown)
    expect(after?.layers_applied).toEqual(['package'])
  })

  it('不同 assignment 各自成条（lesson 池是每人的）', async () => {
    await lessons.pool(correction({ assignment_id: 'asg-1' }))
    await lessons.pool(correction({ assignment_id: 'asg-2' }))
    expect(lessons.list({ status: 'pooled' })).toHaveLength(2)
  })

  it('不相似的文本不合并；不同段不合并', async () => {
    await lessons.pool(correction())
    await lessons.pool(correction({ text: '完全不相干的另一条经验，说的是物流时效' }))
    await lessons.pool(correction({ section_id: headingId(base.sections, '禁止事项') }))
    expect(lessons.list({ status: 'pooled' })).toHaveLength(3)
  })

  it('置信度低于门槛不进提议', async () => {
    await lessons.pool(correction({ strength: 'weak' }))
    const { proposals } = await lessons.consolidate('ws1', { now: clock.now() })
    expect(proposals).toEqual([])
    const raised = await lessons.consolidate('ws1', { now: clock.now(), threshold: 0.2 })
    expect(raised.proposals).toHaveLength(1)
  })

  it('别的工作区的 lesson 不进本工作区的整理', async () => {
    await lessons.pool(correction({ workspace_id: 'ws2' }))
    expect((await lessons.consolidate('ws1', { now: clock.now() })).proposals).toEqual([])
  })

  it('三种强度的初始置信度', async () => {
    const strong = await lessons.pool(correction({ strength: 'strong' }))
    const medium = await lessons.pool(correction({ strength: 'medium', text: '中等强度的另一条' }))
    const weak = await lessons.pool(correction({ strength: 'weak', text: '弱信号的第三条经验' }))
    expect([strong.confidence, medium.confidence, weak.confidence]).toEqual([0.6, 0.4, 0.25])
  })
})

describe('24 §6.4 策略层永不进学习回路', () => {
  it('段标题含"策略/额度" → 被过滤，不生成提议', async () => {
    await lessons.pool(correction({ section_id: policySection, text: '把单笔补偿上限提到 200 元' }))
    await lessons.pool(correction())
    const { proposals, filtered } = await lessons.consolidate('ws1', { now: clock.now() })
    expect(proposals.map((p) => p.section_id)).toEqual([greeting])
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.section_id).toBe(policySection)
    expect(filtered[0]?.reason).toBe('policy_layer')
    // 被过滤的 lesson 仍留在池里，不变 proposed
    expect(lessons.list({ status: 'pooled' })).toHaveLength(1)
  })

  it('skill 名在 policySkills 集合里 → 整条 skill 被过滤', async () => {
    await setup(['customer-care'])
    await lessons.pool(correction())
    const { proposals, filtered } = await lessons.consolidate('ws1', { now: clock.now() })
    expect(proposals).toEqual([])
    expect(filtered).toHaveLength(1)
  })

  it('policySkills 也能按次传入', async () => {
    await lessons.pool(correction())
    const out = await lessons.consolidate('ws1', {
      now: clock.now(),
      policySkills: ['customer-care'],
    })
    expect(out.proposals).toEqual([])
  })

  it('policy 关键词大小写不敏感，没有 section_id 时只看 skill 名', async () => {
    expect(lessons.isPolicyTarget('customer-care', policySection)).toBe(true)
    expect(lessons.isPolicyTarget('customer-care', greeting)).toBe(false)
    expect(lessons.isPolicyTarget('customer-care')).toBe(false)
    expect(lessons.isPolicyTarget('customer-care', 'UNKNOWN-SECTION')).toBe(false)
    expect(lessons.isPolicyTarget('mandate-skill', undefined, new Set(['mandate-skill']))).toBe(
      true,
    )
  })
})

describe('mark：接受 / 忽略 / 驳回', () => {
  it('接受 → accepted；忽略 → ×0.7；驳回 → 0', async () => {
    const a = await lessons.pool(correction())
    expect((await lessons.mark(a.id, 'accepted')).status).toBe('accepted')

    const b = await lessons.pool(correction({ assignment_id: 'asg-2' }))
    const ignored = await lessons.mark(b.id, 'ignored')
    expect(ignored.status).toBe('ignored')
    expect(ignored.confidence).toBe(0.42)

    const c = await lessons.pool(correction({ assignment_id: 'asg-3' }))
    const refuted = await lessons.mark(c.id, 'refuted')
    expect(refuted.confidence).toBe(0)
    expect(refuted.status).toBe('refuted')
  })

  it('忽略后再次出现 → 回到池里继续攒；驳回过的不复活', async () => {
    const a = await lessons.pool(correction())
    await lessons.mark(a.id, 'ignored')
    const again = await lessons.pool(correction({ run_id: 'run-9' }))
    expect(again.id).toBe(a.id)
    expect(again.status).toBe('pooled')
    expect(again.confirmations).toBe(2)

    const b = await lessons.pool(correction({ assignment_id: 'asg-2' }))
    await lessons.mark(b.id, 'refuted')
    const fresh = await lessons.pool(correction({ assignment_id: 'asg-2', run_id: 'run-10' }))
    expect(fresh.id).not.toBe(b.id)
    expect(fresh.confirmations).toBe(1)
  })

  it('mark 未知 id → not_found', async () => {
    await expect(lessons.mark('nope', 'accepted')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('get 能读回单条', async () => {
    const a = await lessons.pool(correction())
    expect(lessons.get(a.id)?.text).toBe(a.text)
    expect(lessons.get('nope')).toBeUndefined()
  })
})

describe('24 §6.5 每周巩固：三人相似修改 → 一条晋升提议', () => {
  async function threeAcceptedContributors(): Promise<void> {
    for (const asg of ['asg-1', 'asg-2', 'asg-3']) {
      const l = await lessons.pool(
        correction({
          assignment_id: asg,
          run_id: `run-${asg}`,
          text: `开头用 Hi there 而不是 Dear customer（${asg}）`,
        }),
      )
      await lessons.mark(l.id, 'accepted')
    }
  }

  it('生成一条 to_tier=department 的提议，contributors 含三人，evidence 含三条', async () => {
    await threeAcceptedContributors()
    clock.advanceDays(20)
    const { proposals } = await lessons.weeklyConsolidate('ws1', clock.now())
    expect(proposals).toHaveLength(1)
    const p = proposals[0]
    expect(p?.skill).toBe('customer-care')
    expect(p?.section_id).toBe(greeting)
    expect(p?.to_tier).toBe('department')
    expect(p?.contributors.sort()).toEqual(['asg-1', 'asg-2', 'asg-3'])
    expect(p?.evidence).toHaveLength(3)
    expect(p?.criteria.contributors).toBe(3)
    expect(p?.criteria.age_days).toBeGreaterThanOrEqual(14)
  })

  it('只有一个人接受 → 不晋升（07 §1：≥ 2 个贡献者）', async () => {
    const l = await lessons.pool(correction())
    await lessons.mark(l.id, 'accepted')
    expect((await lessons.weeklyConsolidate('ws1', clock.now())).proposals).toEqual([])
  })

  it('策略层的段即便三人接受也不晋升；目标层可指定', async () => {
    for (const asg of ['asg-1', 'asg-2']) {
      const l = await lessons.pool(
        correction({
          assignment_id: asg,
          section_id: policySection,
          text: '把补偿上限提到 200 元',
        }),
      )
      await lessons.mark(l.id, 'accepted')
    }
    expect((await lessons.weeklyConsolidate('ws1', clock.now())).proposals).toEqual([])

    await threeAcceptedContributors()
    const out = await lessons.weeklyConsolidate('ws1', clock.now(), { to_tier: 'company' })
    expect(out.proposals.map((p) => p.to_tier)).toEqual(['company'])
  })
})

describe('24 §6.6 晋升 eval 红 → 拒绝', () => {
  it('evalResult 红 → accepted=false 并给原因', async () => {
    const out = await lessons.promote({
      skill: 'customer-care',
      section_ids: [greeting],
      from: { tier: 'personal', owner: 'p1' },
      to_tier: 'department',
      evalResult: { status: 'red', failed: ['refund-window', 'tone'] },
    })
    expect(out.accepted).toBe(false)
    if (out.accepted) throw new Error('unreachable')
    expect(out.code).toBe('not_approved')
    expect(out.reason).toContain('eval')
    expect(out.reason).toContain('refund-window')
  })

  it('eval 绿 → 产出 skill_promotion 审批请求，且不动任何一层', async () => {
    const l = await lessons.pool(correction())
    await lessons.mark(l.id, 'accepted')
    const out = await lessons.promote({
      skill: 'customer-care',
      section_ids: [greeting],
      from: { tier: 'personal', owner: 'p1' },
      to_tier: 'company',
      evidence: [l.id],
      evalResult: { status: 'green' },
    })
    expect(out.accepted).toBe(true)
    if (!out.accepted) throw new Error('unreachable')
    expect(out.approval_request.kind).toBe('skill_promotion')
    expect(out.approval_request.to_tier).toBe('company')
    expect(out.approval_request.contributors).toEqual(['asg-1'])
    expect(registry.listOverlays('customer-care')).toEqual([])
    expect((await registry.resolve('customer-care', ACTOR))?.layers_applied).toEqual(['package'])
  })

  it('eval 红只给 detail 时也带出原因', async () => {
    const out = await lessons.promote({
      skill: 'customer-care',
      section_ids: [greeting],
      from: { tier: 'personal', owner: 'p1' },
      to_tier: 'department',
      evalResult: { status: 'red', detail: '两条回归' },
    })
    expect(out.accepted).toBe(false)
    if (out.accepted) throw new Error('unreachable')
    expect(out.reason).toContain('两条回归')
  })

  it('目标层不高于来源层 → invalid_input；没有段 → 报错', async () => {
    const out = await lessons.promote({
      skill: 'customer-care',
      section_ids: [greeting],
      from: { tier: 'company', owner: 'ws1' },
      to_tier: 'personal',
    })
    expect(out.accepted).toBe(false)
    if (out.accepted) throw new Error('unreachable')
    expect(out.code).toBe('invalid_input')

    await expect(
      lessons.promote({
        skill: 'customer-care',
        section_ids: [],
        from: { tier: 'personal', owner: 'p1' },
        to_tier: 'company',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('enforce_criteria 打开时按 07 §1 的四条判据拦', async () => {
    const l = await lessons.pool(correction())
    await lessons.mark(l.id, 'accepted')
    const blocked = await lessons.promote({
      skill: 'customer-care',
      section_ids: [greeting],
      from: { tier: 'personal', owner: 'p1' },
      to_tier: 'company',
      evidence: [l.id],
      enforce_criteria: true,
    })
    expect(blocked.accepted).toBe(false)
    if (blocked.accepted) throw new Error('unreachable')
    expect(blocked.criteria?.missing).toEqual([
      '置信度 < 0.9',
      '采用次数 < 5',
      '贡献者 < 2',
      '存在时间 < 14 天',
    ])

    // 攒够：3 人 × 各自确认到 0.99，跨过 14 天
    const ids: string[] = [l.id]
    for (const asg of ['asg-2', 'asg-3']) {
      let last = l.id
      for (let i = 0; i < 4; i++) {
        const r = await lessons.pool(correction({ assignment_id: asg, run_id: `r-${asg}-${i}` }))
        last = r.id
      }
      await lessons.mark(last, 'accepted')
      ids.push(last)
    }
    clock.advanceDays(15)
    const ok = await lessons.promote({
      skill: 'customer-care',
      section_ids: [greeting],
      from: { tier: 'personal', owner: 'p1' },
      to_tier: 'company',
      evidence: ids,
      enforce_criteria: true,
      now: clock.now(),
    })
    expect(ok.accepted).toBe(true)
    if (!ok.accepted) throw new Error('unreachable')
    expect(ok.criteria?.passed).toBe(true)
  })
})
