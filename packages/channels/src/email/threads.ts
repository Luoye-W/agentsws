import type { Iso8601, MaybePromise } from '@agentsws/contracts'

/**
 * 线程台账。存在的理由有两个：
 * ① 回复要拿到 `In-Reply-To` / `References` / 原主题（18 §2.3「回复语义在渠道层」）
 * ② **收件人门禁**（31 §3.3）：outbound 的收件人只能是线程原有参与者，
 *    不接受"模型从内容里解析出的新收件人"——所以 `send` 的收件人从这里取，不从入参取。
 */
export interface ThreadRecord {
  external_id: string
  subject?: string
  /** 线程原有参与者（发件人 + 收件人 + 抄送），小写邮箱 */
  participants: string[]
  /** 线程里最后一封的 Message-ID；回复以它为 In-Reply-To */
  last_message_id?: string
  references: string[]
  updated_at: Iso8601
  /**
   * WP55 / 48 §4 L3 #2：渠道细分（`amazon`）。传输层仍是邮件，但这条线程上的
   * 出站要过 Amazon 的社区规范硬闸、进 24h SLA 表。
   */
  channel?: string
  /**
   * 渠道细分的判定结果。写入是**增量补丁**语义：给了的键覆盖，没给的键保留旧值
   * ——`last_buyer_message_at` 是 SLA 的唯一时钟锚，一封系统通知不该把它推掉；
   * `relay_address` 同理，L2 通知没有 relay 地址，照写 null 会把回信目标抹掉。
   */
  channel_meta?: Record<string, unknown>
}

export interface ThreadStore {
  get(external_id: string): MaybePromise<ThreadRecord | undefined>
  upsert(record: ThreadRecord): MaybePromise<void>
  /**
   * WP55：列出全部线程（24h SLA sweep 要按渠道细分挑）。
   *
   * 可选：不实现 = sweep 扫不到这只邮箱（它只会少扫，不会扫错）。
   */
  list?(): MaybePromise<ThreadRecord[]>
}

export class MemoryThreadStore implements ThreadStore {
  private readonly threads = new Map<string, ThreadRecord>()

  get(external_id: string): ThreadRecord | undefined {
    const rec = this.threads.get(external_id)
    return rec === undefined
      ? undefined
      : {
          ...rec,
          participants: [...rec.participants],
          references: [...rec.references],
          ...(rec.channel_meta === undefined ? {} : { channel_meta: { ...rec.channel_meta } }),
        }
  }

  upsert(record: ThreadRecord): void {
    this.threads.set(record.external_id, {
      ...record,
      participants: [...record.participants],
      references: [...record.references],
      ...(record.channel_meta === undefined ? {} : { channel_meta: { ...record.channel_meta } }),
    })
  }

  list(): ThreadRecord[] {
    return [...this.threads.keys()].map((id) => this.get(id) as ThreadRecord)
  }

  get size(): number {
    return this.threads.size
  }
}

/** 合并一次新消息进线程台账（参与者去重、references 追加）。 */
export function mergeThread(
  prior: ThreadRecord | undefined,
  next: {
    external_id: string
    subject?: string
    participants: readonly string[]
    message_id?: string
    references: readonly string[]
    at: Iso8601
    /** WP55：渠道细分；不给 = 保留旧值（一封普通邮件不该把线程从 amazon 降回 email）。 */
    channel?: string
    /** WP55：`channel_meta` 的增量补丁；只合并给了的键。 */
    channel_meta?: Record<string, unknown>
  },
): ThreadRecord {
  const participants = [...(prior?.participants ?? [])]
  for (const p of next.participants) {
    const addr = p.trim().toLowerCase()
    if (addr.length > 0 && !participants.includes(addr)) participants.push(addr)
  }
  const references = [...(prior?.references ?? [])]
  for (const r of [...next.references, ...(next.message_id === undefined ? [] : [next.message_id])])
    if (!references.includes(r)) references.push(r)
  const subject = next.subject ?? prior?.subject
  const channel = next.channel ?? prior?.channel
  const channel_meta =
    next.channel_meta === undefined
      ? prior?.channel_meta
      : { ...(prior?.channel_meta ?? {}), ...next.channel_meta }
  return {
    external_id: next.external_id,
    participants,
    references,
    updated_at: next.at,
    ...(subject === undefined ? {} : { subject }),
    ...(channel === undefined ? {} : { channel }),
    ...(channel_meta === undefined ? {} : { channel_meta }),
    ...(next.message_id === undefined
      ? prior?.last_message_id === undefined
        ? {}
        : { last_message_id: prior.last_message_id }
      : { last_message_id: next.message_id }),
  }
}
