/**
 * 24 §6 一致性用例，逐条走一遍**整条回路**（抽取 → 池 → 提案 → 采纳 → 下次运行）。
 *
 * 与 `@agentsws/skills` 那份的分工：那边验的是注册表本身（段 id、叠加、rebase）；
 * 这边验的是"学习回路接上去之后，这七条还成立吗"。
 */
import { createSkills } from '@agentsws/skills'
import { describe, expect, it } from 'vitest'
import type { ExtractedLesson, LessonProposalCard, PooledLesson } from '../src/index.js'
import {
  applyLessonDecision,
  draftProposals,
  extractLessons,
  LearningPool,
  skillPromptSections,
  skillReaderOf,
  weeklyPromotions,
} from '../src/index.js'
import { counterIds, extractInput, fixture, SKILL_MD, seeded, TestClock } from './helpers.js'

const NOW = '2026-09-08T07:30:00.000Z'
const ACTOR = { person_id: 'p_wang', workspace_id: 'ws_1' }

function correction(
  reason: string,
  section_id?: string,
  over: Record<string, unknown> = {},
): ExtractedLesson {
  const out = extractLessons(
    extractInput({
      decisions: [
        { approval_item_id: 'ai_1', action: 'reject', at: '2026-09-07T10:00:00.000Z', reason },
      ],
      applies_to: {
        skill: 'customer-care',
        ...(section_id === undefined ? {} : { section_id }),
      },
      ...over,
    }),
  )
  const first = out[0]
  if (first === undefined) throw new Error('夹具没抽出 lesson')
  return first
}

const poolOf = (): LearningPool =>
  new LearningPool({ clock: new TestClock(), nextId: counterIds() })

describe('24 §6.1 公司版改标题不改段 id → 学来的个人 overlay 仍叠上', () => {
  it('改了标题之后，采纳过的那一条还在解析结果里', async () => {
    const f = await fixture()
    const section = f.sections[0]
    if (section === undefined) throw new Error('夹具缺段')
    const pool = poolOf()
    pool.pool(correction('退货窗口从送达日算', section.id))
    pool.pool(correction('退货窗口从送达日算', section.id))
    const card = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
    }).proposals[0] as LessonProposalCard
    await applyLessonDecision(
      { proposal: card, action: 'accept', owner: 'p_wang', by: 'p_wang', at: NOW },
      { registry: f.skills.registry, pool },
    )

    await f.skills.registry.putFromMarkdown({
      markdown: SKILL_MD.replace('## 退货窗口计算', '## 退货窗口怎么算'),
      tier: 'company',
      owner: 'p_owner',
      version: '1.5',
      workspace_id: 'ws_1',
    })
    const resolved = await f.skills.registry.resolve('customer-care', ACTOR)
    expect(resolved?.markdown).toContain('退货窗口怎么算')
    expect(resolved?.markdown).toContain('退货窗口从送达日算')
  })
})

describe('24 §6.2 同段两边都改 → conflict，不自动合', () => {
  it('公司层改了那一段，个人层学来的那一段仍在 conflicts 里报出来', async () => {
    const f = await fixture()
    const section = f.sections[0]
    if (section === undefined) throw new Error('夹具缺段')
    const pool = poolOf()
    pool.pool(correction('退货窗口从送达日算', section.id))
    pool.pool(correction('退货窗口从送达日算', section.id))
    const card = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
    }).proposals[0] as LessonProposalCard
    await applyLessonDecision(
      {
        proposal: card,
        action: 'accept',
        selected_option_id: 'replace',
        owner: 'p_wang',
        by: 'p_wang',
        at: NOW,
      },
      { registry: f.skills.registry, pool },
    )
    await f.skills.registry.putFromMarkdown({
      markdown: SKILL_MD.replace('14 天内可退', '30 天内可退'),
      tier: 'company',
      owner: 'p_owner',
      version: '1.5',
      workspace_id: 'ws_1',
    })
    const { conflicts } = await f.skills.registry.rebase('customer-care', 'personal', {
      owner: 'p_wang',
    })
    expect(conflicts.map((c) => c.section_id)).toContain(section.id)
    expect(conflicts[0]?.versions).toHaveLength(2)
  })
})

describe('24 §6.3 五次相同纠正 → 一条 lesson、次日一条提议、夜里没有任何 overlay 变化', () => {
  it('池里一条 hits=5；提案一张；夜间整理不写 overlay', async () => {
    const f = await fixture()
    const section = f.sections[0]
    if (section === undefined) throw new Error('夹具缺段')
    const pool = poolOf()
    for (let i = 0; i < 5; i += 1) pool.pool(correction('退货窗口从送达日算', section.id))

    const before = await f.skills.registry.resolve('customer-care', ACTOR)
    const { proposals } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
    })
    const after = await f.skills.registry.resolve('customer-care', ACTOR)

    expect(pool.list()).toHaveLength(1)
    expect(pool.list()[0]?.hits).toBe(5)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.hits).toBe(5)
    expect(f.skills.registry.listOverlays('customer-care')).toEqual([])
    expect(after?.markdown).toBe(before?.markdown)
  })
})

describe('24 §6.4 策略层的段被学习回路选中 → 被过滤，不生成提议', () => {
  it('段标题命中策略关键词 → filtered: policy_layer', async () => {
    const clock = new TestClock()
    const skills = createSkills({ clock, random: seeded(7) })
    await skills.registry.putFromMarkdown({
      markdown: `---\nname: customer-care\n---\n\n## 额度与策略\n\n单笔退款不超过 200 USD。\n`,
      tier: 'company',
      owner: 'p_owner',
      version: '1.0',
      workspace_id: 'ws_1',
    })
    const target = skills.registry.listSections('customer-care')[0]
    if (target === undefined) throw new Error('夹具缺段')
    const pool = poolOf()
    pool.pool(correction('额度提到 500', target.id))
    pool.pool(correction('额度提到 500', target.id))
    const { proposals, filtered } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: skillReaderOf(skills.registry),
      now: NOW,
    })
    expect(proposals).toEqual([])
    expect(filtered[0]?.reason).toBe('policy_layer')
    expect(skills.registry.listOverlays('customer-care')).toEqual([])
  })
})

describe('24 §6.5 三人接受相似修改 → 周合并生成一条晋升提议，evidence 含三人', () => {
  it('三个 assignment 的 accepted 汇成一张 skill_promotion 卡', async () => {
    const f = await fixture()
    const section = f.sections[0]
    if (section === undefined) throw new Error('夹具缺段')
    const pool = poolOf()
    for (const asg of ['asg_1', 'asg_2', 'asg_3']) {
      const l = pool.pool({
        ...correction('退货窗口从送达日算', section.id),
        assignment_id: asg,
      })
      for (let i = 0; i < 24; i += 1) {
        pool.pool({ ...correction('退货窗口从送达日算', section.id), assignment_id: asg })
      }
      pool.mark(l.id, 'accepted', '2026-09-08T00:00:00.000Z')
    }
    const aged: PooledLesson[] = pool
      .list()
      .map((l) => ({ ...l, created_at: '2026-08-01T00:00:00.000Z' }))
    const { cards } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: aged,
      now: '2026-09-08T06:00:00.000Z',
      from: { tier: 'personal', owner: 'p_wang' },
    })
    expect(cards).toHaveLength(1)
    expect(cards[0]?.contributors.sort()).toEqual(['asg_1', 'asg_2', 'asg_3'])
    expect(cards[0]?.evidence.quotes).toContain('退货窗口从送达日算')
  })
})

describe('24 §6.6 晋升 eval 红 → 预检 blocked', () => {
  it('eval 红时一张卡都不出', () => {
    const base: PooledLesson[] = ['asg_1', 'asg_2'].map((asg, i) => ({
      workspace_id: 'ws_1',
      assignment_id: asg,
      run_id: 'run_1',
      applies_to: { skill: 'customer-care', section_id: 'sec_1' },
      kind: 'rule',
      signal: 'reject',
      strength: 'strong',
      text: '退货窗口从送达日算',
      confidence: 0.99,
      semantic_key: 'k1',
      evidence: [],
      hits: 40,
      status: 'accepted',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: NOW,
      runs: ['run_1'],
      assignments: [asg],
      id: `l${i}`,
    }))
    const { cards, blocked } = weeklyPromotions({
      workspace_id: 'ws_1',
      lessons: base,
      now: NOW,
      from: { tier: 'personal', owner: 'p_wang' },
      evalResult: { status: 'red', failed: ['tone'] },
    })
    expect(cards).toEqual([])
    expect(blocked[0]?.reason).toBe('eval_red')
  })
})

describe('24 §6.7 排除某 skill → 它不进 RunRequest 的 prompt', () => {
  it('排除之后 persona 段里没有它；没排除时含学来的那条', async () => {
    const f = await fixture()
    const section = f.sections[0]
    if (section === undefined) throw new Error('夹具缺段')
    const pool = poolOf()
    pool.pool(correction('退货窗口从送达日算', section.id))
    pool.pool(correction('退货窗口从送达日算', section.id))
    const card = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
    }).proposals[0] as LessonProposalCard
    await applyLessonDecision(
      { proposal: card, action: 'accept', owner: 'p_wang', by: 'p_wang', at: NOW },
      { registry: f.skills.registry, pool },
    )

    const skills = [
      { name: 'customer-care', tier: 'open' as const, load: 'always' as const },
      { name: 'not-installed', tier: 'open' as const, load: 'always' as const },
      { name: 'lazy', tier: 'open' as const, load: 'on_demand' as const },
    ]
    const before = await skillPromptSections({
      skills,
      actor: ACTOR,
      registry: f.skills.registry,
    })
    expect(before).toHaveLength(1)
    expect(before[0]?.id).toBe('skill_customer-care')
    expect(before[0]?.text).toContain('退货窗口从送达日算')

    await f.skills.registry.exclude('customer-care', 'p_wang', true)
    expect(
      await skillPromptSections({ skills, actor: ACTOR, registry: f.skills.registry }),
    ).toEqual([])
  })
})
