/**
 * WP171（docs/84）：guardrail 里 B2B 那十三条 kind 的判断。
 *
 * 单独一个文件是为了让 `guardrail.ts` 的 switch 只多一行分派——判断本身都在这里，
 * 规则名（hit 的 `rule`）就是卡面上与模拟断言里认的那个字符串。
 *
 * 三条纪律（docs/84 §2 / §3 / §11）：
 *
 * 1. **承诺**：回询盘碰到价格 / 交期 / 认证 / MOQ / 独家 / 账期 / 保证 → 转人审；
 *    开发信碰到 → block（冷邮件里不该有"人点一下就发出去"的承诺）。
 * 2. **报价授权**：四个数只决定谁批。超出任何一个就多报一条 review hit，
 *    路由看到它就把卡转给上级（没有上级转老板）。
 * 3. **收款账户只认事实卡**：往外发的正文里带账户信息、却没标"取自事实卡"→ block；
 *    付款指示的账户对不上事实卡 → block。
 */
import type { ChangeKind, Mandate } from '@agentsws/contracts'
import {
  B2B_COMMITMENT_LABELS,
  detectPaymentAccountChange,
  scanB2bCommitments,
} from './b2b-terms.js'
import { capNumber } from './mandate.js'
import { suppressedRecipients } from './suppression.js'

type Push = (rule: string, cap?: number | string, actual?: number | string) => void

/** 这几条 kind 归这个文件判。 */
export const B2B_GUARDED_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  'b2b_reply',
  'b2b_quote',
  'b2b_sample',
  'b2b_outreach',
  'b2b_list_import',
  'b2b_account_transfer',
  'trade_show_registration',
  'export_docs_send',
  'shipment_booking',
  'bill_release',
  'payment_instruction',
  'marketplace_listing',
  'marketplace_spend',
])

/**
 * 报价四个数对授权（职责 yml 的 `mandate.caps`）。回超出的那几条（空 = 授权内）。
 * `@agentsws/b2b-core` 的 `quoteOutsideMandate` 与这里是同一个口径。
 */
export const QUOTE_MANDATE_RULES = [
  { rule: 'quote_amount_over_mandate', cap: 'max_amount_usd', field: 'amount_usd', over: true },
  { rule: 'quote_margin_under_mandate', cap: 'min_margin_pct', field: 'margin_pct', over: false },
  {
    rule: 'quote_discount_over_mandate',
    cap: 'max_discount_pct',
    field: 'discount_pct',
    over: true,
  },
  {
    rule: 'quote_payment_terms_over_mandate',
    cap: 'max_payment_terms_days',
    field: 'payment_terms_days',
    over: true,
  },
] as const

const text = (...vs: unknown[]): string =>
  vs.filter((v): v is string => typeof v === 'string').join('\n')
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** 往外发的正文里带账户信息，必须是从事实卡取的（`after.account_from_fact_card === true`）。 */
function accountOnlyFromFactCard(after: Record<string, unknown>, body: string, block: Push): void {
  const signal = detectPaymentAccountChange(body)
  if (signal.has_account_details && after.account_from_fact_card !== true)
    block('payment_account_not_from_fact_card', 'fact_card', 'body')
}

/**
 * 判一条 B2B 变更。`review` / `block` 是 `evaluateGuardrail` 里那两个收集器，
 * `windowCount` 是这条动作窗口内已占的条数（日配额看它）。
 */
export function evaluateB2bChange(
  kind: ChangeKind,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  mandate: Mandate,
  windowCount: number,
  review: Push,
  block: Push,
): void {
  switch (kind) {
    case 'b2b_reply': {
      const body = text(after.subject, after.body)
      const hits = scanB2bCommitments(body)
      // 转人审不是 block：回询盘本来就要谈价，只是这一封得人看过再发
      if (hits.length > 0)
        review(
          'b2b_commitment',
          hits.map((h) => B2B_COMMITMENT_LABELS[h.category]).join('、'),
          hits.map((h) => h.term).join(', '),
        )
      accountOnlyFromFactCard(after, body, block)
      break
    }
    case 'b2b_quote': {
      // 报价版本不可改：新的一版号必须比旧的大（改价 = 新建一版）
      const prev = num(before.version)
      const next = num(after.version)
      if (prev !== undefined && (next === undefined || next <= prev))
        block('quote_version_immutable', prev + 1, next ?? 'missing')
      for (const r of QUOTE_MANDATE_RULES) {
        const cap = capNumber(mandate, r.cap)
        const actual = num(after[r.field])
        if (cap === undefined) continue
        // 缺数 = 判不了，按超出处理（fail-closed：转上级比漏批好）
        if (actual === undefined) review(r.rule, cap, 'missing')
        else if (r.over ? actual > cap : actual < cap) review(r.rule, cap, actual)
      }
      break
    }
    case 'b2b_sample': {
      if (
        after.status === 'shipped' &&
        (typeof after.tracking_no !== 'string' || after.tracking_no === '')
      )
        block('sample_tracking_required', 'tracking_no', 'missing')
      break
    }
    case 'b2b_outreach': {
      const body = text(after.subject, after.body)
      const hit = scanB2bCommitments(body)[0]
      if (hit !== undefined)
        block('b2b_outreach_commitment', B2B_COMMITMENT_LABELS[hit.category], hit.term)
      // 页脚由系统加（退订方式 + 公司实体地址，CAN-SPAM / CASL / GDPR）
      if (after.footer_unsubscribe !== true || after.footer_address !== true)
        block('b2b_outreach_footer', 'unsubscribe+address', 'missing')
      const noSource = num(after.contacts_missing_source) ?? 0
      if (noSource > 0) block('contact_source_required', 0, noSource)
      // SPF / DKIM 没过不发（送达前提，§11.1 第 4 条）；DMARC 缺了只提示
      const auth = (after.sender_auth ?? {}) as Record<string, unknown>
      if (auth.spf !== 'pass' || auth.dkim !== 'pass')
        block(
          'sender_auth',
          'spf+dkim',
          `${String(auth.spf ?? 'unknown')}/${String(auth.dkim ?? 'unknown')}`,
        )
      else if (auth.dmarc !== 'pass')
        review('sender_dmarc_missing', 'dmarc', String(auth.dmarc ?? 'unknown'))
      // 用主域名发是用户自己选的：能发，卡上一句风险提示（§11.1 第 4 条）
      if (after.shared_sending_domain === true)
        review('shared_sending_domain', 'separate', 'primary')
      // 德国、奥地利默认不发，用户勾选并确认风险后才发（§11.1 第 6 条）
      const excluded = strings(after.countries).filter((c) => c === 'DE' || c === 'AT')
      if (excluded.length > 0 && after.de_at_confirmed !== true)
        block('country_excluded', 'DE,AT', excluded.join(','))
      if (after.suppression_checked !== true)
        block('suppression_list_required', 'checked', String(after.suppression_checked ?? 'never'))
      else {
        const leaked = suppressedRecipients(strings(after.recipients), strings(after.suppressed))
        if (leaked.length > 0) block('suppression_list', 0, leaked.length)
      }
      const cap = capNumber(mandate, 'max_outreach_per_day')
      const batch = num(after.count) ?? 1
      if (cap !== undefined && windowCount + batch > cap)
        review('max_outreach_per_day', cap, windowCount + batch)
      break
    }
    case 'b2b_list_import': {
      // 官方档要扣积分：卡上必须写预计扣多少（价目取云上，不写死）
      if (after.tier === 'official' && num(after.credits_estimate) === undefined)
        block('list_credits_estimate_required', 'credits_estimate', 'missing')
      break
    }
    case 'trade_show_registration': {
      const cap = capNumber(mandate, 'max_trade_show_fee_usd')
      const fee = num(after.fee_usd)
      if (cap !== undefined && fee !== undefined && fee > cap)
        review('trade_show_fee_over_cap', cap, fee)
      break
    }
    case 'export_docs_send': {
      const docs = Array.isArray(after.docs) ? (after.docs as Record<string, unknown>[]) : []
      const bad = docs.filter((d) => d.status === 'discrepancy').length
      if (bad > 0 && after.discrepancies_acknowledged !== true) review('doc_discrepancy', 0, bad)
      accountOnlyFromFactCard(after, text(after.body), block)
      break
    }
    case 'bill_release': {
      // 尾款没到不放单——是提醒不是禁令（有的客户信用好，老板点头就放）
      if (after.balance_received !== true) review('balance_unpaid', 'received', 'no')
      break
    }
    case 'payment_instruction': {
      if (after.account_matches_fact_card !== true)
        block(
          'payment_account_mismatch',
          'fact_card',
          String(after.account_matches_fact_card ?? 'unchecked'),
        )
      break
    }
    default:
      break
  }
}
