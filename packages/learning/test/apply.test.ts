import { describe, expect, it } from 'vitest'
import type { ExtractedLesson, LessonProposalCard } from '../src/index.js'
import {
  applyLessonDecision,
  bumpPatch,
  draftProposals,
  extractLessons,
  LearningPool,
  OPTION_NONE,
} from '../src/index.js'
import { counterIds, extractInput, fixture, TestClock } from './helpers.js'

const NOW = '2026-09-08T07:30:00.000Z'
const ACTOR = { person_id: 'p_wang', workspace_id: 'ws_1' }

function reject(reason: string, section_id?: string): ExtractedLesson {
  const out = extractLessons(
    extractInput({
      decisions: [
        { approval_item_id: 'ai_1', action: 'reject', at: '2026-09-07T10:00:00.000Z', reason },
      ],
      applies_to: {
        skill: 'customer-care',
        ...(section_id === undefined ? {} : { section_id }),
      },
    }),
  )
  const first = out[0]
  if (first === undefined) throw new Error('夹具没抽出 lesson')
  return first
}

async function scene(): Promise<{
  f: Awaited<ReturnType<typeof fixture>>
  pool: LearningPool
  card: LessonProposalCard
}> {
  const f = await fixture()
  const pool = new LearningPool({ clock: new TestClock(), nextId: counterIds() })
  const section = f.sections[0]
  if (section === undefined) throw new Error('夹具缺段')
  pool.pool(reject('退货窗口从送达日算，不是下单日', section.id))
  pool.pool(reject('退货窗口从送达日算，不是下单日', section.id))
  const { proposals } = draftProposals({
    workspace_id: 'ws_1',
    lessons: pool.list(),
    skills: f.reader,
    now: NOW,
  })
  const card = proposals[0]
  if (card === undefined) throw new Error('夹具没出提案')
  return { f, pool, card }
}

describe('bumpPatch', () => {
  it('1.4 → 1.4.1；1.4.2 → 1.4.3；非语义版本加 +1', () => {
    expect(bumpPatch('1.4')).toBe('1.4.1')
    expect(bumpPatch('1.4.2')).toBe('1.4.3')
    expect(bumpPatch(' 2.0.9 ')).toBe('2.0.10')
    expect(bumpPatch('rolling')).toBe('rolling+1')
  })
})

describe('24 §2 采纳 → 写个人 overlay，版本 +1，带出处', () => {
  it('采纳 append：overlay 有 origin=learned 与 learned_from，解析后正文含新规则', async () => {
    const { f, pool, card } = await scene()
    const before = await f.skills.registry.resolve('customer-care', ACTOR)
    expect(before?.markdown).not.toContain('退货窗口从送达日算')

    const out = await applyLessonDecision(
      {
        proposal: card,
        action: 'accept',
        selected_option_id: 'append',
        owner: 'p_wang',
        by: 'p_wang',
        at: NOW,
      },
      { registry: f.skills.registry, pool },
    )
    expect(out.status).toBe('applied')
    expect(out.ops).toHaveLength(1)
    expect(out.ops[0]).toMatchObject({ op: 'append', origin: 'learned' })
    expect(out.ops[0]?.learned_from?.lessons).toEqual(card.lessons)
    expect(out.overlay?.tier).toBe('personal')
    expect(out.overlay_version).toBe(1)
    // 公司层有技能记录 → 版本 patch +1 不动；这里落个人层，公司层不该变
    expect(
      (await f.skills.registry.get('customer-care', 'company', { workspace_id: 'ws_1' }))?.version,
    ).toBe('1.4')

    const after = await f.skills.registry.resolve('customer-care', ACTOR)
    expect(after?.markdown).toContain('退货窗口从送达日算')
    expect(after?.layers_applied).toContain('personal')
    for (const id of card.lessons) expect(pool.get(id)?.status).toBe('accepted')
  })

  it('落到公司层时该层技能版本 patch +1', async () => {
    const { f, pool, card } = await scene()
    const out = await applyLessonDecision(
      {
        proposal: card,
        action: 'accept',
        selected_option_id: 'replace',
        tier: 'company',
        owner: 'ws_1',
        by: 'p_owner',
        at: NOW,
      },
      { registry: f.skills.registry, pool },
    )
    expect(out.skill_version).toBe('1.4.1')
    expect(
      (await f.skills.registry.get('customer-care', 'company', { workspace_id: 'ws_1' }))?.version,
    ).toBe('1.4.1')
    expect(out.overlay?.base_version).toBe('1.4')
  })

  it('不给 selected_option_id 时取第一个候选', async () => {
    const { f, pool, card } = await scene()
    const out = await applyLessonDecision(
      { proposal: card, action: 'accept', owner: 'p_wang', by: 'p_wang', at: NOW },
      { registry: f.skills.registry, pool },
    )
    expect(out.ops[0]?.op).toBe('append')
  })

  it('编辑后采纳：用人改过的文本', async () => {
    const { f, pool, card } = await scene()
    const out = await applyLessonDecision(
      {
        proposal: card,
        action: 'accept',
        selected_option_id: 'append',
        edited_text: '窗口按送达日 +14 天算，节假日不顺延',
        owner: 'p_wang',
        by: 'p_wang',
        at: NOW,
      },
      { registry: f.skills.registry, pool },
    )
    expect(out.ops[0]?.body).toBe('窗口按送达日 +14 天算，节假日不顺延')
    const after = await f.skills.registry.resolve('customer-care', ACTOR)
    expect(after?.markdown).toContain('节假日不顺延')
  })

  it('编辑成空 → invalid_input', async () => {
    const { f, pool, card } = await scene()
    await expect(
      applyLessonDecision(
        {
          proposal: card,
          action: 'accept',
          edited_text: '   ',
          owner: 'p_wang',
          by: 'p_wang',
          at: NOW,
        },
        { registry: f.skills.registry, pool },
      ),
    ).rejects.toThrowError(/不能为空/)
  })

  it('同一段再学一条 → 换掉上一条学来的，不叠成两条', async () => {
    const { f, pool, card } = await scene()
    await applyLessonDecision(
      { proposal: card, action: 'accept', owner: 'p_wang', by: 'p_wang', at: NOW },
      { registry: f.skills.registry, pool },
    )
    const second = await applyLessonDecision(
      {
        proposal: { ...card, lessons: ['les_9'] },
        action: 'accept',
        edited_text: '新的一条',
        owner: 'p_wang',
        by: 'p_wang',
        at: NOW,
      },
      { registry: f.skills.registry, pool: undefined },
    )
    expect(second.ops).toHaveLength(1)
    expect(second.ops[0]?.body).toBe('新的一条')
    expect(second.overlay_version).toBe(2)
  })

  it('人手写的 overlay 不会被学习回路顶掉', async () => {
    const { f, pool, card } = await scene()
    await f.skills.registry.setOverlay({
      skill: 'customer-care',
      tier: 'personal',
      owner: 'p_wang',
      ops: [
        { op: 'append', section_id: card.section_id, body: '我自己写的一句', origin: 'authored' },
      ],
      base_version: '1.4',
      version: 0,
    })
    const out = await applyLessonDecision(
      { proposal: card, action: 'accept', owner: 'p_wang', by: 'p_wang', at: NOW },
      { registry: f.skills.registry, pool },
    )
    expect(out.ops).toHaveLength(2)
    expect(out.ops[0]?.origin).toBe('authored')
  })
})

describe('不采纳的三条路', () => {
  it('驳回 → lesson refuted + 语义键进黑名单，不写 overlay', async () => {
    const { f, pool, card } = await scene()
    const out = await applyLessonDecision(
      {
        proposal: card,
        action: 'reject',
        reason: '这条不对',
        owner: 'p_wang',
        by: 'p_wang',
        at: NOW,
      },
      { registry: f.skills.registry, pool },
    )
    expect(out.status).toBe('declined')
    expect(out.ops).toEqual([])
    expect(out.blacklisted).toBe(card.semantic_key)
    expect(f.skills.registry.listOverlays('customer-care')).toEqual([])
    expect(pool.isRejected('ws_1', card.semantic_key)).toBe(true)
    for (const id of card.lessons) expect(pool.get(id)?.status).toBe('refuted')
  })

  it('驳回不写原因也记一条（默认理由）', async () => {
    const { f, pool, card } = await scene()
    await applyLessonDecision(
      { proposal: card, action: 'reject', owner: 'p_wang', by: 'p_wang', at: NOW },
      { registry: f.skills.registry, pool },
    )
    expect(pool.rejectedKeys('ws_1')[0]?.reason).toBe('rejected_by_person')
  })

  it('稍后 / 没理（ignore）→ 置信度衰减，不进黑名单', async () => {
    const { f, pool, card } = await scene()
    const out = await applyLessonDecision(
      { proposal: card, action: 'ignore', owner: 'p_wang', by: 'p_wang', at: NOW },
      { registry: f.skills.registry, pool },
    )
    expect(out.status).toBe('ignored')
    expect(pool.rejectedKeys('ws_1')).toEqual([])
    for (const id of card.lessons) expect(pool.get(id)?.status).toBe('ignored')
  })

  it('选了「都不要」→ 当作忽略，不进黑名单', async () => {
    const { f, pool, card } = await scene()
    const out = await applyLessonDecision(
      {
        proposal: card,
        action: 'accept',
        selected_option_id: OPTION_NONE,
        owner: 'p_wang',
        by: 'p_wang',
        at: NOW,
      },
      { registry: f.skills.registry, pool },
    )
    expect(out.status).toBe('ignored')
    expect(out.ops).toEqual([])
    expect(pool.rejectedKeys('ws_1')).toEqual([])
  })

  it('选了不存在的选项 → 也按「都不要」处理，不乱写', async () => {
    const { f, pool, card } = await scene()
    const out = await applyLessonDecision(
      {
        proposal: card,
        action: 'accept',
        selected_option_id: 'nope',
        owner: 'p_wang',
        by: 'p_wang',
        at: NOW,
      },
      { registry: f.skills.registry, pool },
    )
    expect(out.status).toBe('ignored')
  })
})

describe('部门层与 base_version', () => {
  it('部门层落到 scope_id；base_version 可显式给', async () => {
    const { f, pool, card } = await scene()
    const out = await applyLessonDecision(
      {
        proposal: card,
        action: 'accept',
        tier: 'department',
        owner: 'dept_ops',
        base_version: '9.9',
        by: 'p_lead',
        at: NOW,
      },
      { registry: f.skills.registry, pool },
    )
    expect(out.overlay?.tier).toBe('department')
    expect(out.overlay?.owner).toBe('dept_ops')
    expect(out.overlay?.base_version).toBe('9.9')
    expect(out.skill_version).toBeUndefined()
  })

  it('注册表没有 bumpVersion 也能落（可选方法）', async () => {
    const { f, pool, card } = await scene()
    const registry = {
      getOverlay: (s: string, t: 'personal', o: string) => f.skills.registry.getOverlay(s, t, o),
      setOverlay: (o: Parameters<typeof f.skills.registry.setOverlay>[0]) =>
        f.skills.registry.setOverlay(o),
      get: (n: string, t: 'company', scope?: { workspace_id?: string }) =>
        f.skills.registry.get(n, t, scope),
    }
    const out = await applyLessonDecision(
      { proposal: card, action: 'accept', tier: 'company', owner: 'ws_1', by: 'p1', at: NOW },
      { registry: registry as never, pool },
    )
    expect(out.skill_version).toBe('1.4.1')
  })
})
