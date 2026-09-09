/**
 * 受控原始材料区（18 §2.1 + 21 §4）的会议档。
 *
 * 端口在 `@agentsws/core`（`RawStorePort`，WP24 上移，与 `@agentsws/channels` 共用同一份纪律：
 * 加密、保留期、随主体删除），但**不共享它的表**（35 §2）——录音与会议文档落本包自己的库。
 *
 * 加密同样不在本包实现：密钥环是 `@agentsws/data` 的（每主体一把独立随机密钥），
 * 本包只收一个 {@link RawCipher} 端口（WP18 / WP23 点名的跨包接线遗留）。
 *
 * **主体是谁**：一段录音里有好几个人，没法给每个与会者各加一把密钥
 * （那要按人重新加密同一段音频）。所以会议档的 `subject_ref` 是**会议 id**：
 * 删一个与会者 = 删他的转写行与产出（`eraseParticipant`），
 * 删整场会议 = 销毁这场会的密钥（{@link MeetingRawStore.eraseSubject}）+ 删行。
 *
 * **这里的内容永不进模型**：管线只把 `ref` 写进 `MeetingRecordMedia.raw_ref`；
 * 进模型的是转写文本，且必须先经围栏。
 */
import type { Iso8601, MaybePromise } from '@agentsws/contracts'
import type { RawCipher, RawRecordBase, RawStorePort } from '@agentsws/core'
import { MeetingError } from './errors.js'

export type MeetingRawKind = 'audio' | 'video' | 'transcript' | 'document'

export interface MeetingRawRecord extends RawRecordBase {
  workspace_id: string
  kind: MeetingRawKind
}

/** {@link MeetingRawStore.eraseSubject} 的结果。 */
export interface MeetingEraseSubjectResult {
  /** 主体密钥的销毁时间；没有 cipher 时 undefined（只删了行）。 */
  shredded_at?: string
  rows: number
}

/** 端口在 `@agentsws/core`（WP24 上移）；会议档另加保留期与随主体删除三件事。 */
export interface MeetingRawStore extends RawStorePort<MeetingRawRecord> {
  /** 随主体删除（21 §4）：按 ref 硬删，返回删掉的条数。 */
  erase(...refs: readonly string[]): MaybePromise<number>
  /** 随主体删除（21 §4）：销毁主体密钥 + 删掉该主体的行。 */
  eraseSubject(subject: string): MaybePromise<MeetingEraseSubjectResult>
  /** 保留期（18 §2.1）：丢掉 `retentionMs` 之前落进来的材料，返回删掉的条数。 */
  prune(retentionMs: number, now: Iso8601): MaybePromise<number>
}

export interface MemoryMeetingRawStoreOptions {
  /** 给了就按主体加密（`@agentsws/data` 的 `SubjectKeyring`）。 */
  cipher?: RawCipher
}

/**
 * 内存实现（测试与 fast 档）。给了 cipher 一样会真加密——
 * 一致性套件对两档跑同一份用例，「销毁密钥后读不出」在两档都必须成立。
 */
export class MemoryMeetingRawStore implements MeetingRawStore {
  private readonly records = new Map<string, MeetingRawRecord>()
  private readonly sealed = new Map<string, { subject: string; bytes: Uint8Array }>()
  private readonly cipher: RawCipher | undefined
  private seq = 0

  constructor(options: MemoryMeetingRawStoreOptions = {}) {
    this.cipher = options.cipher
  }

  put(input: Omit<MeetingRawRecord, 'ref'>): string {
    this.seq += 1
    const ref = `raw://meetings/${input.workspace_id}/${input.kind}/${this.seq}`
    const subject = input.subject_ref
    if (this.cipher !== undefined && subject !== undefined && subject !== '') {
      this.sealed.set(ref, {
        subject,
        bytes: this.cipher.seal(subject, bytesOfPayload(input.payload)),
      })
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

  get(ref: string): MeetingRawRecord | undefined {
    const rec = this.records.get(ref)
    if (rec === undefined) return undefined
    const sealed = this.sealed.get(ref)
    if (sealed === undefined || this.cipher === undefined) return rec
    const plain = this.cipher.open(sealed.subject, sealed.bytes)
    if (plain === undefined) return { ...rec, erased: true }
    return { ...rec, payload: typeof rec.payload === 'string' ? decode(plain) : plain }
  }

  erase(...refs: readonly string[]): number {
    let n = 0
    for (const ref of refs) {
      this.sealed.delete(ref)
      if (this.records.delete(ref)) n += 1
    }
    return n
  }

  eraseSubject(subject: string): MeetingEraseSubjectResult {
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

  prune(retentionMs: number, now: Iso8601): number {
    const cutoff = Date.parse(now) - retentionMs
    let n = 0
    for (const [ref, rec] of this.records) {
      if (Date.parse(rec.stored_at) <= cutoff) {
        this.records.delete(ref)
        this.sealed.delete(ref)
        n += 1
      }
    }
    return n
  }

  scrub(ref: string, redact: (text: string) => string): void {
    const rec = this.get(ref)
    if (rec === undefined) throw new MeetingError('not_found', `原始材料不存在：${ref}`, { ref })
    if (typeof rec.payload !== 'string') return
    const stored = this.records.get(ref) as MeetingRawRecord
    const text = redact(rec.payload)
    const sealed = this.sealed.get(ref)
    if (sealed !== undefined && this.cipher !== undefined) {
      this.sealed.set(ref, {
        ...sealed,
        bytes: this.cipher.seal(sealed.subject, bytesOfPayload(text)),
      })
      this.records.set(ref, { ...stored, secrets_scrubbed: true })
      return
    }
    this.records.set(ref, { ...stored, payload: text, secrets_scrubbed: true })
  }

  /** 观察面：受控区里现有的全部记录（测试用；生产实现不必提供）。 */
  all(): MeetingRawRecord[] {
    return [...this.records.keys()].map((ref) => this.get(ref) as MeetingRawRecord)
  }

  get size(): number {
    return this.records.size
  }
}

const EMPTY = new Uint8Array(0)
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** 取字节；文本类按 UTF-8 编码。 */
export function bytesOfPayload(payload: string | Uint8Array): Uint8Array {
  return typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
}

/** 取字节；文本类按 UTF-8 编码。转写要的是字节（ASR provider 只吃字节）。 */
export function bytesOf(record: MeetingRawRecord): Uint8Array {
  return bytesOfPayload(record.payload)
}
