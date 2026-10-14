/**
 * WP330：Reddit 周报那张报表卡——一排数、按配置顺序的几节、原文收着（点开见作者 / 时间 / 链接）、
 * 复制整份 Markdown、导出 .md；不截图（没有图片）。
 */
import type { RedditWeeklyPayload } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { isRedditWeekly, RedditWeeklyBody } from '@/components/deck/reddit-weekly-body'
import { renderWithProviders } from './helpers'

const quote = {
  id: 't1_a',
  kind: 'comment' as const,
  subreddit: 'augmentedreality',
  author: 'bob',
  at: '2026-10-13T03:00:00.000Z',
  url: 'https://www.reddit.com/r/augmentedreality/comments/9/x/a/',
  text: 'Anyone compared INMO Air3 with the others?',
}

const payload: RedditWeeklyPayload = {
  kind: 'reddit_weekly',
  week_of: '2026-10-11',
  window: { since: '2026-10-10T16:00:00.000Z', until: '2026-10-16T09:00:00.000Z' },
  generated_at: '2026-10-16T09:00:00.000Z',
  title: 'INMO Reddit 周报（10/11 – 10/16）',
  summary: '帖子 3 · 评论 12',
  sections: [
    {
      id: 'external',
      title: '全域 VOC & 舆情监测',
      topics: [
        {
          key: 'compare',
          label: '和别家对比',
          posts: 1,
          comments: 2,
          assessment: 'follow_up',
          quotes: [quote],
          more: 0,
        },
      ],
    },
    { id: 'own_stats', title: '自家版块数据', subreddits: ['inmoxr'], posts: 3, comments: 12 },
    { id: 'voc_ugc', title: '自家版块 VOC 与 UGC', voc: [], ugc: [] },
    {
      id: 'our_replies',
      title: '我们本周的回复',
      to_posts: 2,
      to_comments: 1,
      new_posts: 0,
      replies: [
        {
          record_id: 'ob_1',
          at: '2026-10-13T02:00:00.000Z',
          target: 'comment',
          url: 'https://www.reddit.com/r/inmoxr/comments/1/x/our1/',
          thread_title: 'Is Air3 worth it?',
          text: 'About 3 hours.',
        },
      ],
    },
  ],
  totals: {
    posts: 3,
    comments: 12,
    voc: 0,
    ugc: 0,
    topics: 1,
    follow_up_topics: 1,
    external_items: 3,
    to_posts: 2,
    to_comments: 1,
    new_posts: 0,
  },
  sweeps: { count: 6, last_at: '2026-10-16T09:00:00.000Z' },
  markdown: '# INMO Reddit 周报\n',
  assessment_labels: {
    no_action: '日常讨论，无需处理',
    low_relevance: '相关度不高，不建议回复',
    follow_up: '建议跟进',
  },
}

describe('Reddit 周报卡', () => {
  it('认形状；按配置顺序出节；话题带数与评估，原文点开才见；回复带链接；没有图片', async () => {
    expect(isRedditWeekly(payload)).toBe(true)
    expect(isRedditWeekly({ kind: 'weekly_review', findings: [] })).toBe(false)
    const { container } = renderWithProviders(<RedditWeeklyBody payload={payload} />)
    const ids = [...container.querySelectorAll('[data-testid^="rw-section-"]')].map((n) =>
      n.getAttribute('data-testid'),
    )
    expect(ids).toEqual([
      'rw-section-external',
      'rw-section-own_stats',
      'rw-section-voc_ugc',
      'rw-section-our_replies',
    ])
    expect(screen.getByText('全域 VOC & 舆情监测')).toBeTruthy()
    expect(screen.getByText('post × 1 / comment × 2')).toBeTruthy()
    expect(screen.getByText('建议跟进')).toBeTruthy()
    const topic = screen.getByTestId('rw-topic') as HTMLDetailsElement
    expect(topic.open).toBe(false)
    expect(topic.querySelector('a')?.getAttribute('href')).toBe(quote.url)
    expect(screen.getByText('u/bob')).toBeTruthy()
    expect(screen.getByTestId('rw-replies').querySelector('a')?.getAttribute('href')).toBe(
      'https://www.reddit.com/r/inmoxr/comments/1/x/our1/',
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByTestId('rw-no-sweep')).toBeNull()
  })

  it('复制整份 Markdown；导出 .md', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const createObjectURL = vi.fn(() => 'blob:x')
    const revoke = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    renderWithProviders(<RedditWeeklyBody payload={payload} />)
    fireEvent.click(screen.getByTestId('rw-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# INMO Reddit 周报\n'))
    fireEvent.click(screen.getByTestId('rw-export'))
    expect(createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    click.mockRestore()
  })

  it('没巡查过就照实说一句', () => {
    renderWithProviders(<RedditWeeklyBody payload={{ ...payload, sweeps: { count: 0 } }} />)
    expect(screen.getByTestId('rw-no-sweep').textContent).toBe('这段时间没有巡查记录')
  })
})
