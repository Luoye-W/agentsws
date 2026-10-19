/**
 * WP419（自查 R10 / S3 / S2 / S4，决策 1231）：社媒发帖与 Reddit 起草的四个工具的执行器
 * （名字 / 描述 / 参数在 `@agentsws/stand-ins` 的 `runtime/social-tools.ts`）。
 *
 * - `list_reddit_pending`：巡查里等着回的（还没出卡 / 卡已出 / 和以前说的矛盾）+ 起草卡在哪一步那一句；
 * - `stage_reddit_write`：回巡查里的某一条（读整串、已回过不起草、口吻没定先出口吻卡）或发新帖（必须带用户的要点）；
 * - `list_social_posts`：这条渠道登记了哪些号、往后几天排了什么；
 * - `stage_social_post`：起草一条、排个时间，出「发布」卡（永远 L1；撞车写在卡上）。IG / TikTok / YouTube 必须带素材。
 *
 * 只出卡、不发：发不发永远人点。
 */

import type { SocialPort } from '@agentsws/api'
import {
  type RedditWatchEntry,
  redditTargetFromItem,
  SOCIAL_CHANNELS,
  type SocialChannel,
  type SocialPostKind,
} from '@agentsws/contracts'
import {
  isRedditWorkRole,
  isSocialPostRole,
  LIST_REDDIT_PENDING_TOOL,
  LIST_SOCIAL_POSTS_TOOL,
  type RedditPendingData,
  type RedditPendingRow,
  type SocialPostsData,
  STAGE_REDDIT_WRITE_TOOL,
  STAGE_SOCIAL_POST_TOOL,
  type StagedData,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { RedditWatchAssembly } from './reddit-watch/service.js'
import type { RedditWriteService } from './reddit-write/service.js'

type Actor = { workspace_id: string; person_id: string; assignment_id: string; role_id: string }

export interface SocialToolsOptions {
  /** 这个品牌的 Reddit 巡查 / 写（没装配回 `undefined`）。 */
  redditWatch(): RedditWatchAssembly | undefined
  redditWrites(): RedditWriteService | undefined
  /** 社媒那一份（发帖、日历、登记的号）。 */
  social(): SocialPort | undefined
  /** 起草卡在哪一步那一句（和侧边栏同一句；没卡住回 `undefined`）。 */
  stageLine?(): Promise<string | undefined>
  /** 口吻没定：出那张「品牌号怎么说话」卡（一天最多一次由它自己管）。 */
  askPersona?(actor: Actor): Promise<void>
  now(): string
}

/** 这几条渠道的帖子必须带图片或视频（纯文字发不出去）。 */
export const MEDIA_REQUIRED: ReadonlySet<string> = new Set(['instagram', 'tiktok', 'youtube'])
const MEDIA_KINDS: ReadonlySet<string> = new Set([
  'image',
  'video',
  'reel',
  'carousel',
  'short',
  'story',
])
const KINDS: readonly SocialPostKind[] = [
  'post',
  'image',
  'video',
  'reel',
  'carousel',
  'short',
  'story',
  'thread',
]

const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const num = (v: unknown, dflt: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(max, Math.floor(v))) : dflt

/** 这条职责发到哪几条渠道（`social.meta` 老职责 = FB + IG）。 */
export function channelsOfRole(role_id: string): SocialChannel[] {
  const spec = SOCIAL_CHANNELS.find((c) => c.role_id === role_id)
  if (spec === undefined) return []
  return spec.superseded_by === undefined ? [spec.id] : [spec.id, ...spec.superseded_by]
}

const link = (path: string | undefined): string | undefined =>
  path === undefined
    ? undefined
    : /^https?:/iu.test(path)
      ? path
      : `https://www.reddit.com${path.startsWith('/') ? '' : '/'}${path}`

/** 巡查条目 → 给模型看的那一行（外部原文截短）。 */
export function pendingRowOf(it: RedditWatchEntry): RedditPendingRow {
  const state: RedditPendingRow['state'] =
    it.status === 'drafting' ? 'card_out' : it.conflict !== undefined ? 'conflict' : 'waiting'
  const url = link(it.url)
  return {
    item_id: it.id,
    source: it.source,
    ...(it.subreddit === undefined ? {} : { subreddit: it.subreddit }),
    ...(it.author === undefined ? {} : { author: it.author }),
    text: (it.title === undefined ? it.text : `${it.title}\n${it.text}`).slice(0, 300),
    ...(url === undefined ? {} : { link: url }),
    at: it.created_at,
    state,
    ...(it.note === undefined ? {} : { note: it.note }),
  }
}

export function createSocialToolExecutor(options: SocialToolsOptions): ToolExecutor {
  const listPending = async (input: Record<string, unknown>) => {
    const rw = options.redditWatch()
    if (rw === undefined) return { status: 'error' as const, reason: '这个品牌没装 Reddit 巡查。' }
    const want = str(input.state) ?? 'all'
    const all = rw
      .items({ reply: true, limit: 300 })
      .filter((x) => (x.status === 'open' || x.status === 'drafting') && x.dup_of === undefined)
      .map(pendingRowOf)
    const counts = {
      waiting: all.filter((r) => r.state === 'waiting').length,
      card_out: all.filter((r) => r.state === 'card_out').length,
      conflict: all.filter((r) => r.state === 'conflict').length,
    }
    const rows = all
      .filter((r) => want === 'all' || r.state === want)
      .slice(0, num(input.limit, 20, 50))
    const stage = await options.stageLine?.().catch(() => undefined)
    const data: RedditPendingData = { rows, counts, ...(stage === undefined ? {} : { stage }) }
    return { status: 'ok' as const, data }
  }

  const stageReddit = async (actor: Actor, input: Record<string, unknown>) => {
    const writes = options.redditWrites()
    if (writes === undefined)
      return { status: 'error' as const, reason: '这个品牌没装 Reddit 写。' }
    const mode = str(input.mode)
    const reason = str(input.reason)
    if (mode === 'reply') {
      const rw = options.redditWatch()
      const id = str(input.item_id)
      const entry =
        id === undefined ? undefined : rw?.items({ limit: 500 }).find((x) => x.id === id)
      if (rw === undefined || entry === undefined)
        return {
          status: 'ok' as const,
          data: {
            staged: false,
            message: '巡查里没有这一条（先用 list_reddit_pending 看 item_id）',
          },
        }
      if (entry.status === 'drafting')
        return {
          status: 'ok' as const,
          data: { staged: false, message: '这一条的卡已经出了，在「要你处理」里等你批。' },
        }
      const target = redditTargetFromItem(entry)
      if (target === undefined)
        return {
          status: 'ok' as const,
          data: { staged: false, message: '认不出这一条回到哪（没有链接），没出卡。' },
        }
      const thread = rw.thread(entry.id)
      const got = await writes.draftAndStage(actor as never, {
        target,
        ...(reason !== undefined
          ? { reason }
          : entry.judgement?.reason === undefined
            ? {}
            : { reason: entry.judgement.reason }),
        ...(thread === undefined ? {} : { thread }),
      })
      if (!got.staged && got.skipped === 'needs_persona')
        await options.askPersona?.(actor).catch(() => undefined)
      if (!got.staged && got.skipped === 'already_replied')
        rw.setStatus(entry.id, 'done', { note: got.message, replied_before: true })
      // 决策 1199：和品牌号说过的矛盾 → 不出卡，条目留在待处理「要你看」
      if (!got.staged && got.skipped === 'contradiction')
        rw.setStatus(entry.id, 'open', {
          note: got.message,
          ...(got.conflict === undefined ? {} : { conflict: got.conflict }),
        })
      const data: StagedData = got.staged
        ? { staged: true, approval_item_id: got.approval_item_id }
        : { staged: false, message: got.message }
      return { status: 'ok' as const, data }
    }
    if (mode === 'post') {
      const points = str(input.points)
      if (points === undefined)
        return {
          status: 'ok' as const,
          data: {
            staged: false,
            message: '发新帖要用户自己说要点（points）：先问一句要讲什么，不要替他编。',
          },
        }
      const sub =
        str(input.subreddit)?.replace(/^\/?r\//iu, '') ??
        options.redditWatch()?.settings().own_subreddits[0]
      if (sub === undefined)
        return {
          status: 'ok' as const,
          data: {
            staged: false,
            message: '没说发到哪个版，巡查设置里也没有自家版块：问一句发到哪。',
          },
        }
      const target = { kind: 'submit' as const, subreddit: sub }
      let text = str(input.text)
      let title = str(input.title)
      if (text === undefined || title === undefined) {
        const draft = await writes
          .draft(actor as never, { target, instruction: points })
          .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
        if ('error' in draft)
          return { status: 'ok' as const, data: { staged: false, message: draft.error } }
        // 没接模型时起草那一步只给开头（发新帖是空的）：正文先放你说的要点原话，人在卡上改
        text ??= draft.text.trim() === '' ? points : draft.text
        title ??= draft.title
      }
      // 标题没起出来：用要点的第一句（人在卡上改）
      title ??=
        points
          .split(/[。.!?！？\n]/u)[0]
          ?.trim()
          .slice(0, 120) || points.slice(0, 120)
      const got = await writes.stage(actor as never, {
        target,
        text: text ?? '',
        title,
        reason: reason ?? `你说的要点：${points.slice(0, 200)}`,
      })
      const data: StagedData = got.staged
        ? { staged: true, approval_item_id: got.approval_item_id }
        : { staged: false, message: got.message }
      return { status: 'ok' as const, data }
    }
    return { status: 'error' as const, reason: 'mode 要是 reply 或 post。' }
  }

  const listPosts = async (actor: Actor, input: Record<string, unknown>) => {
    const port = options.social()
    if (port === undefined) return { status: 'error' as const, reason: '这个品牌没装社媒。' }
    const channels = channelsOfRole(actor.role_id)
    const accounts = (
      await Promise.all(
        channels.map(async (channel) => (await port.accounts(actor as never, { channel })).rows),
      )
    ).flat()
    const from = options.now()
    const to = new Date(Date.parse(from) + num(input.days, 14, 31) * 86_400_000).toISOString()
    const cal = await port.calendar(actor as never, { from, to })
    const data: SocialPostsData = {
      accounts: accounts.map((a) => ({
        account_id: a.id,
        name: a.display_name || a.handle || a.id,
        channel: a.channel,
      })),
      posts: cal.cells
        .filter((c) => channels.includes(c.channel))
        .map((c) => ({
          post_id: c.post_id,
          account_name: c.account_name,
          kind: c.kind,
          status: c.status,
          scheduled_at: c.scheduled_at,
          preview: c.preview,
          conflicts: c.conflicts,
        })),
      ...(accounts.length === 0
        ? {
            note: '这条渠道还没登记要发帖的号：先在连接里连上（插件用你自己浏览器的登录态，不用开发者应用），连上会自动登记。',
          }
        : {}),
    }
    return { status: 'ok' as const, data }
  }

  const stagePost = async (actor: Actor, input: Record<string, unknown>) => {
    const port = options.social()
    if (port === undefined) return { status: 'error' as const, reason: '这个品牌没装社媒。' }
    const body = str(input.body)
    if (body === undefined)
      return { status: 'ok' as const, data: { staged: false, message: '正文是空的，没出卡。' } }
    const channels = channelsOfRole(actor.role_id)
    const accounts = (
      await Promise.all(
        channels.map(async (channel) => (await port.accounts(actor as never, { channel })).rows),
      )
    ).flat()
    const wanted = str(input.account_id)
    const account =
      wanted === undefined
        ? accounts.length === 1
          ? accounts[0]
          : undefined
        : accounts.find((a) => a.id === wanted)
    if (account === undefined)
      return {
        status: 'ok' as const,
        data: {
          staged: false,
          message:
            accounts.length === 0
              ? '这条渠道还没登记要发帖的号：先在连接里连上，连上会自动登记。'
              : `有 ${accounts.length} 个号，要说发到哪一个（account_id）：${accounts.map((a) => `${a.display_name || a.handle}（${a.id}）`).join('、')}`,
        },
      }
    const media = Array.isArray(input.media_refs)
      ? input.media_refs
          .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
          .slice(0, 10)
      : []
    const rawKind = str(input.kind)
    const kind: SocialPostKind =
      rawKind !== undefined && (KINDS as readonly string[]).includes(rawKind)
        ? (rawKind as SocialPostKind)
        : media.length > 0
          ? 'image'
          : 'post'
    // 自查 S4：IG / TikTok / YouTube 纯文字发不出去；图片 / 视频形态必须带素材
    if (media.length === 0 && (MEDIA_REQUIRED.has(account.channel) || MEDIA_KINDS.has(kind)))
      return {
        status: 'ok' as const,
        data: {
          staged: false,
          message: `${account.channel === 'instagram' ? 'Instagram' : account.channel === 'tiktok' ? 'TikTok' : account.channel === 'youtube' ? 'YouTube' : '这种形态'}的帖子要带图片或视频：先问用户要素材（或从素材库里挑），再出卡。`,
        },
      }
    const scheduled = str(input.scheduled_at)
    if (scheduled !== undefined && Number.isNaN(Date.parse(scheduled)))
      return {
        status: 'ok' as const,
        data: { staged: false, message: '排期时间认不出（要 ISO 时间）。' },
      }
    const view = await port.createPost(actor as never, {
      account_id: account.id,
      kind,
      body,
      ...(scheduled === undefined ? {} : { scheduled_at: new Date(scheduled).toISOString() }),
      ...(media.length === 0 ? {} : { media_refs: media }),
    })
    const data: StagedData = {
      staged: view.staged.staged,
      ...(view.staged.approval_item_id === undefined
        ? {}
        : { approval_item_id: view.staged.approval_item_id }),
      ...(view.staged.message === undefined ? {} : { message: view.staged.message }),
      ...(view.conflicts.length === 0 ? {} : { conflicts: view.conflicts }),
      ...(view.next_free_slot === undefined ? {} : { next_free_slot: view.next_free_slot }),
      ...(view.post.scheduled_at === undefined ? {} : { scheduled_at: view.post.scheduled_at }),
    }
    return { status: 'ok' as const, data }
  }

  return async (call) => {
    const name = bare(call.name)
    const req = call.request
    const actor: Actor = {
      workspace_id: req.workspace_id,
      person_id: req.actor.person_id,
      assignment_id: req.actor.assignment_id,
      role_id: req.actor.role_id,
    }
    const input = call.input as Record<string, unknown>
    if (name === LIST_REDDIT_PENDING_TOOL || name === STAGE_REDDIT_WRITE_TOOL) {
      if (!isRedditWorkRole(actor.role_id))
        return { status: 'blocked', reason: '只给 Reddit 运营 / 外部版块。' }
      return name === LIST_REDDIT_PENDING_TOOL ? listPending(input) : stageReddit(actor, input)
    }
    if (name === LIST_SOCIAL_POSTS_TOOL || name === STAGE_SOCIAL_POST_TOOL) {
      if (!isSocialPostRole(actor.role_id))
        return { status: 'blocked', reason: '只给社媒内容账号那几条职责。' }
      return name === LIST_SOCIAL_POSTS_TOOL ? listPosts(actor, input) : stagePost(actor, input)
    }
    return { status: 'error', reason: `unsupported_tool：${call.name}` }
  }
}
