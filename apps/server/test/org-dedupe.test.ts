/**
 * 45 H4「建之前先查」端到端（WP50）：查重入口从五个变八个。
 *
 * 40 §2.2 原来的五个入口判的是词袋 + 触发器；这三类组织对象判的是**唯一键**
 * （品牌名归一化 / 产品线的父范围 + 判据 / 店铺域名），所以另有一个 `guardOrgSimilar`，
 * 但形状与那五个一模一样：查到像的不建，回 409 + 候选 + 两个选项，
 * 选"仍新建"要写一句为什么。
 *
 * 钉五条：
 * 1. 同名品牌 → 409，消息里说得出"谁建的、几个岗位挂着"；
 * 2. 带上够长的理由 → 建得出来，那句话进了事件日志；
 * 3. 理由太短 → 400（不是 409：这次是他自己没写够）；
 * 4. 查重路由只读——问一百遍公司里也不多一条；
 * 5. 被取代的那份不参与查重（它是别名，不是第二份）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

let server: Server

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

interface Hit {
  id: string
  name: string
  verdict: string
  holders: number
  created_by?: string
  created_by_name?: string
  reasons: string[]
}

const brand = (name: string, members: string[], body: Record<string, unknown> = {}) =>
  call('POST', '/v1/org/range-groups', {
    body: { name, members: members.map((id) => ({ kind: 'store', id })), ...body },
  })

beforeEach(async () => {
  server = await createServer({ quiet: true, startRun: false, tokenRefreshIntervalMs: 0 })
})

afterEach(async () => {
  await server.close()
})

describe('45 H4：建品牌之前先查', () => {
  it('同名的第二个品牌 → 409，说得出已有那条是谁建的、几个岗位挂着', async () => {
    expect((await brand('品牌乙', ['store_a'])).status).toBe(201)
    const res = await brand('品牌 乙', ['store_b'])
    expect(res.status).toBe(409)
    const err = (await res.json()) as {
      code: string
      message: string
      details: { candidates: Hit[]; options: { id: string }[] }
    }
    expect(err.code).toBe('similar_exists')
    expect(err.message).toContain('已有「品牌乙」')
    expect(err.message).toContain('直接用它')
    expect(err.details.candidates[0]?.verdict).toBe('same')
    expect(err.details.candidates[0]?.created_by_name).toBe(server.bootstrap.person.name)
    expect(err.details.options.map((o) => o.id)).toEqual(['reuse', 'new'])
    // 一条都没建
    const all = await data<{ id: string }[]>(await call('GET', '/v1/org/range-groups'))
    expect(all).toHaveLength(1)
  })

  it('成员大半重合但名字不同 → 也拦（similar），理由说得出重合在哪', async () => {
    await brand('品牌B', ['store_a', 'store_c'])
    const res = await brand('品牌乙', ['store_a', 'store_b'])
    expect(res.status).toBe(409)
    const err = (await res.json()) as { details: { candidates: Hit[] } }
    expect(err.details.candidates[0]?.verdict).toBe('similar')
    expect(err.details.candidates[0]?.reasons.join('')).toContain('成员重合')
  })

  it('写够一句为什么就建得出来，那句话进事件日志', async () => {
    await brand('品牌乙', ['store_a'])
    expect(
      (
        await brand('品牌 乙', ['store_b'], {
          duplicate_ack: { decision: 'new', reason: '短' },
        })
      ).status,
    ).toBe(400)
    const ok = await brand('品牌 乙', ['store_b'], {
      duplicate_ack: {
        decision: 'new',
        reason: '这是欧洲那个同名的牌子，不是一个东西',
        similar_to: ['rg_x'],
      },
    })
    expect(ok.status).toBe(201)
    const page = await data<{ events: { type: string; payload: Record<string, unknown> }[] }>(
      await call('GET', '/v1/events?limit=500'),
    )
    const created = page.events.filter((e) => e.type === 'range_group.created')
    expect(created.at(-1)?.payload.duplicate_reason).toBe('这是欧洲那个同名的牌子，不是一个东西')
  })

  it('查重路由只读：问一百遍也不多一条；三类都问得出来', async () => {
    const made = await data<{ id: string }>(await brand('品牌乙', ['glass-bowl.myshopify.com']))
    for (let i = 0; i < 3; i += 1) {
      const hits = await data<Hit[]>(
        await call('POST', '/v1/org/duplicate-check', {
          body: { kind: 'range_group', name: '品牌乙' },
        }),
      )
      expect(hits.map((h) => h.id)).toEqual([made.id])
    }
    expect(await data<{ id: string }[]>(await call('GET', '/v1/org/range-groups'))).toHaveLength(1)

    // 店铺范围：公司认得的店是从岗位范围与品牌成员里推出来的；域名怎么写都指同一家
    const store = await data<Hit[]>(
      await call('POST', '/v1/org/duplicate-check', {
        body: {
          kind: 'store_range',
          name: 'Glass-Bowl.MyShopify.com/',
          platform: 'shopify',
          external_id: 'https://Glass-Bowl.MyShopify.com/products',
        },
      }),
    )
    expect(store.map((h) => h.id)).toEqual(['glass-bowl.myshopify.com'])

    // 产品线：父范围 + 判据是道门，缺一格直接 400
    await call('POST', '/v1/org/product-lines', {
      body: {
        name: '厨房线',
        parent: { kind: 'store', id: 'store_a' },
        rule: { platform: 'shopify', tags: ['kitchen'] },
      },
    })
    const line = await data<Hit[]>(
      await call('POST', '/v1/org/duplicate-check', {
        body: {
          kind: 'product_line',
          name: '厨房那条',
          parent: { kind: 'store', id: 'store_a' },
          rule: { platform: 'shopify', tags: ['KITCHEN'] },
        },
      }),
    )
    expect(line[0]?.name).toBe('厨房线')
    expect(line[0]?.verdict).toBe('same')
    expect(
      (
        await call('POST', '/v1/org/duplicate-check', {
          body: { kind: 'product_line', name: '缺了判据' },
        })
      ).status,
    ).toBe(400)
  })

  it('被取代的那份不参与查重：它是别名，不是第二份', async () => {
    const first = await data<{ id: string }>(await brand('品牌乙', ['store_a']))
    const second = await data<{ id: string }>(
      await brand('品牌丙', ['store_x'], {
        duplicate_ack: { decision: 'new', reason: '这是另一个牌子，不一样' },
      }),
    )
    // 品牌丙并进了品牌乙（45 H3：公司那份是真源，它变别名）
    server.roles.rangeGroups.supersede(second.id, first.id)
    const hits = await data<Hit[]>(
      await call('POST', '/v1/org/duplicate-check', {
        body: { kind: 'range_group', name: '品牌丙' },
      }),
    )
    expect(hits).toEqual([])
    // 换个名字、成员与它一样也不再被它拦——查重看的是还活着的那些
    expect((await brand('品牌丙（新）', ['store_x'])).status).toBe(201)
  })

  it('建同一条产品线（判据大小写不同）→ 409；判据只有重叠 → similar 也拦', async () => {
    const line = (rule: unknown, name: string) =>
      call('POST', '/v1/org/product-lines', {
        body: { name, parent: { kind: 'store', id: 'store_a' }, rule },
      })
    expect((await line({ platform: 'shopify', tags: ['kitchen'] }, '厨房线')).status).toBe(201)
    expect((await line({ platform: 'shopify', tags: ['KITCHEN'] }, '厨房那条')).status).toBe(409)
    expect((await line({ platform: 'shopify', tags: ['kitchen', 'pot'] }, '锅具线')).status).toBe(
      409,
    )
    // 不同平台 = 两条不相干的线，照常建
    expect((await line({ platform: 'amazon', asins: ['B0ABC'] }, '亚马逊厨房')).status).toBe(201)
  })
})

describe('45 H4：建之后——夜里扫一遍，出一张「这两条是同一个吗」', () => {
  /** 绕开界面建两条重复的（并发、脚本、老数据都会这样）。 */
  const sneak = (name: string, members: string[]) =>
    server.roles.rangeGroups.create({
      workspace_id: server.bootstrap.workspace.id,
      name,
      members: members.map((id) => ({ kind: 'store' as const, id })),
      created_by: server.bootstrap.person.id,
    })

  /** 扫出来的卡：从事件日志里捡 id，再按 id 读回来（卡是发给 owner 的，不在"我的"那条道上）。 */
  const cards = async (): Promise<{ id: string; title: string; summary: string }[]> => {
    const page = await data<{ events: { type: string; payload: Record<string, unknown> }[] }>(
      await call('GET', '/v1/events?limit=500'),
    )
    const ids = [
      ...new Set(
        page.events
          .filter(
            (e) => e.type === 'policy_change.proposed' && e.payload.target === 'org_duplicate',
          )
          .map((e) => String(e.payload.approval_item_id)),
      ),
    ]
    const out: { id: string; title: string; summary: string }[] = []
    for (const id of ids)
      out.push(
        await data<{ id: string; title: string; summary: string }>(
          await call('GET', `/v1/approvals/${id}`),
        ),
      )
    return out
  }

  it('扫出一对 → 一张卡；owner 批了 → 下一轮真的合，岗位范围跟着改指', async () => {
    const ws = server.bootstrap.workspace.id
    const me = server.bootstrap.person.id
    const one = sneak('品牌乙', ['store_a'])
    const two = sneak('品牌 乙 ', ['store_b'])
    // 两条各有一个岗位挂着：合完之后挂着"被并掉那条"的那个岗位必须被改指
    server.roles.assignments.update(server.bootstrap.ownerAssignment.id, {
      range_groups: [one.id],
    })
    server.roles.assignments.create({
      person_id: 'per_two',
      workspace_id: ws,
      role_id: 'common.member',
      granted_by: me,
      range_groups: [two.id],
    })

    const first = await server.orgDuplicates.run()
    expect(first).toMatchObject({ asked: 1, merged: 0 })
    const [card] = await cards()
    expect(card?.summary).toContain('品牌乙')
    expect(card?.summary).toContain('名字归一化后一样')

    // 45 §4：只出卡，一个字都没合
    expect(server.roles.rangeGroups.get(one.id)?.superseded_by).toBeUndefined()
    expect(server.roles.rangeGroups.get(two.id)?.superseded_by).toBeUndefined()

    const decided = await call('POST', `/v1/approvals/${card?.id}/decide`, {
      body: { action: 'approve', selected_option_id: 'merge' },
    })
    expect(decided.status).toBe(200)
    const second = await server.orgDuplicates.run()
    expect(second).toMatchObject({ asked: 0, merged: 1 })
    // 挂着被并掉那条的岗位被改指了（不改，他的权限就停在一份没人读的副本上）
    expect(second.range_rewrites).toBeGreaterThan(0)

    // 留下的那条取并集，并掉的那条变别名（断得开，所以退得回去）
    const alive = server.roles.rangeGroups
      .list(ws)
      .filter((g) => g.superseded_by === undefined && g.name.includes('乙'))
    expect(alive).toHaveLength(1)
    expect(alive[0]?.members.map((m) => m.id).sort()).toEqual(['store_a', 'store_b'])
    const aliased = [one, two].find((g) => g.id !== alive[0]?.id)
    expect(server.roles.rangeGroups.get(aliased?.id ?? '')?.superseded_by).toBe(alive[0]?.id)
    // 两个岗位现在都挂着留下的那一条，范围是合过的两家店
    for (const a of server.roles.assignments.listByWorkspace(ws, {})) {
      if ((a.range_groups ?? []).length === 0) continue
      expect(a.range_groups).toEqual([alive[0]?.id])
      expect(a.ranges.map((r) => r.id).sort()).toEqual(['store_a', 'store_b'])
    }
    const types = (
      await data<{ events: { type: string }[] }>(await call('GET', '/v1/events?limit=500'))
    ).events.map((e) => e.type)
    expect(types).toEqual(expect.arrayContaining(['range_group.merged', 'range.alias_resolved']))
  })

  it('同一对只出一张卡：扫十遍还是一张，选了"维持现状"也不再问', async () => {
    sneak('品牌乙', ['store_a'])
    sneak('品牌 乙 ', ['store_b'])
    for (let i = 0; i < 10; i += 1) await server.orgDuplicates.run()
    expect(await cards()).toHaveLength(1)

    // 36 §2.2：这是一张选择题卡，光按"批准"不算——得说清选的是哪一个
    const [card] = await cards()
    expect(
      (
        await call('POST', `/v1/approvals/${card?.id}/decide`, {
          body: { action: 'approve' },
        })
      ).status,
    ).toBe(400)
    const kept = await call('POST', `/v1/approvals/${card?.id}/decide`, {
      body: { action: 'approve', selected_option_id: 'keep_both' },
    })
    expect(kept.status).toBe(200)
    const settled = await server.orgDuplicates.run()
    expect(settled).toMatchObject({ asked: 0, merged: 0, kept: 1 })
    // 两条都还在，而且以后不再问
    expect(
      server.roles.rangeGroups
        .list(server.bootstrap.workspace.id)
        .filter((g) => g.superseded_by === undefined && g.name.includes('乙')),
    ).toHaveLength(2)
    await server.orgDuplicates.run()
    expect(await cards()).toHaveLength(1)
  })

  it('没有重复就一张卡都不出；被取代的那份不再参与（不会跟自己的真源配成一对）', async () => {
    sneak('品牌甲', ['store_a'])
    sneak('品牌丙', ['store_x'])
    expect(await server.orgDuplicates.run()).toMatchObject({ asked: 0, merged: 0, kept: 0 })
    expect(await cards()).toHaveLength(0)
  })
})
