/**
 * DeepSeek Messages 口的 **Files API 复用**（WP143）：同一张图只上传一次，请求里发 file id。
 *
 * 移植自 `@deepseek-ai/dsh-llm-deepseek@0.1.7-rc.1`（MIT，deepseek-ai/deepseek-harness
 * `packages/llm/llm-deepseek`），对应官方 `lib/index.js` 里的这几段：
 * - `lib/types/messages-api.js`：`MESSAGES_FILES_BETA`、`messagesApiRoot`；
 * - `lib/types/files-api.js`：`DeepSeekFilesClient.request / upload`、`parseFileObject`、
 *   `providerErrorDetail$1`（上传只要这两样；`list / retrieve / delete` 没搬，见下）；
 * - `lib/types/upload-index.js`：`deepSeekFileScope`、`reusable`、记录形状（去掉 `attachmentId` /
 *   `variantId` 两格，换成一格按字节算的 `imageKey`——我们没有官方的附件服务）；
 * - `lib/types/file-store.js`：`DeepSeekFileStore.ensureUploaded / invalidate` 与 singleflight；
 * - `lib/types/request-files.js`：`providerRejectedFileId`、`detailNamesFileId`、`staleMappings`。
 *
 * 与官方的差别（都写进了 WP143 报告）：
 * - **索引默认只在内存**；可选落本机一个 JSON 文件（{@link jsonFileUploadIndex}，0600）——**不上云**。
 * - **不做配额清理**（官方配额满时删最老的一批自家文件再传一次）：那是删用户账号里远端文件的动作，
 *   本单不做；配额满 = 这次解析失败 = 整份请求退回内联 base64，照样能用。
 * - 等待方不能单独取消（官方有"带等待方局部取消的 singleflight"）；我们的调用方没有取消信号，
 *   每次解析各自有超时，超时就退内联。
 *
 * 凭据纪律：令牌 / key **只进请求头**。落盘与内存键里用的是官方同款的 `scope`
 * （`sha256(接口根 \0 凭据)`），不是凭据本身；错误信封里只有状态码与上游的错误字段。
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 官方同款：Files 请求与带 file id 的模型请求都要带这个 beta 头。 */
export const MESSAGES_FILES_BETA = 'files-api-2025-04-14'

/** 官方默认：上传时要求远端保留 7 天；剩余复用期不足 1 小时就换一个新 id；一次解析最多等 60 秒。 */
export const DEFAULT_FILE_EXPIRY_SECONDS = 10080 * 60
export const DEFAULT_FILE_REFRESH_MARGIN_SECONDS = 3600
export const DEFAULT_FILES_API_TIMEOUT_MS = 60_000

/** 官方 `messagesApiRoot`：显式写了 `/v1` 的根不再重复加。 */
export function messagesApiRoot(baseURL: string): string {
  const base = baseURL.replace(/\/+$/u, '')
  return new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`
}

export type FilesFetch = (
  input: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: FormData
    redirect: 'error'
    signal?: AbortSignal
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

/** 一次 Files 调用要的连接事实。`credential` 只进头、只当哈希输入。 */
export interface DeepSeekFileConnection {
  baseURL: string
  credential: string
  /** 账号令牌走 `x-dsh-auth-token`（不加 Bearer）；否则是 API key，走 `x-api-key`。 */
  accountCredential: boolean
}

/** 要上传的一张图（请求里的原样字节）。 */
export interface DeepSeekRequestImage {
  /** 按字节算的稳定键（{@link imageKeyOf}）。 */
  key: string
  data: Uint8Array
  mime: string
}

/** 一条"这张图 → 远端 file id"的映射。时间都是毫秒。 */
export interface DeepSeekUploadRecord {
  scope: string
  imageKey: string
  fileId: string
  bytes: number
  createdAt: number
  expiresAt: number
}

/** 映射放哪儿：默认内存；可选本机 JSON 文件。 */
export interface DeepSeekUploadIndex {
  get(
    scope: string,
    imageKey: string,
    now: number,
    refreshMarginMs: number,
  ): DeepSeekUploadRecord | undefined
  put(record: DeepSeekUploadRecord, now: number, refreshMarginMs: number): void
  remove(scope: string, imageKey: string, fileId: string): void
}

/** Files 口的失败（状态码 + 上游错误字段拼成的 detail，只用来分类）。 */
export class DeepSeekFilesError extends Error {
  readonly status: number
  readonly detail: string
  constructor(message: string, status: number, detail: string) {
    super(message)
    this.name = 'DeepSeekFilesError'
    this.status = status
    this.detail = detail
  }
}

/** 官方 `deepSeekFileScope`：不落凭据本身，只落它参与的哈希。 */
export function deepSeekFileScope(baseURL: string, credential: string): string {
  return createHash('sha256')
    .update(messagesApiRoot(baseURL).replace(/\/+$/u, ''))
    .update('\0')
    .update(credential)
    .digest('hex')
}

/** 同一张图（同字节、同类型）永远得到同一个键。 */
export function imageKeyOf(mime: string, data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(mime).update('\0').update(data).digest('hex')}`
}

const reusable = (record: DeepSeekUploadRecord, now: number, marginMs: number): boolean =>
  record.expiresAt - now > marginMs

/** 默认的内存索引（一个进程一份；进程重启就全部重传一次）。 */
export function memoryUploadIndex(): DeepSeekUploadIndex {
  const records = new Map<string, DeepSeekUploadRecord>()
  const k = (scope: string, imageKey: string) => `${scope}\0${imageKey}`
  return {
    get(scope, imageKey, now, marginMs) {
      const r = records.get(k(scope, imageKey))
      return r !== undefined && reusable(r, now, marginMs) ? r : undefined
    },
    put(record, now, marginMs) {
      for (const [key, r] of records) if (!reusable(r, now, marginMs)) records.delete(key)
      records.set(k(record.scope, record.imageKey), record)
    },
    remove(scope, imageKey, fileId) {
      if (records.get(k(scope, imageKey))?.fileId === fileId) records.delete(k(scope, imageKey))
    },
  }
}

/**
 * 可选：落本机一个 JSON 文件（官方落 `DSH_HOME/llm-deepseek/files-v3.json`，我们落在调用方给的
 * 目录里，通常是这个品牌的 `models.json` 旁边）。文件权限 0600；读坏了当空的。**不上云。**
 * 文件里只有 scope 哈希、图片哈希、file id 与时间——没有凭据、没有图。
 */
export function jsonFileUploadIndex(path: string): DeepSeekUploadIndex {
  const memory = memoryUploadIndex()
  const all: DeepSeekUploadRecord[] = []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; records?: unknown }
    if (parsed.version === 1 && Array.isArray(parsed.records)) {
      for (const r of parsed.records as DeepSeekUploadRecord[]) {
        if (
          typeof r?.scope === 'string' &&
          typeof r.imageKey === 'string' &&
          typeof r.fileId === 'string' &&
          r.fileId.length > 0 &&
          Number.isSafeInteger(r.createdAt) &&
          Number.isSafeInteger(r.expiresAt)
        ) {
          all.push(r)
        }
      }
    }
  } catch {
    // 没有 / 读坏了：当空的（官方同款：InvalidUploadIndexError 也当空）
  }
  const live = new Map(all.map((r) => [`${r.scope}\0${r.imageKey}`, r]))
  for (const r of live.values()) memory.put(r, r.createdAt, 0)
  const save = (): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(
      path,
      `${JSON.stringify({ version: 1, records: [...live.values()] }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    )
    chmodSync(path, 0o600)
  }
  return {
    get: (scope, imageKey, now, marginMs) => memory.get(scope, imageKey, now, marginMs),
    put(record, now, marginMs) {
      memory.put(record, now, marginMs)
      for (const [key, r] of live) if (!reusable(r, now, marginMs)) live.delete(key)
      live.set(`${record.scope}\0${record.imageKey}`, record)
      save()
    },
    remove(scope, imageKey, fileId) {
      memory.remove(scope, imageKey, fileId)
      const key = `${scope}\0${imageKey}`
      if (live.get(key)?.fileId === fileId) {
        live.delete(key)
        save()
      }
    },
  }
}

/** 官方 `providerErrorDetail$1`：只取 `error.code / type / message` 三格拼起来（分类用）。 */
export function providerErrorDetail(raw: unknown): { message?: string; detail: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { detail: '' }
  const error = (raw as { error?: unknown }).error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return { detail: '' }
  const f = error as Record<string, unknown>
  return {
    ...(typeof f.message === 'string' ? { message: f.message } : {}),
    detail: [f.code, f.type, f.message].filter((x): x is string => typeof x === 'string').join(' '),
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * 官方 `DeepSeekFilesClient.upload`：`POST <根>/v1/files`（multipart），要求远端按上传时间
 * 保留 `expiresAfterSeconds`；拒绝重定向；凭据只在头里。回的对象照官方 `parseFileObject` 校验。
 */
export async function uploadDeepSeekFile(
  fetchImpl: FilesFetch,
  connection: DeepSeekFileConnection,
  input: { data: Uint8Array; mime: string; filename: string; expiresAfterSeconds: number },
  signal?: AbortSignal,
): Promise<{ id: string; bytes: number; createdAt: number; expiresAt: number }> {
  const root = messagesApiRoot(connection.baseURL)
  const form = new FormData()
  form.set('expires_after[anchor]', 'created_at')
  form.set('expires_after[seconds]', String(input.expiresAfterSeconds))
  form.set('file', new Blob([Uint8Array.from(input.data)], { type: input.mime }), input.filename)
  let res: Awaited<ReturnType<FilesFetch>>
  try {
    res = await fetchImpl(`${root}/files`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        [connection.accountCredential ? 'x-dsh-auth-token' : 'x-api-key']: connection.credential,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': MESSAGES_FILES_BETA,
      },
      body: form,
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (e) {
    // 不带原始错误文本：有些 fetch 实现会把请求头拼进报错
    throw new DeepSeekFilesError(
      `DeepSeek Files API request to ${root} failed (${e instanceof Error ? e.name : 'error'})`,
      0,
      '',
    )
  }
  if (!res.ok) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await res.text())
    } catch {}
    const { message, detail } = providerErrorDetail(parsed)
    throw new DeepSeekFilesError(
      message ?? `DeepSeek Files API error (HTTP ${res.status})`,
      res.status,
      detail,
    )
  }
  const wire = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined
  const createdAt =
    typeof wire?.created_at === 'string' ? Math.floor(Date.parse(wire.created_at) / 1000) : NaN
  if (
    wire === undefined ||
    typeof wire.id !== 'string' ||
    wire.id.length === 0 ||
    wire.type !== 'file' ||
    typeof wire.size_bytes !== 'number' ||
    !Number.isSafeInteger(wire.size_bytes) ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  ) {
    throw new DeepSeekFilesError(
      'DeepSeek Files API returned an invalid upload response.',
      res.status,
      '',
    )
  }
  return {
    id: wire.id,
    bytes: wire.size_bytes,
    createdAt,
    expiresAt: createdAt + input.expiresAfterSeconds,
  }
}

export interface DeepSeekFileStoreOptions {
  index?: DeepSeekUploadIndex
  now?: () => number
  /** 缺省 `globalThis.fetch`。测试注入替身（不联网）。 */
  fetch?: FilesFetch
  expiresAfterSeconds?: number
  refreshMarginSeconds?: number
}

/**
 * 官方 `DeepSeekFileStore`：按 (接口根 + 凭据) 的 scope 与图片键找可复用的 file id，没有就传一次。
 * 同一张图并发解析只传一次（singleflight）。**一个服务进程共用一个**（装配方持有），
 * 所以同一次运行、同一个会话、乃至下一次运行里的同一张图都只传一次（直到过期）。
 */
export class DeepSeekFileStore {
  private readonly index: DeepSeekUploadIndex
  private readonly now: () => number
  private readonly fetchImpl: FilesFetch
  private readonly expiresAfterSeconds: number
  private readonly marginMs: number
  private readonly inflight = new Map<string, Promise<DeepSeekUploadRecord>>()
  /** 真的发出去的上传次数（测试与报告的省量估算用；不含失败的）。 */
  uploads = 0

  constructor(options: DeepSeekFileStoreOptions = {}) {
    this.index = options.index ?? memoryUploadIndex()
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FilesFetch)
    this.expiresAfterSeconds = options.expiresAfterSeconds ?? DEFAULT_FILE_EXPIRY_SECONDS
    this.marginMs = (options.refreshMarginSeconds ?? DEFAULT_FILE_REFRESH_MARGIN_SECONDS) * 1000
  }

  /** 解析一张图的 file id：有可复用的就用，没有就上传。`uploaded` = 这一次是不是真传了。 */
  async ensureUploaded(
    image: DeepSeekRequestImage,
    connection: DeepSeekFileConnection,
    signal?: AbortSignal,
  ): Promise<{ fileId: string; uploaded: boolean }> {
    const scope = deepSeekFileScope(connection.baseURL, connection.credential)
    const cached = this.index.get(scope, image.key, this.now(), this.marginMs)
    if (cached !== undefined) return { fileId: cached.fileId, uploaded: false }
    const key = `${scope}\0${image.key}`
    const active = this.inflight.get(key)
    if (active !== undefined) return { fileId: (await active).fileId, uploaded: false }
    const run = this.upload(image, connection, scope, signal)
    this.inflight.set(key, run)
    try {
      return { fileId: (await run).fileId, uploaded: true }
    } finally {
      if (this.inflight.get(key) === run) this.inflight.delete(key)
    }
  }

  private async upload(
    image: DeepSeekRequestImage,
    connection: DeepSeekFileConnection,
    scope: string,
    signal?: AbortSignal,
  ): Promise<DeepSeekUploadRecord> {
    const remote = await uploadDeepSeekFile(
      this.fetchImpl,
      connection,
      {
        data: image.data,
        mime: image.mime,
        filename: `agentsws-${image.key.slice(7, 23)}.${EXTENSIONS[image.mime] ?? 'bin'}`,
        expiresAfterSeconds: this.expiresAfterSeconds,
      },
      signal,
    )
    if (remote.bytes !== image.data.byteLength) {
      throw new DeepSeekFilesError(
        'DeepSeek Files API upload size does not match the image.',
        200,
        '',
      )
    }
    this.uploads += 1
    const record: DeepSeekUploadRecord = {
      scope,
      imageKey: image.key,
      fileId: remote.id,
      bytes: remote.bytes,
      createdAt: remote.createdAt * 1000,
      expiresAt: remote.expiresAt * 1000,
    }
    this.index.put(record, this.now(), this.marginMs)
    return record
  }

  /** 模型口说这个 id 不认了（过期 / 删了 / 不是这个账号的）：只删这一条精确映射。 */
  invalidate(imageKey: string, fileId: string, connection: DeepSeekFileConnection): void {
    this.index.remove(
      deepSeekFileScope(connection.baseURL, connection.credential),
      imageKey,
      fileId,
    )
  }
}

/** 官方 `providerRejectedFileId`：模型口的报错是不是"这个 file id 不认了"。 */
export function providerRejectedFileId(detail: string): boolean {
  const file = /\bfile(?:[_ -]?(?:id|api|not[_ -]?found|deleted|expired))?/iu.test(detail)
  const missing =
    /(?:expired|not[_ -]?found|deleted|do(?:es)? not exist|not created under (?:this|your) account)/iu.test(
      detail,
    )
  const invalidId =
    /(?:invalid.{0,20}file[_ -]?(?:id|api)|file[_ -]?(?:id|api).{0,20}invalid)/iu.test(detail)
  return file && (missing || invalidId)
}

/** 官方 `detailNamesFileId`：报错里是不是**完整地**点了这个 id 的名。 */
export function detailNamesFileId(detail: string, fileId: string): boolean {
  let index = detail.indexOf(fileId)
  while (index >= 0) {
    const before = detail[index - 1]
    const after = detail[index + fileId.length]
    if (
      (before === undefined || !/[\p{L}\p{N}_-]/u.test(before)) &&
      (after === undefined || !/[\p{L}\p{N}_-]/u.test(after))
    ) {
      return true
    }
    index = detail.indexOf(fileId, index + 1)
  }
  return false
}

/** 官方 `staleMappings`：点了名的就只作废点名的；没点名就作废这次用过的全部。 */
export function staleMappings<T extends { imageKey: string; fileId: string }>(
  used: readonly T[],
  detail: string,
): T[] {
  const unique = [...new Map(used.map((u) => [`${u.imageKey}\0${u.fileId}`, u])).values()]
  const exact = unique.filter((u) => detailNamesFileId(detail, u.fileId))
  return exact.length > 0 ? exact : unique
}
