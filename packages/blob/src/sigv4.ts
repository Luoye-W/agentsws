/**
 * AWS Signature V4（S3 REST）——**自己写的那 200 行**，不装 `@aws-sdk/client-s3`。
 *
 * 为什么不装 SDK（35 §2「只准新增一个依赖」之外还有一条更硬的理由）：
 * `@aws-sdk/client-s3` 连它的传递依赖解压后 40 MB 上下，桌面壳打包与 NAS 镜像
 * 都得背着它；WP 里曾因为同一个理由拒过一次。我们要的只有五个动作
 * （PUT / GET / HEAD / DELETE / ListObjectsV2）与一种签名，签名算法是公开且稳定的，
 * 自己写反而更容易讲清楚：**凭据只用来算签名，从不进日志、不进 URL 的可见部分**。
 *
 * 覆盖面写清楚（不夸大）：
 * - 只做 **path-style** 寻址（`https://endpoint/bucket/key`）。MinIO、阿里 OSS、
 *   腾讯 COS、R2、B2 都支持；AWS S3 的新桶也仍然支持带区域端点的 path-style。
 * - 只做 `UNSIGNED-PAYLOAD` 之外的**单块签名**（把整段字节的 sha256 算出来签进去），
 *   没有分块上传（multipart）。单个对象上限按后端的单次 PUT 上限（S3 是 5 GB）。
 * - 查询串签名（presign）只做 GET / PUT。
 */
import { createHash, createHmac } from 'node:crypto'

export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
  /** 临时凭据的会话令牌（云上的 STS）。 */
  sessionToken?: string
}

export interface SignInput {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
  /** 完整 URL（含 query）。 */
  url: URL
  /** 已经准备好的请求头（不含 Authorization / x-amz-date / x-amz-content-sha256）。 */
  headers: Record<string, string>
  /** 请求体；GET / HEAD / DELETE 传空。 */
  body?: Uint8Array
  region: string
  service?: string
  credentials: S3Credentials
  /** 注入的时刻（35 §2：不裸调 Date.now）。 */
  now: Date
}

const ALGORITHM = 'AWS4-HMAC-SHA256'

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))
    .digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** `20260910T031500Z` / `20260910`。 */
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

/**
 * S3 的路径编码：每一段都编码，但 `/` 保留。`encodeURIComponent` 不编码
 * `!'()*`，而 SigV4 要求编码它们——不补这一步，带这些字符的文件名就会签名不匹配。
 */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/')
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = []
  for (const [k, v] of url.searchParams) pairs.push([k, v])
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
  return pairs
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}=${encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    )
    .join('&')
}

function signingKey(
  credentials: S3Credentials,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

/** 给请求头签名。返回要加上去的头（含 Authorization）。 */
export function signRequest(input: SignInput): Record<string, string> {
  const service = input.service ?? 's3'
  const { amzDate, dateStamp } = stamps(input.now)
  const payloadHash = sha256Hex(input.body ?? new Uint8Array())

  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(input.credentials.sessionToken === undefined
      ? {}
      : { 'x-amz-security-token': input.credentials.sessionToken }),
  }

  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
  const canonicalHeaders = names
    .map((name) => {
      const value = Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? ''
      return `${name}:${String(value).trim().replace(/\s+/g, ' ')}\n`
    })
    .join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [
    input.method,
    encodePath(input.url.pathname),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmac(
    signingKey(input.credentials, dateStamp, input.region, service),
    stringToSign,
  ).toString('hex')

  return {
    ...headers,
    Authorization: `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

export interface PresignInput {
  method: 'GET' | 'PUT'
  url: URL
  region: string
  service?: string
  credentials: S3Credentials
  expiresIn: number
  now: Date
}

/** 查询串签名。凭据里只有 access key id 出现在 URL 上，密钥永远不出现。 */
export function presignUrl(input: PresignInput): string {
  const service = input.service ?? 's3'
  const { amzDate, dateStamp } = stamps(input.now)
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`
  const url = new URL(input.url.toString())
  url.searchParams.set('X-Amz-Algorithm', ALGORITHM)
  url.searchParams.set('X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`)
  url.searchParams.set('X-Amz-Date', amzDate)
  url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(input.expiresIn, 604800))))
  url.searchParams.set('X-Amz-SignedHeaders', 'host')
  if (input.credentials.sessionToken !== undefined) {
    url.searchParams.set('X-Amz-Security-Token', input.credentials.sessionToken)
  }

  const canonicalRequest = [
    input.method,
    encodePath(url.pathname),
    canonicalQuery(url),
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmac(
    signingKey(input.credentials, dateStamp, input.region, service),
    stringToSign,
  ).toString('hex')
  url.searchParams.set('X-Amz-Signature', signature)
  return url.toString()
}
