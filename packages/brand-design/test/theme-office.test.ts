/**
 * WP122b 交付 ⑥：主题设置 → `theme` 档令牌，docx / pptx 手册拆页。
 */
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { officePages } from '../src/office.js'
import { extractThemeDesign, fontHandleToName } from '../src/theme-design.js'

describe('extractThemeDesign：Shopify 主题设置', () => {
  it('Dawn 的 color_schemes + 字体 handle → 色/字体令牌，来路 theme', () => {
    const { profile, contributed } = extractThemeDesign({
      current: {
        color_schemes: {
          'scheme-1': {
            settings: {
              background: '#f7f5f2',
              text: '#1a1c1e',
              button: '#0a7d33',
              button_label: '#ffffff',
            },
          },
        },
        type_header_font: 'assistant_n4',
        type_base_font: 'open_sans_n7',
      },
    })
    expect(profile.colors?.primary?.value).toBe('#0a7d33')
    expect(profile.colors?.surface?.value).toBe('#f7f5f2')
    expect(profile.colors?.['on-surface']?.value).toBe('#1a1c1e')
    expect(profile.colors?.primary?.source[0]?.origin).toBe('theme')
    expect(profile.colors?.primary?.source[0]?.locator).toBe('theme:color_schemes')
    expect(profile.typography?.h1?.value.fontFamily).toBe('Assistant')
    expect(profile.typography?.['body-md']?.value.fontFamily).toBe('Open Sans')
    expect(contributed).toContain('colors.primary')
    expect(contributed).toContain('typography.h1')
  })

  it('老主题（没有 color_schemes）：平铺的 color 键按序挑进主/次/三', () => {
    const { profile } = extractThemeDesign({
      current: {
        colors_background: '#ffffff',
        color_primary: '#b8422e',
        color_secondary: '#2e6fb8',
      },
    })
    expect(profile.colors?.primary?.value).toBe('#b8422e')
    expect(profile.colors?.secondary?.value).toBe('#2e6fb8')
    expect(profile.colors?.primary?.source[0]?.locator).toBe('theme:colors')
  })

  it('settings_data.json 本体传进来也认（current 在/不在都行）；认不出的不猜', () => {
    expect(extractThemeDesign({ current: {} }).contributed).toEqual([])
    expect(extractThemeDesign('not json at all').contributed).toEqual([])
  })

  it('fontHandleToName：剥类型后缀、下划线转驼名', () => {
    expect(fontHandleToName('assistant_n4')).toBe('Assistant')
    expect(fontHandleToName('open_sans_n7')).toBe('Open Sans')
    expect(fontHandleToName('Inter')).toBe('Inter')
  })
})

/* ── officePages：内存里拼 zip（store 方法，不压缩）────────────────── */

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function zipOf(files: { name: string; content: string }[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const data = Buffer.from(file.content, 'utf8')
    const nameBuf = Buffer.from(file.name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    locals.push(local, data)

    const centralEntry = Buffer.alloc(46 + nameBuf.length)
    centralEntry.writeUInt32LE(0x02014b50, 0)
    centralEntry.writeUInt16LE(20, 4)
    centralEntry.writeUInt16LE(0, 8) // flags
    centralEntry.writeUInt16LE(0, 10) // method
    centralEntry.writeUInt32LE(crc, 16)
    centralEntry.writeUInt32LE(data.length, 20)
    centralEntry.writeUInt32LE(data.length, 24)
    centralEntry.writeUInt16LE(nameBuf.length, 28)
    centralEntry.writeUInt32LE(offset, 42)
    nameBuf.copy(centralEntry, 46)
    central.push(centralEntry)
    offset += local.length + data.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const DOCX_XML = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>主色：</w:t><w:t>PANTONE 186 C</w:t></w:r></w:p>
<w:p><w:r><w:t>标题字体：Public Sans</w:t></w:r></w:p>
<w:p><w:r><w:t>最小尺寸 24px</w:t></w:r></w:p>
</w:body>
</w:document>`

const SLIDE1 = `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:txBody><a:p><a:r><a:t>我们的颜色</a:t></a:r><a:r><a:t>#0A7D33</a:t></a:r></a:p></a:txBody>
</p:sld>`

const SLIDE2 = `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:txBody><a:p><a:r><a:t>标题字体：Space Grotesk</a:t></a:r></a:p></a:txBody>
</p:sld>`

describe('officePages：docx / pptx 拆页', () => {
  it('docx：整份文档记一页，段落文字都取出来', () => {
    const zip = zipOf([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'word/document.xml', content: DOCX_XML },
    ])
    const pages = officePages(new Uint8Array(zip))
    expect(pages).toHaveLength(1)
    expect(pages[0]?.page).toBe(1)
    expect(pages[0]?.text).toContain('主色：')
    expect(pages[0]?.text).toContain('PANTONE 186 C')
    expect(pages[0]?.text).toContain('最小尺寸 24px')
  })

  it('pptx：每张幻灯片一页，页码是幻灯片号', () => {
    const zip = zipOf([
      { name: 'ppt/slides/slide2.xml', content: SLIDE2 },
      { name: 'ppt/slides/slide1.xml', content: SLIDE1 },
    ])
    const pages = officePages(new Uint8Array(zip))
    expect(pages.map((p) => p.page)).toEqual([1, 2])
    expect(pages[0]?.text).toContain('#0A7D33')
    expect(pages[1]?.text).toContain('Space Grotesk')
  })

  it('抽出经 extractFileDesign 的 pages 口，能贡献色与字体', async () => {
    const { extractFileDesign } = await import('../src/file-design.js')
    const zip = zipOf([{ name: 'ppt/slides/slide1.xml', content: SLIDE1 }])
    const got = extractFileDesign({
      filename: 'brand.pptx',
      pages: officePages(new Uint8Array(zip)),
    })
    expect(got.failure).toBeUndefined()
    expect(got.profile.colors?.primary?.value.toLowerCase()).toBe('#0a7d33')
    expect(got.contributed).toContain('colors.primary')
  })

  it('不是 zip（.doc 老格式 / 瞎写的字节）：空手回，不抛', () => {
    expect(officePages(new Uint8Array([1, 2, 3, 4]))).toEqual([])
    expect(officePages(new TextEncoder().encode('plain text, not a zip'))).toEqual([])
  })

  it('deflate 压缩的条目也认', () => {
    const raw = Buffer.from(SLIDE1, 'utf8')
    const deflated = deflateRawSync(raw)
    // 直接造一个 method=8 的条目：中央目录与本地头 method=8，长度用压缩后
    const nameBuf = Buffer.from('ppt/slides/slide1.xml')
    const crc = crc32(raw)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(deflated.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(0, 42)
    nameBuf.copy(central, 46)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(central.length, 12)
    eocd.writeUInt32LE(local.length + deflated.length, 16)
    const zip = Buffer.concat([local, deflated, central, eocd])
    const pages = officePages(new Uint8Array(zip))
    expect(pages).toHaveLength(1)
    expect(pages[0]?.text).toContain('#0A7D33')
  })
})
