/**
 * decide 的输入校验（36 §2.1、14 §4）。
 *
 * 五动作矩阵是界面的说法，14 的状态机只认 `approve / approve_edited / reject / defer …`。
 * 这里做那一层翻译，并把三条硬规则挡在网关之前：
 *
 * 1. 选择题卡裸 `approve` → `OPTION_REQUIRED`
 * 2. `instruct` 必须先选作用域 → `SCOPE_REQUIRED`
 * 3. `version` 与卡片不一致 → `VERSION_MISMATCH`（14 §5：revision 变了旧决定就作废）
 *
 * `instruct` 落到 14 上是 **reject + 指导文本**：这条草稿不发出去，人给了改法，
 * Agent 重做——这正是 14 §9 里「reject + reason = 强负样本」的那条学习信号。
 * 作用域决定它之后落到哪（本条回复 / 技能 overlay 提案 / 职责策略变更），
 * 那一步在 WP6 / WP3 的机器里，v1 只把 scope 原样带出去（见交付报告「未完成项」）。
 */
import { DeckError } from './errors.js'
import type { DeckCard, DeckDecideInput, InstructionScope, ResolvedDecision } from './types.js'

export const INSTRUCTION_SCOPES: readonly InstructionScope[] = [
  'single_reply',
  'similar_cases',
  'global_rule',
]

/** 稍后 = 默认推迟 4 小时（14 §4 的 deferred；到时自动回 pending）。 */
export const DEFAULT_SNOOZE_MS = 4 * 3_600_000

export interface ResolveOptions {
  /** 计算默认 defer_until 用的当前时间（注入，不用 Date.now()）。 */
  now: string
}

export function resolveDecision(
  card: DeckCard,
  input: DeckDecideInput,
  options: ResolveOptions,
): ResolvedDecision {
  if (input.version !== undefined && input.version !== card.version) {
    throw new DeckError(
      'VERSION_MISMATCH',
      `卡片已更新（当前 ${card.version}，你带的是 ${input.version}）`,
      {
        current: card.version,
        got: input.version,
      },
    )
  }
  if (!card.available_actions.includes(input.action)) {
    throw new DeckError('ACTION_NOT_AVAILABLE', `这张卡现在不能「${input.action}」`, {
      state: card.status,
      available: card.available_actions,
    })
  }
  if (input.instruction !== undefined) {
    const scope = input.instruction.scope
    if (!INSTRUCTION_SCOPES.includes(scope)) {
      throw new DeckError(
        'SCOPE_REQUIRED',
        'instruction.scope 只能是 single_reply / similar_cases / global_rule',
        {
          got: scope,
        },
      )
    }
    if (input.instruction.text.trim() === '') {
      throw new DeckError('SCOPE_REQUIRED', '指导内容不能为空')
    }
  }

  switch (input.action) {
    case 'open':
      throw new DeckError('ACTION_NOT_AVAILABLE', '「打开」不是一次决定，前端自己跳转')
    case 'approve': {
      if (card.options !== undefined && card.options.length > 0) {
        const picked = input.selected_option_id
        if (picked === undefined || picked === '') {
          throw new DeckError('OPTION_REQUIRED', '这是一张选择题卡，必须带 selected_option_id', {
            options: card.options.map((o) => o.id),
          })
        }
        if (!card.options.some((o) => o.id === picked)) {
          throw new DeckError('UNKNOWN_OPTION', `卡上没有这个选项：${picked}`, {
            options: card.options.map((o) => o.id),
          })
        }
        return {
          action: 'approve_edited',
          edited_payload: { ...asRecord(card.detail.payload), selected_option_id: picked },
        }
      }
      if (input.edited_payload !== undefined) {
        return { action: 'approve_edited', edited_payload: input.edited_payload }
      }
      return { action: 'approve' }
    }
    case 'reject': {
      const reason = input.instruction?.text ?? input.reason
      if (reason === undefined || reason.trim() === '') {
        throw new DeckError('REASON_REQUIRED', '14 §4：驳回必须写原因（它是最强的学习信号）')
      }
      return {
        action: 'reject',
        reason,
        ...(input.instruction === undefined ? {} : { instruction_scope: input.instruction.scope }),
      }
    }
    case 'instruct': {
      const instruction = input.instruction
      if (instruction === undefined) {
        throw new DeckError('SCOPE_REQUIRED', '指导要先选作用域：这一条 / 类似情况 / 以后都这样')
      }
      return {
        action: 'reject',
        reason: instruction.text,
        instruction_scope: instruction.scope,
      }
    }
    case 'snooze': {
      const until =
        input.defer_until ?? new Date(Date.parse(options.now) + DEFAULT_SNOOZE_MS).toISOString()
      return {
        action: 'defer',
        defer_until: until,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }
    }
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}
