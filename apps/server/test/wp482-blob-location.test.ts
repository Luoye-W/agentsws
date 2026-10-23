/**
 * WP482：大文件（附件、录音、上传的原件……）单独放一个位置——外置硬盘、NAS。
 *
 * 桌面壳把用户选的那个目录经 `AGENTSWS_BLOB_DIR` 给服务进程。这一组钉三件事：
 *
 * 1. **连不上照样开**：目录不在（硬盘没插、NAS 断网），服务进程照常起来，不替它建一个空目录；
 *    `GET /v1/storage` 照实说「连不上」；
 * 2. **用到的地方说清楚**：读写大文件回 503 + `provider_unavailable` + `details.reason =
 *    blob_location_unreachable` + 那个位置——不能当成「文件不存在」（那会被说成内容已擦除）；
 * 3. **接好就通**：目录回来之后，同一个服务进程下一次读写就好了（界面上的「再试一次」靠这个）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StorageView } from '@agentsws/api'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-23T09:00:00.000Z'

function seeded(seed = 482): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server | undefined
let root: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function boot(env: Record<string, string>): Promise<{
  s: Server
  dbDir: string
  call: (method: string, path: string, body?: BodyInit) => Promise<Response>
}> {
  root = mkdtempSync(join(tmpdir(), 'agentsws-wp482-'))
  const dbDir = join(root, '数据 库')
  mkdirSync(dbDir)
  let t = Date.parse(T0)
  const s = await createServer({
    clock: {
      now: () => {
        t += 1000
        return new Date(t).toISOString()
      },
    },
    random: seeded(),
    quiet: true,
    startRun: false,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    dbDir,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost', ...env },
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
  })
  server = s
  const call = (method: string, path: string, body?: BodyInit): Promise<Response> =>
    s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': s.bootstrap.ownerAssignment.id,
        },
        ...(body === undefined ? {} : { body }),
      }),
    )
  return { s, dbDir, call }
}

const upload = (name: string, text: string): FormData => {
  const fd = new FormData()
  fd.set('file', new Blob([new TextEncoder().encode(text)]), name)
  return fd
}

const storageView = async (
  call: (method: string, path: string) => Promise<Response>,
): Promise<StorageView> =>
  ((await (await call('GET', '/v1/storage')).json()) as { data: StorageView }).data

describe('WP482 大文件单独放一个位置', () => {
  it('位置连不上：服务照常起来、不替它建空目录、用到时回 503 + 位置；接好之后同一个进程就通了', async () => {
    const pending = join(tmpdir(), `agentsws-wp482-nas-${process.pid}-${Date.now()}`, '工坊 大文件')
    const { dbDir, call } = await boot({ AGENTSWS_BLOB_DIR: pending })
    try {
      // ① 照常起来了；不替它建（硬盘没插时建出来的是一个空的本地目录）
      expect(existsSync(pending)).toBe(false)
      expect(existsSync(join(dbDir, 'blobs'))).toBe(false)
      const view = await storageView(call)
      expect(view.blobs.display).toBe(pending)
      expect(view.blobs.reachable).toBe(false)
      expect(view.blobs.bytes).toBeUndefined()
      // 数据库那一格不受影响
      expect(view.database.display).toBe(dbDir)

      // ② 用到大文件：503 + 人话 + 位置（界面凭 reason 出「再试一次」）
      const failed = await call('POST', '/v1/knowledge/sources/upload', upload('说明.txt', '你好'))
      expect(failed.status).toBe(503)
      const body = (await failed.json()) as {
        code: string
        message: string
        details?: { reason?: string; location?: string }
      }
      expect(body.code).toBe('provider_unavailable')
      expect(body.message).toContain('大文件存放的位置现在连不上')
      expect(body.details?.reason).toBe('blob_location_unreachable')
      expect(body.details?.location).toBe(pending)
      expect(existsSync(pending)).toBe(false)

      // ③ 接好了（目录回来了）：同一个进程，再试一次就通
      mkdirSync(pending, { recursive: true })
      const created = await call('POST', '/v1/knowledge/sources/upload', upload('说明.txt', '你好'))
      expect(created.status).toBe(201)
      const source = ((await created.json()) as { data: { id: string } }).data
      expect(readdirSync(pending).length).toBeGreaterThan(0)
      // 大文件真的在那边，没进数据库目录
      expect(existsSync(join(dbDir, 'blobs'))).toBe(false)
      const again = await storageView(call)
      expect(again.blobs.reachable).toBe(true)
      expect(again.blobs.objects).toBe(1)

      const file = await call('GET', `/v1/knowledge/sources/${source.id}/file`)
      expect(file.status).toBe(200)
      expect(new TextDecoder().decode(await file.arrayBuffer())).toBe('你好')

      // ④ 又断了（拔了硬盘）：读的时候说「连不上」，**不是** 404 / 内容已擦除
      rmSync(pending, { recursive: true, force: true })
      const gone = await call('GET', `/v1/knowledge/sources/${source.id}/file`)
      expect(gone.status).toBe(503)
      const goneBody = (await gone.json()) as { details?: { reason?: string } }
      expect(goneBody.details?.reason).toBe('blob_location_unreachable')
      expect(existsSync(pending)).toBe(false)
    } finally {
      rmSync(join(pending, '..'), { recursive: true, force: true })
    }
  })

  it('没给单独的位置：照旧放在数据目录的 blobs 里，连得上', async () => {
    const { dbDir, call } = await boot({})
    const view = await storageView(call)
    expect(view.blobs.display).toBe(join(dbDir, 'blobs'))
    expect(view.blobs.reachable).toBe(true)
    const created = await call('POST', '/v1/knowledge/sources/upload', upload('a.txt', 'x'))
    expect(created.status).toBe(201)
    expect(readdirSync(join(dbDir, 'blobs')).length).toBeGreaterThan(0)
  })

  it('AGENTSWS_BLOB_URL 显式给了（接我的云 / 运维指定）：比单独的位置优先', async () => {
    const explicit = join(tmpdir(), `agentsws-wp482-url-${process.pid}-${Date.now()}`)
    try {
      const { call } = await boot({
        AGENTSWS_BLOB_URL: explicit,
        AGENTSWS_BLOB_DIR: join(explicit, 'not-used'),
      })
      const view = await storageView(call)
      expect(view.blobs.display).toBe(explicit)
      expect(view.blobs.reachable).toBe(true)
    } finally {
      rmSync(explicit, { recursive: true, force: true })
    }
  })
})
