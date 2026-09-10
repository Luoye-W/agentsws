/**
 * 40 §2 工具箱与查重，端到端跑在真服务进程上：
 *
 * 建一条定时任务 → 再建一条差不多的 → **409 不直接建** → "仍新建"没写理由 400 →
 * 写了理由 201 且理由进目录 → 工具箱里两条都看得见、疑似重复成对 →
 * 一键合并出一张 policy_change 卡 → 批准后留下的那条升层、并掉的那条指向它。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCatalogIndex } from '../src/catalog-index.js'
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

function seeded(seed = 11): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface CatalogEntryRow {
  id: string
  kind: string
  title: string
  owner: string
  layer: string
  used_by_positions: string[]
  runs_30d: number
  reason_for_duplicate?: string
  superseded_by?: string
}

let server: Server
let url: string

const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}

const post = (path: string, body: unknown): Promise<Response> =>
  api(path, { method: 'POST', body: JSON.stringify(body) })

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const CRON = { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' } as const
const REASON = '我这条只看退货窗口内的单，口径跟他那条不一样'

beforeEach(async () => {
  const clock = makeClock()
  server = await createServer({
    quiet: true,
    clock: { now: () => clock.now() },
    random: seeded(),
    scheduleIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com' },
  })
  url = (await server.listen(0)).url
})

afterEach(async () => {
  await server.close()
})

describe('40 §2.2 建之前先查（真进程）', () => {
  it('第一条直接建；第二条差不多的 → 409 + 候选；没理由 400；有理由 201 且理由进目录', async () => {
    const first = await post('/v1/schedules', { title: '每天早上汇总退款单', trigger: CRON })
    expect(first.status).toBe(201)

    const blocked = await post('/v1/schedules', { title: '早上把退款单汇总一下', trigger: CRON })
    expect(blocked.status).toBe(409)
    const err = (await blocked.json()) as {
      code: string
      details: { candidates: { entry: CatalogEntryRow; reasons: string[] }[] }
    }
    expect(err.code).toBe('similar_exists')
    expect(err.details.candidates[0]?.entry.title).toBe('每天早上汇总退款单')
    expect(err.details.candidates[0]?.reasons.join('')).toContain('触发时机相同')

    const noReason = await post('/v1/schedules', {
      title: '早上把退款单汇总一下',
      trigger: CRON,
      duplicate_ack: { decision: 'new', reason: '不一样' },
    })
    expect(noReason.status).toBe(400)

    const listedBefore = await data<CatalogEntryRow[]>(await api('/v1/catalog?kind=schedule'))
    expect(listedBefore).toHaveLength(1)

    const forced = await post('/v1/schedules', {
      title: '早上把退款单汇总一下',
      trigger: CRON,
      duplicate_ack: {
        decision: 'new',
        reason: REASON,
        similar_to: [err.details.candidates[0]?.entry.id ?? ''],
      },
    })
    expect(forced.status).toBe(201)

    const listed = await data<CatalogEntryRow[]>(await api('/v1/catalog?kind=schedule'))
    expect(listed).toHaveLength(2)
    // 那句理由进了目录，下次别人查得到
    expect(listed.map((e) => e.reason_for_duplicate).filter(Boolean)).toEqual([REASON])
  })

  it('查不到像的就直接建，不打扰人', async () => {
    expect(
      (await post('/v1/schedules', { title: '每天早上汇总退款单', trigger: CRON })).status,
    ).toBe(201)
    expect((await post('/v1/schedules', { title: '每周给红人寄样', trigger: CRON })).status).toBe(
      201,
    )
  })

  it('工具箱列的是整个工作区建过的东西，能按 kind 与用途筛', async () => {
    await post('/v1/schedules', { title: '每天早上汇总退款单', trigger: CRON })
    const all = await data<CatalogEntryRow[]>(await api('/v1/catalog'))
    // 定时任务 + 技能库里那份自带技能
    expect(all.some((e) => e.kind === 'schedule')).toBe(true)
    expect(all.some((e) => e.kind === 'skill')).toBe(true)
    const hit = await data<CatalogEntryRow[]>(await api('/v1/catalog?q=退款'))
    expect(hit.map((e) => e.kind)).toEqual(['schedule'])
    expect((await api('/v1/catalog?kind=lol')).status).toBe(400)
  })
})

describe('40 §2.2 疑似重复与一键合并（真进程）', () => {
  it('两条都在用 → 成对报出来；合并出一张 policy_change 卡，批了才真的合', async () => {
    const a = await data<{ id: string }>(
      await post('/v1/schedules', { title: '每天早上汇总退款单', trigger: CRON }),
    )
    const b = await data<{ id: string }>(
      await post('/v1/schedules', {
        title: '每天早上汇总退款单',
        trigger: CRON,
        duplicate_ack: { decision: 'new', reason: REASON, similar_to: [`schedule:${a.id}`] },
      }),
    )

    const pairs = await data<{ a: CatalogEntryRow; b: CatalogEntryRow; both_in_use: boolean }[]>(
      await api('/v1/catalog/duplicates'),
    )
    expect(pairs).toHaveLength(1)
    // 两条都挂在岗位上 → 都算"在用"
    expect(pairs[0]?.both_in_use).toBe(true)

    const merged = await data<{ approval_item_id: string }>(
      await post('/v1/catalog/merge', { keep: `schedule:${a.id}`, drop: `schedule:${b.id}` }),
    )
    // 只出卡，不合并
    const stillTwo = await data<CatalogEntryRow[]>(await api('/v1/catalog?kind=schedule'))
    expect(stillTwo).toHaveLength(2)

    const card = await data<ApprovalItem>(await api(`/v1/approvals/${merged.approval_item_id}`))
    expect(card.kind).toBe('policy_change')

    const decided = await post(`/v1/approvals/${merged.approval_item_id}/decide`, {
      action: 'approve',
    })
    expect(decided.status).toBe(200)

    // 批了之后：留下的那条升到部门层，并掉的那条指向它、不再列在工具箱里
    const after = await data<CatalogEntryRow[]>(await api('/v1/catalog?kind=schedule'))
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(`schedule:${a.id}`)
    expect(after[0]?.layer).toBe('dept')
    const withHidden = await data<CatalogEntryRow[]>(await api('/v1/catalog/duplicates'))
    expect(withHidden).toEqual([])
  })

  it('合并两条同一个 id → 400；目录里没有的 → 404', async () => {
    expect((await post('/v1/catalog/merge', { keep: 'x', drop: 'x' })).status).toBe(400)
    expect((await post('/v1/catalog/merge', { keep: 'x', drop: 'y' })).status).toBe(404)
  })
})

/* ------------------------------------------------------------------ */
/* 好东西往上浮：出卡 → 批准 → 升层 + 个人副本指过去                       */
/* ------------------------------------------------------------------ */

describe('40 §2.2 第 3 条 往上浮', () => {
  const WS = 'ws_promo'
  const clock = { now: () => T0 }

  /** 只留 create / decide 两件事的假总线。 */
  function fakeBus() {
    const items = new Map<string, ApprovalItem>()
    let seq = 0
    return {
      items,
      create: (input: Record<string, unknown>) => {
        seq += 1
        const item = { ...input, id: `ap_${seq}`, state: 'pending' } as unknown as ApprovalItem
        items.set(item.id, item)
        return Promise.resolve(item)
      },
      decide: (id: string) => {
        const item = items.get(id)
        if (item === undefined) throw new Error('no item')
        const out = { ...item, state: 'approved' } as ApprovalItem
        items.set(id, out)
        return Promise.resolve(out)
      },
    }
  }

  it('两个岗位在用、跑得多、没人说不合用 → 出一张卡；批了才升层', async () => {
    const assembly = createCatalogIndex({ workspace_id: WS, clock })
    assembly.index.record({
      kind: 'schedule',
      id: 'schedule:s1',
      title: '每天早上汇总退款单',
      summary: '',
      owner: 'p_li',
      layer: 'personal',
      used_by_positions: ['asg_a', 'asg_b'],
      runs_30d: 30,
      workspace_id: WS,
    })
    const bus = fakeBus()
    const wrapped = assembly.wrap(bus as never)
    const out = await assembly.proposePromotions({
      approvals: wrapped,
      owner: 'p_li',
      role_id: 'common.owner',
    })
    expect(out.created).toHaveLength(1)
    // 只出卡，不落层
    expect((await assembly.index.entries(WS))[0]?.layer).toBe('personal')

    await wrapped.decide(out.created[0] ?? '', 'p_li', { action: 'approve' } as never)
    expect((await assembly.index.entries(WS))[0]?.layer).toBe('dept')
    assembly.close()
  })

  it('挂着两个岗位但从来没跑过 → 过不了 Wilson，不出卡', async () => {
    const assembly = createCatalogIndex({ workspace_id: WS, clock })
    assembly.index.record({
      kind: 'schedule',
      id: 'schedule:s2',
      title: '没人用的那条',
      summary: '',
      owner: 'p_li',
      layer: 'personal',
      used_by_positions: ['asg_a', 'asg_b'],
      runs_30d: 0,
      workspace_id: WS,
    })
    const bus = fakeBus()
    const out = await assembly.proposePromotions({
      approvals: assembly.wrap(bus as never),
      owner: 'p_li',
      role_id: 'common.owner',
    })
    expect(out.created).toEqual([])
    expect(bus.items.size).toBe(0)
    assembly.close()
  })
})
