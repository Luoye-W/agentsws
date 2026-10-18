/**
 * WP417（自查客服 F7）：IM 里问「小王今天忙吗」→ 问的是小王，不是提问人自己。
 */
import { describe, expect, it } from 'vitest'
import { pickNamedPerson } from '../src/im-ask-target.js'

const PEOPLE = [
  { id: 'p_me', name: '张三' },
  { id: 'p_wang', name: '小王' },
  { id: 'p_wangxm', name: '王小明' },
  { id: 'p_li', name: '李' },
  { id: 'p_ann', name: 'Ann' },
]

describe('WP417 F7：IM 点名的同事', () => {
  it('点了名就问那位同事', () => {
    expect(pickNamedPerson('小王今天忙吗', PEOPLE, 'p_me')?.id).toBe('p_wang')
    expect(pickNamedPerson('@Ann 在做什么', PEOPLE, 'p_me')?.id).toBe('p_ann')
  })
  it('名字有包含关系时取最长的', () => {
    expect(pickNamedPerson('王小明下午有空吗', PEOPLE, 'p_me')?.id).toBe('p_wangxm')
  })
  it('没点名 / 只点了自己 / 一个字的名字 → 不改（问自己）', () => {
    expect(pickNamedPerson('我今天有什么会', PEOPLE, 'p_me')).toBeUndefined()
    expect(pickNamedPerson('张三今天忙吗', PEOPLE, 'p_me')).toBeUndefined()
    expect(pickNamedPerson('李经理那单怎么样了', PEOPLE, 'p_me')).toBeUndefined()
  })
})
