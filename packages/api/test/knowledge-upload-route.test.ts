/**
 * WP99（19 §1.3「上传」）：`POST /v1/knowledge/sources/upload` 与
 * `DELETE /v1/knowledge/sources/:id`。
 *
 * 网关这一侧只有四件事，这一组就钉这四件：**multipart 里那一个 `file` 拆得出来**、
 * **字节原样转下去**（网关不认识 Office 格式，六道闸在宿主那一侧）、
 * **一道粗的大小闸**（`Content-Length` 先看一眼，再验一次真实大小）、
 * **删不到一律 404**（不区分"不存在"与"不是你的"，与 `:id/file` 同一条）。
 */
import { describe, expect, it } from 'vitest'
import { harness } from './helpers.js'

type Harness = Awaited<ReturnType<typeof harness>>

function form(file: { name: string; bytes: Uint8Array; type?: string }): FormData {
  const fd = new FormData()
  fd.set(
    'file',
    new Blob([file.bytes as unknown as ArrayBuffer], {
      type: file.type ?? 'application/octet-stream',
    }),
    file.name,
  )
  return fd
}

function send(h: Harness, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  return h.gateway.fetch(
    new Request('http://x/v1/knowledge/sources/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${h.token}`,
        'X-Assignment': h.assignment.id,
        ...headers,
      },
      body,
    }),
  )
}

function del(h: Harness, id: string): Promise<Response> {
  return h.gateway.fetch(
    new Request(`http://x/v1/knowledge/sources/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id },
    }),
  )
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * 一段"像 xlsx"的字节：`PK` 的本地签名加一个 `xl/`。
 *
 * 写成字节数组而不是带转义的字符串字面量——格式化工具会把 `\u0003` 这种转义
 * 还原成**字面的控制字符**写回源码，于是那一行看上去就成了一段谁也读不懂的东西。
 */
const XLSX_ISH = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x78, 0x6c, 0x2f])

describe('上传', () => {
  it('201：文件名与字节原样转下去，回一条登记好的源', async () => {
    const h = await harness()
    const res = await send(h, form({ name: '报价 单.xlsx', bytes: XLSX_ISH }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { id: string; kind: string; filename?: string } }
    expect(body.data.kind).toBe('upload')
    expect(body.data.filename).toBe('报价 单.xlsx')
    const got = h.knowledgeState.uploads[0]
    expect(got?.filename).toBe('报价 单.xlsx')
    expect(got?.bytes).toEqual(XLSX_ISH)
    // 传完之后清单里立刻有它（工作台"传完立刻出现"靠的就是这一条）
    const list = (await (await h.get('/v1/knowledge/sources')).json()) as { data: unknown[] }
    expect(list.data).toHaveLength(1)
  })

  it('客户端说的 MIME 一个字都不用（网关只转文件名与字节）', async () => {
    const h = await harness()
    await send(h, form({ name: 'a.txt', bytes: bytes('hi'), type: 'text/html' }))
    expect(Object.keys(h.knowledgeState.uploads[0] ?? {}).sort()).toEqual(['bytes', 'filename'])
  })

  it('不是 multipart → 400（不是 500）', async () => {
    const h = await harness()
    const res = await h.post('/v1/knowledge/sources/upload', { file: 'x' })
    expect(res.status).toBe(400)
  })

  it('multipart 里没有 file → 400', async () => {
    const h = await harness()
    const fd = new FormData()
    fd.set('note', '忘了带文件')
    expect((await send(h, fd)).status).toBe(400)
  })

  it('`Content-Length` 就超了 → 400，而且**一个字节都没读**', async () => {
    const h = await harness()
    const res = await send(h, form({ name: 'a.txt', bytes: bytes('hi') }), {
      'content-length': String(65 * 1024 * 1024),
    })
    expect(res.status).toBe(400)
    expect(h.knowledgeState.uploads).toHaveLength(0)
  })

  it('这个服务进程没装这一面 → 501，不是 500', async () => {
    const h = await harness({ bareKnowledge: true })
    expect((await send(h, form({ name: 'a.txt', bytes: bytes('hi') }))).status).toBe(501)
  })

  it('没带 Assignment → 4xx，一个字节都不收', async () => {
    const h = await harness()
    const res = await h.gateway.fetch(
      new Request('http://x/v1/knowledge/sources/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${h.token}` },
        body: form({ name: 'a.txt', bytes: bytes('hi') }),
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(h.knowledgeState.uploads).toHaveLength(0)
  })
})

describe('删除', () => {
  it('删得掉：清单里没有了', async () => {
    const h = await harness()
    const created = (await (await send(h, form({ name: 'a.txt', bytes: bytes('hi') }))).json()) as {
      data: { id: string }
    }
    const res = await del(h, created.data.id)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ deleted: true, id: created.data.id })
    expect(h.knowledgeState.sources).toHaveLength(0)
    expect(h.knowledgeState.deleted).toEqual([created.data.id])
  })

  it('删不到 → 404（"不存在"与"不是你的"不分开说）', async () => {
    const h = await harness()
    expect((await del(h, 'src_nope')).status).toBe(404)
  })

  it('这个服务进程没装这一面 → 501', async () => {
    const h = await harness({ bareKnowledge: true })
    expect((await del(h, 'src_1')).status).toBe(501)
  })
})
