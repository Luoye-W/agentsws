/**
 * WP99：**上传一份文件，走完整条线再原样拿回来**。
 *
 * 前面两组用例各钉一段（`knowledge-upload.test.ts` 钉六道闸、
 * `packages/api/test/knowledge-upload-route.test.ts` 钉网关那一侧），这一组钉
 * 它们**接起来**之后成不成立——跑的是真装配线：真路由 → 真 `KnowledgePort` →
 * 真 `BlobStore`（本地档，带信封加密）→ 真 SQLite 源表 → 真事件日志。
 *
 * 一条端到端：
 *
 *   现造一份 xlsx（exceljs 那一份 fixture 在工作台侧；这里用一个最小的真 zip）
 *     → `POST /v1/knowledge/sources/upload`
 *     → `GET /v1/knowledge/sources`（列表里立刻有它）
 *     → `GET /v1/knowledge/sources/:id/file`（**字节逐个相同**）
 *     → `DELETE`（清单里没了、再读 404、事件日志上两条都在）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-18T09:00:00.000Z'

function makeClock() {
  let t = Date.parse(T0)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 99): () => number {
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
let dir: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/**
 * 一份**真的** xlsx 字节：一个 zip，里面有一个叫 `xl/workbook.xml` 的条目。
 *
 * 不引 exceljs（那是工作台那一侧的依赖，服务进程不该有它），也不签一个二进制
 * 进仓库——手写一个最小的 zip（本地文件头 + 中央目录 + 目录结尾），条目**不压缩**。
 * 这样六道闸里的第 4 道（`PK` + 里面得有 `xl/`）验的是真东西，不是一段假签名。
 */
function xlsxBytes(content: string): Uint8Array {
  const enc = new TextEncoder()
  const name = enc.encode('xl/workbook.xml')
  const data = enc.encode(content)
  const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]
  const u32 = (n: number): number[] => [
    n & 0xff,
    (n >> 8) & 0xff,
    (n >> 16) & 0xff,
    (n >>> 24) & 0xff,
  ]
  // crc32 这一格填 0：我们自己不解这个包，闸也只看条目名
  const local = [
    ...u32(0x04034b50),
    ...u16(20),
    ...u16(0),
    ...u16(0), // 压缩方法 0 = 存储
    ...u16(0),
    ...u16(0),
    ...u32(0),
    ...u32(data.length),
    ...u32(data.length),
    ...u16(name.length),
    ...u16(0),
    ...name,
    ...data,
  ]
  const central = [
    ...u32(0x02014b50),
    ...u16(20),
    ...u16(20),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u32(0),
    ...u32(data.length),
    ...u32(data.length),
    ...u16(name.length),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u32(0),
    ...u32(0),
    ...name,
  ]
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(1),
    ...u16(1),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(0),
  ]
  return new Uint8Array([...local, ...central, ...end])
}

async function boot(): Promise<{
  s: Server
  call: (method: string, path: string, body?: BodyInit) => Promise<Response>
}> {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp99-'))
  const s = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    startRun: false,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    // 对象存储只在有数据目录的那一档开（内存档故意不开，见 server.ts 那段注释）
    dbDir: dir,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
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
  return { s, call }
}

function upload(name: string, bytes: Uint8Array): FormData {
  const fd = new FormData()
  fd.set('file', new Blob([bytes as unknown as ArrayBuffer]), name)
  return fd
}

describe('端到端：传一份 xlsx → 列表 → 拉回来 → 删掉', () => {
  it('字节逐个相同，清单立刻有它，溯源事件也在', async () => {
    const { s, call } = await boot()
    const bytes = xlsxBytes('<workbook><sheet name="订单"/></workbook>')

    const created = await call(
      'POST',
      '/v1/knowledge/sources/upload',
      upload('报价 单.xlsx', bytes),
    )
    expect(created.status).toBe(201)
    const source = ((await created.json()) as { data: Record<string, unknown> }).data
    expect(source.kind).toBe('upload')
    expect(source.filename).toBe('报价 单.xlsx')
    expect(source.size).toBe(bytes.length)
    expect(String(source.ref).startsWith('blob://knowledge/')).toBe(true)
    // 41 §2：大文件只住对象存储，别处只拿引用
    expect(String(source.content_sha256)).toHaveLength(64)
    expect(source.uploaded_by).toBe(s.bootstrap.person.id)

    // 清单里立刻有它（工作台"传完立刻出现"靠的就是这一条）
    const list = (
      (await (await call('GET', '/v1/knowledge/sources')).json()) as {
        data: { id: string }[]
      }
    ).data
    expect(list.map((x) => x.id)).toContain(source.id)

    // 原件拉回来：**逐个字节相同**，文件名与 content-type 也对
    const file = await call('GET', `/v1/knowledge/sources/${String(source.id)}/file`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    const disposition = file.headers.get('content-disposition') ?? ''
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? '')).toBe('报价 单.xlsx')
    const back = new Uint8Array(await file.arrayBuffer())
    expect(back).toEqual(bytes)

    // 溯源：事件日志上有一条 `knowledge.source.added`，而且**载荷里没有正文**
    const added = s.kernel.eventLog
      .readSync({ workspace_id: s.bootstrap.workspace.id })
      .filter((e) => e.type === 'knowledge.source.added')
    expect(added).toHaveLength(1)
    const payload = added[0]?.payload as Record<string, unknown>
    expect(payload).toMatchObject({
      source_id: source.id,
      kind: 'upload',
      filename: '报价 单.xlsx',
      uploaded_by: s.bootstrap.person.id,
      content_sha256: source.content_sha256,
      size: bytes.length,
    })
    expect(JSON.stringify(payload)).not.toContain('workbook')

    // 删掉：清单里没了、再读 404、日志上 removed 也在
    const gone = await call('DELETE', `/v1/knowledge/sources/${String(source.id)}`)
    expect(gone.status).toBe(200)
    const after = (
      (await (await call('GET', '/v1/knowledge/sources')).json()) as {
        data: { id: string }[]
      }
    ).data
    expect(after.map((x) => x.id)).not.toContain(source.id)
    expect((await call('GET', `/v1/knowledge/sources/${String(source.id)}/file`)).status).toBe(404)
    expect((await call('DELETE', `/v1/knowledge/sources/${String(source.id)}`)).status).toBe(404)
    expect(
      s.kernel.eventLog
        .readSync({ workspace_id: s.bootstrap.workspace.id })
        .filter((e) => e.type === 'knowledge.source.removed'),
    ).toHaveLength(1)
  })

  it('六道闸在真路由上照样拦：改了名字的文件 400，而且什么都没落库', async () => {
    const { s, call } = await boot()
    // 一份 xlsx 的字节，名字写成 .docx
    const bad = await call(
      'POST',
      '/v1/knowledge/sources/upload',
      upload('假的.docx', xlsxBytes('<workbook/>')),
    )
    expect(bad.status).toBe(400)
    expect((await bad.json()).message).toContain('装的不是 Word')

    // 扩展名不在白名单里
    const html = await call(
      'POST',
      '/v1/knowledge/sources/upload',
      upload('页面.html', new TextEncoder().encode('<script>alert(1)</script>')),
    )
    expect(html.status).toBe(400)

    // 文件名里带路径：洗掉，而不是拒——但洗完之后仍然要过扩展名那一关
    const escaped = await call(
      'POST',
      '/v1/knowledge/sources/upload',
      upload('../../etc/passwd.txt', new TextEncoder().encode('退货窗口是 30 天')),
    )
    expect(escaped.status).toBe(201)
    const saved = ((await escaped.json()) as { data: { filename: string; ref: string } }).data
    expect(saved.filename).toBe('passwd.txt')
    // key 里没有那段路径（`assertKey` 也不会让它进来）
    expect(saved.ref).not.toContain('..')

    // 落库的只有那一条洗干净的
    expect(s.knowledge.intake.sources(s.bootstrap.workspace.id)).toHaveLength(1)
  })

  it('同一份内容传两次 = 同一条源（key 是内容 hash，不多存一份字节）', async () => {
    const { s, call } = await boot()
    const bytes = xlsxBytes('<workbook/>')
    const a = (
      (await (
        await call('POST', '/v1/knowledge/sources/upload', upload('一.xlsx', bytes))
      ).json()) as { data: { id: string } }
    ).data
    const b = (
      (await (
        await call('POST', '/v1/knowledge/sources/upload', upload('二.xlsx', bytes))
      ).json()) as { data: { id: string } }
    ).data
    expect(b.id).toBe(a.id)
    expect(s.knowledge.intake.sources(s.bootstrap.workspace.id)).toHaveLength(1)
  })
})
