import type {
  Clock,
  DecisionAction,
  DeliveryChannel,
  DeliveryProvider,
  Iso8601,
  MaybePromise,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import { redactOutboundText, sanitizeLabel } from '@agentsws/core'
import { domainOf, type Mailer, messageIdFor } from '../email/smtp.js'
import { ChannelError } from '../errors.js'
import type { ChannelEventSink } from '../pipeline.js'

/** `DeliveryProvider.deliver` 的入参（契约里是内联类型，这里给它一个名字）。 */
export interface DeliveredItem {
  id: string
  title: string
  summary: string
  view: 'full' | 'redacted'
  decision_token: string
  actions: string[]
}

export interface DeliveryRecord {
  external_id: string
  to: PersonId
  to_address: string
  item_id: string
  view: 'full' | 'redacted'
  sent_at: Iso8601
  state: string
  refreshed_at?: Iso8601
}

/** 14 §7 的三个按钮：通过 / 编辑（跳工作台）/ 驳回。 */
export const CARD_ACTIONS: readonly DecisionAction[] = ['approve', 'approve_edited', 'reject']

const ACTION_LABEL: Readonly<Record<string, string>> = {
  approve: '通过',
  approve_edited: '编辑后通过（跳工作台）',
  reject: '驳回',
  redirect: '转交',
  defer: '稍后',
  withdraw: '撤回',
}

const DECISION_ACTIONS: ReadonlySet<string> = new Set<DecisionAction>([
  'approve',
  'approve_edited',
  'reject',
  'redirect',
  'defer',
  'withdraw',
])

export interface EmailDeliveryOptions {
  clock: Clock
  mailer: Mailer
  workspace_id: WorkspaceId
  from: string
  from_name?: string
  /** 回调入口；三个按钮都是它 + item_id / decision_token / action 三个参数 */
  callback_url: string
  /**
   * person_id → 邮箱。**收件人只从这里来**（31 §3.3）：
   * 不接受来自审批项内容、更不接受模型解析出来的地址。
   */
  resolveRecipient: (to: PersonId) => MaybePromise<string | undefined>
  events?: ChannelEventSink
  render_html?: (input: { title: string; summary: string; links: DecisionLink[] }) => string
}

export interface DecisionLink {
  action: DecisionAction
  label: string
  url: string
}

/** 一个带 `decision_token` 的回调链接；不带任何业务参数（14 §7 防篡改）。 */
export function callbackLink(
  base: string,
  input: { item_id: string; decision_token: string; action: DecisionAction },
): string {
  const url = new URL(base)
  url.searchParams.set('item_id', input.item_id)
  url.searchParams.set('decision_token', input.decision_token)
  url.searchParams.set('action', input.action)
  return url.toString()
}

export function decisionLinks(
  base: string,
  item: DeliveredItem,
  actions: readonly string[] = CARD_ACTIONS,
): DecisionLink[] {
  const wanted = actions.filter((a): a is DecisionAction => DECISION_ACTIONS.has(a))
  return wanted.map((action) => ({
    action,
    label: ACTION_LABEL[action] ?? action,
    url: callbackLink(base, {
      item_id: item.id,
      decision_token: item.decision_token,
      action,
    }),
  }))
}

/** 渲染一封审批邮件（纯函数）：脱敏视图 + 三个链接。 */
export function renderApprovalEmail(
  item: DeliveredItem,
  links: readonly DecisionLink[],
): { subject: string; text: string } {
  // 31 §3.3：卡片这一路（标题 / 摘要 / payload）走出站脱敏的统一入口
  const title = redactOutboundText('card_payload', sanitizeLabel(item.title, 120))
  const summary = redactOutboundText('card_payload', item.summary)
  const lines = [
    title,
    '',
    summary,
    '',
    ...links.map((l) => `${l.label}：${l.url}`),
    '',
    item.view === 'redacted' ? '（本邮件为脱敏视图，完整内容请到工作台查看）' : '',
    '链接一次有效；同一条审批被他人处理后，本邮件的链接会失效。',
  ]
  return {
    subject: `[审批] ${title}`,
    text: lines
      .filter((l) => l !== undefined)
      .join('\n')
      .trim(),
  }
}

/**
 * 邮件投递（`DeliveryProvider`，channel='email'，18 §3 + 14 §7）。
 * 卡片 = 脱敏视图 + 三个带 `decision_token` 的链接；回调只解析 item_id / token / action。
 */
export class EmailDeliveryProvider implements DeliveryProvider {
  readonly channel: DeliveryChannel = 'email'

  private readonly clock: Clock
  private readonly mailer: Mailer
  private readonly workspace: WorkspaceId
  private readonly from: string
  private readonly fromName: string | undefined
  private readonly callbackUrl: string
  private readonly resolveRecipient: (to: PersonId) => MaybePromise<string | undefined>
  private readonly events: ChannelEventSink | undefined
  private readonly renderHtml:
    | ((input: { title: string; summary: string; links: DecisionLink[] }) => string)
    | undefined
  private readonly records = new Map<string, DeliveryRecord>()

  constructor(opts: EmailDeliveryOptions) {
    this.clock = opts.clock
    this.mailer = opts.mailer
    this.workspace = opts.workspace_id
    this.from = opts.from
    this.fromName = opts.from_name
    this.callbackUrl = opts.callback_url
    this.resolveRecipient = opts.resolveRecipient
    this.events = opts.events
    this.renderHtml = opts.render_html
  }

  async deliver(item: DeliveredItem, to: PersonId): Promise<{ external_id?: string }> {
    const address = await this.resolveRecipient(to)
    if (address === undefined || address.length === 0) {
      throw new ChannelError('not_found', `收件人没有可投递的邮箱：${to}`, { person_id: to })
    }
    const links = decisionLinks(
      this.callbackUrl,
      item,
      item.actions.length > 0 ? item.actions : CARD_ACTIONS,
    )
    const { subject, text } = renderApprovalEmail(item, links)
    const external_id = messageIdFor(`delivery:${item.id}:${to}`, domainOf(this.from))
    const html = this.renderHtml?.({
      title: redactOutboundText('card_payload', sanitizeLabel(item.title, 120)),
      summary: redactOutboundText('card_payload', item.summary),
      links,
    })
    try {
      await this.mailer.send({
        from: this.fromName === undefined ? this.from : `${this.fromName} <${this.from}>`,
        to: [address],
        subject,
        text,
        message_id: external_id,
        ...(html === undefined ? {} : { html }),
      })
    } catch (e) {
      await this.emit('delivery.failed', {
        item_id: item.id,
        to,
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
    this.records.set(external_id, {
      external_id,
      to,
      to_address: address,
      item_id: item.id,
      view: item.view,
      sent_at: this.clock.now(),
      state: 'sent',
    })
    // 事件里不带 decision_token（它是一次性凭据，不进日志）
    await this.emit('delivery.sent', {
      item_id: item.id,
      to,
      external_id,
      view: item.view,
      actions: links.map((l) => l.action),
    })
    return { external_id }
  }

  /** 已由他人处理 → 在同一线程里补一封状态邮件（邮件没有"刷新卡片"，只能追一封）。 */
  async refresh(external_id: string, state: string): Promise<void> {
    const rec = this.records.get(external_id)
    if (rec === undefined) {
      throw new ChannelError('not_found', `投递不存在：${external_id}`, { external_id })
    }
    const at = this.clock.now()
    this.records.set(external_id, { ...rec, state, refreshed_at: at })
    await this.mailer.send({
      from: this.fromName === undefined ? this.from : `${this.fromName} <${this.from}>`,
      to: [rec.to_address],
      subject: `[审批] 状态更新：${sanitizeLabel(state, 80)}`,
      text: `审批项 ${rec.item_id} 的状态：${sanitizeLabel(state, 200)}\n原邮件里的链接已失效。`,
      message_id: messageIdFor(`delivery-refresh:${external_id}:${state}`, domainOf(this.from)),
      in_reply_to: external_id,
      references: external_id,
    })
  }

  /**
   * 回调只做一件事：认出 item_id + decision_token + action，其余一律丢弃。
   * 接受三种形态：回调 URL 串、`a=b&c=d` 查询串、已解析的对象 / JSON。
   */
  parseCallback(
    payload: unknown,
  ): { item_id: string; decision_token: string; action: DecisionAction } | undefined {
    const flat = flatten(payload)
    if (flat === undefined) return undefined
    const item_id = flat.item_id
    const decision_token = flat.decision_token
    const action = flat.action
    if (typeof item_id !== 'string' || item_id.length === 0) return undefined
    if (typeof decision_token !== 'string' || decision_token.length === 0) return undefined
    if (typeof action !== 'string' || !DECISION_ACTIONS.has(action)) return undefined
    return { item_id, decision_token, action: action as DecisionAction }
  }

  /** 观察面：投递记录。 */
  all(): DeliveryRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }))
  }

  private async emit(
    type: 'delivery.sent' | 'delivery.failed',
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.events === undefined) return
    await this.events.append({
      schema_version: 1,
      workspace_id: this.workspace,
      type,
      actor: { kind: 'system', id: 'delivery:email' },
      subject: { type: 'approval_item', id: String(payload.item_id ?? '') },
      correlation: { trace_id: `tr_delivery_${String(payload.item_id ?? '')}` },
      payload,
    })
  }
}

function flatten(payload: unknown): Record<string, unknown> | undefined {
  let raw: unknown = payload
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text.length === 0) return undefined
    if (text.startsWith('{')) {
      try {
        raw = JSON.parse(text)
      } catch {
        return undefined
      }
    } else {
      const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text
      const params = new URLSearchParams(query)
      const out: Record<string, unknown> = {}
      for (const [k, v] of params) out[k] = v
      return out
    }
  }
  if (raw instanceof URLSearchParams) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of raw) out[k] = v
    return out
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}
