import type { ChannelName, Clock, MaybePromise } from '@agentsws/contracts'
import type { RawCipher, RawRecordBase, RawStorePort } from '@agentsws/core'
import { ChannelError } from './errors.js'

/**
 * 受控原始材料区（18 §2.1 + 31 §4）：原始 MIME 与附件字节只落这里，`raw_ref` 指向它。
 * 三条纪律：**加密、保留期、随主体删除**。
 * **这里的内容永不进模型**：管线只把它的 `ref` 写进 `InboundEvent.raw_ref`。
 *
 * 加密不在本包实现——密钥环是 `@agentsws/data` 的（21 §4，每主体一把独立随机密钥），
 * 本包只收一个 {@link RawCipher} 端口（WP18 点名的「靠 data 主体密钥环跨包接线」遗留）。
 * 表仍然不共享（35 §2）：邮件原文落 channels 自己的库，密钥落 data 的库。
 */
export interface RawRecord extends RawRecordBase {
  channel: ChannelName
  kind: 'message' | 'attachment'
}

/** {@link RawStore.eraseSubject} 的结果。 */
export interface EraseSubjectResult {
  /** 主体密钥的销毁时间；没有 cipher 时 undefined（只删了行）。 */
  shredded_at?: string
  /** 删掉的行数。 */
  rows: number
}

/**
 * 端口在 `@agentsws/core`（WP24 上移）；这里只钉住渠道档的记录形状，
 * 外加 21 §4 的「随主体删除」——它是本包的域知识（按 subject_ref 找行）。
 */
export interface RawStore extends RawStorePort<RawRecord> {
  /**
   * 21 §4 随主体删除：**先销毁主体密钥**（这一刻起备份里的密文也读不出来了），
   * 再删掉这个主体在本库里的行。两件事都做，才叫删干净。
   */
  eraseSubject(subject: string): MaybePromise<EraseSubjectResult>
  /**
   * 18 §2.1 保留期：丢掉 `retentionMs` 之前落进来的材料，返回删掉的条数。
   *
   * WP34 把它提上接口：以前只有 SQLite 档有这个方法，装配方拿到的是
   * `RawStore` 类型就调不着——于是「谁来定时调 prune」这条待办连挂都没处挂
   * （39 待办 H）。两档都要有，保留期才是一条纪律而不是一个实现细节。
   */
  prune(retentionMs: number, clock?: Clock): MaybePromise<number>
}

export interface MemoryRawStoreOptions {
  /** 给了就按主体加密（`@agentsws/data` 的 `SubjectKeyring`）。 */
  cipher?: RawCipher
  /** `prune` 用；构造时不给就每次调用时给。 */
  clock?: Clock
}

/**
 * 内存实现（测试与 fast 档）。给了 cipher 一样会真加密——
 * 一致性套件对两档跑同一份用例，「销毁密钥后读不出」在两档都必须成立。
 */
export class MemoryRawStore implements RawStore {
  private readonly records = new Map<string, RawRecord>()
  /** 已封装的载荷（明文不留在 Map 里）。 */
  private readonly sealed = new Map<string, { subject: string; bytes: Uint8Array }>()
  private readonly cipher: RawCipher | undefined
  private readonly clock: Clock | undefined
  private seq = 0

  constructor(options: MemoryRawStoreOptions = {}) {
    this.cipher = options.cipher
    this.clock = options.clock
  }

  put(input: Omit<RawRecord, 'ref'>): string {
    this.seq += 1
    const ref = `raw://inbound/${input.channel}/${input.kind}/${this.seq}`
    const subject = input.subject_ref
    if (this.cipher !== undefined && subject !== undefined && subject !== '') {
      this.sealed.set(ref, { subject, bytes: this.cipher.seal(subject, bytesOf(input.payload)) })
      this.records.set(ref, {
        ...input,
        ref,
        payload: typeof input.payload === 'string' ? '' : EMPTY,
      })
      return ref
    }
    this.records.set(ref, { ...input, ref })
    return ref
  }

  get(ref: string): RawRecord | undefined {
    const rec = this.records.get(ref)
    if (rec === undefined) return undefined
    const sealed = this.sealed.get(ref)
    if (sealed === undefined || this.cipher === undefined) return rec
    const plain = this.cipher.open(sealed.subject, sealed.bytes)
    if (plain === undefined) return { ...rec, erased: true }
    return { ...rec, payload: typeof rec.payload === 'string' ? decode(plain) : plain }
  }

  scrub(ref: string, redact: (text: string) => string): void {
    const rec = this.get(ref)
    if (rec === undefined) throw new ChannelError('not_found', `原始材料不存在：${ref}`, { ref })
    if (typeof rec.payload !== 'string') return
    const stored = this.records.get(ref) as RawRecord
    const text = redact(rec.payload)
    const sealed = this.sealed.get(ref)
    if (sealed !== undefined && this.cipher !== undefined) {
      this.sealed.set(ref, { ...sealed, bytes: this.cipher.seal(sealed.subject, encode(text)) })
      this.records.set(ref, { ...stored, secrets_scrubbed: true })
      return
    }
    this.records.set(ref, { ...stored, payload: text, secrets_scrubbed: true })
  }

  /** 18 §2.1 保留期：与 SQLite 档同语义（按落库时间，一致性套件两档同跑）。 */
  prune(retentionMs: number, clock?: Clock): number {
    const c = clock ?? this.clock
    if (c === undefined)
      throw new ChannelError('invalid_input', 'prune 需要一个 Clock（构造时给或调用时给）')
    const cutoff = Date.parse(c.now()) - retentionMs
    let n = 0
    for (const [ref, rec] of [...this.records]) {
      if (Date.parse(rec.stored_at) > cutoff) continue
      this.records.delete(ref)
      this.sealed.delete(ref)
      n += 1
    }
    return n
  }

  eraseSubject(subject: string): EraseSubjectResult {
    const shredded_at = this.cipher?.shred(subject)
    let rows = 0
    for (const [ref, rec] of [...this.records]) {
      if (rec.subject_ref !== subject) continue
      this.records.delete(ref)
      this.sealed.delete(ref)
      rows += 1
    }
    return { ...(shredded_at === undefined ? {} : { shredded_at }), rows }
  }

  /** 观察面：受控区里现有的全部记录（测试用；生产实现不必提供）。 */
  all(): RawRecord[] {
    return [...this.records.keys()].map((ref) => this.get(ref) as RawRecord)
  }

  get size(): number {
    return this.records.size
  }
}

const EMPTY = new Uint8Array(0)
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** 文本按 UTF-8，字节原样——封装前统一成字节。 */
export function bytesOf(payload: string | Uint8Array): Uint8Array {
  return typeof payload === 'string' ? encode(payload) : payload
}
