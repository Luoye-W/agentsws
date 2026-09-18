/**
 * WP97（36 §11，`docs/upstream/sidebar-compare.md` #13）：
 * `GET /v1/knowledge/sources/:id/file` —— 第三栏 Office 预览的取数口。
 *
 * 网关这一侧只有三件事，这一组就钉这三件：**字节原样转下去**（不做任何转换）、
 * **读不到一律 404**（不区分"不存在"与"不是你的"，与 `cards/:id` 同一条）、
 * **文件名进响应头之前先洗一遍**（外来串直接拼进 header 就是一条换行注入）。
 */
import { describe, expect, it } from 'vitest'
import { contentDisposition } from '../src/routes/knowledge.js'
import { harness } from './helpers.js'

describe('取原件字节', () => {
  it('200：字节原样、content-type 原样、文件名两份都在', async () => {
    const h = await harness()
    const res = await h.get('/v1/knowledge/sources/src_file/file')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition.startsWith('attachment;')).toBe(true)
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? '')).toBe('报价 单.xlsx')
    expect(new TextDecoder().decode(await res.arrayBuffer())).toContain('fake-xlsx')
  })

  it('读不到 → 404（"不存在"与"不是你的"不分开说）', async () => {
    const h = await harness()
    expect((await h.get('/v1/knowledge/sources/src_nope/file')).status).toBe(404)
  })

  it('这个服务进程没装这一面 → 501，不是 500', async () => {
    const h = await harness({ bareKnowledge: true })
    expect((await h.get('/v1/knowledge/sources/src_file/file')).status).toBe(501)
  })

  it('没带 Assignment → 401 / 403，绝不下发字节', async () => {
    const h = await harness()
    const res = await h.get('/v1/knowledge/sources/src_file/file', { assignment: null })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.headers.get('content-disposition')).toBeNull()
  })
})

describe('Content-Disposition 里的文件名', () => {
  it('两份一起给：ASCII 兜底 + RFC 5987 的真名', () => {
    const header = contentDisposition('报价单.xlsx')
    expect(header).toContain('filename="___.xlsx"')
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1] ?? '')).toBe('报价单.xlsx')
  })

  it('换行与引号进不去（不然就是一条响应头注入）', () => {
    const header = contentDisposition('a"\r\nX-Evil: 1.docx')
    expect(header).not.toContain('\r')
    expect(header).not.toContain('\n')
    expect(header.startsWith('attachment; filename="')).toBe(true)
  })

  it('全是非 ASCII 时 ASCII 那一份也不空', () => {
    expect(contentDisposition('报价单')).toContain('filename="___"')
    expect(contentDisposition('')).toContain('filename="download"')
  })
})
