/**
 * WP176（Fable 09-28）：Run 里的**开发信工具**真接上数据。
 *
 * 三个名字（`@agentsws/stand-ins` 的 `b2b-outbound.ts`）全部落到 `B2bOutboundPort` 上——
 * 与「主动开发」界面、`/v1/b2b/outbound/*` 同一份装配。这里一行业务逻辑都没有，只做三件事：
 *
 * 1. **判职责**：只有 `b2b.outbound` 能用（`tools.allow` 那一关之外再判一次），别的一律 `blocked`；
 * 2. **白名单出参**：名字、公司、走到哪一封、还差什么；没有邮箱（联系人库本来就只有加密库引用）；
 * 3. **失败说人话**：装配还没好、缺信，都回一句中文。
 *
 * 开一轮**不直接发信**：它出的是「用哪只邮箱发」的选择卡或首封批量卡，人批了执行器才发。
 */
import type { B2bActor, B2bOutboundPort } from '@agentsws/api'

import type { RunRequest, WorkspaceId } from '@agentsws/contracts'
import type {
  B2bSequencesData,
  B2bStartRoundData,
  ToolExecution,
  ToolExecutor,
} from '@agentsws/stand-ins'
import {
  B2B_CLASSIFY_REPLY_TOOL,
  B2B_LIST_SEQUENCES_TOOL,
  B2B_OUTBOUND_TOOL_NAMES,
  B2B_START_ROUND_TOOL,
  isB2bOutboundRole,
} from '@agentsws/stand-ins'
import { QUEUED_ZH } from './b2b-outbound.js'

export interface B2bOutboundToolsOptions {
  workspace_id: WorkspaceId
  /** 懒取：开发信装配比运行时晚建出来。 */
  port(): B2bOutboundPort | undefined
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

const STATUS_ZH: Readonly<Record<string, string>> = {
  queued: '排着',
  awaiting_approval: '待批',
  active: '进行中',
  replied: '回了',
  handed_to_sales: '转给业务',
  stopped: '停了',
  finished: '走完了',
}

const STEP_ZH: Readonly<Record<string, string>> = {
  first: '首封',
  follow_up: '跟进',
  final: '收尾',
}

export function createB2bOutboundToolExecutor(options: B2bOutboundToolsOptions): ToolExecutor {
  const actorOf = (request: RunRequest): B2bActor => ({
    workspace_id: options.workspace_id,
    person_id: request.actor.person_id,
    assignment_id: request.actor.assignment_id,
    role_id: request.actor.role_id,
  })

  return async ({ name, input, request }): Promise<ToolExecution> => {
    const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
    if (!B2B_OUTBOUND_TOOL_NAMES.includes(bare))
      return { status: 'error', reason: `not_a_b2b_outbound_tool:${bare}` }
    if (!isB2bOutboundRole(request.actor.role_id))
      return {
        status: 'blocked',
        reason: `${request.actor.role_id} 不是「主动开发」职责，用不了开发信工具。`,
      }
    const port = options.port()
    if (port === undefined)
      return { status: 'error', reason: '这个进程没装开发信那一摊，工具用不了。' }
    const actor = actorOf(request)
    try {
      if (bare === B2B_LIST_SEQUENCES_TOOL) {
        const view = await port.view(actor)
        const rows = (await port.sequences?.(actor))?.rows ?? []
        const data: B2bSequencesData = {
          funnel: view.funnel.map((f) => ({ label: f.label, count: f.count })),
          needs: view.needs.map((n) => QUEUED_ZH[n]),
          ...(view.sender === undefined ? {} : { remaining_today: view.sender.quota.remaining }),
          rows: rows.slice(0, 50).map((r) => ({
            name: r.name,
            company: r.company,
            status: STATUS_ZH[r.status] ?? r.status,
            ...(r.next_step === undefined
              ? {}
              : { next_step: STEP_ZH[r.next_step] ?? r.next_step }),
            ...(r.due_at === undefined ? {} : { due_at: r.due_at }),
          })),
          cooling: (view.cooling ?? []).map((c) => ({
            name:
              c.company === undefined
                ? (c.name ?? c.masked)
                : `${c.company}（${c.name ?? c.masked}）`,
            until: c.until,
            count: c.count,
          })),
        }
        return { status: 'ok', data }
      }
      if (bare === B2B_START_ROUND_TOOL) {
        const ids = Array.isArray(input.contact_ids)
          ? input.contact_ids.filter((x): x is string => typeof x === 'string' && x !== '')
          : undefined
        const product = str(input.product)
        const out = await port.start(actor, {
          ...(ids === undefined || ids.length === 0 ? {} : { contact_ids: ids }),
          ...(product === undefined ? {} : { product }),
        })
        const data: B2bStartRoundData = {
          status: out.status,
          message: out.message,
          picked: out.picked,
          queued_tomorrow: out.queued_tomorrow,
          ...(out.approval_item_id === undefined ? {} : { approval_item_id: out.approval_item_id }),
          excluded: out.excluded.map((x) => ({ name: x.name, company: x.company, label: x.label })),
        }
        return {
          status: 'ok',
          data: {
            ...data,
            // 运行时靠这两样把「出了卡」翻成时间线上看得见的一条
            kind: 'b2b_outreach',
            ...(out.change_id === undefined ? {} : { change_id: out.change_id }),
          },
        }
      }
      if (bare === B2B_CLASSIFY_REPLY_TOOL) {
        if (port.classifyReply === undefined)
          return { status: 'error', reason: '这个进程的开发信装配不会分回信。' }
        const inquiry_id = str(input.inquiry_id)
        const subject = str(input.subject)
        const text = str(input.text)
        const out = await port.classifyReply(actor, {
          ...(inquiry_id === undefined ? {} : { inquiry_id }),
          ...(subject === undefined ? {} : { subject }),
          ...(text === undefined ? {} : { text }),
        })
        return { status: 'ok', data: out }
      }
    } catch (e) {
      return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
    }
    return { status: 'error', reason: `not_a_b2b_outbound_tool:${bare}` }
  }
}
