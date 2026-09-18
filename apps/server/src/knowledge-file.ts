/**
 * WP97（36 §11，`docs/upstream/sidebar-compare.md` #13）：**按 source_id 读原件字节**。
 *
 * 官方 0.1.6-alpha.2 的 Office 预览是"本机 LibreOffice 转 PDF 再渲染"
 * （`dsh-office-to-pdf` → `@deepseek-ai/libreoffice-kit`，本机那个平台包 259 MB，
 * WP93 已按 16 §3 最严解释 `ignoredOptionalDependencies` 掉了）。**体不借**：
 * 这个文件只做一件事——把一个登记过的导入源的原件字节读出来，一个字节都不改。
 * 转成什么样子由浏览器那一侧的纯 JS 渲染决定（`rail/panels/office-preview-panel.tsx`）。
 *
 * 两种 `ref`（19 §1.3 只说 `ref` 是"由 kind 决定怎么解释"的一个串）：
 *
 * | ref | 从哪读 | 为什么 |
 * |---|---|---|
 * | `blob://<key>` | {@link BlobStore} | 41 §2：大文件只住对象存储，别处只拿引用。密钥销毁之后 `bytes` 为空（21 §4），这里照实回 `undefined` |
 * | 其余（相对路径） | `<数据目录>/uploads/<ref>` | 现在还没有"上传一个文件"的写口（见 §未完成），这一档是给已经放进数据目录的原件留的 |
 *
 * **四道闸**，每一道都因为输入是外来文件而必要：
 *
 * 1. **只认 `kind: 'upload'`**——飞书文档 / 网页 / 邮件线程那几种源的 `ref` 是外部地址，
 *    照着它去读本机文件是一条明晃晃的 SSRF / 任意读；
 * 2. **路径笼子**：`ref` 规范化之后必须仍在 `uploads/` 里（`..` / 绝对路径 / 符号链接
 *    指出去的，一律当不存在）；
 * 3. **大小上限** {@link SOURCE_FILE_MAX_BYTES}：不把服务进程的内存交给一个外来文件决定
 *    （"太大就不预览"是界面那一侧的另一道闸，两道分开——见那个常量的注释）；
 * 4. **不认识的扩展名不给 content-type 猜**：回 `application/octet-stream`，
 *    让浏览器当附件下载，而不是当 HTML 渲染（同源 XSS）。
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { BlobStore } from '@agentsws/blob'
import type { KnowledgeSource, KnowledgeSourceFile } from '@agentsws/contracts'

/**
 * 单个原件的上限（64 MB）。
 *
 * 这是一道**内存闸**，不是预览的那道闸：这条路由要把整个文件读进服务进程的内存
 * 再下发，没有上限就等于"数据目录里放一个 2 GB 的文件 = 服务进程 OOM"。
 *
 * "太大就不预览"那道闸在**界面**（`office-preview-panel.tsx` 的 `PREVIEW_MAX_BYTES`，
 * 20 MB），而且是看 `Content-Length` 之后就把响应体取消掉、**不落地**。
 * 两道闸分开是有意的：20 MB 的 Excel 预览不了，**下载原件仍然要能点**——
 * 把两道闸并成一道的话，界面上那个"下载查看"按钮点下去会 404。
 */
export const SOURCE_FILE_MAX_BYTES = 64 * 1024 * 1024

/** 原件放在数据目录下的哪一层。 */
export const UPLOADS_DIR = 'uploads'

/** `blob://<key>` 的前缀。 */
const BLOB_PREFIX = 'blob://'

/**
 * 扩展名 → content-type。**只列我们认得的那几种**，其余一律当八位字节流。
 *
 * 不用 `mime` 那一类库：一个 600 行的映射表里混着 `text/html` 与 `image/svg+xml`，
 * 而这条路由下发的是用户传上来的文件——多认一种类型就多一次"浏览器把它当页面渲染"的机会。
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  doc: 'application/msword',
  ppt: 'application/vnd.ms-powerpoint',
  csv: 'text/csv',
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function contentTypeOf(name: string): string {
  return CONTENT_TYPES[extensionOf(name)] ?? 'application/octet-stream'
}

/** `a/b/c.docx` → `c.docx`（Windows 的反斜杠也算分隔符：ref 可能是别人机器上写进来的）。 */
export function basenameOf(ref: string): string {
  const parts = ref.split(/[/\\]/)
  return parts[parts.length - 1] ?? ref
}

export interface SourceFileOptions {
  /** 服务进程的数据目录；没有（内存档）就只剩 `blob://` 那一条路。 */
  dataDir?: string
  blobs?: BlobStore
}

/**
 * 把 `ref` 落到 `uploads/` 里的一个真实文件上，落不到就回 `undefined`。
 *
 * 用 `realpathSync` 而不是只比字符串：`uploads/x.docx` 可以是一个指向
 * `/etc/passwd` 的符号链接，字符串比较看不出来，`realpath` 看得出来。
 */
function resolveUpload(ref: string, dataDir: string): string | undefined {
  if (ref === '' || isAbsolute(ref) || ref.includes('\0')) return undefined
  const root = resolve(dataDir, UPLOADS_DIR)
  const target = resolve(root, normalize(ref))
  if (target !== root && !target.startsWith(root + sep)) return undefined
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    return undefined
  }
  const realRoot = (() => {
    try {
      return realpathSync(root)
    } catch {
      return root
    }
  })()
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined
  try {
    if (!statSync(real).isFile()) return undefined
  } catch {
    return undefined
  }
  return real
}

/**
 * 读一个导入源的原件。
 *
 * 读不到、不是 `upload`、超过上限、密钥已销毁——一律 `undefined`（路由翻成 404）。
 * **不抛**：这条路由上"读不到"是常态（源可以登记在案而原件不在这台机器上），
 * 把常态做成异常只会让日志里堆满不是错的错。
 */
export async function knowledgeSourceFile(
  source: KnowledgeSource,
  options: SourceFileOptions,
): Promise<KnowledgeSourceFile | undefined> {
  if (source.kind !== 'upload') return undefined
  const ref = source.ref
  const filename = basenameOf(ref)

  if (ref.startsWith(BLOB_PREFIX)) {
    const store = options.blobs
    if (store === undefined) return undefined
    const key = ref.slice(BLOB_PREFIX.length)
    if (key === '') return undefined
    const got = await store.get(key)
    // 密钥销毁之后 `stat.encrypted` 为真而 `bytes` 为空（21 §4 的 crypto-shredding）——
    // 那不是"文件不见了"，但对这一栏来说结果一样：渲染不出来
    if (got?.bytes === undefined) return undefined
    if (got.bytes.length > SOURCE_FILE_MAX_BYTES) return undefined
    const name = got.stat.filename ?? filename
    return {
      bytes: got.bytes,
      filename: name,
      content_type: got.stat.content_type ?? contentTypeOf(name),
      size: got.bytes.length,
    }
  }

  const dataDir = options.dataDir
  if (dataDir === undefined) return undefined
  const path = resolveUpload(ref, dataDir)
  if (path === undefined) return undefined
  // 先 stat 再读：那道闸要在把文件读进内存**之前**关上
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return undefined
  }
  if (size > SOURCE_FILE_MAX_BYTES) return undefined
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(readFileSync(path))
  } catch {
    return undefined
  }
  return { bytes, filename, content_type: contentTypeOf(filename), size: bytes.length }
}

/** 数据目录里原件该放哪（给写口与测试用的同一个答案）。 */
export function uploadsRoot(dataDir: string): string {
  return join(dataDir, UPLOADS_DIR)
}
