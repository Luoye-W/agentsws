/**
 * WP421（自查 general 组 R1，决策 1266–1270）：公关 / 内容与搜索 / 设计这几类卡**批了以后到底做了什么**。
 *
 * 自查发现：这几类卡没有专门的执行器，批了落到内存空桩，一律回「已执行」——新闻稿没发、论坛帖没发、
 * 店里的标题没改、素材没入库，界面上却写着做完了。这里给每一类一个真执行器，做不到的照实回「没做 + 原因」：
 *
 * | 卡 | 批了做什么 | 结果 |
 * |---|---|---|
 * | 新闻稿草稿（`press_release`，没有 `distributed`） | 稿子定稿（状态改「已批」，人改过的正文回写），读回 | 成功 |
 * | 发新闻稿（`press_release`，`distributed: true`） | 分发渠道还没接通：稿子标「已批」，**不标已发** | 没做：请复制全文自己发 |
 * | 外部论坛发帖（`community_post`，不是 Reddit） | 帖子标「已批」 | 没做：论坛发帖还没接自动执行，请自己去发 |
 * | 内容改动（改标题 / 加小节 / 调内链 / 发文章，没走店铺写法的） | 什么都不改 | 没做：还没接通写回店铺 |
 * | 定稿入库（`asset_publish`） | 素材改「已定稿」、需求单交付、回给下单方，读回 | 成功 |
 * | 设计需求单（`design_request`） | 建单时已交给设计岗；这里核一下单还在 | 成功 / 单不在了 |
 *
 * 不是这几类回 `undefined`（掉回原来那条路，一个字节不变）。Reddit 帖子、走店铺写法（`via: shop_admin`）的改动
 * 有各自的执行器，这里不碰。
 */
import type { StagedChange } from '@agentsws/contracts'
import type { BackendResult } from '@agentsws/txn'
import type { DesignServiceAssembly, DesignStore } from './design.js'
import type { PrStore } from './pr.js'

export interface DeskApplyDeps {
  pr?: Pick<PrStore, 'release' | 'saveRelease' | 'post' | 'savePost'>
  design?: Pick<DesignServiceAssembly, 'applyPublish'>
  designStore?: Pick<DesignStore, 'request'>
  now(): string
}

/** 内容与搜索那几种改动卡（`seo-service` 出的）。 */
export const CONTENT_CHANGE_KINDS: readonly string[] = [
  'page_seo_edit',
  'page_section_add',
  'internal_link_edit',
  'publish_post',
]

export const NOT_WIRED = {
  press_distribute:
    '没发出去：新闻稿分发渠道还没接通。稿子已定稿，卡上有全文——复制后自己发给媒体。',
  forum_post: '没发出去：论坛发帖还没接自动执行。帖子已批，复制卡上的正文自己去发。',
  content:
    '店里没改：这一类改动还没接通写回店铺。照卡上的改法到店铺后台自己改一下（改完下次体检会读到）。',
} as const

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined

const notDone = (message: string): BackendResult => ({
  status: 'failed',
  error: { message, retryable: false },
})

export async function deskApply(
  change: Pick<StagedChange, 'id' | 'kind' | 'target' | 'after' | 'workspace_id'>,
  deps: DeskApplyDeps,
): Promise<BackendResult | undefined> {
  const after = rec(change.after)
  if (change.kind === 'press_release' && change.target.type === 'press_release') {
    const release = deps.pr?.release(change.target.id)
    if (release === undefined) return notDone('这篇稿子已经不在库里了。')
    // 人在卡上改过的正文 / 标题回写（不改就照旧）
    const next = {
      ...release,
      headline: str(after.headline) ?? release.headline,
      body: str(after.body) ?? release.body,
      status: 'approved' as const,
      updated_at: deps.now(),
    }
    deps.pr?.saveRelease(next)
    if (after.distributed === true) return notDone(NOT_WIRED.press_distribute)
    const back = deps.pr?.release(release.id)
    return back?.status === 'approved'
      ? { status: 'ok', execution_id: `pr_release_${release.id}`, outcome_ref: change.target }
      : { status: 'unknown', error: { message: '改了，但读回来不是「已批」。', retryable: true } }
  }
  if (change.kind === 'community_post' && change.target.type === 'external_post') {
    if (str(after.platform)?.toLowerCase() === 'reddit') return undefined
    const post = deps.pr?.post(change.target.id)
    if (post === undefined) return notDone('这条帖子已经不在库里了。')
    deps.pr?.savePost({ ...post, body: str(after.body) ?? post.body, status: 'approved' })
    return notDone(NOT_WIRED.forum_post)
  }
  if (CONTENT_CHANGE_KINDS.includes(change.kind) && after.via !== 'shop_admin')
    return notDone(NOT_WIRED.content)
  if (change.kind === 'asset_publish') return deps.design?.applyPublish(change)
  if (change.kind === 'design_request' && change.target.type === 'design_request') {
    const request = deps.designStore?.request(change.target.id)
    return request === undefined
      ? notDone('这张需求单已经不在了。')
      : { status: 'ok', execution_id: `design_request_${request.id}`, outcome_ref: change.target }
  }
  return undefined
}
