/** 40 §2 工具箱与查重面：列表 / 先查 / 疑似重复，以及没装工具箱时的 501。 */
import { describe, expect, it } from 'vitest'
import type {
  CatalogEntryView,
  CatalogKindName,
  CatalogPort,
  CatalogSimilarHit,
} from '../src/index.js'
import { harness } from './helpers.js'

function entry(over: Partial<CatalogEntryView> & { id: string; title: string }): CatalogEntryView {
  return {
    kind: 'schedule',
    summary: '',
    owner: 'p_li',
    layer: 'personal',
    used_by_positions: [],
    runs_30d: 0,
    workspace_id: 'ws',
    ...over,
  }
}

/** 只留网关用得到的行为；判定本身在 `@agentsws/catalog` 里测。 */
class FakeCatalog implements CatalogPort {
  readonly entries: CatalogEntryView[]
  readonly notes: { entry_id: string; reason: string; similar_to: string[] }[] = []
  readonly reuses: { entry_id: string; reused: string }[] = []
  readonly seen: unknown[] = []

  constructor(entries: CatalogEntryView[]) {
    this.entries = entries
  }

  list(query: {
    workspace_id: string
    kind?: CatalogKindName[]
    layer?: string[]
    position_id?: string
    owner?: string
    text?: string
  }): CatalogEntryView[] {
    this.seen.push(query)
    return this.entries.filter((e) => {
      if (query.kind !== undefined && !query.kind.includes(e.kind)) return false
      if (query.layer !== undefined && !query.layer.includes(e.layer)) return false
      if (query.position_id !== undefined && !e.used_by_positions.includes(query.position_id))
        return false
      if (query.owner !== undefined && e.owner !== query.owner) return false
      if (query.text !== undefined && !e.title.includes(query.text)) return false
      return true
    })
  }

  similar(query: { title: string; kind: CatalogKindName }): CatalogSimilarHit[] {
    this.seen.push(query)
    return this.entries
      .filter((e) => e.kind === query.kind && e.title === query.title)
      .map((e) => ({ entry: e, similarity: 1, keys: ['semantic', 'kind'], reasons: ['一模一样'] }))
  }

  duplicates(query: { limit?: number }): {
    a: CatalogEntryView
    b: CatalogEntryView
    similarity: number
    both_in_use: boolean
    reasons: string[]
  }[] {
    const [a, b] = this.entries
    if (a === undefined || b === undefined) return []
    const pairs = [{ a, b, similarity: 0.9, both_in_use: true, reasons: ['一模一样'] }]
    return query.limit === undefined ? pairs : pairs.slice(0, query.limit)
  }

  noteDuplicate(input: { entry_id: string; reason: string; similar_to: string[] }): void {
    this.notes.push({
      entry_id: input.entry_id,
      reason: input.reason,
      similar_to: input.similar_to,
    })
  }

  noteReuse(input: { entry_id: string; reused: string }): void {
    this.reuses.push({ entry_id: input.entry_id, reused: input.reused })
  }
}

async function withCatalog(entries: CatalogEntryView[] = []) {
  const h = await harness()
  const catalog = new FakeCatalog(entries.map((e) => ({ ...e, workspace_id: h.workspace_id })))
  // 路由处理器拿的是同一个 deps 对象，建完网关再装也生效
  h.deps.catalog = catalog
  return { h, catalog }
}

const SEED: CatalogEntryView[] = [
  entry({
    id: 'schedule:s1',
    title: '每天早上汇总退款单',
    owner: 'p_li',
    used_by_positions: ['asg_ok'],
    runs_30d: 28,
  }),
  entry({ id: 'skill:aftersales', kind: 'skill', title: '售后客服', layer: 'company' }),
]

describe('GET /v1/catalog', () => {
  it('列出本工作区建过的全部，按 kind / 层 / 岗位 / 人 / 用途筛', async () => {
    const { h } = await withCatalog(SEED)
    const all = await (await h.get('/v1/catalog')).json()
    expect(all.data.map((e: CatalogEntryView) => e.id)).toEqual(['schedule:s1', 'skill:aftersales'])
    const skills = await (await h.get('/v1/catalog?kind=skill')).json()
    expect(skills.data.map((e: CatalogEntryView) => e.id)).toEqual(['skill:aftersales'])
    const company = await (await h.get('/v1/catalog?layer=company')).json()
    expect(company.data).toHaveLength(1)
    const mine = await (await h.get('/v1/catalog?position=asg_ok&owner=p_li&q=退款')).json()
    expect(mine.data.map((e: CatalogEntryView) => e.id)).toEqual(['schedule:s1'])
  })

  it('kind / layer 写错回 400（不悄悄退成"全部"）', async () => {
    const { h } = await withCatalog(SEED)
    expect((await h.get('/v1/catalog?kind=lol')).status).toBe(400)
    expect((await h.get('/v1/catalog?layer=lol')).status).toBe(400)
  })

  it('没装工具箱 → 501', async () => {
    const h = await harness()
    expect((await h.get('/v1/catalog')).status).toBe(501)
    expect((await h.get('/v1/catalog/duplicates')).status).toBe(501)
    expect((await h.post('/v1/catalog/similar', { kind: 'schedule', title: 'x' })).status).toBe(501)
  })
})

describe('POST /v1/catalog/similar', () => {
  it('查得到就回候选与人话理由', async () => {
    const { h } = await withCatalog(SEED)
    const res = await h.post('/v1/catalog/similar', {
      kind: 'schedule',
      title: '每天早上汇总退款单',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].reasons).toEqual(['一模一样'])
  })

  it('查不到就是空数组（不是 404）', async () => {
    const { h } = await withCatalog(SEED)
    const res = await h.post('/v1/catalog/similar', { kind: 'schedule', title: '没人做过的事' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([])
  })

  it('kind 不在六种里 → 400', async () => {
    const { h } = await withCatalog(SEED)
    expect((await h.post('/v1/catalog/similar', { kind: 'lol', title: 'x' })).status).toBe(400)
  })
})

describe('GET /v1/catalog/duplicates', () => {
  it('成对回，limit 生效；limit 写错 400', async () => {
    const { h } = await withCatalog(SEED)
    const res = await h.get('/v1/catalog/duplicates')
    expect((await res.json()).data).toHaveLength(1)
    expect((await (await h.get('/v1/catalog/duplicates?limit=1')).json()).data).toHaveLength(1)
    expect((await h.get('/v1/catalog/duplicates?limit=0')).status).toBe(400)
  })
})
