import { describe, expect, it } from 'vitest'
import { type RedditPendingLike, redditTargetFromItem } from '../src/index.js'

const base: RedditPendingLike = {
  id: 'rw_1',
  kind: 'comment',
  fullname: 't1_c1',
  subreddit: 'ivraxr',
  author: 'alice',
  text: 'Mine fogs up a bit',
  url: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/?context=3',
  post_title: 'Air3 with glasses?',
  inbox_type: 'comment_reply',
}

describe('WP329：WP328 待处理条目 → 写到哪', () => {
  it('评论（含收件箱回复 / @）→ 楼中楼，带链接与上下文', () => {
    expect(redditTargetFromItem(base)).toEqual({
      kind: 'reply',
      subreddit: 'ivraxr',
      parent_fullname: 't1_c1',
      permalink: '/r/ivraxr/comments/abc/slug/c1/',
      post_title: 'Air3 with glasses?',
      parent_author: 'alice',
      parent_text: 'Mine fogs up a bit',
      inbox_type: 'comment_reply',
      source: { type: 'reddit_watch_item', id: 'rw_1' },
    })
  })

  it('帖子 → 在帖子下回一条', () => {
    const t = redditTargetFromItem({
      ...base,
      kind: 'post',
      fullname: 't3_abc',
      title: 'Air3 with glasses?',
      url: '/r/ivraxr/comments/abc/slug/',
    })
    expect(t?.kind).toBe('comment')
    expect(t?.parent_fullname).toBe('t3_abc')
    expect(t?.post_title).toBe('Air3 with glasses?')
  })

  it('私信不回；评论没链接回不了', () => {
    expect(redditTargetFromItem({ ...base, kind: 'message', fullname: 't4_x' })).toBeUndefined()
    const { url: _u, ...noUrl } = base
    expect(redditTargetFromItem(noUrl)).toBeUndefined()
  })
})
