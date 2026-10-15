/**
 * WP308（决策 447）：IM 里一句话问谁（秘书 / 岗位 Agent / 在岗位建任务），与岗位摘要、当场回答的聊天排版。
 * 纯函数，直接喂。
 */
import type { PositionWorkItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { imAskTarget, isPositionStatusQuestion } from '../src/im-ask-route.js'
import { positionBriefText, quickAnswerForIm } from '../src/im-position-ask.js'

const REDDIT = 'social.reddit'

describe('imAskTarget：问秘书还是问岗位', () => {
  it('点名岗位的工作问题 → 岗位；交代 → 岗位任务', () => {
    expect(
      imAskTarget({
        question: 'Reddit 运营今天有没有什么需要我处理的',
        role_id: REDDIT,
        named: true,
      }),
    ).toBe('position_ask')
    expect(
      imAskTarget({ question: 'Reddit 运营上周发了几条帖子', role_id: REDDIT, named: true }),
    ).toBe('position_ask')
    expect(imAskTarget({ question: '帮我回一下这封邮件', role_id: REDDIT, named: false })).toBe(
      'position_task',
    )
    expect(imAskTarget({ question: 'Reddit 帮我写个帖子', role_id: REDDIT, named: true })).toBe(
      'position_task',
    )
  })

  it('没点名但问的是活（落到主要岗位）→ 岗位', () => {
    expect(imAskTarget({ question: '今天有什么要我处理的', role_id: REDDIT, named: false })).toBe(
      'position_ask',
    )
  })

  it('闲聊 / 个人的事 / 只有底座职责 → 秘书', () => {
    expect(imAskTarget({ question: '你好', role_id: REDDIT, named: false })).toBe('secretary')
    expect(imAskTarget({ question: '谢谢', role_id: REDDIT, named: true })).toBe('secretary')
    expect(imAskTarget({ question: '我明天下午有空吗', role_id: REDDIT, named: false })).toBe(
      'secretary',
    )
    expect(imAskTarget({ question: '帮我约张三明天开会', role_id: REDDIT, named: false })).toBe(
      'secretary',
    )
    expect(
      imAskTarget({ question: '今天有什么要我处理的', role_id: 'common.owner', named: false }),
    ).toBe('secretary')
    expect(imAskTarget({ question: '今天有什么要我处理的', named: false })).toBe('secretary')
    expect(imAskTarget({ question: '天气怎么样', role_id: REDDIT, named: false })).toBe('secretary')
  })

  it('「今天要我处理的 / 在忙什么 / 进展」是问状况', () => {
    expect(isPositionStatusQuestion('Reddit 运营今天有没有什么需要我处理的')).toBe(true)
    expect(isPositionStatusQuestion('社媒运营在忙什么')).toBe(true)
    expect(isPositionStatusQuestion('Reddit 运营上周发了几条帖子')).toBe(false)
  })
})

const item = (over: Partial<PositionWorkItem>): PositionWorkItem => ({
  id: 'x',
  kind: 'matter',
  ref_id: 'x',
  title: '一件事',
  group: 'doing',
  status: 'open',
  cards: 0,
  card_ids: [],
  source: 'you',
  updated_at: '2026-10-13T08:00:00.000Z',
  movable: false,
  ...over,
})

describe('positionBriefText：岗位今天的一句摘要', () => {
  it('卡 / 待办（含过期）/ 在做 / 卡住了 + 最近一条', () => {
    const text = positionBriefText({
      position_name: '社媒运营',
      pending_cards: 2,
      work: {
        counts: {
          doing: 3,
          queued: 0,
          waiting: 0,
          done: 0,
          stuck: 1,
          cards: 2,
          todos_today: 2,
          todos_overdue: 1,
        },
        items: [
          item({
            id: 'a',
            title: '回评论',
            progress: '起草好了，等你看',
            updated_at: '2026-10-13T09:00:00.000Z',
          }),
          item({ id: 'b', kind: 'todo', title: '一个待办' }),
          item({ id: 'c', kind: 'todo', title: '另一个待办' }),
        ],
      },
    })
    expect(text).toBe(
      '「社媒运营」今天：2 张卡等你定，2 个待办（1 个已过期），1 件在做，1 件卡住了。\n最近：「回评论」起草好了，等你看',
    )
  })

  it('什么都没有就说没有', () => {
    expect(
      positionBriefText({
        position_name: '社媒运营',
        pending_cards: 0,
        work: {
          counts: { doing: 0, queued: 0, waiting: 0, done: 0, cards: 0, todos_today: 0 },
          items: [],
        },
      }),
    ).toBe('「社媒运营」今天没有要你处理的。')
  })
})

describe('quickAnswerForIm：一句话 + 组件压成几行字', () => {
  it('数字一行、表格最多 5 行 + 共几行', () => {
    const text = quickAnswerForIm({
      lead: '上周发了 7 条。',
      text: '上周发了 7 条。',
      // WP336：组件是一块 genui（数字 + 表格）
      components: [
        {
          kind: 'genui',
          spec: {
            items: [
              { type: 'stat', label: '帖子', value: '7条' },
              { type: 'stat', label: '评论', value: '31' },
              {
                type: 'table',
                columns: ['标题', '赞'],
                rows: Array.from({ length: 7 }, (_, i) => [`帖 ${i + 1}`, i]),
              },
            ],
          },
        },
      ],
    })
    const lines = text.split('\n').filter((l) => l !== '')
    expect(lines[0]).toBe('上周发了 7 条。')
    expect(lines[1]).toBe('帖子 7条 · 评论 31')
    expect(lines.filter((l) => l.startsWith('· '))).toHaveLength(5)
    expect(lines.at(-1)).toBe('（共 7 行）')
  })
})
