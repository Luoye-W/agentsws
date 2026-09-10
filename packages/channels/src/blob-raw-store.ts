/**
 * 附件走对象存储（WP40 / 41 §2）。
 *
 * 这是**一层包装**，不是第四个 `RawStore` 实现：里外都是同一个接口，
 * 装配时套上去，不装就是原样（附件字节继续落库，行为与 WP31 一致）。
 * 包装只做一件事：
 *
 * - `put` 的正文是**字节**（附件）→ 字节写进 {@link RawBlobPort}，
 *   库里那一行改存一句 `blob://<key>`（18 §2.1「原始材料区只留文本与引用」）
 * - `get` 读到这句就把字节取回来，调用方拿到的还是 `Uint8Array`，一无所知
 * - `erase` / `eraseSubject` / `prune` 删行之前先删对象——不然对象就成了没人认领的垃圾，
 *   而且 21 §4 的「随主体删除」会漏掉最大的那一块
 *
 * 加密在**对象那一层**做（同一把主体密钥、同一次 `shred` 就全读不出来），
 * 所以这里不再对字节做第二次加密。文本材料（邮件原文）照旧由内层库加密。
 */
import type { Clock, MaybePromise } from '@agentsws/contracts'
import type { RawBlobPort } from '@agentsws/core'
import { blobKeyOfMarker, blobMarker, isBlobMarker } from '@agentsws/core'
import type { EraseSubjectResult, RawRecord, RawStore } from './raw-store.js'

/** 内层至少还要能列出全部记录（删对象要按记录找 key）。两档都有 `all()`。 */
export type ListableRawStore = RawStore & {
  all(): MaybePromise<RawRecord[]>
  erase?(...refs: readonly string[]): MaybePromise<number>
}

export interface BlobBackedRawStoreOptions {
  inner: ListableRawStore
  blobs: RawBlobPort
  /** 对象 key 的前缀；默认 `channels`。 */
  prefix?: string
  /**
   * 一个附件一个 key。默认 `crypto.randomUUID()`；
   * 模拟与测试注入确定性实现（35 §2：随机经注入）。
   */
  newId?: () => string
}

export class BlobBackedRawStore implements RawStore {
  readonly #inner: ListableRawStore
  readonly #blobs: RawBlobPort
  readonly #prefix: string
  readonly #newId: () => string

  constructor(options: BlobBackedRawStoreOptions) {
    this.#inner = options.inner
    this.#blobs = options.blobs
    this.#prefix = options.prefix ?? 'channels'
    this.#newId = options.newId ?? (() => crypto.randomUUID())
  }

  /** 内层库（保留期、脱敏、迁移那些只跟库有关的东西还是问它）。 */
  get inner(): ListableRawStore {
    return this.#inner
  }

  async put(input: Omit<RawRecord, 'ref'>): Promise<string> {
    if (typeof input.payload === 'string') return this.#inner.put(input)

    const key = `${this.#prefix}/${input.channel}/${this.#newId()}`
    await this.#blobs.put(key, input.payload, {
      ...(input.mime === undefined ? {} : { content_type: input.mime }),
      ...(input.name === undefined ? {} : { filename: input.name }),
      ...(input.subject_ref === undefined ? {} : { subject_ref: input.subject_ref }),
    })
    return this.#inner.put({ ...input, payload: blobMarker(key) })
  }

  async get(ref: string): Promise<RawRecord | undefined> {
    const record = await this.#inner.get(ref)
    if (record === undefined || !isBlobMarker(record.payload)) return record
    const key = blobKeyOfMarker(record.payload)
    const object = await this.#blobs.get(key)
    // 对象没了 / 主体密钥已销毁 → 与库里被擦除同一个形状：行还在，内容读不出来
    if (object?.bytes === undefined) {
      return { ...record, payload: new Uint8Array(0), erased: true }
    }
    return { ...record, payload: object.bytes }
  }

  /** 只对文本材料有意义（附件本来就不脱敏）；原样转给内层。 */
  async scrub(ref: string, redact: (text: string) => string): Promise<void> {
    const record = await this.#inner.get(ref)
    if (record !== undefined && isBlobMarker(record.payload)) return
    await this.#inner.scrub?.(ref, redact)
  }

  /** 内层有 `erase(...refs)` 才转发（SQLite 档有，内存档没有）。 */
  async erase(...refs: readonly string[]): Promise<number> {
    await this.#dropObjects(refs)
    return (await this.#inner.erase?.(...refs)) ?? 0
  }

  async eraseSubject(subject: string): Promise<EraseSubjectResult> {
    // 先把这个主体的对象删掉，再让内层销毁密钥 + 删行
    const all = await this.#inner.all()
    await this.#dropObjectsOf(all.filter((r) => r.subject_ref === subject))
    return this.#inner.eraseSubject(subject)
  }

  async prune(retentionMs: number, clock?: Clock): Promise<number> {
    const now = clock?.now()
    if (now !== undefined) {
      const cutoff = Date.parse(now) - retentionMs
      const all = await this.#inner.all()
      await this.#dropObjectsOf(all.filter((r) => Date.parse(r.stored_at) <= cutoff))
    }
    return this.#inner.prune(retentionMs, clock)
  }

  async all(): Promise<RawRecord[]> {
    return this.#inner.all()
  }

  async #dropObjects(refs: readonly string[]): Promise<void> {
    const records: RawRecord[] = []
    for (const ref of refs) {
      const record = await this.#inner.get(ref)
      if (record !== undefined) records.push(record)
    }
    await this.#dropObjectsOf(records)
  }

  async #dropObjectsOf(records: readonly RawRecord[]): Promise<void> {
    for (const record of records) {
      if (!isBlobMarker(record.payload)) continue
      await this.#blobs.delete(blobKeyOfMarker(record.payload))
    }
  }
}

export function withBlobAttachments(options: BlobBackedRawStoreOptions): BlobBackedRawStore {
  return new BlobBackedRawStore(options)
}
