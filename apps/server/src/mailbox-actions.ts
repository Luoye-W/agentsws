/**
 * WP163：邮箱动作（标已读 / 挪进 `KefuAgents` / 跳过 / 失败）的**事件**与「最近一次失败」。
 *
 * 老产品 KefuAgent 每个动作写一行 `supportMailboxActionLog`；这里对应成一条
 * `inbound.mailbox_action` 事件（原因码 + 文件夹 + uid，**没有正文**，地址遮掉），
 * 再在内存里记住每只邮箱最近一次失败，给「消息」页左栏那一行用。
 */
import type { MailboxActionRecord } from '@agentsws/channels'
import type { EventEnvelope, Iso8601, WorkspaceId } from '@agentsws/contracts'

/** 63 §10：日志里的地址一律遮掩（`ann@customer.example` → `a***@customer.example`）。 */
export function maskAddress(address: string): string {
  const at = address.indexOf('@')
  if (at <= 0) return address === '' ? '' : '***'
  return `${address[0] ?? ''}***${address.slice(at)}`
}

/** 一条邮箱动作 → 一条事件（payload 只有码、文件夹与 uid）。 */
export function mailboxActionEvent(input: {
  workspace_id: WorkspaceId
  /** 谁动的：`channel:email`（渠道那一路）或 `messages`（消息同步）。 */
  actor_id: string
  at: Iso8601
  record: MailboxActionRecord
}): Omit<EventEnvelope, 'id' | 'at'> {
  const r = input.record
  return {
    schema_version: 1,
    workspace_id: input.workspace_id,
    type: 'inbound.mailbox_action',
    actor: { kind: 'system', id: input.actor_id },
    correlation: { trace_id: `tr_mbx_${input.at}_${r.uid}` },
    payload: {
      account: maskAddress(r.account),
      action: r.action,
      status: r.status,
      folder: r.from_folder,
      uid: r.uid,
      ...(r.to_folder === undefined ? {} : { to_folder: r.to_folder }),
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      ...(r.detail === undefined ? {} : { detail: r.detail }),
    },
  }
}

/** 界面上「最近一次没动成」的那一行（与 `MessageAccountView.last_mailbox_failure` 同形）。 */
export interface MailboxActionFailure {
  at: Iso8601
  action: 'mark_read' | 'move'
  reason: string
  folder: string
  to_folder?: string
}

/**
 * 每只邮箱最近一次失败（只在本进程内：重启清零，下一次失败再记上）。
 * 同一种动作后来成功了一次，就把那条失败抹掉——界面上不挂一条已经过去的警告。
 */
export class MailboxActionFailures {
  private readonly latest = new Map<string, MailboxActionFailure>()

  note(record: MailboxActionRecord, at: Iso8601): void {
    if (record.action === 'observe') return
    if (record.status === 'failed') {
      this.latest.set(record.account, {
        at,
        action: record.action,
        reason: record.reason ?? 'error',
        folder: record.from_folder,
        ...(record.to_folder === undefined ? {} : { to_folder: record.to_folder }),
      })
      return
    }
    if (
      record.status === 'completed' &&
      this.latest.get(record.account)?.action === record.action
    ) {
      this.latest.delete(record.account)
    }
  }

  of(account: string): MailboxActionFailure | undefined {
    return this.latest.get(account)
  }
}
