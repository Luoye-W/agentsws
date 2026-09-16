/**
 * 卡片在 IM 里长什么样（WP85）。
 *
 * ## 为什么不在微信里放按钮
 *
 * 14 §7 的卡片在邮件那一路是三个链接（通过 / 编辑 / 驳回，各带 `decision_token`）。
 * IM 这一路**故意不这么做**：
 *
 * - 微信 ClawBot 的定位是「本人 ↔ 本人的代理」，那条通道上只该有对话；
 *   把 `decision_token` 发进去等于把一次**施行**的钥匙放进一个我们管不了留存的地方。
 * - 企业微信群里那条更明显：群里所有人都看得见那条消息，按钮谁都能按。
 *
 * 所以 IM 里只出**文本摘要 + 一条「去工作台处理」的深链**。深链不带 token、
 * 不带任何业务参数，只是一个 `/matters/...` 之类的地址；点进去要登录、要过
 * 31 §3.1 的完整元组判定，跟平时在工作台上处理一模一样。
 *
 * 一句话：**凭据与决策不经 IM**（13 §4、29 §5「动作不经模型」的同一条纪律）。
 */

import { redactOutboundText, sanitizeLabel } from '@agentsws/core'

/** 要摆进 IM 的那张卡（只用得上这几样）。 */
export interface ImCardInput {
  id: string
  title: string
  summary: string
  /** 卡片类型（`draft_reply` / `policy_change` …）；认不出就不显示。 */
  kind?: string
  /** 等这张卡的人看的一句「还差什么」。 */
  hint?: string
}

/** 摘要最多摆多少字：IM 里长文没人读，读的是「要不要现在去处理」。 */
export const IM_CARD_SUMMARY_MAX = 180

const KIND_LABEL: Readonly<Record<string, string>> = {
  draft_reply: '一封待发的回信',
  policy_change: '一条要改的规矩',
  claim: '一件没人认领的事',
  meet: '一个约时间的请求',
}

/**
 * 渲染一张卡在 IM 里的样子（纯函数）。
 *
 * 出站脱敏走统一入口（31 §3.3）：标题与摘要都是**输出通道**，
 * 从客户原文里抄来的 `sk-…` 一样要在这里被抹掉。
 */
export function renderCardForIm(card: ImCardInput, deep_link: string): string {
  const title = redactOutboundText('card_payload', sanitizeLabel(card.title, 80))
  const summary = redactOutboundText('card_payload', card.summary).trim()
  const clipped =
    summary.length > IM_CARD_SUMMARY_MAX ? `${summary.slice(0, IM_CARD_SUMMARY_MAX - 1)}…` : summary
  const kind = card.kind === undefined ? undefined : KIND_LABEL[card.kind]
  const lines = [
    kind === undefined ? `【待你定】${title}` : `【待你定 · ${kind}】${title}`,
    ...(clipped === '' ? [] : ['', clipped]),
    ...(card.hint === undefined ? [] : ['', redactOutboundText('card_payload', card.hint)]),
    '',
    // 只有地址，没有 token、没有动作参数：在微信里点不了「通过」，只能去工作台
    `去工作台处理：${deep_link}`,
  ]
  return lines.join('\n')
}

/**
 * 卡片的深链。
 *
 * 只拼路径，不带 `decision_token`、不带 `action`——这正是它与
 * `delivery/email.ts` 的 `callbackLink` 的区别，也是本文件存在的理由。
 */
export function imCardDeepLink(base: string, card_id: string): string {
  const url = new URL(base.endsWith('/') ? base : `${base}/`)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/cards/${encodeURIComponent(card_id)}`
  return url.toString()
}
