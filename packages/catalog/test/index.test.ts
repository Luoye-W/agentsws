import { afterEach, describe, expect, it } from 'vitest'
import {
  CatalogError,
  CatalogIndex,
  type CatalogStore,
  createCatalog,
  MemoryCatalogStore,
  MIN_REASON_LENGTH,
  PROMOTION_CRITERIA,
  promotionCandidates,
  SqliteCatalogStore,
} from '../src/index.js'
import { entry, fixedClock, source, WS } from './helpers.js'

const clock = fixedClock()

const opened: CatalogStore[] = []
const stores = (): { name: string; make: () => CatalogStore }[] => [
  { name: '内存档', make: () => new MemoryCatalogStore() },
  {
    name: 'SQLite 档',
    make: () => {
      const s = new SqliteCatalogStore({ clock })
      opened.push(s)
      return s
    },
  },
]

afterEach(() => {
  for (const s of opened.splice(0)) s.close?.()
})

describe.each(stores())('$name', ({ make }) => {
  it('注记合并：只覆盖给了的字段', () => {
    const store = make()
    store.put({
      workspace_id: WS,
      entry_id: 'schedule:a',
      layer: 'dept',
      at: '2026-09-10T00:00:00.000Z',
    })
    store.put({
      workspace_id: WS,
      entry_id: 'schedule:a',
      reason_for_duplicate: '我这个只看退货窗口内的单',
      similar_to: ['schedule:b'],
      at: '2026-09-11T00:00:00.000Z',
    })
    const got = store.get(WS, 'schedule:a')
    expect(got?.layer).toBe('dept')
    expect(got?.reason_for_duplicate).toBe('我这个只看退货窗口内的单')
    expect(got?.at).toBe('2026-09-11T00:00:00.000Z')
    expect(store.get('ws_other', 'schedule:a')).toBeUndefined()
    expect(store.list(WS)).toHaveLength(1)
    expect(store.list('ws_other')).toEqual([])
  })

  it('目录条目盖上注记：层升了、被取代了', async () => {
    const store = make()
    const index = new CatalogIndex({
      clock,
      store,
      sources: [
        source('schedule', [
          entry({ id: 'schedule:a', title: '每天早上汇总退款单' }),
          entry({ id: 'schedule:b', title: '早上汇总退款单' }),
        ]),
      ],
    })
    index.promote({
      workspace_id: WS,
      entry_id: 'schedule:a',
      to_layer: 'company',
      supersede: ['schedule:b', 'schedule:a'],
    })
    const all = await index.entries(WS)
    expect(all.find((e) => e.id === 'schedule:a')?.layer).toBe('company')
    expect(all.find((e) => e.id === 'schedule:b')?.superseded_by).toBe('schedule:a')
    // 默认不列已被取代的
    expect((await index.list({ workspace_id: WS })).map((e) => e.id)).toEqual(['schedule:a'])
    expect((await index.list({ workspace_id: WS, include_superseded: true })).length).toBe(2)
  })
})

describe('CatalogIndex', () => {
  const build = (): CatalogIndex => {
    const index = new CatalogIndex({ clock })
    index.register(
      source('schedule', [
        entry({
          id: 'schedule:s1',
          title: '每天早上汇总退款单',
          summary: '给运营看',
          owner: 'p_li',
          used_by_positions: ['asg_ops'],
          runs_30d: 28,
          trigger: 'cron:0 9 * * *',
          last_run_at: '2026-09-09T01:00:00.000Z',
        }),
        entry({ id: 'schedule:s2', title: '每周给红人发跟进邮件', owner: 'p_wang', layer: 'dept' }),
        // 别的工作区的条目：一律不进目录
        entry({ id: 'schedule:x', title: '别人家的', workspace_id: 'ws_other' }),
      ]),
    )
    index.register(
      source('skill', [
        entry({
          id: 'skill:dtc.aftersales',
          kind: 'skill',
          title: '售后客服',
          owner: 'p_li',
          used_by_positions: ['asg_ops', 'asg_cs'],
          runs_30d: 40,
        }),
      ]),
    )
    return index
  }

  it('列全部、按 kind / 岗位 / 层 / 人 / 文本筛', async () => {
    const index = build()
    expect((await index.list({ workspace_id: WS })).map((e) => e.id)).toEqual([
      'schedule:s1',
      'schedule:s2',
      'skill:dtc.aftersales',
    ])
    expect((await index.list({ workspace_id: WS, kind: ['skill'] })).map((e) => e.id)).toEqual([
      'skill:dtc.aftersales',
    ])
    expect(
      (await index.list({ workspace_id: WS, position_id: 'asg_cs' })).map((e) => e.id),
    ).toEqual(['skill:dtc.aftersales'])
    expect((await index.list({ workspace_id: WS, layer: ['dept'] })).map((e) => e.id)).toEqual([
      'schedule:s2',
    ])
    expect((await index.list({ workspace_id: WS, owner: 'p_wang' })).map((e) => e.id)).toEqual([
      'schedule:s2',
    ])
    expect((await index.list({ workspace_id: WS, text: '退款' })).map((e) => e.id)).toEqual([
      'schedule:s1',
    ])
  })

  it('建之前先查：查到就回候选与人话理由', async () => {
    const hits = await build().similar({
      workspace_id: WS,
      kind: 'schedule',
      title: '早上把退款单汇总一下',
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.entry.owner).toBe('p_li')
    expect(hits[0]?.reasons.join('')).toContain('同一件事')
  })

  it('"仍新建"必须写理由，理由进目录并成为下次的负样本', async () => {
    const index = build()
    expect(() =>
      index.noteDuplicate({
        workspace_id: WS,
        entry_id: 'schedule:s9',
        similar_to: ['schedule:s1'],
        reason: '不一样',
      }),
    ).toThrow(CatalogError)
    expect(() =>
      index.noteDuplicate({
        workspace_id: WS,
        entry_id: 'schedule:s9',
        similar_to: ['schedule:s1'],
        reason: ' '.repeat(MIN_REASON_LENGTH),
      }),
    ).toThrow(/至少/)
    const note = index.noteDuplicate({
      workspace_id: WS,
      entry_id: 'schedule:s9',
      similar_to: ['schedule:s1'],
      reason: '我这条只看退货窗口内的单，口径不同',
    })
    expect(note.at).toBe(clock.now())
    expect(index.rejections(WS)).toEqual({ 'schedule:s1': 1 })
  })

  it('复用已有的那一条：只记来源', () => {
    const index = build()
    index.noteReuse({
      workspace_id: WS,
      entry_id: 'custom_card:c1',
      reused: 'schedule:s1',
      conversation_id: 'conv_1',
    })
    expect(index.store.get(WS, 'custom_card:c1')?.created_from).toEqual({
      entry_id: 'schedule:s1',
      conversation_id: 'conv_1',
    })
    expect(index.rejections(WS)).toEqual({})
  })

  it('疑似重复：两条都在用', async () => {
    const index = new CatalogIndex({ clock })
    index.register(
      source('schedule', [
        entry({ id: 'schedule:a', title: '每天早上汇总退款单', runs_30d: 10 }),
        entry({ id: 'schedule:b', title: '早上汇总退款单', used_by_positions: ['asg_ops'] }),
      ]),
    )
    const pairs = await index.duplicates(WS)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.both_in_use).toBe(true)
    expect(await index.duplicates(WS, { threshold: 0.99 })).toEqual([])
  })

  it('往上浮：跑得多没人反对 → 过 Wilson；只有两个岗位挂着不过', async () => {
    const index = build()
    const candidates = await index.promotionCandidates({ workspace_id: WS })
    const skill = candidates.find((c) => c.entry.id === 'skill:dtc.aftersales')
    expect(skill?.card_kind).toBe('skill_promotion')
    expect(skill?.trigger).toBe('positions')
    expect(skill?.passed).toBe(true)
    expect(skill?.lower_bound).toBeGreaterThanOrEqual(PROMOTION_CRITERIA.min_lower_bound)
    // 只有一个岗位在用，不进候选
    expect(candidates.find((c) => c.entry.id === 'schedule:s1')).toBeUndefined()
  })

  it('周复盘点名也能进候选，但跑得太少照样不出卡', async () => {
    const index = new CatalogIndex({ clock })
    index.register(
      source('custom_card', [
        entry({ id: 'custom_card:c1', kind: 'custom_card', title: '退款看板', runs_30d: 2 }),
      ]),
    )
    const [c] = await index.promotionCandidates({
      workspace_id: WS,
      named_in_review: ['custom_card:c1'],
    })
    expect(c?.trigger).toBe('review')
    expect(c?.card_kind).toBe('policy_change')
    expect(c?.passed).toBe(false)
    expect(c?.missing.join('')).toContain('采用率下界')
  })

  it('已经在部门层的、已被取代的，不再往上推', () => {
    const listed = promotionCandidates({
      entries: [
        entry({ id: 'a', title: 'a', layer: 'dept', used_by_positions: ['1', '2'] }),
        entry({ id: 'b', title: 'b', used_by_positions: ['1', '2'], superseded_by: 'a' }),
      ],
      rejections: {},
    })
    expect(listed).toEqual([])
  })

  it('被"仍新建"顶掉得多 → 下界掉下来，不出卡', () => {
    const e = entry({ id: 'schedule:a', title: 'a', used_by_positions: ['1', '2'], runs_30d: 30 })
    expect(promotionCandidates({ entries: [e], rejections: {} })[0]?.passed).toBe(true)
    const busted = promotionCandidates({ entries: [e], rejections: { 'schedule:a': 6 } })[0]
    expect(busted?.rejections).toBe(6)
    expect(busted?.passed).toBe(false)
  })

  it('createCatalog：给了路径就落盘，重启还在', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/agentsws-catalog-${process.pid}.db`
    const first = createCatalog({ clock, dbPath: path })
    first.noteDuplicate({
      workspace_id: WS,
      entry_id: 'schedule:s9',
      similar_to: ['schedule:s1'],
      reason: '口径不同：只看退货窗口内',
    })
    first.close()
    const again = createCatalog({ clock, dbPath: path })
    expect(again.rejections(WS)).toEqual({ 'schedule:s1': 1 })
    again.close()
  })

  it('createCatalog：不给路径就是内存档', async () => {
    const index = createCatalog({ clock, sources: [source('app', [])] })
    expect(await index.entries(WS)).toEqual([])
    index.close()
  })
})

describe('没有家的条目', () => {
  it('record 记一条定制卡：进得了工具箱，也参与查重与晋升', async () => {
    const index = new CatalogIndex({ clock })
    index.record(
      entry({ id: 'custom_card:c1', kind: 'custom_card', title: '退款看板', runs_30d: 3 }),
    )
    expect((await index.list({ workspace_id: WS })).map((e) => e.id)).toEqual(['custom_card:c1'])
    const hits = await index.similar({ workspace_id: WS, kind: 'custom_card', title: '退款看板' })
    expect(hits).toHaveLength(1)
    // 来源回调喂进来的同 id 条目优先（有家的以它自己那份为准）
    index.register(
      source('custom_card', [
        entry({ id: 'custom_card:c1', kind: 'custom_card', title: '换了个名字' }),
      ]),
    )
    expect((await index.entries(WS)).map((e) => e.title)).toEqual(['换了个名字'])
  })

  it('别的工作区记的那条不串场', async () => {
    const index = new CatalogIndex({ clock })
    index.record(entry({ id: 'rule:r1', kind: 'rule', title: '不给运费补偿' }))
    expect(await index.entries('ws_other')).toEqual([])
  })
})
