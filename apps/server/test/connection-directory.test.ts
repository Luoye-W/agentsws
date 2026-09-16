/**
 * 连接目录与岗位连接清单端到端（WP83，54（将改号 55）§4 前两层）。
 *
 * 起真服务进程 → 看目录 → 看岗位清单 → 连上邮箱 → 清单少一条 →
 * 登记一台自定义 MCP 服务器（真的起一个假的 stdio server 连一次）→ 删掉。
 *
 * 凭据那条线（13 §4.3）照连接向导的老规矩断言：MCP 的请求头**值**一个字节都不许
 * 出现在响应体、事件日志、落盘文件里。
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionDirectoryItemView, PositionConnectionsView } from '@agentsws/api'
import type { EventEnvelope, McpServerRecord } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-09-16T09:00:00.000Z'
const SECRETS_KEY = 'a'.repeat(64)
/** 这个用例里唯一的"凭据"。零泄漏断言全盯着这一串。 */
const MCP_TOKEN = 'Bearer mcp-Zq7-never-logged-token'
const FAKE_MCP = join(import.meta.dirname, 'fixtures/fake-mcp-server.mjs')

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 7): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Ctx {
  server: Server
  url: string
  dir: string
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

const post = (path: string, body?: unknown): Promise<Response> =>
  api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

const directory = async (): Promise<ConnectionDirectoryItemView[]> =>
  (await data<{ entries: ConnectionDirectoryItemView[] }>(await api('/v1/connection-directory')))
    .entries

const entryOf = async (kind: string): Promise<ConnectionDirectoryItemView> => {
  const found = (await directory()).find((e) => e.kind === kind)
  if (found === undefined) throw new Error(`目录里没有 ${kind}`)
  return found
}

async function allEvents(): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for await (const e of ctx.server.kernel.eventLog.read({
    workspace_id: ctx.server.bootstrap.workspace.id,
    limit: 5000,
  }))
    out.push(e)
  return out
}

/** 数据目录里所有文件的字节（落盘零泄漏断言）。 */
function allFileBytes(dir: string): Buffer[] {
  const out: Buffer[] = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name)
    if (d.isDirectory()) out.push(...allFileBytes(full))
    else out.push(readFileSync(full))
  }
  return out
}

/** 连一个邮箱（连上之后岗位清单里那一条该消失）。 */
async function connectMailbox(): Promise<void> {
  const res = await post('/v1/connections/imap_smtp/submit', {
    alias: 'support',
    fields: {
      email: 'support@yourbrand.com',
      password: 'app-password-not-under-test',
      // 连不上的地址：试连失败不影响"这条连接建出来了"
      imap_host: '127.0.0.1',
      imap_port: '1',
      smtp_host: '127.0.0.1',
      smtp_port: '2',
    },
  })
  expect(res.status).toBe(200)
}

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-directory-'))
  const server = await createServer({
    dbDir: dir,
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    env: { [SECRETS_KEY_ENV]: SECRETS_KEY },
    tokenRefreshIntervalMs: 0,
  })
  const { url } = await server.listen(0)
  ctx = { server, url, dir }
})

afterEach(async () => {
  await ctx.server.close()
})

describe('54 §4 第一层：GET /v1/connection-directory', () => {
  it('端出整张登记表，每一条都带运行时状态', async () => {
    const entries = await directory()
    expect(entries.length).toBeGreaterThan(15)
    for (const e of entries) {
      expect(['connected', 'not_connected', 'error']).toContain(e.state)
      expect(e.name.zh.length).toBeGreaterThan(0)
      expect(e.name.en.length).toBeGreaterThan(0)
    }
    // 一开始什么都没连
    expect(entries.every((e) => e.state === 'not_connected')).toBe(true)
  })

  it('目录里没有凭据、也没有任何一条真实连接的账号 id（13 §4.3 / 36 §2）', async () => {
    await connectMailbox()
    const raw = await (await api('/v1/connection-directory')).text()
    expect(raw).not.toContain('app-password-not-under-test')
    // 目录说的是"哪一类东西"，不是"你连了哪个账号"
    expect(raw).not.toContain('support@yourbrand.com')
    expect(raw).not.toContain('conn_mail')
  })

  it('连上邮箱之后那一条变成"已连"，别的不动', async () => {
    expect((await entryOf('email')).state).toBe('not_connected')
    await connectMailbox()
    expect((await entryOf('email')).state).toBe('connected')
    expect((await entryOf('shopify')).state).toBe('not_connected')
  })

  it('`shop` 按公司档案解析成点得动的那张卡（51 §1 N0）', async () => {
    // 缺省档案就是 Shopify
    expect((await entryOf('shop')).connect_service).toBe('shopify_admin')
    await api('/v1/workspace/profile', {
      method: 'PUT',
      body: JSON.stringify({
        legal_name: '测试有限公司',
        discoverable: false,
        storefront_platform: 'magento',
      }),
    })
    // Magento 根本没有 provider：点进去无处可点的按钮比没有它更糟
    expect((await entryOf('shop')).connect_service).toBeUndefined()
  })

  it('还没做的那几条明着标出来，不藏（微信两条指到 /im-channels）', async () => {
    const planned = (await directory()).filter((e) => e.status === 'planned')
    expect(planned.map((e) => e.kind)).toContain('amazon_sp')
    expect(planned.map((e) => e.kind)).toContain('wechat_clawbot')
    expect((await entryOf('wecom_bot')).docs_url).toBe('/im-channels')
  })
})

describe('54 §4 第二层：GET /v1/positions/:id/connections', () => {
  it('并集 − 已连：客服岗位三条职责的连接器合成一张清单', async () => {
    for (const role_id of ['dtc.support', 'dtc.live-chat', 'amz.support'])
      ctx.server.roles.assignments.create({
        person_id: ctx.server.bootstrap.person.id,
        workspace_id: ctx.server.bootstrap.workspace.id,
        role_id,
        granted_by: ctx.server.bootstrap.person.id,
      })
    const view = await data<PositionConnectionsView>(
      await api('/v1/positions/customer-care/connections'),
    )
    expect(view.position_name).toBe('客服')
    const kinds = view.items.map((i) => i.kind)
    // 三条职责各自的连接器都进来了，而且**去了重**（邮箱三条职责都要，只出现一次）
    expect(kinds).toContain('email')
    expect(kinds).toContain('shopify')
    expect(kinds).toContain('chat_widget')
    expect(kinds.filter((k) => k === 'email')).toHaveLength(1)
    expect(new Set(kinds).size).toBe(kinds.length)
    // "哪几条职责要它"说的是名字，不出 id（36 §2）
    const email = view.items.find((i) => i.kind === 'email')
    expect(email?.needed_by.length).toBeGreaterThan(1)
    expect(email?.needed_by.join('')).not.toContain('dtc.')
  })

  it('required 的没连 = 未就绪；必需的排在前面', async () => {
    ctx.server.roles.assignments.create({
      person_id: ctx.server.bootstrap.person.id,
      workspace_id: ctx.server.bootstrap.workspace.id,
      role_id: 'dtc.support',
      granted_by: ctx.server.bootstrap.person.id,
    })
    const view = await data<PositionConnectionsView>(
      await api('/v1/positions/customer-care/connections'),
    )
    expect(view.ready).toBe(false)
    expect(view.missing_required).toContain('email')
    const firstOptional = view.items.findIndex((i) => !i.required)
    const lastRequired = view.items.map((i) => i.required).lastIndexOf(true)
    if (firstOptional >= 0) expect(lastRequired).toBeLessThan(firstOptional)
  })

  it('连上一个，卡上就少一条', async () => {
    ctx.server.roles.assignments.create({
      person_id: ctx.server.bootstrap.person.id,
      workspace_id: ctx.server.bootstrap.workspace.id,
      role_id: 'dtc.support',
      granted_by: ctx.server.bootstrap.person.id,
    })
    const before = await data<PositionConnectionsView>(
      await api('/v1/positions/customer-care/connections'),
    )
    expect(before.items.map((i) => i.kind)).toContain('email')
    await connectMailbox()
    const after = await data<PositionConnectionsView>(
      await api('/v1/positions/customer-care/connections'),
    )
    expect(after.items.map((i) => i.kind)).not.toContain('email')
    expect(after.missing_required).not.toContain('email')
    expect(after.items.length).toBe(before.items.length - 1)
  })

  it('给本人持有的 assignment_id 也认（岗位页递的就是它）', async () => {
    const assignment = ctx.server.roles.assignments.create({
      person_id: ctx.server.bootstrap.person.id,
      workspace_id: ctx.server.bootstrap.workspace.id,
      role_id: 'dtc.content',
      granted_by: ctx.server.bootstrap.person.id,
    })
    const view = await data<PositionConnectionsView>(
      await api(`/v1/positions/${assignment.id}/connections`),
    )
    expect(view.position_id).toBe('web-ops')
    // `dtc.content` 要 Search Console（职责模板写 `search_console`）——目录里查得到名字
    const gsc = view.items.find((i) => i.kind === 'search_console')
    expect(gsc?.name.zh).toBe('Google Search Console')
    expect(gsc?.connect_service).toBe('gsc')
  })

  it('不认识的岗位回 404（不是 500、也不是一张空卡）', async () => {
    expect((await api('/v1/positions/nope/connections')).status).toBe(404)
  })

  it('清单里每一条的名字都查得到——目录漏一个 kind 这里就红', async () => {
    for (const position of ['customer-care', 'web-ops', 'kol-marketing', 'owner']) {
      const view = await data<PositionConnectionsView>(
        await api(`/v1/positions/${position}/connections`),
      )
      for (const item of view.items) expect(item.name.zh, item.kind).not.toBe(item.kind)
    }
  })
})

describe('自定义 MCP 服务器：保存 / 校验 / 探测（不接进运行时）', () => {
  it('登记一台真的 stdio server，连一次把它的工具列出来', async () => {
    const res = await post('/v1/connection-directory/mcp-servers', {
      name: 'fake-tools',
      transport: 'stdio',
      command: process.execPath,
      args: [FAKE_MCP],
    })
    expect(res.status).toBe(201)
    const row = await data<McpServerRecord>(res)
    expect(row.probe?.ok).toBe(true)
    expect(row.probe?.tools.map((t) => t.name)).toEqual(['echo', 'add'])
    expect(row.probe?.tools[0]?.description).toBe('把你说的话原样说回来')
    // 目录上那一条跟着变成"已连"
    expect((await entryOf('mcp_server')).state).toBe('connected')
  })

  it('连不上的照实说，不假装成功', async () => {
    const row = await data<McpServerRecord>(
      await post('/v1/connection-directory/mcp-servers', {
        name: 'broken',
        transport: 'stdio',
        command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures/there-is-no-such-file.mjs')],
      }),
    )
    expect(row.probe?.ok).toBe(false)
    expect(row.probe?.reason).toBe('probe_failed')
    expect(row.probe?.tools).toEqual([])
    const entry = await entryOf('mcp_server')
    expect(entry.state).toBe('error')
    expect(entry.state_detail?.length).toBeGreaterThan(0)
  })

  it('请求头的值只进加密库：响应、事件、落盘一个字节都没有', async () => {
    const row = await data<McpServerRecord>(
      await post('/v1/connection-directory/mcp-servers', {
        name: 'with-headers',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP],
        headers: { Authorization: MCP_TOKEN },
      }),
    )
    // 记录里只有**名字**
    expect(row.header_names).toEqual(['Authorization'])
    expect(JSON.stringify(row)).not.toContain(MCP_TOKEN)
    const listed = await (await api('/v1/connection-directory/mcp-servers')).text()
    expect(listed).toContain('with-headers')
    expect(listed).not.toContain(MCP_TOKEN)
    for (const e of await allEvents()) expect(JSON.stringify(e)).not.toContain(MCP_TOKEN)
    for (const bytes of allFileBytes(ctx.dir)) expect(bytes.includes(MCP_TOKEN)).toBe(false)
  })

  it('校验不过的当场拒，不留半条记录', async () => {
    const res = await post('/v1/connection-directory/mcp-servers', {
      name: 'Bad Name',
      transport: 'stdio',
      command: 'x',
    })
    expect(res.status).toBe(400)
    const { servers } = await data<{ servers: McpServerRecord[] }>(
      await api('/v1/connection-directory/mcp-servers'),
    )
    expect(servers).toEqual([])
  })

  it('streamable-http 的明文 http 地址一律拒（那等于把 token 交出去）', async () => {
    const res = await post('/v1/connection-directory/mcp-servers', {
      name: 'remote',
      transport: 'streamable-http',
      url: 'http://example.com/mcp',
    })
    expect(res.status).toBe(400)
  })

  it('再探测一次、删掉；删掉之后目录那一条回到"未连"', async () => {
    await post('/v1/connection-directory/mcp-servers', {
      name: 'fake-tools',
      transport: 'stdio',
      command: process.execPath,
      args: [FAKE_MCP, '--silent'],
    })
    const again = await data<McpServerRecord>(
      await post('/v1/connection-directory/mcp-servers/fake-tools/probe'),
    )
    // 连上了、但它一个工具都没有：这也算成功
    expect(again.probe?.ok).toBe(true)
    expect(again.probe?.tools).toEqual([])

    expect(
      (await api('/v1/connection-directory/mcp-servers/nope/probe', { method: 'POST' })).status,
    ).toBe(404)

    const removed = await data<{ removed: boolean }>(
      await api('/v1/connection-directory/mcp-servers/fake-tools', { method: 'DELETE' }),
    )
    expect(removed.removed).toBe(true)
    expect((await entryOf('mcp_server')).state).toBe('not_connected')
    expect(
      (
        await data<{ removed: boolean }>(
          await api('/v1/connection-directory/mcp-servers/fake-tools', { method: 'DELETE' }),
        )
      ).removed,
    ).toBe(false)
  })

  it('重启之后登记还在（落盘的是元数据，凭据仍在加密库里）', async () => {
    await post('/v1/connection-directory/mcp-servers', {
      name: 'fake-tools',
      transport: 'stdio',
      command: process.execPath,
      args: [FAKE_MCP],
      headers: { Authorization: MCP_TOKEN },
    })
    await ctx.server.close()
    const server = await createServer({
      dbDir: ctx.dir,
      clock: makeClock(),
      random: seeded(),
      quiet: true,
      env: { [SECRETS_KEY_ENV]: SECRETS_KEY },
      tokenRefreshIntervalMs: 0,
    })
    const { url } = await server.listen(0)
    ctx = { ...ctx, server, url }
    const { servers } = await data<{ servers: McpServerRecord[] }>(
      await api('/v1/connection-directory/mcp-servers'),
    )
    expect(servers.map((s) => s.name)).toEqual(['fake-tools'])
    expect(servers[0]?.header_names).toEqual(['Authorization'])
    // 探测照样跑得起来 = 加密库里那个头还在
    const again = await data<McpServerRecord>(
      await post('/v1/connection-directory/mcp-servers/fake-tools/probe'),
    )
    expect(again.probe?.ok).toBe(true)
  })
})

describe('WP86（55 §4 第三层）：只读清单与接进运行时', () => {
  it('勾出只读工具：保存时不必把请求头再发一遍，加密库里那把照样在', async () => {
    await post('/v1/connection-directory/mcp-servers', {
      name: 'fake-tools',
      transport: 'stdio',
      command: process.execPath,
      args: [FAKE_MCP],
      headers: { Authorization: MCP_TOKEN },
    })
    // 第二次提交只带 read_tools —— **不带 headers**
    const row = await data<McpServerRecord>(
      await post('/v1/connection-directory/mcp-servers', {
        name: 'fake-tools',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP],
        read_tools: ['echo'],
      }),
    )
    expect(row.read_tools).toEqual(['echo'])
    // 头还在（名字还在 = 加密库里那把没被清掉；探测能跑通更是硬证据）
    expect(row.header_names).toEqual(['Authorization'])
    expect(row.probe?.ok).toBe(true)
    // 还是一个字节都查不到
    expect(JSON.stringify(row)).not.toContain('mcp-Zq7-never-logged-token')
  })

  it('只读清单里带前缀的名字当场被拒（方向填反了会静默地更严）', async () => {
    const res = await post('/v1/connection-directory/mcp-servers', {
      name: 'fake-tools',
      transport: 'stdio',
      command: process.execPath,
      args: [FAKE_MCP],
      read_tools: ['mcp__fake-tools__echo'],
    })
    expect(res.status).toBe(400)
  })

  it('改了别的字段不会把勾好的只读清单清空', async () => {
    await post('/v1/connection-directory/mcp-servers', {
      name: 'fake-tools',
      transport: 'stdio',
      command: process.execPath,
      args: [FAKE_MCP],
      read_tools: ['echo', 'add'],
    })
    const row = await data<McpServerRecord>(
      await post('/v1/connection-directory/mcp-servers', {
        name: 'fake-tools',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP],
      }),
    )
    expect(row.read_tools).toEqual(['add', 'echo'])
  })
})
