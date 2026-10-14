/**
 * WP331：报告积木的纯计算——时间窗、巡查条目筛选 / 计数 / 按话题归组、发出记录计数。
 * 全是替身数据（不联网、不开任何平台）。
 */
import type { OutboundRecord, WatchItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  clipQuote,
  queryWatchItems,
  resolvePeriod,
  sentTargetOf,
  summarizeSent,
} from '../src/watch-query.js'

const TZ = 480 // 东八区
const NOW = '2026-10-16T09:00:00.000Z' // 周五 17:00（本地）
const SUNDAY = '2026-10-10T16:00:00.000Z' // 周日 00:00（本地）

let n = 0
const item = (over: Partial<WatchItem>): WatchItem => {
  n += 1
  return {
    id: `t1_${n}`,
    platform: 'reddit',
    kind: 'comment',
    scope: 'own',
    place: 'inmoxr',
    author: `user${n}`,
    created_at: '2026-10-13T03:00:00.000Z',
    url: `https://www.reddit.com/r/inmoxr/comments/x/${n}/`,
    text: `text ${n}`,
    ...over,
  }
}

describe('resolvePeriod', () => {
  it('本周从周日起：周五 17:00 → 周日 00:00 至现在；默认周一起', () => {
    const w = resolvePeriod(NOW, TZ, { period: 'this_week', week_start: 0 })
    expect(w).toMatchObject({ since: SUNDAY, until: NOW, start_date: '2026-10-11' })
    expect(w.label).toBe('10/11 – 10/16')
    expect(resolvePeriod(NOW, TZ, { period: 'this_week' }).start_date).toBe('2026-10-12')
  })

  it('上周、昨天、本月、最近 7 天、直接给日期；认不出的照实说', () => {
    const last = resolvePeriod(NOW, TZ, { period: 'last_week', week_start: 0 })
    expect(last.start_date).toBe('2026-10-04')
    expect(last.until).toBe(new Date(Date.parse(SUNDAY) - 1).toISOString())
    expect(resolvePeriod(NOW, TZ, { period: 'yesterday' }).start_date).toBe('2026-10-15')
    expect(resolvePeriod(NOW, TZ, { period: 'this_month' }).start_date).toBe('2026-10-01')
    expect(resolvePeriod(NOW, TZ, { period: 'last_month' }).end_date).toBe('2026-09-30')
    expect(resolvePeriod(NOW, TZ).since).toBe('2026-10-09T09:00:00.000Z')
    const given = resolvePeriod(NOW, TZ, { since: '2026-10-11', until: '2026-10-16' })
    expect(given).toMatchObject({ since: SUNDAY, until: '2026-10-16T16:00:00.000Z' })
    expect(resolvePeriod(NOW, TZ, { period: 'fortnight' }).problems[0]).toContain('fortnight')
    expect(resolvePeriod(NOW, TZ, { period: 'this_week', week_start: 9 }).problems).toHaveLength(1)
  })
})

describe('queryWatchItems', () => {
  const window = { since: SUNDAY, until: NOW }
  const items: WatchItem[] = [
    item({ id: 't3_a', kind: 'post', signals: { ugc: true, note: '开箱' } }),
    item({ id: 't1_b', signals: { voc: true } }),
    item({ id: 't1_b', signals: { voc: true, note: '后补的判断' } }), // 同一条只算一次，后给的为准
    item({ id: 't1_c', deleted: true, signals: { voc: true } }), // 被删：算数、不引用
    item({ id: 't1_old', created_at: '2026-10-10T15:59:59.999Z' }), // 起点前 1 毫秒
    item({ id: 't1_other', place: 'somewhere' }), // 不是自家版块、也不是外部
    item({
      id: 't3_x',
      kind: 'post',
      scope: 'external',
      place: 'augmentedreality',
      topic: { key: 't:compare', label: '和别家对比' },
      assessment: 'no_action',
      keyword: 'INMO',
    }),
    item({
      id: 't1_y',
      scope: 'external',
      place: 'smartglasses',
      topic: { key: 't:compare', label: '和别家对比' },
      assessment: 'follow_up',
      keyword: 'INMO',
    }),
    item({ id: 't1_z', scope: 'external', place: 'tech', keyword: 'Air3' }),
  ]

  it('窗口、去重、自家 / 外部计数、被删照样算数', () => {
    const r = queryWatchItems({ items, ownPlaces: ['r/inmoxr'], window })
    expect(r.totals).toMatchObject({
      items: 6,
      own: { posts: 1, comments: 2 },
      external: { posts: 1, comments: 2 },
      voc: 1,
      ugc: 1,
    })
    const own = queryWatchItems({ items, ownPlaces: ['inmoxr'], window, filter: { scope: 'own' } })
    expect(own.items.map((x) => x.id)).toEqual(['t3_a', 't1_b', 't1_c'])
    expect(own.items[2]).toMatchObject({ text: '', deleted: true })
    expect(own.items[1]?.note).toBe('后补的判断')
  })

  it('只要有效的 VOC / UGC（原话还在的）；按判断档、话题、关键词筛', () => {
    const voc = queryWatchItems({ items, ownPlaces: [], window, filter: { signal: 'any' } })
    expect(voc.items.map((x) => x.id)).toEqual(['t3_a', 't1_b'])
    const follow = queryWatchItems({
      items,
      ownPlaces: [],
      window,
      filter: { assessment: ['follow_up'] },
    })
    expect(follow.items.map((x) => x.id)).toEqual(['t1_y'])
    const topic = queryWatchItems({ items, ownPlaces: [], window, filter: { topic: '对比' } })
    expect(topic.totals.items).toBe(2)
    const kw = queryWatchItems({ items, ownPlaces: [], window, filter: { keyword: 'air3' } })
    expect(kw.items.map((x) => x.id)).toEqual(['t1_z'])
  })

  it('按话题归组：取最重的那一档、按严重度排、没话题按关键词、每组最多几条', () => {
    const r = queryWatchItems({
      items,
      ownPlaces: ['inmoxr'],
      window,
      filter: { scope: 'external' },
      group_by: 'topic',
      limit: 1,
    })
    expect(r.groups?.map((g) => [g.topic, g.posts, g.comments, g.assessment, g.more])).toEqual([
      ['和别家对比', 1, 1, 'follow_up', 1],
      ['关键词「Air3」', 0, 1, 'no_action', 0],
    ])
    expect(r.groups?.[0]?.items[0]).toMatchObject({ author: 'user7', url: expect.any(String) })
    expect(r.items).toEqual([])
  })

  it('原话截断不改字', () => {
    expect(clipQuote('a  b\nc', 10)).toBe('a b c')
    expect(clipQuote('abcdefghij', 5)).toBe('abcd…')
  })
})

describe('summarizeSent', () => {
  let m = 0
  const rec = (over: Partial<OutboundRecord>): OutboundRecord => {
    m += 1
    return {
      id: `ob_${m}`,
      workspace_id: 'ws_1',
      source_key: `k${m}`,
      sent_at: '2026-10-13T02:00:00.000Z',
      channel: 'reddit',
      action: 'reply',
      kind: 'outbound_draft',
      content: `我们的回复 ${m}`,
      status: 'sent',
      follow_ups: [],
      ...over,
    } as OutboundRecord
  }
  const records = [
    rec({ link: 'https://www.reddit.com/r/inmoxr/comments/1/x/our1/' }),
    rec({ action: 'comment', parent_external_id: 't1_abc' }),
    rec({ action: 'post' }),
    rec({ channel: 'email', action: 'email' }),
    rec({ status: 'failed' }),
    rec({ action: 'report' }), // 报告那一行不算「发出去的」
    rec({ sent_at: '2026-10-01T00:00:00.000Z' }),
  ]

  it('按窗口、渠道数回帖子 / 回评论 / 发帖，带链接', () => {
    const s = summarizeSent(records, { window: { since: SUNDAY, until: NOW }, channel: 'Reddit' })
    expect(s.totals).toEqual({
      all: 3,
      by_action: { reply: 1, comment: 1, post: 1 },
      replies_to_posts: 1,
      replies_to_comments: 1,
      new_posts: 1,
    })
    expect(s.records[0]?.link).toContain('our1')
    const all = summarizeSent(records, { window: { since: SUNDAY, until: NOW } })
    expect(all.totals.all).toBe(4)
    const reports = summarizeSent(records, {
      window: { since: SUNDAY, until: NOW },
      actions: ['report'],
    })
    expect(reports.totals.all).toBe(1)
    expect(sentTargetOf({ action: 'email' })).toBeUndefined()
  })
})
