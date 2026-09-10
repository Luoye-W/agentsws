/**
 * S3 兼容档（41 §2.2 第二档）。同一份代码接：AWS S3、阿里云 OSS、腾讯云 COS、
 * Cloudflare R2、Backblaze B2、NAS 上自带的 MinIO——**云厂商差异全在 endpoint 与区域**，
 * 不为任何一家写代码（41 F5）。
 *
 * 凭据只从环境变量 / 本机加密库进来（35 §2），只用于算签名：
 * 不进日志、不进事件、不进响应体、不进 OpenAPI。
 */
import type { Clock } from '@agentsws/contracts'
import type { RawCipher } from '@agentsws/core'
import { isSealed, seal, open as unseal } from './envelope.js'
import { encodePath, presignUrl, type S3Credentials, signRequest } from './sigv4.js'
import {
  assertKey,
  BlobError,
  type BlobMeta,
  type BlobRef,
  type BlobStat,
  type BlobStore,
  blobUri,
  type PresignOptions,
} from './types.js'

export interface S3BlobStoreOptions {
  /** `https://oss-cn-shenzhen.aliyuncs.com` / `http://127.0.0.1:9000`（MinIO）。 */
  endpoint: string
  bucket: string
  region?: string
  credentials: S3Credentials
  clock: Clock
  cipher?: RawCipher
  /** 所有 key 的公共前缀（一个桶装多个工作区时用）。 */
  prefix?: string
  fetch?: typeof globalThis.fetch
}

/** S3 元数据头的前缀。值必须是 ASCII，所以中文文件名走 base64。 */
const META = 'x-amz-meta-'

function encodeMetaValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function decodeMetaValue(value: string | null): string | undefined {
  if (value === null) return undefined
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const
  readonly #endpoint: URL
  readonly #bucket: string
  readonly #region: string
  readonly #credentials: S3Credentials
  readonly #clock: Clock
  readonly #cipher: RawCipher | undefined
  readonly #prefix: string
  readonly #fetch: typeof globalThis.fetch

  constructor(options: S3BlobStoreOptions) {
    this.#endpoint = new URL(options.endpoint)
    this.#bucket = options.bucket
    this.#region = options.region ?? 'us-east-1'
    this.#credentials = options.credentials
    this.#clock = options.clock
    this.#cipher = options.cipher
    this.#prefix =
      options.prefix === undefined || options.prefix === ''
        ? ''
        : `${options.prefix.replace(/\/+$/, '')}/`
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  describe(): { kind: 's3'; display: string; encrypted: boolean } {
    return {
      kind: 's3',
      // 只有 endpoint / bucket / 前缀，没有 access key
      display: `${this.#endpoint.host}/${this.#bucket}${this.#prefix === '' ? '' : `/${this.#prefix}`}`,
      encrypted: this.#cipher !== undefined,
    }
  }

  #url(key: string, query: Record<string, string> = {}): URL {
    const url = new URL(this.#endpoint.toString())
    const path = `${this.#bucket}/${this.#prefix}${assertKey(key)}`
    url.pathname = `/${path}`
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    return url
  }

  async #send(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    url: URL,
    init: { headers?: Record<string, string>; body?: Uint8Array } = {},
  ): Promise<Response> {
    const headers = signRequest({
      method,
      url,
      headers: init.headers ?? {},
      ...(init.body === undefined ? {} : { body: init.body }),
      region: this.#region,
      credentials: this.#credentials,
      now: new Date(this.#clock.now()),
    })
    const response = await this.#fetch(url.toString(), {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: Buffer.from(init.body) }),
    })
    return response
  }

  async put(key: string, body: Uint8Array, meta: BlobMeta = {}): Promise<BlobRef> {
    const subject = meta.subject_ref
    const encrypt = this.#cipher !== undefined && subject !== undefined && subject.length > 0
    const bytes = encrypt ? seal(this.#cipher as RawCipher, subject as string, key, body) : body

    const headers: Record<string, string> = {
      'content-type': meta.content_type ?? 'application/octet-stream',
      'content-length': String(bytes.length),
      [`${META}size`]: String(body.length),
      [`${META}stored-at`]: this.#clock.now(),
      [`${META}encrypted`]: encrypt ? '1' : '0',
    }
    if (meta.filename !== undefined) headers[`${META}filename`] = encodeMetaValue(meta.filename)
    if (subject !== undefined) headers[`${META}subject`] = encodeMetaValue(subject)
    if (meta.workspace_id !== undefined) headers[`${META}workspace`] = meta.workspace_id
    for (const [k, v] of Object.entries(meta.extra ?? {})) {
      if (!/^[a-z0-9-]{1,40}$/.test(k))
        throw new BlobError('invalid_input', `illegal meta key: ${k}`)
      headers[`${META}x-${k}`] = encodeMetaValue(v)
    }

    const response = await this.#send('PUT', this.#url(key), { headers, body: bytes })
    if (!response.ok) throw await backendError('PUT', key, response)
    return {
      uri: blobUri(key),
      key,
      size: body.length,
      ...(meta.content_type === undefined ? {} : { content_type: meta.content_type }),
    }
  }

  #stat(key: string, response: Response): BlobStat {
    const h = response.headers
    const filename = decodeMetaValue(h.get(`${META}filename`))
    const subject = decodeMetaValue(h.get(`${META}subject`))
    const workspace = h.get(`${META}workspace`)
    const extra: Record<string, string> = {}
    for (const [name, value] of h) {
      if (!name.startsWith(`${META}x-`)) continue
      const decoded = decodeMetaValue(value)
      if (decoded !== undefined) extra[name.slice(`${META}x-`.length)] = decoded
    }
    const declared = Number(h.get(`${META}size`) ?? Number.NaN)
    return {
      key,
      uri: blobUri(key),
      size: Number.isFinite(declared) ? declared : Number(h.get('content-length') ?? 0),
      ...(h.get('content-type') === null ? {} : { content_type: h.get('content-type') as string }),
      ...(filename === undefined ? {} : { filename }),
      ...(subject === undefined ? {} : { subject_ref: subject }),
      ...(workspace === null ? {} : { workspace_id: workspace }),
      stored_at: h.get(`${META}stored-at`) ?? h.get('last-modified') ?? this.#clock.now(),
      encrypted: h.get(`${META}encrypted`) === '1',
      extra,
    }
  }

  async head(key: string): Promise<BlobStat | undefined> {
    const response = await this.#send('HEAD', this.#url(key))
    if (response.status === 404) return undefined
    if (!response.ok) throw await backendError('HEAD', key, response)
    return this.#stat(key, response)
  }

  async get(key: string): Promise<{ bytes?: Uint8Array; stat: BlobStat } | undefined> {
    const response = await this.#send('GET', this.#url(key))
    if (response.status === 404) return undefined
    if (!response.ok) throw await backendError('GET', key, response)
    const raw = new Uint8Array(await response.arrayBuffer())
    const stat = this.#stat(key, response)
    if (!isSealed(raw)) return { bytes: raw, stat }
    const subject = stat.subject_ref
    if (this.#cipher === undefined || subject === undefined) return { stat }
    const plain = unseal(this.#cipher, subject, key, raw)
    return plain === undefined ? { stat } : { bytes: plain, stat }
  }

  async delete(key: string): Promise<void> {
    const response = await this.#send('DELETE', this.#url(key))
    if (!response.ok && response.status !== 404) throw await backendError('DELETE', key, response)
  }

  /** ListObjectsV2；分页跟到底（`is-truncated` + `continuation-token`）。 */
  async #listKeys(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = []
    let token: string | undefined
    do {
      const url = new URL(this.#endpoint.toString())
      url.pathname = `/${this.#bucket}`
      url.searchParams.set('list-type', '2')
      url.searchParams.set('prefix', `${this.#prefix}${prefix}`)
      url.searchParams.set('max-keys', '1000')
      if (token !== undefined) url.searchParams.set('continuation-token', token)
      const response = await this.#send('GET', url)
      if (!response.ok) throw await backendError('LIST', prefix, response)
      const xml = await response.text()
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const chunk = match[1] ?? ''
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(chunk)?.[1]
        const size = Number(/<Size>(\d+)<\/Size>/.exec(chunk)?.[1] ?? '0')
        if (key === undefined) continue
        out.push({ key: unescapeXml(key).slice(this.#prefix.length), size })
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? (/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? undefined)
        : undefined
      if (token !== undefined) token = unescapeXml(token)
    } while (token !== undefined)
    return out
  }

  async list(prefix = ''): Promise<BlobStat[]> {
    const keys = await this.#listKeys(prefix)
    const out: BlobStat[] = []
    for (const { key } of keys) {
      const stat = await this.head(key)
      if (stat !== undefined) out.push(stat)
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  async usage(prefix = ''): Promise<{ objects: number; bytes: number }> {
    const keys = await this.#listKeys(prefix)
    return { objects: keys.length, bytes: keys.reduce((sum, k) => sum + k.size, 0) }
  }

  /**
   * 限时直链。**加密过的对象不给直链**——直链绕过我们这一层，
   * 拿到的会是信封字节，用户下载下来打不开；给了反而是骗人。
   */
  async presign(key: string, options: PresignOptions = {}): Promise<string | undefined> {
    const stat = await this.head(key)
    if (stat?.encrypted === true) return undefined
    return presignUrl({
      method: options.method ?? 'GET',
      url: this.#url(key),
      region: this.#region,
      credentials: this.#credentials,
      expiresIn: options.expiresIn ?? 300,
      now: new Date(this.#clock.now()),
    })
  }
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 后端的错误正文里可能带桶名与请求 id，不带凭据；原样收进 message 便于排查。 */
async function backendError(op: string, key: string, response: Response): Promise<BlobError> {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 400)
  } catch {
    // 正文读不出来就算了
  }
  return new BlobError(
    response.status === 403 ? 'forbidden' : 'backend_error',
    `S3 ${op} ${key} failed: ${response.status} ${detail}`,
  )
}

export { encodePath }
