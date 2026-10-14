/**
 * WP317（docs/101 §5.1④，决策 559）：素材流水线 `/v1/ads/creative/*`，端到端（起真进程 → 打 HTTP）。
 *
 * 钉三件事：
 *
 * 1. **替身档不编文案**：进程里的模型是替身时，「出新文案」照实说没接上，一条都不写。
 * 2. **投放 → 设计岗批量出图单**：经设计岗那一侧开 `request_design`（L3），单子带着版数；
 *    设计岗出 brief 时按广告那条的额度截（30），图上文字一版一句。
 * 3. **实验记录按品牌存**，重启前后都在这个品牌的广告库里；不是投放职责打不开这一面。
 */
import type { AdCreativeRound, Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-14T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

function seeded(seed = 317): () => number {
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
let url: string
let google: Assignment
let designAds: Assignment
let support: Assignment

const api = async (
  path: string,
  init: RequestInit & { assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? google.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown, assignment?: string): Promise<Response> =>
  api(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(assignment === undefined ? {} : { assignment }),
  })
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const CSV = [
  'Campaign,Ad group,Ad ID,Headline 1,Description 1,Final URL,Impr.,Clicks',
  'PB,Commute,101,Magnetic Power Bank,Snaps on.,https://s.example/a,10000,300',
  'PB,Commute,102,Power on the go,Light.,https://s.example/a,8000,80',
  'PB,Gift,103,Gift idea,Nice.,https://s.example/b,9000,250',
].join('\n')

beforeEach(async () => {
  server = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    random: seeded(),
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  const base = {
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
  }
  google = server.roles.assignments.create({ ...base, role_id: 'ads.google' })
  designAds = server.roles.assignments.create({ ...base, role_id: 'design.ads' })
  support = server.roles.assignments.create({ ...base, role_id: 'dtc.support' })
})

afterEach(async () => {
  await server.close()
})

describe('WP317 素材流水线路由', () => {
  it('导入导出表 → 挑出表现差的；替身档「出新文案」照实说没接上，一条不编', async () => {
    const imp = await data<{
      id: string
      rows: number
      weak: { ad_id: string; verdict: string }[]
    }>(await post('/v1/ads/creative/imports', { platform: 'google', text: CSV }))
    expect(imp.rows).toBe(3)
    expect(imp.weak.filter((w) => w.verdict === 'weak').map((w) => w.ad_id)).toEqual(['102'])
    const res = await post('/v1/ads/creative/rounds', { import_id: imp.id })
    expect(res.status).toBe(201)
    const round = await data<AdCreativeRound>(res)
    expect(round.notes.join(' ')).toContain('没接上')
    expect(round.rewrites[0]?.headlines).toEqual([])
    // 出不了上传表（一条收下的都没有）
    expect((await api(`/v1/ads/creative/rounds/${round.id}/sheet`)).status).toBe(400)
  })

  it('批量出图单走设计岗（L3），带着版数；设计岗出 brief 按广告那条的额度截、图上文字一版一句', async () => {
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    const lines = Array.from({ length: 35 }, (_, i) => `Headline ${i + 1}`)
    brand.ads.saveCreativeRound({
      id: 'adround_t1',
      platform: 'google',
      import_id: 'adimp_none',
      rewrites: [
        {
          ad_id: '102',
          campaign: 'PB',
          ad_group: 'Commute',
          headlines: lines.map((text) => ({
            field: 'headline',
            text,
            chars: text.length,
            limit: 30,
          })),
          descriptions: [],
          rejected: [],
          notes: [],
        },
      ],
      experiments_used: 0,
      notes: [],
      created_at: T0,
    })
    const view = await data<{
      requested: boolean
      request_id: string
      variants: number
      notes: string[]
      staged: { staged: boolean; level?: string }
    }>(await post('/v1/ads/creative/rounds/adround_t1/design', {}))
    expect(view.requested).toBe(true)
    expect(view.variants).toBe(30)
    expect(view.notes.join(' ')).toContain('一单最多 30 版')
    expect(view.staged.level).toBe('L3')

    const req = brand.design.request(view.request_id)
    expect(req).toMatchObject({ duty: 'ads', from_role_id: 'ads.google', variants: 30 })

    // 设计岗那一侧出 brief：没另给版数就用单子上的 30；图上文字一版一句
    const brief = await data<{ brief: { variant_plan: { angle_zh: string }[] } }>(
      await post(`/v1/design/requests/${view.request_id}/brief`, {}, designAds.id),
    )
    expect(brief.brief.variant_plan).toHaveLength(30)
    expect(brief.brief.variant_plan[0]?.angle_zh).toContain('「Headline 1」')
    expect(brief.brief.variant_plan[29]?.angle_zh).toContain('「Headline 30」')
  })

  it('实验记录：记一笔、回填结果、按轮次列出；存在这个品牌的广告库里', async () => {
    const e = await data<{ id: string; round: number; memory_id?: string }>(
      await post('/v1/ads/creative/experiments', {
        hypothesis: '标题带价格点击率更高',
        change: '6 条标题带价格',
        platform: 'google',
      }),
    )
    expect(e.round).toBe(1)
    // 同步进投放岗记忆（docs/54）：记忆面板里看得到这一条，标题带品牌名
    // 真源是这个品牌的投放岗记忆（WP320 起落盘、按品牌分）：实验的 id 就是那条记忆的 id
    expect(e.memory_id).toMatch(/^m:position:/)
    expect(e.id).toBe(e.memory_id)
    const mem = await data<{ entries: { id: string; heading?: string; body: string }[] }>(
      await api(`/v1/memory?tier=position&scope_id=${e.memory_id?.split(':')[2]}`),
    )
    const hit = mem.entries.find((x) => x.id === e.memory_id)
    expect(hit?.heading).toContain('第 1 轮')
    expect(hit?.body).toContain('假设：标题带价格点击率更高')
    const patched = await data<{ result: string }>(
      await api(`/v1/ads/creative/experiments/${encodeURIComponent(e.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ result: 'CTR 2.1% vs 1.4%' }),
      }),
    )
    expect(patched.result).toBe('CTR 2.1% vs 1.4%')
    const list = await data<{ rows: { round: number; result?: string }[] }>(
      await api('/v1/ads/creative/experiments'),
    )
    expect(list.rows).toEqual([expect.objectContaining({ round: 1, result: 'CTR 2.1% vs 1.4%' })])
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    // 广告库里只留索引那一行
    expect(brand.ads.experiments()).toHaveLength(1)
    // 记忆面板里那一条也跟着回填了结果
    const after = await data<{ entries: { id: string; body: string }[] }>(
      await api(`/v1/memory?tier=position&scope_id=${e.memory_id?.split(':')[2]}`),
    )
    expect(after.entries.find((x) => x.id === e.memory_id)?.body).toContain(
      '结果：CTR 2.1% vs 1.4%',
    )
    // 前两格不能空
    expect(
      (await post('/v1/ads/creative/experiments', { hypothesis: '  ', change: 'x' })).status,
    ).toBe(400)
  })

  it('不是投放职责：打不开这一面', async () => {
    const res = await post(
      '/v1/ads/creative/imports',
      { platform: 'google', text: CSV },
      support.id,
    )
    expect(res.status).toBe(403)
  })
})
