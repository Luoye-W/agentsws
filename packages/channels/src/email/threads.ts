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
}

export interface ThreadStore {
  get(external_id: string): MaybePromise<ThreadRecord | undefined>
  upsert(record: ThreadRecord): MaybePromise<void>
}

export class MemoryThreadStore implements ThreadStore {
  private readonly threads = new Map<string, ThreadRecord>()

  get(external_id: string): ThreadRecord | undefined {
    const rec = this.threads.get(external_id)
    return rec === undefined
      ? undefined
      : { ...rec, participants: [...rec.participants], references: [...rec.references] }
  }

  upsert(record: ThreadRecord): void {
    this.threads.set(record.external_id, {
      ...record,
      participants: [...record.participants],
      references: [...record.references],
    })
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
  return {
    external_id: next.external_id,
    participants,
    references,
    updated_at: next.at,
    ...(subject === undefined ? {} : { subject }),
    ...(next.message_id === undefined
      ? prior?.last_message_id === undefined
        ? {}
        : { last_message_id: prior.last_message_id }
      : { last_message_id: next.message_id }),
  }
}
