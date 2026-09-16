/**
 * WhatsApp 适配器（社群组，56 §1 / §2；**真实现** WP73）。
 *
 * 事实来源：WhatsApp Business Cloud API 文档（2026-09-16 读）。
 * <https://developers.facebook.com/docs/whatsapp/cloud-api>
 *
 * 这条渠道的规矩比别的都硬，而且**违了封的是这个品牌的号**：
 *
 * 1. **主动消息只能按预先审过的模板发**（`type: 'template'`，`template.name`
 *    必填）。自由文本只能在 **24 小时客服窗口**里发——窗口的起点是**对方最近
 *    一条入站消息**的时刻（{@link WHATSAPP_CUSTOMER_WINDOW_MS}）。窗口过了还发
 *    自由文本，上游回 `131047`，而账号那边记一笔。
 * 2. **收件人必须先 opt-in**，而且要能举证。我们这一侧的落点是
 *    `community_broadcast` 提案上的 `opt_in_verified`——guardrail 不为真就 block，
 *    不是转人审：人在一屏卡面上判不出三千个号里有没有没 opt-in 的。
 *    {@link whatsappBroadcastGate} 在**适配器这一层再查一遍**，因为执行器有可能
 *    被别的路径调到。
 * 3. **一天 100 条模板消息**是 56 §7 定的我们自己的闸（平台自己的分级更复杂）。
 *
 * 群发是**一个一个发**的：Cloud API 没有批量接口，`/messages` 一跳一个号。
 * 所以 `broadcast` 数着发了几个、失败几个，**失败不重试**（重试一条可能已经
 * 送达的模板消息，代价是对方收到两条一样的）。
 */

import type { SocialChannel } from '@agentsws/contracts'
import {
  type BroadcastInput,
  type ChannelProfile,
  callJson,
  guardConnected,
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

/** 24 小时客服窗口（文件头第 1 条）。起点是对方最近一条入站消息的时刻。 */
export const WHATSAPP_CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000

/** 默认模板语言。连接那条记录里能盖过去（`template_language`）。 */
export const WHATSAPP_DEFAULT_TEMPLATE_LANGUAGE = 'zh_CN'

/**
 * 硬闸：少一格就不许发。**在适配器这一层再查一遍**（见文件头第 2 条）。
 *
 * 三格都是"不给就不发"，不是"不给就按默认来"：模板名编不出来，opt-in 更编不出来。
 */
export function whatsappBroadcastGate(input: BroadcastInput): SocialError | undefined {
  if ((input.template_id ?? '').trim() === '')
    return { ok: false, reason: 'needs_approval', message: WHATSAPP_TEMPLATE_REQUIRED }
  if (input.opt_in_verified !== true)
    return { ok: false, reason: 'needs_approval', message: WHATSAPP_OPT_IN_REQUIRED }
  const n = input.recipients?.length ?? 0
  if (n > WHATSAPP_MAX_TEMPLATE_MESSAGES_PER_DAY)
    return {
      ok: false,
      reason: 'rate_limited',
      message: `一天最多 ${WHATSAPP_MAX_TEMPLATE_MESSAGES_PER_DAY} 条模板消息，这一批是 ${n} 条。分几天发。`,
    }
  return undefined
}

/**
 * 这个号现在还在 24 小时客服窗口里吗（文件头第 1 条）。
 *
 * `last_inbound_at` 不给 = **不在**窗口里。把"没记过"当成"还在窗口里"，
 * 等于把这一闸悄悄打开——而这一闸后面是账号被封。
 */
export function whatsappWindowOpen(input: {
  last_inbound_at: string | undefined
  now: string
}): boolean {
  if (input.last_inbound_at === undefined) return false
  const last = Date.parse(input.last_inbound_at)
  const now = Date.parse(input.now)
  if (Number.isNaN(last) || Number.isNaN(now)) return false
  return now - last < WHATSAPP_CUSTOMER_WINDOW_MS && now >= last
}

interface RawSendResult {
  messages?: { id?: string }[]
}

export function createWhatsAppAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  const credOf = () => transport.credential(CHANNEL)

  /** 一跳到 `/{phone-number-id}/messages`。 */
  const send = async (
    phone_number_id: string,
    token: string,
    payload: unknown,
  ): Promise<{ ok: true; data: RawSendResult } | SocialError> => {
    const url = `${WHATSAPP_API_BASE}/${encodeURIComponent(phone_number_id)}/messages`
    return callJson<RawSendResult>(transport, LABEL, url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...(payload as object) }),
    })
  }

  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(account_external_id: string): Promise<SocialResult<ChannelProfile>> {
      const guard = off()
      if (guard !== undefined) return guard
      const cred = await credOf()
      const id = cred.phone_number_id ?? account_external_id
      const url = `${WHATSAPP_API_BASE}/${encodeURIComponent(id)}/whatsapp_business_profile?fields=${encodeURIComponent('about,description,email,websites,vertical')}`
      const res = await callJson<{
        data?: { about?: string; description?: string }[]
      }>(transport, LABEL, url, {
        headers: { authorization: `Bearer ${cred.access_token ?? cred.token ?? ''}` },
      })
      if (!('data' in res)) return res
      const raw = res.data.data?.[0] ?? {}
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          channel: CHANNEL,
          external_id: id,
          handle: cred.display_phone_number ?? id,
          display_name: cred.display_name ?? cred.display_phone_number ?? id,
          url: `https://wa.me/${(cred.display_phone_number ?? '').replace(/\D/g, '')}`,
          ...(raw.about === undefined && raw.description === undefined
            ? {}
            : { bio: raw.about ?? raw.description ?? '' }),
          // **粉丝数 / 成员数这条渠道上没有**：WhatsApp 不是一个有"群众"的地方
        },
      }
    },

    async reply(input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      /*
       * 文件头第 1 条：**自由文本只在 24 小时窗口里**。
       *
       * 窗口关着的时候这里不"降级成模板消息自动发一条"——那等于替人做了一个
       * 会花钱、会被人当成骚扰的决定。照实说，让起草那一跳去选一个模板。
       */
      if (!whatsappWindowOpen({ last_inbound_at: input.last_inbound_at, now: transport.now() }))
        return {
          ok: false,
          reason: 'needs_approval',
          message: `这个号的 24 小时客服窗口${input.last_inbound_at === undefined ? '没有记录（当成关着）' : '已经过了'}，自由文本发不出去。${WHATSAPP_TEMPLATE_REQUIRED}`,
        }
      const cred = await credOf()
      const res = await send(
        cred.phone_number_id ?? input.account_external_id ?? '',
        cred.access_token ?? cred.token ?? '',
        {
          to: input.parent_external_id,
          type: 'text',
          text: { body: input.text, preview_url: false },
        },
      )
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: { external_id: res.data.messages?.[0]?.id ?? '' },
      }
    },

    async broadcast(
      input: BroadcastInput,
    ): Promise<SocialResult<{ sent: number; failed: number }>> {
      const guard = off()
      if (guard !== undefined) return guard
      // 硬闸先过：即使真调用接上了，这三格也永远在最前面（文件头第 2 条）
      const gate = whatsappBroadcastGate(input)
      if (gate !== undefined) return gate

      const cred = await credOf()
      const phone_number_id = cred.phone_number_id ?? input.account_external_id
      const token = cred.access_token ?? cred.token ?? ''
      const language = cred.template_language ?? WHATSAPP_DEFAULT_TEMPLATE_LANGUAGE
      /*
       * 模板变量按位置填（Cloud API 的 `body` 组件收的是一个有序数组）。
       * `template_variables` 的 key 是 `'1'` / `'2'` …，照数字序排——
       * 对象的自然序在这件事上靠不住。
       */
      const vars = Object.entries(input.template_variables ?? {})
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, v]) => ({ type: 'text', text: v }))
      const components = vars.length === 0 ? [] : [{ type: 'body', parameters: vars }]

      let sent = 0
      let failed = 0
      let firstError: SocialError | undefined
      for (const to of input.recipients ?? []) {
        const res = await send(phone_number_id, token, {
          to,
          type: 'template',
          template: {
            // 文件头第 1 条：`template.name` 必填
            name: input.template_id,
            language: { code: language },
            ...(components.length === 0 ? {} : { components }),
          },
        })
        if ('data' in res) {
          sent += 1
          continue
        }
        failed += 1
        firstError ??= res
        /*
         * **失败就停**：没连上 / 授权掉了 / 被限流这三种，接着发下去只会把
         * 同一个错误重复几百遍，而每一遍都在这个号上记一笔。
         */
        if (res.reason === 'not_connected' || res.reason === 'rate_limited') break
      }
      if (sent === 0 && firstError !== undefined) return firstError
      return { ok: true, observed_at: transport.now(), data: { sent, failed } }
    },
  }
}
