import type { ChannelName, InboundEvent } from '@agentsws/contracts'

/**
 * WP210（Luoye 09-30）：一条进了死信的入站消息，**是不是客户来信**。
 *
 * 失败的信现在自动按退避重投（`ChannelInboundPipeline.sweepDeadLetters`），彻底投不进的只进
 * 后台日志——**只有客户来信**最终失败才值得打扰人、给一张卡：系统通知、营销群发、退信回执
 * 投不进就投不进，没有人在等它的回复。
 *
 * 判据全是结构性的（不读正文、不花模型）：
 * - 只看**客户会用的渠道**（邮件 / 在线聊天 / WhatsApp / Meta 私信 / 表单）的 `message`；
 *   企业微信、飞书是自己人跟自己的代理说话，webhook 是平台的系统事件，都不算；
 * - 发件人是 noreply / 退信 / 通知 / 营销这类机器地址的不算（与消息分拣
 *   `messages/triage.ts` 的 `isAutomatedMail` 同一个口径，入站事件里没有原始信头，只能看地址）；
 * - Amazon 渠道细分里判成「不起草」的（平台通知、疑似钓鱼）不算。
 */
const CUSTOMER_CHANNELS: ReadonlySet<ChannelName> = new Set<ChannelName>([
  'email',
  'chat',
  'whatsapp',
  'meta_dm',
  'form',
])

const AUTOMATED_SENDER =
  /(?:^|[.\-_+])(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|newsletters?|marketing|news)@/i

export function isCustomerLetter(event: InboundEvent): boolean {
  if (event.kind !== 'message') return false
  if (!CUSTOMER_CHANNELS.has(event.channel)) return false
  const from = event.actor?.external_id ?? ''
  if (AUTOMATED_SENDER.test(from)) return false
  if (event.sub_channel === 'amazon' && event.channel_meta?.generates_draft === false) return false
  return true
}
