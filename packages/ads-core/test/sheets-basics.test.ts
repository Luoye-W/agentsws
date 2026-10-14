/**
 * WP314：上传表的底层小件——CSV 编解码、导出字节解码、SHA-256 指纹、最小 .xlsx。
 * 样例全部手写，没有任何真实账户数据。
 */
import { describe, expect, it } from 'vitest'
import {
  columnLetter,
  decodeExportBytes,
  detectDelimiter,
  encodeDelimited,
  parseDelimited,
  sha256Hex,
  writeXlsx,
} from '../src/index.js'

describe('CSV / 制表符', () => {
  it('带逗号、引号、换行的格子来回一趟不变', () => {
    const rows = [
      ['Keyword', 'Note'],
      ['"running shoes"', 'a, b'],
      ['[trail shoes]', 'line1\nline2'],
      [' padded ', ''],
    ]
    const text = encodeDelimited(rows, ',')
    expect(parseDelimited(text, ',')).toEqual(rows.filter((r) => r.some((c) => c.trim() !== '')))
  })

  it('猜分隔符：制表符多就按制表符', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',')
  })

  it('去 BOM、丢空行', () => {
    expect(parseDelimited('﻿a,b\r\n\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('UTF-16LE 带 BOM 的导出能解开', () => {
    const s = 'Campaign\tCost\n春季\t12.5'
    const bytes = new Uint8Array(2 + s.length * 2)
    bytes[0] = 0xff
    bytes[1] = 0xfe
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i)
      bytes[2 + i * 2] = c & 0xff
      bytes[3 + i * 2] = c >> 8
    }
    expect(decodeExportBytes(bytes)).toBe(s)
    expect(decodeExportBytes(new TextEncoder().encode(`﻿${s}`))).toBe(s)
  })
})

describe('SHA-256 指纹', () => {
  it('对得上标准测试向量', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('跨 64 字节分块的长输入也对（中文按 UTF-8）', () => {
    const long = '广告'.repeat(100)
    expect(sha256Hex(long)).toBe(sha256Hex(new TextEncoder().encode(long)))
    expect(sha256Hex(long)).not.toBe(sha256Hex(`${long} `))
  })
})

describe('最小 .xlsx', () => {
  it('是 zip（PK 开头）、内容不压缩、同样输入同样字节', () => {
    const rows = [
      ['Campaign Name', 'Body'],
      ['Spring <Sale>', '< > +20% off & more'],
    ]
    const a = writeXlsx(rows, 'Ads')
    const b = writeXlsx(rows, 'Ads')
    expect(a[0]).toBe(0x50)
    expect(a[1]).toBe(0x4b)
    expect(sha256Hex(a)).toBe(sha256Hex(b))
    const text = new TextDecoder().decode(a)
    expect(text).toContain('xl/worksheets/sheet1.xml')
    expect(text).toContain('Spring &lt;Sale&gt;')
    expect(text).toContain('&lt; &gt; +20% off &amp; more')
    expect(text).toContain('r="B2"')
  })

  it('列字母', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
    expect(columnLetter(52)).toBe('BA')
  })
})
