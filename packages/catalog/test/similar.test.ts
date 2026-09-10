import { describe, expect, it } from 'vitest'
import {
  DUPLICATE_THRESHOLD,
  findDuplicates,
  findSimilar,
  inUse,
  matchesText,
  SIMILAR_THRESHOLD,
  score,
  textOf,
} from '../src/index.js'
import { entry, WS } from './helpers.js'

describe('三把钥匙', () => {
  it('标题说的是同一件事 + 同一类东西 → 过门槛', () => {
    const s = score(
      { kind: 'schedule', title: '每天早上汇总退款单' },
      { kind: 'schedule', title: '早上把退款单汇总一下' },
    )
    expect(s.similarity).toBeGreaterThanOrEqual(SIMILAR_THRESHOLD)
    expect(s.keys).toContain('semantic')
    expect(s.keys).toContain('kind')
    expect(s.reasons[0]).toContain('同一件事')
  })

  it('同样的话但不是同一类东西 → 不过门槛（规矩不该挡定时任务）', () => {
    const s = score(
      { kind: 'rule', title: '每天早上汇总退款单' },
      { kind: 'schedule', title: '每天早上汇总退款单' },
    )
    expect(s.similarity).toBeLessThan(SIMILAR_THRESHOLD)
  })

  it('三把钥匙全中 → 就算话说得不像也算重复', () => {
    const s = score(
      { kind: 'schedule', title: '退款巡检', trigger: 'cron:0 9 * * *', target: 'store:s_main' },
      { kind: 'schedule', title: '早会材料', trigger: 'CRON: 0 9 * * *', target: 'store:s_main' },
    )
    expect(s.keys).toEqual(expect.arrayContaining(['trigger', 'target', 'kind']))
    expect(s.similarity).toBeGreaterThanOrEqual(SIMILAR_THRESHOLD)
    expect(s.reasons.join('；')).toContain('触发时机相同')
    expect(s.reasons.join('；')).toContain('针对同一个对象')
  })

  it('对称：score(a,b) === score(b,a)', () => {
    const a = { kind: 'skill', title: '退货窗口先看下单时间', summary: '售后' }
    const b = { kind: 'skill', title: '先看下单时间再判退货窗口' }
    expect(score(a, b).similarity).toBe(score(b, a).similarity)
  })

  it('相似度最多 1，且只留四位小数', () => {
    const s = score(
      { kind: 'schedule', title: '一样', trigger: 't', target: 'o' },
      { kind: 'schedule', title: '一样', trigger: 't', target: 'o' },
    )
    expect(s.similarity).toBe(1)
    expect(String(s.similarity).replace(/^\d+\.?/, '').length).toBeLessThanOrEqual(4)
  })
})

describe('findSimilar', () => {
  const entries = [
    entry({ id: 'schedule:s1', title: '每天早上汇总退款单', owner: 'p_li' }),
    entry({ id: 'schedule:s2', title: '每周给红人发跟进邮件' }),
    entry({ id: 'schedule:s3', title: '早上汇总退款单', superseded_by: 'schedule:s1' }),
  ]

  it('查得到像的那条，查不到不像的', () => {
    const hits = findSimilar(
      { workspace_id: WS, kind: 'schedule', title: '早上把退款单汇总一下' },
      entries,
    )
    expect(hits.map((h) => h.entry.id)).toEqual(['schedule:s1'])
  })

  it('已经被取代的个人副本不再挡人', () => {
    const hits = findSimilar(
      { workspace_id: WS, kind: 'schedule', title: '早上汇总退款单', exclude_id: 'schedule:s1' },
      entries,
    )
    expect(hits).toEqual([])
  })

  it('exclude_id：改自己的时候不被自己挡住', () => {
    const hits = findSimilar(
      {
        workspace_id: WS,
        kind: 'schedule',
        title: '每天早上汇总退款单',
        exclude_id: 'schedule:s1',
      },
      entries,
    )
    expect(hits).toEqual([])
  })

  it('别的工作区的条目一律不参与', () => {
    const hits = findSimilar(
      { workspace_id: 'ws_other', kind: 'schedule', title: '每天早上汇总退款单' },
      entries,
    )
    expect(hits).toEqual([])
  })

  it('limit 生效，且按分从高到低', () => {
    const many = [
      entry({ id: 'schedule:a', title: '早上汇总退款' }),
      entry({ id: 'schedule:b', title: '每天早上汇总退款单', trigger: 'cron:0 9 * * *' }),
    ]
    const hits = findSimilar(
      {
        workspace_id: WS,
        kind: 'schedule',
        title: '每天早上汇总退款单',
        trigger: 'cron:0 9 * * *',
        limit: 1,
      },
      many,
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]?.entry.id).toBe('schedule:b')
  })
})

describe('疑似重复', () => {
  it('两条都在用才报', () => {
    const live = entry({ id: 'schedule:a', title: '每天早上汇总退款单', runs_30d: 20 })
    const alsoLive = entry({
      id: 'schedule:b',
      title: '每天早上汇总退款单',
      used_by_positions: ['asg_1'],
    })
    const idle = entry({ id: 'schedule:c', title: '每天早上汇总退款单' })
    const pairs = findDuplicates([live, alsoLive, idle])
    expect(pairs).toHaveLength(1)
    expect([pairs[0]?.a.id, pairs[0]?.b.id]).toEqual(['schedule:a', 'schedule:b'])
    expect(pairs[0]?.both_in_use).toBe(true)
    expect(pairs[0]?.similarity).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD)
  })

  it('被取代的不再算重复；limit 生效', () => {
    const a = entry({ id: 'schedule:a', title: '汇总退款单', runs_30d: 1 })
    const b = entry({
      id: 'schedule:b',
      title: '汇总退款单',
      runs_30d: 1,
      superseded_by: 'schedule:a',
    })
    expect(findDuplicates([a, b])).toEqual([])
    expect(findDuplicates([a, entry({ ...a, id: 'schedule:c' })], { limit: 0 })).toEqual([])
  })
})

describe('搜索与小工具', () => {
  it('子串命中或词袋全含', () => {
    const e = entry({ id: 'schedule:a', title: '每天早上汇总退款单', summary: '给运营看' })
    expect(matchesText(e, '退款')).toBe(true)
    expect(matchesText(e, '汇总 退款单')).toBe(true)
    expect(matchesText(e, '红人')).toBe(false)
    expect(matchesText(e, '  ')).toBe(true)
    expect(matchesText(e, '的')).toBe(false)
  })

  it('inUse / textOf', () => {
    expect(inUse(entry({ id: 'x', title: 'x' }))).toBe(false)
    expect(inUse(entry({ id: 'x', title: 'x', runs_30d: 1 }))).toBe(true)
    expect(inUse(entry({ id: 'x', title: 'x', used_by_positions: ['a'] }))).toBe(true)
    expect(textOf({ title: 'a', summary: 'b' })).toBe('a b')
    expect(textOf({ title: 'a' })).toBe('a')
  })
})
