/**
 * WP99（19 §1.3，36 §11 #13）：**上传一份文件进知识库**——WP97 只留了读口
 * （`knowledge-file.ts`），`kind: 'upload'` 的源只有 demo 在造。这里补上写口那一侧
 * 的**闸**：一份外来文件在落进对象存储之前要过哪几关。
 *
 * 路由与落库在别处（`packages/api/src/routes/knowledge.ts` 与 `server.ts`），
 * 这个文件只做一件事：**判一份字节能不能收**，而且是纯函数——同样的字节
 * 同样的答案，不碰磁盘、不碰网络、不看时钟。
 *
 * ## 六道闸
 *
 * | # | 闸 | 为什么必要 |
 * |---|---|---|
 * | 1 | **大小** ≤ {@link UPLOAD_MAX_BYTES} | 与读口同一个数（64 MB）。两边必须一样：收得进去却读不出来，等于凭空造一条"列得出、打不开"的记录 |
 * | 2 | **扩展名白名单** | 八种（{@link UPLOAD_EXTENSIONS}）。不在表里的一律不收——"先收下来再说"意味着数据目录里迟早躺着 `.html` / `.svg`，而它们是同源 XSS 的现成弹药 |
 * | 3 | **文件名洗净** | 路径分隔符、`..`、控制字符、NUL、前导点、超长一律处理掉。这个名字会进响应头（`Content-Disposition`）、进界面、进日志 |
 * | 4 | **magic bytes 与扩展名对得上** | 光看扩展名等于让上传者自己说自己是什么。`.docx` 必须真是一个带 `word/` 的 zip，`.pdf` 必须真以 `%PDF-` 开头 |
 * | 5 | **不信客户端的 MIME** | `content_type` 由**扩展名**决定（查我们自己那张表），浏览器发来的 `file.type` 一个字都不用 |
 * | 6 | **纯文本档要真的是文本** | `.csv` / `.md` / `.txt` 没有 magic bytes，所以反着判：必须是合法 UTF-8、不含 NUL、开头不是任何一种已知的二进制签名。一个改名成 `.txt` 的可执行文件就此收不进来 |
 *
 * ## 不做的事（写在明处）
 *
 * - **不解析内容**：不拆 zip、不读 XML、不抽文字。解析是下游（`parser: 'anydoc'`）
 *   的事，而且要在用得着的时候才做——在上传这条路上解一份 64 MB 的 xlsx，
 *   等于把服务进程的 CPU 交给上传者决定；
 * - **不查毒**：本机档没有杀毒引擎可接，托管档那一层另说。这不是"忘了"，
 *   是这一层给不出的保证；
 * - **不改字节**：收进来的和存下去的逐字节相同（`sha256` 就是拿它算的）。
 */
import { createHash } from 'node:crypto'
import type { AppError, ErrorCode } from '@agentsws/contracts'
import { SOURCE_FILE_MAX_BYTES } from './knowledge-file.js'

/**
 * 单份上传的上限（64 MB）。
 *
 * **刻意与读口那道闸取同一个数**（`knowledge-file.ts` 的 `SOURCE_FILE_MAX_BYTES`）：
 * 收得进去却读不出来是最难查的一类 bug——列表里有这一行，点开永远 404。
 * 写成引用而不是再抄一个 `64 * 1024 * 1024`，就是不让这两个数有机会分家。
 */
export const UPLOAD_MAX_BYTES = SOURCE_FILE_MAX_BYTES

/**
 * 收哪八种（派工书定的）。
 *
 * 与预览那一栏认的四种（docx / xlsx / csv / pptx）**故意不一样**：
 * 知识库收的是"要进知识的材料"，预览只管"这一栏画不画得出来"。
 * `.xls` / `.pdf` 收得进来、预览不了——那一档在界面上是"点一下下载"。
 */
export const UPLOAD_EXTENSIONS = ['docx', 'xlsx', 'xls', 'csv', 'pptx', 'pdf', 'md', 'txt'] as const

export type UploadExtension = (typeof UPLOAD_EXTENSIONS)[number]

/** 扩展名 → 下发时用的 content-type（**只按扩展名，不信客户端的 MIME**）。 */
const CONTENT_TYPE: Readonly<Record<UploadExtension, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
}

/** 洗完之后文件名最长多少字符（`Content-Disposition` 那一头也按这个数截）。 */
const MAX_FILENAME_CHARS = 120

/** 这条路上唯一会抛的错。`code` 照 28 §2 那张码表，网关照它翻状态码。 */
export class UploadRejected extends Error implements AppError {
  readonly code: ErrorCode

  constructor(message: string, code: ErrorCode = 'invalid_input') {
    super(message)
    this.name = 'UploadRejected'
    this.code = code
  }
}

/**
 * 洗一个文件名。
 *
 * 这个串来自上传者，而它会去三个地方：响应头（`Content-Disposition`）、
 * 界面上那一行、日志。所以：
 *
 * - **只取最后一段**（`a/b/c.docx` → `c.docx`；反斜杠也算分隔符——名字可能是
 *   从 Windows 机器上发来的）；
 * - 控制字符（含 CR / LF / NUL）一律去掉：换行进响应头就是一条头注入；
 * - 前导的 `.` 去掉：`.bashrc` 这种名字在任何界面里都只会添乱；
 * - 截到 {@link MAX_FILENAME_CHARS}，**截的是主名不是扩展名**——
 *   截没了扩展名，这个文件在界面上就变成"不知道是什么"。
 *
 * 洗到空串就抛：没有名字的文件不收（那一条在界面上没法显示，也没法下载）。
 */
export function sanitizeUploadFilename(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? ''
  // 逐字符滤而不是写一条带 \u0000-\u001f 的正则：格式化工具会把那几个转义
  // 还原成**字面的控制字符**写回源码里，于是这一行从此没人读得懂、也没人敢改
  let kept = ''
  for (const ch of last) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    kept += ch
  }
  const cleaned = kept.replace(/^\.+/, '').trim()
  if (cleaned === '') throw new UploadRejected('这个文件没有名字，收不了。')
  const dot = cleaned.lastIndexOf('.')
  if (dot <= 0) {
    if (cleaned.length <= MAX_FILENAME_CHARS) return cleaned
    return cleaned.slice(0, MAX_FILENAME_CHARS)
  }
  const stem = cleaned.slice(0, dot)
  const ext = cleaned.slice(dot)
  if (stem.length + ext.length <= MAX_FILENAME_CHARS) return cleaned
  const room = Math.max(1, MAX_FILENAME_CHARS - ext.length)
  return `${stem.slice(0, room)}${ext}`
}

/** 小写扩展名（不含点）。 */
export function uploadExtensionOf(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i < 0 ? '' : filename.slice(i + 1).toLowerCase()
}

function isAllowed(ext: string): ext is UploadExtension {
  return (UPLOAD_EXTENSIONS as readonly string[]).includes(ext)
}

/** `bytes` 的开头是不是这几个字节。 */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((b, i) => bytes[i] === b)
}

/** ZIP 的三种本地签名：普通、空包、跨卷。OOXML 三兄弟都是 zip。 */
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04]
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06]
const ZIP_SPANNED = [0x50, 0x4b, 0x07, 0x08]
/** OLE2 复合文档（2003 之前的 `.xls` / `.doc` / `.ppt`）。 */
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
/** `%PDF-`。 */
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]

function isZip(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, ZIP_LOCAL) || startsWith(bytes, ZIP_EMPTY) || startsWith(bytes, ZIP_SPANNED)
  )
}

/**
 * zip 里有没有一个以 `prefix` 开头的条目名。
 *
 * **条目名在 zip 里是不压缩的**（本地文件头与中央目录里各存一份明文），所以
 * 在整段字节里找这个 ASCII 串就够——不用解压，也就不给 zip bomb 任何机会。
 *
 * 这一步把"三种 OOXML 互相冒充"挡住了：`word/` 只在 docx 里，`xl/` 只在
 * xlsx 里，`ppt/` 只在 pptx 里。光验 `PK` 的话，把一份 xlsx 改名成 `.docx`
 * 照样进得来，然后在第三栏里画不出来。
 */
function zipHasEntryPrefix(bytes: Uint8Array, prefix: string): boolean {
  const needle = new TextEncoder().encode(prefix)
  const limit = bytes.length - needle.length
  for (let i = 0; i <= limit; i += 1) {
    let hit = true
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) {
        hit = false
        break
      }
    }
    if (hit) return true
  }
  return false
}

/** 已知的二进制签名（纯文本档反着判时用：以它们开头就不是文本）。 */
function looksBinary(bytes: Uint8Array): boolean {
  return isZip(bytes) || startsWith(bytes, OLE2) || startsWith(bytes, PDF)
}

/**
 * 纯文本档（`.csv` / `.md` / `.txt`）没有 magic bytes，所以**反着判**：
 * 必须是合法 UTF-8、不含 NUL、开头不是任何一种已知的二进制签名。
 *
 * 为什么这三条就够：一个改名成 `.txt` 的 exe / zip / pdf 要么开头就露馅，
 * 要么解 UTF-8 时炸（`fatal: true`），要么正文里有 NUL。三条都躲过去的东西
 * ——那它确实就是一段文本。
 */
function isPlainText(bytes: Uint8Array): boolean {
  if (looksBinary(bytes)) return false
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** 字节与扩展名对不对得上（对不上 → `undefined` 之外的那一句人话）。 */
function magicMismatch(ext: UploadExtension, bytes: Uint8Array): string | undefined {
  switch (ext) {
    case 'docx':
    case 'xlsx':
    case 'pptx': {
      if (!isZip(bytes))
        return `这份文件的名字是 .${ext}，但内容不是 Office 的新格式（不是一个 zip 包）。`
      const prefix = ext === 'docx' ? 'word/' : ext === 'xlsx' ? 'xl/' : 'ppt/'
      if (!zipHasEntryPrefix(bytes, prefix))
        return `这份文件的名字是 .${ext}，但里面装的不是 ${ext === 'docx' ? 'Word' : ext === 'xlsx' ? 'Excel' : 'PowerPoint'} 的内容。`
      return undefined
    }
    case 'xls':
      return startsWith(bytes, OLE2)
        ? undefined
        : '这份文件的名字是 .xls，但内容不是 2003 之前那种 Excel 文件。如果它其实是新格式，改名成 .xlsx 再传。'
    case 'pdf':
      return startsWith(bytes, PDF) ? undefined : '这份文件的名字是 .pdf，但内容不是 PDF。'
    case 'csv':
    case 'md':
    case 'txt':
      return isPlainText(bytes)
        ? undefined
        : `这份文件的名字是 .${ext}，但内容不是纯文本（可能是改了名字的其他文件）。`
  }
}

export interface CheckedUpload {
  /** 洗过的原始文件名（给人看的那个）。 */
  filename: string
  extension: UploadExtension
  /** 按扩展名定的 content-type，**不是**客户端发来的那个。 */
  content_type: string
  /** 内容的 sha256（十六进制全长）。溯源链里记的就是它。 */
  sha256: string
  size: number
}

/**
 * 六道闸走一遍。过了给一份**已经洗干净**的描述，没过抛 {@link UploadRejected}
 * （消息是给人看的一句中文，会原样显示在上传那一栏里）。
 */
export function checkUpload(input: { filename: string; bytes: Uint8Array }): CheckedUpload {
  const bytes = input.bytes
  if (bytes.length === 0) throw new UploadRejected('这是一个空文件，收不了。')
  if (bytes.length > UPLOAD_MAX_BYTES)
    throw new UploadRejected(
      `这份文件超过 ${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)} MB，收不了。`,
    )
  const filename = sanitizeUploadFilename(input.filename)
  const ext = uploadExtensionOf(filename)
  if (!isAllowed(ext))
    throw new UploadRejected(
      `知识库只收这几种文件：${UPLOAD_EXTENSIONS.join(' / ')}。这一份是 ${ext === '' ? '没有扩展名' : `.${ext}`}。`,
    )
  const mismatch = magicMismatch(ext, bytes)
  if (mismatch !== undefined) throw new UploadRejected(mismatch)
  return {
    filename,
    extension: ext,
    content_type: CONTENT_TYPE[ext],
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  }
}

/**
 * 对象存储里的 key。
 *
 * **不用原始文件名**：`assertKey`（`packages/blob`）只认一小撮 ASCII，而上传来的
 * 名字里有中文、空格、括号。所以 key 用 `<工作区>/<sha256>.<扩展名>`，
 * 原始名字放在 blob 的元数据里（`BlobMeta.filename`，读口按它回 `Content-Disposition`）。
 *
 * 用内容 hash 当 key 顺带把**同一份文件传两次**变成同一个对象：
 * 不多存一份字节，上层那条 `(workspace_id, kind, ref)` 唯一索引也自然去了重。
 */
export function uploadBlobKey(workspace_id: string, sha256: string, ext: string): string {
  // 工作区 id 那一段连 `.` 都不留：留着就可能拼出一个 `..` 段，而
  // `assertKey` 正是拿它当非法。换成下划线一劳永逸
  const ws = workspace_id.replace(/[^A-Za-z0-9_-]/g, '_')
  return `knowledge/${ws === '' ? 'ws' : ws}/${sha256}.${ext}`
}

/** 21 §4：这份原件是**谁**的——工作区。销毁这个主体的密钥 = 它的每一份原件当场读不出来。 */
export function uploadSubjectRef(workspace_id: string): string {
  return `workspace:${workspace_id}`
}
