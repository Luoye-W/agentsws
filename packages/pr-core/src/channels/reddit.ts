/**
 * `pr.reddit` 的渠道口（60 §2 `channels/reddit.ts`）。
 *
 * **不重新写一个 Reddit 适配器。** `@agentsws/social-core` 的
 * `createRedditAdapter` 已经把这条渠道上所有难的东西做完了（User-Agent 的格式、
 * fullname 前缀、form-urlencoded、一分钟 60 跳自己排队、`api_type=json` 把
 * 业务错误藏在 200 里）。这里只加**三口**，因为 `social.reddit` 管的是
 * 我们自己的版、用不上它们：
 *
 * | 口 | 干什么 | 为什么社媒那条没有 |
 * |---|---|---|
 * | {@link PrRedditAdapter.searchSubreddits} | 找版 | 自己的版不用找 |
 * | {@link PrRedditAdapter.subredditRules} | 读版规 | 自己的版规是自己写的 |
 * | {@link PrRedditAdapter.submitToSubreddit} | 在**别人的**版里发一条 | 越界 |
 *
 * 一条纪律压在第三口上：**它不判审批，但它也不该被起草那一跳调到**。
 * 与 56 的 Facebook 群组那条一样，真正"点下去"的那一跳要带一张批过的卡
 * （{@link submitApprovedPost}）——路径上就不存在"想发就发"。
 */

import type { Iso8601, SubredditPolicy } from '@agentsws/contracts'
import {
  callJson,
  createRedditAdapter,
  guardConnected,
  REDDIT_API_BASE,
  REDDIT_SUBMIT_PATH,
  type SocialChannelAdapter,
  type SocialError,
  type SocialResult,
  type SocialTransport,
} from '@agentsws/social-core'
import { parseSubredditRules } from '../subreddits.js'

const LABEL = 'Reddit'

/** 搜到的一个版（找版那一块的行）。 */
export interface SubredditHit {
  name: string
  title: string
  subscribers?: number
  /** 版的简介（**外部文本**——进模型上下文前要围栏，21 §1）。 */
  description?: string
  over_18: boolean
  url: string
}

export interface PrRedditAdapter {
  /** 社媒那一份适配器原样端出来（读帖子、读评论、回帖都走它）。 */
  readonly base: SocialChannelAdapter
  /** 找版：按关键词搜 subreddit。 */
  searchSubreddits(input: { query: string; limit?: number }): Promise<SocialResult<SubredditHit[]>>
  /** 读版规：`/r/<sub>/about/rules`，解析成结构化的三件事。 */
  subredditRules(name: string): Promise<SocialResult<SubredditPolicy>>
  /**
   * 在别人的版里发一条。**要带一张批过的卡**（文件头最后一段）。
   *
   * 版规在这里**不再查一遍**：查过的结论是 `ExternalPost.rules_checked`，
   * 它已经被 guardrail 当成硬闸判过了（`community_post` 那一支）。
   * 在这里重判等于第二份判据，两份迟早各改各的。
   */
  submitToSubreddit(input: {
    subreddit: string
    title: string
    body: string
    flair_id?: string
    approval_id: string
  }): Promise<SocialResult<{ external_id: string; url?: string }>>
}

interface RawSubredditListing {
  data?: {
    children?: {
      data?: {
        display_name?: string
        title?: string
        subscribers?: number
        public_description?: string
        over18?: boolean
        url?: string
      }
    }[]
  }
}

interface RawRules {
  rules?: { short_name?: string; description?: string; violation_reason?: string }[]
}

const subOf = (value: string): string => value.replace(/^\/?r\//, '').replace(/^\//, '')

export function createPrRedditAdapter(transport: SocialTransport): PrRedditAdapter {
  const base = createRedditAdapter(transport)
  const off = (): SocialError | undefined => guardConnected(transport, 'reddit', LABEL)

  const headers = async (): Promise<Record<string, string>> => {
    const cred = await transport.credential('reddit')
    return {
      authorization: `Bearer ${cred.access_token ?? cred.token ?? ''}`,
      'user-agent': cred.user_agent ?? 'agentsws/1.0 (公共关系；https://github.com/agentsws)',
      accept: 'application/json',
    }
  }

  return {
    base,

    async searchSubreddits({ query, limit }) {
      const guard = off()
      if (guard !== undefined) return guard
      const res = await callJson<RawSubredditListing>(
        transport,
        LABEL,
        `${REDDIT_API_BASE}/subreddits/search?q=${encodeURIComponent(query)}&limit=${Math.min(limit ?? 25, 100)}`,
        { headers: await headers() },
      )
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data?.children ?? []).map((c) => {
          const raw = c.data ?? {}
          return {
            name: raw.display_name ?? '',
            title: raw.title ?? raw.display_name ?? '',
            ...(raw.subscribers === undefined ? {} : { subscribers: raw.subscribers }),
            ...(raw.public_description === undefined
              ? {}
              : { description: raw.public_description }),
            over_18: raw.over18 === true,
            url: `https://www.reddit.com${raw.url ?? `/r/${raw.display_name ?? ''}/`}`,
          }
        }),
      }
    },

    async subredditRules(name) {
      const guard = off()
      if (guard !== undefined) return guard
      const sub = subOf(name)
      const res = await callJson<RawRules>(
        transport,
        LABEL,
        `${REDDIT_API_BASE}/r/${encodeURIComponent(sub)}/about/rules`,
        { headers: await headers() },
      )
      if (!('data' in res)) return res
      const now: Iso8601 = transport.now()
      /*
       * 一条规则在 Reddit 上有三格（短名、正文、违规理由），三格都可能写着
       * "no self-promotion"。合成一行再解析，比挑其中一格解析漏判得少。
       */
      const raw_rules = (res.data.rules ?? []).map((r) =>
        [r.short_name, r.violation_reason, r.description]
          .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
          .join('：'),
      )
      return {
        ok: true,
        observed_at: now,
        data: parseSubredditRules({ name: sub, raw_rules, observed_at: now }),
      }
    },

    async submitToSubreddit(input) {
      const guard = off()
      if (guard !== undefined) return guard
      if (input.approval_id.trim() === '')
        return {
          ok: false,
          reason: 'needs_approval',
          message:
            '在别人的版里发帖要先有一张批过的卡。没有卡 id 就不发——我们在人家的地盘上，这一下点错了是整个品牌被那个版赶走。',
        }
      const body = new URLSearchParams({
        api_type: 'json',
        sr: subOf(input.subreddit),
        kind: 'self',
        title: input.title.slice(0, 300),
        text: input.body,
        ...(input.flair_id === undefined ? {} : { flair_id: input.flair_id }),
      }).toString()
      const res = await callJson<{
        json?: { data?: { name?: string; url?: string }; errors?: unknown[][] }
      }>(transport, LABEL, `${REDDIT_API_BASE}${REDDIT_SUBMIT_PATH}`, {
        method: 'POST',
        headers: {
          ...(await headers()),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      })
      if (!('data' in res)) return res
      const errs = res.data.json?.errors ?? []
      if (errs.length > 0) {
        const first = errs[0] ?? []
        const code = String(first[0] ?? '')
        const text = String(first[1] ?? '')
        /*
         * `SUBREDDIT_NOTALLOWED` / `USER_REQUIRED_SUBREDDIT_RULE` 这一族说的是
         * **版规不让**，与"太快了"是两件事：前者要人去看那个版的规矩再决定，
         * 后者等一会儿就好。混成一句"发失败"的话，人只会反复重试。
         */
        if (code === 'RATELIMIT')
          return { ok: false, reason: 'rate_limited', message: `${LABEL} 说太快了：${text}` }
        return {
          ok: false,
          reason: 'upstream_error',
          message: `r/${subOf(input.subreddit)} 没收下这一条（${code}${text === '' ? '' : `：${text}`}）。多半是版规不让——去看一眼那个版的规矩，别直接重试。`,
        }
      }
      const made = res.data.json?.data ?? {}
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          external_id: made.name ?? '',
          ...(made.url === undefined ? {} : { url: made.url }),
        },
      }
    },
  }
}

/**
 * **批准之后**才调的那一跳（与 56 的 `executeApprovedBrowserAction` 同一条纪律）。
 *
 * `approval_id` 只是一道形状上的闸（空串直接拒），真正的判定在变更账本那一侧——
 * 这个包不认识审批，也不该认识。
 */
export async function submitApprovedPost(
  adapter: PrRedditAdapter,
  input: {
    subreddit: string
    title: string
    body: string
    flair_id?: string
  },
  context: { approval_id: string },
): Promise<SocialResult<{ external_id: string; url?: string }>> {
  return adapter.submitToSubreddit({ ...input, approval_id: context.approval_id })
}
