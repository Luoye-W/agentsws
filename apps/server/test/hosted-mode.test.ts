/**
 * WP128：托管实例模式（容器里那一份 `apps/server`）。
 *
 * 全替身：云端是一个假 fetch（记下推上来的快照、按需回一份），WebSocket 是全局替身
 * （记下握手那一帧），一个字节不出这台机器。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHostedEnv } from '@agentsws/hosted'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { exportWorkspace } from '../src/backup.js'
import {
  createHostedOwnerClient,
  ensureCloudModelDefault,
  type HostedFetch,
  hostedModeOf,
  hostedTargetOf,
  type OwnerFetch,
  pushHostedSnapshot,
  restoreHostedSnapshot,
  seedHostedSecrets,
} from '../src/hosted-mode.js'
import { createSecretStore } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

const KEY = 'a'.repeat(64)
const WS = 'ws_hosted_srv'
const clock = { now: () => '2026-09-23T10:00:00.000Z' }

const hostedEnv = (): Record<string, string> =>
  buildHostedEnv({
    cloud_base_url: 'https://cloud.example.test',
    key: KEY,
    tenants: [{ workspace_id: WS, cloud_token: 'wst_hosted_x.y', relay_pairing: 'hrp_test' }],
  })

const temps: string[] = []
const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `agentsws-hosted-${name}-`))
  temps.push(dir)
  return dir
}
const live: Server[] = []

afterEach(async () => {
  for (const s of live.splice(0)) await s.close()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 一个假的云：记下 PUT 上来的快照；GET 回最近那一份（或 204）。 */
function fakeCloud(initial?: { body: Uint8Array; source: 'hosted' | 'local' }): {
  fetch: HostedFetch
  calls: { method: string; url: string; auth?: string; bytes?: number }[]
  stored: { body: Uint8Array; source: 'hosted' | 'local' } | undefined
} {
  const state = {
    calls: [] as { method: string; url: string; auth?: string; bytes?: number }[],
    stored: initial,
  }
  const fetch: HostedFetch = async (url, init) => {
    state.calls.push({
      method: init.method,
      url,
      ...(init.headers.Authorization === undefined ? {} : { auth: init.headers.Authorization }),
      ...(init.body === undefined ? {} : { bytes: init.body.byteLength }),
    })
    if (init.method === 'PUT') {
      state.stored = { body: init.body ?? new Uint8Array(), source: 'hosted' }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    }
    const found = state.stored
    if (found === undefined)
      return {
        ok: true,
        status: 204,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    return {
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n === 'x-agentsws-snapshot-source' ? found.source : null) },
      arrayBuffer: async () => found.body.slice().buffer,
    }
  }
  return {
    fetch,
    get calls() {
      return state.calls
    },
    get stored() {
      return state.stored
    },
  }
}

/** 造一个像样的数据目录（一个库 + 一个秘密库），导成一个包的字节。 */
function packageBytes(): Uint8Array {
  const dir = temp('src')
  const db = new Database(join(dir, 'events.db'))
  db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('对话')")
  db.close()
  const secrets = new Database(join(dir, 'secrets.sqlite'))
  secrets.exec('CREATE TABLE s (x TEXT)')
  secrets.close()
  const out = join(temp('pkg'), 'p.zip')
  exportWorkspace({ dataDir: dir, workspace_id: WS as never, out, clock })
  return new Uint8Array(readFileSync(out))
}

describe('托管模式：开关与配置', () => {
  it('没开 = 本机那一份；开了缺配置就抛（不起半残的托管实例）', () => {
    expect(hostedModeOf({})).toBeUndefined()
    expect(() => hostedModeOf({ AGENTSWS_HOSTED: '1' })).toThrow(/缺启动配置/)
    const config = hostedModeOf(hostedEnv())
    expect(config?.relay_endpoint).toBe(`https://cloud.example.test/relay/${WS}`)
  })

  it('接托管的品牌：是这家公司的品牌就是它，否则 bootstrap（空库起）', () => {
    const config = hostedModeOf(hostedEnv()) as NonNullable<ReturnType<typeof hostedModeOf>>
    expect(hostedTargetOf(config, 'ws_boot' as never, ['ws_boot', WS] as never)).toBe(WS)
    expect(hostedTargetOf(config, 'ws_boot' as never, ['ws_boot'] as never)).toBe('ws_boot')
  })

  it('种钥匙：托管令牌进 cloud.workspace_token，转发器地址与配对进 chat.relay', () => {
    const secrets = createSecretStore({
      dbPath: ':memory:',
      clock,
      env: { AGENTSWS_SECRETS_KEY: KEY },
    })
    const config = hostedModeOf(hostedEnv()) as NonNullable<ReturnType<typeof hostedModeOf>>
    expect(seedHostedSecrets(secrets, config)).toBe(true)
    expect(secrets.get('cloud.workspace_token')?.token).toBe('wst_hosted_x.y')
    expect(secrets.get('chat.relay')).toEqual({
      endpoint: `https://cloud.example.test/relay/${WS}`,
      pairing_token: 'hrp_test',
    })
    secrets.close()
  })

  it('默认模型换成云那一条；别的 provider 留着，按用途的指派清掉', () => {
    const dir = temp('models')
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: 'deepseek',
            kind: 'openai_compatible',
            label: 'x',
            base_url: 'u',
            model: 'm',
            region: 'cn',
          },
        ],
        defaults: { default: 'deepseek', by_purpose: { run: 'deepseek' } },
        tests: {},
      }),
    )
    const config = hostedModeOf(hostedEnv()) as NonNullable<ReturnType<typeof hostedModeOf>>
    ensureCloudModelDefault(dir, config, { label: '云', model: 'deepseek-flash', region: 'cn' })
    const state = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')) as {
      providers: { id: string; kind: string; base_url: string }[]
      defaults: { default: string; by_purpose: Record<string, string> }
    }
    expect(state.providers.map((p) => p.id)).toEqual(['deepseek', 'agentsws_cloud'])
    expect(state.providers[1]?.base_url).toBe('https://cloud.example.test/v1/ai')
    expect(state.defaults).toEqual({ default: 'agentsws_cloud', by_purpose: {} })
  })
})

describe('托管模式：快照（起来先拉、定时推）', () => {
  it('云端没有快照 → 从空库起', async () => {
    const cloud = fakeCloud()
    const config = hostedModeOf(hostedEnv()) as NonNullable<ReturnType<typeof hostedModeOf>>
    const dataDir = temp('data')
    expect(await restoreHostedSnapshot({ config, dataDir, fetch: cloud.fetch })).toBe('empty')
    expect(cloud.calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://cloud.example.test/v1/hosted/snapshot',
      auth: 'Bearer wst_hosted_x.y',
    })
  })

  it('自己推上去的那一份：原样导回（秘密库留着——同一把派生钥匙打得开）', async () => {
    const cloud = fakeCloud({ body: packageBytes(), source: 'hosted' })
    const config = hostedModeOf(hostedEnv()) as NonNullable<ReturnType<typeof hostedModeOf>>
    const dataDir = temp('data')
    expect(await restoreHostedSnapshot({ config, dataDir, fetch: cloud.fetch })).toBe('restored')
    const db = new Database(join(dataDir, 'events.db'), { readonly: true })
    expect(db.prepare('SELECT x FROM t').get()).toEqual({ x: '对话' })
    db.close()
    expect(readFileSync(join(dataDir, 'secrets.sqlite')).byteLength).toBeGreaterThan(0)
    // 盘上已经有库：再起一次不拉
    expect(await restoreHostedSnapshot({ config, dataDir, fetch: cloud.fetch })).toBe('kept')
  })

  it('商家本机推上来的那一份：导进来，但秘密库删掉（最小必要）', async () => {
    const cloud = fakeCloud({ body: packageBytes(), source: 'local' })
    const config = hostedModeOf(hostedEnv()) as NonNullable<ReturnType<typeof hostedModeOf>>
    const dataDir = temp('data')
    await restoreHostedSnapshot({ config, dataDir, fetch: cloud.fetch })
    expect(() => readFileSync(join(dataDir, 'secrets.sqlite'))).toThrow()
  })

  it('推快照：导出成包，带托管令牌 PUT 上去；推上去的拉得回来', async () => {
    const cloud = fakeCloud()
    const config = hostedModeOf(hostedEnv()) as NonNullable<ReturnType<typeof hostedModeOf>>
    const dataDir = temp('data')
    mkdirSync(dataDir, { recursive: true })
    const db = new Database(join(dataDir, 'events.db'))
    db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('推')")
    db.close()
    const bytes = await pushHostedSnapshot({ config, dataDir, clock, fetch: cloud.fetch })
    expect(bytes).toBeGreaterThan(0)
    expect(cloud.calls[0]).toMatchObject({ method: 'PUT', auth: 'Bearer wst_hosted_x.y', bytes })
    const again = temp('again')
    expect(await restoreHostedSnapshot({ config, dataDir: again, fetch: cloud.fetch })).toBe(
      'restored',
    )
  })
})

describe('托管模式：整台服务进程起来', () => {
  it('转发器客户端以 peer=hosted 外连，用的是托管配对；默认模型是云', async () => {
    const opened: { url: string; sent: string[]; fire: (t: string) => void }[] = []
    const original = (globalThis as { WebSocket?: unknown }).WebSocket
    class FakeSocket {
      readonly sent: string[] = []
      readonly handlers = new Map<string, (e?: unknown) => void>()
      constructor(readonly url: string) {
        opened.push({ url, sent: this.sent, fire: (t) => this.handlers.get(t)?.() })
      }
      send(text: string): void {
        this.sent.push(text)
      }
      close(): void {}
      addEventListener(type: string, handler: (e?: unknown) => void): void {
        this.handlers.set(type, handler)
      }
    }
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket
    try {
      const dbDir = temp('server')
      const server = await createServer({
        quiet: true,
        clock,
        scheduleIntervalMs: 0,
        dbDir,
        env: {
          AGENTSWS_OWNER_EMAIL: 'owner@example.com',
          ...hostedEnv(),
          AGENTSWS_SECRETS_KEY: KEY,
        },
      })
      live.push(server)
      const socket = opened.find((o) => o.url === `wss://cloud.example.test/relay/${WS}/connect`)
      expect(socket).toBeDefined()
      socket?.fire('open')
      const hello = JSON.parse(socket?.sent[0] ?? '{}') as Record<string, unknown>
      expect(hello).toMatchObject({
        type: 'hello',
        workspace: WS,
        pairing: 'hrp_test',
        peer: 'hosted',
      })
      const models = JSON.parse(readFileSync(join(dbDir, 'models.json'), 'utf8')) as {
        defaults: { default: string }
      }
      expect(models.defaults.default).toBe('agentsws_cloud')
    } finally {
      ;(globalThis as { WebSocket?: unknown }).WebSocket = original
    }
  })
})

describe('商家本机那一侧：订阅 / 看状态 / 取回 / 覆盖', () => {
  /** 一个假的云（/v1/support/*）：订阅状态机只有 none → active → cancelling。 */
  function ownerCloud(): { fetch: OwnerFetch; puts: number[]; seen: string[] } {
    let status: 'none' | 'active' | 'cancelling' = 'none'
    const puts: number[] = []
    const seen: string[] = []
    const fetch: OwnerFetch = async (url, init) => {
      const method = init.method ?? 'GET'
      const path = new URL(url).pathname
      seen.push(`${method} ${path} ${new Headers(init.headers).get('Authorization') ?? ''}`)
      if (path === '/v1/support/subscription') {
        if (method === 'POST') status = 'active'
        if (method === 'DELETE') status = 'cancelling'
        return Response.json({ data: { status, service_id: 'support.service.monthly' } })
      }
      if (path === '/v1/support/hosted')
        return Response.json({
          data: {
            workspace_id: status === 'none' ? '' : WS,
            state: 'running',
            last_heartbeat_at: '2026-09-23T09:58:00.000Z',
          },
        })
      if (path === '/v1/support/hosted/snapshot' && method === 'PUT') {
        puts.push((init.body as Uint8Array).byteLength)
        return Response.json({ data: { ok: true } })
      }
      if (path === '/v1/support/hosted/snapshot')
        return new Response(new Uint8Array([9, 9]), {
          status: 200,
          headers: { 'x-agentsws-snapshot-at': '2026-09-23T04:00:00.000Z' },
        })
      return new Response('', { status: 404 })
    }
    return { fetch, puts, seen }
  }

  it('没关联账号：一句人话，一个请求都不发', async () => {
    const cloud = ownerCloud()
    const client = createHostedOwnerClient({
      cloud_base_url: 'https://cloud.example.test',
      token: () => undefined,
      workspace_id: WS as never,
      clock,
      fetch: cloud.fetch,
    })
    const view = await client.status()
    expect(view.linked).toBe(false)
    expect(view.message).toContain('关联')
    expect(cloud.seen).toHaveLength(0)
  })

  it('开通 → 云端替你值守中（托管在跑、有心跳）→ 取消（当期用完为止）', async () => {
    const cloud = ownerCloud()
    const client = createHostedOwnerClient({
      cloud_base_url: 'https://cloud.example.test',
      token: () => 'wst_owner',
      workspace_id: WS as never,
      clock,
      fetch: cloud.fetch,
    })
    expect((await client.status()).subscription.status).toBe('none')
    const on = await client.subscribe()
    expect(on.subscription.status).toBe('active')
    expect(on.hosted?.state).toBe('running')
    expect(on.hosted?.last_heartbeat_at).toBe('2026-09-23T09:58:00.000Z')
    expect(cloud.seen).toContain('POST /v1/support/subscription Bearer wst_owner')
    expect((await client.cancel()).subscription.status).toBe('cancelling')
  })

  it('取回：落进备份目录（不自己导入）；覆盖：导出本机那一份 PUT 上去', async () => {
    const cloud = ownerCloud()
    const dataDir = temp('owner-data')
    const backupDir = temp('owner-backup')
    const db = new Database(join(dataDir, 'events.db'))
    db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('本机')")
    db.close()
    const client = createHostedOwnerClient({
      cloud_base_url: 'https://cloud.example.test',
      token: () => 'wst_owner',
      workspace_id: WS as never,
      clock,
      dataDir,
      backupDir,
      fetch: cloud.fetch,
    })
    const home = await client.bringHome()
    expect(home.saved_to).toContain(backupDir)
    expect(home.saved_to).toContain('hosted-')
    expect([...readFileSync(home.saved_to as string)]).toEqual([9, 9])
    const seeded = await client.seed()
    expect(seeded.bytes).toBeGreaterThan(0)
    expect(cloud.puts).toEqual([seeded.bytes])
  })
})
