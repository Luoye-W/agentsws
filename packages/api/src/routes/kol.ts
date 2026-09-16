/**
 * WP68（48 §5.4）：**本地红人库的 `/v1` 面**。
 *
 * WP67 把六类对象、十个能力模块与五条渠道职责都建了起来，可是工作台上
 * 一个增删改的入口都没有——面板读得到红人，只是因为服务进程在装配期直接把
 * 投影塞给了 deck。这个文件补的就是那条缺口：**红人库从此有门**。
 *
 * 四条纪律，每条都在类型上看得见：
 *
 * 1. **联系方式的明文只走两跳**：进来那一跳（`POST …/contacts` 的 `value`
 *    当场写进本机加密库，换成 `value_ref`）与发信那一跳（执行器从加密库取）。
 *    读回来的一律是 {@link KolContactView.masked} 那个脱敏形态（`a***@x.com`）——
 *    这个类型上**根本没有明文那一格**，所以它不可能漏进响应体、事件或模型上下文。
 * 2. **一个对象域一把闸**。六条对象域各自判权（`creator` / `platform_account` /
 *    `creator_contact` / `collaboration` / `deliverable` / `tracked_link`），
 *    联系方式与合作是 `confidential`，其余 `internal`。五条渠道职责的 scopes
 *    一模一样，所以"能不能动"这件事由 `X-Assignment` 那条分配说了算，
 *    与路径上写的是哪条渠道无关。
 * 3. **合并永远是一张卡**。`GET /v1/kol/merge-suggestions` 出的是建议，
 *    `POST …/:id/accept` 才真的合。建议 id 是**算出来的**（`kms_<keep>__<merge>`），
 *    不落第二张表——建议是库当前状态的一个函数，存一份就要回答"什么时候重算"。
 * 4. **审核结论走变更账本**。`POST /v1/kol/deliverables/:id/review` 提的是一条
 *    `kol_deliverable_review` staged change（L2 起），不是直接改库。
 */
import type {
  AssignmentId,
  Collaboration,
  CollaborationStage,
  Creator,
  CreatorContactKind,
  Deliverable,
  DeliverableKind,
  DeliverableReview,
  Iso8601,
  KolChannel,
  KolUtm,
  MaybePromise,
  PersonId,
  PlatformAccount,
  RoleId,
  TrackedLink,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, intParam, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/* ── 鉴权元组：六个对象域各一把闸（31 §3.1 完整元组） ─────────────────── */

const READ_CREATOR = {
  domain: 'creator',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_CREATOR = { ...READ_CREATOR, op: 'stage' } as const
const STAGE_ACCOUNT = {
  domain: 'platform_account',
  op: 'stage',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const READ_CONTACT = {
  domain: 'creator_contact',
  op: 'read',
  range: 'assigned',
  sensitivity: 'confidential',
} as const
const STAGE_CONTACT = { ...READ_CONTACT, op: 'stage' } as const
const READ_COLLAB = {
  domain: 'collaboration',
  op: 'read',
  range: 'assigned',
  sensitivity: 'confidential',
} as const
const STAGE_COLLAB = { ...READ_COLLAB, op: 'stage' } as const
const READ_DELIVERABLE = {
  domain: 'deliverable',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_DELIVERABLE = { ...READ_DELIVERABLE, op: 'stage' } as const
const READ_LINK = {
  domain: 'tracked_link',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_LINK = { ...READ_LINK, op: 'stage' } as const

/* ── actor 与视图 ─────────────────────────────────────────────────────── */

export interface KolActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  /** 本次绑定的那条分配（31 §3.1）——额度、等级与"能不能动"全从它来。 */
  assignment_id: AssignmentId
  role_id: RoleId
}

/**
 * 一条联系方式在响应体里的样子。
 *
 * **没有明文那一格**（文件头第 1 条）：`masked` 是 `a***@x.com` 这种形态，
 * 够人认出"是哪一个邮箱"，又不足以拿去发信。
 */
export interface KolContactView {
  id: string
  creator_id: string
  kind: CreatorContactKind
  source: string
  verified_at?: Iso8601
  masked: string
}

/** 找人清单上的一行（`GET /v1/kol/creators`）。 */
export interface KolCreatorRow {
  creator_id: string
  display_name: string
  channel: KolChannel
  handle: string
  url: string
  followers?: number
  engagement_rate?: number
  category?: string
  observed_at: Iso8601
  /** `kol-core` 的 `scoreCreator` 当场算的分（0–100）。 */
  score: number
  /** 刷粉护栏那一句；有值就是"这个数不可信"，与低分分得开。 */
  blocked?: string
  /** 库里有没有这个人的联系方式（**只说有没有**）。 */
  has_contact: boolean
}

/** 红人详情（工作台上点开那一屏）。 */
export interface KolCreatorDetail {
  creator: Creator
  accounts: PlatformAccount[]
  contacts: KolContactView[]
  collaborations: Collaboration[]
  /** 这个人名下每条合作的交付物与追踪链接（合作历史那一段）。 */
  deliverables: Deliverable[]
  tracked_links: TrackedLink[]
}

/** 合并建议在卡面上的样子。 */
export interface KolMergeSuggestionView {
  id: string
  keep: { creator_id: string; display_name: string }
  merge: { creator_id: string; display_name: string }
  reasons: { id: string; text: string }[]
  confidence: number
  /** 这条建议对应的那张 14 四段式卡；没建出来（比如被去重挡住）时没有。 */
  approval_item_id?: string
}

/** 导入的结果（36 §1：说清楚发生了什么）。 */
export interface KolImportView {
  /** 一句人话的汇总。 */
  summary: string
  created_creators: number
  created_accounts: number
  updated_accounts: number
  /** 写进加密库的联系方式条数（表里有邮箱那一列时）。 */
  created_contacts: number
  duplicates: { source_row: number; same_as_row: number; handle: string; channel: KolChannel }[]
  rejected: { source_row: number; reason: string }[]
  unmapped: string[]
  /** 这一版只认 CSV / TSV；收到别的扩展名时这里说明白。 */
  note?: string
}

/**
 * 找人的结果（`GET /v1/kol/search`）。
 *
 * **"拿不到"与"搜到 0 个"必须分得开**（36 §3）：`ok: false` 时 `message` 是一句
 * 人话（没连 / 要申请 / 要买档 / 配额用完），界面照它说；`ok: true` 而
 * `rows` 是空的，才是真的"这个条件下没人"。
 */
export interface KolSearchResult {
  ok: boolean
  /** 这一份是从哪儿来的：`channel` = 你自己的平台连接；`public_library` = agentsws 的公共库。 */
  source: 'channel' | 'public_library'
  rows: KolSearchHit[]
  /** `ok: false` 时那一句人话。 */
  message?: string
  /** 机器可读的原因（`not_connected` / `needs_approval` / `quota_exhausted` / …）。 */
  reason?: string
  /** 这份数据什么时候看到的。 */
  observed_at?: Iso8601
  /**
   * 公共库那一档才有：**reveal 一个邮箱要花多少积分**（起草开发信之前先说）。
   *
   * 浏览是免费的，所以这一格与 `rows` 一起回来——人在决定"要不要花这笔钱"之前
   * 就该看得见数，而不是点下去之后才知道。
   */
  reveal_price?: KolRevealPrice
}

/** 公共库那一档要花多少积分（49 M4 的价目；本地一个数字都不自己算）。 */
export interface KolRevealPrice {
  capability: string
  credits: number
  unit: string
  /** 一句人话：「这一步扣 N 积分」。 */
  note: string
}

/** 搜出来的一条（还没进库——进库是"加到红人库"那一下的事）。 */
export interface KolSearchHit {
  channel: KolChannel
  handle: string
  url: string
  display_name: string
  followers?: number
  engagement_rate?: number
  category?: string
  language?: string
  region?: string
  /** 公共库那一档才有：库里有没有这个人的联系方式（reveal 要花积分）。 */
  has_contact?: boolean
  /** 这个人已经在本地库里了（别重复加）。 */
  in_library?: boolean
}

/**
 * 一封开发信起草完的样子（`POST /v1/kol/outreach`）。
 *
 * **禁承诺是 block 不是转人审**：`staged: false` + `forbidden_hits` 时这一封
 * 根本没进队列——一封写着"我们付你 800 美元"的信不该存在"人点一下就发出去"的路径。
 */
export interface KolOutreachView extends KolStagedView {
  step: 'first' | 'follow_up' | 'final'
  subject: string
  body: string
  forbidden_hits: string[]
  /** 变量缺了哪几格（缺了就不起草——拿一封写着 {{product}} 的信去问人更糟）。 */
  missing_vars: string[]
  /** 今天还能发几封（职责 yml 的 `max_outreach_per_day`）。 */
  quota: { cap: number; sent_today: number; remaining: number; allowed: boolean }
}

/** campaign 清单里的一条。 */
export interface KolCampaignPick {
  creator_id: string
  display_name: string
  channel: KolChannel
  handle: string
  followers?: number
  score: number
  /** 为什么挑他（打分里最高那一项的一句带数的话）。 */
  why: string[]
  /** 已经有这条渠道的合作了（接受时跳过，不重复建）。 */
  already: boolean
}

/**
 * 一条渠道那一组。
 *
 * **`allowed: false` 的那几组在卡面上灰显**（05 §4「不做跨 Assignment 并集」）：
 * 同一个人只勾了 YouTube 那条职责，就只能建 YouTube 那几条合作，
 * Instagram 那几条摆在那里给他看，但点不动，并说清楚为什么。
 */
export interface KolCampaignGroup {
  channel: KolChannel
  role_id: string
  /** 本人有没有这条渠道职责的分配（有才建得了）。 */
  allowed: boolean
  /** 建的时候用的是这条分配（额度、等级、权限全从它来）。 */
  assignment_id?: string
  /** `allowed: false` 时那一句人话。 */
  reason?: string
  picks: KolCampaignPick[]
}

export interface KolCampaignView {
  campaign_id: string
  /** 四格齐了没有；没齐时 `by_channel` 是空的。 */
  ready: boolean
  gaps: string[]
  /** 缺格时那一句人话。 */
  message: string
  by_channel: KolCampaignGroup[]
  budget_per_creator: number
  /** 这张清单卡（`kol_campaign`）。 */
  approval_item_id?: string
}

/** 接受一张清单卡之后真建出来了什么。 */
export interface KolCampaignAcceptView {
  campaign_id: string
  created: { channel: KolChannel; creator_id: string; collaboration_id: string }[]
  /** 没建的那几条与为什么（没这条职责 / 已经有合作了 / 额度到顶）。 */
  skipped: { channel: KolChannel; creator_id?: string; reason: string }[]
}

/** 提了一条变更之后回给界面的那一份（卡在哪、拦没拦）。 */
export interface KolStagedView {
  staged: boolean
  change_id?: string
  approval_item_id?: string
  /** 被拦下时的一句人话。 */
  message?: string
  auto_approved?: boolean
}

/** 手工加一个红人的入参。 */
export interface KolCreatorInput {
  display_name: string
  channel: KolChannel
  handle?: string | undefined
  url?: string | undefined
  followers?: number | undefined
  engagement_rate?: number | undefined
  category?: string | undefined
  language?: string | undefined
  region?: string | undefined
}

/** 改名字，或者更新一条渠道账号的资料快照。 */
export interface KolCreatorPatch {
  display_name?: string | undefined
  account?:
    | {
        id: string
        followers?: number | undefined
        engagement_rate?: number | undefined
        category?: string | undefined
        language?: string | undefined
        region?: string | undefined
        observed_at?: Iso8601 | undefined
      }
    | undefined
}

/** 建一条合作的入参。 */
export interface KolCollaborationInput {
  creator_id: string
  channel: KolChannel
  budget?: number | undefined
  currency?: string | undefined
  campaign_id?: string | undefined
}

/** 建一条追踪链接的入参。三参数（source / medium / campaign）由服务端定，见实现。 */
export interface KolTrackedLinkInput {
  collaboration_id: string
  url: string
  campaign: string
  affiliate_code?: string | undefined
  utm?: Partial<Record<keyof KolUtm, string | undefined>> | undefined
}

/** campaign 向导那四格（48 §5.2：目标 / 预算 / 渠道 / 人数）。 */
export interface KolCampaignBrief {
  goal: string
  budget: number
  currency?: string | undefined
  channels: KolChannel[]
  headcount: number
  /** 打分条件（类目 / 语言 / 地区 / 粉丝带）。 */
  criteria?:
    | {
        category?: string | undefined
        language?: string | undefined
        region?: string | undefined
        followers_band?: { min: number; max: number } | undefined
      }
    | undefined
}

/**
 * 红人库端口。网关只做装配与校验，逻辑在 `apps/server/src/kol-service.ts`。
 *
 * 每个方法的第一个参数都是 `actor`——WP66 的 `brand-ports` 靠这一条按品牌取模块，
 * 少一个就是"这条路由还跟着第一个品牌"。
 */
export interface KolPort {
  creators(
    actor: KolActor,
    filter: {
      channel?: KolChannel | undefined
      q?: string | undefined
      limit?: number | undefined
    },
  ): MaybePromise<{ rows: KolCreatorRow[] }>
  /**
   * 去渠道上找人（48 §5.1 那条链的第一步）。
   *
   * 走哪条路由由 49 M2 的开关定：用我的 = 打这条渠道自己的接口；
   * 用 agentsws 的 = 查云端公共库。两条路回的是同一个形状。
   */
  search(
    actor: KolActor,
    input: { channel: KolChannel; q: string; limit?: number | undefined },
  ): MaybePromise<KolSearchResult>
  creator(actor: KolActor, id: string): MaybePromise<KolCreatorDetail | undefined>
  createCreator(actor: KolActor, input: KolCreatorInput): MaybePromise<KolCreatorDetail>
  patchCreator(actor: KolActor, id: string, input: KolCreatorPatch): MaybePromise<KolCreatorDetail>
  addContact(
    actor: KolActor,
    creator_id: string,
    input: { kind: CreatorContactKind; value: string; source?: string | undefined },
  ): MaybePromise<KolContactView>

  collaborations(
    actor: KolActor,
    filter: { channel?: KolChannel | undefined; stage?: CollaborationStage | undefined },
  ): MaybePromise<{ rows: Collaboration[] }>
  createCollaboration(
    actor: KolActor,
    input: KolCollaborationInput,
  ): MaybePromise<KolStagedView & { collaboration?: Collaboration }>
  advanceCollaboration(
    actor: KolActor,
    id: string,
    input: { stage: CollaborationStage },
  ): MaybePromise<Collaboration>

  deliverables(
    actor: KolActor,
    filter: { collaboration_id?: string | undefined; pending?: boolean | undefined },
  ): MaybePromise<{ rows: Deliverable[] }>
  createDeliverable(
    actor: KolActor,
    input: {
      collaboration_id: string
      kind: DeliverableKind
      due_at: Iso8601
      url?: string | undefined
    },
  ): MaybePromise<Deliverable>
  reviewDeliverable(
    actor: KolActor,
    id: string,
    input: { review: DeliverableReview; notes?: string | undefined },
  ): MaybePromise<KolStagedView>

  trackedLinks(
    actor: KolActor,
    filter: { collaboration_id?: string | undefined },
  ): MaybePromise<{ rows: TrackedLink[] }>
  createTrackedLink(actor: KolActor, input: KolTrackedLinkInput): MaybePromise<TrackedLink>

  importTable(
    actor: KolActor,
    input: { filename?: string | undefined; content: string },
  ): MaybePromise<KolImportView>

  /** 起草一封开发信并提上去（L2 起；禁承诺当场 block）。 */
  outreach(
    actor: KolActor,
    input: {
      creator_id: string
      channel: KolChannel
      step?: 'first' | 'follow_up' | 'final' | undefined
      product: string
      reason?: string | undefined
      brand_pitch?: string | undefined
      sender_name?: string | undefined
    },
  ): MaybePromise<KolOutreachView>

  /**
   * 付费 reveal 一个公共库里的联系方式（49 M4 `data.kol.lookup`）。
   *
   * 明文**当场写进本机加密库**，回来的只有脱敏形态——与手工加一条联系方式
   * 走的是同一条路。库里没有联系方式**不收钱**。
   */
  revealFromPublicLibrary(
    actor: KolActor,
    input: { channel: KolChannel; handle: string; creator_id?: string | undefined },
  ): MaybePromise<{
    ok: boolean
    contact?: KolContactView
    creator_id?: string
    credits_spent?: number
    reason?: string
    message?: string
  }>

  /** campaign 向导：四格 → 一份按渠道分好组的挑人清单 + 一张清单卡。 */
  planCampaign(actor: KolActor, input: KolCampaignBrief): MaybePromise<KolCampaignView>
  /** 接受一张清单卡：按渠道分别建合作，**每条走各自渠道职责的额度**。 */
  acceptCampaign(actor: KolActor, approval_item_id: string): MaybePromise<KolCampaignAcceptView>

  mergeSuggestions(actor: KolActor): MaybePromise<{ rows: KolMergeSuggestionView[] }>
  acceptMerge(actor: KolActor, id: string): MaybePromise<{ creator: Creator }>
  rejectMerge(actor: KolActor, id: string): MaybePromise<{ id: string; rejected: true }>
}

function portOf(deps: GatewayDeps): KolPort {
  const p = deps.kol
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配红人库（GatewayDeps.kol）。红人营销那五条职责要它才动得了。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): KolActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

const CHANNELS = ['youtube', 'facebook', 'instagram', 'tiktok', 'x'] as const
const STAGES = [
  'sourced',
  'contacted',
  'replied',
  'negotiating',
  'agreed',
  'delivering',
  'delivered',
  'closed',
  'declined',
] as const
const KINDS = ['video', 'post', 'story', 'reel', 'thread', 'live'] as const
const REVIEWS = ['pending', 'approved', 'changes_requested', 'rejected'] as const

const ChannelSchema = z.enum(CHANNELS)

const CreatorBody = z.object({
  display_name: z.string().min(1).max(200),
  channel: ChannelSchema,
  handle: z.string().max(200).optional(),
  url: z.string().max(2000).optional(),
  followers: z.number().int().nonnegative().optional(),
  engagement_rate: z.number().min(0).max(1).optional(),
  category: z.string().max(100).optional(),
  language: z.string().max(20).optional(),
  region: z.string().max(10).optional(),
})

const CreatorPatchBody = z.object({
  display_name: z.string().min(1).max(200).optional(),
  account: z
    .object({
      id: z.string().min(1),
      followers: z.number().int().nonnegative().optional(),
      engagement_rate: z.number().min(0).max(1).optional(),
      category: z.string().max(100).optional(),
      language: z.string().max(20).optional(),
      region: z.string().max(10).optional(),
      observed_at: z.string().optional(),
    })
    .optional(),
})

const ContactBody = z.object({
  kind: z.enum(['email', 'dm', 'form']),
  /** 明文只在这一格里活一瞬：服务端当场写进加密库，换成 `value_ref`。 */
  value: z.string().min(1).max(320),
  source: z.string().max(60).optional(),
})

const CollaborationBody = z.object({
  creator_id: z.string().min(1),
  channel: ChannelSchema,
  budget: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  campaign_id: z.string().max(64).optional(),
})

const StageBody = z.object({ stage: z.enum(STAGES) })

const DeliverableBody = z.object({
  collaboration_id: z.string().min(1),
  kind: z.enum(KINDS),
  due_at: z.string().min(1),
  url: z.string().max(2000).optional(),
})

const ReviewBody = z.object({
  review: z.enum(REVIEWS),
  notes: z.string().max(2000).optional(),
})

const TrackedLinkBody = z.object({
  collaboration_id: z.string().min(1),
  url: z.string().min(1).max(2000),
  campaign: z.string().min(1).max(100),
  affiliate_code: z.string().max(40).optional(),
  utm: z
    .object({
      source: z.string().max(60).optional(),
      medium: z.string().max(60).optional(),
      campaign: z.string().max(100).optional(),
      term: z.string().max(60).optional(),
      content: z.string().max(100).optional(),
    })
    .optional(),
})

const OutreachBody = z.object({
  creator_id: z.string().min(1),
  channel: ChannelSchema,
  step: z.enum(['first', 'follow_up', 'final']).optional(),
  /** 想聊的那个产品。**必填**：缺了就不起草（拿一封写着 {{product}} 的信去问人更糟）。 */
  product: z.string().min(1).max(200),
  reason: z.string().max(500).optional(),
  brand_pitch: z.string().max(500).optional(),
  sender_name: z.string().max(100).optional(),
})

const RevealBody = z.object({
  channel: ChannelSchema,
  handle: z.string().min(1).max(200),
  /** 挂到已有的那个红人身上；不给就按 渠道 + handle 建一条新的。 */
  creator_id: z.string().min(1).optional(),
})

const CampaignBody = z.object({
  goal: z.string().min(1).max(200),
  budget: z.number().positive(),
  currency: z.string().length(3).optional(),
  channels: z.array(ChannelSchema).min(1).max(5),
  headcount: z.number().int().positive().max(200),
  criteria: z
    .object({
      category: z.string().max(100).optional(),
      language: z.string().max(20).optional(),
      region: z.string().max(10).optional(),
      followers_band: z
        .object({ min: z.number().int().nonnegative(), max: z.number().int().positive() })
        .optional(),
    })
    .optional(),
})

const ImportBody = z.object({
  filename: z.string().max(200).optional(),
  /** 表的正文（CSV / TSV）。上传口子在工作台那一侧把文件读成文本再递过来。 */
  content: z.string().min(1).max(4_000_000),
})

const channelQuery = (c: Parameters<typeof param>[0]): KolChannel | undefined => {
  const raw = c.req.query('channel')
  if (raw === undefined || raw.trim() === '') return undefined
  const found = CHANNELS.find((x) => x === raw.trim())
  if (found === undefined) throw new ApiError('invalid_input', `不认识这个渠道：${raw}`)
  return found
}

export function kolRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/kol/creators',
        operationId: 'listKolCreators',
        summary:
          '红人库的找人清单（48 §5.1）：分由 kol-core 的 scoreCreator 当场算，刷粉的排在后面而不是剔掉',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: READ_CREATOR,
        params: [
          { name: 'channel', in: 'query', description: '只看这条渠道' },
          { name: 'q', in: 'query', description: '在名字与 handle 里找（子串）' },
          { name: 'limit', in: 'query', description: '最多几行', schema: { type: 'integer' } },
        ],
        returns: '{ rows: KolCreatorRow[] }',
      },
      async (c, deps) => {
        const channel = channelQuery(c)
        const q = c.req.query('q')
        const limit = intParam(c, 'limit')
        return ok(
          c,
          await portOf(deps).creators(actorOf(c), {
            ...(channel === undefined ? {} : { channel }),
            ...(q === undefined || q === '' ? {} : { q }),
            ...(limit === undefined ? {} : { limit }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/kol/search',
        operationId: 'searchKolCreators',
        summary:
          '去渠道上找人：没连 / 要申请 / 要买档 / 配额用完各有一句人话，**与"搜到 0 个"分得开**',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: READ_CREATOR,
        params: [
          { name: 'channel', in: 'query', required: true, description: '哪条渠道' },
          {
            name: 'q',
            in: 'query',
            required: true,
            description:
              '关键词（YouTube / Facebook）或者一串账号名（Instagram / TikTok / X 没有按关键词搜人这回事）',
          },
          { name: 'limit', in: 'query', description: '最多几条', schema: { type: 'integer' } },
        ],
        returns: 'KolSearchResult',
      },
      async (c, deps) => {
        const channel = channelQuery(c)
        if (channel === undefined) throw new ApiError('invalid_input', '得说清楚是哪条渠道')
        const q = c.req.query('q')
        if (q === undefined || q.trim() === '')
          throw new ApiError('invalid_input', '得给一个关键词或者账号名')
        const limit = intParam(c, 'limit')
        return ok(
          c,
          await portOf(deps).search(actorOf(c), {
            channel,
            q: q.trim(),
            ...(limit === undefined ? {} : { limit }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/kol/creators',
        operationId: 'createKolCreator',
        summary: '手工加一个红人（一个人 + 一条渠道账号；渠道之间零共享数据，48 §5.1）',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CREATOR,
        body: CreatorBody,
        returns: 'KolCreatorDetail',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).createCreator(actorOf(c), await body(c, CreatorBody)), 201),
    ),
    route(
      {
        method: 'get',
        path: '/v1/kol/creators/:id',
        operationId: 'getKolCreator',
        summary: '红人详情：资料快照、联系方式（**脱敏**）、合作历史',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTACT,
        params: [{ name: 'id', in: 'path', required: true, description: 'creator_id' }],
        returns: 'KolCreatorDetail',
      },
      async (c, deps) => {
        const found = await portOf(deps).creator(actorOf(c), param(c, 'id'))
        if (found === undefined) throw new ApiError('not_found', '库里没有这个红人')
        return ok(c, found)
      },
    ),
    route(
      {
        method: 'patch',
        path: '/v1/kol/creators/:id',
        operationId: 'patchKolCreator',
        summary: '改名字，或者更新一条渠道账号的资料快照（`observed_at` 跟着走）',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CREATOR,
        params: [{ name: 'id', in: 'path', required: true, description: 'creator_id' }],
        body: CreatorPatchBody,
        returns: 'KolCreatorDetail',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).patchCreator(
            actorOf(c),
            param(c, 'id'),
            await body(c, CreatorPatchBody),
          ),
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/kol/creators/:id/contacts',
        operationId: 'addKolContact',
        summary:
          '加一条联系方式：**明文当场写进本机加密库**（value_ref = kol.contact.<id>），回来的只有脱敏形态',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTACT,
        params: [{ name: 'id', in: 'path', required: true, description: 'creator_id' }],
        body: ContactBody,
        returns: 'KolContactView（只有 masked，没有明文）',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).addContact(actorOf(c), param(c, 'id'), await body(c, ContactBody)),
          201,
        ),
    ),

    route(
      {
        method: 'get',
        path: '/v1/kol/collaborations',
        operationId: 'listKolCollaborations',
        summary: '合作清单（可按渠道与阶段筛）',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: READ_COLLAB,
        params: [
          { name: 'channel', in: 'query', description: '只看这条渠道' },
          { name: 'stage', in: 'query', description: '只看这个阶段' },
        ],
        returns: '{ rows: Collaboration[] }',
      },
      async (c, deps) => {
        const channel = channelQuery(c)
        const raw = c.req.query('stage')
        const stage = raw === undefined ? undefined : STAGES.find((s) => s === raw)
        if (raw !== undefined && stage === undefined)
          throw new ApiError('invalid_input', `不认识这个阶段：${raw}`)
        return ok(
          c,
          await portOf(deps).collaborations(actorOf(c), {
            ...(channel === undefined ? {} : { channel }),
            ...(stage === undefined ? {} : { stage }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/kol/collaborations',
        operationId: 'createKolCollaboration',
        summary:
          '建一条合作：提一条 kol_collaboration 变更（**永远 L1**，15 §2 的 HARD_L1），人点头之后才落库',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_COLLAB,
        body: CollaborationBody,
        returns: 'KolStagedView & { collaboration? }',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).createCollaboration(actorOf(c), await body(c, CollaborationBody)),
          201,
        ),
    ),
    route(
      {
        method: 'patch',
        path: '/v1/kol/collaborations/:id/stage',
        operationId: 'advanceKolCollaboration',
        summary: '推进合作阶段：合法迁移表只有 kol-core 的 stages.ts 那一份，非法跳转回一句人话',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_COLLAB,
        params: [{ name: 'id', in: 'path', required: true, description: 'collaboration_id' }],
        body: StageBody,
        returns: 'Collaboration',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).advanceCollaboration(
            actorOf(c),
            param(c, 'id'),
            await body(c, StageBody),
          ),
        ),
    ),

    route(
      {
        method: 'get',
        path: '/v1/kol/deliverables',
        operationId: 'listKolDeliverables',
        summary: '交付物清单；`pending=1` 只看还没有结论的那些',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: READ_DELIVERABLE,
        params: [
          { name: 'collaboration_id', in: 'query', description: '只看这条合作的' },
          {
            name: 'pending',
            in: 'query',
            description: '只看待审的',
            schema: { type: 'boolean' },
          },
        ],
        returns: '{ rows: Deliverable[] }',
      },
      async (c, deps) => {
        const collaboration_id = c.req.query('collaboration_id')
        const pending = c.req.query('pending')
        return ok(
          c,
          await portOf(deps).deliverables(actorOf(c), {
            ...(collaboration_id === undefined || collaboration_id === ''
              ? {}
              : { collaboration_id }),
            ...(pending === undefined || pending === '' || pending === '0'
              ? {}
              : { pending: true }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/kol/deliverables',
        operationId: 'createKolDeliverable',
        summary: '登记一件交付物（视频 / 帖子 / Reels …）与它的交稿日期',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_DELIVERABLE,
        body: DeliverableBody,
        returns: 'Deliverable',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).createDeliverable(actorOf(c), await body(c, DeliverableBody)),
          201,
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/kol/deliverables/:id/review',
        operationId: 'reviewKolDeliverable',
        summary: '给一件交付物下结论：提一条 kol_deliverable_review 变更（L2 起）',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_DELIVERABLE,
        params: [{ name: 'id', in: 'path', required: true, description: 'deliverable_id' }],
        body: ReviewBody,
        returns: 'KolStagedView',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).reviewDeliverable(
            actorOf(c),
            param(c, 'id'),
            await body(c, ReviewBody),
          ),
          201,
        ),
    ),

    route(
      {
        method: 'get',
        path: '/v1/kol/tracked-links',
        operationId: 'listKolTrackedLinks',
        summary: '追踪链接与回填的点击 / 订单 / 收入（数字原样端出去，不在渲染时现算）',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: READ_LINK,
        params: [{ name: 'collaboration_id', in: 'query', description: '只看这条合作的' }],
        returns: '{ rows: TrackedLink[] }',
      },
      async (c, deps) => {
        const collaboration_id = c.req.query('collaboration_id')
        return ok(
          c,
          await portOf(deps).trackedLinks(actorOf(c), {
            ...(collaboration_id === undefined || collaboration_id === ''
              ? {}
              : { collaboration_id }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/kol/tracked-links',
        operationId: 'createKolTrackedLink',
        summary: '给一条合作建一条带 UTM / 联盟码的追踪链接（UTM 三参数缺一即被 guardrail 拦）',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_LINK,
        body: TrackedLinkBody,
        returns: 'TrackedLink',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).createTrackedLink(actorOf(c), await body(c, TrackedLinkBody)),
          201,
        ),
    ),

    route(
      {
        method: 'post',
        path: '/v1/kol/import',
        operationId: 'importKolTable',
        summary:
          '导一张表（CSV / TSV）：列映射靠表头别名，去重只按 渠道 + handle，认不出来的行照实说',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ACCOUNT,
        body: ImportBody,
        returns: 'KolImportView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).importTable(actorOf(c), await body(c, ImportBody)), 201),
    ),

    route(
      {
        method: 'post',
        path: '/v1/kol/outreach',
        operationId: 'draftKolOutreach',
        summary:
          '起草一封开发信并提上去（L2 起）。禁承诺是 **block 不是转人审**——写了给钱 / 白送 / 保证的话，这一封根本不进队列',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTACT,
        body: OutreachBody,
        returns: 'KolOutreachView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).outreach(actorOf(c), await body(c, OutreachBody)), 201),
    ),
    route(
      {
        method: 'post',
        path: '/v1/kol/public/reveal',
        operationId: 'revealKolContact',
        summary:
          '花积分从公共红人库取回一个邮箱（49 M4 `data.kol.lookup`）。明文当场写进本机加密库，回来的只有脱敏形态；库里没有联系方式不收钱',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTACT,
        body: RevealBody,
        returns: '{ ok, contact?, creator_id?, credits_spent?, reason?, message? }',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).revealFromPublicLibrary(actorOf(c), await body(c, RevealBody))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/kol/campaigns',
        operationId: 'planKolCampaign',
        summary:
          'campaign 向导（48 §5.2）：目标 / 预算 / 渠道 / 人数 → 一份按渠道分好组的挑人清单 + 一张清单卡。**只出清单，不出动作**',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: READ_CREATOR,
        body: CampaignBody,
        returns: 'KolCampaignView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).planCampaign(actorOf(c), await body(c, CampaignBody)), 201),
    ),
    route(
      {
        method: 'post',
        path: '/v1/kol/campaigns/:id/accept',
        operationId: 'acceptKolCampaign',
        summary:
          '接受一张清单卡：为清单上每个人建一条合作（`sourced`）。**每条走各自渠道职责的额度**，本人没有那条职责的整组跳过并说明',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_COLLAB,
        params: [
          { name: 'id', in: 'path', required: true, description: '清单卡的 approval_item_id' },
        ],
        returns: 'KolCampaignAcceptView',
      },
      async (c, deps) => ok(c, await portOf(deps).acceptCampaign(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/kol/merge-suggestions',
        operationId: 'listKolMergeSuggestions',
        summary:
          '同一人合并的建议（48 §5.2：**只出建议卡，永远不自动合**）；每条建议同时进一张 14 四段式卡',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: READ_CREATOR,
        returns: '{ rows: KolMergeSuggestionView[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).mergeSuggestions(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/kol/merge-suggestions/:id/accept',
        operationId: 'acceptKolMergeSuggestion',
        summary:
          '接受一条合并建议：账号 / 联系方式 / 合作改挂到保留那条上，被合掉那条的 id 留在 merged_from 里（合错了拆得回来）',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CREATOR,
        params: [
          { name: 'id', in: 'path', required: true, description: '建议 id（kms_<keep>__<merge>）' },
        ],
        returns: '{ creator }',
      },
      async (c, deps) => ok(c, await portOf(deps).acceptMerge(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/kol/merge-suggestions/:id/reject',
        operationId: 'rejectKolMergeSuggestion',
        summary: '否掉一条合并建议：这两条以后不再互相建议（卡也一并撤掉）',
        tag: 'kol',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CREATOR,
        params: [{ name: 'id', in: 'path', required: true, description: '建议 id' }],
        returns: '{ id, rejected }',
      },
      async (c, deps) => ok(c, await portOf(deps).rejectMerge(actorOf(c), param(c, 'id'))),
    ),
  ]
}
