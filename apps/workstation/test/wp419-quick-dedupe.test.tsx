/**
 * WP419（自查 U1）：社媒岗位页快捷按钮「排下周的内容」「起草一条」FB、IG 各一个——同名只留一个。
 */
import { describe, expect, it } from 'vitest'
import { uniqueByLabel } from '@/components/position/landing-actions'

describe('WP419 快捷按钮按文字去重', () => {
  it('同名只留第一个，顺序不变', () => {
    const got = uniqueByLabel([
      { id: 'fb.plan', label: '排下周的内容', prompt: 'fb' },
      { id: 'fb.draft', label: '起草一条', prompt: 'fb' },
      { id: 'ig.plan', label: '排下周的内容', prompt: 'ig' },
      { id: 'ig.draft', label: '起草一条 ', prompt: 'ig' },
      { id: 'ig.comments', label: '有哪些评论等着回', prompt: 'ig' },
    ])
    expect(got.map((p) => p.id)).toEqual(['fb.plan', 'fb.draft', 'ig.comments'])
  })
})
