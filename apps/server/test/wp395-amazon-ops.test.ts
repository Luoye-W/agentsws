/**
 * WP395（docs/106 §13 / docs/104 C2）：Amazon 运营岗位只在卖 Amazon 的品牌下出现。
 *
 * - 工作区建好时不种这个岗位（类别目录里有，「我的岗位」里没有）；
 * - 首次设置原话提到 Amazon / 亚马逊 / FBA → 推荐里有亚马逊店铺运营，划分出「Amazon 运营」；
 *   只说独立站 → 一条 Amazon 的都不推（AI 推了也拿掉）；品牌档案看得出卖 Amazon 也算提到；
 * - 只做 Amazon、没客服岗：`amz.support` 挂到 Amazon 运营（A3）；
 * - 照推荐建好之后左栏有它，图标是它自己的。
 */
import type { PositionInstance } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import {
  brandOnAmazon,
  modelSuggester,
  type SuggestCatalogRole,
  suggestPositions,
} from '../src/onboarding-suggest.js'

const CATALOG = [
  {
    id: 'customer-care',
    name: '客服',
    roles: [
      { id: 'dtc.support', default: true },
      { id: 'amz.support', default: true },
    ],
  },
  { id: 'web-ops', name: '网站运营', roles: [{ id: 'dtc.store', default: true }] },
  {
    id: 'amazon-ops',
    name: 'Amazon 运营',
    roles: [
      { id: 'amz.store', default: true },
      { id: 'amz.support', default: false },
    ],
  },
]
const ROLES: SuggestCatalogRole[] = [
  {
    id: 'dtc.support',
    name: '网站客服',
    category_id: 'customer-care',
    category: '客服',
    what_it_does: '客服邮箱',
    default: true,
  },
  {
    id: 'amz.support',
    name: 'Amazon 客服',
    category_id: 'customer-care',
    category: '客服',
    what_it_does: '买家消息',
    default: true,
  },
  {
    id: 'dtc.store',
    name: '店铺管理',
    category_id: 'web-ops',
    category: '网站运营',
    what_it_does: '独立站商品与价格',
    default: true,
  },
  {
    id: 'amz.store',
    name: '亚马逊店铺运营',
    category_id: 'amazon-ops',
    category: 'Amazon 运营',
    what_it_does: 'Listing、库存、评价',
    default: true,
  },
]

const suggest = (text: string, extra: Partial<Parameters<typeof suggestPositions>[0]> = {}) =>
  suggestPositions({ text, catalog: CATALOG, roles: ROLES, suggester: undefined, ...extra })

describe('按词对（没接模型时）', () => {
  it('「我们在 Amazon 美国站卖电动自行车」→ 推亚马逊店铺运营，划分出 Amazon 运营', async () => {
    const out = await suggest('我们在 Amazon 美国站卖电动自行车')
    expect(out.source).toBe('keyword')
    expect(out.roles.map((r) => r.role_id)).toEqual(['amz.store'])
    expect(out.positions).toEqual([
      { name: 'Amazon 运营', role_ids: ['amz.store'], template_id: 'amazon-ops' },
    ])
  })

  it('「亚马逊」「FBA」也认', async () => {
    expect((await suggest('我们主要在亚马逊卖')).roles.map((r) => r.role_id)).toContain('amz.store')
    expect((await suggest('货都发 FBA')).roles.map((r) => r.role_id)).toContain('amz.store')
  })

  it('只说独立站 / listing → 一条 Amazon 的都不推', async () => {
    const out = await suggest('我们做独立站，listing 要优化')
    expect(out.roles.some((r) => r.role_id.startsWith('amz.'))).toBe(false)
  })

  it('原话没提、品牌档案看得出卖 Amazon → 也推', async () => {
    const out = await suggest('我们卖电动自行车，要有人管店', { brand_on_amazon: true })
    expect(out.roles.map((r) => r.role_id)).toContain('amz.store')
  })
})

describe('AI 推回来的也过这一道', () => {
  const reply = JSON.stringify({
    r: [
      ['amz.store', '管 Amazon 店', 'Amazon'],
      ['amz.support', '回买家消息', '买家'],
    ],
  })

  it('原话没提 Amazon → AI 推的 Amazon 职责拿掉', async () => {
    const out = await suggest('我们做独立站，买家消息也多', {
      suggester: modelSuggester(async () => reply),
    })
    expect(out.roles).toEqual([])
  })

  it('只做 Amazon、没客服岗 → amz.support 跟着进 Amazon 运营（A3）', async () => {
    const out = await suggest('只在 Amazon 上卖，买家消息我自己回', {
      suggester: modelSuggester(async () => reply),
    })
    expect(out.positions).toEqual([
      { name: 'Amazon 运营', role_ids: ['amz.store', 'amz.support'], template_id: 'amazon-ops' },
    ])
  })

  it('AI 自己分了「Amazon 运营」= 两条：认得出是 Amazon 运营那个模板', async () => {
    const out = await suggest('只在 Amazon 上卖', {
      suggester: modelSuggester(async () =>
        JSON.stringify({
          r: [
            ['amz.store', '管店', 'Amazon'],
            ['amz.support', '回消息', 'Amazon'],
          ],
          p: [['Amazon 运营', ['amz.store', 'amz.support']]],
        }),
      ),
    })
    expect(out.positions[0]?.template_id).toBe('amazon-ops')
  })
})

describe('品牌档案看不看得出卖 Amazon', () => {
  it('市场从 Amazon 读出来 / 一句话介绍提到 → 是；别的 → 不猜', () => {
    expect(brandOnAmazon({ markets_source: { from: 'amazon' } })).toBe(true)
    expect(brandOnAmazon({ one_liner: '亚马逊上卖电动自行车' })).toBe(true)
    expect(brandOnAmazon({ markets_source: { from: 'site' }, one_liner: '独立站' })).toBe(false)
    expect(brandOnAmazon(undefined)).toBe(false)
  })
})

/* ── 真装配线 ─────────────────────────────────────────────────────── */

let server: Server

const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}
const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}
const mine = async (): Promise<PositionInstance[]> =>
  (await dataOf<{ instances?: PositionInstance[] }>(await call('GET', '/v1/positions')))
    .instances ?? []

interface SuggestView {
  source: string
  roles: { role_id: string }[]
  positions: { name: string; role_ids: string[]; template_id?: string }[]
}

describe('真装配线：卖 Amazon 的品牌才有 Amazon 运营', () => {
  beforeEach(async () => {
    server = await createServer({ quiet: true, tokenRefreshIntervalMs: 0, scheduleIntervalMs: 0 })
  })
  afterEach(async () => {
    await server.close()
  })

  it('工作区建好时没有这个岗位；类别目录里有', async () => {
    expect(server.org.positions().some((p) => p.id === 'amazon-ops')).toBe(false)
    const cats = await dataOf<{ id: string; roles: { id: string; default: boolean }[] }[]>(
      await call('GET', '/v1/onboarding/positions'),
    )
    expect(cats.find((c) => c.id === 'amazon-ops')?.roles.map((r) => [r.id, r.default])).toEqual([
      ['amz.store', true],
      ['amz.support', false],
    ])
  })

  it('原话写「我们在 Amazon 美国站卖电动自行车」→ 推出来 → 建好后左栏有它', async () => {
    const out = await dataOf<SuggestView>(
      await call('POST', '/v1/onboarding/suggest', { text: '我们在 Amazon 美国站卖电动自行车' }),
    )
    expect(out.roles.map((r) => r.role_id)).toContain('amz.store')
    const plan = out.positions.find((p) => p.template_id === 'amazon-ops')
    expect(plan?.role_ids).toEqual(['amz.store'])
    await call('POST', '/v1/onboarding/apply', {
      position_ids: [],
      role_ids: [],
      positions: [plan],
    })
    const list = await mine()
    const amazon = list.find((p) => p.position_id === 'amazon-ops')
    expect(amazon?.name.zh).toBe('Amazon 运营')
    expect(amazon?.icon).toBe('amazon-ops')
    expect(
      amazon?.roles.filter((r) => r.my_assignment_id !== undefined).map((r) => r.role_id),
    ).toEqual(['amz.store'])
  })

  it('只写「我们做独立站」→ 推荐里没有 Amazon 运营', async () => {
    const out = await dataOf<SuggestView>(
      await call('POST', '/v1/onboarding/suggest', { text: '我们做独立站' }),
    )
    expect(out.roles.some((r) => r.role_id.startsWith('amz.'))).toBe(false)
    expect(out.positions.some((p) => p.template_id === 'amazon-ops')).toBe(false)
  })
})
