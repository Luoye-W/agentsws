import type { ChannelName, Iso8601, MaybePromise } from '@agentsws/contracts'
import { ChannelError } from './errors.js'

/**
 * 受控原始材料区（18 §2.1 + 31 §4）：原始 MIME 与附件字节只落这里，`raw_ref` 指向它。
 * 三条纪律由宿主实现兑现——加密、保留期、随主体删除；本包只定义端口 + 一个内存实现。
 * **这里的内容永不进模型**：管线只把它的 `ref` 写进 `InboundEvent.raw_ref`。
 */
export interface RawRecord {
  ref: string
  channel: ChannelName
  kind: 'message' | 'attachment'
  stored_at: Iso8601
  /** 文本类（MIME 源）用 string；附件字节用 Uint8Array */
  payload: string | Uint8Array
  mime?: string
  name?: string
  /** 落库前已按 `rawSecretPolicy` 脱敏 */
  secrets_scrubbed?: boolean
}

export interface RawStore {
  put(input: Omit<RawRecord, 'ref'>): MaybePromise<string>
  get(ref: string): MaybePromise<RawRecord | undefined>
  /** 落库后才发现秘密时的就地脱敏（`rawSecretPolicy: 'redact'` 下管线兜底调用）。 */
  scrub?(ref: string, redact: (text: string) => string): MaybePromise<void>
}

/** 内存实现（测试与 fast 档）。生产实现应是加密文件区 / 对象存储 + 保留期。 */
export class MemoryRawStore implements RawStore {
  private readonly records = new Map<string, RawRecord>()
  private seq = 0

  put(input: Omit<RawRecord, 'ref'>): string {
    this.seq += 1
    const ref = `raw://inbound/${input.channel}/${input.kind}/${this.seq}`
    this.records.set(ref, { ...input, ref })
    return ref
  }

  get(ref: string): RawRecord | undefined {
    return this.records.get(ref)
  }

  scrub(ref: string, redact: (text: string) => string): void {
    const rec = this.records.get(ref)
    if (rec === undefined) throw new ChannelError('not_found', `原始材料不存在：${ref}`, { ref })
    if (typeof rec.payload !== 'string') return
    this.records.set(ref, { ...rec, payload: redact(rec.payload), secrets_scrubbed: true })
  }

  /** 观察面：受控区里现有的全部记录（测试用；生产实现不必提供）。 */
  all(): RawRecord[] {
    return [...this.records.values()]
  }

  get size(): number {
    return this.records.size
  }
}
