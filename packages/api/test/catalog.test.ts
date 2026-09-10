/** 40 §2 工具箱与查重面：列表 / 先查 / 疑似重复，以及没装工具箱时的 501。 */
import { describe, expect, it } from 'vitest'
import type {
  CatalogEntryView,
  CatalogKindName,
  CatalogPort,
  CatalogSimilarHit,
  SchedulePort,
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
  readonly recorded: CatalogEntryView[] = []
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

  record(entry: CatalogEntryView): void {
    this.recorded.push(entry)
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

/* ------------------------------------------------------------------ */
/* 五个"建"的入口：查到像的 → 409 不直接建；"仍新建"没写理由 → 400        */
/* ------------------------------------------------------------------ */

/** 只留"建出来一条"这一件事；真调度器在 `apps/server` 里测。 */
function fakeSchedules(): SchedulePort & { created: string[]; started: string[] } {
  const created: string[] = []
  const started: string[] = []
  return {
    created,
    started,
    list: () => [],
    create: (input) => {
      created.push(input.title)
      return {
        id: `sch_${created.length}`,
        workspace_id: input.workspace_id,
        owner: input.person_id,
        assignment_id: input.assignment_id,
        title: input.title,
        trigger: input.trigger,
        state: 'active',
        created_by: 'user',
        misfire_policy: input.misfire_policy,
        fire_count: 0,
      } as never
    },
    update: () => ({}) as never,
    cancel: () => ({}) as never,
    runNow: () => ({}) as never,
    workflows: () => [],
    workflow: () => undefined,
    workflowDefinition: (id) => ({ id, name: '红人合作' }),
    startWorkflow: (_actor, input) => {
      started.push(input.def_id)
      return { id: `wf_1`, def: { id: input.def_id, version: '1' } } as never
    },
  }
}

const REASON = '我这条只看退货窗口内的单，口径不一样'

describe('40 §2.2 建之前先查：定时任务', () => {
  it('查到像的 → 409 similar_exists，候选与三个选项都在 details 里，且一条都没建', async () => {
    const { h, catalog } = await withCatalog(SEED)
    const schedules = fakeSchedules()
    h.deps.schedules = schedules
    const res = await h.post('/v1/schedules', {
      title: '每天早上汇总退款单',
      trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('similar_exists')
    expect(body.details.candidates[0].entry.id).toBe('schedule:s1')
    expect(body.details.options.map((o: { id: string }) => o.id)).toEqual(['reuse', 'merge', 'new'])
    expect(schedules.created).toEqual([])
    expect(catalog.notes).toEqual([])
  })

  it('"仍新建"没写理由 / 写得太短 → 400，还是一条都没建', async () => {
    const { h, catalog } = await withCatalog(SEED)
    const schedules = fakeSchedules()
    h.deps.schedules = schedules
    const short = await h.post('/v1/schedules', {
      title: '每天早上汇总退款单',
      trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      duplicate_ack: { decision: 'new', reason: '不一样', similar_to: ['schedule:s1'] },
    })
    expect(short.status).toBe(400)
    expect((await short.json()).details.field).toBe('duplicate_ack.reason')
    // 理由字段本身是必填：连 reason 都不给的 ack 过不了 zod
    const none = await h.post('/v1/schedules', {
      title: '每天早上汇总退款单',
      trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      duplicate_ack: { decision: 'new', similar_to: ['schedule:s1'] },
    })
    expect(none.status).toBe(400)
    expect(schedules.created).toEqual([])
    expect(catalog.notes).toEqual([])
  })

  it('"仍新建"写了理由 → 201，理由与它顶掉的那些条目一起进目录', async () => {
    const { h, catalog } = await withCatalog(SEED)
    const schedules = fakeSchedules()
    h.deps.schedules = schedules
    const res = await h.post('/v1/schedules', {
      title: '每天早上汇总退款单',
      trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      duplicate_ack: { decision: 'new', reason: REASON, similar_to: ['schedule:s1'] },
    })
    expect(res.status).toBe(201)
    expect(schedules.created).toEqual(['每天早上汇总退款单'])
    expect(catalog.notes).toEqual([
      { entry_id: 'schedule:sch_1', reason: REASON, similar_to: ['schedule:s1'] },
    ])
  })

  it('查不到像的就直接建（不打扰人）；没装工具箱也照常建', async () => {
    const { h, catalog } = await withCatalog(SEED)
    const schedules = fakeSchedules()
    h.deps.schedules = schedules
    expect(
      (
        await h.post('/v1/schedules', {
          title: '没人做过的事',
          trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
        })
      ).status,
    ).toBe(201)
    expect(catalog.notes).toEqual([])

    const bare = await harness()
    bare.deps.schedules = fakeSchedules()
    expect(
      (
        await bare.post('/v1/schedules', {
          title: '每天早上汇总退款单',
          trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
        })
      ).status,
    ).toBe(201)
  })
})

describe('40 §2.2 建之前先查：另外四个入口', () => {
  it('流程：同一个定义、同一个对象上再开一条 → 409', async () => {
    const { h } = await withCatalog([
      entry({ id: 'workflow:creator', kind: 'workflow', title: '红人合作' }),
    ])
    const schedules = fakeSchedules()
    h.deps.schedules = schedules
    const res = await h.post('/v1/workflows', { def_id: 'creator', subject: 'creator:c_7' })
    expect(res.status).toBe(409)
    expect(schedules.started).toEqual([])
    const again = await h.post('/v1/workflows', {
      def_id: 'creator',
      subject: 'creator:c_7',
      duplicate_ack: { decision: 'new', reason: REASON, similar_to: ['workflow:creator'] },
    })
    expect(again.status).toBe(201)
    expect(schedules.started).toEqual(['creator'])
  })

  it('流程：subject 写错 400；没装流程引擎 501', async () => {
    const { h } = await withCatalog([])
    h.deps.schedules = fakeSchedules()
    expect((await h.post('/v1/workflows', { def_id: 'creator', subject: 'bad' })).status).toBe(400)
    const bare = await harness()
    expect((await bare.post('/v1/workflows', { def_id: 'x', subject: 'a:b' })).status).toBe(501)
  })

  it('技能副本：第一次给自己开副本要先看公司版（409）；改自己那份不再拦', async () => {
    const { h, catalog } = await withCatalog([
      entry({
        id: 'skill:aftersales-reply',
        kind: 'skill',
        title: 'aftersales-reply',
        layer: 'company',
      }),
    ])
    const ops = [{ op: 'append' as const, section_id: 'sec_1', body: '别用感叹号' }]
    const first = await h.put('/v1/skills/aftersales-reply/overlay', {
      ops,
      base_version: '1.0.0',
      version: 0,
    })
    expect(first.status).toBe(409)
    // 已经有副本的（version > 0）照常改
    const second = await h.put('/v1/skills/aftersales-reply/overlay', {
      ops,
      base_version: '1.0.0',
      version: 2,
    })
    expect(second.status).toBe(200)
    expect(catalog.notes).toEqual([])
    const forced = await h.put('/v1/skills/aftersales-reply/overlay', {
      ops,
      base_version: '1.0.0',
      version: 0,
      duplicate_ack: { decision: 'new', reason: REASON, similar_to: ['skill:aftersales-reply'] },
    })
    expect(forced.status).toBe(200)
    expect(catalog.notes[0]?.entry_id).toBe('skill:aftersales-reply')
  })

  it('定制卡：同一个积木上再钉一张 → 409；建成了就进目录', async () => {
    const { h, catalog } = await withCatalog([])
    const first = await h.post('/v1/blocks/propose', {
      block_id: 'shop.overdue_orders',
      conversation_id: 'conv_1',
    })
    expect(first.status).toBe(201)
    expect(catalog.recorded.map((e) => e.kind)).toEqual(['custom_card'])
    // 目录里有了同名的这张卡，再钉一次就该问一句
    catalog.entries.push(...catalog.recorded)
    const again = await h.post('/v1/blocks/propose', {
      block_id: 'shop.overdue_orders',
      conversation_id: 'conv_2',
    })
    expect(again.status).toBe(409)
  })

  it('定制卡：没注册的积木 id → 拒（29 原则 ①）', async () => {
    const { h } = await withCatalog([])
    const res = await h.post('/v1/blocks/propose', {
      block_id: 'nope.not_registered',
      conversation_id: 'conv_1',
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('40 §2.2 建之前先查：指导里的 global_rule', () => {
  const RULE = '以后一律不给运费补偿'

  it('公司里已经有一条差不多的规矩 → 409，且那张卡的决定没有先落下去', async () => {
    const { h } = await withCatalog([entry({ id: 'rule:r1', kind: 'rule', title: RULE })])
    const res = await h.post(`/v1/approvals/${h.item.id}/decide`, {
      action: 'instruct',
      instruction: { scope: 'global_rule', text: RULE },
    })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('similar_exists')
    // 查重在 decide 之前：卡还停在原来的状态
    expect(h.approvals.items.get(h.item.id)?.state).toBe('pending')
  })

  it('"仍新建"写了理由 → 照常落 policy_change，规矩与理由都进目录', async () => {
    const { h, catalog } = await withCatalog([entry({ id: 'rule:r1', kind: 'rule', title: RULE })])
    const res = await h.post(`/v1/approvals/${h.item.id}/decide`, {
      action: 'instruct',
      instruction: { scope: 'global_rule', text: RULE },
      duplicate_ack: { decision: 'new', reason: REASON, similar_to: ['rule:r1'] },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.instruction_proposal.kind).toBe('policy_change')
    expect(catalog.recorded.map((e) => e.kind)).toEqual(['rule'])
    expect(catalog.notes[0]?.reason).toBe(REASON)
  })

  it('similar_cases 不走规矩这条路（它进的是学习回路）', async () => {
    const { h, catalog } = await withCatalog([entry({ id: 'rule:r1', kind: 'rule', title: RULE })])
    const res = await h.post(`/v1/approvals/${h.item.id}/decide`, {
      action: 'instruct',
      instruction: { scope: 'similar_cases', text: RULE },
    })
    expect(res.status).toBe(200)
    expect(catalog.recorded).toEqual([])
  })
})
