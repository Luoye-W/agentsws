/**
 * WP76（58 §1 / §3 / §5）：设计库、面板投影、连接目录里那两张「待增加」的卡。
 *
 * 三组断言分别钉住三件事：
 * 1. 库按职责切得开（五条职责各看各的规格与队列）；
 * 2. 投影分得开「待挑」与「待定稿」，并且「本周产出」数的是**定稿**；
 * 3. Figma / Canva 明着列在目录里（找不到只会让人以为是自己没找到）。
 */
import { CONNECTION_CATEGORIES, connectionDirectoryEntry } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createDesignStore, designDeckData, seedDemoDesign } from '../src/design.js'

const NOW = '2026-09-17T09:00:00.000Z'
const store = () => {
  const s = createDesignStore({ workspace_id: 'ws_test' })
  seedDemoDesign(s, NOW)
  return s
}

describe('58 §5 设计库（三类对象）', () => {
  it('按职责切得开：Amazon 设计看不见独立站那张单', () => {
    const s = store()
    expect(s.requests({ duty: 'amazon' }).map((r) => r.id)).toEqual(['dreq_demo_3'])
    expect(s.requests({ duty: 'dtc' }).every((r) => r.duty === 'dtc')).toBe(true)
    // 五条职责之间零共享：各条加起来才是全部
    const bySum = (['dtc', 'amazon', 'social', 'ads', 'exhibition'] as const)
      .map((d) => s.requests({ duty: d }).length)
      .reduce((a, b) => a + b, 0)
    expect(bySum).toBe(s.requests().length)
  })

  it('按来源岗位筛得出来（面板第一块按它分组）', () => {
    const s = store()
    expect(s.requests({ from_role_id: 'social.meta' }).map((r) => r.id)).toEqual(['dreq_demo_2'])
    expect(s.requests({ from_role_id: 'dtc.support' })).toEqual([])
  })

  it('需求单走下一步：单不在就什么也不做（不凭空建一条）', () => {
    const s = store()
    s.advanceRequest('dreq_nope', 'briefed', NOW)
    expect(s.request('dreq_nope')).toBeUndefined()
    s.advanceRequest('dreq_demo_1', 'briefed', NOW)
    expect(s.request('dreq_demo_1')?.status).toBe('briefed')
    expect(s.request('dreq_demo_1')?.updated_at).toBe(NOW)
  })

  it('需求原文原样存，不改写（外部文本，21 §1）', () => {
    const s = store()
    expect(s.request('dreq_demo_1')?.need).toContain('“一个口，三台设备”')
  })

  it('Amazon 那份 brief 的禁忌里带着平台的硬规矩（主图一个字都不许有）', () => {
    const s = store()
    const brief = s.brief('dbrief_demo_3')
    expect(brief?.must_avoid).toContain('文字')
    expect(brief?.must_avoid).toContain('水印')
  })
})

describe('58 §3 面板五块的投影', () => {
  const data = () => designDeckData(store(), { now: NOW })

  it('需求单队列只放还没出 brief 的那些', () => {
    expect(data().request_queue.map((r) => r.request_id)).toEqual(['dreq_demo_1'])
  })

  it('每一行都说得出是谁下的单', () => {
    expect(data().request_queue[0]?.from).toBe('dtc.store')
  })

  it('进行中那一块把「计划几张 / 出了几张」分开', () => {
    const row = data().in_progress.find((r) => r.request_id === 'dreq_demo_2')
    expect(row?.brief_id).toBe('dbrief_demo_2')
    expect(row?.planned).toBe(2)
    expect(row?.generated).toBe(0)
  })

  it('**待挑与待定稿分得开**：球在谁那儿要看得出来', () => {
    const rows = data().awaiting_pick
    expect(rows.length).toBe(3)
    expect(rows.every((r) => r.stage === 'waiting_pick')).toBe(true)
    // 规格显示中文名，不是 id
    expect(rows[0]?.spec).toBe('Amazon 主图')
  })

  it('**本周产出数的是定稿**，不是出图张数', () => {
    const week = data().weekly
    // demo 里这一周出了四张、定下来一张——产出是 1 不是 4。
    // 把出图张数当产出的结果是这个数永远好看，而只有一张图真的能用。
    expect(week.variants).toBe(4)
    expect(week.final).toBe(1)
    expect(week.by_use).toEqual([{ use: 'story', count: 1 }])
  })

  it('素材库只放定稿的（判据是「入库了**而且**人点过」）', () => {
    const s = store()
    // 上周那张定过稿的不在本周窗口里，但它在素材库里
    expect(designDeckData(s, { now: NOW }).library.map((g) => g.use)).toEqual(['story'])
  })

  it('过期是单独一格，不靠颜色表达', () => {
    const s = store()
    const overdue = designDeckData(s, { now: '2026-09-30T00:00:00.000Z' }).request_queue
    expect(overdue[0]?.overdue).toBe(true)
    expect(data().request_queue[0]?.overdue).toBe(false)
  })
})

describe('58 §1 末行：Figma / Canva 登记「待增加」', () => {
  it('两条都在目录里，而且明着写 planned', () => {
    for (const kind of ['figma', 'canva']) {
      const entry = connectionDirectoryEntry(kind)
      expect(entry?.status).toBe('planned')
      expect(entry?.category).toBe('design')
      // 准备说明里先说代价：没有它照样出 brief、出图、入库
      expect(entry?.note?.zh).toContain('没有它照样')
    }
  })

  it('目录里有「设计」这个分类（没有分类的条目在界面上根本不出现）', () => {
    expect(CONNECTION_CATEGORIES.map((c) => c.id)).toContain('design')
  })
})
