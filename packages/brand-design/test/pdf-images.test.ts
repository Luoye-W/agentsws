/**
 * WP122b 交付 ⑤：手册里的图 → 视觉档。
 *
 * `pdfPageImages` 抽的是 PDF 里嵌着的 JPEG（`/DCTDecode` 流原样就是 JPEG）。
 * 这里的夹具是一份**手写的最小 PDF**：一页、一个内容流、一个 8×8 的
 * JPEG XObject。字节是造的，但它有 JPEG 的魔数——我们的抽取器只认
 * 字节与过滤器，不真的解码图片，所以夹具不需要是一张真图。
 */
import { describe, expect, it } from 'vitest'
import { pdfPageImages } from '../src/pdf.js'

/** 一张够小的"JPEG"：SOI + APP0 魔数开头，后面用 0xFF 填充到指定长度。 */
function fakeJpeg(minBytes: number): Uint8Array {
  const bytes = new Uint8Array(minBytes)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  bytes[2] = 0xff
  for (let i = 3; i < minBytes; i++) bytes[i] = 0x00
  return bytes
}

function buildPdf(input: {
  jpeg: Uint8Array
  /** 页资源字典里是否登记这张图（false = 归不到页，page 记 0）。 */
  referenceInResources?: boolean
}): Uint8Array {
  const jpeg = input.jpeg
  const referenced = input.referenceInResources ?? true
  const objects: string[] = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    `3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << ${
      referenced ? '/Im1 5 0 R' : '/ImOther 9 0 R'
    } >> >> >> endobj`,
    '4 0 obj << /Length 44 >> stream\nq 100 0 0 100 10 10 cm /Im1 Do Q\nendstream endobj',
  ]
  let out = '%PDF-1.4\n'
  for (const o of objects) out += `${o}\n`
  out += `5 0 obj << /Type /XObject /Subtype /Image /Filter /DCTDecode /Width 8 /Height 8 /Length ${jpeg.length} >> stream\n`
  const head = new TextEncoder().encode(out)
  const tail = new TextEncoder().encode('\nendstream endobj\n%%EOF\n')
  const bytes = new Uint8Array(head.length + jpeg.length + tail.length)
  bytes.set(head, 0)
  bytes.set(jpeg, head.length)
  bytes.set(tail, head.length + jpeg.length)
  return bytes
}

describe('pdfPageImages：嵌着的 JPEG 原样抽出来', () => {
  it('页资源里登记的图抽出来，页码归对，字节原样（魔数不动）', () => {
    const jpeg = fakeJpeg(2048)
    const images = pdfPageImages(buildPdf({ jpeg }), { minBytes: 16 })
    expect(images).toHaveLength(1)
    expect(images[0]?.page).toBe(1)
    expect(images[0]?.mime).toBe('image/jpeg')
    expect(images[0]?.bytes[0]).toBe(0xff)
    expect(images[0]?.bytes[1]).toBe(0xd8)
    expect(images[0]?.bytes.length).toBe(2048)
  })

  it('资源字典归不到页的图仍然抽出来，page 记 0；小图当图标跳过', () => {
    const images = pdfPageImages(buildPdf({ jpeg: fakeJpeg(2048), referenceInResources: false }), {
      minBytes: 16,
    })
    expect(images).toHaveLength(1)
    expect(images[0]?.page).toBe(0)

    const tiny = pdfPageImages(buildPdf({ jpeg: fakeJpeg(64) }), { minBytes: 1024 })
    expect(tiny).toHaveLength(0)
  })

  it('不是 PDF / 没有 JPEG：空手回，不抛', () => {
    expect(pdfPageImages(new TextEncoder().encode('hello world, not a pdf'))).toEqual([])
    expect(
      pdfPageImages(buildPdf({ jpeg: fakeJpeg(2048) }).slice(0, 40), { minBytes: 16 }),
    ).toEqual([])
  })
})
