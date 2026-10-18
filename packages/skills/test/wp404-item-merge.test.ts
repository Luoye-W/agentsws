/**
 * WP404（docs/107 §4）：按条的三方合并——docs/90 §6.3 那张表的七种情形，换成「条」。
 */
import { describe, expect, it } from 'vitest'
import { type ItemUserEdit, itemConflictKey, planItemMerge } from '../src/index.js'

const before = [
  { id: 'a', value: '找一批红人' },
  { id: 'b', value: '起草开发信' },
  { id: 'c', value: '谁还没回' },
  { id: 'd', value: '审一条稿' },
]
const after = [
  { id: 'a', value: '找一批红人' }, // 没动
  { id: 'b', value: '起草一封开发信' }, // 改了
  { id: 'd', value: '审一条稿（含广告标识）' }, // 改了
  { id: 'e', value: '哪几个真带货了' }, // 新加
] // c 删了

const edit = (
  op: ItemUserEdit<string>['op'],
  item_id: string,
  value?: string,
): ItemUserEdit<string> => ({
  tier: 'role',
  owner: 'kol.youtube',
  op,
  item_id,
  ...(value === undefined ? {} : { value }),
})

const one = (e: ItemUserEdit<string>) => planItemMerge(before, after, [e])

describe('planItemMerge 七种情形', () => {
  it('① 上游没动、你改了 / 隐藏了 → 保留你的', () => {
    expect(one(edit('edit', 'a', '找 20 个红人')).clean[0]?.resolution).toBe('keep')
    expect(one(edit('hide', 'a')).clean[0]?.resolution).toBe('keep')
  })

  it('② 上游改了、你在后面追加了一句 → 新版 + 你追加的', () => {
    const plan = one(edit('edit', 'b', '起草开发信，不提报价'))
    expect(plan.conflicts).toEqual([])
    expect(plan.clean[0]).toMatchObject({
      resolution: 'rebase',
      value_after: '起草一封开发信，不提报价',
    })
  })

  it('③ 上游改了、你改成和新版一样 → 干净', () => {
    expect(one(edit('edit', 'b', '起草一封开发信')).clean[0]?.resolution).toBe('same')
  })

  it('④ 上游改了、你改成别的 / 隐藏了 → 冲突', () => {
    const changed = one(edit('edit', 'b', '写一封英文信'))
    expect(changed.clean).toEqual([])
    expect(changed.conflicts[0]).toMatchObject({
      reason: 'upstream_changed',
      base_before: '起草开发信',
      base_after: '起草一封开发信',
      mine: '写一封英文信',
    })
    const hidden = one(edit('hide', 'd'))
    expect(hidden.conflicts[0]).toMatchObject({ reason: 'upstream_changed' })
    expect(hidden.conflicts[0]?.mine).toBeUndefined()
  })

  it('⑤ 上游删了、你改了 → 冲突；你也隐藏了 → 干净', () => {
    expect(one(edit('edit', 'c', '谁超过 7 天没回')).conflicts[0]).toMatchObject({
      reason: 'upstream_removed',
      base_before: '谁还没回',
    })
    expect(one(edit('hide', 'c')).clean[0]?.resolution).toBe('keep')
  })

  it('⑥ 你自己加的 → 干净；id 正好和上游新加的撞了（内容不同）→ 冲突', () => {
    expect(one(edit('add', 'mine_1', '本周寄样清单')).clean[0]?.resolution).toBe('keep')
    expect(one(edit('add', 'e', '别的内容')).conflicts[0]?.reason).toBe('id_clash')
    expect(one(edit('add', 'e', '哪几个真带货了')).clean[0]?.resolution).toBe('keep')
  })

  it('⑦ 上游改了、上层只是照抄了旧版（没真改）→ 跟新版走，不问人', () => {
    expect(one(edit('edit', 'b', '起草开发信')).clean[0]?.resolution).toBe('follow_new')
  })

  it('上游这一版本身的变化：加了 / 改了 / 删了哪几条', () => {
    expect(planItemMerge(before, after, []).upstream).toEqual({
      added: ['e'],
      changed: ['b', 'd'],
      removed: ['c'],
    })
  })

  it('值是对象（快捷问题）：按内容比，键的顺序不算；不认「追加」', () => {
    const qp = (prompt: string) => ({
      label: { zh: '起草', en: 'Draft' },
      prompt,
      kind: 'start_task',
    })
    const b = [{ id: 'q', value: qp('写信') }]
    const a = [{ id: 'q', value: qp('写一封信') }]
    const reordered = { kind: 'start_task', prompt: '写信', label: { en: 'Draft', zh: '起草' } }
    const e = (value: unknown): ItemUserEdit => ({
      tier: 'role',
      owner: 'r',
      op: 'edit',
      item_id: 'q',
      value,
    })
    expect(planItemMerge(b, b, [e(qp('写两封信'))]).clean[0]?.resolution).toBe('keep')
    expect(planItemMerge(b, a, [e(reordered)]).clean[0]?.resolution).toBe('follow_new')
    expect(planItemMerge(b, a, [e(qp('写信，附报价'))]).conflicts[0]?.reason).toBe(
      'upstream_changed',
    )
  })

  it('冲突键稳定', () => {
    expect(itemConflictKey('role:kol.youtube/quick_prompts', '2', edit('edit', 'b', 'x'))).toBe(
      'role:kol.youtube/quick_prompts|2|role|kol.youtube|b',
    )
  })
})
