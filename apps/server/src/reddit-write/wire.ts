/**
 * WP329：把 Reddit 写接到三条已有的路上（`server.ts` 只调这里，自己不写判断）：
 *
 * 1. 社媒回帖卡（WP254 `social_reply`）：Reddit 那一条改走插件（{@link socialRedditFill}）；
 * 2. 公关的外部发帖卡（`community_post`，WP78）：**以前批了也发不出去**（`submitApprovedPost` 没人调），
 *    现在批了交给插件填发帖页（{@link applyExternalPost}）；有 OAuth 应用、插件没连时走 `submitApprovedPost`；
 * 3. 插件用不了时的直发（{@link redditDirectWriter}）：OAuth 应用 → 官方号浏览器（WP249 留作备用）。
 *
 * 写有了结局之后按来源回写（{@link settleRedditWrite}）：社媒线程标已回、公关帖标已发 / 留着草稿。
 */
import type { RedditWrite } from '@agentsws/browser-action'
import type {
  ApprovalItem,
  CommunityThread,
  ExternalPost,
  OutboundRecordInput,
  StagedChange,
} from '@agentsws/contracts'
import { type PrRedditAdapter, submitApprovedPost } from '@agentsws/pr-core'
import { redditFullname, type SocialChannelAdapter } from '@agentsws/social-core'
import type {
  RedditDirectResult,
  RedditDirectWrite,
  RedditWriteEntry,
  RedditWriteResult,
  RedditWriteService,
} from './service.js'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const subOf = (s: string): string =>
  s
    .replace(/^\/?r\//u, '')
    .replace(/^\//u, '')
    .trim()

/** 社媒线程 → 一次写（评论没有链接就回 `undefined`：退回原来的出口）。 */
export function writeOfThread(thread: CommunityThread): RedditWrite | undefined {
  if (thread.surface === 'dm') return undefined
  if (thread.surface === 'comment') {
    if (thread.permalink === undefined) return undefined
    return {
      kind: 'reply',
      parent: redditFullname(thread.external_id, 't1'),
      permalink: thread.permalink,
    }
  }
  return {
    kind: 'comment',
    post: redditFullname(thread.external_id, 't3'),
    ...(thread.permalink === undefined ? {} : { permalink: thread.permalink }),
  }
}

/** 社媒执行器的 `redditFill`。 */
export function socialRedditFill(writes: () => RedditWriteService | undefined) {
  return async (input: {
    item: ApprovalItem
    thread: CommunityThread
    account_external_id: string
    text: string
    record: OutboundRecordInput
  }): Promise<RedditWriteResult | undefined> => {
    const svc = writes()
    if (svc === undefined) return undefined
    const write = writeOfThread(input.thread)
    if (write === undefined) return undefined
    return svc.send({
      approval_item_id: input.item.id,
      write,
      text: input.text,
      subreddit: input.account_external_id,
      record: {
        ...input.record,
        action: write.kind === 'reply' ? 'reply' : 'comment',
        destination: `r/${subOf(input.account_external_id)}`,
      },
      source: { type: 'community_thread', id: input.thread.id },
      label: input.item.title,
    })
  }
}

/** 插件用不了时的直发：OAuth 应用 → 官方号浏览器；两条都不通回 `undefined`。 */
export function redditDirectWriter(input: {
  /** 社媒那一条 Reddit 出口（WP249 的混合出口：接口优先、官方号浏览器兜底）。 */
  adapter: () => SocialChannelAdapter | undefined
  /** 公关那一份（`submitApprovedPost` 要它；只有 OAuth 应用连着才有）。 */
  prAdapter: () => PrRedditAdapter | undefined
  apiConnected: () => boolean
  officialReady: () => boolean
}) {
  return async (w: RedditDirectWrite): Promise<RedditDirectResult | undefined> => {
    const api = input.apiConnected()
    if (!api && !input.officialReady()) return undefined
    const adapter = input.adapter()
    if (w.write.kind === 'submit') {
      // 在别人的版里发帖：有 OAuth 应用就走 `submitApprovedPost`（带一张批过的卡才发）
      const pr = api ? input.prAdapter() : undefined
      if (pr !== undefined) {
        const r = await submitApprovedPost(
          pr,
          { subreddit: w.write.subreddit, title: w.write.title, body: w.text },
          { approval_id: w.approval_id },
        )
        return r.ok
          ? {
              ok: true,
              external_id: r.data.external_id,
              ...(r.data.url === undefined ? {} : { url: r.data.url }),
            }
          : { ok: false, message: r.message }
      }
      if (adapter?.publish === undefined) return undefined
      const r = await adapter.publish({
        account_external_id: w.write.subreddit,
        body: `${w.write.title}\n${w.text}`,
      } as Parameters<NonNullable<SocialChannelAdapter['publish']>>[0])
      return r.ok
        ? {
            ok: true,
            external_id: r.data.external_id,
            ...(r.data.url === undefined ? {} : { url: r.data.url }),
          }
        : { ok: false, message: r.message }
    }
    if (adapter?.reply === undefined) return undefined
    const parent = w.write.kind === 'reply' ? w.write.parent : w.write.post
    const sub =
      w.write.kind === 'reply' ? (w.write.permalink.match(/^\/r\/([^/]+)\//u)?.[1] ?? '') : ''
    const r = await adapter.reply({
      parent_external_id: parent,
      text: w.text,
      account_external_id: sub,
    })
    return r.ok ? { ok: true, external_id: r.data.external_id } : { ok: false, message: r.message }
  }
}

/** 公关外部发帖卡批了（`backendApply`）：Reddit 那一条交出去；别的平台 / 别的卡回 `undefined`。 */
export async function applyExternalPost(
  change: StagedChange,
  deps: {
    writes: RedditWriteService | undefined
    post(id: string): ExternalPost | undefined
    approverName?(person_id: string): Promise<string | undefined>
  },
): Promise<RedditWriteResult | undefined> {
  if (change.kind !== 'community_post' || change.target.type !== 'external_post') return undefined
  const after = isRecord(change.after) ? change.after : {}
  if (str(after.platform)?.toLowerCase() !== 'reddit') return undefined
  const svc = deps.writes
  if (svc === undefined) return undefined
  const post = deps.post(change.target.id)
  if (post === undefined)
    return {
      status: 'failed',
      error: { message: '这条外部帖子已经不在库里了，没发。', retryable: false },
    }
  const approval_id = change.approval?.item_id
  if (approval_id === undefined)
    return { status: 'failed', error: { message: '没有批过的卡，不发。', retryable: false } }
  const sub = subOf(post.venue)
  const body = str(after.body) ?? post.body
  let write: RedditWrite
  let title: string | undefined
  if (post.parent_external_id !== undefined) {
    // 回帖子（顶层评论）；回评论要那条评论的链接，公关这张卡上没有
    if (!post.parent_external_id.startsWith('t3_') && /^t1_/u.test(post.parent_external_id))
      return {
        status: 'failed',
        error: {
          message:
            '这张卡回的是一条评论，但卡上没有那条评论的链接，插件找不到回复框。从待处理里重新起草一张。',
          retryable: false,
        },
      }
    write = { kind: 'comment', post: redditFullname(post.parent_external_id, 't3') }
  } else {
    // 卡上没单独写标题：第一行当标题、其余当正文（与社媒发帖那一侧同一个拆法）
    const lines = body.split('\n')
    title = (post.title ?? lines[0] ?? '').trim()
    write = { kind: 'submit', subreddit: sub, title }
  }
  const text =
    write.kind === 'submit' && post.title === undefined
      ? body.split('\n').slice(1).join('\n').trim() || body
      : body
  const by = change.approval?.by
  const approved_by =
    by === undefined
      ? undefined
      : by === 'mandate'
        ? '自动'
        : ((await deps.approverName?.(by)) ?? by)
  return svc.send({
    approval_item_id: approval_id,
    write,
    text,
    ...(title === undefined ? {} : { title }),
    subreddit: sub,
    record: {
      source_key: `change:${change.id}`,
      channel: 'reddit',
      action: write.kind === 'submit' ? 'post' : 'comment',
      kind: change.kind,
      destination: `r/${sub}`,
      ...(title === undefined ? {} : { subject: title }),
      content: text,
      ...(post.parent_external_id === undefined
        ? {}
        : { parent_external_id: post.parent_external_id }),
      change_id: change.id,
      approval_item_id: approval_id,
      role_id: change.role_id,
      ...(approved_by === undefined ? {} : { approved_by }),
      ...(change.approval?.at === undefined ? {} : { approved_at: change.approval.at }),
    } as OutboundRecordInput,
    source: { type: 'external_post', id: post.id },
    label: `外部发帖：r/${sub}`,
  })
}

/** 一条写有了结局：按来源回写（社媒线程 / 公关帖）。WP328 的条目由它自己的钩子接。 */
export function settleRedditWrite(
  entry: RedditWriteEntry,
  deps: {
    thread?(id: string): CommunityThread | undefined
    saveThread?(row: CommunityThread): void
    post?(id: string): ExternalPost | undefined
    savePost?(row: ExternalPost): void
    /** WP328：待处理条目回过了（挂上发出记录那一行）。 */
    setWatchStatus?(id: string, record_id: string | undefined): void
    emit(type: string, payload: Record<string, unknown>): void
    now(): string
  },
): void {
  const src = entry.source
  if (src === undefined) return
  if (src.type === 'reddit_watch_item') {
    // 没发出去：条目留在「起草中」，人能在卡片流 / 待处理里再来
    if (entry.state === 'sent') deps.setWatchStatus?.(src.id, entry.record_id)
    return
  }
  if (src.type === 'community_thread') {
    const thread = deps.thread?.(src.id)
    if (thread === undefined) return
    if (entry.state === 'sent') {
      deps.saveThread?.({
        ...thread,
        status: 'answered',
        ...(entry.fullname === undefined ? {} : { reply_external_id: entry.fullname }),
      })
      deps.emit('social.reply_sent', {
        approval_item_id: entry.approval_item_id,
        thread_id: thread.id,
        channel: thread.channel,
      })
    } else
      deps.emit('social.reply_failed', {
        approval_item_id: entry.approval_item_id,
        thread_id: thread.id,
        channel: thread.channel,
      })
    return
  }
  if (src.type === 'external_post' && entry.state === 'sent') {
    const post = deps.post?.(src.id)
    if (post === undefined) return
    deps.savePost?.({
      ...post,
      status: 'published',
      published_at: entry.finished_at ?? deps.now(),
      ...(entry.fullname === undefined ? {} : { external_id: entry.fullname }),
      ...(entry.link === undefined ? {} : { url: entry.link }),
    })
  }
}
