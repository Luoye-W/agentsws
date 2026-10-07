/**
 * WP249（决策 89）：Reddit 的**出口**——「官方接口优先、官方号浏览器兜底」。
 *
 * 连接里有 OAuth 凭据（用户自己申请过开发者应用）就走 {@link createRedditAdapter} 那一套；
 * 没有就走「Reddit 官方号浏览器通道」（用户在工作台起的独立浏览器里自己登录过的那个会话）。
 * 两条都不通就照实说怎么接上，不假装发出去了。
 *
 * 这一层不碰审批：发帖 / 回帖 / 置顶 / 版务动作的调用方都是**卡被批准之后的执行器**
 * （`types.ts` 文件头第 4 条）。浏览器那一侧再加一道：执行器只执行卡上那一个动作，
 * 驱动层白名单拦其余点击（`reddit-browser.ts`）。
 */

import { REDDIT_JOIN_REQUESTS_UNSUPPORTED, redditFullname } from './reddit.js'
import type { RedditBrowserWrite } from './reddit-browser.js'
import type {
  BroadcastInput,
  ModerateInput,
  ModQueueEntry,
  ModQueueSource,
  PublishInput,
  ReplyInput,
  SocialChannelAdapter,
  SocialError,
  SocialResult,
  SocialTransport,
} from './types.js'

/** 浏览器那一侧做完一个动作回来的三种结果（与 Facebook 群组那条执行器同一个分法）。 */
export type RedditBrowserRunResult =
  | { status: 'ok'; fullname?: string; url?: string }
  /** 要人去「登录官方号」窗口里处理（登录掉了 / 验证码 / 被拦）。 */
  | { status: 'handover'; message: string }
  | { status: 'failed'; message: string }

export type RedditBrowserReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'limited' | 'blocked' | 'login' | 'failed'; message: string }

/**
 * 「Reddit 官方号浏览器通道」在这个包里的形状。真的那一个在服务进程里
 * （`apps/server/src/reddit-official-browser/`）；测试里塞一个假的。
 */
export interface RedditOfficialBrowserPort {
  /** 上次体检看到已登录（没体检过 / 没登录 = 假）。 */
  ready(): boolean
  readModQueue(
    sub: string,
    source: 'modqueue' | 'unmoderated',
    limit: number,
  ): Promise<RedditBrowserReadResult<ModQueueEntry[]>>
  readRules(sub: string): Promise<RedditBrowserReadResult<string[]>>
  /** 执行**审批过的**那一个动作。 */
  run(write: RedditBrowserWrite): Promise<RedditBrowserRunResult>
}

/** 两条都没接上时那一句。 */
export const REDDIT_NOT_CONNECTED_MESSAGE =
  'Reddit 还没接上：去连接页点「登录官方号」，在弹出的浏览器里登录你们的官方号（或填已有的 OAuth 开发者应用）。'

const notConnected = (): SocialError => ({
  ok: false,
  reason: 'not_connected',
  message: REDDIT_NOT_CONNECTED_MESSAGE,
})

const subOf = (value: string): string => value.replace(/^\/?r\//u, '').replace(/^\//u, '')

function readFailure(r: { reason: string; message: string }): SocialError {
  return {
    ok: false,
    reason:
      r.reason === 'limited'
        ? 'rate_limited'
        : r.reason === 'login'
          ? 'not_connected'
          : 'upstream_error',
    message: r.message,
  }
}

function runFailure(r: { status: 'handover' | 'failed'; message: string }): SocialError {
  return {
    ok: false,
    reason: 'upstream_error',
    message:
      r.status === 'handover'
        ? `${r.message} 去「登录官方号」那个浏览器窗口里手动处理一下，这一条没做成。`
        : r.message,
  }
}

/**
 * 把 OAuth 适配器与官方号浏览器拼成一个适配器。`apiConnected` 回答「连接里有没有 OAuth 凭据」。
 */
export function createRedditHybridAdapter(input: {
  api: SocialChannelAdapter
  apiConnected: () => boolean
  browser?: RedditOfficialBrowserPort
  transport: Pick<SocialTransport, 'now'>
}): SocialChannelAdapter {
  const { api, browser, transport } = input
  const useApi = (): boolean => input.apiConnected()
  const useBrowser = (): RedditOfficialBrowserPort | undefined =>
    browser?.ready() ? browser : undefined
  const ok = <T>(data: T): SocialResult<T> => ({ ok: true, observed_at: transport.now(), data })

  const run = async (
    write: RedditBrowserWrite,
  ): Promise<SocialResult<{ external_id: string; url?: string }>> => {
    const b = useBrowser()
    if (b === undefined) return notConnected()
    const r = await b.run(write)
    if (r.status !== 'ok') return runFailure(r)
    return ok({ external_id: r.fullname ?? '', ...(r.url === undefined ? {} : { url: r.url }) })
  }

  const split = (body: string): { title: string; text: string } => {
    const [title, ...rest] = body.split('\n')
    return { title: (title ?? body).slice(0, 300), text: rest.join('\n') }
  }

  const adapter: SocialChannelAdapter = {
    channel: 'reddit',
    mode: 'api',
    // 读别的版 / 资料仍走接口（Reddit 取数路线在 WP220 / WP246 那一侧，不经版主号——决策 88）
    ...(api.profile === undefined ? {} : { profile: api.profile.bind(api) }),
    ...(api.posts === undefined ? {} : { posts: api.posts.bind(api) }),
    ...(api.comments === undefined ? {} : { comments: api.comments.bind(api) }),
    ...(api.members === undefined ? {} : { members: api.members.bind(api) }),

    async publish(p: PublishInput) {
      if (useApi() && api.publish !== undefined) return api.publish(p)
      if (p.scheduled_at !== undefined)
        return {
          ok: false,
          reason: 'not_implemented',
          message: 'Reddit 没有排期发布；到点之后由我们的调度器再发这一跳。',
        }
      const { title, text } = split(p.body)
      return run({ kind: 'submit', sub: subOf(p.account_external_id), title, text })
    },

    async reply(r: ReplyInput) {
      if (useApi() && api.reply !== undefined) return api.reply(r)
      const parent = redditFullname(r.parent_external_id, 't3')
      if (!parent.startsWith('t3_'))
        return {
          ok: false,
          reason: 'not_implemented',
          message: '官方号浏览器通道这一版只回帖子（顶层回复），不回评论下面的楼中楼。',
        }
      const res = await run({ kind: 'reply', post_fullname: parent, text: r.text })
      return res.ok ? ok({ external_id: res.data.external_id }) : res
    },

    async broadcast(b: BroadcastInput) {
      if (useApi() && api.broadcast !== undefined) return api.broadcast(b)
      // 与接口那一侧同一个意思：Reddit 上的「群发」= 一条置顶帖
      const { title, text } = split(b.body)
      const res = await run({
        kind: 'submit',
        sub: subOf(b.account_external_id),
        title,
        text,
        sticky: true,
      })
      return res.ok ? ok({ sent: 1, failed: 0 }) : res
    },

    async moderate(m: ModerateInput) {
      if (useApi() && api.moderate !== undefined) return api.moderate(m)
      const sub = subOf(m.account_external_id)
      const queue = m.queue ?? 'modqueue'
      let write: RedditBrowserWrite
      switch (m.action) {
        case 'approve':
          write = {
            kind: 'approve',
            sub,
            fullname: redditFullname(m.target_external_id, 't3'),
            queue,
          }
          break
        case 'delete_post':
          write = {
            kind: 'remove',
            sub,
            fullname: redditFullname(m.target_external_id, 't3'),
            queue,
            ...(m.removal_message === undefined ? {} : { removal_message: m.removal_message }),
          }
          break
        case 'ban':
        case 'permanent_ban':
          write = {
            kind: 'ban',
            sub,
            username: m.target_external_id.replace(/^\/?u\//u, ''),
            ...(m.action === 'ban'
              ? { days: Math.max(1, Math.round((m.duration_minutes ?? 10_080) / 1440)) }
              : {}),
            ...(m.reason === undefined ? {} : { note: m.reason.slice(0, 300) }),
          }
          break
        default:
          return {
            ok: false,
            reason: 'not_implemented',
            message:
              '官方号浏览器通道这一版只做批准 / 移除 / 封禁；别的版务动作请在 Reddit 网页上做。',
          }
      }
      const res = await run(write)
      return res.ok ? ok({ ok: true as const }) : res
    },

    async modQueue(q: { account_external_id: string; source: ModQueueSource; limit?: number }) {
      if (useApi() && api.modQueue !== undefined) return api.modQueue(q)
      const b = useBrowser()
      if (b === undefined) return notConnected()
      if (q.source === 'join_requests')
        return { ok: false, reason: 'not_implemented', message: REDDIT_JOIN_REQUESTS_UNSUPPORTED }
      const r = await b.readModQueue(subOf(q.account_external_id), q.source, q.limit ?? 50)
      return r.ok ? ok(r.data) : readFailure(r)
    },

    async communityRules(account_external_id: string) {
      if (useApi() && api.communityRules !== undefined)
        return api.communityRules(account_external_id)
      const b = useBrowser()
      if (b === undefined) return notConnected()
      const r = await b.readRules(subOf(account_external_id))
      return r.ok ? ok(r.data) : readFailure(r)
    },
  }
  return adapter
}
