/**
 * WP191（docs/86 §4）：**LinkedIn** 适配器（公司主页 + 创始人 / 老板本人号的**内容**）。
 *
 * 事实来源：LinkedIn Marketing API · Posts API（Microsoft Learn，2026-09-29 读）。
 * <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api>
 *
 * 这条渠道特有的五件事：
 *
 * 1. **两种作者、两种权限**：本人号 `urn:li:person:…` 要 `w_member_social`（自助开通）；
 *    公司主页 `urn:li:organization:…` 要 `w_organization_social`，得过 Community
 *    Management API 审核、授权人还得是主页管理员。**没批下来是常态**——403 在这条渠道
 *    上说的是"要先申请"，不是"授权掉了"（同 TikTok 那条的教训）。
 * 2. **发出去的 id 在响应头上**：成功是 201 + 空 body，新帖的 URN 只在 `x-restli-id`
 *    头里。所以这里不走 `callJson`（它要解 JSON），自己打那一跳。
 * 3. **每一跳带两个头**：`LinkedIn-Version: YYYYMM`（钉死，不钉的话哪天悄悄换了行为）与
 *    `X-Restli-Protocol-Version: 2.0.0`。
 * 4. **这一版只代发文字**：带图 / 文档 / 视频要先走 Images / Documents API 传素材，
 *    还没接。带素材的帖子回 `not_implemented`——而这条渠道在契约上标了
 *    `publish_fallback: 'manual_task'`，所以到点它会变成一条「复制文案去 LinkedIn 发」
 *    的待办，不会悄悄没发。
 * 5. **没有 `reply` 与 `members`**：读写评论也在 Community Management API 后面，
 *    而**加人、私信在用户协议 §8.2 里明令禁止自动化**（那是 B2B 岗位只出人工任务的事）。
 *    缺席本身就是信息：界面上这两个按钮是灰的。
 */

import type { SocialChannel } from '@agentsws/contracts'
import { checkPostText } from '../platform.js'
import {
  type ChannelPost,
  contentRejected,
  guardConnected,
  httpFailure,
  notImplemented,
  type PublishInput,
  type SocialChannelAdapter,
  type SocialError,
  type SocialResult,
  type SocialTransport,
  upstreamError,
} from './types.js'

const CHANNEL: SocialChannel = 'linkedin'
const LABEL = 'LinkedIn'

export const LINKEDIN_API_BASE = 'https://api.linkedin.com/rest'
/** 版本钉死（文件头第 3 条）。LinkedIn 每个版本支持约一年，升级时改这一行。 */
export const LINKEDIN_API_VERSION = '202509'

/** 403 在这条渠道上的那句话（文件头第 1 条）。 */
function linkedinForbidden(author: string): SocialError {
  const org = author.startsWith('urn:li:organization:')
  return {
    ok: false,
    reason: 'needs_approval',
    status: 403,
    message: org
      ? 'LinkedIn 不让这把令牌替公司主页发帖：公司主页发帖要先过 Community Management API 审核，而且授权的人得是主页管理员。没批下来之前，到点会给你一条「复制文案去 LinkedIn 发」的待办。'
      : 'LinkedIn 不让这把令牌发帖：本人号发帖要在应用里开通「Share on LinkedIn」（w_member_social）。开通之前，到点会给你一条「复制文案去 LinkedIn 发」的待办。',
  }
}

export function createLinkedInAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  const headers = async (): Promise<Record<string, string>> => {
    const cred = await transport.credential(CHANNEL)
    return {
      Authorization: `Bearer ${cred.access_token ?? cred.token ?? ''}`,
      'LinkedIn-Version': LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    }
  }
  /** 作者 URN：账号上记的就是它；没记就用连接卡上填的那一格。 */
  const authorOf = async (account_external_id: string): Promise<string> => {
    if (account_external_id.startsWith('urn:li:')) return account_external_id
    const cred = await transport.credential(CHANNEL)
    return cred.author_urn ?? account_external_id
  }

  return {
    channel: CHANNEL,
    mode: 'api',

    async posts({ account_external_id, limit }): Promise<SocialResult<ChannelPost[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const author = await authorOf(account_external_id)
      const url = `${LINKEDIN_API_BASE}/posts?q=author&author=${encodeURIComponent(author)}&count=${limit ?? 25}`
      let res: Awaited<ReturnType<SocialTransport['fetch']>>
      try {
        res = await transport.fetch(url, { headers: await headers() })
      } catch (e) {
        return upstreamError(LABEL, e, url)
      }
      if (res.status === 403) return linkedinForbidden(author)
      if (!res.ok) return httpFailure(LABEL, res.status, url)
      try {
        const raw = JSON.parse(await res.text()) as {
          elements?: { id?: string; commentary?: string; publishedAt?: number }[]
        }
        return {
          ok: true,
          observed_at: transport.now(),
          data: (raw.elements ?? []).map((p) => ({
            external_id: p.id ?? '',
            kind: 'post' as const,
            body: p.commentary ?? '',
            ...(p.publishedAt === undefined
              ? {}
              : { published_at: new Date(p.publishedAt).toISOString() }),
            ...(p.id === undefined ? {} : { url: `https://www.linkedin.com/feed/update/${p.id}/` }),
          })),
        }
      } catch (e) {
        return upstreamError(LABEL, e, url)
      }
    },

    async publish(
      input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const problems = checkPostText(CHANNEL, input.body)
      if (problems.length > 0) return contentRejected(LABEL, problems)
      if (input.media_urls !== undefined && input.media_urls.length > 0)
        return notImplemented(
          LABEL,
          '带图、文档或视频的帖子要先把素材传给 LinkedIn，这一步还没接——这条会变成一条待办，你复制文案、带上素材去 LinkedIn 发',
        )
      const author = await authorOf(input.account_external_id)
      const url = `${LINKEDIN_API_BASE}/posts`
      let res: Awaited<ReturnType<SocialTransport['fetch']>>
      try {
        res = await transport.fetch(url, {
          method: 'POST',
          headers: { ...(await headers()), 'content-type': 'application/json' },
          body: JSON.stringify({
            author,
            commentary: input.body,
            visibility: 'PUBLIC',
            distribution: {
              feedDistribution: 'MAIN_FEED',
              targetEntities: [],
              thirdPartyDistributionChannels: [],
            },
            lifecycleState: 'PUBLISHED',
            isReshareDisabledByAuthor: false,
          }),
        })
      } catch (e) {
        return upstreamError(LABEL, e, url)
      }
      if (res.status === 403) return linkedinForbidden(author)
      if (res.status === 422)
        return {
          ok: false,
          reason: 'content_rejected',
          status: 422,
          message: `${LABEL} 退回了这条（422）：多半是正文里有它不收的格式或超长。改一下再发。`,
        }
      if (!res.ok) return httpFailure(LABEL, res.status, url)
      // 文件头第 2 条：id 在响应头上
      const id = res.headers?.get('x-restli-id') ?? ''
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          external_id: id,
          ...(id === '' ? {} : { url: `https://www.linkedin.com/feed/update/${id}/` }),
        },
      }
    },
  }
}
