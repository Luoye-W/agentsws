/**
 * `@agentsws/blob`：大文件住哪，只由一个 URL 决定（41 §2.4「一键选与技术入口」）。
 *
 * - `AGENTSWS_BLOB_URL` 没设 → 本地目录 `AGENTSWS_DATA_DIR/blobs`（第一档默认）
 * - `file:///volume1/agentsws/blobs` → 本地目录（NAS 共享目录就是这一条）
 * - `s3://bucket/prefix?endpoint=https://oss-cn-shenzhen.aliyuncs.com&region=cn-shenzhen`
 *   → S3 兼容（第二档；凭据从环境变量 / 本机加密库来，**不写在 URL 里**）
 */
import { join } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import type { RawCipher } from '@agentsws/core'
import { LocalBlobStore } from './local-store.js'
import { S3BlobStore } from './s3-store.js'
import { BlobError, type BlobStore } from './types.js'

export { isSealed, open as openEnvelope, seal as sealEnvelope } from './envelope.js'
export { LocalBlobStore, type LocalBlobStoreOptions } from './local-store.js'
export { S3BlobStore, type S3BlobStoreOptions } from './s3-store.js'
export {
  encodePath,
  type PresignInput,
  presignUrl,
  type S3Credentials,
  type SignInput,
  signRequest,
} from './sigv4.js'
export {
  assertKey,
  BlobError,
  type BlobMeta,
  type BlobRef,
  type BlobStat,
  type BlobStore,
  type BlobUri,
  blobKey,
  blobUri,
  type PresignOptions,
} from './types.js'

/** 环境变量名（41 §2.4 的「高级」一栏里显示的就是这几个）。 */
export const BLOB_URL_ENV = 'AGENTSWS_BLOB_URL'
export const BLOB_ACCESS_KEY_ENV = 'AGENTSWS_BLOB_ACCESS_KEY_ID'
export const BLOB_SECRET_ENV = 'AGENTSWS_BLOB_SECRET_ACCESS_KEY'
export const BLOB_SESSION_TOKEN_ENV = 'AGENTSWS_BLOB_SESSION_TOKEN'
export const DATA_DIR_ENV = 'AGENTSWS_DATA_DIR'

export interface OpenBlobStoreOptions {
  clock: Clock
  /** 给了就加密有 `subject_ref` 的对象（21 §4 / 18 §2.1 同一纪律）。 */
  cipher?: RawCipher
  env?: Record<string, string | undefined>
  /** 覆盖环境变量里的 URL（测试与迁移向导用）。 */
  url?: string
  /** 本地档的兜底根目录；缺省 `<AGENTSWS_DATA_DIR>/blobs`。 */
  defaultRoot?: string
  fetch?: typeof globalThis.fetch
}

export async function openBlobStore(options: OpenBlobStoreOptions): Promise<BlobStore> {
  const env = options.env ?? process.env
  const url = options.url ?? env[BLOB_URL_ENV]

  if (url === undefined || url === '' || url.startsWith('file:') || url.startsWith('/')) {
    const root =
      url === undefined || url === ''
        ? (options.defaultRoot ?? join(env[DATA_DIR_ENV] ?? process.cwd(), 'blobs'))
        : url.startsWith('file:')
          ? new URL(url).pathname
          : url
    return LocalBlobStore.open({
      root,
      clock: options.clock,
      ...(options.cipher === undefined ? {} : { cipher: options.cipher }),
    })
  }

  if (url.startsWith('s3://')) {
    const parsed = new URL(url)
    const bucket = parsed.hostname
    if (bucket === '') throw new BlobError('invalid_input', `s3 url has no bucket: ${url}`)
    const endpoint = parsed.searchParams.get('endpoint')
    if (endpoint === null) {
      throw new BlobError(
        'invalid_input',
        's3 url needs ?endpoint=… （阿里 OSS / 腾讯 COS / R2 / MinIO 都靠它区分；AWS 也要写区域端点）',
      )
    }
    const accessKeyId = env[BLOB_ACCESS_KEY_ENV]
    const secretAccessKey = env[BLOB_SECRET_ENV]
    if (accessKeyId === undefined || secretAccessKey === undefined) {
      throw new BlobError(
        'invalid_input',
        `对象存储凭据要从环境变量来：${BLOB_ACCESS_KEY_ENV} / ${BLOB_SECRET_ENV}（35 §2：秘密不写在 URL 里）`,
      )
    }
    const sessionToken = env[BLOB_SESSION_TOKEN_ENV]
    return new S3BlobStore({
      endpoint,
      bucket,
      region: parsed.searchParams.get('region') ?? 'us-east-1',
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken === undefined ? {} : { sessionToken }),
      },
      clock: options.clock,
      ...(options.cipher === undefined ? {} : { cipher: options.cipher }),
      prefix: parsed.pathname.replace(/^\//, ''),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
  }

  throw new BlobError('invalid_input', `unsupported blob url: ${url}`)
}
