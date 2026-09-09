/**
 * WP33 D 的契约用例：**「第三方前端只靠 OpenAPI 就能接」**。
 *
 * 这个测试进程刻意**一个 workspace 包都不 import**——没有 `@agentsws/contracts`、
 * 没有 `@agentsws/api`、连 `@agentsws/sdk` 自己的运行时代码都不用。它只有三样东西：
 * `node:child_process` 起服务、`packages/sdk/openapi.json`（= 第三方唯一能拿到的资料）、
 * 和 `fetch`。走通的路是 36 §5 的第一屏：**登录 → 取岗位 → 取首页 → 批一张卡**。
 *
 * 每一步的路径、方法、请求体字段、鉴权头，都先从 openapi.json 里查出来再用；
 * 查不到就直接失败——那正说明「只有 OpenAPI 接不上」。
 *
 * 服务进程是**另一个进程**（`fixtures/serve.mjs`），它要读 `apps/server/dist`，
 * 所以这条用例依赖 `tsc -b` 已经跑过（CI 里 `tsc -b --force` 排在 vitest 前面）。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const SERVE = resolve(HERE, 'fixtures/serve.mjs')
const SERVER_DIST = resolve(ROOT, 'apps/server/dist/index.js')
const OPENAPI = resolve(ROOT, 'packages/sdk/openapi.json')

/** 第三方手里只有这一份东西。 */
interface OpenApi {
  openapi: string
  paths: Record<
    string,
    Record<
      string,
      {
        operationId: string
        parameters?: { name: string; in: string; required?: boolean }[]
        requestBody?: {
          content: Record<string, { schema: { properties?: Record<string, unknown> } }>
        }
        security?: unknown[]
      }
    >
  >
  components: { securitySchemes: Record<string, { type: string; scheme?: string }> }
  'x-asyncapi': { channels: Record<string, unknown> }
}

interface Booted {
  url: string
  email: string
  workspace_id: string
  assignment_id: string
  approval_id: string
}

let doc: OpenApi
let boot: Booted
let child: ReturnType<typeof spawn> | undefined

/** operationId → [路径模板, 方法]。第三方就是这样找路由的。 */
function operation(operationId: string): {
  path: string
  method: string
  op: OpenApi['paths'][string][string]
} {
  for (const [path, methods] of Object.entries(doc.paths))
    for (const [method, op] of Object.entries(methods))
      if (op.operationId === operationId) return { path, method, op }
  throw new Error(`openapi.json 里没有 operationId=${operationId}——第三方接不上`)
}

/** 按 OpenAPI 的声明发一次请求：路径参数、鉴权头、Assignment 头都照它说的填。 */
async function call(
  operationId: string,
  input: {
    path?: Record<string, string>
    body?: unknown
    token?: string
    assignment?: string
  } = {},
): Promise<{ status: number; data: unknown; body: unknown }> {
  const { path, method, op } = operation(operationId)
  let url = path
  for (const p of op.parameters ?? []) {
    if (p.in !== 'path') continue
    const value = input.path?.[p.name]
    if (value === undefined) throw new Error(`${operationId} 需要路径参数 ${p.name}`)
    url = url.replace(`{${p.name}}`, encodeURIComponent(value))
  }
  const headers: Record<string, string> = {}
  // 安全声明说要 bearer 才带（`security: []` 的那几条是公开的）
  const needsAuth = Array.isArray(op.security) && op.security.length > 0
  if (needsAuth) {
    if (input.token === undefined) throw new Error(`${operationId} 声明了 bearerAuth，但没给 token`)
    headers.Authorization = `Bearer ${input.token}`
  }
  if ((op.parameters ?? []).some((p) => p.in === 'header' && p.name === 'X-Assignment')) {
    if (input.assignment === undefined)
      throw new Error(`${operationId} 声明了 X-Assignment，但没给`)
    headers['X-Assignment'] = input.assignment
  }
  if (input.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${boot.url}${url}`, {
    method: method.toUpperCase(),
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
  const text = await res.text()
  const body: unknown = text === '' ? {} : JSON.parse(text)
  return { status: res.status, data: (body as { data?: unknown }).data, body }
}

beforeAll(async () => {
  expect(
    existsSync(SERVER_DIST),
    `找不到 ${SERVER_DIST}：这条用例要真起一个服务进程，先跑 \`pnpm exec tsc -b\``,
  ).toBe(true)
  doc = JSON.parse(readFileSync(OPENAPI, 'utf8')) as OpenApi

  const proc = spawn(process.execPath, [SERVE], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  child = proc
  const stderr: string[] = []
  proc.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()))
  boot = await new Promise<Booted>((resolveBoot, rejectBoot) => {
    const timer = setTimeout(() => {
      rejectBoot(new Error(`服务进程没起来：${stderr.join('')}`))
    }, 60_000)
    let buffered = ''
    proc.stdout?.on('data', (d: Buffer) => {
      buffered += d.toString()
      const line = buffered.split('\n').find((l) => l.trim().startsWith('{'))
      if (line === undefined) return
      clearTimeout(timer)
      resolveBoot(JSON.parse(line) as Booted)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      rejectBoot(new Error(`服务进程退出（${String(code)}）：${stderr.join('')}`))
    })
  })
}, 90_000)

afterAll(() => {
  child?.kill('SIGTERM')
})

describe('28 §4：第三方前端只靠 OpenAPI 就能接', () => {
  it('拿到的 openapi.json 就是服务进程在跑的那一份', async () => {
    const res = await fetch(`${boot.url}/openapi.json`)
    const live = (await res.json()) as OpenApi
    expect(live.openapi).toBe('3.1.0')
    // 路径集合逐条对得上（版本号会随发行版变，不比）
    expect(Object.keys(live.paths).sort()).toEqual(Object.keys(doc.paths).sort())
  })

  it('每条路由都有 operationId，且不重名（生成客户端的前提）', () => {
    const ids: string[] = []
    for (const methods of Object.values(doc.paths))
      for (const op of Object.values(methods)) ids.push(op.operationId)
    expect(ids.every((id) => id !== '' && id !== undefined)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('鉴权方式写在文档里（bearer），事件流写在 x-asyncapi 里', () => {
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    })
    expect(Object.keys(doc['x-asyncapi'].channels)).toContain('/v1/ws')
  })

  it('登录 → 取岗位 → 取首页 → 批一张卡，全程只照着 openapi.json 走', async () => {
    // 1. 登录（20 §3 magic-link：本地档一次性 token 直接回传）
    const issued = await call('issueMagicLink', { body: { email: boot.email } })
    expect(issued.status).toBe(200)
    const token = (issued.data as { token?: string }).token
    expect(token, '本地档应当直接回一次性 token').toBeTypeOf('string')

    const verified = await call('verifyMagicLink', { body: { token } })
    expect(verified.status).toBe(200)
    const session = (verified.data as { session_token: string }).session_token
    expect(session).toBeTypeOf('string')

    // 2. 我是谁 + 我有哪些岗位
    const me = await call('getMe', { token: session })
    expect(me.status).toBe(200)
    const assignments = (me.data as { assignments: { id: string; revoked_at?: string }[] })
      .assignments
    const assignment = assignments.find((a) => a.revoked_at === undefined)?.id
    expect(assignment).toBeTypeOf('string')

    const positions = await call('listPositions', { token: session, assignment })
    expect(positions.status).toBe(200)
    expect(
      (positions.data as { positions: { position_id: string }[] }).positions.length,
    ).toBeGreaterThan(0)

    // 3. 首页（29 §3 四区；数全在服务端算好）
    const home = await call('getHome', { token: session, assignment })
    expect(home.status).toBe(200)
    const queue = (
      home.data as {
        queue: { id: string; title: string; options?: { id: string; label: string }[] }[]
      }
    ).queue
    const card = queue.find((c) => c.id === boot.approval_id)
    expect(card, '刚建的那张卡应当在首页队列里').toBeDefined()

    // 4a. 选择题卡裸 approve 会被拒（36 §2.2 / 29 §7）——第三方从错误信封里就能学会该怎么发
    const bare = await call('decideApproval', {
      token: session,
      assignment,
      path: { id: boot.approval_id },
      body: { action: 'approve' },
    })
    expect(bare.status).toBe(400)
    expect((bare.body as { details: { reason: string } }).details.reason).toBe('OPTION_REQUIRED')

    // 4b. 带上选项再批（29 §5：动作打回宿主 API，不经模型）
    const option = card?.options?.[0]?.id
    expect(option).toBeTypeOf('string')
    const decided = await call('decideApproval', {
      token: session,
      assignment,
      path: { id: boot.approval_id },
      body: { action: 'approve', selected_option_id: option },
    })
    expect(decided.status).toBe(200)
    expect((decided.data as { state: string }).state).toMatch(/approved|applying|applied/)

    // 5. 批完之后队列里就没它了——第三方前端看到的是真状态，不是自己猜的
    const after = await call('getHome', { token: session, assignment })
    const queueAfter = (after.data as { queue: { id: string }[] }).queue
    expect(queueAfter.some((c) => c.id === boot.approval_id)).toBe(false)
  }, 30_000)

  it('错误也照文档来：没凭据 401、统一信封带 code 与 trace_id', async () => {
    const res = await fetch(`${boot.url}/v1/me`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string; message: string; trace_id: string }
    expect(body.code).toBe('unauthenticated')
    expect(body.trace_id).toBeTypeOf('string')
    expect(body.message).toBeTypeOf('string')
  })
})
