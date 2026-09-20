/**
 * WP76（58 §1 / §3 / §5）：设计库、面板投影、连接目录里那两张「待增加」的卡。
 *
 * 三组断言分别钉住三件事：
 * 1. 库按职责切得开（五条职责各看各的规格与队列）；
 * 2. 投影分得开「待挑」与「待定稿」，并且「本周产出」数的是**定稿**；
 * 3. Figma / Canva 明着列在目录里（找不到只会让人以为是自己没找到）。
 */
import type { BrandDesignProfile } from '@agentsws/contracts'
import { CONNECTION_CATEGORIES, connectionDirectoryEntry } from '@agentsws/contracts'
import type { GenerationPlan } from '@agentsws/design-core'
import { describe, expect, it } from 'vitest'
import {
  createDesignStore,
  designCheckNote,
  designDeckData,
  seedDemoDesign,
} from '../src/design.js'

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
    expect(s.requests({ from_role_id: 'dtc.content' }).map((r) => r.id)).toEqual(['dreq_demo_4'])
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

  it('每一行都说得出是谁下的单；给了职责名就不摆裸 id（36 §2）', () => {
    expect(data().request_queue[0]?.from).toBe('dtc.store')
    const named = designDeckData(store(), {
      now: NOW,
      roleName: (id) => (id === 'dtc.store' ? '店铺管理' : undefined),
    })
    expect(named.request_queue[0]?.from).toBe('店铺管理')
  })

  it('进行中那一块把「计划几张 / 出了几张」分开', () => {
    const row = data().in_progress.find((r) => r.request_id === 'dreq_demo_2')
    expect(row?.brief_id).toBe('dbrief_demo_2')
    expect(row?.planned).toBe(2)
    expect(row?.generated).toBe(0)
    // 第四张单出完了三张，还在等人挑
    const dtc = data().in_progress.find((r) => r.request_id === 'dreq_demo_4')
    expect(dtc?.planned).toBe(3)
    expect(dtc?.generated).toBe(3)
  })

  it('**待挑与待定稿分得开**：球在谁那儿要看得出来', () => {
    const rows = data().awaiting_pick
    expect(rows.length).toBe(6)
    expect(rows.every((r) => r.stage === 'waiting_pick')).toBe(true)
    // 规格显示中文名，不是 id
    expect(rows[0]?.spec).toBe('Amazon 主图')
    expect(rows.map((r) => r.duty).sort()).toEqual([
      'amazon',
      'amazon',
      'amazon',
      'dtc',
      'dtc',
      'dtc',
    ])
  })

  it('**本周产出数的是定稿**，不是出图张数', () => {
    const week = data().weekly
    // demo 里这一周出了七张、定下来一张——产出是 1 不是 7。
    // 把出图张数当产出的结果是这个数永远好看，而只有一张图真的能用。
    expect(week.variants).toBe(7)
    expect(week.final).toBe(1)
    expect(week.by_use).toEqual([{ use: 'hero', count: 1 }])
  })

  it('素材库只放定稿的（判据是「入库了**而且**人点过」）', () => {
    const s = store()
    // 上周那张定过稿的不在本周窗口里，但它在素材库里
    expect(designDeckData(s, { now: NOW }).library.map((g) => g.use)).toEqual(['hero'])
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

/*
 * WP122（71 §5 第二条）：出图那一批提示词过一道规范自检，压成卡片上一行字。
 *
 * 这一组盯的是**克制**，不是覆盖率：
 * - 没有规范就一个字都不说（不然每个新品牌的每张图都在报"不在色板里"）；
 * - 同一句话只说一次（六条提示词都写了同一个橙，卡面上出现六遍等于没说）；
 * - 回的是 `string | undefined`，**不是布尔**——它没有能力拦住任何东西。
 */
describe('71 §5 规范自检那一行', () => {
  const profile: BrandDesignProfile = {
    colors: {
      primary: {
        value: '#b8422e',
        confidence: 'high',
        source: [{ origin: 'site', url: 'https://heritage.test/', locator: 'css-var:--brand' }],
      },
      surface: {
        value: '#f7f5f2',
        confidence: 'high',
        source: [{ origin: 'site', url: 'https://heritage.test/', locator: 'css:body' }],
      },
    },
  }

  const plan = (...prompts: string[]): GenerationPlan => ({
    brief_id: 'dbrief_1',
    n: prompts.length,
    quota_notes: [],
    over_quota: false,
    prompts: prompts.map((prompt, i) => ({
      plan_item_id: `p${String(i)}`,
      spec_id: 'social.ig.square',
      size: '1080x1080',
      prompt,
      positive_prompt: prompt,
    })),
  })

  it('还没有规范：一个字都不说（不把一个没启用的功能做成噪声源）', () => {
    expect(designCheckNote(undefined, plan('主视觉用 #ff7a00 的渐变'))).toBeUndefined()
  })

  it('色板外的颜色：说出来，并把色板里最近的那个一并给出', () => {
    const note = designCheckNote(profile, plan('主视觉用 #ff7a00 的渐变'))
    expect(note).toContain('#ff7a00 不在品牌色板里')
  })

  it('一批里同一个色出现三次：卡面上只说一次', () => {
    const note = designCheckNote(
      profile,
      plan('底色 #ff7a00', '按钮 #ff7a00', '文字压在 #ff7a00 上'),
    )
    expect(note?.split('#ff7a00 不在品牌色板里').length).toBe(2)
    expect(note).not.toContain('另有')
  })

  it('全都合规范：这一格不出现（界面上不画一行空白）', () => {
    expect(designCheckNote(profile, plan('底色 #b8422e，留白多'))).toBeUndefined()
  })

  it('两个不同的色都出格：都进那一行，超过三条只报头三条 + 还有几条', () => {
    const note = designCheckNote(
      profile,
      plan('#ff7a00 与 #00ff88 与 #1234ff 与 #abcdef 都不在色板里'),
    )
    expect(note).toContain('另有 1 条')
  })
})
