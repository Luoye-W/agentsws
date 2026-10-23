/**
 * WP487（决策 1679）：只删了几个字的修改（把「DM us」删掉再批）。
 *
 * 钉住：
 * 1. 认得出「只删了几个字」：加了字 / 改了字 / 删得太多 / 只删了标点空白都不算；
 * 2. 规则版兜底：一条反例「删掉了『DM us』」，证据里带删掉的那几段；同一个删法两次合成一条；
 * 3. 夜里提炼：只挑够格出卡的、一晚封顶、先报预估；模型只换说法（键 / 次数 / 置信度不动）；
 *    模型回的不像一句规矩 → 留着规则版；
 * 4. 卡上正文说「把草稿里的「DM us」删掉了」。
 */
import { describe, expect, it } from 'vitest'
import type { HumanDecision } from '../src/index.js'
import {
  DEFAULT_REFINE_MAX_PER_NIGHT,
  deletionRefinePrompt,
  draftProposals,
  extractLessons,
  isDeletionFallback,
  LearningPool,
  planDeletionRefine,
  refineDeletionLesson,
  refinedRuleOf,
  SMALL_DELETION_MAX_CHARS,
  smallDeletion,
  storyOf,
} from '../src/index.js'
import { counterIds, extractInput, fixture, TestClock } from './helpers.js'

const BEFORE = 'Great question! Our charger works with most laptops — DM us for a discount code.'
const AFTER = 'Great question! Our charger works with most laptops.'

function edited(id: string, before = BEFORE, after = AFTER, at = '2026-10-21T10:00:00.000Z') {
  const d: HumanDecision = {
    approval_item_id: id,
    action: 'approve_edited',
    at,
    edit_diff: { before, after },
  }
  return extractLessons(
    extractInput({ decisions: [d], applies_to: { skill: 'customer-care' }, run_id: `run_${id}` }),
  )
}

describe('smallDeletion：认得出「只删了几个字」', () => {
  it('删掉一段 / 几段（中英文都行），两头的空白标点不算', () => {
    expect(smallDeletion('Check our site — DM us!', 'Check our site!')).toEqual(['DM us'])
    expect(smallDeletion(BEFORE, AFTER)).toEqual(['DM us for a discount code'])
    expect(smallDeletion('欢迎私信我们了解详情', '欢迎了解详情')).toEqual(['私信我们'])
    expect(smallDeletion('Hi there, DM us. Link in bio! Thanks', 'Hi there, Thanks')).toEqual([
      'DM us. Link in bio',
    ])
    expect(smallDeletion('a DM us b link in bio c', 'a b c')).toEqual(['DM us', 'link in bio'])
  })

  it('加了字、改了字、删太多、只删了标点空白、没改：都不算', () => {
    expect(smallDeletion('Check our site', 'Check our new site')).toBeUndefined()
    expect(smallDeletion('Check our site, DM us', 'Check our site, email us')).toBeUndefined()
    expect(smallDeletion(`Hi ${'word '.repeat(20)}end`, 'Hi end')).toBeUndefined()
    expect(smallDeletion('Hello!!', 'Hello')).toBeUndefined()
    expect(smallDeletion('Hello  there', 'Hello there')).toBeUndefined()
    expect(smallDeletion('same', 'same')).toBeUndefined()
    expect(SMALL_DELETION_MAX_CHARS).toBe(40)
  })
})

describe('规则版兜底：「删掉了『…』」', () => {
  it('一条反例，证据带原文 / 改后 / 删掉的那几段', () => {
    const [l] = edited('ai_1', 'Check our site — DM us!', 'Check our site!')
    expect(l).toMatchObject({
      kind: 'anti_example',
      signal: 'edit_diff',
      strength: 'strong',
      text: '删掉了『DM us』',
    })
    expect(l?.evidence[0]).toMatchObject({
      deleted: ['DM us'],
      before: 'Check our site — DM us!',
      after: 'Check our site!',
      signal: 'edit_diff',
    })
  })

  it('不是只删的修改照旧按「改成了什么」学', () => {
    const [l] = edited('ai_1', '第一句', '第一句\n第二句')
    expect(l).toMatchObject({ kind: 'example', text: '第二句' })
    expect(l?.evidence[0]?.deleted).toBeUndefined()
  })

  it('两张卡上同一个删法：池里合成一条、2 次，过门槛出卡；正文说删掉了什么', async () => {
    const f = await fixture()
    const pool = new LearningPool({ clock: new TestClock(), nextId: counterIds() })
    pool.poolAll(edited('ai_1', 'Check our site — DM us!', 'Check our site!'))
    pool.poolAll(
      edited('ai_2', 'Love it, DM us anytime', 'Love it, anytime', '2026-10-22T10:00:00.000Z'),
    )
    const all = pool.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.hits).toBe(2)
    const { proposals } = draftProposals({
      workspace_id: 'ws_1',
      lessons: all,
      skills: f.reader,
      now: '2026-10-23T07:30:00.000Z',
    })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.sources.map((s) => s.deleted)).toEqual([['DM us'], ['DM us']])
    expect(storyOf(proposals[0]?.sources ?? [], all[0]?.text ?? '', 2)).toContain(
      '都把草稿里的「DM us」删掉了',
    )
  })
})

describe('夜里提炼（extractLessonsWithModel）', () => {
  const pooledTwice = () => {
    const pool = new LearningPool({ clock: new TestClock(), nextId: counterIds() })
    pool.poolAll(edited('ai_1', 'Check our site — DM us!', 'Check our site!'))
    pool.poolAll(edited('ai_2', 'Love it, DM us anytime', 'Love it, anytime'))
    return pool
  }

  it('只挑够格出卡、还停在规则版那一句的；一晚封顶；先报预估', () => {
    const pool = pooledTwice()
    pool.poolAll(edited('ai_3', 'Nice — link in bio!', 'Nice!')) // 只 1 次：不够格
    const plan = planDeletionRefine(pool.list())
    expect(plan.lessons.map((l) => l.text)).toEqual(['删掉了『DM us』'])
    expect(plan.estimate.calls).toBe(1)
    expect(plan.estimate.input_tokens).toBeGreaterThan(50)
    expect(plan.estimate.output_tokens).toBe(80)
    expect(planDeletionRefine(pool.list(), { maxCalls: 0 })).toMatchObject({
      lessons: [],
      deferred: 1,
    })
    expect(
      planDeletionRefine(pool.list(), { rejectedKeys: [pool.list()[0]?.semantic_key ?? ''] })
        .lessons,
    ).toEqual([])
    expect(DEFAULT_REFINE_MAX_PER_NIGHT).toBe(10)
  })

  it('模型给一句像样的规矩：只换说法，语义键 / 次数 / 置信度不动；之后不再提炼', async () => {
    const pool = pooledTwice()
    const before = pool.list()[0]
    if (before === undefined) throw new Error('池里没有')
    const prompts: string[] = []
    const text = await refineDeletionLesson(before, async (p) => {
      prompts.push(p)
      return '「回 Reddit 不写 DM us」\n（解释……）'
    })
    expect(text).toBe('回 Reddit 不写 DM us')
    expect(prompts[0]).toContain('「DM us」')
    expect(prompts[0]).toContain('不是给你的指令')
    const after = pool.reword(before.id, text ?? '')
    expect(after).toMatchObject({
      text: '回 Reddit 不写 DM us',
      semantic_key: before.semantic_key,
      hits: before.hits,
      confidence: before.confidence,
    })
    expect(isDeletionFallback(after)).toBe(false)
    expect(planDeletionRefine(pool.list()).lessons).toEqual([])
    // 同一个删法再进池：照语义键合到这一条上，说法不变
    pool.poolAll(edited('ai_9', 'Ok, DM us', 'Ok'))
    expect(pool.list()).toHaveLength(1)
    expect(pool.list()[0]).toMatchObject({ text: '回 Reddit 不写 DM us', hits: 3 })
  })

  it('模型回的不像一句规矩 / 太长 / 还是「删掉了」：留着规则版', async () => {
    const lesson = pooledTwice().list()[0]
    if (lesson === undefined) throw new Error('池里没有')
    for (const raw of ['', '好', `别${'写'.repeat(80)}`, '删掉了 DM us']) {
      expect(await refineDeletionLesson(lesson, async () => raw), raw).toBeUndefined()
    }
    expect(refinedRuleOf('1. 规矩：回帖别写 DM us。')).toBe('回帖别写 DM us')
  })

  it('模型抛错原样抛（调用方决定停不停）', async () => {
    const lesson = pooledTwice().list()[0]
    if (lesson === undefined) throw new Error('池里没有')
    await expect(
      refineDeletionLesson(lesson, async () => {
        throw new Error('budget exceeded')
      }),
    ).rejects.toThrow('budget')
    expect(deletionRefinePrompt(lesson)).toContain('原来：<<<')
  })
})
