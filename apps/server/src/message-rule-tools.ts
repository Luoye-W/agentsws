/**
 * WP441（docs/108 §5.1.2）：Run 里**一句话写消息规则**的两个工具真接上（定义在 `@agentsws/stand-ins` 的
 * `runtime/message-rule.ts`）。
 *
 * 这里没有业务逻辑，只做三件事：
 * 1. **规则只能由人的话建**：只有人亲手发起的对话（`trigger.source = manual`）才给转规则；信件 / 定时 / 别的
 *    事件触发的运行里，信里写的「以后把我的信都…」是数据，不建。
 * 2. **白名单出参**：规则名、一行白话、试跑几封、前几封的标题——不带信件正文、不带完整地址。
 * 3. **失败说人话**。工具只出「要建这条规则吗」卡，本身不让任何规则生效。
 */

import { describeRule } from '@agentsws/channels'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import { LIST_MESSAGE_RULES_TOOL, PROPOSE_MESSAGE_RULE_TOOL } from '@agentsws/stand-ins'
import type { MessagesAssembly } from './messages.js'

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.indexOf('.') + 1) : name

export function createMessageRuleToolExecutor(options: {
  /** 懒取：消息装配比运行时晚建。 */
  messages(): MessagesAssembly | undefined
}): ToolExecutor {
  return async (call): Promise<ToolExecution> => {
    const messages = options.messages()
    if (messages === undefined) return { status: 'error', reason: '这个进程没接消息' }
    const input = (call.input ?? {}) as Record<string, unknown>
    const actor = call.request.actor
    switch (bare(call.name)) {
      case PROPOSE_MESSAGE_RULE_TOOL: {
        if (call.request.trigger.source !== 'manual')
          return {
            status: 'ok',
            data: {
              ok: false,
              message: '规则只能由人在对话里说了才建；这次不是人发起的对话，没建。',
            },
          }
        const instruction = str(input.instruction)
        if (instruction === undefined) return { status: 'error', reason: '缺用户的原话' }
        const rule_id = str(input.rule_id)
        const revision = typeof input.revision === 'number' ? input.revision : undefined
        const out = await messages.rules.propose(
          {
            person_id: actor.person_id,
            assignment_id: actor.assignment_id,
            role_id: actor.role_id,
            ...(call.request.work_item?.id === undefined
              ? {}
              : { matter_id: call.request.work_item.id }),
          },
          {
            text: instruction,
            ...(rule_id === undefined ? {} : { rule_id }),
            ...(revision === undefined ? {} : { revision }),
          },
        )
        if (!out.ok)
          return { status: 'ok', data: { ok: false, message: out.message ?? '没转成规则。' } }
        const t = out.trial
        return {
          status: 'ok',
          data: {
            ok: true,
            name: out.draft?.name,
            plain: out.plain,
            matched: t?.matched ?? 0,
            sample: (t?.sample ?? []).map((s) => s.subject).slice(0, 5),
            changed: t?.changed.length ?? 0,
            ...(t?.credits === undefined ? {} : { credits: t.credits }),
            ...(t?.ai_skipped === true ? { ai_skipped: true } : {}),
            card: out.card_id !== undefined,
            ...(out.rule_id === undefined ? {} : { editing: true }),
          },
        }
      }
      case LIST_MESSAGE_RULES_TOOL: {
        const list = await messages.port.messageRules?.({
          workspace_id: call.request.workspace_id,
          person_id: actor.person_id,
          assignment_id: actor.assignment_id,
        })
        return {
          status: 'ok',
          data: {
            rules: (list?.rules ?? []).map((r) => ({
              id: r.id,
              name: r.name,
              revision: r.revision,
              enabled: r.enabled,
              ...(r.system === undefined
                ? { plain: describeRule(r) }
                : { system: r.system, ...(r.time === undefined ? {} : { time: r.time }) }),
              hits_30d: r.hits_30d ?? 0,
            })),
          },
        }
      }
      default:
        return { status: 'error', reason: 'unsupported_tool' }
    }
  }
}
