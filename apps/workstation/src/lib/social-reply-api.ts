/**
 * WP255（决策 144）：工作台「回复」按钮与社群线程列表的接口。
 *
 * 单独一个文件（`api.ts` 那张大表好几单同时在加）。出卡走 WP254 的 `POST /v1/social/threads/:id/reply`
 * （承诺话术在那里打回 400，原话在 `ApiClientError.message` 里）。
 */
import type { CommunityThread } from '@agentsws/contracts'
import { api, type SocialChannelId, type SocialStagedData } from './api'

const as = (assignment: string | undefined) => (assignment === undefined ? {} : { assignment })

/** 线程列表上的一行（契约里的线程 + 哪个号 / 群）。正文是外部文本，原样显示。 */
export type SocialThreadRowData = CommunityThread & { account_name: string }

/** 「回复」框里那一句起草。`template` = 这次没用 AI（界面照实说）。 */
export interface SocialReplyDraftData {
  text: string
  source: 'ai' | 'template'
  note?: string
  /** 起草出来的这句自己过不了承诺扫描时那句改写要求。 */
  warning?: string
}

/** 这条渠道还没处理完的线程（转给客服的那些不算——球在客服那边）。 */
export const getSocialThreads = (
  channel: SocialChannelId,
  assignment?: string,
): Promise<{ rows: SocialThreadRowData[] }> =>
  api(`/v1/social/threads?channel=${encodeURIComponent(channel)}&open=true`, as(assignment))

/** 让 AI 先起草一句（只起草：不出卡、不落库）。 */
export const draftSocialReply = (
  thread_id: string,
  assignment?: string,
): Promise<SocialReplyDraftData> =>
  api(`/v1/social/threads/${encodeURIComponent(thread_id)}/reply-draft`, {
    method: 'POST',
    ...as(assignment),
  })

/** 出一张回帖卡（不直接发；批了过取消窗口才经渠道发出去）。 */
export const replySocialThread = (
  thread_id: string,
  text: string,
  assignment?: string,
): Promise<SocialStagedData> =>
  api(`/v1/social/threads/${encodeURIComponent(thread_id)}/reply`, {
    method: 'POST',
    body: { text },
    ...as(assignment),
  })

/** 自家版队列里一条 → 社媒库里的线程 id（同一条只记一次）。 */
export const ownSubThread = (
  input: { account_id: string; item_id: string },
  assignment?: string,
): Promise<{ thread_id: string }> =>
  api('/v1/social/own-sub/thread', { method: 'POST', body: input, ...as(assignment) })
