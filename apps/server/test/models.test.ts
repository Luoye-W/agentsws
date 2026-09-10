/**
 * 模型连接设置端到端（WP25 交付 C）：起真服务进程 → 看模板 → 填 key → 试跑 →
 * 改默认 → 看花费 → 删掉，全程按 13 §4.3 与 22 §5 断言 **API key 零泄漏**。
 *
 * 三条主张，每条都有断言撑着：
 *
 * 1. **零泄漏**：key 的值不出现在任何响应体、任何事件、数据目录里任何一个文件的字节里，
 *    也不出现在 `process.env`。整条路上唯一见过它的是加密库的密文。
 * 2. **热更新**：保存 / 删除 / 改默认之后，**同一个网关对象**下一次 `complete` 就走新配置，
 *    不用重启进程——而且预算已花的额度不清零。
 * 3. **测试按钮不联网**：`modelFetch` 注入之后，全程没有一个字节离开这台机器。
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ModelDefaultsView,
  ModelListing,
  ModelProviderTemplate,
  ModelProviderView,
  ModelTestResult,
  ModelUsageView,
} from '@agentsws/api'
import type { EventEnvelope } from '@agentsws/contracts'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { DEEPSEEK_KEY_ENV } from '../src/models.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-09-09T09:00:00.000Z'
const SECRETS_KEY = 'a'.repeat(64)

/** 测试里唯一的"凭据"。所有零泄漏断言都盯着这一串。 */
const API_KEY = 'sk-wp25-never-leaves-the-vault-9f3c'
/** 环境变量兜底那条路用的另一把（和上面那把区分开）。 */
const ENV_KEY = 'sk-from-env-var-fallback-7d1a'

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

/** 假上游：记下每一次请求（含头），回一段最小的 OpenAI 兼容响应。 */
interface FakeUpstream {
  fetch: FetchLike
  calls: { url: string; auth: string | undefined; body: string }[]
  /** 下一次回什么：ok / 401 / 连不上。 */
  mode: 'ok' | 'unauthorized' | 'down'
  /** WP42：`GET /models` 回哪几个模型名（空数组 = 这家没有这个口）。 */
  models: string[]
}

function fakeUpstream(): FakeUpstream {
  const state: FakeUpstream = {
    calls: [],
    mode: 'ok',
    models: ['deepseek-chat', 'deepseek-flash', 'deepseek-v4-pro'],
    fetch: async () => ({}) as never,
  }
  state.fetch = async (url, init) => {
    state.calls.push({
      url,
      auth: init.headers.Authorization ?? init.headers.authorization,
      body: typeof init.body === 'string' ? init.body : '[form]',
    })
    if (state.mode === 'down') throw new Error('ECONNREFUSED 127.0.0.1:1')
    if (state.mode === 'unauthorized') {
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Invalid API key' } }),
        text: async () => '{"error":{"message":"Invalid API key"}}',
      }
    }
    // WP42：模型清单口。空清单时当作"这家没有这个接口"回 404
    if (url.endsWith('/models') || url.endsWith('/api/tags')) {
      if (state.models.length === 0) {
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'no such route' }
      }
      const body = url.endsWith('/api/tags')
        ? { models: state.models.map((m) => ({ model: m })) }
        : { object: 'list', data: state.models.map((m) => ({ id: m, owned_by: 'upstream' })) }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '好' } }],
        usage: { prompt_tokens: 9, completion_tokens: 1 },
      }),
      text: async () => '{}',
    }
  }
  return state
}

interface Ctx {
  server: Server
  url: string
  dir: string
  upstream: FakeUpstream
}

let ctx: Ctx

const api = async (
  path: string,
  init: RequestInit & { assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${ctx.server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? ctx.server.bootstrap.ownerAssignment.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${ctx.url}${path}`, { ...init, headers })
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const put = (path: string, body: unknown): Promise<Response> =>
  api(path, { method: 'PUT', body: JSON.stringify(body) })
const post = (path: string, body?: unknown): Promise<Response> =>
  api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

async function allEvents(): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for await (const e of ctx.server.kernel.eventLog.read({
    workspace_id: ctx.server.bootstrap.workspace.id,
    limit: 5000,
  }))
    out.push(e)
  return out
}

function allFileBytes(dir: string): { name: string; bytes: Buffer }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => ({ name: d.name, bytes: readFileSync(join(dir, d.name)) }))
}

/** 保存一条真能用的 DeepSeek 配置（默认带 key）。 */
const SAVE = {
  kind: 'deepseek' as const,
  label: '我的 DeepSeek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  api_key: API_KEY,
  price_in: 0.27,
  price_out: 1.1,
}

async function boot(env: Record<string, string | undefined> = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-models-'))
  const upstream = fakeUpstream()
  const server = await createServer({
    dbDir: dir,
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    env: { [SECRETS_KEY_ENV]: SECRETS_KEY, ...env },
    modelFetch: upstream.fetch,
    // 一次性任务不留后台计时器
    tokenRefreshIntervalMs: 0,
  })
  const { url } = await server.listen(0)
  ctx = { server, url, dir, upstream }
}

beforeEach(async () => {
  await boot()
})

afterEach(async () => {
  await ctx.server.close()
})

describe('WP25 §C 模板与空状态', () => {
  it('一台新机器：一条 provider 都没有，configured 为假', async () => {
    const { providers } = await data<{ providers: ModelProviderView[] }>(
      await api('/v1/models/providers'),
    )
    expect(providers).toEqual([])
    expect(ctx.server.modelSettings.configured()).toBe(false)
  })

  it('两种模板：DeepSeek 官方 + OpenAI 兼容自定义，各带 ≤ 5 步说明与外链', async () => {
    const { templates } = await data<{ templates: ModelProviderTemplate[] }>(
      await api('/v1/models/providers'),
    )
    expect(templates.map((t) => t.kind)).toEqual(['deepseek', 'openai_compatible'])
    for (const t of templates) {
      expect(t.steps.length).toBeGreaterThan(0)
      expect(t.steps.length).toBeLessThanOrEqual(5)
      expect(t.links.length).toBeGreaterThan(0)
      expect(t.default_model).not.toBe('')
    }
    // 自定义那条带一组"点一下就填好"的预设（Moonshot / 通义 / 本地 Ollama…）
    const custom = templates.find((t) => t.kind === 'openai_compatible')
    expect((custom?.presets ?? []).length).toBeGreaterThan(2)
  })

  it('没配模型时默认模型是 stub —— 运行时落回 stub 而不是崩', () => {
    expect(ctx.server.modelSettings.defaultRef().provider).toBe('stub')
  })
})

describe('WP25 §C 填 key（零泄漏）', () => {
  it('保存之后只回 has_key: true —— 响应体里没有 key、没有密文、没有长度线索', async () => {
    const res = await put('/v1/models/providers/deepseek', SAVE)
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain(API_KEY)
    // 连片段都不许有（防"只回前四位"这种"脱敏"）
    expect(raw).not.toContain(API_KEY.slice(0, 12))
    const view = (JSON.parse(raw) as { data: ModelProviderView }).data
    expect(view.has_key).toBe(true)
    expect(view.active).toBe(true)
    expect(Object.keys(view)).not.toContain('api_key')
  })

  it('列表、默认、花费三条读路径都不带 key', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    for (const path of ['/v1/models/providers', '/v1/models/defaults', '/v1/models/usage']) {
      const text = await (await api(path)).text()
      expect(text, path).not.toContain(API_KEY)
    }
  })

  it('事件日志里一个字节都没有 key', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    await post('/v1/models/providers/deepseek/test')
    const dump = JSON.stringify(await allEvents())
    expect(dump).not.toContain(API_KEY)
    expect(dump).not.toContain(API_KEY.slice(0, 12))
  })

  it('数据目录里每一个文件的字节都没有 key（明文 models.json 也没有）', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    const files = allFileBytes(ctx.dir)
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      expect(f.bytes.includes(API_KEY), `${f.name} 里有 key`).toBe(false)
    }
    // models.json 确实存在、确实是明文，并且里面确实有非秘密配置
    const models = files.find((f) => f.name === 'models.json')
    expect(models?.bytes.toString('utf8')).toContain('deepseek-chat')
    expect(models?.bytes.toString('utf8')).not.toContain('api_key')
  })

  it('key 不进 process.env（写环境变量等于让同进程任何代码都能读到）', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    expect(Object.values(process.env).some((v) => v === API_KEY)).toBe(false)
  })

  it('校验不过时错误信封里只有字段路径，没有值', async () => {
    const res = await put('/v1/models/providers/deepseek', { ...SAVE, model: '' })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain(API_KEY)
    expect(text).toContain('model')
  })

  it('id 不合法直接顶回来，不会在加密库里留下半条', async () => {
    const res = await put('/v1/models/providers/Bad%20Id', SAVE)
    expect(res.status).toBe(400)
    const { providers } = await data<{ providers: ModelProviderView[] }>(
      await api('/v1/models/providers'),
    )
    expect(providers).toEqual([])
  })

  it('不给 api_key 就是"别动已经存着的那把"：改模型名不用重填', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    const res = await put('/v1/models/providers/deepseek', {
      kind: 'deepseek',
      model: 'deepseek-reasoner',
    })
    const view = await data<ModelProviderView>(res)
    expect(view.model).toBe('deepseek-reasoner')
    expect(view.has_key).toBe(true)
    // 而且下一次请求用的还是同一把 key
    await post('/v1/models/providers/deepseek/test')
    expect(ctx.upstream.calls.at(-1)?.auth).toBe(`Bearer ${API_KEY}`)
  })
})

describe('WP25 §C 热更新（保存即生效，不重启）', () => {
  it('保存前后是同一个网关对象，默认模型换了', async () => {
    const before = ctx.server.models
    expect(ctx.server.modelSettings.defaultRef().provider).toBe('stub')
    await put('/v1/models/providers/deepseek', SAVE)
    expect(ctx.server.models).toBe(before)
    expect(ctx.server.modelSettings.defaultRef()).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      region: 'cn',
    })
    expect(ctx.server.modelSettings.configured()).toBe(true)
  })

  it('第一条能用的 provider 自动成为默认，用户不用再去下拉框点一次', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    const defaults = await data<ModelDefaultsView>(await api('/v1/models/defaults'))
    expect(defaults.default).toBe('deepseek/deepseek-chat')
    // WP42：下拉里是拉回来的整份清单，配置里那一个排头一个
    expect(defaults.choices.map((c) => c.id)).toEqual([
      'deepseek/deepseek-chat',
      'deepseek/deepseek-flash',
      'deepseek/deepseek-v4-pro',
    ])
  })

  it('换 base_url / 模型名之后，下一次请求就打到新地址（不用重启）', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    await post('/v1/models/providers/deepseek/test')
    expect(ctx.upstream.calls.at(-1)?.url).toContain('api.deepseek.com')
    await put('/v1/models/providers/deepseek', {
      kind: 'openai_compatible',
      base_url: 'http://127.0.0.1:11434/v1',
      model: 'llama3.1',
    })
    await post('/v1/models/providers/deepseek/test')
    expect(ctx.upstream.calls.at(-1)?.url).toContain('127.0.0.1:11434')
    expect(ctx.upstream.calls.at(-1)?.body).toContain('llama3.1')
  })

  it('热更新不清账：改完配置，已经花掉的预算还在（重建网关会把今天花的钱清零）', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    await post('/v1/models/providers/deepseek/test')
    const before = await data<ModelUsageView>(await api('/v1/models/usage'))
    expect(before.total?.calls).toBe(1)
    await put('/v1/models/providers/deepseek', { kind: 'deepseek', model: 'deepseek-chat' })
    const after = await data<ModelUsageView>(await api('/v1/models/usage'))
    expect(after.total?.calls).toBe(1)
    expect(after.total?.cost_base).toBe(before.total?.cost_base)
  })

  it('删掉最后一条：默认落回 stub，加密库里那把 key 也没了', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    expect(ctx.server.secrets.record('model_provider:deepseek')).toBeDefined()
    expect((await api('/v1/models/providers/deepseek', { method: 'DELETE' })).status).toBe(200)
    expect(ctx.server.secrets.record('model_provider:deepseek')).toBeUndefined()
    expect(ctx.server.modelSettings.configured()).toBe(false)
    expect(ctx.server.modelSettings.defaultRef().provider).toBe('stub')
  })

  it('删一个不存在的：404，不是静默成功', async () => {
    expect((await api('/v1/models/providers/nope', { method: 'DELETE' })).status).toBe(404)
  })
})

describe('WP25 §C 测试按钮', () => {
  it('走网关一次最小 complete（purpose=judge），回延迟与模型名，全程不联网', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    const result = await data<ModelTestResult>(await post('/v1/models/providers/deepseek/test'))
    expect(result.ok).toBe(true)
    expect(result.model).toBe('deepseek/deepseek-chat')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
    // 出网请求全打在注入的假上游上：真 fetch 一次都没被调到
    // （保存时会顺手拉一次模型清单，WP42；试跑本身仍然只有这一次 chat 调用）
    const chats = ctx.upstream.calls.filter((c) => c.url.endsWith('/chat/completions'))
    expect(chats).toHaveLength(1)
    const call = chats[0]
    expect(call?.url).toBe('https://api.deepseek.com/chat/completions')
    // key 只在 Authorization 头里出现，body 里没有
    expect(call?.auth).toBe(`Bearer ${API_KEY}`)
    expect(call?.body).not.toContain(API_KEY)
  })

  it('试跑用的 token 很少（≤ 10 个输出 token 的一句话，不是一次真干活）', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    await post('/v1/models/providers/deepseek/test')
    const chat = ctx.upstream.calls.find((c) => c.url.endsWith('/chat/completions'))
    const body = JSON.parse(chat?.body ?? '{}') as {
      messages: { role: string }[]
    }
    expect(body.messages).toHaveLength(2)
  })

  it('还没填 key 就点测试：明说"先保存一把再测"，一次网络请求都不发', async () => {
    // 先存一条没 key 的（秘密库里没有它）
    await put('/v1/models/providers/mine', {
      kind: 'openai_compatible',
      base_url: 'http://127.0.0.1:11434/v1',
      model: 'llama3.1',
    })
    const result = await data<ModelTestResult>(await post('/v1/models/providers/mine/test'))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no_key')
    expect(result.detail).toContain('API key')
    expect(ctx.upstream.calls).toHaveLength(0)
  })

  it('上游 401：翻成"key 不对，去控制台重新生成一把"，原文只在括号里', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    ctx.upstream.mode = 'unauthorized'
    const result = await data<ModelTestResult>(await post('/v1/models/providers/deepseek/test'))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('API key 不对')
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  it('连不上：提示检查地址与网络（本地模型没起来就是这条）', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    ctx.upstream.mode = 'down'
    const result = await data<ModelTestResult>(await post('/v1/models/providers/deepseek/test'))
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/连不上|没通/)
  })

  it('测试结果记在那条 provider 上，刷新页面还看得见', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    await post('/v1/models/providers/deepseek/test')
    const { providers } = await data<{ providers: ModelProviderView[] }>(
      await api('/v1/models/providers'),
    )
    expect(providers[0]?.last_test?.ok).toBe(true)
    expect(providers[0]?.last_test?.checked_at).toBe(T0)
  })

  it('测一个不存在的 provider：404', async () => {
    expect((await post('/v1/models/providers/nope/test')).status).toBe(404)
  })
})

describe('WP25 §C 默认模型 / 驻留 / 三级预算', () => {
  it('按 purpose 指定模型；指到一个用不了的直接顶回来', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    const ok = await data<ModelDefaultsView>(
      await put('/v1/models/defaults', {
        by_purpose: { judge: 'deepseek/deepseek-chat' },
        data_residency: 'cn',
      }),
    )
    expect(ok.by_purpose.judge).toBe('deepseek/deepseek-chat')
    const bad = await put('/v1/models/defaults', { default: 'nobody/nothing' })
    expect(bad.status).toBe(400)
  })

  it('三级预算存下来，花费那一页读得到工作区档', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    await put('/v1/models/defaults', {
      budget: { workspace_daily_base: 12.5, assignment_daily_base: 3 },
    })
    const defaults = await data<ModelDefaultsView>(await api('/v1/models/defaults'))
    expect(defaults.budget.workspace_daily_base).toBe(12.5)
    const usage = await data<ModelUsageView>(await api('/v1/models/usage'))
    expect(usage.budget.cap_base).toBe(12.5)
    expect(usage.budget.frozen).toBe(false)
  })

  it('花费按 purpose 分行，试跑那次记在 judge 上', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    await post('/v1/models/providers/deepseek/test')
    const usage = await data<ModelUsageView>(await api('/v1/models/usage'))
    expect(usage.rows.map((r) => r.purpose)).toEqual(['judge'])
    expect(usage.rows[0]?.input_tokens).toBe(9)
    expect(usage.total?.calls).toBe(1)
  })

  it('落盘之后重启进程，配置还在、key 也还在（不用重填）', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    await put('/v1/models/defaults', { budget: { workspace_daily_base: 7 } })
    const dir = ctx.dir
    await ctx.server.close()
    const upstream = fakeUpstream()
    const server = await createServer({
      dbDir: dir,
      clock: makeClock(),
      random: seeded(),
      quiet: true,
      env: { [SECRETS_KEY_ENV]: SECRETS_KEY },
      modelFetch: upstream.fetch,
      tokenRefreshIntervalMs: 0,
    })
    const { url } = await server.listen(0)
    ctx = { server, url, dir, upstream }
    expect(server.modelSettings.configured()).toBe(true)
    const defaults = await data<ModelDefaultsView>(await api('/v1/models/defaults'))
    expect(defaults.budget.workspace_daily_base).toBe(7)
    // key 确实还在：试跑还是那把
    await post('/v1/models/providers/deepseek/test')
    expect(upstream.calls.at(-1)?.auth).toBe(`Bearer ${API_KEY}`)
  })
})

describe('WP25 §C 环境变量兜底（无界面部署）', () => {
  afterEach(async () => {
    await ctx.server.close()
    await boot()
  })

  it('设了 DEEPSEEK_API_KEY：兜出一条标 from_env 的 provider，界面上删不掉', async () => {
    await ctx.server.close()
    await boot({ [DEEPSEEK_KEY_ENV]: ENV_KEY })
    const { providers } = await data<{ providers: ModelProviderView[] }>(
      await api('/v1/models/providers'),
    )
    expect(providers).toHaveLength(1)
    expect(providers[0]?.id).toBe('deepseek')
    expect(providers[0]?.from_env).toBe(true)
    expect(providers[0]?.has_key).toBe(true)
    expect(ctx.server.modelSettings.configured()).toBe(true)
    const del = await api('/v1/models/providers/deepseek', { method: 'DELETE' })
    expect(del.status).toBe(400)
    expect(await del.text()).toContain(DEEPSEEK_KEY_ENV)
  })

  it('环境变量那条也不把值抄进任何响应体', async () => {
    await ctx.server.close()
    await boot({ [DEEPSEEK_KEY_ENV]: ENV_KEY })
    expect(await (await api('/v1/models/providers')).text()).not.toContain(ENV_KEY)
    await post('/v1/models/providers/deepseek/test')
    expect(JSON.stringify(await allEvents())).not.toContain(ENV_KEY)
  })

  it('界面上填的那条盖过环境变量（同一个 id 就是同一条）', async () => {
    await ctx.server.close()
    await boot({ [DEEPSEEK_KEY_ENV]: ENV_KEY })
    await put('/v1/models/providers/deepseek', SAVE)
    const { providers } = await data<{ providers: ModelProviderView[] }>(
      await api('/v1/models/providers'),
    )
    expect(providers).toHaveLength(1)
    expect(providers[0]?.from_env).toBeUndefined()
    await post('/v1/models/providers/deepseek/test')
    expect(ctx.upstream.calls.at(-1)?.auth).toBe(`Bearer ${API_KEY}`)
  })
})

describe('WP25 §C 没有秘密库密钥的机器', () => {
  it('填 key 时直接拒，并说清楚为什么（不假装存下了）', async () => {
    await ctx.server.close()
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-models-nokey-'))
    const upstream = fakeUpstream()
    const server = await createServer({
      dbDir: dir,
      clock: makeClock(),
      random: seeded(),
      quiet: true,
      env: {},
      modelFetch: upstream.fetch,
      tokenRefreshIntervalMs: 0,
    })
    const { url } = await server.listen(0)
    ctx = { server, url, dir, upstream }
    const res = await put('/v1/models/providers/deepseek', SAVE)
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain(SECRETS_KEY_ENV)
    expect(text).not.toContain(API_KEY)
    expect(server.modelSettings.configured()).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* WP42 交付 1：模型名从接口拉                                            */
/* ------------------------------------------------------------------ */

describe('WP42 §1 拉模型列表', () => {
  it('保存时顺手拉一次：清单进 view，"模型名"下拉照它画', async () => {
    const saved = await data<ModelProviderView>(await put('/v1/models/providers/deepseek', SAVE))
    expect(saved.models).toEqual(['deepseek-chat', 'deepseek-flash', 'deepseek-v4-pro'])
    expect(saved.last_listing?.ok).toBe(true)
    // 清单跟着配置落盘：重新读一次还在
    const { providers } = await data<{ providers: ModelProviderView[] }>(
      await api('/v1/models/providers'),
    )
    expect(providers[0]?.models).toHaveLength(3)
  })

  it('还没保存也能先拉：请求体里带地址与 key，key 不落盘', async () => {
    const listing = await data<ModelListing>(
      await post('/v1/models/providers/kimi/discover', {
        base_url: 'https://api.moonshot.cn/v1',
        api_key: API_KEY,
        region: 'cn',
      }),
    )
    expect(listing.ok).toBe(true)
    expect(listing.models.length).toBeGreaterThan(0)
    // 探一次不建 provider，也不写加密库
    const { providers } = await data<{ providers: ModelProviderView[] }>(
      await api('/v1/models/providers'),
    )
    expect(providers).toEqual([])
    for (const f of allFileBytes(ctx.dir)) {
      expect(f.bytes.includes(Buffer.from(API_KEY, 'utf8'))).toBe(false)
    }
  })

  it('拉不到不是错：回 ok=false + 一句人话，界面退回手填', async () => {
    ctx.upstream.models = []
    const listing = await data<ModelListing>(
      await post('/v1/models/providers/deepseek/discover', {
        base_url: 'https://api.deepseek.com',
        api_key: API_KEY,
      }),
    )
    expect(listing.ok).toBe(false)
    expect(listing.models).toEqual([])
    expect(listing.reason ?? '').not.toBe('')
    expect(listing.reason ?? '').not.toContain(API_KEY)
  })

  it('还没填 key 就点拉取：明说要先填 key，一次网络请求都不发', async () => {
    const before = ctx.upstream.calls.length
    const listing = await data<ModelListing>(
      await post('/v1/models/providers/nobody/discover', {
        base_url: 'https://api.deepseek.com',
      }),
    )
    expect(listing.ok).toBe(false)
    expect(listing.reason).toContain('API key')
    expect(ctx.upstream.calls).toHaveLength(before)
  })

  it('按 purpose 可以挑这家的**另一个**模型，发出去的模型名跟着变', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    const defaults = await data<ModelDefaultsView>(await api('/v1/models/defaults'))
    // 下拉里是拉回来的三个，不只是配置里那一个
    expect(defaults.choices.map((c) => c.id)).toEqual([
      'deepseek/deepseek-chat',
      'deepseek/deepseek-flash',
      'deepseek/deepseek-v4-pro',
    ])
    const next = await data<ModelDefaultsView>(
      await put('/v1/models/defaults', { by_purpose: { judge: 'deepseek/deepseek-flash' } }),
    )
    expect(next.by_purpose.judge).toBe('deepseek/deepseek-flash')
    // 挑中的那个真的挂上了网关：选它的运行发出去的模型名就是它，不是配置里的主模型
    expect(ctx.server.models.providers()).toContainEqual({
      provider: 'deepseek',
      model: 'deepseek-flash',
      region: 'cn',
    })
    // 没被选中的不装：一份下拉框的数据不该整份变成运行时的 provider
    expect(ctx.server.models.providers().map((r) => r.model)).not.toContain('deepseek-v4-pro')
  })

  it('拉不到的模型名不给选（乱填一个 id 仍然 400）', async () => {
    await put('/v1/models/providers/deepseek', SAVE)
    const res = await put('/v1/models/defaults', { default: 'deepseek/not-a-real-model' })
    expect(res.status).toBe(400)
  })
})
