/**
 * WP68 才接的那三条（Facebook / TikTok / X）：**接口齐了，实现没有**。
 *
 * 为什么现在就把它们建出来而不是等 WP68：五条渠道职责已经上线，
 * 用户在岗位页上点得到 TikTok 那条职责。那条职责里的找人这一块要么说
 * "还没做，先用导入"，要么什么都不说——后者会让人以为是自己哪里没设置对。
 * 这正是 36 §3「没连就明说」与 51 §3 N2「待增加要看得见」的同一条规矩。
 *
 * 四个口子全部回 `not_implemented` + 一句人话，**一跳都不打**。
 * 与"没连"分得开：那个用户去连接页能修好，这个他修不好。
 */
import type { KolChannel } from '@agentsws/contracts'
import {
  type ChannelBenchmark,
  type ChannelResult,
  type ChannelSearchHit,
  type ContactHint,
  type KolChannelAdapter,
  notImplemented,
} from './types.js'

function pending(channel: KolChannel, label: string, plan: string): KolChannelAdapter {
  const err = notImplemented(label, plan)
  return {
    channel,
    search: async (): Promise<ChannelResult<ChannelSearchHit[]>> => err,
    profile: async (): Promise<ChannelResult<ChannelSearchHit>> => err,
    benchmark: async (): Promise<ChannelResult<ChannelBenchmark | undefined>> => err,
    contact_hint: async (): Promise<ChannelResult<ContactHint[]>> => err,
  }
}

/** Facebook：Graph API 的主页权限是审核制，建联走主页私信（48 §5.1）。 */
export const createFacebookAdapter = (): KolChannelAdapter =>
  pending('facebook', 'Facebook', 'WP68 接；Graph API 的主页权限要先过审核')

/** TikTok：Research API 申请制，带货归因走 TikTok Shop 联盟（48 §5.1）。 */
export const createTikTokAdapter = (): KolChannelAdapter =>
  pending('tiktok', 'TikTok', 'WP68 接；Research API 是申请制，批下来才有数据')

/** X：官方 API 是付费档（48 §5.1）。 */
export const createXAdapter = (): KolChannelAdapter =>
  pending('x', 'X', 'WP68 接；X 的官方 API 要买付费档')
