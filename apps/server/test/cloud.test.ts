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
}

function fakeCloud(): FakeCloud {
  const state: FakeCloud = {
    calls: [],
    purchased: 800,
    monthCredits: 37.5,
    mode: 'ok',
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
    // WP118 加了两条订阅（红人已上线、客服只登记），所以是 10 条
    expect(pricing.entries.length).toBe(10)
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
