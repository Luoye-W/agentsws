/**
 * 对象存储端口（41 §2「共同底座」的第二个抽象）。
 *
 * 大文件（会议录音、邮件附件、导出包）只住这里；别处只拿 `blob://…` 的引用。
 * 三个档共用同一个面：本地目录（第一档，含 NAS 共享目录）、S3 兼容（第二档
 * 阿里 OSS / AWS S3 / 腾讯 COS / R2 / B2 / NAS 上的 MinIO）、以后托管档。
 *
 * 三条纪律照抄受控原始材料区（18 §2.1）：
 * 1. **加密**：每个对象一把随机密钥，用主体密钥包一层落在对象自己的信封里；
 *    销毁主体密钥（21 §4 的 crypto-shredding）= 这个主体的所有对象当场读不出来。
 * 2. **内容不进模型、不进事件日志**：这一层只吐字节与 `blob://` 引用。
 * 3. **随主体删除**：`subject_ref` 是删除的抓手，没有 subject 的对象就是明文
 *    （比如系统自己的日志附件——这不是漏洞，是「没有主体可绑」）。
 */
import type { Iso8601 } from '@agentsws/contracts'

/** `blob://<key>`。存进业务记录的就是这一个字符串。 */
export type BlobUri = string

export interface BlobMeta {
  content_type?: string
  /** 给人看的原始文件名（下载时用）。 */
  filename?: string
  /** 21 §4：这条内容是**谁**的。给了就加密，没给就明文。 */
  subject_ref?: string
  workspace_id?: string
  /** 其余自定义元数据；值必须是字符串（S3 元数据只吃字符串）。 */
  extra?: Readonly<Record<string, string>>
}

export interface BlobStat {
  key: string
  uri: BlobUri
  /** **明文**字节数。加密档下这不是对象在盘上的大小，是调用方给进来的那个数。 */
  size: number
  content_type?: string
  filename?: string
  subject_ref?: string
  workspace_id?: string
  stored_at: Iso8601
  encrypted: boolean
  extra: Readonly<Record<string, string>>
}

export interface BlobRef {
  uri: BlobUri
  key: string
  size: number
  content_type?: string
}

export interface PresignOptions {
  /** 有效期（秒）。默认 300。 */
  expiresIn?: number
  /** `GET` 下载或 `PUT` 直传。 */
  method?: 'GET' | 'PUT'
}

export interface BlobStore {
  readonly kind: 'local' | 's3'
  put(key: string, body: Uint8Array, meta?: BlobMeta): Promise<BlobRef>
  /** 读不到（不存在）→ undefined；密钥已销毁 → `stat.encrypted` 为真但 `bytes` 为 undefined。 */
  get(key: string): Promise<{ bytes?: Uint8Array; stat: BlobStat } | undefined>
  head(key: string): Promise<BlobStat | undefined>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<BlobStat[]>
  /**
   * 直链。本地档没有（返回 undefined）——本地档的下载走服务进程自己的路由，
   * 不开第二个 HTTP 面。S3 档给一个限时 URL。
   */
  presign?(key: string, options?: PresignOptions): Promise<string | undefined>
  /** 后端描述，给 `GET /v1/storage` 用；**永不含凭据**。 */
  describe(): { kind: 'local' | 's3'; display: string; encrypted: boolean }
  /** 占用（字节）。本地档遍历目录，S3 档遍历 list。贵，只给运维页调。 */
  usage(prefix?: string): Promise<{ objects: number; bytes: number }>
}

export function blobUri(key: string): BlobUri {
  return `blob://${key}`
}

/** `blob://a/b` → `a/b`；不是 blob URI 就原样返回（当成 key）。 */
export function blobKey(uri: BlobUri): string {
  return uri.startsWith('blob://') ? uri.slice('blob://'.length) : uri
}

export class BlobError extends Error {
  readonly code: 'invalid_input' | 'not_found' | 'backend_error' | 'forbidden'

  constructor(
    code: 'invalid_input' | 'not_found' | 'backend_error' | 'forbidden',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause })
    this.name = 'BlobError'
    this.code = code
  }
}

/**
 * key 的合法性。**不许 `..`、不许绝对路径、不许反斜杠**——本地档下一个坏 key
 * 就是任意文件写入；S3 档下是把对象扔进别的前缀。
 */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._~!$'()*+,;=:@-]*(\/[A-Za-z0-9._~!$'()*+,;=:@-]+)*$/

export function assertKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) {
    throw new BlobError('invalid_input', 'blob key must be 1..1024 chars')
  }
  if (!KEY.test(key) || key.split('/').some((part) => part === '.' || part === '..')) {
    throw new BlobError('invalid_input', `illegal blob key: ${key}`)
  }
  return key
}
