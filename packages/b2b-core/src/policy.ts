/**
 * 报价授权与动作判断（docs/84 §3.2 / §11.1 第 3 条）。
 *
 * 出处：Luoye/BtoBAgents（Luoye 自己的私有仓库，本机 `~/Documents/BtoBAgents`）
 * `src/features/btobagents/domain/policy.ts`，首次 `5d4ed9c`、`29f93fe` 改过、
 * `c832e1e` 改名，移植时仓库 HEAD `940f12b`。不在 KOLAgents 纯模板提交 `cb506142` 里
 * （业务文件，非 MkSaaS 模板）。
 *
 * 移植时改了四处（其余判断顺序与文案原样）：
 *
 * 1. **去掉 L3 自动报价**。原来"金额、毛利都在授权内就 `execute`"，这里报价永远
 *    `approval_required`——授权只决定**谁批**（{@link PolicyDecision.approver}）：
 *    授权内业务员自己批，超出转上级，没有上级转老板（{@link quoteApprover}）。
 * 2. **两套阈值统一**成契约的 `DEFAULT_B2B_QUOTE_MANDATE`（1 万美元 / 20% / 5% / 30 天）；
 *    原来 `defaultMandate` 写的是 32% / 8%，`runtime.ts` 写的是 10 万 / 20% / 5%。
 * 3. 超授权的判据改用 `@agentsws/core` 的 `QUOTE_MANDATE_RULES`（与 guardrail 同一份），
 *    结论里带上超了哪几条。
 * 4. 字段名改成本仓的 snake_case；Mandate 换成契约的 `B2bQuoteMandate`。
 */
import type { B2bQuoteMandate } from '@agentsws/contracts'
import { DEFAULT_B2B_QUOTE_MANDATE } from '@agentsws/contracts'
import { QUOTE_MANDATE_RULES } from '@agentsws/core'

export type AutomationLevel = 'L0' | 'L1' | 'L2' | 'L3'
export type PolicyOutcome =
  | 'observe_only'
  | 'draft_only'
  | 'execute'
  | 'approval_required'
  | 'denied'

export interface ActionRequest {
  action:
    | 'research'
    | 'record_fact'
    | 'send_email'
    | 'send_whatsapp'
    | 'linkedin_task'
    | 'create_quote'
    | 'discount_exception'
    | 'contract_change'
    | 'account_transfer'
  level: AutomationLevel
  channel?: 'email' | 'whatsapp' | 'linkedin' | 'internal'
  amount_usd?: number
  margin_pct?: number
  discount_pct?: number
  payment_terms_days?: number
  has_whatsapp_opt_in?: boolean
  inside_whatsapp_service_window?: boolean
  has_verified_evidence?: boolean
  has_commercial_commitment?: boolean
  dry_run?: boolean
}

/** 谁来批这张卡（报价那一支才有）。 */
export type QuoteApprover = 'role_holder' | 'scope_manager' | 'owner'

export interface PolicyDecision {
  outcome: PolicyOutcome
  reason: string
  audit_code: string
  /** 报价：谁批（授权内业务员自己，超出转上级 / 老板）。 */
  approver?: QuoteApprover
  /** 报价：超了授权的哪几条（与 guardrail 的 hit 名逐字相同）。 */
  breaches?: string[]
}

const levelRank: Record<AutomationLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }

/** 一张报价的四个数超了授权的哪几条（空 = 授权内）。缺数按超出算。 */
export function quoteBreaches(
  quote: Pick<ActionRequest, 'amount_usd' | 'margin_pct' | 'discount_pct' | 'payment_terms_days'>,
  mandate: B2bQuoteMandate = DEFAULT_B2B_QUOTE_MANDATE,
): string[] {
  const out: string[] = []
  for (const r of QUOTE_MANDATE_RULES) {
    const cap = mandate[r.cap]
    const actual = quote[r.field]
    if (actual === undefined || (r.over ? actual > cap : actual < cap)) out.push(r.rule)
  }
  return out
}

/**
 * 超授权的报价卡转给谁：先上级（这条职责所在部门的负责人），没有上级再老板
 * （§11.1 第 3 条）。授权内业务员自己批。
 */
export function quoteApprover(
  breaches: readonly string[],
  hasScopeManager: boolean,
): QuoteApprover {
  if (breaches.length === 0) return 'role_holder'
  return hasScopeManager ? 'scope_manager' : 'owner'
}

/**
 * 判一个动作该怎么走（原 `evaluateAction`，判断顺序原样）。
 *
 * `hasScopeManager`：这条职责所在部门有没有负责人（报价转上级还是转老板看它）。
 */
export function evaluateAction(
  request: ActionRequest,
  mandate: B2bQuoteMandate = DEFAULT_B2B_QUOTE_MANDATE,
  hasScopeManager = true,
): PolicyDecision {
  if (request.dry_run) {
    return {
      outcome: 'draft_only',
      reason: 'Dry run 只返回计划和预计消耗，不产生外部副作用。',
      audit_code: 'execution.dry-run',
    }
  }

  if (request.level === 'L0') {
    return {
      outcome: 'observe_only',
      reason: '当前动作仅允许分析与记录建议。',
      audit_code: 'level.observe-only',
    }
  }

  if (request.action === 'linkedin_task') {
    return {
      outcome: 'draft_only',
      reason: 'LinkedIn 永远由成员人工完成发送。',
      audit_code: 'channel.linkedin-human-only',
    }
  }

  if (request.action === 'contract_change') {
    return {
      outcome: 'approval_required',
      reason: '合同条款修改属于不可关闭的人审动作。',
      audit_code: 'commercial.contract-human-gate',
    }
  }

  if (
    request.action === 'send_whatsapp' &&
    !request.has_whatsapp_opt_in &&
    !request.inside_whatsapp_service_window
  ) {
    return {
      outcome: 'denied',
      reason: '未记录 WhatsApp Opt-in，且不在服务窗口内。',
      audit_code: 'channel.whatsapp-opt-in-missing',
    }
  }

  if (request.action === 'record_fact' && !request.has_verified_evidence) {
    return {
      outcome: 'approval_required',
      reason: '事实缺少可自动应用的强证据。',
      audit_code: 'evidence.human-confirmation',
    }
  }

  if (request.action === 'account_transfer') {
    return {
      outcome: 'approval_required',
      reason: '客户资产交接必须由主管批准并生成审计记录。',
      audit_code: 'team.transfer-manager-gate',
    }
  }

  if (request.action === 'send_email' && request.has_commercial_commitment) {
    return {
      outcome: 'approval_required',
      reason: '邮件包含价格、交期、认证或合同承诺，需要人工确认。',
      audit_code: 'commercial.email-commitment-gate',
    }
  }

  if (request.action === 'create_quote') {
    const breaches = quoteBreaches(request, mandate)
    const approver = quoteApprover(breaches, hasScopeManager)
    if (!request.has_verified_evidence) {
      return {
        outcome: 'approval_required',
        reason: '报价缺少可追溯的产品、价格或客户需求证据。',
        audit_code: 'commercial.quote-evidence-missing',
        approver,
        breaches,
      }
    }
    // 移植改动 1：原来授权内走到最后的 `execute`（L3 自动报价）——这里**不搬**，报价永远出卡
    return breaches.length > 0
      ? {
          outcome: 'approval_required',
          reason: '报价超出金额、毛利、折扣或账期授权，转上级批。',
          audit_code: 'commercial.quote-outside-mandate',
          approver,
          breaches,
        }
      : {
          outcome: 'approval_required',
          reason: '报价在授权内，业务员自己批（报价永远出卡）。',
          audit_code: 'commercial.quote-inside-mandate',
          approver,
          breaches,
        }
  }

  if (
    request.action === 'discount_exception' &&
    (request.discount_pct ?? 100) > mandate.max_discount_pct
  ) {
    return {
      outcome: 'approval_required',
      reason: '折扣超出自动执行边界。',
      audit_code: 'commercial.discount-outside-mandate',
    }
  }

  if (levelRank[request.level] === 1) {
    return {
      outcome: 'draft_only',
      reason: 'L1 只生成草稿，不执行外部动作。',
      audit_code: 'level.draft-only',
    }
  }

  return {
    outcome: 'execute',
    reason: '动作在当前自动化等级与授权边界内。',
    audit_code: 'policy.allowed',
  }
}
