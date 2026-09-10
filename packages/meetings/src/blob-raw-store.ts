/**
 * 会议音视频走对象存储（WP40 / 41 §2）。
 *
 * 与 `@agentsws/channels` 的那一层是同一个做法（同一份纪律，两个域各一层包装）：
 * **正文是字节就落对象存储，库里只留一句 `blob://<key>`**（18 §2.1）。
 * 会议这边尤其要紧——一小时录音几十上百 MB，落 SQLite 就是把库撑爆，
 * 落 NAS 共享目录或 MinIO 才是这一档该有的样子。
 *
 * 转写（`transcript`）与文档（`document`）是**文本**，照旧留在库里：
 * 它们要检索、要脱敏、要按主体加密，搬去对象存储只会更难管。
 *
 * 加密在对象那一层做（同一把会议主体密钥、同一次 `shred`），这里不再加密第二遍。
 */
import type { Iso8601, MaybePromise } from '@agentsws/contracts'
import type { RawBlobPort } from '@agentsws/core'
import { blobKeyOfMarker, blobMarker, isBlobMarker } from '@agentsws/core'
import type { MeetingEraseSubjectResult, MeetingRawRecord, MeetingRawStore } from './raw-store.js'

/** 内层还要能列出全部记录（删对象要按记录找 key）。两档都有 `all()`。 */
export type ListableMeetingRawStore = MeetingRawStore & {
  all(): MaybePromise<MeetingRawRecord[]>
}

export interface BlobBackedMeetingRawStoreOptions {
  inner: ListableMeetingRawStore
  blobs: RawBlobPort
  /** 对象 key 的前缀；默认 `meetings`。 */
  prefix?: string
  /** 一个媒体一个 key；默认 `crypto.randomUUID()`，测试注入确定性实现。 */
  newId?: () => string
}

export class BlobBackedMeetingRawStore implements MeetingRawStore {
  readonly #inner: ListableMeetingRawStore
  readonly #blobs: RawBlobPort
  readonly #prefix: string
  readonly #newId: () => string

  constructor(options: BlobBackedMeetingRawStoreOptions) {
    this.#inner = options.inner
    this.#blobs = options.blobs
    this.#prefix = options.prefix ?? 'meetings'
    this.#newId = options.newId ?? (() => crypto.randomUUID())
  }

  get inner(): ListableMeetingRawStore {
    return this.#inner
  }

  async put(input: Omit<MeetingRawRecord, 'ref'>): Promise<string> {
    if (typeof input.payload === 'string') return this.#inner.put(input)

    const key = `${this.#prefix}/${input.workspace_id}/${input.kind}/${this.#newId()}`
    await this.#blobs.put(key, input.payload, {
      workspace_id: input.workspace_id,
      ...(input.mime === undefined ? {} : { content_type: input.mime }),
      ...(input.name === undefined ? {} : { filename: input.name }),
      ...(input.subject_ref === undefined ? {} : { subject_ref: input.subject_ref }),
    })
    return this.#inner.put({ ...input, payload: blobMarker(key) })
  }

  async get(ref: string): Promise<MeetingRawRecord | undefined> {
    const record = await this.#inner.get(ref)
    if (record === undefined || !isBlobMarker(record.payload)) return record
    const object = await this.#blobs.get(blobKeyOfMarker(record.payload))
    // 对象没了 / 会议密钥已销毁 → 行还在、内容读不出来（与库内擦除同一个形状）
    if (object?.bytes === undefined) {
      return { ...record, payload: new Uint8Array(0), erased: true }
    }
    return { ...record, payload: object.bytes }
  }

  /** 媒体不脱敏；文本的转给内层。 */
  async scrub(ref: string, redact: (text: string) => string): Promise<void> {
    const record = await this.#inner.get(ref)
    if (record !== undefined && isBlobMarker(record.payload)) return
    await this.#inner.scrub?.(ref, redact)
  }

  async erase(...refs: readonly string[]): Promise<number> {
    for (const ref of refs) {
      const record = await this.#inner.get(ref)
      if (record !== undefined) await this.#drop([record])
    }
    return this.#inner.erase(...refs)
  }

  async eraseSubject(subject: string): Promise<MeetingEraseSubjectResult> {
    const all = await this.#inner.all()
    await this.#drop(all.filter((r) => r.subject_ref === subject))
    return this.#inner.eraseSubject(subject)
  }

  async prune(retentionMs: number, now: Iso8601): Promise<number> {
    const cutoff = Date.parse(now) - retentionMs
    const all = await this.#inner.all()
    await this.#drop(all.filter((r) => Date.parse(r.stored_at) <= cutoff))
    return this.#inner.prune(retentionMs, now)
  }

  async all(): Promise<MeetingRawRecord[]> {
    return this.#inner.all()
  }

  async #drop(records: readonly MeetingRawRecord[]): Promise<void> {
    for (const record of records) {
      if (!isBlobMarker(record.payload)) continue
      await this.#blobs.delete(blobKeyOfMarker(record.payload))
    }
  }
}

export function withBlobMedia(
  options: BlobBackedMeetingRawStoreOptions,
): BlobBackedMeetingRawStore {
  return new BlobBackedMeetingRawStore(options)
}
