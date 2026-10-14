/**
 * WP330：Reddit 周报纯函数——窗口边界、计数、VOC / UGC、话题归组、我们的回复、Markdown、分节与措辞。
 * 全是替身数据（不联网、不开 Reddit）。
 */
import {
  DEFAULT_REDDIT_WEEKLY_FORMAT,
  type OutboundRecord,
  type RedditWatchItem,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  composeRedditWeekly,
  normalizeRedditWeeklyFormat,
  redditWeekWindow,
  replyTargetOf,
} from '../src/reddit-weekly.js'

const TZ = 480 // 东八区
const NOW = '2026-10-16T09:00:00.000Z' // 周五 17:00（本地）
const SINCE = '2026-10-10T16:00:00.000Z' // 周日 00:00（本地）

let n = 0
const item = (over: Partial<RedditWatchItem>): RedditWatchItem => {
  n += 1
  return {
    id: `t1_${n}`,
    kind: 'comment',
    scope: 'own',
    subreddit: 'inmoxr',
    author: `user${n}`,
    created_at: '2026-10-12T03:00:00.000Z',
    permalink: `https://www.reddit.com/r/inmoxr/comments/abc/x/c${n}/`,
    text: `comment ${n}`,
    ...over,
  }
}

const record = (over: Partial<OutboundRecord>): OutboundRecord => {
  n += 1
  return {
    id: `ob_${n}`,
    workspace_id: 'ws_1' as OutboundRecord['workspace_id'],
    source_key: `approval:${n}`,
    sent_at: '2026-10-13T02:00:00.000Z',
    channel: 'reddit',
    action: 'reply',
    kind: 'social_reply',
    content: `our reply ${n}`,
    link: `https://www.reddit.com/r/inmoxr/comments/abc/x/our${n}/`,
    status: 'sent',
    follow_ups: [],
    ...over,
  }
}

const window = redditWeekWindow(NOW, TZ, 0)
const compose = (items: RedditWatchItem[], records: OutboundRecord[] = [], extra = {}) =>
  composeRedditWeekly({
    now: NOW,
    window,
    tzOffsetMinutes: TZ,
    format: DEFAULT_REDDIT_WEEKLY_FORMAT,
    brand: 'INMO',
    subreddits: ['r/inmoxr'],
    items,
    records,
    sweeps: ['2026-10-11T01:00:00.000Z', '2026-10-16T09:00:00.000Z', '2026-10-09T01:00:00.000Z'],
    ...extra,
  })

describe('窗口', () => {
  it('周五 17:00 出 → 周日 00:00（本地）到现在', () => {
    expect(window).toEqual({ since: SINCE, until: NOW, week_of: '2026-10-11' })
  })
  it('周日当天出 → 当天 00:00 起；起始日可改（周一）', () => {
    expect(redditWeekWindow('2026-10-11T02:00:00.000Z', TZ, 0).since).toBe(SINCE)
    expect(redditWeekWindow(NOW, TZ, 1)).toMatchObject({
      since: '2026-10-11T16:00:00.000Z',
      week_of: '2026-10-12',
    })
    // UTC 时区：周日 00:00Z
    expect(redditWeekWindow(NOW, 0, 0).since).toBe('2026-10-11T00:00:00.000Z')
  })
})

describe('计数与边界', () => {
  it('按 Reddit 上的发出时间进窗口：起点算、起点前一毫秒不算、现在之后不算；同 id 只算一次', () => {
    const p = compose([
      item({ id: 't3_a', kind: 'post', created_at: SINCE }),
      item({ id: 't3_b', kind: 'post', created_at: '2026-10-10T15:59:59.999Z' }),
      item({ id: 't3_c', kind: 'post', created_at: '2026-10-16T09:00:00.001Z' }),
      item({ id: 't1_x' }),
      item({ id: 't1_x' }),
      item({ id: 't1_y', deleted: true }),
      item({ id: 't1_other', subreddit: 'somewhere' }),
    ])
    expect(p.totals.posts).toBe(1)
    expect(p.totals.comments).toBe(2) // 被删的照样算；别的版块（scope own 但不是配的版块）不算
    expect(p.sections[0]).toMatchObject({
      id: 'own_stats',
      subreddits: ['inmoxr'],
      posts: 1,
      comments: 2,
    })
    expect(p.sweeps).toEqual({ count: 2, last_at: '2026-10-16T09:00:00.000Z' })
    expect(p.week_of).toBe('2026-10-11')
    expect(p.title).toBe('INMO Reddit 周报（10/11 – 10/16）')
  })

  it('VOC / UGC 只列判过有效的、原话还在的', () => {
    const p = compose([
      item({ signals: { voc: true, note: '续航不够' }, text: 'battery dies in 2 hours' }),
      item({ signals: { ugc: true }, kind: 'post', title: 'My setup', text: 'photo of my setup' }),
      item({ signals: { voc: true }, deleted: true }),
      item({ signals: { voc: true }, text: '  ' }),
      item({ text: 'nothing special' }),
    ])
    const s = p.sections.find((x) => x.id === 'voc_ugc')
    expect(s?.id === 'voc_ugc' && s.voc.map((q) => q.text)).toEqual(['battery dies in 2 hours'])
    expect(s?.id === 'voc_ugc' && s.ugc.map((q) => q.title)).toEqual(['My setup'])
    expect(p.totals).toMatchObject({ voc: 1, ugc: 1 })
    expect(p.markdown).toContain('> battery dies in 2 hours')
    expect(p.markdown).toContain('- 续航不够')
  })
})

describe('外部社区按话题归组', () => {
  it('同一话题跨天合并、取最重那一档、按严重度排；没话题的按关键词', () => {
    const ext = (over: Partial<RedditWatchItem>) =>
      item({ scope: 'external', subreddit: 'augmentedreality', ...over })
    const p = compose([
      ext({ topic: { key: 'price', label: '价格讨论' }, assessment: 'no_action', kind: 'post' }),
      ext({
        topic: { key: 'price', label: '价格讨论（Air3）' },
        assessment: 'low_relevance',
        created_at: '2026-10-14T03:00:00.000Z',
      }),
      ext({ topic: { key: 'fake', label: '冒充官方' }, assessment: 'follow_up' }),
      ext({ keyword: 'inmo air', assessment: undefined }),
      ext({ topic: { key: 'fake', label: '冒充官方' }, deleted: true }),
    ])
    const s = p.sections.find((x) => x.id === 'external')
    if (s?.id !== 'external') throw new Error('no external')
    expect(
      s.topics.map((t) => [t.label, t.assessment, t.posts, t.comments, t.quotes.length]),
    ).toEqual([
      ['冒充官方', 'follow_up', 0, 2, 1],
      ['价格讨论（Air3）', 'low_relevance', 1, 1, 2],
      ['关键词「inmo air」', 'no_action', 0, 1, 1],
    ])
    expect(p.totals).toMatchObject({ topics: 3, follow_up_topics: 1, external_items: 5 })
    expect(p.markdown).toContain('### 1. 冒充官方（post × 0 / comment × 2）')
    expect(p.markdown).toContain('评估：需跟进')
    expect(p.summary).toContain('外部话题 3（需跟进 1）')
  })

  it('每个话题最多列几条原文，其余照实说', () => {
    const ext = (i: number) =>
      item({ scope: 'external', subreddit: 'x', topic: { key: 'k', label: 'K' }, text: `t${i}` })
    const p = composeRedditWeekly({
      now: NOW,
      window,
      tzOffsetMinutes: TZ,
      format: { ...DEFAULT_REDDIT_WEEKLY_FORMAT, max_quotes_per_topic: 2 },
      subreddits: [],
      items: [ext(1), ext(2), ext(3)],
      records: [],
      sweeps: [],
    })
    expect(p.markdown).toContain('另有 1 条未列出。')
    expect(p.markdown).toContain('这段时间没有巡查记录')
  })
})

describe('我们本周的回复（发出记录）', () => {
  it('回帖子 / 回评论 / 发帖分开数；别的渠道、失败的、窗口外的、周报那一行不算', () => {
    expect(replyTargetOf(record({ parent_external_id: 't1_zz' }))).toBe('comment')
    const p = compose(
      [],
      [
        record({ parent_external_id: 't3_aa' }),
        record({}),
        record({ parent_external_id: 't1_zz', thread_title: 'Is Air3 worth it?' }),
        record({ action: 'post', kind: 'social_post' }),
        record({ channel: 'x' }),
        record({ status: 'failed' }),
        record({ sent_at: '2026-10-10T10:00:00.000Z' }),
        record({ action: 'weekly_report', kind: 'reddit_weekly' }),
      ],
    )
    expect(p.totals).toMatchObject({ to_posts: 2, to_comments: 1, new_posts: 1 })
    const s = p.sections.find((x) => x.id === 'our_replies')
    expect(s?.id === 'our_replies' && s.replies.every((r) => r.url?.startsWith('https://'))).toBe(
      true,
    )
    expect(p.markdown).toContain('- 回复帖子 **2** · 回复评论 **1** · 发帖 **1**')
    expect(p.markdown).toMatch(/回评论 · Is Air3 worth it\? · https:\/\/www\.reddit\.com/)
  })
})

describe('分节与措辞', () => {
  it('改标题、调顺序、关一节、改评估写法、阿拉伯编号', () => {
    const { format, problems } = normalizeRedditWeeklyFormat({
      title: '{brand} 社区周报 {start}-{end}',
      sections: [
        { id: 'external', title: '全域 VOC & 舆情监测' },
        { id: 'own_stats', title: '官方版块数据', intro: '统计口径：本周新发' },
        { id: 'voc_ugc', enabled: false },
        { id: 'nope' },
      ],
      numbering: 'arabic',
      assessment_labels: { follow_up: '建议跟进' },
      quote_max_chars: 5,
    })
    expect(problems).toEqual(['认不出的小节：nope', 'quote_max_chars 要是 40–2000 的整数'])
    expect(format.sections.map((s) => [s.id, s.enabled])).toEqual([
      ['external', true],
      ['own_stats', true],
      ['voc_ugc', false],
      ['our_replies', true],
    ])
    const p = compose(
      [item({ scope: 'external', topic: { key: 'k', label: 'K' }, assessment: 'follow_up' })],
      [],
      { format },
    )
    expect(p.sections.map((s) => s.id)).toEqual(['external', 'own_stats', 'our_replies'])
    expect(p.title).toBe('INMO 社区周报 10/11-10/16')
    expect(p.markdown).toContain('## 1. 全域 VOC & 舆情监测')
    expect(p.markdown).toContain('## 2. 官方版块数据\n\n统计口径：本周新发')
    expect(p.markdown).toContain('评估：建议跟进')
    expect(p.markdown).not.toContain('VOC 与 UGC')
  })

  it('什么都没给 → 原样，照实说', () => {
    const r = normalizeRedditWeeklyFormat('x')
    expect(r.problems).toEqual(['没给要改什么'])
    expect(r.format).toEqual(DEFAULT_REDDIT_WEEKLY_FORMAT)
  })

  it('默认是中文编号、四节齐全、不截图（只有原文与链接）', () => {
    const p = compose([item({ signals: { voc: true } })])
    expect(p.markdown).toMatch(
      /## 一、自家版块数据[\s\S]*## 二、[\s\S]*## 三、[\s\S]*## 四、我们本周的回复/,
    )
    expect(p.markdown).not.toMatch(/!\[|截图|screenshot/i)
    expect(p.markdown).toContain('u/user')
    expect(p.markdown).toContain('https://www.reddit.com/r/inmoxr/')
  })
})
