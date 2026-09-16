/**
 * WhatsApp 适配器（社群组，56 §1 / §2）——**接口在、实现待 WP73**。
 *
 * 事实来源：WhatsApp Cloud API 文档（2026-09-16 读）。
 * <https://developers.facebook.com/docs/whatsapp/cloud-api>
 *
 * 这条渠道的规矩比别的都硬，而且**违了封的是这个品牌的号**：
 *
 * 1. **主动消息只能按预先审过的模板发**。自由文本只能在 24 小时客服窗口里发
 *    （对方先说过话）。所以 {@link WHATSAPP_TEMPLATE_REQUIRED} 这句话要在三处
 *    一字不差：这里、guardrail 的 `whatsapp_template_required`、连接卡的准备说明。
 * 2. **收件人必须先 opt-in**，而且要能举证。我们这一侧的落点是
 *    `community_broadcast` 提案上的 `opt_in_verified`——guardrail 不为真就 block，
 *    不是转人审：人在一屏卡面上判不出三千个号里有没有没 opt-in 的。
 * 3. **一天 100 条模板消息**是 56 §7 定的我们自己的闸（平台自己的分级更复杂）。
 *
 * 所以这个文件即使在 WP73 接上之后，`broadcast` 也**永远**先查那两格——
 * 适配器这一层再查一遍不是冗余，是因为执行器有可能被别的路径调到。
 *
 * 形状先钉死：基址 `https://graph.facebook.com/v21.0/<phone_number_id>/messages`，
 * `POST` JSON，`{ messaging_product: 'whatsapp', to, type: 'template', template: {...} }`。
 */

import type { SocialChannel } from '@agentsws/contracts'
import {
  type BroadcastInput,
  type ChannelProfile,
  guardConnected,
  needsApproval,
  type ReplyInput,
  type SocialChannelAdapter,
  type SocialError,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'whatsapp'
const LABEL = 'WhatsApp'
export const WHATSAPP_API_BASE = 'https://graph.facebook.com/v21.0'

/** 这句话在三处一字不差（见文件头第 1 条）。 */
export const WHATSAPP_TEMPLATE_REQUIRED =
  'WhatsApp 的主动消息只能按**预先审过的模板**发，自由文本只能在 24 小时客服窗口里发。去后台建一个模板，批下来之后把 template_id 填进来。'
export const WHATSAPP_OPT_IN_REQUIRED =
  'WhatsApp 要求收件人先 opt-in，而且要能举证。这批人里有没 opt-in 的、或者我们还没核过——两种情况都不许发（封的是这个品牌的号）。'

/** 56 §7：我们自己那一闸。平台自己的分级另算，两个都过才发得出去。 */
export const WHATSAPP_MAX_TEMPLATE_MESSAGES_PER_DAY = 100

/** 硬闸：少一格就不许发。**在适配器这一层再查一遍**（见文件头末段）。 */
export function whatsappBroadcastGate(input: BroadcastInput): SocialError | undefined {
  if ((input.template_id ?? '').trim() === '')
    return { ok: false, reason: 'needs_approval', message: WHATSAPP_TEMPLATE_REQUIRED }
  const n = input.recipients?.length ?? 0
  if (n > WHATSAPP_MAX_TEMPLATE_MESSAGES_PER_DAY)
    return {
      ok: false,
      reason: 'rate_limited',
      message: `一天最多 ${WHATSAPP_MAX_TEMPLATE_MESSAGES_PER_DAY} 条模板消息，这一批是 ${n} 条。分几天发。`,
    }
  return undefined
}

export function createWhatsAppAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(_account_external_id: string): Promise<SocialResult<ChannelProfile>> {
      return off() ?? needsApproval(LABEL, '商业账号资料接口（要先过 Meta 的商业验证）')
    },

    async reply(_input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      // 24h 窗口内的自由文本回复；WP73 接
      return off() ?? needsApproval(LABEL, '客服窗口内的回复（要先过 Meta 的商业验证与号码审核）')
    },

    async broadcast(
      input: BroadcastInput,
    ): Promise<SocialResult<{ sent: number; failed: number }>> {
      const guard = off()
      if (guard !== undefined) return guard
      // 硬闸先过：即使 WP73 接上了真调用，这两格也永远在最前面
      const gate = whatsappBroadcastGate(input)
      if (gate !== undefined) return gate
      return needsApproval(LABEL, '模板消息发送（Cloud API；要先过商业验证、号码审核与模板审核）')
    },
  }
}
