/**
 * WP417（自查客服 B5）：Amazon 买家消息的出站硬闸**在起草时就跑**。
 *
 * 以前只在人点了「发送」那一刻（`channels.ts` 的 deliver）才拦：人白批一次，卡再被打回。现在起草那一跳
 * 先查收件人是不是 marketplace relay 地址，是就照同一套规则（`evaluateAmazonOutbound`）扫一遍——
 * 有外链 / 联系方式 / 营销话术就**打回重写**（不建卡），原因原样喂回模型。发送那一跳的闸照旧在（双保险）。
 */
import {
  buildAmazonRewriteInstruction,
  evaluateAmazonOutbound,
  isMarketplaceRelayAddress,
} from '@agentsws/support-core'

export interface AmazonDraftVerdict {
  action: 'rewrite'
  rewrite_instruction: string
  /** 时间线上那一句。 */
  note: string
  gate_context: []
}

/** 收件人是 Amazon 买家 relay 地址、而正文过不了平台规矩 → 打回重写；别的回 `undefined`（照常走）。 */
export function amazonDraftGuard(input: {
  recipient?: string | undefined
  subject: string
  body: string
}): AmazonDraftVerdict | undefined {
  const to = input.recipient?.trim()
  if (to === undefined || !isMarketplaceRelayAddress(to)) return undefined
  const verdict = evaluateAmazonOutbound('amazon', {
    to_address: to,
    subject: input.subject,
    body_text: input.body,
    is_reply_to_buyer_thread: true,
  })
  if (verdict.ok) return undefined
  return {
    action: 'rewrite',
    rewrite_instruction: buildAmazonRewriteInstruction(verdict.violations),
    note: `这一版回信不符合 Amazon 站内信规矩（${verdict.violations
      .map((v) => v.code)
      .slice(0, 3)
      .join('、')}），已打回重写。`,
    gate_context: [],
  }
}
