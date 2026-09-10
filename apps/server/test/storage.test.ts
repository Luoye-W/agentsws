/**
 * 数据后端面端到端（WP40 / 41 §2.4）。
 *
 * 盯的是三件事，每一件都是「说了就得做到」的那种：
 * 1. **`GET /v1/storage` 永不含凭据**——连接串里的密码、S3 的 secret key，
 *    一个字节都不许出现在响应体、事件日志或任何落盘文件里。
 * 2. **测连接不落库、不切换**：连不上就给人话，配置照旧。
 * 3. **迁移是显式四步**，走完之后旧后端只读留 7 天（41 §2.2），
 *    而且这一切都由**本人**触发、记进事件日志。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StorageMigrationView, StorageView } from '@agentsws/api'
import type { EventEnvelope } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-09-10T00:00:00.000Z'
const SECRETS_KEY = 'a'.repeat(64)

/** 测试里唯一的「凭据」。所有零泄漏断言都盯着这两串。 */
const DB_PASSWORD = 'pg-Zq7-secret-never-logged'
const S3_SECRET = 's3-Xy9-secret-never-logged'
const DATABASE_URL = `postgres://agentsws:${DB_PASSWORD}@127.0.0.1:1/agentsws`

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

async function allEvents(): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for await (const e of ctx.server.kernel.eventLog.read({
    workspace_id: ctx.server.bootstrap.workspace.id,
    limit: 5000,
  }))
    out.push(e)
  return out
}

/** 数据目录里所有文件（含子目录）的字节。 */
function allBytes(dir: string): { name: string; bytes: Buffer }[] {
  const out: { name: string; bytes: Buffer }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...allBytes(path))
      continue
    }
    try {
      if (statSync(path).size > 40_000_000) continue
      out.push({ name: path, bytes: readFileSync(path) })
    } catch {
      // 读不到就跳过
    }
  }
  return out
}

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-storage-'))
  let t = Date.parse(T0)
  const clock = {
    now: (): string => {
      t += 1000
      return new Date(t).toISOString()
    },
  }
  const server = await createServer({
    dbDir: dir,
    clock,
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
  rmSync(ctx.dir, { recursive: true, force: true })
})

describe('GET /v1/storage（41 §2.4）', () => {
  it('第一档默认：SQLite + 本地目录，且把 compose 与环境变量端出来', async () => {
    const view = await data<StorageView>(await api('/v1/storage'))
    expect(view.tier).toBe('local')
    expect(view.database.kind).toBe('sqlite')
    expect(view.database.display).toBe(ctx.dir)
    expect(view.database.bytes).toBeGreaterThan(0)
    expect(view.blobs.kind).toBe('local')
    // 21 §4：大文件这一档接了主体密钥环，所以是加密的
    expect(view.blobs.encrypted).toBe(true)
    expect(view.compose_url).toContain('docker-compose.yml')
    // 「高级」一栏至少要有这几个开关
    const names = view.env.map((e) => e.name)
    expect(names).toContain('DATABASE_URL')
    expect(names).toContain('AGENTSWS_BLOB_URL')
    expect(names).toContain('AGENTSWS_DATA_DIR')
  })

  it('凭据类环境变量只说「已设置 / 未设置」，不抄值', async () => {
    const view = await data<StorageView>(await api('/v1/storage'))
    for (const row of view.env.filter((e) => e.secret)) {
      expect(['（已设置）', '（未设置）']).toContain(row.value)
    }
  })
})

describe('POST /v1/storage/backend：凭据零泄漏（13 §4.3 同一条纪律）', () => {
  it('存进去只回字段名；GET、事件日志、落盘文件里都没有值', async () => {
    const saved = await data<{ saved_fields: string[] }>(
      await post('/v1/storage/backend', {
        database_url: DATABASE_URL,
        blob_endpoint: 'https://oss-cn-shenzhen.aliyuncs.com',
        blob_bucket: 'my-company',
        blob_region: 'cn-shenzhen',
        blob_access_key_id: 'AKID_public_part',
        blob_secret_access_key: S3_SECRET,
      }),
    )
    expect(saved.saved_fields).toEqual([
      'blob_access_key_id',
      'blob_bucket',
      'blob_endpoint',
      'blob_region',
      'blob_secret_access_key',
      'database_url',
    ])

    // ① 响应体里没有值
    const raw = await (await api('/v1/storage')).text()
    expect(raw).not.toContain(DB_PASSWORD)
    expect(raw).not.toContain(S3_SECRET)
    expect(raw).not.toContain(DATABASE_URL)

    // ② 事件日志里只有字段名
    const events = await allEvents()
    const configured = events.filter((e) => e.type === 'storage.backend_configured')
    expect(configured).toHaveLength(1)
    const dump = JSON.stringify(events)
    expect(dump).not.toContain(DB_PASSWORD)
    expect(dump).not.toContain(S3_SECRET)
    expect(dump).toContain('blob_secret_access_key') // 字段名可以说

    // ③ 落盘：加密库里是密文，别的文件里一个字节都没有
    for (const file of allBytes(ctx.dir)) {
      expect(file.bytes.includes(Buffer.from(DB_PASSWORD, 'utf8'))).toBe(false)
      expect(file.bytes.includes(Buffer.from(S3_SECRET, 'utf8'))).toBe(false)
    }
  })

  it('再存一次不带密码 = 沿用旧的（表单不必每次重填密码）', async () => {
    await post('/v1/storage/backend', {
      database_url: DATABASE_URL,
      blob_endpoint: 'https://oss-cn-shenzhen.aliyuncs.com',
      blob_bucket: 'my-company',
      blob_access_key_id: 'AKID_public_part',
      blob_secret_access_key: S3_SECRET,
    })
    const again = await data<{ saved_fields: string[] }>(
      await post('/v1/storage/backend', { blob_bucket: 'my-company-2' }),
    )
    expect(again.saved_fields).toContain('blob_secret_access_key')
    expect(again.saved_fields).toContain('database_url')
  })

  it('形状不对的连接串被拒，而且错误信封里没有值', async () => {
    const res = await post('/v1/storage/backend', { database_url: `mysql://u:${DB_PASSWORD}@h/db` })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain(DB_PASSWORD)
  })
})

describe('POST /v1/storage/test：连不上给人话，配置照旧', () => {
  it('Postgres 连不上 → ok:false + 一句人话（不是栈）', async () => {
    const out = await data<{ database?: { ok: boolean; reason?: string } }>(
      await post('/v1/storage/test', { database_url: DATABASE_URL }),
    )
    expect(out.database?.ok).toBe(false)
    expect(out.database?.reason).toBeTruthy()
    expect(out.database?.reason).not.toContain(DB_PASSWORD)
    // 测一下不落库：后端还是本地档
    const view = await data<StorageView>(await api('/v1/storage'))
    expect(view.database.kind).toBe('sqlite')
  })

  it('S3 endpoint 连不上 → ok:false + 一句人话', async () => {
    const out = await data<{ blobs?: { ok: boolean; reason?: string } }>(
      await post('/v1/storage/test', {
        blob_endpoint: 'http://127.0.0.1:1',
        blob_bucket: 'nope',
        blob_access_key_id: 'AKID',
        blob_secret_access_key: S3_SECRET,
      }),
    )
    expect(out.blobs?.ok).toBe(false)
    expect(out.blobs?.reason).toBeTruthy()
    expect(JSON.stringify(out)).not.toContain(S3_SECRET)
  })
})

describe('POST /v1/storage/migrate：四步 + 旧后端只读留 7 天', () => {
  it('没保存过配置就迁移 → 明说要先填', async () => {
    const res = await post('/v1/storage/migrate', { confirm: true })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await res.text()).toContain('先在')
  })

  it('confirm 不给就不迁（不是一个可以顺手点的按钮）', async () => {
    expect((await post('/v1/storage/migrate', {})).status).toBe(400)
  })

  it('走完四步：done + 旧后端只读到 7 天后，进度可查、事件可见', async () => {
    await post('/v1/storage/backend', { database_url: DATABASE_URL })
    const started = await data<StorageMigrationView>(
      await post('/v1/storage/migrate', { confirm: true }),
    )
    expect(started.state).toBe('running')

    let view = started
    for (let i = 0; i < 100 && view.state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 20))
      view = await data<StorageMigrationView>(await api(`/v1/storage/migrations/${started.id}`))
    }
    expect(view.state).toBe('done')
    expect(view.step).toBe('finished')
    // 导出的是这个库目录里的 SQLite 文件
    expect(view.exported_records).toBeGreaterThan(0)
    const until = Date.parse(view.previous_readonly_until as string)
    const startedAt = Date.parse(view.started_at)
    expect(Math.round((until - startedAt) / (24 * 3600 * 1000))).toBe(7)

    // `GET /v1/storage` 也要把这个保留期说出来
    const storage = await data<StorageView>(await api('/v1/storage'))
    expect(storage.previous_backend_readonly_until).toBe(view.previous_readonly_until)

    // 21 §1：谁在什么时候动了数据后端，看得见
    const events = await allEvents()
    expect(events.some((e) => e.type === 'storage.migration_started')).toBe(true)
  })

  it('查一个不存在的迁移 → 404', async () => {
    expect((await api('/v1/storage/migrations/nope')).status).toBe(404)
  })
})

describe('监听地址（WP40：容器档）', () => {
  it('默认只绑回环——不设那个环境变量，行为一个字没变（13 §5）', async () => {
    const { bindHost } = await import('../src/server.js')
    expect(bindHost({})).toBe('127.0.0.1')
    expect(bindHost({ AGENTSWS_BIND_HOST: '' })).toBe('127.0.0.1')
  })

  it('容器里绑 0.0.0.0；别的地址直接报错（写内网地址多半是配错了）', async () => {
    const { bindHost } = await import('../src/server.js')
    expect(bindHost({ AGENTSWS_BIND_HOST: '0.0.0.0' })).toBe('0.0.0.0')
    expect(bindHost({ AGENTSWS_BIND_HOST: '::' })).toBe('::')
    expect(() => bindHost({ AGENTSWS_BIND_HOST: '192.168.1.10' })).toThrow(/只接受/)
  })
})
