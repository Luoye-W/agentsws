/**
 * WP99（19 §1.3「上传」）：**收一份文件之前的那六道闸**。
 *
 * 这一组全是纯函数的用例——`checkUpload` 不碰磁盘、不碰网络、不看时钟，
 * 所以每一条都能把"什么字节进来、什么结果出去"写死。
 *
 * 落库那一侧（进 BlobStore、登记成源、发溯源事件）在
 * `packages/api/test/knowledge-upload-route.test.ts` 与
 * `packages/knowledge/test/intake.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import { SOURCE_FILE_MAX_BYTES } from '../src/knowledge-file.js'
import {
  checkUpload,
  sanitizeUploadFilename,
  UPLOAD_EXTENSIONS,
  UPLOAD_MAX_BYTES,
  UploadRejected,
  uploadBlobKey,
  uploadExtensionOf,
  uploadSubjectRef,
} from '../src/knowledge-upload.js'

const text = (s: string): Uint8Array => new TextEncoder().encode(s)

/** 一个最小的 zip：本地文件头 + 一个条目名。条目名在 zip 里是不压缩的。 */
function zipWith(entry: string): Uint8Array {
  const head = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])
  const name = text(entry)
  const out = new Uint8Array(head.length + name.length)
  out.set(head, 0)
  out.set(name, head.length)
  return out
}

const OLE2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3])
const PDF = text('%PDF-1.7\n1 0 obj\n')

function reject(input: { filename: string; bytes: Uint8Array }): string {
  try {
    checkUpload(input)
  } catch (e: unknown) {
    expect(e).toBeInstanceOf(UploadRejected)
    return (e as Error).message
  }
  throw new Error('本该被拒，却收下了')
}

describe('闸 1：大小', () => {
  it('上限与读口那道闸是同一个数（收得进去就一定读得出来）', () => {
    expect(UPLOAD_MAX_BYTES).toBe(SOURCE_FILE_MAX_BYTES)
    expect(UPLOAD_MAX_BYTES).toBe(64 * 1024 * 1024)
  })

  it('空文件不收', () => {
    expect(reject({ filename: 'a.txt', bytes: new Uint8Array(0) })).toContain('空文件')
  })

  it('超过上限不收（而且是在算 hash 之前就回绝）', () => {
    const big = new Uint8Array(UPLOAD_MAX_BYTES + 1)
    big.set(text('hello'), 0)
    expect(reject({ filename: 'a.txt', bytes: big })).toContain('64 MB')
  })
})

describe('闸 2：扩展名白名单', () => {
  it('收的就是这八种', () => {
    expect([...UPLOAD_EXTENSIONS]).toEqual([
      'docx',
      'xlsx',
      'xls',
      'csv',
      'pptx',
      'pdf',
      'md',
      'txt',
    ])
  })

  it('不在表里的一律不收（尤其是 html / svg 这两个同源 XSS 的现成弹药）', () => {
    for (const name of ['x.html', 'x.svg', 'x.exe', 'x.zip', 'x.doc', 'x.ppt', 'x'])
      expect(reject({ filename: name, bytes: text('hello') })).toContain('只收这几种')
  })

  it('大小写不算区别', () => {
    expect(checkUpload({ filename: '报价.TXT', bytes: text('hi') }).extension).toBe('txt')
    expect(uploadExtensionOf('A.Md')).toBe('md')
    expect(uploadExtensionOf('noext')).toBe('')
  })
})

describe('闸 3：文件名洗净', () => {
  it('只取最后一段——路径与 `..` 都进不来（Windows 的反斜杠也算分隔符）', () => {
    expect(sanitizeUploadFilename('../../etc/passwd.txt')).toBe('passwd.txt')
    expect(sanitizeUploadFilename('C:\\Users\\me\\报价单.xlsx')).toBe('报价单.xlsx')
    expect(sanitizeUploadFilename('a/b/c.docx')).toBe('c.docx')
  })

  it('控制字符去掉——换行进响应头就是一条头注入', () => {
    const evil = `a${String.fromCharCode(13)}${String.fromCharCode(10)}X-Evil: 1.docx`
    const clean = sanitizeUploadFilename(evil)
    expect(clean).toBe('aX-Evil: 1.docx')
    expect(clean).not.toContain(String.fromCharCode(13))
    expect(clean).not.toContain(String.fromCharCode(10))
    expect(sanitizeUploadFilename(`a${String.fromCharCode(0)}b.txt`)).toBe('ab.txt')
  })

  it('前导点去掉；洗成空串的不收', () => {
    expect(sanitizeUploadFilename('...bashrc.txt')).toBe('bashrc.txt')
    expect(() => sanitizeUploadFilename('/')).toThrow(UploadRejected)
    expect(() => sanitizeUploadFilename('...')).toThrow(UploadRejected)
    expect(reject({ filename: '   ', bytes: text('hi') })).toContain('没有名字')
  })

  it('超长截主名、**不截扩展名**（截没了扩展名就不知道这是什么文件了）', () => {
    const long = `${'名'.repeat(300)}.xlsx`
    const clean = sanitizeUploadFilename(long)
    expect(clean.length).toBeLessThanOrEqual(120)
    expect(clean.endsWith('.xlsx')).toBe(true)
    // 没有扩展名的那一档也截得住
    expect(sanitizeUploadFilename('x'.repeat(300)).length).toBe(120)
  })

  it('洗过的名字跟着结果走（进响应头 / 界面的就是它）', () => {
    expect(checkUpload({ filename: '../a/报价 单.txt', bytes: text('hi') }).filename).toBe(
      '报价 单.txt',
    )
  })
})

describe('闸 4：magic bytes 与扩展名对得上', () => {
  it('OOXML 三兄弟：要是 zip，而且里面装的得是对的那一种', () => {
    expect(checkUpload({ filename: 'a.docx', bytes: zipWith('word/document.xml') }).extension).toBe(
      'docx',
    )
    expect(checkUpload({ filename: 'a.xlsx', bytes: zipWith('xl/workbook.xml') }).extension).toBe(
      'xlsx',
    )
    expect(
      checkUpload({ filename: 'a.pptx', bytes: zipWith('ppt/presentation.xml') }).extension,
    ).toBe('pptx')
  })

  it('不是 zip 的 .docx 不收', () => {
    expect(reject({ filename: 'a.docx', bytes: text('这其实是一段文字') })).toContain(
      '不是一个 zip 包',
    )
  })

  it('是 zip、但装的是别的那一种：也不收（xlsx 改名成 docx 进不来）', () => {
    expect(reject({ filename: 'a.docx', bytes: zipWith('xl/workbook.xml') })).toContain(
      '装的不是 Word',
    )
    expect(reject({ filename: 'a.xlsx', bytes: zipWith('word/document.xml') })).toContain(
      '装的不是 Excel',
    )
    expect(reject({ filename: 'a.pptx', bytes: zipWith('xl/workbook.xml') })).toContain(
      '装的不是 PowerPoint',
    )
  })

  it('`.xls` 要 OLE2 复合文档；新格式改名成 .xls 会被指出来', () => {
    expect(checkUpload({ filename: 'a.xls', bytes: OLE2 }).extension).toBe('xls')
    expect(reject({ filename: 'a.xls', bytes: zipWith('xl/workbook.xml') })).toContain(
      '改名成 .xlsx',
    )
  })

  it('`.pdf` 要 `%PDF-`', () => {
    expect(checkUpload({ filename: 'a.pdf', bytes: PDF }).extension).toBe('pdf')
    expect(reject({ filename: 'a.pdf', bytes: text('not a pdf') })).toContain('内容不是 PDF')
  })
})

describe('闸 5 / 6：不信客户端 MIME、纯文本档反着判', () => {
  it('content-type 只按扩展名给（客户端说什么都不作数）', () => {
    expect(checkUpload({ filename: 'a.csv', bytes: text('a,b') }).content_type).toBe('text/csv')
    expect(checkUpload({ filename: 'a.md', bytes: text('# 标题') }).content_type).toBe(
      'text/markdown',
    )
    expect(
      checkUpload({ filename: 'a.xlsx', bytes: zipWith('xl/workbook.xml') }).content_type,
    ).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  it('真文本收：UTF-8、中文、带 BOM 都行', () => {
    expect(
      checkUpload({ filename: 'a.txt', bytes: text('退货窗口是 30 天') }).size,
    ).toBeGreaterThan(0)
    expect(
      checkUpload({ filename: 'a.csv', bytes: text('\ufeff订单号,金额\nSO-1,128') }).extension,
    ).toBe('csv')
  })

  it('改了名字的二进制收不进来（三条各挡一类）', () => {
    // ① 开头就露馅
    expect(reject({ filename: 'a.txt', bytes: zipWith('word/document.xml') })).toContain(
      '不是纯文本',
    )
    expect(reject({ filename: 'a.md', bytes: PDF })).toContain('不是纯文本')
    expect(reject({ filename: 'a.csv', bytes: OLE2 })).toContain('不是纯文本')
    // ② 正文里有 NUL
    expect(reject({ filename: 'a.txt', bytes: new Uint8Array([104, 105, 0, 104]) })).toContain(
      '不是纯文本',
    )
    // ③ 不是合法 UTF-8
    expect(reject({ filename: 'a.txt', bytes: new Uint8Array([0xff, 0xfe, 0x41]) })).toContain(
      '不是纯文本',
    )
  })
})

describe('sha256 与 blob key', () => {
  it('sha256 是内容的（同内容同 hash，改一个字节就变）', () => {
    const a = checkUpload({ filename: 'a.txt', bytes: text('hello') })
    const b = checkUpload({ filename: '另一个名字.txt', bytes: text('hello') })
    const c = checkUpload({ filename: 'a.txt', bytes: text('hellp') })
    expect(a.sha256).toBe(b.sha256)
    expect(a.sha256).not.toBe(c.sha256)
    expect(a.sha256).toHaveLength(64)
    expect(a.size).toBe(5)
  })

  it('key 只用 ASCII（`assertKey` 那张表不认中文），原名另放元数据', () => {
    const key = uploadBlobKey('ws_1', 'a'.repeat(64), 'xlsx')
    expect(key).toBe(`knowledge/ws_1/${'a'.repeat(64)}.xlsx`)
    expect(/^[A-Za-z0-9/._-]+$/.test(key)).toBe(true)
    // 工作区 id 里万一有别的字符，换成下划线而不是直接拼进去
    expect(
      uploadBlobKey('ws/../etc', 'b'.repeat(64), 'txt').startsWith('knowledge/ws____etc/'),
    ).toBe(true)
    expect(uploadBlobKey('', 'c'.repeat(64), 'txt').startsWith('knowledge/ws/')).toBe(true)
  })

  it('21 §4：主体是工作区（销毁它的密钥 = 它的每一份原件当场读不出来）', () => {
    expect(uploadSubjectRef('ws_1')).toBe('workspace:ws_1')
  })
})
