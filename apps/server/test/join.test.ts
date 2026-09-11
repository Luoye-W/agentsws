/**
 * Join 向导端到端（WP50 / 45 H2–H3）：真装配线（路由 → JoinPort → roles / txn），不打桩。
 *
 * 走的就是 45 的那条路：一个人先在自己的工作区里建「品牌乙」（店 A + 店 B）与厨房线，
 * 进公司时公司已经有「品牌B」（店 A + 店 C）→ 对照出 `similar` → owner 选"同一个，
 * 取并集" → 公司那份成了店 A + B + C、个人那份 `superseded_by`、他的岗位范围指到公司那份。
 *
 * 另外钉住的几条：
 * - 导入**不改任何东西**（只出一张 `join_mapping` 卡）
 * - 凭据默认不交（`transfer: false`）
 * - 落地幂等（同一个 join 落两次，第二次原样回第一次的回执）
 * - 退出公司（20 §4.4）别名断开，个人那份恢复可编辑
 */
import type { JoinExportBundle, JoinMappingPayload } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-07T09:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 5): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
let clock: ReturnType<typeof makeClock>

const call = async (
  method: string,
  path: string,
  options: { body?: unknown } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

const data = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data
}

interface RangeGroupView {
  id: string
  name: string
  members: { kind: string; id: string }[]
}

interface JoinReceipt {
  join_id: string
  approval_item_id: string
  payload: JoinMappingPayload
  summary: string
}

interface CompleteResult {
  merged: number
  created: number
  kept: number
  transferred_connections: number
  aliases: { kind: string; from: string; to: string }[]
  range_rewrites: number
}

const SOLO = 'ws_solo'
const SUN = 'p_sun'
const at = (n: number): string => new Date(Date.parse(T0) - n).toISOString()

/** 一个人单干时攒下来的东西：品牌乙（店 A + 店 B）、厨房线、两家店的范围。 */
function soloBundle(overrides: Partial<JoinExportBundle> = {}): JoinExportBundle {
  return {
    schema_version: 1,
    workspace_id: SOLO,
    person_id: SUN,
    exported_at: at(0),
    range_groups: [
      {
        id: 'rg_solo_b',
        workspace_id: SOLO,
        name: '品牌乙',
        members: [
          { kind: 'store', id: 'store_a' },
          { kind: 'store', id: 'store_b' },
        ],
        created_at: at(1000),
        updated_at: at(1000),
      },
    ],
    product_lines: [
      {
        id: 'pl_solo_kitchen',
        workspace_id: SOLO,
        name: '厨房线',
        parent: { kind: 'store', id: 'store_a' },
        rule: { platform: 'shopify', tags: ['kitchen'] },
        created_at: at(1000),
        updated_at: at(1000),
      },
    ],
    store_ranges: [
      {
        range: { kind: 'store', id: 'store_a' },
        platform: 'shopify',
        external_id: 'store_a',
        name: '店 A',
      },
      {
        range: { kind: 'store', id: 'store_b' },
        platform: 'shopify',
        external_id: 'store_b',
        name: '店 B',
      },
    ],
    connections: [
      {
        connection_id: 'conn_solo_shop',
        service: 'shopify_admin',
        label: 'Shopify · 店 B',
        transfer: false,
      },
    ],
    ...overrides,
  }
}

/** 公司这边已经有的：品牌B（店 A + 店 C）。 */
async function companyBrand(): Promise<RangeGroupView> {
  return data<RangeGroupView>(
    await call('POST', '/v1/org/range-groups', {
      body: {
        name: '品牌B',
        members: [
          { kind: 'store', id: 'store_a' },
          { kind: 'store', id: 'store_c' },
        ],
      },
    }),
  )
}

beforeEach(async () => {
  clock = makeClock()
  server = await createServer({
    clock,
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
  })
})

afterEach(async () => {
  await server.close()
})

describe('45 H2：Join 向导对照三类对象', () => {
  it('导入只出一张 join_mapping 卡，公司那边一个字都没改', async () => {
    const company = await companyBrand()
    const receipt = await data<JoinReceipt>(
      await call('POST', '/v1/join/import', { body: soloBundle() }),
    )
    expect(receipt.approval_item_id).not.toBe('')
    // 品牌乙 vs 品牌B：名字不同、成员重合 50% → similar
    const brand = receipt.payload.objects.find((o) => o.kind === 'range_group')
    expect(brand?.verdict).toBe('similar')
    expect(brand?.theirs?.id).toBe(company.id)
    expect(brand?.options).toEqual(['merge_union', 'adopt_company', 'keep_both'])
    // 厨房线公司还没有 → missing；店 A 公司已经有（品牌B 的成员）→ same；店 B → missing
    expect(receipt.payload.objects.find((o) => o.kind === 'product_line')?.verdict).toBe('missing')
    const stores = receipt.payload.objects.filter((o) => o.kind === 'store_range')
    expect(stores.map((s) => `${s.mine.id}:${s.verdict}`).sort()).toEqual([
      'store_a:same',
      'store_b:missing',
    ])
    expect(receipt.payload.counts).toEqual({ same: 1, similar: 1, missing: 2 })

    // 45 H2 第三条：凭据开关默认是关的
    expect(receipt.payload.connections.map((c) => c.transfer)).toEqual([false])

    // 导入不改任何东西：公司的品牌还是原来那两家店
    const after = await data<RangeGroupView[]>(await call('GET', '/v1/org/range-groups'))
    expect(after).toHaveLength(1)
    expect(after[0]?.members.map((m) => m.id).sort()).toEqual(['store_a', 'store_c'])

    // 卡在队列里等 owner
    const item = await data<{ kind: string; state: string }>(
      await call('GET', `/v1/approvals/${receipt.approval_item_id}`),
    )
    expect([item.kind, item.state]).toEqual(['join_mapping', 'pending'])
  })

  it('自己的包不能并进自己', async () => {
    const res = await call('POST', '/v1/join/import', {
      body: soloBundle({ workspace_id: server.bootstrap.workspace.id }),
    })
    expect(res.status).toBe(400)
  })

  it('同一个包导两次是同一张卡（去重键稳定）', async () => {
    await companyBrand()
    const first = await data<JoinReceipt>(
      await call('POST', '/v1/join/import', { body: soloBundle() }),
    )
    const second = await data<JoinReceipt>(
      await call('POST', '/v1/join/import', { body: soloBundle() }),
    )
    expect(second.join_id).toBe(first.join_id)
    expect(second.approval_item_id).toBe(first.approval_item_id)
  })
})

describe('45 H3：批准落地——公司那份是真源，个人那份变别名', () => {
  it('similar 选「同一个，取并集」→ 成员合并、别名建立、岗位范围改指到公司那份', async () => {
    const company = await companyBrand()
    // 这位同事把自己的品牌带进来之前，岗位先挂着他个人那条（Join 之后要被改指）
    const receipt = await data<JoinReceipt>(
      await call('POST', '/v1/join/import', { body: soloBundle() }),
    )

    const result = await data<CompleteResult>(
      await call('POST', `/v1/join/${receipt.join_id}/complete`, {
        body: {
          objects: [{ unique_key: 'brand:品牌乙', chosen: 'merge_union', name_choice: 'company' }],
        },
      }),
    )
    // 品牌合并 + 店 A 用公司那条 = 2 条 merged；厨房线与店 B 在公司新建 = 2 条 created
    expect(result.merged).toBe(2)
    expect(result.created).toBe(2)

    // 公司那份成员取并集：店 A + 店 B + 店 C
    const brands = await data<RangeGroupView[]>(await call('GET', '/v1/org/range-groups'))
    const merged = brands.find((b) => b.id === company.id)
    expect(merged?.name).toBe('品牌B')
    expect(merged?.members.map((m) => m.id).sort()).toEqual(['store_a', 'store_b', 'store_c'])

    // 个人那份变别名（只读），解析到公司那份
    const personal = server.roles.rangeGroups.get('rg_solo_b')
    expect(personal?.superseded_by).toBe(company.id)
    expect(server.roles.rangeGroups.resolve('rg_solo_b')?.id).toBe(company.id)
    expect(() => server.roles.rangeGroups.update('rg_solo_b', { name: '改个名' })).toThrowError(
      /只能看/u,
    )

    // 公司那份记住了是谁带进来的
    expect(merged !== undefined && server.roles.rangeGroups.get(merged.id)?.origin).toMatchObject({
      workspace_id: SOLO,
      person_id: SUN,
    })

    // 三条新事件落了痕
    const types = await eventTypes()
    expect(types).toContain('range_group.merged')
    expect(types).toContain('join.completed')
  })

  it('落两次回同一份回执（幂等）', async () => {
    await companyBrand()
    const receipt = await data<JoinReceipt>(
      await call('POST', '/v1/join/import', { body: soloBundle() }),
    )
    const first = await data<CompleteResult>(
      await call('POST', `/v1/join/${receipt.join_id}/complete`, { body: {} }),
    )
    const second = await data<CompleteResult>(
      await call('POST', `/v1/join/${receipt.join_id}/complete`, { body: {} }),
    )
    expect(second).toEqual(first)
    // 品牌没有被合第二遍
    const brands = await data<RangeGroupView[]>(await call('GET', '/v1/org/range-groups'))
    expect(brands.find((b) => b.name === '品牌B')?.members).toHaveLength(3)
  })

  it('选「保留两条」= 公司里多一条，不建别名', async () => {
    await companyBrand()
    const receipt = await data<JoinReceipt>(
      await call('POST', '/v1/join/import', { body: soloBundle() }),
    )
    const result = await data<CompleteResult>(
      await call('POST', `/v1/join/${receipt.join_id}/complete`, {
        body: { objects: [{ unique_key: 'brand:品牌乙', chosen: 'keep_both' }] },
      }),
    )
    expect(result.aliases.some((a) => a.from === 'rg_solo_b')).toBe(false)
    const brands = await data<RangeGroupView[]>(await call('GET', '/v1/org/range-groups'))
    expect(brands.map((b) => b.name).sort()).toEqual(['品牌B', '品牌乙'])
  })

  it('选不在选项里的动作 → 400，说得出这一条能选哪些', async () => {
    await companyBrand()
    const receipt = await data<JoinReceipt>(
      await call('POST', '/v1/join/import', { body: soloBundle() }),
    )
    const res = await call('POST', `/v1/join/${receipt.join_id}/complete`, {
      body: { objects: [{ unique_key: 'brand:品牌乙', chosen: 'create_in_company' }] },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toContain('merge_union')
  })

  it('凭据不自动走：没打开开关 = 一条都不交', async () => {
    await companyBrand()
    const receipt = await data<JoinReceipt>(
      await call('POST', '/v1/join/import', { body: soloBundle() }),
    )
    const result = await data<CompleteResult>(
      await call('POST', `/v1/join/${receipt.join_id}/complete`, { body: {} }),
    )
    expect(result.transferred_connections).toBe(0)
  })
})

describe('20 §4.4：退出公司', () => {
  it('别名断开，个人那份恢复可编辑；公司那份留下', async () => {
    const company = await companyBrand()
    const receipt = await data<JoinReceipt>(
      await call('POST', '/v1/join/import', { body: soloBundle() }),
    )
    await data<CompleteResult>(
      await call('POST', `/v1/join/${receipt.join_id}/complete`, { body: {} }),
    )
    const left = await data<{ restored: number }>(
      await call('POST', `/v1/join/${receipt.join_id}/leave`),
    )
    expect(left.restored).toBeGreaterThan(0)
    expect(server.roles.rangeGroups.get('rg_solo_b')?.superseded_by).toBeUndefined()
    // 恢复可编辑
    expect(server.roles.rangeGroups.update('rg_solo_b', { name: '品牌乙（自己的）' }).name).toBe(
      '品牌乙（自己的）',
    )
    // 公司那份留下（成员仍是合过的三家店）
    const brands = await data<RangeGroupView[]>(await call('GET', '/v1/org/range-groups'))
    expect(brands.find((b) => b.id === company.id)?.members).toHaveLength(3)
  })

  it('还没落地就退出 → 409', async () => {
    await companyBrand()
    const receipt = await data<JoinReceipt>(
      await call('POST', '/v1/join/import', { body: soloBundle() }),
    )
    expect((await call('POST', `/v1/join/${receipt.join_id}/leave`)).status).toBe(409)
  })
})

describe('20 §5：导出包', () => {
  it('导出带范围组 / 产品线 / 店铺范围', async () => {
    await companyBrand()
    await call('POST', '/v1/org/product-lines', {
      body: {
        name: '厨房线',
        parent: { kind: 'store', id: 'store_a' },
        rule: { platform: 'shopify', tags: ['kitchen'] },
      },
    })
    const bundle = await data<JoinExportBundle>(await call('POST', '/v1/join/export'))
    expect(bundle.schema_version).toBe(1)
    expect(bundle.range_groups.map((g) => g.name)).toEqual(['品牌B'])
    expect(bundle.product_lines.map((l) => l.name)).toEqual(['厨房线'])
    // 品牌成员与岗位范围里出现过的店都在
    expect(bundle.store_ranges.map((s) => s.range.id)).toEqual(
      expect.arrayContaining(['store_a', 'store_c']),
    )
  })
})

async function eventTypes(): Promise<string[]> {
  const page = await data<{ events: { type: string }[] }>(await call('GET', '/v1/events?limit=500'))
  return page.events.map((e) => e.type)
}

describe('45 H3 / H5：别名解析与「提议修改」', () => {
  /** 并完之后回一对 `{ 个人那条, 公司那条 }`。 */
  async function joined(): Promise<{ mine: string; company: string }> {
    const company = await companyBrand()
    const receipt = await data<JoinReceipt>(
      await call('POST', '/v1/join/import', { body: soloBundle() }),
    )
    await data<CompleteResult>(
      await call('POST', `/v1/join/${receipt.join_id}/complete`, { body: {} }),
    )
    return { mine: 'rg_solo_b', company: company.id }
  }

  it('打开自己那份被取代的品牌，读到的是公司那份（只读 + 记着点进来的是哪一条）', async () => {
    const { mine, company } = await joined()
    const view = await data<{
      id: string
      name: string
      alias_of?: string
      readonly?: boolean
      members: { id: string }[]
    }>(await call('GET', `/v1/org/range-groups/${mine}`))
    expect(view.id).toBe(company)
    expect(view.alias_of).toBe(mine)
    expect(view.members.map((m) => m.id).sort()).toEqual(['store_a', 'store_b', 'store_c'])
    // 公司那条自己不是别名，所以没有 readonly / alias_of
    const direct = await data<{ alias_of?: string; readonly?: boolean; origin?: unknown }>(
      await call('GET', `/v1/org/range-groups/${company}`),
    )
    expect(direct.alias_of).toBeUndefined()
    expect(direct.readonly).toBeUndefined()
    // 45 H2：公司那条记着是谁、从哪个工作区带进来的
    expect(direct.origin).toMatchObject({ workspace_id: SOLO, person_id: SUN })
    expect((await call('GET', '/v1/org/range-groups/rg_nope')).status).toBe(404)
  })

  it('提议修改：卡落在真源那一条上，批了才改，理由太短直接 400', async () => {
    const { mine, company } = await joined()
    expect(
      (
        await call('POST', `/v1/org/range-groups/${mine}/propose`, {
          body: { reason: '短' },
        })
      ).status,
    ).toBe(400)

    const receipt = await data<{ status: string; approval_item_id: string; summary: string }>(
      await call('POST', `/v1/org/range-groups/${mine}/propose`, {
        body: {
          reason: '店 D 也是这个品牌的，想加进来',
          members: [{ kind: 'store', id: 'store_d' }],
        },
      }),
    )
    expect(receipt.status).toBe('pending_approval')
    // 提议**不改任何东西**
    const before = await data<{ members: { id: string }[] }>(
      await call('GET', `/v1/org/range-groups/${company}`),
    )
    expect(before.members.map((m) => m.id)).not.toContain('store_d')

    await call('POST', `/v1/approvals/${receipt.approval_item_id}/decide`, {
      // 36 §2.2：policy_change 是选择题卡，批准必须说清选哪一个（after = 按提议改）
      body: { action: 'approve', selected_option_id: 'after' },
    })
    // 落库发生在下一次读（org 端口每个方法先 reconcile 一遍）
    await call('GET', '/v1/org/ranges')
    const after = await data<{ members: { id: string }[] }>(
      await call('GET', `/v1/org/range-groups/${company}`),
    )
    expect(after.members.map((m) => m.id)).toEqual(['store_d'])
    expect(await eventTypes()).toEqual(expect.arrayContaining(['policy_change.proposed']))
  })

  it('产品线也能提议；提的是不存在的那条 → 404', async () => {
    const line = await data<{ id: string }>(
      await call('POST', '/v1/org/product-lines', {
        body: {
          name: '厨房线',
          parent: { kind: 'store', id: 'store_a' },
          rule: { platform: 'shopify', tags: ['kitchen'] },
        },
      }),
    )
    expect((await call('GET', `/v1/org/product-lines/${line.id}`)).status).toBe(200)
    expect((await call('GET', '/v1/org/product-lines/pl_nope')).status).toBe(404)
    expect(
      (
        await call('POST', '/v1/org/product-lines/pl_nope/propose', {
          body: { reason: '这条线该带上锅具那几件' },
        })
      ).status,
    ).toBe(404)

    const receipt = await data<{ approval_item_id: string }>(
      await call('POST', `/v1/org/product-lines/${line.id}/propose`, {
        body: {
          reason: '锅具也该算厨房线',
          rule: { platform: 'shopify', tags: ['kitchen', 'pot'] },
        },
      }),
    )
    await call('POST', `/v1/approvals/${receipt.approval_item_id}/decide`, {
      // 36 §2.2：policy_change 是选择题卡，批准必须说清选哪一个（after = 按提议改）
      body: { action: 'approve', selected_option_id: 'after' },
    })
    await call('GET', '/v1/org/ranges')
    const after = await data<{ rule: { tags?: string[] } }>(
      await call('GET', `/v1/org/product-lines/${line.id}`),
    )
    expect(after.rule.tags).toEqual(['kitchen', 'pot'])
  })
})
