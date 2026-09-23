/**
 * "用 agentsws 的"这一条在本地的端到端（WP59 / 49 M2 + M5）。
 *
 * 四条主张，每条都有断言撑着：
 *
 * 1. **不填 key**。第三张模型卡的 `api_key` 是空的；真往里填反而会被拒——
 *    它用的是关联账号时拿到的工作区服务令牌，不是用户填的东西。
 * 2. **没关联账号不是错**。`/v1/cloud/credits` 回 `linked: false` + 一句人话，
 *    模型卡显示"先关联账号"，而不是一个红框或者一堆 0。
 * 3. **令牌零泄漏**。它不出现在任何响应体、任何 `models.json` 的字节里；
 *    唯一见过它的是加密库的密文与出站请求的那一个头。
 * 4. **本地不记账**。余额与价目全是云上那份的透传（缓存 60 秒），本地一个数字都不自己算。
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelProviderTemplate, ModelProviderView } from '@agentsws/api'
import type { CapabilitySourceSettings, CloudCreditsView, Pricing } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudFetch } from '../src/cloud.js'
import { createServer, type Server } from '../src/index.js'
import { CLOUD_BASE_URL_ENV, CLOUD_TOKEN_SECRET_ID } from '../src/models.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

// 这一档每条都要起真服务进程 + 内存云 + 加密库：单跑 1–4 s，与模拟矩阵并跑时会撞 5 s 默认线
vi.setConfig({ testTimeout: 20_000 })

const T0 = '2026-09-15T09:00:00.000Z'
const SECRETS_KEY = 'b'.repeat(64)
/** WP58 关联账号时会存进来的那把。所有零泄漏断言都盯着这一串。 */
const WORKSPACE_TOKEN = 'wst_never_leaves_the_vault_4b71'
const CLOUD_BASE = 'http://cloud.test.invalid'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 13): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface FakeCloud {
  fetch: CloudFetch
  calls: { url: string; auth: string | undefined }[]
  purchased: number
  monthCredits: number
  mode: 'ok' | 'down'
  /** 红人营销增值服务（WP118）在云上的那一本。 */
  kol: {
    /** 订阅状态。`none` 时同步那几条回 402（与真云侧同一个闸门）。 */
    status: 'none' | 'active' | 'cancelling' | 'grace'
    /** 云上那本账里的对象。 */
    objects: Record<string, unknown>[]
    /** 本地推上来的那些（原样收着，测试直接看）。 */
    pushed: Record<string, unknown>[]
    /** 下一次 pull 要还给本地的那些（"别的机器写的"）。 */
    toPull: Record<string, unknown>[]
    cursor: number
    deleted: number
  }
}

/** 一句人话 + 一个码（云侧那个信封）。 */
const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
})

/**
 * 云上红人营销增值服务那一组的替身。
 *
 * 只实现本地那一头真会打的几条，形状与 `packages/kol-cloud` 的路由逐字一致
 * （成功 `{ data }`，失败 `{ code, message }`）——真云侧的行为由它自己的测试钉住，
 * 这里要钉的是**本地这一头会不会说这门协议**。
 */
function kolRoute(
  url: string,
  init: { method?: string; body?: string },
): { ok: boolean; status: number; json: () => Promise<unknown> } {
  const kol = FAKE_KOL
  const method = init.method ?? 'GET'
  const at = '2026-09-15T09:00:00.000Z'
  const subscription = {
    org_id: 'org_test',
    service_id: 'kol.service.monthly',
    status: kol.status,
    cancel_at_period_end: kol.status === 'cancelling',
    granted_months: 0,
    updated_at: at,
    ...(kol.status === 'none'
      ? {}
      : {
          started_at: at,
          anchor_at: at,
          current_cycle_start: at,
          current_cycle_end: '2026-10-15T09:00:00.000Z',
        }),
  }
  const gate = () =>
    kol.status === 'active' || kol.status === 'cancelling'
      ? undefined
      : json(
          {
            code: 'payment_required',
            message:
              kol.status === 'none'
                ? '还没开通红人营销增值服务（30 积分 / 月）。开通之后红人库才开始往云上同步。'
                : '这一期的 30 积分没扣上，同步暂停了。云上与本地的数据一条都没动。',
          },
          402,
        )

  if (url.includes('/v1/kol/sync/status'))
    return json({
      data: {
        org_id: 'org_test',
        subscription,
        object_count: kol.objects.length,
        by_kind: [],
        cursor: String(kol.cursor),
        pending_conflicts: 0,
        at,
      },
    })
  if (url.includes('/v1/kol/sync/push')) {
    const blocked = gate()
    if (blocked !== undefined) return blocked
    const body = JSON.parse(init.body ?? '{}') as { objects?: Record<string, unknown>[] }
    const objects = body.objects ?? []
    kol.pushed.push(...objects)
    kol.objects.push(...objects.filter((o) => o.deleted !== true))
    kol.cursor += objects.length
    return json({
      data: {
        accepted: objects.length,
        rejected: [],
        conflicts: [],
        cursor: String(kol.cursor),
        at,
      },
    })
  }
  if (url.includes('/v1/kol/sync/pull')) {
    const blocked = gate()
    if (blocked !== undefined) return blocked
    const objects = kol.toPull.splice(0)
    kol.cursor += objects.length
    return json({ data: { objects, cursor: String(kol.cursor), has_more: false, at } })
  }
  if (url.includes('/v1/kol/sync/conflicts/resolve'))
    return json({
      data: {
        org_id: 'org_test',
        kind: 'creator',
        id: 'c1',
        resolved: 1,
        pending_conflicts: 0,
        at,
      },
    })
  if (url.includes('/v1/kol/subscription')) {
    kol.status = method === 'DELETE' ? 'cancelling' : 'active'
    return json(
      {
        data: {
          ...subscription,
          status: kol.status,
          cancel_at_period_end: kol.status === 'cancelling',
        },
      },
      method === 'DELETE' ? 200 : 201,
    )
  }
  if (url.includes('/v1/kol/cloud/export'))
    return json({
      data: {
        format: 1,
        org_id: 'org_test',
        at,
        subscription,
        objects: kol.objects,
        conflicts: [],
      },
    })
  if (url.includes('/v1/kol/cloud')) {
    kol.deleted = kol.objects.length
    kol.objects = []
    return json({
      data: { org_id: 'org_test', deleted: kol.deleted, subscription_kept: true, at },
    })
  }
  return json({ code: 'not_found', message: '没有这条路' }, 404)
}

/** 替身之间要共享同一本账（`fakeCloud()` 每次建一个新的，这里只要一份）。 */
const FAKE_KOL = {
  status: 'none' as 'none' | 'active' | 'cancelling' | 'grace',
  objects: [] as Record<string, unknown>[],
  pushed: [] as Record<string, unknown>[],
  toPull: [] as Record<string, unknown>[],
  cursor: 0,
  deleted: 0,
}

function fakeCloud(): FakeCloud {
  const state: FakeCloud = {
    calls: [],
    purchased: 800,
    monthCredits: 37.5,
    mode: 'ok',
    kol: FAKE_KOL,
    fetch: async () => ({}) as never,
  }
  state.fetch = async (url, init) => {
    state.calls.push({ url, auth: init.headers.Authorization ?? init.headers.authorization })
    if (state.mode === 'down') throw new Error('ECONNREFUSED')
    if (url.includes('/v1/wallet/usage')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { group: 'capability', rows: [], total_credits: state.monthCredits },
        }),
      }
    }
    if (url.includes('/v1/wallet/pricing')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            version: 1,
            as_of: '2026-09-15',
            credit_cny: 1,
            ai_multiplier: 3,
            fx: { CNY: 1 },
            entries: [
              {
                capability: 'ai.chat',
                unit: '1k_tokens',
                credits_per_unit: 0.1,
                label_zh: '来自云上的价目表',
                label_en: 'from the cloud',
              },
            ],
          },
        }),
      }
    }
    if (url.includes('/v1/kol/')) return kolRoute(url, init)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          org_id: 'org_test',
          purchased: state.purchased,
          granted: 120,
          available: state.purchased + 120,
          reserved: 0,
          expiring: [{ credits: 120, expires_at: '2026-10-15T00:00:00.000Z' }],
          low_balance_threshold: 50,
          low_balance: false,
          at: T0,
        },
      }),
    }
  }
  return state
}

interface Ctx {
  server: Server
  url: string
  dir: string
  cloud: FakeCloud
  clock: ReturnType<typeof makeClock>
}

let ctx: Ctx

const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${ctx.server.bootstrap.internalToken}`)
  headers.set('X-Assignment', ctx.server.bootstrap.ownerAssignment.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${ctx.url}${path}`, { ...init, headers })
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

/** WP58 会做的事：把工作区服务令牌放进本机加密库。这里直接放，不等那个 WP。 */
function linkAccount(): void {
  ctx.server.secrets.put(CLOUD_TOKEN_SECRET_ID, { token: WORKSPACE_TOKEN })
}

function allFileBytes(dir: string): { name: string; bytes: Buffer }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => ({ name: d.name, bytes: readFileSync(join(dir, d.name)) }))
}

beforeEach(async () => {
  // 云上那本账是模块级的一份（替身之间要共享），所以每条测试自己清一遍
  FAKE_KOL.status = 'none'
  FAKE_KOL.objects = []
  FAKE_KOL.pushed = []
  FAKE_KOL.toPull = []
  FAKE_KOL.cursor = 0
  FAKE_KOL.deleted = 0
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-cloud-'))
  const cloud = fakeCloud()
  const clock = makeClock()
  const server = await createServer({
    dbDir: dir,
    clock,
    random: seeded(),
    quiet: true,
    env: { [SECRETS_KEY_ENV]: SECRETS_KEY, [CLOUD_BASE_URL_ENV]: CLOUD_BASE },
    cloudFetch: cloud.fetch,
    tokenRefreshIntervalMs: 0,
  })
  const { url } = await server.listen(0)
  ctx = { server, url, dir, cloud, clock }
})

afterEach(async () => {
  await ctx.server.close()
})

describe('第三张模型卡（49 M2）', () => {
  it('模板里有它，地址指向服务入口，而且"要准备什么"里没有一句"填 key"', async () => {
    const { templates } = await data<{ templates: ModelProviderTemplate[] }>(
      await api('/v1/models/providers'),
    )
    const cloud = templates.find((t) => t.kind === 'agentsws_cloud')
    expect(cloud).toBeDefined()
    expect(cloud?.default_base_url).toBe(`${CLOUD_BASE}/v1/ai`)
    // "要准备什么"里没有一句"填 key"（末一步提到 key 是为了说怎么换回自己的）
    expect(cloud?.steps.join('')).not.toContain('填 key')
    expect(cloud?.steps[0]).toContain('关联')
    expect(cloud?.summary).toContain('积分')
  })

  it('还没关联账号时存不上——回一句人话，不是 500', async () => {
    const res = await api('/v1/models/providers/cloud', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'agentsws_cloud', model: 'deepseek-flash' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { message: string }
    expect(body.message).toContain('关联')
  })

  it('往里填 key 会被拒——它本来就不填 key', async () => {
    linkAccount()
    const res = await api('/v1/models/providers/cloud', {
      method: 'PUT',
      body: JSON.stringify({
        kind: 'agentsws_cloud',
        model: 'deepseek-flash',
        api_key: 'sk-user-typed-this-by-mistake',
      }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toContain('不用填 key')
  })

  it('关联之后存得上、挂得起来，而且令牌一个字节都没漏出去', async () => {
    linkAccount()
    const saved = await data<ModelProviderView>(
      await api('/v1/models/providers/cloud', {
        method: 'PUT',
        body: JSON.stringify({ kind: 'agentsws_cloud', model: 'deepseek-flash' }),
      }),
    )
    expect(saved.kind).toBe('agentsws_cloud')
    expect(saved.has_key).toBe(true)
    expect(saved.active).toBe(true)
    expect(saved.base_url).toBe(`${CLOUD_BASE}/v1/ai`)
    expect(JSON.stringify(saved)).not.toContain(WORKSPACE_TOKEN)

    // 列表里也没有；`models.json` 是明文 JSON，里面更不该有
    const listed = await (await api('/v1/models/providers')).text()
    expect(listed).not.toContain(WORKSPACE_TOKEN)
    const plaintext = allFileBytes(ctx.dir).filter((f) => f.name.endsWith('.json'))
    for (const f of plaintext) {
      expect(f.bytes.includes(WORKSPACE_TOKEN), `${f.name} 里出现了令牌`).toBe(false)
    }
  })

  it('没关联时那条显示的是"去关联账号"，不是"还没填 API key"', async () => {
    linkAccount()
    await api('/v1/models/providers/cloud', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'agentsws_cloud', model: 'deepseek-flash' }),
    })
    // 模拟"撤销了账号关联"
    ctx.server.secrets.remove(CLOUD_TOKEN_SECRET_ID)
    const { providers } = await data<{ providers: ModelProviderView[] }>(
      await api('/v1/models/providers'),
    )
    const row = providers.find((p) => p.id === 'cloud')
    expect(row?.active).toBe(false)
    expect(row?.inactive_reason).toContain('关联')
    expect(row?.inactive_reason).not.toContain('API key')
  })
})

describe('/v1/cloud/credits（49 M5）', () => {
  it('没关联账号：linked=false + 一句人话，一次云都不打', async () => {
    const view = await data<CloudCreditsView>(await api('/v1/cloud/credits'))
    expect(view.linked).toBe(false)
    expect(view.reason).toContain('关联')
    expect(view.balance).toBeUndefined()
    expect(ctx.cloud.calls).toHaveLength(0)
  })

  it('关联之后：余额与本月用量都是云上那份的透传，令牌只在出站的头里', async () => {
    linkAccount()
    const view = await data<CloudCreditsView>(await api('/v1/cloud/credits'))
    expect(view.linked).toBe(true)
    expect(view.balance).toMatchObject({ purchased: 800, granted: 120, available: 920 })
    expect(view.month_credits).toBe(37.5)
    expect(ctx.cloud.calls.every((c) => c.auth === `Bearer ${WORKSPACE_TOKEN}`)).toBe(true)
    expect(JSON.stringify(view)).not.toContain(WORKSPACE_TOKEN)
  })

  it('缓存 60 秒：连打三次只走一轮云；过了 60 秒才再打一轮', async () => {
    linkAccount()
    await api('/v1/cloud/credits')
    const afterFirst = ctx.cloud.calls.length
    expect(afterFirst).toBe(2) // 余额 + 用量
    await api('/v1/cloud/credits')
    await api('/v1/cloud/credits')
    expect(ctx.cloud.calls).toHaveLength(afterFirst)

    ctx.clock.advance(61_000)
    ctx.cloud.purchased = 1300
    const fresh = await data<CloudCreditsView>(await api('/v1/cloud/credits'))
    expect(ctx.cloud.calls.length).toBe(afterFirst * 2)
    expect(fresh.balance?.purchased).toBe(1300)
  })

  it('云连不上：linked=true + "暂时取不到"，不是 500', async () => {
    linkAccount()
    ctx.cloud.mode = 'down'
    const res = await api('/v1/cloud/credits')
    expect(res.status).toBe(200)
    const view = await data<CloudCreditsView>(res)
    expect(view.linked).toBe(true)
    expect(view.reason).toContain('暂时取不到')
  })
})

describe('/v1/cloud/pricing', () => {
  it('关联之后拿云上那份', async () => {
    linkAccount()
    const pricing = await data<Pricing>(await api('/v1/cloud/pricing'))
    expect(pricing.entries[0]?.label_zh).toBe('来自云上的价目表')
  })

  it('没关联 / 连不上就回本地内置那份——价目表不该因为断网就一片空白', async () => {
    const pricing = await data<Pricing>(await api('/v1/cloud/pricing'))
    expect(pricing.credit_cny).toBe(1)
    // WP118 加了两条订阅（红人已上线、客服只登记），WP127 加了生图（按张），09-23 又把联系方式揭示
    // 从 lookup 里单开成 data.kol.reveal，所以是 12 条
    expect(pricing.entries.length).toBe(12)
    expect(pricing.entries.map((e) => e.capability)).toContain('crawl.page')
  })
})

describe('每项能力"用我的 / 用 agentsws 的"（49 M2）', () => {
  it('默认全是"用我的"——一张空表', async () => {
    const view = await data<CapabilitySourceSettings>(await api('/v1/settings/capability-sources'))
    expect(view.capability_sources).toEqual({})
    expect(view.workspace_id).toBe(ctx.server.bootstrap.workspace.id)
  })

  it('改一项存得住，重启进程还在', async () => {
    await api('/v1/settings/capability-sources', {
      method: 'PUT',
      body: JSON.stringify({
        capability_sources: { 'data.kol.lookup': 'agentsws', 'social.fetch': 'mine' },
      }),
    })
    const view = await data<CapabilitySourceSettings>(await api('/v1/settings/capability-sources'))
    // `mine` 是默认，不落盘——把默认值腌进文件，以后默认真要改就会被这些行挡着
    expect(view.capability_sources).toEqual({ 'data.kol.lookup': 'agentsws' })
    expect(view.updated_at).toBe(T0)

    const onDisk = JSON.parse(readFileSync(join(ctx.dir, 'capability-sources.json'), 'utf8')) as {
      capability_sources: Record<string, string>
    }
    expect(onDisk.capability_sources).toEqual({ 'data.kol.lookup': 'agentsws' })
  })

  it('切回"用我的"就把那一项抹掉（切回后不再产生扣费）', async () => {
    const put = (sources: Record<string, string>) =>
      api('/v1/settings/capability-sources', {
        method: 'PUT',
        body: JSON.stringify({ capability_sources: sources }),
      })
    await put({ 'crawl.page': 'agentsws' })
    const back = await data<CapabilitySourceSettings>(await put({ 'crawl.page': 'mine' }))
    expect(back.capability_sources).toEqual({})
  })

  it('只认 mine / agentsws 两个值', async () => {
    const res = await api('/v1/settings/capability-sources', {
      method: 'PUT',
      body: JSON.stringify({ capability_sources: { 'crawl.page': 'somebody_else' } }),
    })
    expect(res.status).toBe(400)
  })
})

/* ------------------------------------------------------------------ */
/* 红人营销增值服务（67 §3，WP118）：本地那一组路由                       */
/* ------------------------------------------------------------------ */

/** 往这个品牌的红人库里放一条（走真库，不经界面）。 */
async function seedCreator(id: string, display_name: string): Promise<void> {
  const brand = await ctx.server.brands.forWorkspace(ctx.server.brands.bootstrap)
  brand.kol.saveCreator({ id, display_name, merged_from: [] })
}

describe('红人营销增值服务（67 §3，WP118）', () => {
  it('没关联账号：linked=false + 一句人话，一次云都不打', async () => {
    const res = await api('/v1/cloud/kol/status')
    expect(res.status).toBe(200)
    const view = await data<{ linked: boolean; reason?: string; pending: number }>(res)
    expect(view.linked).toBe(false)
    expect(view.reason).toContain('关联')
    expect(ctx.cloud.calls).toEqual([])
  })

  it('开通：当场从云上拿到订阅状态（本地不自己算一期到哪天）', async () => {
    linkAccount()
    const res = await api('/v1/cloud/kol/subscription', { method: 'POST' })
    expect(res.status).toBe(201)
    const sub = await data<{ status: string; service_id: string }>(res)
    expect(sub.status).toBe('active')
    expect(sub.service_id).toBe('kol.service.monthly')
  })

  it('首次同步：本地整本推上去，回执里说清推了几条', async () => {
    linkAccount()
    FAKE_KOL.status = 'active'
    await seedCreator('cre_1', 'Gadget Jonas')
    await seedCreator('cre_2', 'Desk Rosa')

    const res = await api('/v1/cloud/kol/sync', { method: 'POST' })
    expect(res.status).toBe(200)
    const run = await data<{ ok: boolean; pushed: number; pulled: number; pending: number }>(res)
    expect(run.ok).toBe(true)
    expect(run.pushed).toBe(2)
    expect(run.pending).toBe(0)
    expect(FAKE_KOL.pushed.map((o) => o.id).sort()).toEqual(['cre_1', 'cre_2'])
    // 推上去的是**正文**（云端要读得懂数据，67 §1），不是一坨看不懂的字节
    expect(JSON.stringify(FAKE_KOL.pushed[0])).toContain('Gadget Jonas')
  })

  it('别的机器写进云上的：一趟同步之后出现在本地库里', async () => {
    linkAccount()
    FAKE_KOL.status = 'active'
    FAKE_KOL.toPull.push({
      kind: 'creator',
      id: 'cre_other',
      version: 1,
      updated_at: '2026-09-14T09:00:00.000Z',
      writer: 'device:other',
      body: { id: 'cre_other', display_name: '别的机器加的', merged_from: [] },
    })
    const run = await data<{ ok: boolean; pulled: number }>(
      await api('/v1/cloud/kol/sync', { method: 'POST' }),
    )
    expect(run.pulled).toBe(1)
    const brand = await ctx.server.brands.forWorkspace(ctx.server.brands.bootstrap)
    expect(brand.kol.creator('cre_other')?.display_name).toBe('别的机器加的')
  })

  it('演练那一批不上云（合成红人是本地 playground 的东西）', async () => {
    linkAccount()
    FAKE_KOL.status = 'active'
    await seedCreator('sbx_cre_1', '演练红人')
    await seedCreator('cre_real', '真红人')
    await api('/v1/cloud/kol/sync', { method: 'POST' })
    expect(FAKE_KOL.pushed.map((o) => o.id)).toEqual(['cre_real'])
  })

  it('没订阅就同步：不是 500，是 200 + 一句人话，本地改动照样排着队', async () => {
    linkAccount()
    await seedCreator('cre_1', 'Gadget Jonas')
    const res = await api('/v1/cloud/kol/sync', { method: 'POST' })
    expect(res.status).toBe(200)
    const run = await data<{ ok: boolean; message?: string; pending: number }>(res)
    expect(run.ok).toBe(false)
    expect(run.message).toContain('还没开通')
    expect(run.pending).toBe(1)
    expect(FAKE_KOL.pushed).toEqual([])

    // 开通之后自己会补上（同一条改动，一条不丢）
    await api('/v1/cloud/kol/subscription', { method: 'POST' })
    const second = await data<{ ok: boolean; pushed: number }>(
      await api('/v1/cloud/kol/sync', { method: 'POST' }),
    )
    expect(second.ok).toBe(true)
    expect(second.pushed).toBe(1)
  })

  it('欠费暂停（grace）：一句"数据一条都没动"，不是一个红框', async () => {
    linkAccount()
    FAKE_KOL.status = 'grace'
    await seedCreator('cre_1', 'Gadget Jonas')
    const run = await data<{ ok: boolean; message?: string }>(
      await api('/v1/cloud/kol/sync', { method: 'POST' }),
    )
    expect(run.ok).toBe(false)
    expect(run.message).toContain('一条都没动')
  })

  it('云连不上：状态照样回 200（说"暂时联系不上"），同步回执说排队中', async () => {
    linkAccount()
    await seedCreator('cre_1', 'Gadget Jonas')
    ctx.cloud.mode = 'down'
    const view = await data<{
      linked: boolean
      cloud_reachable: boolean
      reason?: string
      pending: number
    }>(await api('/v1/cloud/kol/status'))
    expect(view.linked).toBe(true)
    expect(view.cloud_reachable).toBe(false)
    expect(view.reason).toContain('联系不上')
    expect(view.pending).toBe(1)

    const run = await data<{ ok: boolean; message?: string }>(
      await api('/v1/cloud/kol/sync', { method: 'POST' }),
    )
    expect(run.ok).toBe(false)
    expect(run.message).toContain('联系不上')
  })

  it('状态里带着云上的数字：云端条数 / 待推条数 / 机器标识（没订阅也算得出来）', async () => {
    linkAccount()
    // 故意不订阅：读状态那一跳会顺带自动补一趟同步，订阅着的话它会把本地那条推上去，
    // "云端 1 条"就变成 2 条了。**没订阅时那一趟被 402 挡住**，数字才是确定的。
    FAKE_KOL.objects.push({ kind: 'creator', id: 'cre_cloud' })
    await seedCreator('cre_1', 'Gadget Jonas')
    const view = await data<{
      linked: boolean
      cloud_reachable: boolean
      object_count?: number
      pending: number
      device_id: string
      subscription?: { status: string }
    }>(await api('/v1/cloud/kol/status'))
    expect(view.linked).toBe(true)
    expect(view.cloud_reachable).toBe(true)
    expect(view.object_count).toBe(1)
    expect(view.pending).toBe(1)
    expect(view.device_id).toContain('device:')
    expect(view.subscription?.status).toBe('none')
  })

  it('订阅着的时候：状态里那个订阅状态是云上说的（本地不自己判）', async () => {
    linkAccount()
    FAKE_KOL.status = 'active'
    const view = await data<{ subscription?: { status: string; service_id: string } }>(
      await api('/v1/cloud/kol/status'),
    )
    expect(view.subscription?.status).toBe('active')
    expect(view.subscription?.service_id).toBe('kol.service.monthly')
  })

  it('排着队的东西自己会补上：读一次状态就把它推上去了（用户不必记得点「立即同步」）', async () => {
    linkAccount()
    FAKE_KOL.status = 'active'
    await seedCreator('cre_1', 'Gadget Jonas')
    expect(FAKE_KOL.pushed).toEqual([])
    await api('/v1/cloud/kol/status')
    // 自动补同步是"不等结果"的一趟，所以给它一点时间落地
    for (let i = 0; i < 50 && FAKE_KOL.pushed.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(FAKE_KOL.pushed.map((o) => o.id)).toEqual(['cre_1'])
  })

  it('取消：当期用完为止，而且**不是**删数据（云上那本还在）', async () => {
    linkAccount()
    FAKE_KOL.status = 'active'
    await seedCreator('cre_1', 'Gadget Jonas')
    await api('/v1/cloud/kol/sync', { method: 'POST' })
    expect(FAKE_KOL.objects).toHaveLength(1)

    const sub = await data<{ status: string; cancel_at_period_end: boolean }>(
      await api('/v1/cloud/kol/subscription', { method: 'DELETE' }),
    )
    expect(sub.status).toBe('cancelling')
    expect(sub.cancel_at_period_end).toBe(true)
    // 退订不等于删数据
    expect(FAKE_KOL.objects).toHaveLength(1)
  })

  it('导出云端这一份：可读的 json，带着订阅状态', async () => {
    linkAccount()
    FAKE_KOL.status = 'active'
    FAKE_KOL.objects.push({ kind: 'creator', id: 'cre_1', body: { display_name: 'Gadget Jonas' } })
    const dump = await data<{
      format: number
      objects: unknown[]
      subscription: { status: string }
    }>(await api('/v1/cloud/kol/export'))
    expect(dump.format).toBe(1)
    expect(dump.objects).toHaveLength(1)
    expect(dump.subscription.status).toBe('active')
  })

  it('欠费也导得出来——这时候拦着等于拿数据当人质', async () => {
    linkAccount()
    FAKE_KOL.status = 'grace'
    FAKE_KOL.objects.push({ kind: 'creator', id: 'cre_1' })
    const res = await api('/v1/cloud/kol/export')
    expect(res.status).toBe(200)
    expect((await data<{ objects: unknown[] }>(res)).objects).toHaveLength(1)
  })

  it('删掉云端这一份：**本地那条还在**（两份数据，不是一份）', async () => {
    linkAccount()
    FAKE_KOL.status = 'active'
    await seedCreator('cre_1', 'Gadget Jonas')
    await api('/v1/cloud/kol/sync', { method: 'POST' })
    expect(FAKE_KOL.objects).toHaveLength(1)

    const res = await api('/v1/cloud/kol', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const out = await data<{ deleted: number; subscription_kept: boolean }>(res)
    expect(out.deleted).toBe(1)
    expect(out.subscription_kept).toBe(true)
    const brand = await ctx.server.brands.forWorkspace(ctx.server.brands.bootstrap)
    expect(brand.kol.creator('cre_1')?.display_name).toBe('Gadget Jonas')
  })

  it('处理一条冲突：路由认那两个值，别的值回一句人话（400）', async () => {
    linkAccount()
    FAKE_KOL.status = 'active'
    const res = await api('/v1/cloud/kol/conflicts/resolve', {
      method: 'POST',
      body: JSON.stringify({ kind: 'creator', id: 'cre_1', pick: 'loser' }),
    })
    expect(res.status).toBe(200)
    const bad = await api('/v1/cloud/kol/conflicts/resolve', {
      method: 'POST',
      body: JSON.stringify({ kind: 'creator', id: 'cre_1', pick: 'delete_both' }),
    })
    expect(bad.status).toBe(400)
  })

  it('令牌零泄漏：同步这一组打云时带的是那把令牌，而它不出现在任何响应体里', async () => {
    linkAccount()
    FAKE_KOL.status = 'active'
    await seedCreator('cre_1', 'Gadget Jonas')
    await api('/v1/cloud/kol/sync', { method: 'POST' })
    const kolCalls = ctx.cloud.calls.filter((c) => c.url.includes('/v1/kol/'))
    expect(kolCalls.length).toBeGreaterThan(0)
    for (const one of kolCalls) expect(one.auth).toBe(`Bearer ${WORKSPACE_TOKEN}`)
    const view = await api('/v1/cloud/kol/status')
    expect(await view.text()).not.toContain(WORKSPACE_TOKEN)
  })
})
