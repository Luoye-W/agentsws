/**
 * WP419：侧边栏卡的投影——回帖子时「回的那一句」就是原帖标题，不再重复一遍（自查 U15）；
 * WP411 的几道检查与「品牌号在这串里说过」带上卡（矛盾的不出卡，不在这里）。
 */
import { describe, expect, it } from 'vitest'
import { panelCardOf } from '../src/index.js'
import { approvalItem } from './helpers.js'

const payload = (over: Record<string, unknown> = {}, reddit: Record<string, unknown> = {}) => ({
  form: 'reddit_write',
  channel: 'reddit',
  reddit: {
    kind: 'comment',
    subreddit: 'ivraxr',
    parent_fullname: 't3_p9',
    permalink: '/r/ivraxr/comments/p9/battery/',
    post_title: 'Battery life after the 2.1 update?',
    post_text: 'Mine drops 20% an hour since the update.',
    parent_author: 'bob',
    ...reddit,
  },
  body: { text: 'Thanks Bob' },
  // 出卡那一跳的兜底：没有 parent_text 时拿原帖标题当「回的那一句」
  in_reply_to: 'Battery life after the 2.1 update?',
  ...over,
})

describe('WP419 侧边栏卡', () => {
  it('回帖子：标题只出一次，引用框放正文', () => {
    const card = panelCardOf(approvalItem({ payload: payload() }))
    expect(card?.post_title).toBe('Battery life after the 2.1 update?')
    expect(card?.parent_text).toBeUndefined()
    expect(card?.post_text).toBe('Mine drops 20% an hour since the update.')
  })
  it('回评论：被回的那一句照常带', () => {
    const card = panelCardOf(
      approvalItem({ payload: payload({}, { kind: 'reply', parent_text: 'Mine fogs up.' }) }),
    )
    expect(card?.parent_text).toBe('Mine fogs up.')
  })
  it('几道检查、品牌号在这串里说过的（最多 5 条）带上卡', () => {
    const card = panelCardOf(
      approvalItem({
        payload: payload({
          checks: [
            {
              kind: 'ungrounded',
              message: '「2 年保修」没依据，换成了「我去确认一下」',
              fixed: true,
            },
            { kind: 'thread', message: '这一串没现读成，只看了库里有的。' },
            { kind: 'persona', message: '' },
          ],
          prior_replies: Array.from({ length: 7 }, (_, i) => ({
            fullname: `t1_o${i}`,
            text: `ours ${i}`,
            created_at: '2026-10-12T08:00:00.000Z',
          })),
        }),
      }),
    )
    expect(card?.checks).toEqual([
      { kind: 'ungrounded', message: '「2 年保修」没依据，换成了「我去确认一下」', fixed: true },
      { kind: 'thread', message: '这一串没现读成，只看了库里有的。' },
    ])
    expect(card?.prior_replies).toHaveLength(5)
    expect(card?.prior_replies?.[4]).toEqual({
      text: 'ours 6',
      created_at: '2026-10-12T08:00:00.000Z',
    })
  })
})
