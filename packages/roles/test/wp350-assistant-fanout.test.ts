/**
 * WP350（决策 900）：助理一次拆成多份——认岗位（点名照点、认不出标归属待定）、品牌公共、
 * 像口令的不进知识 / 记忆；人改方案（勾掉 / 改归属 / 改文字）之后哪些发、哪些不发。
 */
import { describe, expect, it } from 'vitest'
import {
  applyFanoutEdits,
  FANOUT_NOTE_SUBJECT,
  fanoutNoteCard,
  mentionedPositions,
  type PickPosition,
  resolveFanout,
} from '../src/index.js'

const owner: PickPosition = {
  id: 'owner',
  name: '负责人',
  duties: [{ role_id: 'common.owner', name: '工作区所有者' }],
}
const reddit: PickPosition = {
  id: 'reddit-ops',
  name: 'Reddit 运营',
  duties: [
    { role_id: 'social.reddit', name: '自家版运营' },
    { role_id: 'pr.reddit', name: 'Reddit 外部露出' },
  ],
}
const care: PickPosition = {
  id: 'customer-care',
  name: '客服',
  duties: [{ role_id: 'dtc.support', name: '售后客服' }],
}
const site: PickPosition = {
  id: 'web-ops',
  name: '网站运营',
  duties: [{ role_id: 'site.store', name: '店铺管理' }],
}
const all = [owner, reddit, care, site]

describe('resolveFanout', () => {
  it('每条按点的岗位名认；职责名带上；要记的可以归品牌公共', () => {
    const items = resolveFanout(all, [
      { kind: 'task', text: '回复昨天那条差评帖', position: 'Reddit 运营', duty: '自家版运营' },
      { kind: 'task', text: '把退货说明改成 30 天', position: '网站运营', due: '周五前' },
      { kind: 'note', text: '退货期统一 30 天', position: '客服', quote: '会上定：退货 30 天' },
      { kind: 'note', text: '品牌语气偏轻松', position: '品牌' },
      { kind: 'memory', text: '周报用表格' },
    ])
    expect(items.map((i) => [i.id, i.kind, i.position_id, i.role_id, i.brand])).toEqual([
      ['i1', 'task', 'reddit-ops', 'social.reddit', undefined],
      ['i2', 'task', 'web-ops', undefined, undefined],
      ['i3', 'note', 'customer-care', undefined, undefined],
      ['i4', 'note', undefined, undefined, true],
      ['i5', 'memory', undefined, undefined, undefined],
    ])
    expect(items[1]?.due).toBe('周五前')
    expect(items[2]?.quote).toBe('会上定：退货 30 天')
  })

  it('认不出的不猜：标归属待定、候选是干活的岗位（不含负责人）', () => {
    const [item] = resolveFanout(all, [{ kind: 'task', text: '把这件事跟进一下' }])
    expect(item?.position_id).toBeUndefined()
    expect(item?.unsure?.candidates).toEqual(['reddit-ops', 'customer-care', 'web-ops'])
    const [named] = resolveFanout(all, [{ kind: 'task', text: '发一条推', position: '推特运营' }])
    expect(named?.unsure?.reason).toContain('推特运营')
  })

  it('没点名但话里只提到一个岗位就归它', () => {
    const [item] = resolveFanout(all, [{ kind: 'task', text: '让客服把工单过一遍' }])
    expect(item?.position_id).toBe('customer-care')
  })

  it('像口令的：要记的标出来（不发），要做的把那串抹掉', () => {
    const items = resolveFanout(all, [
      { kind: 'note', text: '后台密码：hunter2-very-secret', position: '网站运营' },
      { kind: 'memory', text: 'api_key=sk-abcdefghijklmnop1234' },
      {
        kind: 'task',
        text: '用 sk-abcdefghijklmnopqrstuvwxyz123456 登录后台检查',
        position: '网站运营',
      },
    ])
    expect(items[0]?.secret).toBe(true)
    expect(items[1]?.secret).toBe(true)
    expect(items[2]?.secret).toBeUndefined()
    expect(items[2]?.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('空的跳过、字数截断、最多 30 条', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      kind: 'task' as const,
      text: i === 0 ? '   ' : `第 ${i} 件 ${'很长'.repeat(200)}`,
      position: '客服',
    }))
    const items = resolveFanout(all, many)
    expect(items.length).toBe(30)
    expect(items[0]?.text.startsWith('第 1 件')).toBe(true)
    expect(items[0]?.text.length).toBeLessThanOrEqual(301)
  })
})

describe('applyFanoutEdits', () => {
  const items = resolveFanout(all, [
    { kind: 'task', text: '回复差评帖', position: 'Reddit 运营' },
    { kind: 'task', text: '改退货说明', position: '网站运营' },
    { kind: 'task', text: '这件事谁来跟' },
    { kind: 'note', text: '退货 30 天', position: '客服' },
    { kind: 'note', text: '密码：abc12345678', position: '客服' },
  ])

  it('不改 = 有岗位的发；归属待定的、像口令的不发', () => {
    const out = applyFanoutEdits(all, items)
    expect(out.send.map((i) => i.id)).toEqual(['i1', 'i2', 'i4'])
    expect(out.skipped.map((i) => [i.id, i.why_skipped])).toEqual([
      ['i3', 'unsure'],
      ['i5', 'secret'],
    ])
  })

  it('勾掉的不发；改归属生效（只认本人名下的岗位 / 职责）；改文字生效', () => {
    const out = applyFanoutEdits(all, items, [
      { id: 'i1', drop: true },
      { id: 'i2', position_id: 'customer-care', role_id: 'dtc.support', text: '写一版退货话术' },
      { id: 'i3', position_id: 'reddit-ops', role_id: 'not.mine' },
      { id: 'i4', brand: true },
    ])
    expect(out.send.map((i) => [i.id, i.position_id, i.role_id, i.brand, i.text])).toEqual([
      ['i2', 'customer-care', 'dtc.support', undefined, '写一版退货话术'],
      ['i3', 'reddit-ops', undefined, undefined, '这件事谁来跟'],
      ['i4', undefined, undefined, true, '退货 30 天'],
    ])
    expect(out.skipped.find((i) => i.id === 'i1')?.why_skipped).toBe('dropped')
  })

  it('改到不在名下的岗位不算（还是待定）', () => {
    const out = applyFanoutEdits(all, items, [{ id: 'i3', position_id: 'ads' }])
    expect(out.skipped.find((i) => i.id === 'i3')?.why_skipped).toBe('unsure')
  })
})

describe('mentionedPositions / fanoutNoteCard', () => {
  it('话里点了哪几个岗位（按出现先后）', () => {
    expect(mentionedPositions(all, '让网站运营改价，客服统一口径，负责人看一下')).toEqual([
      'web-ops',
      'customer-care',
    ])
    expect(mentionedPositions(all, '帮我总结一下')).toEqual([])
  })

  it('知识条目：proposed 前的形状，出处 = 这份资料，subject.id = 岗位', () => {
    const [item] = resolveFanout(all, [
      { kind: 'note', text: '退货 30 天', position: '客服', quote: '会上定：退货 30 天' },
    ])
    if (item === undefined) throw new Error('没拆出来')
    const card = fanoutNoteCard(item, {
      workspace_id: 'ws_1' as never,
      owner: 'p_1' as never,
      at: '2026-10-16T00:00:00.000Z',
      batch_id: 'fan_1',
      source_name: '周会纪要.md',
      source_kind: 'meeting',
      position_name: '客服',
    })
    expect(card.subject).toEqual({
      type: FANOUT_NOTE_SUBJECT,
      id: 'customer-care',
      key: 'fanout:fan_1:i1',
    })
    expect(card.provenance[0]).toMatchObject({
      source: 'meeting',
      ref: 'assistant:fan_1',
      locator: '周会纪要.md',
      quote: '会上定：退货 30 天',
    })
    expect(card.created_by).toEqual({ kind: 'agent', id: 'assistant' })
  })
})
