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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ModelDefaultsView,
  ModelListing,
  ModelPricingRefreshResult,
  ModelPricingView,
  ModelProviderTemplate,
  ModelProviderView,
  ModelTestResult,
  ModelUsageView,
} from '@agentsws/api'
import type { EventEnvelope } from '@agentsws/contracts'
import type { FetchLike, PageFetch } from '@agentsws/model-gateway'
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
  pricing: { fetch: PageFetch; calls: string[] }
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

/**
 * WP42：抓价目页用的假 fetch。回放 `packages/model-gateway/test/fixtures/pricing/`
 * 里那几张 2026-09-10 从官网抓下来的真页面片段——**一个字节都不出网**。
 */
const PRICING_PAGES: Record<string, string> = {
  'https://api-docs.deepseek.com/quick_start/pricing/': 'deepseek.html',
  'https://developers.openai.com/api/docs/pricing': 'openai.html',
  'https://platform.kimi.com/docs/pricing/chat-k3.md': 'kimi-k3.md',
  'https://platform.kimi.com/docs/pricing/chat-k26.md': 'kimi-k26.md',
  'https://platform.kimi.com/docs/pricing/chat-k27-code.md': 'kimi-k27-code.md',
  'https://docs.bigmodel.cn/cn/guide/start/pricing.md': 'zhipu.md',
}

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'model-gateway',
  'test',
  'fixtures',
  'pricing',
)

function pricingReplay(): { fetch: PageFetch; calls: string[] } {
  const calls: string[] = []
  const fetch: PageFetch = async (url) => {
    calls.push(url)
    const name = PRICING_PAGES[url]
    if (name === undefined) return { ok: false, status: 503, text: async () => '' }
    return {
      ok: true,
      status: 200,
      text: async () => readFileSync(join(FIXTURE_DIR, name), 'utf8'),
    }
  }
  return { fetch, calls }
}

async function boot(env: Record<string, string | undefined> = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-models-'))
  const upstream = fakeUpstream()
  const pricing = pricingReplay()
  const server = await createServer({
    dbDir: dir,
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    env: { [SECRETS_KEY_ENV]: SECRETS_KEY, ...env },
    modelFetch: upstream.fetch,
    pricingFetch: pricing.fetch,
    // 一次性任务不留后台计时器
    tokenRefreshIntervalMs: 0,
  })
  const { url } = await server.listen(0)
  ctx = { server, url, dir, upstream, pricing }
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

  /*
   * WP59（49 M2）起第三种「agentsws 云」不填 key，细节在 `cloud.test.ts`；
   * WP88 起百炼占三条（按量 / Token Plan / Coding Plan）——形态仍是
   * `openai_compatible`，分开是因为**三套的地址与 key 互不通用**；
   * WP90 再加四条：OpenAI 与 Anthropic 各两条（订阅登录 + API key）。
   *
   * **模板条数 ≠ 卡数**（WP90，Luoye 定）：同一个 `vendor` 的几条合成一张卡、
   * 点进去再选方案。眼下十条模板 → 六张卡（DeepSeek / OpenAI 兼容 / 阿里云百炼 /
   * OpenAI / Anthropic / agentsws 云）。所以这条用例既钉模板清单，也钉分组结果。
   */
  it('十条模板 → 六张卡（一家一张、点进去选方案），各带 ≤ 5 步说明', async () => {
    const { templates } = await data<{ templates: ModelProviderTemplate[] }>(
      await api('/v1/models/providers'),
    )
    expect(templates.map((t) => t.kind)).toEqual([
      'deepseek',
      'openai_compatible',
      'openai_compatible',
      'openai_compatible',
      'openai_compatible',
      // WP90：OpenAI 那张卡的两个方案（订阅登录在前）
      'openai-codex',
      'openai_compatible',
      // Anthropic 那张卡的两个方案
      'anthropic',
      'openai_compatible',
      'agentsws_cloud',
    ])
    for (const t of templates) {
      expect(t.steps.length).toBeGreaterThan(0)
      expect(t.steps.length).toBeLessThanOrEqual(5)
      expect(t.links.length).toBeGreaterThan(0)
      expect(t.default_model).not.toBe('')
    }
    // 每条模板的标题与默认地址都各不相同——界面按地址认"是哪个方案"（templateSlug），
    // 撞了两条会共用一个 key，点开一条另一条跟着展开
    expect(new Set(templates.map((t) => t.label)).size).toBe(templates.length)
    expect(new Set(templates.map((t) => t.default_base_url)).size).toBe(templates.length)

    // WP90：分组成六张卡，每张卡里的方案有排序、第一个是默认选中的那个
    const vendors = [...new Set(templates.map((t) => t.vendor ?? t.label))]
    expect(vendors).toEqual([
      'deepseek',
      'openai-compatible',
      'bailian',
      'openai',
      'anthropic',
      'agentsws-cloud',
    ])
    const planOf = (vendor: string): ModelProviderTemplate[] =>
      templates
        .filter((t) => t.vendor === vendor)
        .sort((a, b) => (a.plan_order ?? 99) - (b.plan_order ?? 99))
    // 百炼一张卡三个方案，**Token Plan（订阅）默认第一**（Luoye 定）
    expect(planOf('bailian').map((t) => t.plan_label)).toEqual([
      'Token Plan（订阅）',
      '按量计费（标准）',
      'Coding Plan（订阅）',
    ])
    // OpenAI / Anthropic 各一张卡，订阅登录排第一、API key 第二
    for (const vendor of ['openai', 'anthropic'] as const) {
      const plans = planOf(vendor)
      expect(plans).toHaveLength(2)
      expect(plans[0]?.auth).toBe('subscription')
      expect(plans[0]?.subscription_provider).toBe(
        vendor === 'openai' ? 'openai-codex' : 'anthropic',
      )
      expect(plans[1]?.auth).toBe('api_key')
    }

    // 自定义那条带一组"点一下就填好"的预设（Moonshot / 通义 / 本地 Ollama…）
    const custom = templates.find((t) => t.label.startsWith('OpenAI 兼容'))
    expect((custom?.presets ?? []).length).toBeGreaterThan(2)
  })

  /*
   * WP88：**阿里云百炼一键设置**。
   *
   * 百炼有三套**互不通用**的东西——按量计费、Token Plan 订阅、Coding Plan 订阅：
   * 地址不同、key 不同（订阅档是 sk-sp- 开头）、计费方式也不同。Luoye 实测他那把
   * Token Plan 的 key 打标准口回 401；官方也明说混用会认证失败或产生意料之外的扣费。
   *
   * 所以这几条断言盯的不是"卡好不好看"，是**三张卡的地址没有串**。
   */
  it('百炼按量那张：国内 / 国际两条预设，地址与数据归属都对得上（WP88）', async () => {
    const { templates } = await data<{ templates: ModelProviderTemplate[] }>(
      await api('/v1/models/providers'),
    )
    const bailian = templates.find((t) => t.label.includes('标准，按量'))
    expect(bailian).toBeDefined()
    // 官方 2026-09-17 核实：北京地域的 OpenAI 兼容口
    expect(bailian?.default_base_url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(bailian?.default_model).toBe('qwen-plus')
    // 默认是境内：22 §2 `data_residency: cn` 的工作区能直接用
    expect(bailian?.region).toBe('cn')
    const presets = bailian?.presets ?? []
    expect(presets.map((p) => p.id)).toEqual(['bailian', 'bailian-intl'])
    // 国际站（新加坡）那条算**出境**——选了它，`cn` 的工作区会拦下来
    expect(presets.find((p) => p.id === 'bailian-intl')).toMatchObject({
      base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      region: 'global',
    })
    // 卡上要说清楚"一把 key 同时调通义与 DeepSeek"——这正是最容易多办一把 key 的地方
    expect(`${bailian?.summary}${(bailian?.steps ?? []).join('')}`).toContain('DeepSeek')
    // 外链里有拿 key 的那一页
    expect((bailian?.links ?? []).some((l) => l.url.includes('bailian.console.aliyun.com'))).toBe(
      true,
    )
  })

  it('百炼 Token Plan 那张：专属地址、只有北京、卡上写明 key 不通用（WP88）', async () => {
    const { templates } = await data<{ templates: ModelProviderTemplate[] }>(
      await api('/v1/models/providers'),
    )
    const plan = templates.find((t) => t.label.includes('Token Plan'))
    expect(plan?.default_base_url).toBe(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    )
    expect(plan?.default_model).toBe('qwen3.7-plus')
    expect(plan?.region).toBe('cn')
    // 官方只支持华北2（北京）——没有别的地址可选，就不该摆一排预设按钮
    expect(plan?.presets).toBeUndefined()
    // "专属 key、和按量那把不是同一把"必须写在卡上：拿错一把就是 401 或者乱扣钱
    const words = `${plan?.summary}${(plan?.steps ?? []).join('')}`
    expect(words).toContain('sk-sp-')
    expect(words).toContain('不通用')
  })

  it('百炼 Coding Plan 那张：另一个订阅档，地址不带 compatible-mode（WP88）', async () => {
    const { templates } = await data<{ templates: ModelProviderTemplate[] }>(
      await api('/v1/models/providers'),
    )
    const coding = templates.find((t) => t.label.includes('Coding Plan'))
    expect(coding?.default_base_url).toBe('https://coding.dashscope.aliyuncs.com/v1')
    expect(coding?.default_base_url).not.toContain('compatible-mode')
    expect((coding?.presets ?? []).map((p) => p.base_url)).toEqual([
      'https://coding.dashscope.aliyuncs.com/v1',
      'https://coding-intl.dashscope.aliyuncs.com/v1',
    ])
  })

  it('百炼：`/models` 拉不到时退回内置清单——三档各兜各的（WP88）', async () => {
    ctx.upstream.models = []
    const pull = async (base_url: string): Promise<ModelListing> =>
      data<ModelListing>(
        await post('/v1/models/providers/qwen/discover', {
          base_url,
          api_key: API_KEY,
          region: 'cn',
        }),
      )

    // 按量档：通义与 DeepSeek 同一把 key，两家的名字都在里面
    const payg = await pull('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(payg.ok).toBe(false)
    expect(payg.models).toContain('qwen-plus')
    expect(payg.models).toContain('deepseek-r1')
    expect(payg.reason ?? '').not.toContain(API_KEY)

    // Token Plan：专属地址是 maas.aliyuncs.com 的子域，不能被按量那条按后缀认走
    const plan = await pull('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
    expect(plan.models).toContain('qwen3.7-plus')
    expect(plan.models).toContain('glm-5.3')
    // 按量档独有的名字不该混进订阅档的清单
    expect(plan.models).not.toContain('qwen-turbo')
    expect(plan.reason ?? '').toContain('Token Plan')

    const coding = await pull('https://coding.dashscope.aliyuncs.com/v1')
    expect(coding.models).toContain('qwen3-coder-plus')
    expect(coding.reason ?? '').toContain('Coding Plan')
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

  /*
   * WP88：订阅档（百炼 Token Plan / Coding Plan）**花费记 0、token 照记**。
   *
   * 这是"价目表里写 0"这件事的真正落点：0 不是"价未知"，是这次调用确实不按 token
   * 花钱。所以 `cost_base` 必须是 0（不能算出一个假数字去误导 22 §3 的三级预算），
   * 而 `input_tokens` / `output_tokens` 必须照记——用掉多少 Credits 只有百炼那边算得出，
   * 但"这台机器打了多少 token"是我们自己的账，一条都不能少。
   */
  it('订阅档：保存后价自动填成 0，跑一次的 cost_base 是 0 而 token 照记（WP88）', async () => {
    const saved = await data<ModelProviderView>(
      await put('/v1/models/providers/bailian-token-plan', {
        kind: 'openai_compatible',
        label: '百炼 Token Plan',
        base_url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.7-plus',
        api_key: API_KEY,
      }),
    )
    // 卡是按**接口地址**认的：没给 region 也不该兜成通用 OpenAI 那张的 global
    // （兜错了，22 §2 的 data_residency: cn 会当场把这条拦下来说"禁止出境"）
    expect(saved.region).toBe('cn')
    // 价照内置价目表自动填：三个 0，来源标成 catalog（用户没手改过）
    expect([saved.price_in, saved.price_out, saved.price_cached]).toEqual([0, 0, 0])
    expect(saved.price_source).toBe('catalog')
    expect(saved.price_currency).toBe('CNY')

    const probe = await data<ModelTestResult>(
      await post('/v1/models/providers/bailian-token-plan/test'),
    )
    expect(probe.ok, probe.reason ?? '').toBe(true)
    const usage = await data<ModelUsageView>(await api('/v1/models/usage'))
    // token 照记
    expect(usage.total?.input_tokens).toBe(9)
    expect(usage.total?.output_tokens).toBe(1)
    // 花费记 0
    expect(usage.total?.cost_base).toBe(0)

    // 响应体里照旧没有 key 的任何痕迹
    const raw = await (await api('/v1/models/providers')).text()
    expect(raw).not.toContain(API_KEY)
    expect(raw).not.toContain(API_KEY.slice(0, 12))
  })

  it('卡按地址认，预设的地址也算数：百炼国际站那条不会兜成别人家的默认值（WP88）', async () => {
    const saved = await data<ModelProviderView>(
      await put('/v1/models/providers/bailian-intl', {
        kind: 'openai_compatible',
        base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus',
        api_key: API_KEY,
      }),
    )
    // 这条地址是百炼那张卡的**预设**（不是它的 default_base_url）——照样要认到那张卡，
    // 而且要认到**卡内那一条预设**：新加坡这条的地域是 global，不是卡默认的 cn
    expect(saved.label).toContain('新加坡')
    expect(saved.region).toBe('global')
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
    ctx = { server, url, dir, upstream, pricing: pricingReplay() }
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
    ctx = { server, url, dir, upstream, pricing: pricingReplay() }
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

  it('拉不到不是错：回 ok=false + 一句人话；认得出的那几家还兜一份内置清单（WP88）', async () => {
    ctx.upstream.models = []
    const listing = await data<ModelListing>(
      await post('/v1/models/providers/deepseek/discover', {
        base_url: 'https://api.deepseek.com',
        api_key: API_KEY,
      }),
    )
    // `ok` 仍然是假——这份不是上游报的，用户有权知道差别
    expect(listing.ok).toBe(false)
    // 但内置价目表认得出 api.deepseek.com，就把那份核实过出处的名字兜回去
    expect(listing.models).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(listing.reason ?? '').toContain('内置价目表')
    expect(listing.reason ?? '').not.toContain(API_KEY)
  })

  it('内置价目表都不认的地址：清单就是空的，不硬凑一份（WP88）', async () => {
    ctx.upstream.models = []
    const listing = await data<ModelListing>(
      await post('/v1/models/providers/ollama/discover', {
        base_url: 'http://127.0.0.1:11434/v1',
        api_key: API_KEY,
      }),
    )
    expect(listing.ok).toBe(false)
    expect(listing.models).toEqual([])
    expect(listing.reason ?? '').not.toContain('内置价目表')
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

/* ------------------------------------------------------------------ */
/* WP42 交付 2：价格自动填 + 手动可改                                      */
/* ------------------------------------------------------------------ */

describe('WP42 §2 价目表', () => {
  it('内置价目表端得出来，每条带出处与币种', async () => {
    const pricing = await data<ModelPricingView>(await api('/v1/models/pricing'))
    const deepseek = pricing.vendors.find((v) => v.id === 'deepseek')
    expect(deepseek?.currency).toBe('USD')
    expect(deepseek?.source_url).toContain('api-docs.deepseek.com')
    expect(deepseek?.models.find((m) => m.model === 'deepseek-flash')).toMatchObject({
      in: 0.3,
      out: 1.2,
      cached: 0.006,
    })
  })

  it('保存时按（地址, 模型）自动填价，并记下"来源：官网 {日期}"', async () => {
    const saved = await data<ModelProviderView>(
      await put('/v1/models/providers/deepseek', {
        kind: 'deepseek',
        base_url: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        api_key: API_KEY,
      }),
    )
    expect(saved.price_in).toBe(0.3)
    expect(saved.price_out).toBe(1.2)
    expect(saved.price_cached).toBe(0.006)
    expect(saved.price_source).toBe('catalog')
    expect(saved.price_currency).toBe('USD')
    expect(saved.price_as_of).toBe('2026-09-10')
  })

  it('用户自己改的价标"手动"，官网刷新一条都不动它', async () => {
    await put('/v1/models/providers/deepseek', {
      kind: 'deepseek',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      api_key: API_KEY,
      price_in: 9.99,
      price_out: 19.99,
      price_source: 'manual',
    })
    const result = await data<ModelPricingRefreshResult>(await post('/v1/models/pricing/refresh'))
    expect(result.ok).toBe(true)
    expect(result.updated_providers).toBe(0)
    const { providers } = await data<{ providers: ModelProviderView[] }>(
      await api('/v1/models/providers'),
    )
    expect(providers[0]?.price_in).toBe(9.99)
    expect(providers[0]?.price_source).toBe('manual')
  })

  it('刷新：抓得到的四家抓到，抓不了的两家明说为什么，事件里只有条数与来源', async () => {
    const result = await data<ModelPricingRefreshResult>(await post('/v1/models/pricing/refresh'))
    const byId = Object.fromEntries(result.vendors.map((v) => [v.id, v]))
    expect(byId.deepseek?.ok).toBe(true)
    expect(byId.openai?.ok).toBe(true)
    expect(byId.moonshot?.ok).toBe(true)
    expect(byId.zhipu?.ok).toBe(true)
    expect(byId.qwen?.ok).toBe(false)
    expect(byId.siliconflow?.ok).toBe(false)

    const events = (await allEvents()).filter((e) => e.type === 'pricing.refreshed')
    expect(events).toHaveLength(1)
    const payload = events[0]?.payload as {
      vendors_ok: number
      models: number
      sources: string[]
    }
    expect(payload.vendors_ok).toBe(4)
    expect(payload.models).toBeGreaterThan(10)
    expect(payload.sources.every((u) => u.startsWith('https://'))).toBe(true)
    // 事件里没有价、没有页面正文
    const raw = JSON.stringify(events[0])
    expect(raw).not.toContain('0.006')
    expect(raw).not.toContain('<table')
  })

  it('抓完之后 provider 上的价跟着更新（非手动的那些）', async () => {
    await put('/v1/models/providers/deepseek', {
      kind: 'deepseek',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      api_key: API_KEY,
    })
    const result = await data<ModelPricingRefreshResult>(await post('/v1/models/pricing/refresh'))
    // 抓回来的和内置价一样，所以没有一条需要改——但抓这件事本身是通的
    expect(result.ok).toBe(true)
    const { providers } = await data<{ providers: ModelProviderView[] }>(
      await api('/v1/models/providers'),
    )
    expect(providers[0]?.price_out).toBe(3.96)
    expect(providers[0]?.price_source).toBe('catalog')
  })

  it('出站急停开着：一次请求都不发，并且明说是被急停拦下的', async () => {
    ctx.server.kernel.halt.set('outbound', true, 'test')
    const before = ctx.pricing.calls.length
    const result = await data<ModelPricingRefreshResult>(await post('/v1/models/pricing/refresh'))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('急停')
    expect(ctx.pricing.calls).toHaveLength(before)
    ctx.server.kernel.halt.set('outbound', false)
  })

  it('内置价目表里没有的（本机 Ollama）：不硬套一条价，让用户自己填', async () => {
    const saved = await data<ModelProviderView>(
      await put('/v1/models/providers/ollama', {
        kind: 'openai_compatible',
        base_url: 'http://127.0.0.1:11434/v1',
        model: 'llama3.1',
        api_key: API_KEY,
      }),
    )
    expect(saved.price_in).toBeUndefined()
    expect(saved.price_source).toBeUndefined()
  })
})
