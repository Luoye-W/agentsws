/**
 * 网关这一层的模型面（WP25 交付 C）：路由形状、权限元组、错误信封，以及
 * **「API key 只经 PUT 这一条路，且不回到任何响应体里」**这条硬约束。
 *
 * 怎么装配 provider、怎么热更新、怎么试跑是 `apps/server` 的事（那边有端到端测试），
 * 这里只用一个记账用的假端口。
 */
import { describe, expect, it } from 'vitest'
import type {
  ModelDefaultsView,
  ModelProviderTemplate,
  ModelProviderView,
  ModelsPort,
  ModelTestResult,
  ModelUsageView,
  SaveModelProviderInput,
  SetModelDefaultsInput,
} from '../src/index.js'
import { createGateway, MODEL_PURPOSES, parseModelId } from '../src/index.js'
import { harness } from './helpers.js'

const T0 = '2026-09-07T09:00:00.000Z'
const SECRET = 'sk-gateway-never-echoes-this-key'

const VIEW: ModelProviderView = {
  id: 'deepseek',
  kind: 'deepseek',
  label: 'DeepSeek 官方',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  region: 'cn',
  has_key: true,
  active: true,
}

const TEMPLATE: ModelProviderTemplate = {
  kind: 'deepseek',
  label: 'DeepSeek 官方',
  summary: '国内直连',
  default_base_url: 'https://api.deepseek.com',
  default_model: 'deepseek-chat',
  region: 'cn',
  steps: ['注册', '建 key', '粘进来'],
  links: [{ label: '开放平台', url: 'https://platform.deepseek.com/api_keys' }],
}

const DEFAULTS: ModelDefaultsView = {
  default: 'deepseek/deepseek-chat',
  by_purpose: {},
  data_residency: 'cn',
  budget: {},
  choices: [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek 官方（deepseek-chat）' }],
}

const USAGE: ModelUsageView = {
  since: T0,
  rows: [],
  total: undefined,
  budget: { used_base: 0, cap_base: 0, frozen: false },
}

const OK_TEST: ModelTestResult = { ok: true, reason: 'ok', checked_at: T0 }

/** 记下每次调用与看到的入参——用来断言 key 只往下走了一次，且没回来。 */
class FakePort implements ModelsPort {
  readonly calls: string[] = []
  readonly saved: SaveModelProviderInput[] = []
  readonly setDefaultsInput: SetModelDefaultsInput[] = []
  throwOn: { method: string; code: string; message: string } | undefined

  private guard(method: string): void {
    this.calls.push(method)
    if (this.throwOn?.method === method) {
      throw Object.assign(new Error(this.throwOn.message), { code: this.throwOn.code })
    }
  }

  templates(): ModelProviderTemplate[] {
    this.guard('templates')
    return [TEMPLATE]
  }

  providers(): ModelProviderView[] {
    this.guard('providers')
    return [VIEW]
  }

  save(_actor: unknown, id: string, input: SaveModelProviderInput): ModelProviderView {
    this.guard('save')
    this.saved.push(input)
    return { ...VIEW, id, model: input.model }
  }

  remove(): void {
    this.guard('remove')
  }

  test(): ModelTestResult {
    this.guard('test')
    return OK_TEST
  }

  defaults(): ModelDefaultsView {
    this.guard('defaults')
    return DEFAULTS
  }

  setDefaults(_actor: unknown, input: SetModelDefaultsInput): ModelDefaultsView {
    this.guard('setDefaults')
    this.setDefaultsInput.push(input)
    return DEFAULTS
  }

  usage(): ModelUsageView {
    this.guard('usage')
    return USAGE
  }

  configured(): boolean {
    return true
  }
}

async function wired(withPort = true): Promise<{
  h: Awaited<ReturnType<typeof harness>>
  port: FakePort
  call: (method: string, path: string, body?: unknown, assignment?: string) => Promise<Response>
}> {
  const h = await harness()
  const port = new FakePort()
  const gateway = createGateway({ ...h.deps, ...(withPort ? { models: port } : {}) })
  const call = (
    method: string,
    path: string,
    body?: unknown,
    assignment = h.assignment.id,
  ): Promise<Response> => {
    const headers = new Headers({ Authorization: `Bearer ${h.token}`, 'X-Assignment': assignment })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return Promise.resolve(
      gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    )
  }
  return { h, port, call }
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const SAVE_BODY = {
  kind: 'deepseek' as const,
  model: 'deepseek-chat',
  api_key: SECRET,
}

describe('WP25 网关：路由与信封', () => {
  it('七条路由都在 /v1/models 之下，且都要 Bearer + X-Assignment + 权限元组', async () => {
    const { h } = await wired()
    const specs = h.gateway.specs.filter((s) => s.path.startsWith('/v1/models'))
    expect(specs.map((s) => `${s.method.toUpperCase()} ${s.path}`).sort()).toEqual([
      'DELETE /v1/models/providers/:id',
      'GET /v1/models/defaults',
      'GET /v1/models/providers',
      'GET /v1/models/usage',
      'POST /v1/models/providers/:id/test',
      'PUT /v1/models/defaults',
      'PUT /v1/models/providers/:id',
    ])
    for (const s of specs) {
      expect(s.auth).toBe('bearer')
      expect(s.assignment).toBe(true)
      expect(s.authz).toBeDefined()
    }
  })

  it('定值段 defaults / usage 不会被 :id 抢走', async () => {
    const { call, port } = await wired()
    expect((await call('GET', '/v1/models/defaults')).status).toBe(200)
    expect((await call('GET', '/v1/models/usage')).status).toBe(200)
    expect(port.calls).toEqual(['defaults', 'usage'])
  })

  it('读走 store_config.read、改走 policy.stage（和连接面同一套元组）', async () => {
    const { h } = await wired()
    const of = (m: string, p: string): { domain: string; op: string } | undefined =>
      h.gateway.specs.find((s) => s.method.toUpperCase() === m && s.path === p)?.authz
    expect(of('GET', '/v1/models/providers')).toMatchObject({
      domain: 'store_config',
      op: 'read',
      range: 'workspace',
    })
    expect(of('PUT', '/v1/models/providers/:id')).toMatchObject({
      domain: 'policy',
      op: 'stage',
      sensitivity: 'restricted',
    })
    expect(of('POST', '/v1/models/providers/:id/test')).toMatchObject({ domain: 'policy' })
    expect(of('DELETE', '/v1/models/providers/:id')).toMatchObject({ domain: 'policy' })
  })

  it('没装配模型面的进程：一律 not_implemented，而不是 500', async () => {
    const { call } = await wired(false)
    const res = await call('GET', '/v1/models/providers')
    expect(res.status).toBe(501)
    expect(await res.text()).toContain('not_implemented')
  })

  it('权限不够的 Assignment 一律 403，端口一次都没被调到', async () => {
    const { call, port } = await wired()
    const paths: [string, string][] = [
      ['GET', '/v1/models/providers'],
      ['GET', '/v1/models/defaults'],
      ['PUT', '/v1/models/defaults'],
      ['GET', '/v1/models/usage'],
      ['PUT', '/v1/models/providers/deepseek'],
      ['POST', '/v1/models/providers/deepseek/test'],
      ['DELETE', '/v1/models/providers/deepseek'],
    ]
    for (const [method, path] of paths) {
      expect((await call(method, path, undefined, 'asg_weak')).status, path).toBe(403)
    }
    expect(port.calls).toEqual([])
  })

  it('端口抛的业务码翻成对应 HTTP 状态', async () => {
    const { call, port } = await wired()
    port.throwOn = { method: 'test', code: 'not_found', message: '没有这个 provider' }
    expect((await call('POST', '/v1/models/providers/nope/test')).status).toBe(404)
    port.throwOn = { method: 'remove', code: 'invalid_input', message: '环境变量给的删不掉' }
    expect((await call('DELETE', '/v1/models/providers/deepseek')).status).toBe(400)
  })
})

describe('WP25 网关：key 只经这一条路', () => {
  it('PUT 把 api_key 原样往下传一次，返回体里一个字节都没有', async () => {
    const { call, port } = await wired()
    const res = await call('PUT', '/v1/models/providers/deepseek', SAVE_BODY)
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain(SECRET.slice(0, 10))
    // 端口确实收到了原文（网关不篡改也不截断），而且只收到一次
    expect(port.saved).toHaveLength(1)
    expect(port.saved[0]?.api_key).toBe(SECRET)
    expect(port.calls.filter((c) => c === 'save')).toHaveLength(1)
  })

  it('列表 / 默认 / 花费 / 试跑四条路径的响应里都没有 key 字段', async () => {
    const { call } = await wired()
    await call('PUT', '/v1/models/providers/deepseek', SAVE_BODY)
    for (const [method, path] of [
      ['GET', '/v1/models/providers'],
      ['GET', '/v1/models/defaults'],
      ['GET', '/v1/models/usage'],
      ['POST', '/v1/models/providers/deepseek/test'],
    ] as [string, string][]) {
      const text = await (await call(method, path)).text()
      expect(text, path).not.toContain(SECRET)
      // 只查"有没有 api_key 这个 JSON 字段"——DeepSeek 控制台的外链里本来就带 api_keys
      expect(text, path).not.toContain('"api_key"')
    }
  })

  it('校验不过时错误信封里只有字段路径，不把值抄回来', async () => {
    const { call, port } = await wired()
    // model 缺失 → 400；body 里带着 key，但错误信封不许回显它
    const res = await call('PUT', '/v1/models/providers/deepseek', {
      kind: 'deepseek',
      api_key: SECRET,
    })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain(SECRET)
    expect(text).toContain('model')
    expect(port.calls).toEqual([])
  })

  it('key 太长（> 4096）直接顶回来，不往下传', async () => {
    const { call, port } = await wired()
    const res = await call('PUT', '/v1/models/providers/deepseek', {
      ...SAVE_BODY,
      api_key: 'x'.repeat(4097),
    })
    expect(res.status).toBe(400)
    expect(port.calls).toEqual([])
  })

  it('OpenAPI 文档里没有一处示例带 key 的值', async () => {
    const { h } = await wired()
    const dump = JSON.stringify(h.gateway.specs.filter((s) => s.path.startsWith('/v1/models')))
    expect(dump).not.toContain(SECRET)
    expect(dump).not.toContain('sk-')
  })
})

describe('WP25 网关：默认与花费', () => {
  it('只改一个 purpose 也接受（zod 的 record 对枚举是穷尽的，这里必须 partialRecord）', async () => {
    const { call, port } = await wired()
    const res = await call('PUT', '/v1/models/defaults', {
      by_purpose: { judge: 'deepseek/deepseek-chat' },
    })
    expect(res.status).toBe(200)
    expect(port.setDefaultsInput[0]?.by_purpose).toEqual({ judge: 'deepseek/deepseek-chat' })
  })

  it('不认识的 purpose 被顶回来', async () => {
    const { call } = await wired()
    const res = await call('PUT', '/v1/models/defaults', { by_purpose: { vibes: 'a/b' } })
    expect(res.status).toBe(400)
  })

  it('预算是数字且不能为负', async () => {
    const { call } = await wired()
    expect(
      (await call('PUT', '/v1/models/defaults', { budget: { workspace_daily_base: -1 } })).status,
    ).toBe(400)
    expect(
      (await call('PUT', '/v1/models/defaults', { budget: { workspace_daily_base: 10 } })).status,
    ).toBe(200)
  })

  it('usage 的 since 是查询参数，透传给端口', async () => {
    const { call } = await wired()
    const res = await call('GET', `/v1/models/usage?since=${encodeURIComponent(T0)}`)
    expect((await data<ModelUsageView>(res)).since).toBe(T0)
  })

  it('providers 一次回配置与模板两样（界面一次请求画完整页）', async () => {
    const { call } = await wired()
    const body = await data<{
      providers: ModelProviderView[]
      templates: ModelProviderTemplate[]
    }>(await call('GET', '/v1/models/providers'))
    expect(body.providers.map((p) => p.id)).toEqual(['deepseek'])
    expect(body.templates.map((t) => t.kind)).toEqual(['deepseek'])
  })
})

describe('WP25 网关：小工具', () => {
  it('六个 purpose（22 的五个 + WP23 的转写）', () => {
    expect([...MODEL_PURPOSES]).toEqual([
      'run',
      'extraction',
      'reflection',
      'embedding',
      'judge',
      'transcription',
    ])
  })

  it('parseModelId 拆 provider/model；模型名里的斜杠留给模型（本地模型常见）', () => {
    expect(parseModelId('deepseek/deepseek-chat')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    expect(parseModelId('ollama/library/llama3.1')).toEqual({
      provider: 'ollama',
      model: 'library/llama3.1',
    })
    expect(parseModelId('nope')).toBeUndefined()
    expect(parseModelId('/leading')).toBeUndefined()
    expect(parseModelId('trailing/')).toBeUndefined()
  })
})
