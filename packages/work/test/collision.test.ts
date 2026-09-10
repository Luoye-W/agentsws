/**
 * 撞车检测（40 §3.1）：三把钥匙、只看进行中、回候选不回判决。
 *
 * 这一份只测纯函数——服务层的「建之前先查」在 `claim.test.ts` 里。
 */
import { describe, expect, it } from 'vitest'
import {
  COROBORATION_THRESHOLD,
  collisionHeadline,
  collisionKey,
  collisionReason,
  findInProgressSimilar,
  type InProgressItem,
} from '../src/collision.js'
import { T0 } from './helpers.js'

const TZ = 480

function item(over: Partial<InProgressItem> = {}): InProgressItem {
  return {
    kind: 'todo',
    id: 'td_a',
    title: '核对昨天的退款单',
    owner: 'p_li',
    collaborators: [],
    status: 'doing',
    refs: [],
    item_kind: 'manual',
    started_at: T0,
    last_activity: T0,
    cards: 2,
    ...over,
  }
}

describe('撞车检测：三把钥匙', () => {
  it('① 同一个主题对象就算撞（哪怕说法完全不一样）', () => {
    const hits = findInProgressSimilar({
      subject: { title: '看一下这单能不能退', at: T0, refs: [{ type: 'order', id: 'ord_1001' }] },
      pool: [item({ refs: [{ type: 'order', id: 'ord_1001' }] })],
      tz_offset_minutes: TZ,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.keys).toContain('object')
    expect(hits[0]?.owner).toBe('p_li')
    expect(hits[0]?.cards).toBe(2)
  })

  it('不同订单不算撞', () => {
    const hits = findInProgressSimilar({
      subject: { title: '看一下这单能不能退', at: T0, refs: [{ type: 'order', id: 'ord_2002' }] },
      pool: [item({ refs: [{ type: 'order', id: 'ord_1001' }] })],
      tz_offset_minutes: TZ,
    })
    expect(hits).toHaveLength(0)
  })

  it('② 换个说法仍是同一把语义键', () => {
    // 词序无关：同一把键
    expect(collisionKey('退款先看窗口')).toBe(collisionKey('先看窗口退款'))
    // 多两个字仍然过线（词面重合 > 0.7）
    const hits = findInProgressSimilar({
      subject: { title: '把昨天的退款单核对一下', at: T0 },
      pool: [item()],
      tz_offset_minutes: TZ,
    })
    expect(hits[0]?.keys).toContain('semantic')
    expect(hits[0]?.similarity).toBeGreaterThan(0.7)
  })

  it('③ 同岗位同日同类只是旁证：词面不沾边就不算撞', () => {
    const pool = [item({ position_id: 'asg_1', item_kind: 'manual' })]
    const unrelated = findInProgressSimilar({
      subject: { title: '给供应商打电话催货', at: T0, position_id: 'asg_1', item_kind: 'manual' },
      pool,
      tz_offset_minutes: TZ,
    })
    expect(unrelated).toHaveLength(0)

    const related = findInProgressSimilar({
      subject: {
        title: '退款单还要再核对一遍吗',
        at: T0,
        position_id: 'asg_1',
        item_kind: 'manual',
      },
      pool,
      tz_offset_minutes: TZ,
    })
    expect(related[0]?.keys).toContain('position_day')
    expect(related[0]?.similarity).toBeGreaterThanOrEqual(COROBORATION_THRESHOLD)
  })

  it('③ 隔了一天就不是「同日」', () => {
    const tomorrow = new Date(Date.parse(T0) + 86_400_000).toISOString()
    const hits = findInProgressSimilar({
      subject: {
        title: '退款单还要再核对一遍吗',
        at: tomorrow,
        position_id: 'asg_1',
        item_kind: 'manual',
      },
      pool: [item({ position_id: 'asg_1' })],
      tz_offset_minutes: TZ,
    })
    expect(hits.every((h) => !h.keys.includes('position_day'))).toBe(true)
  })

  it('命中几把钥匙决定排序：三把的排在一把的前面', () => {
    const hits = findInProgressSimilar({
      subject: {
        title: '核对昨天的退款单',
        at: T0,
        refs: [{ type: 'order', id: 'ord_1001' }],
        position_id: 'asg_1',
        item_kind: 'manual',
      },
      pool: [
        item({ id: 'td_weak', title: '把昨天的退款单核对一下', refs: [] }),
        item({
          id: 'td_strong',
          refs: [{ type: 'order', id: 'ord_1001' }],
          position_id: 'asg_1',
        }),
      ],
      tz_offset_minutes: TZ,
    })
    expect(hits.map((h) => h.id)).toEqual(['td_strong', 'td_weak'])
    expect(hits[0]?.keys).toHaveLength(3)
  })

  it('exclude_ids 把自己排掉（改自己那条时别撞自己）', () => {
    const hits = findInProgressSimilar({
      subject: { title: '核对昨天的退款单', at: T0 },
      pool: [item()],
      tz_offset_minutes: TZ,
      exclude_ids: ['td_a'],
    })
    expect(hits).toHaveLength(0)
  })

  it('解释是人话，不是分数', () => {
    const hit = findInProgressSimilar({
      subject: { title: '核对昨天的退款单', at: T0, refs: [{ type: 'order', id: 'ord_1001' }] },
      pool: [item({ refs: [{ type: 'order', id: 'ord_1001' }] })],
      tz_offset_minutes: TZ,
    })[0]
    if (hit === undefined) throw new Error('应当命中')
    expect(collisionReason(hit)).toContain('同一个对象')
    expect(collisionHeadline(hit, (id) => (id === 'p_li' ? '李默' : id))).toBe(
      '李默正在做「核对昨天的退款单」（进行中，2 张卡等他定）',
    )
  })
})
