import { describe, expect, it } from 'vitest'
import type { ExtractedLesson, PooledLesson, SkillReader } from '../src/index.js'
import {
  DEFAULT_MAX_OPTIONS,
  draftProposals,
  extractLessons,
  isPolicySection,
  LearningPool,
  OPTION_NONE,
  skillReaderOf,
} from '../src/index.js'
import { counterIds, extractInput, fixture, TestClock } from './helpers.js'

const NOW = '2026-09-08T07:30:00.000Z'

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

function poolOf(): LearningPool {
  return new LearningPool({ clock: new TestClock(), nextId: counterIds() })
}

describe('24 §3 次日提案：选择题卡，夜里不写任何 overlay', () => {
  it('两次同类纠正 → 一张卡，2–3 个候选改法 + 都不要', async () => {
    const f = await fixture()
    const pool = poolOf()
    const section = f.sections[0]
    if (section === undefined) throw new Error('夹具缺段')
    pool.pool(reject('退货窗口从送达日算', section.id))
    pool.pool(reject('退货窗口从送达日算', section.id))

    const before = f.skills.registry.listOverlays('customer-care')
    const { proposals, filtered } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
    })
    expect(filtered).toEqual([])
    expect(proposals).toHaveLength(1)
    const card = proposals[0]
    expect(card?.section_id).toBe(section.id)
    expect(card?.hits).toBe(2)
    expect(card?.options.map((o) => o.id)).toEqual(['append', 'replace', OPTION_NONE])
    expect(card?.options.at(-1)?.label).toBe('都不要')
    expect(card?.diff.before).toBe(section.body)
    expect(card?.diff.after).toContain('退货窗口从送达日算')
    expect(card?.evidence.quotes).toContain('退货窗口从送达日算')
    expect(card?.evidence.approval_item_ids).toEqual(['ai_1'])
    // 夜里 overlay 一个字不动（24 §6.3）
    expect(f.skills.registry.listOverlays('customer-care')).toEqual(before)
  })

  it('单条但置信度 ≥ 0.8 也出卡；一次且置信度不够 → below_threshold', async () => {
    const f = await fixture()
    const section = f.sections[0]
    if (section === undefined) throw new Error('夹具缺段')
    const one = poolOf()
    one.pool(reject('金额一律写清币种', section.id))
    const weak = draftProposals({
      workspace_id: 'ws_1',
      lessons: one.list(),
      skills: f.reader,
      now: NOW,
    })
    expect(weak.proposals).toEqual([])
    expect(weak.filtered[0]?.reason).toBe('below_threshold')
    expect(weak.filtered[0]?.detail).toContain('置信度')

    const strong = draftProposals({
      workspace_id: 'ws_1',
      lessons: one.list().map((l) => ({ ...l, confidence: 0.85 }) as PooledLesson),
      skills: f.reader,
      now: NOW,
    })
    expect(strong.proposals).toHaveLength(1)
  })

  it('第二种说法进第三个选项，并按 maxOptions 截断', async () => {
    const f = await fixture()
    const section = f.sections[1]
    if (section === undefined) throw new Error('夹具缺段')
    const pool = poolOf()
    pool.pool(reject('开头直接叫客户名字不要用 Dear Customer', section.id))
    pool.pool(reject('开头用名字称呼客户不要写 Dear Customer 这种', section.id))
    const all = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
    })
    const ids = all.proposals[0]?.options.map((o) => o.id) ?? []
    expect(ids.length).toBeLessThanOrEqual(DEFAULT_MAX_OPTIONS + 1)

    const trimmed = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
      maxOptions: 1,
    })
    expect(trimmed.proposals[0]?.options.map((o) => o.id)).toEqual(['append', OPTION_NONE])
  })

  it('没写段的 lesson 落到词面最像的那一段；一条都不沾就落最后一段', async () => {
    const f = await fixture()
    const pool = poolOf()
    pool.pool(reject('退货窗口从送达日算'))
    pool.pool(reject('退货窗口从送达日算'))
    const { proposals } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
    })
    // 「退货窗口计算」那一段（不是最后一段「回信语气」）
    expect(proposals[0]?.heading).toBe('退货窗口计算')
    expect(proposals[0]?.section_id).toBe(f.sections[0]?.id)

    const stray = poolOf()
    stray.pool(reject('zzz qqq xxx yyy'))
    stray.pool(reject('zzz qqq xxx yyy'))
    const fallback = draftProposals({
      workspace_id: 'ws_1',
      lessons: stray.list(),
      skills: f.reader,
      now: NOW,
    })
    expect(fallback.proposals[0]?.section_id).toBe(f.sections.at(-1)?.id)
  })
})

describe('三道闸门', () => {
  it('① 策略层：技能名在名单里 → policy_layer', async () => {
    const f = await fixture()
    const pool = poolOf()
    pool.pool(reject('退款额度提到 500'))
    pool.pool(reject('退款额度提到 500'))
    const { proposals, filtered } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
      policySkills: ['customer-care'],
    })
    expect(proposals).toEqual([])
    expect(filtered[0]?.reason).toBe('policy_layer')
  })

  it('① 策略层：段标题命中关键词也拦', async () => {
    expect(isPolicySection('额度与策略')).toBe(true)
    expect(isPolicySection('Refund policy')).toBe(true)
    expect(isPolicySection('回信语气')).toBe(false)

    const reader: SkillReader = {
      sections: () => [{ id: 'sec_p', heading: '退款额度', body: '单笔不超过 200' }],
    }
    const pool = poolOf()
    pool.pool(reject('额度提到 500', 'sec_p'))
    pool.pool(reject('额度提到 500', 'sec_p'))
    const { filtered } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: reader,
      now: NOW,
    })
    expect(filtered[0]?.reason).toBe('policy_layer')
  })

  it('② 被驳回过的语义键 → rejected_before', async () => {
    const f = await fixture()
    const pool = poolOf()
    const first = pool.pool(reject('退货窗口从送达日算'))
    pool.pool(reject('退货窗口从送达日算'))
    const { filtered } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
      rejectedKeys: [first.semantic_key],
    })
    expect(filtered[0]?.reason).toBe('rejected_before')
    expect(filtered[0]?.detail).toContain('不再提')
  })

  it('③ 技能一段都没有 → no_target_section', () => {
    const pool = poolOf()
    pool.pool(reject('随便一条'))
    pool.pool(reject('随便一条'))
    const { proposals, filtered } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: { sections: () => [] },
      now: NOW,
    })
    expect(proposals).toEqual([])
    expect(filtered[0]?.reason).toBe('no_target_section')
  })

  it('④ 这条已经在段落里了 → empty_diff', () => {
    const pool = poolOf()
    pool.pool(reject('金额一律写清币种'))
    pool.pool(reject('金额一律写清币种'))
    const text = pool.list()[0]?.text ?? ''
    const { proposals, filtered } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: { sections: () => [{ id: 'sec_1', heading: '写法', body: text }] },
      now: NOW,
    })
    expect(proposals).toEqual([])
    expect(filtered[0]?.reason).toBe('empty_diff')
  })

  it('只看本工作区、只看 pooled 状态', async () => {
    const f = await fixture()
    const pool = poolOf()
    const a = pool.pool(reject('退货窗口从送达日算'))
    pool.pool(reject('退货窗口从送达日算'))
    pool.mark(a.id, 'proposed')
    expect(
      draftProposals({ workspace_id: 'ws_1', lessons: pool.list(), skills: f.reader, now: NOW })
        .proposals,
    ).toEqual([])
    expect(
      draftProposals({ workspace_id: 'ws_other', lessons: pool.list(), skills: f.reader, now: NOW })
        .proposals,
    ).toEqual([])
  })
})

describe('skillReaderOf', () => {
  it('把注册表包成只读面', async () => {
    const f = await fixture()
    const reader = skillReaderOf(f.skills.registry)
    expect(reader.sections('customer-care').length).toBe(f.sections.length)
    expect(reader.sections('nope')).toEqual([])
  })
})

describe('聚类、代表与标题', () => {
  const pooled = (over: Partial<PooledLesson> & { id: string }): PooledLesson => ({
    workspace_id: 'ws_1',
    assignment_id: 'asg_1',
    run_id: 'run_1',
    applies_to: { skill: 'customer-care', section_id: 'sec_1' },
    kind: 'rule',
    signal: 'reject',
    strength: 'strong',
    text: '退货窗口从送达日算',
    confidence: 0.9,
    semantic_key: 'k_default',
    evidence: [{ quote: '退货窗口从送达日算', at: '2026-09-07T10:00:00.000Z' }],
    hits: 2,
    status: 'pooled',
    created_at: '2026-09-07T10:00:00.000Z',
    updated_at: '2026-09-07T10:00:00.000Z',
    runs: ['run_1'],
    assignments: ['asg_1'],
    ...over,
  })

  const reader: SkillReader = {
    sections: () => [{ id: 'sec_1', heading: '退货窗口计算', body: '以送达日为起点。' }],
  }

  it('像但不同的两条聚成一张卡，第二种说法进第三个选项', () => {
    const { proposals } = draftProposals({
      workspace_id: 'ws_1',
      lessons: [
        pooled({ id: 'l1', semantic_key: 'k1', text: '退货窗口从送达日算起' }),
        pooled({ id: 'l2', semantic_key: 'k2', text: '退货窗口从送达日算，别用下单日' }),
      ],
      skills: reader,
      now: NOW,
    })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.options.map((o) => o.id)).toEqual([
      'append',
      'replace',
      'append_alt',
      OPTION_NONE,
    ])
    expect(proposals[0]?.lessons).toEqual(['l1', 'l2'])
  })

  it('八竿子打不着的两条各出一张卡', () => {
    const { proposals } = draftProposals({
      workspace_id: 'ws_1',
      lessons: [
        pooled({ id: 'l1', semantic_key: 'k1', text: '退货窗口从送达日算起' }),
        pooled({ id: 'l2', semantic_key: 'k2', text: '金额一律写清币种 USD' }),
      ],
      skills: reader,
      now: NOW,
    })
    expect(proposals).toHaveLength(2)
  })

  it('代表按置信度 → hits → 时间 → id 排；标题超过 28 字截断', () => {
    const long = '退货窗口一律从物流签收当天开始算起而不是从客户下单的那一天开始算'
    const { proposals } = draftProposals({
      workspace_id: 'ws_1',
      lessons: [
        pooled({ id: 'l_b', semantic_key: 'k1', text: long, confidence: 0.9, hits: 2 }),
        pooled({ id: 'l_a', semantic_key: 'k1', text: long, confidence: 0.9, hits: 2 }),
      ],
      skills: reader,
      now: NOW,
    })
    expect(proposals[0]?.title).toContain('…')
    expect(proposals[0]?.title.length).toBeLessThan(60)
    expect(proposals[0]?.hits).toBe(4)
  })
})
