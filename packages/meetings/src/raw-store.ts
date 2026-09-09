/**
 * 受控原始材料区（18 §2.1 + 21 §4）的会议档。
 *
 * 端口在 `@agentsws/core`（`RawStorePort`，WP24 上移，与 `@agentsws/channels` 共用同一份纪律：
 * 加密、保留期、随主体删除），但**不共享它的表**（35 §2）——录音与会议文档落本包自己的库。
 *
 * **这里的内容永不进模型**：管线只把 `ref` 写进 `MeetingRecordMedia.raw_ref`；
 * 进模型的是转写文本，且必须先经围栏。
 */
import type { Iso8601, MaybePromise } from '@agentsws/contracts'
import type { RawRecordBase, RawStorePort } from '@agentsws/core'
import { MeetingError } from './errors.js'

export type MeetingRawKind = 'audio' | 'video' | 'transcript' | 'document'

export interface MeetingRawRecord extends RawRecordBase {
  workspace_id: string
  kind: MeetingRawKind
}

/** 端口在 `@agentsws/core`（WP24 上移）；会议档另加保留期与随主体删除两件事。 */
export interface MeetingRawStore extends RawStorePort<MeetingRawRecord> {
  /** 随主体删除（21 §4）：按 ref 硬删，返回删掉的条数。 */
  erase(...refs: readonly string[]): MaybePromise<number>
  /** 保留期（18 §2.1）：丢掉 `retentionMs` 之前落进来的材料，返回删掉的条数。 */
  prune(retentionMs: number, now: Iso8601): MaybePromise<number>
}

/** 内存实现（测试与 fast 档）。生产实现是加密文件区 / 对象存储 + 保留期。 */
export class MemoryMeetingRawStore implements MeetingRawStore {
  private readonly records = new Map<string, MeetingRawRecord>()
  private seq = 0

  put(input: Omit<MeetingRawRecord, 'ref'>): string {
    this.seq += 1
    const ref = `raw://meetings/${input.workspace_id}/${input.kind}/${this.seq}`
    this.records.set(ref, { ...input, ref })
    return ref
  }

  get(ref: string): MeetingRawRecord | undefined {
    return this.records.get(ref)
  }

  erase(...refs: readonly string[]): number {
    let n = 0
    for (const ref of refs) if (this.records.delete(ref)) n += 1
    return n
  }

  prune(retentionMs: number, now: Iso8601): number {
    const cutoff = Date.parse(now) - retentionMs
    let n = 0
    for (const [ref, rec] of this.records) {
      if (Date.parse(rec.stored_at) <= cutoff) {
        this.records.delete(ref)
        n += 1
      }
    }
    return n
  }

  scrub(ref: string, redact: (text: string) => string): void {
    const rec = this.records.get(ref)
    if (rec === undefined) throw new MeetingError('not_found', `原始材料不存在：${ref}`, { ref })
    if (typeof rec.payload !== 'string') return
    this.records.set(ref, { ...rec, payload: redact(rec.payload), secrets_scrubbed: true })
  }

  /** 观察面：受控区里现有的全部记录（测试用；生产实现不必提供）。 */
  all(): MeetingRawRecord[] {
    return [...this.records.values()]
  }

  get size(): number {
    return this.records.size
  }
}

/** 取字节；文本类按 UTF-8 编码。转写要的是字节（ASR provider 只吃字节）。 */
export function bytesOf(record: MeetingRawRecord): Uint8Array {
  return typeof record.payload === 'string'
    ? new TextEncoder().encode(record.payload)
    : record.payload
}
