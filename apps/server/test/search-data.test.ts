/**
 * WP155（docs/81）：本机的搜索数据接口——三档路由、自带 key 的纪律、官方那一档的错误翻译。
 *
 * 不联网：官方那一档打的「云」与自带那一档打的「服务商」都是替身。
 * 钉的几条：
 * - 没选过（auto）按「官方 → 自带 → 不接」挑；选了哪档就是哪档；
 * - **配了但报错不换档**：自带 key 失败不会偷偷去花积分；
 * - key 只进本机加密库：设置文件里没有、读视图里没有、错误信息里没有；
 * - 官方那一档：402 → insufficient_credits，401 / 缺 data 权限 → not_configured。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SearchFetch } from '@agentsws/cloud-entry'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createOfficialSearchClient,
  createSearchDataService,
  createSearchDataStore,
  SEARCH_DATA_FILE,
} from '../src/search-data.js'
import type { SecretStore } from '../src/secret-store.js'

const NOW = '2026-09-26T08:00:00.000Z'
const BYO_KEY = 'my-login:not-a-real-password'
const CLOUD = 'http://cloud.test'
const Q = {
  query: 'best portable charger',
  engine: 'google',
  country: 'us',
  language: 'en',
} as const
const PROBE = {
  question: 'best charger',
  platforms: ['chatgpt', 'copilot'],
  country: 'us',
  language: 'en',
  brand: { name: 'Anker', domains: ['anker.com'] },
} as const

/** 内存加密库替身（真的那份另有测试；这里只要「存进去、取得出、删得掉」）。 */
function memorySecrets(): SecretStore & { dump(): string } {
  const rows = new Map<string, Record<string, string>>()
  return {
    available: true,
    put: (id, fields) => {
      rows.set(id, { ...fields })
      return {
        connection_id: id,
        field_names: Object.keys(fields),
        created_at: NOW,
        updated_at: NOW,
      } as never
    },
    get: (id) => rows.get(id),
    list: () => [],
    record: () => undefined,
    remove: (id) => rows.delete(id),
    rotate: () => ({}) as never,
    close: () => {},
    dump: () => JSON.stringify([...rows]),
  }
}

const SERP_OK = {
  status_code: 20000,
  tasks: [
    {
      status_code: 20000,
      result: [
        {
          items: [
            { type: 'organic', url: 'https://www.anker.com/', title: 'Anker', description: 'x' },
          ],
        },
      ],
    },
  ],
}
const CHATGPT_OK = {
  status_code: 20000,
  tasks: [
    {
      status_code: 20000,
      result: [{ markdown: 'Try Anker or Belkin.', sources: [{ url: 'https://www.anker.com/p' }] }],
    },
  ],
}

interface Setup {
  dir: string
  secrets: ReturnType<typeof memorySecrets>
  cloudCalls: string[]
  providerCalls: string[]
  service: ReturnType<typeof createSearchDataService>
}

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function setup(
  opts: {
    linked?: boolean
    cloud?: (url: string) => Response
    provider?: (url: string) => Response
  } = {},
): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp155-'))
  dirs.push(dir)
  const secrets = memorySecrets()
  if (opts.linked === true) secrets.put('cloud.workspace_token', { token: 'wst_never_leaves_4b71' })
  const cloudCalls: string[] = []
  const providerCalls: string[] = []
  const cloudFetch: SearchFetch = async (url) => {
    cloudCalls.push(url)
    return opts.cloud?.(url) ?? new Response('{}', { status: 500 })
  }
  const providerFetch: SearchFetch = async (url) => {
    providerCalls.push(url)
    return opts.provider?.(url) ?? new Response('{}', { status: 500 })
  }
  const service = createSearchDataService({
    store: createSearchDataStore({ secrets, dir, now: () => NOW }),
    official: createOfficialSearchClient({
      secrets,
      baseUrl: CLOUD,
      tokenSecretId: 'cloud.workspace_token',
      fetch: cloudFetch,
    }),
    now: () => NOW,
    fetch: providerFetch,
  })
  return { dir, secrets, cloudCalls, providerCalls, service }
}

async function codeOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
  } catch (err) {
    return { code: (err as { code: string }).code, message: (err as Error).message }
  }
  throw new Error('应该抛错')
}

describe('三档路由', () => {
  it('什么都没有：none + 一句人话；查询抛 not_configured，谁都不打', async () => {
    const s = setup()
    expect(await s.service.status()).toMatchObject({ configured: false, route: 'none' })
    expect((await s.service.status()).reason).toMatch(/还没接/)
    expect((await codeOf(s.service.serp(Q))).code).toBe('not_configured')
    expect(s.cloudCalls).toEqual([])
    expect(s.providerCalls).toEqual([])
  })

  it('auto + 关联了云账号 → 官方：打云端 /v1/data/search/serp，原样带回积分', async () => {
    const s = setup({
      linked: true,
      cloud: (url) =>
        url.endsWith('/status')
          ? Response.json({
              configured: true,
              route: 'official',
              prices: { serp: 0.2, ai_answer: 0.4 },
            })
          : Response.json({
              query: Q,
              items: [],
              fetched_at: NOW,
              source: 'official',
              credits: 0.2,
            }),
    })
    expect(await s.service.status()).toMatchObject({ route: 'official', prices: { serp: 0.2 } })
    expect(await s.service.serp(Q)).toMatchObject({ source: 'official', credits: 0.2 })
    expect(s.cloudCalls).toContain(`${CLOUD}/v1/data/search/serp`)
  })

  it('auto + 没关联 + 填了自带 key → 自带：本机直连服务商，不扣积分，source 写服务商', async () => {
    const s = setup({ provider: () => Response.json(SERP_OK) })
    await s.service.setByo({ provider: 'dataforseo', api_key: BYO_KEY })
    const view = await s.service.settings()
    expect(view).toMatchObject({
      choice: 'byo',
      byo: { provider: 'dataforseo', has_key: true },
      status: { route: 'byo', configured: true },
    })
    expect(view.status.platforms).toContain('chatgpt')
    const out = await s.service.serp(Q)
    expect(out).toMatchObject({ source: 'byo:dataforseo', credits: 0 })
    expect(out.items[0]?.domain).toBe('anker.com')
    expect(s.cloudCalls).toEqual([])
  })

  it('选了「不接」：即使关联了也不查；选了官方但没关联：not_configured', async () => {
    const s = setup({ linked: true })
    await s.service.setChoice('none')
    expect(await s.service.status()).toMatchObject({ configured: false, route: 'none' })
    expect((await codeOf(s.service.serp(Q))).code).toBe('not_configured')
    const t = setup()
    await t.service.setChoice('official')
    expect((await codeOf(t.service.serp(Q))).code).toBe('not_configured')
  })

  it('配了但报错不换档：自带 key 失败照实抛，不偷偷去花积分', async () => {
    const s = setup({
      linked: true,
      provider: () => new Response('{"status_message":"bad"}', { status: 500 }),
    })
    await s.service.setByo({ provider: 'dataforseo', api_key: BYO_KEY })
    const e = await codeOf(s.service.serp(Q))
    expect(e.code).toBe('provider_error')
    expect(e.message).not.toContain(BYO_KEY)
    expect(s.cloudCalls.filter((u) => u.includes('/serp'))).toEqual([])
  })

  it('自带 key 的 AI 问答：服务商探测不了的平台跳过，只回查到的那几个', async () => {
    const s = setup({ provider: () => Response.json(CHATGPT_OK) })
    await s.service.setByo({ provider: 'dataforseo', api_key: BYO_KEY })
    const rows = await s.service.aiAnswers({ ...PROBE, platforms: [...PROBE.platforms] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      platform: 'chatgpt',
      brand_mentioned: true,
      our_domain_cited: true,
      source: 'byo:dataforseo',
      credits: 0,
    })
  })
})

describe('官方那一档的错误翻译', () => {
  it('402 → insufficient_credits（原话带回）；401 → not_configured；缺 data 权限 → 重新关联那句', async () => {
    const cases: [number, unknown, string][] = [
      [402, { code: 'insufficient_credits', message: '积分不够了' }, 'insufficient_credits'],
      [401, { code: 'unauthenticated', message: 'x' }, 'not_configured'],
      [
        403,
        { code: 'forbidden', message: 'x', details: { required_scope: 'data' } },
        'not_configured',
      ],
      [
        501,
        { code: 'not_implemented', message: '没开通', details: { reason: 'not_configured' } },
        'not_configured',
      ],
      [504, { code: 'provider_error', message: '等太久' }, 'timeout'],
    ]
    for (const [status, body, code] of cases) {
      const s = setup({ linked: true, cloud: () => new Response(JSON.stringify(body), { status }) })
      const e = await codeOf(s.service.serp(Q))
      expect(e.code, String(status)).toBe(code)
      expect(e.message).not.toContain('wst_never_leaves_4b71')
    }
  })
})

describe('key 纪律', () => {
  it('key 只进加密库：设置文件与读视图里都没有；拔掉之后加密库里也没了、档位回 auto', async () => {
    const s = setup({ provider: () => Response.json(SERP_OK) })
    await s.service.setByo({ provider: 'serpapi', api_key: BYO_KEY })
    const file = readFileSync(join(s.dir, SEARCH_DATA_FILE), 'utf8')
    expect(file).not.toContain(BYO_KEY)
    expect(JSON.stringify(await s.service.settings())).not.toContain(BYO_KEY)
    expect(s.secrets.dump()).toContain(BYO_KEY)
    expect(await s.service.clearByo()).toEqual({ cleared: true })
    expect(s.secrets.dump()).not.toContain(BYO_KEY)
    expect((await s.service.settings()).choice).toBe('auto')
  })

  it('测试连接：用填的 key 打一次；失败的话不回显 key', async () => {
    const s = setup({
      provider: () =>
        new Response(JSON.stringify({ error: `Invalid API key ${BYO_KEY}` }), { status: 401 }),
    })
    const r = await s.service.testByo({ provider: 'serpapi', api_key: BYO_KEY })
    expect(r.ok).toBe(false)
    expect(r.message).not.toContain(BYO_KEY)
    expect(s.providerCalls[0]).toContain('serpapi.com/account.json')
    const ok = setup({ provider: () => Response.json({ account_id: 'x' }) })
    expect(await ok.service.testByo({ provider: 'serpapi', api_key: BYO_KEY })).toMatchObject({
      ok: true,
    })
  })
})
