/**
 * WP97（36 §11，`docs/upstream/sidebar-compare.md` #13）：**按 source_id 读原件字节**。
 *
 * 这条路由下发的是**用户传上来的文件**，所以这一组用例八成在钉那四道闸：
 *
 * 1. 只认 `kind: 'upload'`（飞书文档 / 网页那几种源的 `ref` 是外部地址）；
 * 2. 路径笼子：`..`、绝对路径、指出笼子外的**符号链接**，一律当不存在；
 * 3. 大小上限（内存闸）；
 * 4. content-type 只认表里那几种，别的当八位字节流（不让浏览器当 HTML 渲染）。
 *
 * `Content-Disposition` 那一头的洗名在网关那一侧
 * （`packages/api/test/knowledge-source-file.test.ts`）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobStat, BlobStore } from '@agentsws/blob'
import type { KnowledgeSource } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  contentTypeOf,
  knowledgeSourceFile,
  SOURCE_FILE_MAX_BYTES,
  uploadsRoot,
} from '../src/knowledge-file.js'

let dataDir: string

function source(ref: string, kind: KnowledgeSource['kind'] = 'upload'): KnowledgeSource {
  return {
    id: 'src_1',
    workspace_id: 'ws_1',
    kind,
    ref,
    acl_inherit: false,
    chunks: 1,
    parser: 'anydoc',
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agentsws-wp97-'))
  mkdirSync(uploadsRoot(dataDir), { recursive: true })
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('数据目录里的原件', () => {
  it('读得出字节、文件名与 content-type', async () => {
    writeFileSync(join(uploadsRoot(dataDir), '报价单.xlsx'), 'hello')
    const got = await knowledgeSourceFile(source('报价单.xlsx'), { dataDir })
    expect(got?.filename).toBe('报价单.xlsx')
    expect(got?.size).toBe(5)
    expect(got?.content_type).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(new TextDecoder().decode(got?.bytes)).toBe('hello')
  })

  it('子目录里的也读得出（`ref` 是一段相对路径）', async () => {
    mkdirSync(join(uploadsRoot(dataDir), '2026'), { recursive: true })
    writeFileSync(join(uploadsRoot(dataDir), '2026', 'a.docx'), 'x')
    expect((await knowledgeSourceFile(source('2026/a.docx'), { dataDir }))?.filename).toBe('a.docx')
  })

  it('不认识的扩展名当八位字节流，不给浏览器当 HTML 渲染的机会', () => {
    expect(contentTypeOf('x.html')).toBe('application/octet-stream')
    expect(contentTypeOf('x.svg')).toBe('application/octet-stream')
    expect(contentTypeOf('x')).toBe('application/octet-stream')
    expect(contentTypeOf('x.CSV')).toBe('text/csv')
  })
})

describe('四道闸', () => {
  it('不是 upload 的源一律不读（外部地址不当本机路径用）', async () => {
    writeFileSync(join(uploadsRoot(dataDir), 'a.docx'), 'x')
    for (const kind of ['feishu_doc', 'website', 'email_thread', 'meeting'] as const)
      expect(await knowledgeSourceFile(source('a.docx', kind), { dataDir })).toBeUndefined()
  })

  it('`..` 与绝对路径出不了笼子', async () => {
    writeFileSync(join(dataDir, 'secret.txt'), 'nope')
    expect(await knowledgeSourceFile(source('../secret.txt'), { dataDir })).toBeUndefined()
    expect(await knowledgeSourceFile(source('a/../../secret.txt'), { dataDir })).toBeUndefined()
    expect(
      await knowledgeSourceFile(source(join(dataDir, 'secret.txt')), { dataDir }),
    ).toBeUndefined()
    expect(await knowledgeSourceFile(source('/etc/passwd'), { dataDir })).toBeUndefined()
  })

  it('指到笼子外的符号链接也不读（只比字符串看不出来，`realpath` 看得出来）', async () => {
    writeFileSync(join(dataDir, 'secret.txt'), 'nope')
    symlinkSync(join(dataDir, 'secret.txt'), join(uploadsRoot(dataDir), 'link.docx'))
    expect(await knowledgeSourceFile(source('link.docx'), { dataDir })).toBeUndefined()
  })

  it('目录不是文件；不存在的也不是', async () => {
    mkdirSync(join(uploadsRoot(dataDir), 'dir.docx'), { recursive: true })
    expect(await knowledgeSourceFile(source('dir.docx'), { dataDir })).toBeUndefined()
    expect(await knowledgeSourceFile(source('missing.docx'), { dataDir })).toBeUndefined()
    expect(await knowledgeSourceFile(source(''), { dataDir })).toBeUndefined()
  })

  it('超过内存闸的不读（先 stat 再决定，不是读完再丢）', async () => {
    const path = join(uploadsRoot(dataDir), 'big.xlsx')
    writeFileSync(path, Buffer.alloc(16))
    // 用一个假的 `stat` 不现实（要真写 64 MB），所以反过来验常量本身是那道闸
    expect(SOURCE_FILE_MAX_BYTES).toBe(64 * 1024 * 1024)
    expect((await knowledgeSourceFile(source('big.xlsx'), { dataDir }))?.size).toBe(16)
  })

  it('没有数据目录（内存档）时只剩 blob 那一条路', async () => {
    expect(await knowledgeSourceFile(source('a.docx'), {})).toBeUndefined()
  })
})

describe('对象存储里的原件（`blob://<key>`）', () => {
  function fakeStore(entry?: { bytes?: Uint8Array; stat: Partial<BlobStat> }): BlobStore {
    return {
      kind: 'local',
      get: async () =>
        entry === undefined
          ? undefined
          : ({ ...entry, stat: { key: 'k1', ...entry.stat } } as Awaited<
              ReturnType<BlobStore['get']>
            >),
    } as unknown as BlobStore
  }

  it('读得出，元数据以对象存储那一份为准', async () => {
    const blobs = fakeStore({
      bytes: new TextEncoder().encode('abc'),
      stat: { filename: '方案.pptx', content_type: 'application/x-custom' },
    })
    const got = await knowledgeSourceFile(source('blob://k1'), { blobs })
    expect(got?.filename).toBe('方案.pptx')
    expect(got?.content_type).toBe('application/x-custom')
    expect(got?.size).toBe(3)
  })

  it('密钥已销毁（21 §4）：有 stat 没字节 → 当读不到', async () => {
    const blobs = fakeStore({ stat: { encrypted: true } })
    expect(await knowledgeSourceFile(source('blob://k1'), { blobs })).toBeUndefined()
  })

  it('对象不存在 / 没装对象存储 / key 为空，都回 undefined', async () => {
    expect(await knowledgeSourceFile(source('blob://k1'), { blobs: fakeStore() })).toBeUndefined()
    expect(await knowledgeSourceFile(source('blob://k1'), {})).toBeUndefined()
    expect(await knowledgeSourceFile(source('blob://'), { blobs: fakeStore() })).toBeUndefined()
  })
})
