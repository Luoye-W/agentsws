/**
 * 网关这一层的连接面（WP20）：路由形状、权限元组、错误信封、以及
 * **「凭据只经 submit 这一条路，且不回到任何响应体里」**这条硬约束。
 *
 * 下游怎么连是 `apps/server` 的事，这里只用一个记账用的假端口。
 */
import { describe, expect, it } from 'vitest'
import type {
  ConnectionsPort,
  ConnectionView,
  ConnectTestResult,
  ProviderView,
  RuntimeStatusView,
} from '../src/index.js'
import { createGateway } from '../src/index.js'
import { harness } from './helpers.js'

const SECRET = 'shpat_gateway_never_echoes_this'
const T0 = '2026-09-07T09:00:00.000Z'

const CONNECTION: ConnectionView = {
  id: 'conn_1',
  service: 'shopify_admin',
  service_label: 'Shopify 店铺',
  alias: '主店',
  ownership: 'workspace',
  status: 'active',
  identity: { display_name: 'demo.myshopify.com' },
  credential_store: 'openconnector',
  data_sources: ['shop'],
}

const PROVIDER: ProviderView = {
  service: 'shopify_admin',
  label: 'Shopify 店铺',
  auth: 'api_key',
  fields: [
    { name: 'shop', label: '店铺域名', secret: false, required: true },
    { name: 'accessToken', label: '访问令牌', secret: true, required: true },
  ],
  available: true,
  data_sources: ['shop'],
  setup_guide: { summary: '建一个自定义应用', steps: ['一', '二'], links: [] },
}

const OK_TEST: ConnectTestResult = { ok: true, reason: 'ok', checked_at: T0 }

/** 记下每次调用与看到的字段名——用来断言值只往下走了一次。 */
class FakePort implements ConnectionsPort {
  readonly calls: string[] = []
  readonly seenFields: Record<string, string>[] = []
  connections: ConnectionView[] = []
  throwOn: { method: string; code: string; message: string } | undefined

  private guard(method: string): void {
    this.calls.push(method)
    if (this.throwOn?.method === method) {
      throw Object.assign(new Error(this.throwOn.message), { code: this.throwOn.code })
    }
  }

  providers(): ProviderView[] {
    this.guard('providers')
    return [PROVIDER]
  }

  list(): ConnectionView[] {
    this.guard('list')
    return this.connections
  }

  async begin(): Promise<{ request_id: string; secure_form: { fields: ProviderView['fields'] } }> {
    this.guard('begin')
    return { request_id: 'creq_1', secure_form: { fields: PROVIDER.fields } }
  }

  async pollRequest(): Promise<{ status: 'connected'; connection: ConnectionView }> {
    this.guard('poll')
    return { status: 'connected', connection: CONNECTION }
  }

  async submit(
    _actor: unknown,
    _service: string,
    input: { fields: Record<string, string> },
  ): Promise<{ connection: ConnectionView; test: ConnectTestResult }> {
    this.guard('submit')
    this.seenFields.push(input.fields)
    this.connections = [CONNECTION]
    return { connection: CONNECTION, test: OK_TEST }
  }

  async remove(): Promise<void> {
    this.guard('remove')
    this.connections = []
  }

  async test(): Promise<ConnectTestResult> {
    this.guard('test')
    return OK_TEST
  }

  async runtime(): Promise<RuntimeStatusView> {
    this.guard('runtime')
    return {
      state: 'unhardened',
      base_url: 'http://127.0.0.1:3000',
      reasons: ['encryption_disabled'],
      checks: [{ name: 'encryption', ok: false, detail: '没开静态加密' }],
      checked_at: T0,
      secrets_vault: { available: false, reason: '没有密钥' },
    }
  }
}

async function wired(): Promise<{
  h: Awaited<ReturnType<typeof harness>>
  port: FakePort
  call: (method: string, path: string, body?: unknown, assignment?: string) => Promise<Response>
}> {
  const h = await harness()
  const port = new FakePort()
  const gateway = createGateway({ ...h.deps, connections: port })
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

describe('WP20 网关：路由与信封', () => {
  it('七条路由都在 /v1/connections 之下，且都要 Bearer + X-Assignment', async () => {
    const { h } = await wired()
    const specs = h.gateway.specs.filter((s) => s.path.startsWith('/v1/connections'))
    expect(specs.map((s) => `${s.method.toUpperCase()} ${s.path}`).sort()).toEqual([
      'DELETE /v1/connections/:id',
      'GET /v1/connections',
      'GET /v1/connections/providers',
      'GET /v1/connections/requests/:id',
      'GET /v1/connections/runtime',
      'POST /v1/connections/:id/test',
      'POST /v1/connections/:service/begin',
      'POST /v1/connections/:service/submit',
    ])
    for (const s of specs) {
      expect(s.auth).toBe('bearer')
      expect(s.assignment).toBe(true)
      expect(s.authz).toBeDefined()
    }
  })

  it('定值段路由不会被 :service 抢走', async () => {
    const { call, port } = await wired()
    expect((await call('GET', '/v1/connections/providers')).status).toBe(200)
    expect((await call('GET', '/v1/connections/runtime')).status).toBe(200)
    expect((await call('GET', '/v1/connections/requests/creq_1')).status).toBe(200)
    expect(port.calls).toEqual(['providers', 'runtime', 'poll'])
  })

  it('没装配连接面时回 not_implemented（501），不是 500', async () => {
    const h = await harness()
    const gateway = createGateway({ ...h.deps })
    const res = await gateway.fetch(
      new Request('http://127.0.0.1/v1/connections', {
        headers: { Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id },
      }),
    )
    expect(res.status).toBe(501)
    expect(((await res.json()) as { code: string }).code).toBe('not_implemented')
  })

  it('下游错误按 code 归一（invalid_input → 400，not_found → 404）', async () => {
    const { call, port } = await wired()
    port.throwOn = { method: 'submit', code: 'invalid_input', message: '还有必填项没填：shop' }
    const res = await call('POST', '/v1/connections/shopify_admin/submit', {
      fields: { accessToken: SECRET },
    })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain('shop')
    expect(text).not.toContain(SECRET)
  })
})

describe('WP20 网关：凭据零泄漏', () => {
  it('submit 的字段值只往端口走一次，响应体与清单里都没有', async () => {
    const { call, port } = await wired()
    const res = await call('POST', '/v1/connections/shopify_admin/submit', {
      alias: '主店',
      fields: { shop: 'demo.myshopify.com', accessToken: SECRET },
    })
    expect(res.status).toBe(200)
    expect(port.seenFields).toEqual([{ shop: 'demo.myshopify.com', accessToken: SECRET }])

    const body = await res.text()
    expect(body).not.toContain(SECRET)

    const listed = await call('GET', '/v1/connections')
    const listedText = await listed.text()
    expect(listedText).not.toContain(SECRET)
    expect(listedText).not.toContain('accessToken')
  })

  it('空 fields 直接 400，不惊动端口', async () => {
    const { call, port } = await wired()
    const res = await call('POST', '/v1/connections/shopify_admin/submit', { fields: {} })
    expect(res.status).toBe(400)
    expect(port.calls).toEqual([])
  })

  it('fields 的值必须是字符串；校验失败的信封里只有字段路径', async () => {
    const { call, port } = await wired()
    const res = await call('POST', '/v1/connections/shopify_admin/submit', {
      fields: { accessToken: { nested: SECRET } },
    })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain('fields.accessToken')
    expect(text).not.toContain(SECRET)
    expect(port.calls).toEqual([])
  })

  it('GET /v1/connections 的 OpenAPI 说明里没有任何凭据字段', async () => {
    const { h } = await wired()
    const spec = h.gateway.specs.find((s) => s.operationId === 'listConnections')
    expect(spec?.returns).not.toContain('password')
    expect(spec?.body).toBeUndefined()
  })
})

describe('WP20 网关：权限（31 §3.1 完整元组）', () => {
  it('读走 store_config.read@workspace，改走 policy.stage@workspace', async () => {
    const { h } = await wired()
    const read = h.gateway.specs.find((s) => s.operationId === 'listConnections')
    expect(read?.authz).toEqual({
      domain: 'store_config',
      op: 'read',
      range: 'workspace',
      sensitivity: 'internal',
    })
    const write = h.gateway.specs.find((s) => s.operationId === 'submitConnectionForm')
    expect(write?.authz).toEqual({
      domain: 'policy',
      op: 'stage',
      range: 'workspace',
      sensitivity: 'restricted',
    })
  })

  it('权限不够的 Assignment 一律 403，端口一次都没被调到', async () => {
    const { call, port } = await wired()
    for (const [method, path] of [
      ['GET', '/v1/connections'],
      ['GET', '/v1/connections/providers'],
      ['POST', '/v1/connections/shopify_admin/begin'],
      ['DELETE', '/v1/connections/conn_1'],
    ] as const) {
      expect((await call(method, path, undefined, 'asg_weak')).status).toBe(403)
    }
    expect(port.calls).toEqual([])
  })

  it('缺 X-Assignment 就 400（一次请求一个 Assignment）', async () => {
    const h = await harness()
    const gateway = createGateway({ ...h.deps, connections: new FakePort() })
    const res = await gateway.fetch(
      new Request('http://127.0.0.1/v1/connections', {
        headers: { Authorization: `Bearer ${h.token}` },
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('WP20 网关：向导与状态条', () => {
  it('begin 回表单描述，字段带 secret 标记', async () => {
    const { call } = await wired()
    const begun = await data<{
      request_id: string
      secure_form: { fields: { secret: boolean }[] }
    }>(await call('POST', '/v1/connections/shopify_admin/begin', { alias: '主店' }))
    expect(begun.request_id).toBe('creq_1')
    expect(begun.secure_form.fields.some((f) => f.secret)).toBe(true)
  })

  it('runtime 状态条把加固失败的原因原样带出来', async () => {
    const { call } = await wired()
    const status = await data<RuntimeStatusView>(await call('GET', '/v1/connections/runtime'))
    expect(status.state).toBe('unhardened')
    expect(status.reasons).toEqual(['encryption_disabled'])
    expect(status.secrets_vault.available).toBe(false)
  })

  it('test 与 delete 都是幂等安全的：删完清单就空了', async () => {
    const { call, port } = await wired()
    await call('POST', '/v1/connections/shopify_admin/submit', {
      fields: { shop: 'x', accessToken: SECRET },
    })
    expect(
      (await data<{ connections: unknown[] }>(await call('GET', '/v1/connections'))).connections,
    ).toHaveLength(1)
    expect(
      await data<ConnectTestResult>(await call('POST', '/v1/connections/conn_1/test')),
    ).toEqual(OK_TEST)
    expect((await call('DELETE', '/v1/connections/conn_1')).status).toBe(200)
    expect(
      (await data<{ connections: unknown[] }>(await call('GET', '/v1/connections'))).connections,
    ).toEqual([])
    expect(port.calls).toContain('remove')
  })
})
