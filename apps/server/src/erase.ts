/**
 * 「删这个人」的**统一编排**（21 §4、18 §2.1 第三条纪律；39 待办 I）。
 *
 * 三个库各自都有 `eraseSubject`（数据层、邮件原始区、会议原始区），但一直是**三次独立
 * 调用**——没有一个入口能把一个人从这台机器上一次清掉。于是「删除」这件事的正确性
 * 取决于调用方记不记得三处都调，而 GDPR 上的删除请求不接受「忘了一处」。
 *
 * 编排的三条纪律：
 *
 * 1. **先销毁密钥，再删行**。密钥一销毁，连**备份里的密文**都读不出来了
 *    （crypto-shredding，21 §4）；反过来先删行再销毁，中间崩一次就留下了能解密的备份。
 *    这一条由各库自己的 `eraseSubject` 兑现，编排只保证顺序不被绕过。
 * 2. **任一步失败整体记 `partial`，并且可重跑**。每一步都是幂等的（销毁密钥幂等、
 *    删行幂等），所以重跑一次就是补做没做成的那几步——不需要事务，也不该需要：
 *    三个库不共享表（35 §2），本来就没有跨库事务可用。
 * 3. **一份墓碑**。数据层的 `erase` 返回 `privacy.erased` 事件，由这里写进事件日志
 *    （21 §4：删了什么、什么时候、谁删的要留得下来，正文不留）。
 */
import type { Actor as DataActor, EventEnvelope, Iso8601, WorkspaceId } from '@agentsws/contracts'
import type { SqliteDataStore } from '@agentsws/data'
import { eraseParticipant, meetingSubjectRef } from '@agentsws/meetings'
import type { ChannelsAssembly } from './channels.js'
import type { MeetingsAssembly } from './meetings.js'

/** 一个库的那一步。 */
export interface EraseStep {
  store: 'data' | 'channels' | 'meetings'
  status: 'done' | 'skipped' | 'failed'
  /** 删掉的行数（各库自己的口径）。 */
  rows?: number
  /** 主体密钥销毁的时刻；没有密钥环时没有这一项。 */
  shredded_at?: Iso8601
  /** 失败原因（人话；不含任何被删内容）。 */
  error?: string
}

export interface EraseResult {
  subject: string
  /** 三步全成 = `done`；任一步失败 = `partial`（可重跑）。 */
  status: 'done' | 'partial'
  at: Iso8601
  steps: EraseStep[]
}

export interface EraseInput {
  /**
   * 主体的自然键。邮件原始区按它加密与删行（= 发件人地址），
   * 会议侧按它匹配与会者的 email。
   */
  subject: string
  /** 数据层那一条记录（可选）：给了才动数据层，不给这一步记 `skipped`。 */
  record?: { collection: string; id: string }
  /** 要连整场录音一起销毁的会议（可选）；不给只删这个人的转写行与产出。 */
  meetings?: readonly string[]
}

export interface PrivacyEraseOptions {
  workspace_id: WorkspaceId
  clock: { now(): Iso8601 }
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  data: SqliteDataStore
  channels?: ChannelsAssembly
  meetings?: MeetingsAssembly
}

export interface PrivacyErase {
  /**
   * `actor` 是**完整的数据层 actor**（带 grants 与 ranges），不是一个 person_id：
   * 数据层的删除同样要过 21 §3 的授权（21 §4 没给「删除」开后门）。
   * 网关那一层从 `roles.effectiveConfig(assignment_id)` 组出来。
   */
  erase(input: EraseInput, actor: DataActor): Promise<EraseResult>
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createPrivacyErase(options: PrivacyEraseOptions): PrivacyErase {
  const { workspace_id, clock } = options

  return {
    async erase(input, actor): Promise<EraseResult> {
      const at = clock.now()
      const steps: EraseStep[] = []

      // ① 数据层：销毁主体密钥 + 写墓碑（记录与事件都留着，只是读不出 PII 了）
      if (input.record === undefined) {
        steps.push({ store: 'data', status: 'skipped' })
      } else {
        try {
          const event = await options.data.erase(input.record, actor)
          // 21 §4：墓碑进事件日志（数据层不依赖 kernel，所以由这里写）
          options.appendEvent(event as unknown as Omit<EventEnvelope, 'id' | 'at'>)
          steps.push({ store: 'data', status: 'done', rows: 1, shredded_at: event.at })
        } catch (e) {
          steps.push({ store: 'data', status: 'failed', error: messageOf(e) })
        }
      }

      // ② 邮件原始区：主体 = 发件人地址（先销毁这把密钥，备份里的密文当场作废）
      if (options.channels === undefined) {
        steps.push({ store: 'channels', status: 'skipped' })
      } else {
        try {
          const out = await options.channels.eraseSubject(input.subject)
          steps.push({
            store: 'channels',
            status: 'done',
            rows: out.rows,
            ...(out.shredded_at === undefined ? {} : { shredded_at: out.shredded_at }),
          })
        } catch (e) {
          steps.push({ store: 'channels', status: 'failed', error: messageOf(e) })
        }
      }

      // ③ 会议：删这个人的转写行与产出；点名的整场会连录音密钥一起销毁
      //    （一段录音里有好几个人，不能因为一个人要删就把别人的也读不出来——
      //     所以「删一个人」与「删整场会」是两个粒度，见 meetings/erase.ts）
      if (options.meetings === undefined) {
        steps.push({ store: 'meetings', status: 'skipped' })
      } else {
        try {
          const meetings = options.meetings
          const person = await eraseParticipant(meetings.store, meetings.raw, {
            workspace_id,
            email: input.subject,
          })
          let rows = person.raw_refs.length
          let shredded_at: Iso8601 | undefined
          for (const id of input.meetings ?? []) {
            const whole = await meetings.raw.eraseSubject(meetingSubjectRef(id))
            rows += whole.rows
            shredded_at = whole.shredded_at ?? shredded_at
          }
          steps.push({
            store: 'meetings',
            status: 'done',
            rows,
            ...(shredded_at === undefined ? {} : { shredded_at }),
          })
        } catch (e) {
          steps.push({ store: 'meetings', status: 'failed', error: messageOf(e) })
        }
      }

      const status = steps.some((s) => s.status === 'failed') ? 'partial' : 'done'
      // 21 §4：删除本身要留痕。payload 里只有「删了哪个主体、几行、成没成」，没有内容。
      options.appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'privacy.erased',
        at,
        actor: { kind: 'person', id: actor.person_id },
        subject: { type: 'subject', id: input.subject },
        correlation: { trace_id: `tr_erase_${at}` },
        payload: {
          subject: input.subject,
          status,
          steps: steps.map((s) => ({
            store: s.store,
            status: s.status,
            ...(s.rows === undefined ? {} : { rows: s.rows }),
          })),
        },
      })
      return { subject: input.subject, status, at, steps }
    },
  }
}
