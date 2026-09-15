/**
 * 在线值守在本地这一面（WP60；49 §6 / 48 L7 / 41 §2.4）。
 *
 * 用一个假云侧（注入 `fetch`）跑完两个方向：切上去、接回来。钉四件事：
 *
 * 1. **没关联账号不是错**：`linked: false` + 一句人话，界面据此换按钮；
 * 2. 切档的顺序是"导出 → 上传 → 开通"，而且令牌**只在 Authorization 头里出现**；
 * 3. 余额不足原样透传云侧那句人话，不自己编第二句；
 * 4. 接回本机是"**先落包、后停云**"——反过来会留下一个哪儿都不在跑的工作区。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { CLOUD_TOKEN_SECRET_ID } from '../src/models.js'
import { createStandby, embedSnippet, publicUrlOf, type StandbyFetch } from '../src/standby.js'

const CLOUD = 'https://cloud.example.test'
const ACTOR = { workspace_id: 'ws_1', person_id: 'p_1', assignment_id: 'as_1' }

const clock: Clock = { now: () => '2026-09-15T09:00:00.000Z' }

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  bytes: number
}

/** 假云侧。每一跳都记下来（断言令牌只在头里、路径与查询串对不对）。 */
function fakeCloud(
  over: { status?: Record<string, unknown>; importStatus?: number; importBody?: unknown } = {},
): { fetch: StandbyFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: StandbyFetch = (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      bytes: init.body?.byteLength ?? 0,
    })
    const json = (value: unknown, status = 200) =>
      Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(value),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      })
    if (url.endsWith('/v1/standby/workspaces')) return json({ workspaces: [], seat_price: 99 })
    if (url.includes('/import'))
      return json(
        over.importBody ?? { status: 'starting', period_end: '2026-10-15T09:00:00.000Z' },
        over.importStatus ?? 201,
      )
    if (url.endsWith('/export'))
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        arrayBuffer: () =>
          Promise.resolve(new TextEncoder().encode('PK-fake-zip').buffer as ArrayBuffer),
      })
    if (url.endsWith('/stop')) return json({ status: 'stopped' })
    return json(
      over.status ?? {
        workspace_id: 'ws_1',
        status: 'running',
        seats: 1,
        period_end: '2026-10-15T09:00:00.000Z',
      },
    )
  }
  return { fetch: fetchImpl, calls }
}

let server: Server
let dataDir: string

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'agentsws-standby-local-'))
  server = await createServer({
    quiet: true,
    dbDir: dataDir,
    clock,
    env: {
      AGENTSWS_OWNER_EMAIL: 'luoye@example.com',
      AGENTSWS_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
  })
})

afterEach(async () => {
  await server.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function standbyOf(over: Parameters<typeof fakeCloud>[0] = {}, linked = true) {
  if (linked) server.secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'wst_local_demo' })
  const cloud = fakeCloud(over)
  const assembly = createStandby({
    workspace_id: server.bootstrap.workspace.id,
    clock,
    secrets: server.secrets,
    env: { AGENTSWS_CLOUD_BASE_URL: CLOUD, AGENTSWS_BACKUP_DIR: join(dataDir, 'backups') },
    dbDir: dataDir,
    fetch: cloud.fetch,
  })
  return { port: assembly.port, calls: cloud.calls }
}

describe('状态', () => {
  it('没关联账号：linked: false + 一句人话，不是错', async () => {
    const s = standbyOf({}, false)
    const view = await s.port.view(ACTOR)
    expect(view.linked).toBe(false)
    expect(view.reason).toContain('关联')
    expect(view.remote).toBe(false)
    // 一跳都没打：没账号的时候不该去敲云
    expect(s.calls).toHaveLength(0)
  })

  it('关联了：状态、座位单价、嵌入脚本全是云上那一份的透传', async () => {
    const s = standbyOf()
    const view = await s.port.view(ACTOR)
    expect(view.linked).toBe(true)
    expect(view.cloud?.status).toBe('running')
    expect(view.seat_price).toBe(99)
    expect(view.embed_snippet).toContain('/widget.js')
    // 令牌只在 Authorization 头里，一次都没进 URL
    for (const call of s.calls) {
      expect(call.headers.authorization).toBe('Bearer wst_local_demo')
      expect(call.url).not.toContain('wst_')
    }
  })
})

describe('切到云上', () => {
  it('导出 → 上传 → 开通：包真的打出来了，传上去的字节数对得上', async () => {
    const s = standbyOf()
    const out = await s.port.switchToCloud(ACTOR, { seats: 2 })

    expect(out.status).toBe('starting')
    expect(out.remote_url).toBe(publicUrlOf(CLOUD, server.bootstrap.workspace.id))
    expect(out.embed_snippet).toBe(embedSnippet(CLOUD, server.bootstrap.workspace.id))
    expect(out.bytes).toBeGreaterThan(0)

    const upload = s.calls.find((c) => c.url.includes('/import'))
    expect(upload?.method).toBe('POST')
    expect(upload?.url).toContain('seats=2')
    expect(upload?.headers['content-type']).toBe('application/zip')
    expect(upload?.bytes).toBe(out.bytes)

    // 本地那一份包也留着（它就是这次搬家的凭证）
    expect(readdirSync(join(dataDir, 'backups')).some((f) => f.startsWith('standby-'))).toBe(true)
  })

  it('余额不足：原样透传云侧那句人话，不自己编第二句', async () => {
    const s = standbyOf({
      importStatus: 402,
      importBody: { code: 'insufficient_credits', message: '开一个月的值守要 99 积分，余额不够。' },
    })
    await expect(s.port.switchToCloud(ACTOR, { seats: 1 })).rejects.toThrow('余额不够')
  })

  it('没关联账号就切不了（而且一个包都不打）', async () => {
    const s = standbyOf({}, false)
    await expect(s.port.switchToCloud(ACTOR, { seats: 1 })).rejects.toThrow('关联')
    expect(existsSync(join(dataDir, 'backups'))).toBe(false)
  })
})

describe('接回本机', () => {
  it('先落包、后停云：顺序反了会留下一个哪儿都不在跑的工作区', async () => {
    const s = standbyOf()
    const out = await s.port.bringHome(ACTOR)

    expect(out.bytes).toBeGreaterThan(0)
    expect(existsSync(out.out)).toBe(true)
    expect(out.stopped).toBe(true)
    // 下一步是人话，而且明说"导入不能在跑着的进程底下做"
    expect(out.next).toContain('agentsws import')
    expect(out.next).toContain('没在跑')

    const order = s.calls.map((c) =>
      c.url.endsWith('/export') ? 'export' : c.url.endsWith('/stop') ? 'stop' : 'other',
    )
    expect(order.indexOf('export')).toBeLessThan(order.indexOf('stop'))
  })
})
