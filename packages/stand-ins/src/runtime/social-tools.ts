/**
 * WP419（自查 R10 / S3 / S13–S14，决策 1231）：社媒运营与 Reddit 的**干活工具**——给模型看的名字、描述、参数，
 * 回来的数据形状，以及 stub 运行时那一段剧本。真正干活在服务端（`apps/server/src/social-tools.ts`）。
 *
 * | 工具 | 谁有 | 干什么 |
 * |---|---|---|
 * | `list_reddit_pending` | Reddit 运营 / 外部版块 | 巡查读到、等着回的那几条（原文、链接、卡出了没有、为什么没起草） |
 * | `stage_reddit_write` | Reddit 运营 / 外部版块 | 起草并出一张「发出去」卡：回巡查里的某一条，或在某个版发一条新帖（**必须带用户给的要点**） |
 * | `list_social_posts` | 社媒内容账号那几条 | 内容日历上已排的帖子 + 登记了哪些号（排下周之前先看一眼，撞车自己避开） |
 * | `stage_social_post` | 社媒内容账号那几条 | 起草一条帖子、排个时间，出「发布」卡（永远 L1；撞车写在卡上；图片 / 视频帖带素材） |
 *
 * 纪律：只出卡，不发；发不发永远人点（Reddit 由人在页面上点发送，社媒发帖由插件在你登录着的后台里填好、人点发布）。
 */
import type { RunRequest, ToolDef } from '@agentsws/contracts'

export const LIST_REDDIT_PENDING_TOOL = 'list_reddit_pending'
export const STAGE_REDDIT_WRITE_TOOL = 'stage_reddit_write'
export const LIST_SOCIAL_POSTS_TOOL = 'list_social_posts'
export const STAGE_SOCIAL_POST_TOOL = 'stage_social_post'

/** Reddit 那两个。 */
export const REDDIT_WORK_TOOL_NAMES: readonly string[] = [
  LIST_REDDIT_PENDING_TOOL,
  STAGE_REDDIT_WRITE_TOOL,
]
/** 社媒发帖那两个。 */
export const SOCIAL_POST_TOOL_NAMES: readonly string[] = [
  LIST_SOCIAL_POSTS_TOOL,
  STAGE_SOCIAL_POST_TOOL,
]
/** 四个（排好序：`tools.allow` 要字节稳定）。 */
export const SOCIAL_WORK_TOOL_NAMES: readonly string[] = [
  ...REDDIT_WORK_TOOL_NAMES,
  ...SOCIAL_POST_TOOL_NAMES,
].sort()

/** 担 Reddit 的那两条职责（官方版块 / 外部版块）。 */
export function isRedditWorkRole(role_id: string): boolean {
  return role_id === 'social.reddit' || role_id === 'pr.reddit'
}

/** 社媒内容账号那几条（发帖 / 排期）。社群组（Discord 等）走群发，不在这里。 */
export const SOCIAL_POST_ROLES: readonly string[] = [
  'social.facebook',
  'social.instagram',
  'social.meta',
  'social.threads',
  'social.linkedin',
  'social.tiktok',
  'social.x',
  'social.youtube',
]
export function isSocialPostRole(role_id: string): boolean {
  return SOCIAL_POST_ROLES.includes(role_id)
}

/** 这条职责摆哪几个（没有回空）。 */
export function socialWorkToolsFor(role_id: string): readonly string[] {
  if (isRedditWorkRole(role_id)) return REDDIT_WORK_TOOL_NAMES
  if (isSocialPostRole(role_id)) return SOCIAL_POST_TOOL_NAMES
  return []
}

export const SOCIAL_WORK_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: LIST_REDDIT_PENDING_TOOL,
    description:
      '列 Reddit 巡查读到、等着我们回的那几条（收件箱的回复 / @、自家版块和外部关键词里判成要回的）：原文、作者、版块、链接、' +
      'state（waiting 还没出卡 / card_out 卡已经出了等人批 / conflict 草稿和品牌号以前说的矛盾、没出卡要人看）、note（为什么没起草）。' +
      '用户问「有哪些评论等着回」「群里有哪些帖子要处理」「有哪些问题值得答」时先调它；要给某一条出回复卡就把 item_id 交给 stage_reddit_write。' +
      '只读；没读到就照实说没有，不要编。',
    input_schema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['waiting', 'card_out', 'conflict', 'all'],
          description: '只要哪一种（不给 = all）',
        },
        limit: { type: 'integer', description: '最多几条（默认 20，最多 50）' },
      },
    },
  },
  {
    name: STAGE_REDDIT_WRITE_TOOL,
    description:
      '起草一条 Reddit 回复 / 新帖并出一张「发出去」卡（只出卡、不发：批了以后插件在用户的 Chrome 里填好，人自己点发送）。' +
      'mode=reply：回巡查里的某一条（item_id 来自 list_reddit_pending；起草前读整串、品牌号已回过的不起草、口吻没定先要人定）。' +
      'mode=post：在某个版发一条新帖——points 必须是用户自己说的要点（用户没给要点就先问，不要替他编）；' +
      '可以带你写好的 title 和 text（不带就按要点起草一份）；价格、时效、参数只写事实卡里有的。' +
      // WP468（决策 1510）：新版 Reddit 的评论框是富文本，Markdown 记号会照原样发出去
      '自己写 title / text 时写纯文字：不写 Markdown 记号（**、[字](链接)、# 标题），链接直接写完整网址，分段用空行。' +
      '卡上会带这个版的版规原文；禁不禁推广由人看了原文自己判。',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['reply', 'post'],
          description: 'reply 回一条 / post 发新帖',
        },
        item_id: {
          type: 'string',
          description: 'mode=reply：list_reddit_pending 里那一条的 item_id',
        },
        subreddit: {
          type: 'string',
          description: 'mode=post：发到哪个版（不带 r/；不给 = 巡查设置里的第一个自家版块）',
        },
        points: { type: 'string', description: 'mode=post：用户给的要点（原话）' },
        title: { type: 'string', description: 'mode=post：标题（不给就按要点起一个）' },
        text: {
          type: 'string',
          description:
            '你写好的正文（纯文字，不写 Markdown；链接写完整网址；不给就由起草那一步写）',
        },
        reason: { type: 'string', description: '为什么要回 / 发（写在卡上给人看）' },
      },
      required: ['mode'],
    },
  },
  {
    name: LIST_SOCIAL_POSTS_TOOL,
    description:
      '看这条渠道内容日历上已排的帖子（时间、形态、前 60 字、撞车说明）和登记了哪些号（account_id）。' +
      '排下周的内容、起草一条之前先调它：避开已排的时间、别和已排的内容撞车；没登记号就照实告诉用户要先连上并登记。只读。',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: '从今天起往后看几天（默认 14，最多 31）' },
      },
    },
  },
  {
    name: STAGE_SOCIAL_POST_TOOL,
    description:
      '起草一条社媒帖子、排个时间，出一张「发布」卡（永远要人批；撞车会写在卡上并给下一个空档）。' +
      '批了以后到点由插件在用户自己登录着的后台里填好、人点发布（不用开发者应用）。' +
      '排一周就调几次、每次一条。kind 是形态：IG / TikTok / YouTube 的帖子必须带素材（media_refs：素材库里的图片 / 视频 id，' +
      '用户没给素材就先问或先出一条纯文字的草稿说明缺素材）；价格、时效、参数只写事实卡里有的。',
    input_schema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: '正文' },
        scheduled_at: {
          type: 'string',
          description: '排在什么时候发（ISO 时间，带时区；不给 = 批了就发）',
        },
        kind: {
          type: 'string',
          enum: ['post', 'image', 'video', 'reel', 'carousel', 'short', 'story', 'thread'],
          description: '形态（不给 = 有素材按素材定，没有就是 post）',
        },
        media_refs: {
          type: 'array',
          items: { type: 'string' },
          description: '素材 id（素材库里的图片 / 视频）',
        },
        account_id: {
          type: 'string',
          description: '发到哪个号（list_social_posts 里的 account_id；只有一个号时不用给）',
        },
      },
      required: ['body'],
    },
  },
]

export const SOCIAL_WORK_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  SOCIAL_WORK_TOOL_DEFS.map((d) => [d.name, d]),
)

/* ── 回来的数据形状（服务端白名单出参）──────────────────────────────────── */

export interface RedditPendingRow {
  item_id: string
  source: string
  subreddit?: string
  author?: string
  text: string
  link?: string
  at?: string
  state: 'waiting' | 'card_out' | 'conflict'
  note?: string
}
export interface RedditPendingData {
  rows: RedditPendingRow[]
  counts: { waiting: number; card_out: number; conflict: number }
  /** 起草卡在哪一步（等你定口吻 / 没人担…），和侧边栏同一句。 */
  stage?: string
}
export interface StagedData {
  staged: boolean
  approval_item_id?: string
  message?: string
  conflicts?: string[]
  next_free_slot?: string
  scheduled_at?: string
}
export interface SocialPostsData {
  accounts: { account_id: string; name: string; channel: string }[]
  posts: {
    post_id: string
    account_name: string
    kind: string
    status: string
    scheduled_at: string
    preview: string
    conflicts: string[]
  }[]
  /** 没登记号 / 没连上的那一句。 */
  note?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function stagedDataOf(v: unknown): StagedData | undefined {
  return isRecord(v) && typeof v.staged === 'boolean' ? (v as unknown as StagedData) : undefined
}
export function redditPendingDataOf(v: unknown): RedditPendingData | undefined {
  return isRecord(v) && Array.isArray(v.rows) ? (v as unknown as RedditPendingData) : undefined
}
export function socialPostsDataOf(v: unknown): SocialPostsData | undefined {
  return isRecord(v) && Array.isArray(v.posts) ? (v as unknown as SocialPostsData) : undefined
}

/* ── stub 剧本 ───────────────────────────────────────────────────────── */

const PENDING_WORDS =
  /等着回|要处理|值得答|没处理|待回|要回|哪些评论|哪些帖子|哪些问题|pending|waiting|worth answering/iu
const POST_WORDS =
  /发一条|起草一条|置顶|公告|发个帖|发帖|新帖|post|announce|sticky|draft a post|排下周|排一周|排期|plan next week/iu
const WEEK_WORDS = /排下周|排一周|下周的内容|排期|plan next week|next week/iu
const SUB_RE = /(?:^|[\s(（])r\/([A-Za-z0-9_]{2,32})/u

export type SocialWorkStep =
  | { kind: 'reddit_pending' }
  | { kind: 'reddit_post'; input: Record<string, unknown> }
  | { kind: 'social_week' }
  | { kind: 'social_one'; text: string }

/**
 * 演示用剧本：这条职责摆了这几个工具、话里是「有哪些等着回」/「发一条」/「排下周」就走它；别的问法一个字节不变。
 */
export function socialWorkBranch(req: RunRequest, text: string): SocialWorkStep | undefined {
  const allow = req.tools.allow
  if (allow.includes(LIST_REDDIT_PENDING_TOOL) && PENDING_WORDS.test(text))
    return { kind: 'reddit_pending' }
  if (allow.includes(STAGE_REDDIT_WRITE_TOOL) && POST_WORDS.test(text)) {
    const sub = SUB_RE.exec(text)?.[1]
    return {
      kind: 'reddit_post',
      input: {
        mode: 'post',
        points: text.trim().slice(0, 600),
        ...(sub === undefined ? {} : { subreddit: sub }),
      },
    }
  }
  if (allow.includes(STAGE_SOCIAL_POST_TOOL) && WEEK_WORDS.test(text))
    return { kind: 'social_week' }
  if (allow.includes(STAGE_SOCIAL_POST_TOOL) && POST_WORDS.test(text))
    return { kind: 'social_one', text: text.trim() }
  return undefined
}

/** 演示用：下周一、三、五 UTC 02:00（北京上午 10 点）——三条。 */
export function demoWeekSlots(nowIso: string): string[] {
  const now = new Date(nowIso)
  const day = now.getUTCDay()
  const toMonday = (8 - day) % 7 || 7
  return [0, 2, 4].map((d) => {
    const t = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + toMonday + d, 2, 0, 0),
    )
    return t.toISOString()
  })
}

/** 回话：等着回的那几条（短）。 */
export function renderRedditPending(data: RedditPendingData | undefined, failed = ''): string {
  if (data === undefined) return `没读到巡查的待回清单：${failed || '工具没回话'}。`
  const c = data.counts
  if (data.rows.length === 0)
    return `巡查里现在没有等着回的。${data.stage === undefined ? '' : data.stage}`
  const lines = [
    `等着回的 ${c.waiting} 条、卡已经出了等你批的 ${c.card_out} 条${c.conflict === 0 ? '' : `、和以前说的矛盾要你看的 ${c.conflict} 条`}。`,
    ...data.rows.slice(0, 8).map((r) => {
      const who = r.author === undefined ? '' : `u/${r.author}`
      const where = r.subreddit === undefined ? '' : ` · r/${r.subreddit}`
      const st =
        r.state === 'card_out' ? '（卡已出）' : r.state === 'conflict' ? '（矛盾，要你看）' : ''
      return `- ${who}${where}${st}：${r.text.slice(0, 80)}${r.note === undefined ? '' : ` —— ${r.note}`}`
    }),
  ]
  if (data.stage !== undefined) lines.push(data.stage)
  return lines.join('\n')
}

/** 回话：出卡那一下（一张或几张）。 */
export function renderStaged(rows: (StagedData | undefined)[], failed = ''): string {
  const ok = rows.filter((r) => r?.staged === true).length
  const why = rows.find((r) => r !== undefined && !r.staged)?.message
  if (ok === 0) return `没出卡：${why ?? (failed || '工具没回话')}。`
  const clash = rows.flatMap((r) => r?.conflicts ?? [])
  return [
    `出了 ${ok} 张卡，在「要你处理」里，批了才会发。`,
    ...(clash.length === 0 ? [] : [`撞车：${clash.slice(0, 3).join('；')}（卡上写了下一个空档）`]),
    ...(why === undefined ? [] : [`有一条没出：${why}`]),
  ].join('\n')
}
