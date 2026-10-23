/**
 * WP486（Luoye 10-23 真机，Reddit 运营岗位）：一张「昨天学到的：给「不写的东西」加一条 不要」。
 *
 * 来历：WP414 起「不要」不强制写理由，没写时决定上记的理由就是「不要」两个字（`REJECT_NO_REASON`）。
 * 学习回路把它当人的原话收了：两次光点「不要」→ 语义键一样 → hits 2 → 过门槛 → 出卡，
 * 规矩文本就是「不要」。这里钉住三件事：
 * 1. 光点「不要」（以及别的按钮名 / 系统代填的那一句）攒不出 lesson；
 * 2. 规矩文本太短（≤ 4 个字）不出卡；
 * 3. 卡上带「攒出这条的那几次纠正」，正文说得出在哪几张卡上做了什么。
 */
import { NOT_WIRED_ACK_REASON } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { HumanDecision } from '../src/index.js'
import {
  draftProposals,
  extractLessons,
  isButtonOnlyText,
  isReadableRule,
  LearningPool,
  storyOf,
} from '../src/index.js'
import { counterIds, extractInput, fixture, TestClock } from './helpers.js'

const NOW = '2026-10-23T07:30:00.000Z'

function decided(d: Omit<HumanDecision, 'at'> & { at?: string }) {
  return extractLessons(
    extractInput({
      decisions: [{ at: '2026-10-21T10:00:00.000Z', ...d }],
      applies_to: { skill: 'customer-care' },
    }),
  )
}

describe('WP486 光点「不要」攒不出「学到」', () => {
  it('理由是按钮名 / 系统代填的那一句：一条 lesson 都不出', () => {
    for (const reason of [
      '不要',
      ' 不要 ',
      '不要。',
      '不接',
      '先不连',
      '先不设',
      NOT_WIRED_ACK_REASON,
      '我自己去邮箱回复',
    ]) {
      expect(decided({ approval_item_id: 'ai_1', action: 'reject', reason }), reason).toEqual([])
    }
  })

  it('写了理由的「不要」照旧是最强信号', () => {
    const out = decided({
      approval_item_id: 'ai_1',
      action: 'reject',
      reason: '回帖里不要写 DM us，社区规则不许拉私信',
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.signal).toBe('reject')
    expect(out[0]?.evidence[0]?.signal).toBe('reject')
  })

  it('两次光点「不要」进池、出卡：什么都没有（原来会出「加一条 不要」）', async () => {
    const f = await fixture()
    const pool = new LearningPool({ clock: new TestClock(), nextId: counterIds() })
    for (const id of ['ai_1', 'ai_2'])
      pool.poolAll(decided({ approval_item_id: id, action: 'reject', reason: '不要' }))
    expect(pool.list()).toEqual([])
    const { proposals } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
    })
    expect(proposals).toEqual([])
  })

  it('isButtonOnlyText / isReadableRule 的边界', () => {
    expect(isButtonOnlyText(undefined)).toBe(true)
    expect(isButtonOnlyText('')).toBe(true)
    expect(isButtonOnlyText('Reject')).toBe(true)
    expect(isButtonOnlyText('不要写 DM us')).toBe(false)
    expect(isReadableRule('不要')).toBe(false)
    expect(isReadableRule('别这样')).toBe(false)
    expect(isReadableRule('太长了吧')).toBe(false)
    expect(isReadableRule('回帖别超过三段')).toBe(true)
  })
})

describe('WP486 规矩文本太短不出卡', () => {
  it('升级前进池的「不要」（老数据）：过门槛也不出卡，filtered 说清为什么', async () => {
    const f = await fixture()
    const pool = new LearningPool({ clock: new TestClock(), nextId: counterIds() })
    const section = f.sections[0]
    if (section === undefined) throw new Error('夹具缺段')
    // 模拟 WP486 之前进池的那一条（直接入池，绕过抽取那一道）
    const old = {
      workspace_id: 'ws_1',
      assignment_id: 'asg_1',
      run_id: 'run_1',
      applies_to: { skill: 'customer-care', section_id: section.id },
      kind: 'anti_example' as const,
      signal: 'reject' as const,
      strength: 'strong' as const,
      text: '不要',
      confidence: 0.6,
      evidence: [{ quote: '不要', at: '2026-10-21T10:00:00.000Z', approval_item_id: 'ai_1' }],
      semantic_key: 'k_bare',
    }
    pool.pool(old)
    pool.pool({ ...old, run_id: 'run_2' })
    const { proposals, filtered } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
    })
    expect(proposals).toEqual([])
    expect(filtered.map((x) => x.reason)).toEqual(['too_short'])
  })
})

describe('WP486 卡上说清来龙去脉', () => {
  it('两次改了字 → 卡带两条来源（时间、哪张卡、原来 / 改成），正文说在哪几张卡上做了什么', async () => {
    const f = await fixture()
    const pool = new LearningPool({ clock: new TestClock(), nextId: counterIds() })
    const section = f.sections[1]
    if (section === undefined) throw new Error('夹具缺段')
    const edit = (id: string, at: string) =>
      extractLessons(
        extractInput({
          decisions: [
            {
              approval_item_id: id,
              action: 'approve_edited',
              at,
              edit_diff: {
                before: 'Great question!\nDM us for a discount code.',
                after: 'Great question!\nHappy to help right here in the thread.',
              },
            },
          ],
          applies_to: { skill: 'customer-care', section_id: section.id },
        }),
      )
    pool.poolAll(edit('ai_1', '2026-10-21T10:00:00.000Z'))
    pool.poolAll(edit('ai_2', '2026-10-22T11:00:00.000Z'))
    const titles: Record<string, string> = { ai_1: '回帖：耳机怎么连', ai_2: '回帖：保修多久' }
    const { proposals } = draftProposals({
      workspace_id: 'ws_1',
      lessons: pool.list(),
      skills: f.reader,
      now: NOW,
      sourceTitle: (id) => titles[id],
    })
    expect(proposals).toHaveLength(1)
    const card = proposals[0]
    expect(card?.sources.map((s) => s.approval_item_id)).toEqual(['ai_1', 'ai_2'])
    expect(card?.sources[0]).toMatchObject({
      signal: 'edit_diff',
      before: 'Great question!\nDM us for a discount code.',
      after: 'Great question!\nHappy to help right here in the thread.',
    })
    expect(card?.summary).toContain('10-21、10-22')
    expect(card?.summary).toContain('「回帖：耳机怎么连」「回帖：保修多久」')
    expect(card?.summary).toContain('都把草稿改成了「Happy to help right here in the thread.」')
    // 选项里规矩文本完整显示
    expect(card?.options[0]?.label).toContain('Happy to help right here in the thread.')
  })

  it('同一句理由、同一时刻、两张不同的卡：池里记两条证据（详情里是两次纠正）', () => {
    const pool = new LearningPool({ clock: new TestClock(), nextId: counterIds() })
    for (const id of ['ai_1', 'ai_2'])
      pool.poolAll(
        decided({ approval_item_id: id, action: 'reject', reason: '回帖里不要写 DM us' }),
      )
    const [l] = pool.list()
    expect(l?.hits).toBe(2)
    expect(l?.evidence.map((e) => e.approval_item_id)).toEqual(['ai_1', 'ai_2'])
  })

  it('storyOf：查不到卡名就只说几张卡；写了理由的说理由', () => {
    const s = storyOf(
      [
        { at: '2026-10-21T01:00:00.000Z', signal: 'reject', quote: 'x', approval_item_id: 'a' },
        { at: '2026-10-22T01:00:00.000Z', signal: 'reject', quote: 'x', approval_item_id: 'b' },
      ],
      '回帖里不要写 DM us',
      2,
    )
    expect(s).toBe(
      '你 10-21、10-22 在 2 张卡上都点了「不要」，理由是「回帖里不要写 DM us」。采纳就写进你的个人层，不采纳以后不再提。',
    )
  })
})
