/**
 * WP113（63 §8）：**消息面**（`/v1/messages/*`）。
 *
 * 28 §2「网关里不写业务」：每条路由都只是消息模块某个方法的投影，
 * 装配在 `apps/server/src/messages.ts`。
 *
 * 鉴权元组照 `work.ts` 那一条（`approval.read|stage / own`）。理由一样：
 * 一只邮箱是**本人自己的收件处**，05 的 scopes 是对业务数据域说的
 * （订单、顾客、广告账户），邮箱不是其中之一。真正会对外产生影响的只有
 * `POST /v1/messages/send`，那一条挂 `outbound: true`，走急停的出站档，
 * 而且它发的是**人自己按下发送的那一封**——不是 Agent 提的草稿。
 *
 * 三条边界写在类型上：
 * - **没有硬删**：`DELETE` 一条路由都没有，删除是 `POST …/move { to: 'trash' }`；
 * - **发送不出卡**（36「只有要人拍板的才是卡」的反面）：人自己按的发送不该
 *   再问他一遍；
 * - **`KefuAgents` / `KOLAgents` 里的信在这里只读**（63 §9）：要亲自回先走
 *   现有的 takeover，这一层不给"直接回复"的口子。
 */
import type {
  MaybePromise,
  MessageBackfillInput,
  MessageClaim,
  MessageClaimInput,
  MessageConfirmRouteInput,
  MessageConfirmRouteResult,
  MessageDigest,
  MessageDraft,
  MessageDraftInput,
  MessageFlagsInput,
  MessageFolder,
  MessageFollowUp,
  MessageFollowUpAction,
  MessageFollowUpRow,
  MessageFollowUpSettings,
  MessageFollowUpSettingsPatch,
  MessageImagesReport,
  MessageKind,
  MessageKindInput,
  MessageLabel,
  MessageListQuery,
  MessageMoveInput,
  MessageNoticeAckInput,
  MessageOverview,
  MessageRecord,
  MessageRule,
  MessageRuleDraft,
  MessageRuleList,
  MessageRulePatch,
  MessageRuleProposal,
  MessageRuleProposeInput,
  MessageRuleTrial,
  MessageSendInput,
  MessageSendResult,
  MessageSuggest,
  MessageSyncReport,
  MessageThreadSummary,
  MessageWriteback,
  PersonId,
  ReplySuggestion,
  SenderRule,
  SenderRuleList,
  Todo,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, intParam, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import { contentDisposition } from './knowledge.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
const WRITE = { ...READ, op: 'stage' } as const

export interface MessageActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  assignment_id: string
}

/** 一只邮箱在消息页上的样子（"全部邮箱"那一排）。 */
export interface MessageAccountView {
  address: string
  unread: number
  folders: MessageFolder[]
  /** 现在回溯到哪一天（"再往前取"旁边那句话）。 */
  backfill_floor: string
  /**
   * WP163：这只邮箱最近一次没动成的邮箱动作（判成客服的信标已读 / 挪进 `KefuAgents`）。
   * `reason` 是原因码（`server_refused` / `error` / `unsupported` …），界面翻成人话。
   * 同一种动作后来成功过就不给。
   */
  last_mailbox_failure?: {
    at: string
    action: 'mark_read' | 'move'
    reason: string
    folder: string
    to_folder?: string
  }
  /** WP172：这只邮箱收 B2B 信（B2B 岗位开着 + 邮箱卡上「收 B2B 信」开着）——左栏据此画「B2B 往来」。 */
  b2b?: boolean
  /**
   * WP204：这只邮箱开着影子模式（「只看不动」）——消息页据此把归档 / 删除置灰并说明为什么，
   * 已读 / 星标只在本机标。只在开着时给。
   */
  shadow_mode?: boolean
}

/** WP204：一封信的一个附件（字节从受控原始材料区取）。 */
export interface MessageAttachmentFile {
  name: string
  mime: string
  bytes: Uint8Array
}

/** 打开一封信时一次拿全（正文 + 这条会话 + 右栏那一格要的东西）。 */
export interface MessageThreadView {
  thread_id: string
  subject: string
  messages: MessageRecord[]
  /**
   * 63 §9：`KefuAgents` / `KOLAgents` 里的信顶上那条状态带。
   * 不为空 = 这一页**不给"直接回复"**（避免人与 Agent 撞车）。
   */
  agent_status?: {
    /** WP172：`b2b` = B2B 岗位在处理（`BtoBAgents` 里的信）。 */
    route: 'support' | 'kol' | 'b2b'
    /** `working` / `waiting_for_you` / `replied`。 */
    state: 'working' | 'waiting_for_you' | 'replied'
    /** 去对应工作线程的深链（`/matters/<id>`）。 */
    href?: string
    /** "我来接手"要打给谁（现有 takeover 那条路）。 */
    takeover_matter_id?: string
  }
  /** WP212：这条会话现在归谁（没人接 / 只是通知 / 已交出去；服务端派生，docs/88 §3.1）。 */
  claim?: MessageClaim
  /** WP212：三个建议作用在哪一封上。 */
  claim_message_id?: string
  /** WP212：交给了谁（岗位模板 id，或 `'me'` / `'notice'`）。 */
  handed_to?: string
  /** WP212：卡片流里还有几张卡等你批、跳过去的链接（「X 在办 · 有 N 张卡等你 →」）。 */
  open_card_count?: number
  card_link?: string
  /** WP212：没人接时 AI 挑的主按钮。 */
  suggest?: MessageSuggest
  /** WP442：回信跟进（最后一封是我们发的、在等对方回的会话才有）。 */
  follow_up?: MessageFollowUp
  kind?: MessageKind
  /**
   * WP440（docs/108 M9）：这条会话上 AI **按把握直接回**的那几封——
   * 「全部」时间线里那一行「AI 直接回 · 出处：…」，旁边「这封不该直接回」。
   */
  auto_replies?: MessageAutoReplyMark[]
}

/** WP440：AI 按把握直接回的一封（只有出处与分数，不含来信原文）。 */
export interface MessageAutoReplyMark {
  /** 那张自动批了的回信卡（「这封不该直接回」按它点）。 */
  approval_item_id: string
  at: string
  /** 0–1 的把握。 */
  score: number
  sources: { kind: string; label: string }[]
  /** 发出去的那封开头一段（对得上是哪一封）。 */
  excerpt: string
  /** 人已经点过「这封不该直接回」。 */
  flagged: boolean
}

/** 右栏 `mail-assistant` 那一格要的东西（一次取全，前端不发第二个请求）。 */
export interface MailAssistantView {
  message_id: string
  summary: string
  /**
   * 这封信要不要回。
   *
   * 与 `suggestions` 分开给，是因为"不用回"与"要回但这台机器上生成不出来"
   * 在界面上必须是两句话——只看空数组的话，一台没接模型的机器会对每封信都说
   * "这封信看起来不用回"，而那是假的。
   */
  needs_reply: boolean
  /** `needs_reply` 为假时是空数组（不生成、不花钱）。 */
  suggestions: ReplySuggestion[]
  sender: {
    address: string
    name?: string
    /** 历史往来多少封。 */
    history_count: number
    /** 关联到的对象（订单 / 红人 / 客户）。 */
    linked: { type: string; id: string; label: string }[]
  }
  /** 相关待办。 */
  todos: { id: string; title: string; status: string }[]
  /** 这台机器上有没有可用的模型（没有时界面照实说，而不是显示"生成失败"）。 */
  model_available: boolean
  /**
   * WP212（docs/88 §5.1b）：助手是**兜底处理的助手**——只在没人接的信上生成回复建议；
   * 岗位在办的信（`handed`）不生成（不花 token），界面只挂「X 在办 · 有 N 张卡等你 →」。
   */
  claim?: MessageClaim
  handed_to?: string
  open_card_count?: number
  card_link?: string
}

export interface MessagesPort {
  accounts(actor: MessageActor): MaybePromise<{ accounts: MessageAccountView[] }>
  threads(
    actor: MessageActor,
    query: MessageListQuery,
  ): MaybePromise<{ threads: MessageThreadSummary[] }>
  thread(actor: MessageActor, thread_id: string): MaybePromise<MessageThreadView>
  message(actor: MessageActor, id: string): MaybePromise<{ message: MessageRecord }>
  setFlags(
    actor: MessageActor,
    id: string,
    input: MessageFlagsInput,
  ): MaybePromise<{ message: MessageRecord; writeback?: MessageWriteback }>
  /** 挪一封信（也是纠错的落点）。删除 = `to: 'trash'`。 */
  move(
    actor: MessageActor,
    id: string,
    input: MessageMoveInput,
  ): MaybePromise<{ message: MessageRecord; rule?: SenderRule; writeback?: MessageWriteback }>
  setLabels(
    actor: MessageActor,
    id: string,
    labels: string[],
  ): MaybePromise<{ message: MessageRecord }>
  /**
   * WP167：「待确认」那一栏上人点的那一下（人工分拣，写事件）：「这是客服」交给客服那一路，
   * 「不是」只记人的判断。不实现 = 这台机器没有这一栏（路由回 501）。
   */
  confirmRoute?(
    actor: MessageActor,
    id: string,
    input: MessageConfirmRouteInput,
  ): MaybePromise<MessageConfirmRouteResult>
  /**
   * 「显示图片」/「总是信任这个发件人」。WP204：图片由本机代取、内联（`images` 说取到几张、
   * 几张没取到）；只对这一封生效，不改库里那一份。
   */
  showImages(
    actor: MessageActor,
    id: string,
    always: boolean,
  ): MaybePromise<{ message: MessageRecord; images?: MessageImagesReport }>
  /**
   * WP204：取一个附件的字节（受控原始材料区）。不实现 = 这台机器看不了附件（路由回 501）；
   * 回 `undefined` = 没有这个附件 / 原件过了保留期（404）。
   */
  attachment?(
    actor: MessageActor,
    id: string,
    attachment_id: string,
  ): MaybePromise<MessageAttachmentFile | undefined>

  labels(actor: MessageActor): MaybePromise<{ labels: MessageLabel[] }>
  putLabel(actor: MessageActor, label: MessageLabel): MaybePromise<{ label: MessageLabel }>
  deleteLabel(actor: MessageActor, id: string): MaybePromise<{ deleted: boolean }>
  /** 合并两个标签（把 `from` 上的信都改挂 `into`，然后删掉 `from`）。 */
  mergeLabels(
    actor: MessageActor,
    from: string,
    into: string,
  ): MaybePromise<{ moved: number; labels: MessageLabel[] }>

  /** WP439：规则清单（命中数、谁教的、刚删的几条）。老实现只回 `rules` 也认。 */
  senderRules(actor: MessageActor): MaybePromise<SenderRuleList>
  /** 删一条：当场生效。WP439：回删掉的那一条（「已删 · 撤回」要它）。 */
  deleteSenderRule(
    actor: MessageActor,
    id: string,
  ): MaybePromise<{ deleted: boolean; rule?: SenderRule }>
  /** WP439：撤回刚删的那一条。不实现 = 这台机器删了就没了（路由回 501）。 */
  restoreSenderRule?(
    actor: MessageActor,
    id: string,
  ): MaybePromise<{ restored: boolean; rule?: SenderRule }>

  drafts(actor: MessageActor): MaybePromise<{ drafts: MessageDraft[] }>
  saveDraft(actor: MessageActor, input: MessageDraftInput): MaybePromise<{ draft: MessageDraft }>
  discardDraft(actor: MessageActor, id: string): MaybePromise<{ deleted: boolean }>
  /** **人自己按的发送**：走现有 outbox 七态 + 对账，不出卡。 */
  send(actor: MessageActor, input: MessageSendInput): MaybePromise<MessageSendResult>

  /** 右栏那一格（摘要 / 回复建议 / 发件人是谁 / 相关待办）。 */
  assistant(actor: MessageActor, id: string): MaybePromise<MailAssistantView>
  /** 「转成待办」。 */
  toTodo(actor: MessageActor, id: string): MaybePromise<{ todo: Todo }>

  /** WP212：「没人接的」顶上那一行、「只是通知」几捆、「你教过它」（一次取全）。 */
  overview?(actor: MessageActor): MaybePromise<MessageOverview>
  /** WP212：改判类型；勾「以后都这样」写发件人规则，不勾进学习回路。 */
  setKind?(
    actor: MessageActor,
    id: string,
    input: MessageKindInput,
  ): MaybePromise<{ message: MessageRecord; rule?: SenderRule }>
  /** WP212：「只是通知」/「我自己处理」/ 撤销（`none`）。 */
  claim?(
    actor: MessageActor,
    id: string,
    input: MessageClaimInput,
  ): MaybePromise<{ message: MessageRecord; writeback?: MessageWriteback }>
  /** WP212：「只是通知」整捆「知道了」。 */
  ackNotices?(
    actor: MessageActor,
    input: MessageNoticeAckInput,
  ): MaybePromise<{ acked: number; writeback?: MessageWriteback }>

  /**
   * WP440（docs/108 M9）：人点「这封不该直接回」→ 记进学习回路（与在线客服「这句不该直接答」同一份），
   * 同类以后转人。不是 AI 直接回的那一封回 `undefined`（404）。不实现 = 这台机器没有邮件直接回（501）。
   */
  flagAutoReply?(
    actor: MessageActor,
    approval_item_id: string,
  ): MaybePromise<{ learned: boolean } | undefined>

  /* ── WP441（docs/108 §5.1 / §5.6）：消息规则、试跑、一句话转规则、今天的简报。不实现 = 501 ── */

  /** 消息规则清单（按清单顺序 = 优先级；带系统规则「今天的简报」）。 */
  messageRules?(actor: MessageActor): MaybePromise<MessageRuleList>
  /** 直接建一条（表单）。一句话建走 {@link MessagesPort.proposeMessageRule}（出卡要人点）。 */
  createMessageRule?(
    actor: MessageActor,
    draft: MessageRuleDraft,
  ): MaybePromise<{ rule: MessageRule }>
  /** 改一条（带版本号；对不上回 409「刚被 X 改过」）。 */
  updateMessageRule?(
    actor: MessageActor,
    id: string,
    patch: MessageRulePatch,
  ): MaybePromise<{ rule: MessageRule }>
  deleteMessageRule?(actor: MessageActor, id: string): MaybePromise<{ deleted: boolean }>
  /** 撤回刚删的一条消息规则（7 天内，决策 243）。 */
  restoreMessageRule?(
    actor: MessageActor,
    id: string,
  ): MaybePromise<{ restored: boolean; rule?: MessageRule }>
  /** 拖动排序：给全部规则的新顺序（不在里面的排在后面）。 */
  reorderMessageRules?(actor: MessageActor, ids: string[]): MaybePromise<MessageRuleList>
  /** 试跑（不落库、不执行动作）。 */
  trialMessageRule?(actor: MessageActor, draft: MessageRuleDraft): MaybePromise<MessageRuleTrial>
  /** 一句话 → 规则草案 + 试跑 + 「要建这条规则吗」卡。 */
  proposeMessageRule?(
    actor: MessageActor,
    input: MessageRuleProposeInput,
  ): MaybePromise<MessageRuleProposal>
  /** 「这封不该归它」：给那条规则加这个发件人的排除，当场生效。 */
  excludeFromMessageRule?(
    actor: MessageActor,
    message_id: string,
    rule_id: string,
  ): MaybePromise<{ rule: MessageRule }>
  /** 今天的简报（还没点「知道了」的，按规则分组）。 */
  digest?(actor: MessageActor): MaybePromise<MessageDigest>
  /** 「全部知道了」（或点名几封）。 */
  ackDigest?(actor: MessageActor, message_ids?: string[]): MaybePromise<{ acked: number }>
  /**
   * WP442（docs/108 §5.3）：回信跟进。「等对方回」那一堆（到期早的在前）；不实现 = 这台机器没有回信跟进（501）。
   */
  followUps?(actor: MessageActor): MaybePromise<{ rows: MessageFollowUpRow[] }>
  /** WP442：系统规则「发出 N 个工作日没回 → 提醒我」（能改天数、能关、能按邮箱分开设）。 */
  followUpSettings?(actor: MessageActor): MaybePromise<MessageFollowUpSettings>
  setFollowUpSettings?(
    actor: MessageActor,
    patch: MessageFollowUpSettingsPatch,
  ): MaybePromise<MessageFollowUpSettings>
  /** WP442：「等对方回」那一行上直接点的（不用跟了 / 再等等 / 接着跟 / 现在就催）。 */
  followUpAction?(
    actor: MessageActor,
    thread_id: string,
    action: MessageFollowUpAction,
  ): MaybePromise<{ follow_up: MessageFollowUp }>

  /** 立刻收一次。 */
  sync(actor: MessageActor): MaybePromise<MessageSyncReport>
  /** 「再往前取」。 */
  backfill(actor: MessageActor, input: MessageBackfillInput): MaybePromise<{ floor: string }>
}

function portOf(deps: GatewayDeps): MessagesPort {
  const p = deps.messages
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配消息面（GatewayDeps.messages）。左栏的「消息」要它才有东西可看。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): MessageActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id, assignment_id: a.id }
}

const AddressSchema = z.object({
  email: z.string().min(3).max(320),
  name: z.string().max(200).optional(),
})

const FlagsBody = z.object({
  read: z.boolean().optional(),
  starred: z.boolean().optional(),
  answered: z.boolean().optional(),
})

const MoveBody = z.object({
  // 没有 `purge`：删除永远是移到垃圾箱（63 §7）
  to: z.enum(['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'support', 'kol', 'custom']),
  remember_sender: z.boolean().optional(),
})

const ConfirmRouteBody = z.object({
  route: z.enum(['support', 'kol', 'b2b', 'inbox', 'position']),
  // WP212：「交给 X」推广到所有岗位（岗位模板 id）+「以后这个发件人都这样」
  position_id: z.string().min(1).max(80).optional(),
  remember_sender: z.boolean().optional(),
})

const KINDS = [
  'customer_question',
  'after_sales',
  'inquiry',
  'creator_reply',
  'partnership',
  'media',
  'billing_system',
  'logistics',
  'marketing',
  'personal_other',
] as const satisfies readonly MessageKind[]

/* ── WP441：消息规则的入参（条件 / 动作只认这几种；外发动作根本写不进来） ── */

const RuleConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('from'), value: z.string().min(1).max(320) }),
  z.object({ type: z.literal('to_account'), value: z.string().min(1).max(320) }),
  z.object({ type: z.literal('subject_has'), value: z.string().min(1).max(200) }),
  z.object({ type: z.literal('body_has'), value: z.string().min(1).max(200) }),
  z.object({ type: z.literal('kind'), value: z.enum(KINDS) }),
  z.object({ type: z.literal('source'), value: z.enum(['email', 'chat']) }),
  z.object({ type: z.literal('has_attachment'), value: z.boolean() }),
  z.object({ type: z.literal('ai'), value: z.string().min(1).max(300) }),
])

const RuleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hand_to'), position_id: z.string().min(1).max(80) }),
  z.object({ type: z.literal('notice') }),
  z.object({ type: z.literal('label'), label: z.string().min(1).max(64) }),
  z.object({
    type: z.literal('record'),
    sink_id: z.string().min(1).max(80).optional(),
    sink_name: z.string().min(1).max(80).optional(),
  }),
  z.object({ type: z.literal('notify'), person_id: z.string().min(1).max(80).optional() }),
  z.object({ type: z.literal('digest') }),
  z.object({ type: z.literal('draft'), instruction: z.string().min(1).max(200).optional() }),
])

const RuleWhenSchema = z.object({
  match: z.enum(['all', 'any']),
  conditions: z.array(RuleConditionSchema).min(1).max(12),
  except: z.array(z.string().min(1).max(320)).max(200).optional(),
})

const RuleScopeSchema = z.object({
  kind: z.enum(['brand', 'account', 'personal']),
  account: z.string().min(3).max(320).optional(),
})

const RuleDraftBody = z.object({
  name: z.string().min(1).max(60),
  scope: RuleScopeSchema.optional(),
  when: RuleWhenSchema,
  actions: z.array(RuleActionSchema).min(1).max(10),
  origin_text: z.string().max(1000),
  enabled: z.boolean().optional(),
})

const RulePatchBody = z.object({
  revision: z.number().int().min(0),
  name: z.string().min(1).max(60).optional(),
  scope: RuleScopeSchema.optional(),
  when: RuleWhenSchema.optional(),
  actions: z.array(RuleActionSchema).min(1).max(10).optional(),
  enabled: z.boolean().optional(),
  origin_text: z.string().max(1000).optional(),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
})

const RuleOrderBody = z.object({ ids: z.array(z.string().min(1).max(80)).max(500) })

const RuleProposeBody = z.object({
  text: z.string().min(1).max(1000),
  rule_id: z.string().min(1).max(80).optional(),
  revision: z.number().int().min(0).optional(),
})

const RuleExcludeBody = z.object({ rule_id: z.string().min(1).max(80) })

const DigestAckBody = z.object({ message_ids: z.array(z.string().min(1)).max(1000).optional() })

const KindBody = z.object({ kind: z.enum(KINDS), remember_sender: z.boolean().optional() })

const ClaimBody = z.object({ as: z.enum(['notice', 'me', 'none']) })

const NoticeAckBody = z.object({
  kind: z.enum(KINDS).optional(),
  suspicious: z.boolean().optional(),
  thread_ids: z.array(z.string().min(1).max(400)).max(500).optional(),
})

const LabelsBody = z.object({ labels: z.array(z.string().min(1).max(64)).max(20) })

const LabelBody = z.object({
  id: z.string().min(1).max(64),
  name_zh: z.string().min(1).max(60),
  name_en: z.string().min(1).max(60),
  color: z.string().min(1).max(32),
})

const MergeLabelsBody = z.object({
  from: z.string().min(1).max(64),
  into: z.string().min(1).max(64),
})

const DraftBody = z.object({
  id: z.string().max(120).optional(),
  account: z.string().max(320).optional(),
  thread_id: z.string().max(400).optional(),
  in_reply_to: z.string().max(400).optional(),
  to: z.array(AddressSchema).max(100).optional(),
  cc: z.array(AddressSchema).max(100).optional(),
  bcc: z.array(AddressSchema).max(100).optional(),
  subject: z.string().max(500).optional(),
  text: z.string().max(200_000).optional(),
})

const SendBody = z.object({
  draft_id: z.string().max(120).optional(),
  account: z.string().max(320).optional(),
  thread_id: z.string().max(400).optional(),
  in_reply_to: z.string().max(400).optional(),
  to: z.array(AddressSchema).max(100).optional(),
  cc: z.array(AddressSchema).max(100).optional(),
  bcc: z.array(AddressSchema).max(100).optional(),
  subject: z.string().max(500).optional(),
  text: z.string().max(200_000).optional(),
})

const ImagesBody = z.object({ always: z.boolean().optional() })

/** WP442：系统规则「发出 N 个工作日没回 → 提醒我」；给 `account` 只改那只邮箱（`reset` = 回到跟着总设置）。 */
const FollowUpSettingsBody = z.object({
  enabled: z.boolean().optional(),
  business_days: z.number().int().min(1).max(15).optional(),
  account: z.string().min(3).max(320).optional(),
  reset: z.boolean().optional(),
})

const FollowUpActionBody = z.object({ action: z.enum(['stop', 'wait', 'resume', 'nudge']) })

const BackfillBody = z.object({
  account: z.string().max(320).optional(),
  folder: z.string().max(200).optional(),
  days: z.number().int().min(1).max(3650).optional(),
})

function queryOf(c: Parameters<typeof principalOf>[0]): MessageListQuery {
  const q = (name: string): string | undefined => {
    const raw = c.req.query(name)
    return raw === undefined || raw.trim() === '' ? undefined : raw.trim()
  }
  const folder_kind = q('folder_kind')
  const routeName = q('route')
  return {
    ...(q('folder') === undefined ? {} : { folder: q('folder') as string }),
    ...(folder_kind === undefined
      ? {}
      : { folder_kind: folder_kind as MessageListQuery['folder_kind'] }),
    ...(q('account') === undefined ? {} : { account: q('account') as string }),
    ...(q('label') === undefined ? {} : { label: q('label') as string }),
    ...(routeName === undefined ? {} : { route: routeName as MessageListQuery['route'] }),
    ...(q('unread') === 'true' ? { unread: true } : {}),
    ...(q('starred') === 'true' ? { starred: true } : {}),
    ...(q('q') === undefined ? {} : { q: q('q') as string }),
    ...(q('pending_route') === 'true' ? { pending_route: true } : {}),
    ...(q('claim') === 'unclaimed' || q('claim') === 'notice'
      ? { claim: q('claim') as 'unclaimed' | 'notice' }
      : {}),
    ...(intParam(c, 'limit') === undefined ? {} : { limit: intParam(c, 'limit') as number }),
  }
}

const LIST_PARAMS = [
  { name: 'folder', in: 'query' as const, description: '文件夹真名（`INBOX` / `KefuAgents`）' },
  {
    name: 'folder_kind',
    in: 'query' as const,
    description: '文件夹语义（收件箱 / 已发 / 垃圾箱 …）',
  },
  { name: 'account', in: 'query' as const, description: '只看这一只邮箱；不给 = 全部邮箱' },
  { name: 'label', in: 'query' as const, description: '只看这个标签' },
  { name: 'route', in: 'query' as const, description: 'inbox / support / kol' },
  { name: 'unread', in: 'query' as const, description: '`true` = 只看未读' },
  { name: 'starred', in: 'query' as const, description: '`true` = 只看星标' },
  { name: 'q', in: 'query' as const, description: '搜索：发件人 / 主题 / 正文 / 标签 / 文件夹' },
  {
    name: 'pending_route',
    in: 'query' as const,
    description: '`true` = 只看「待确认」：分拣判不准、没开事项、等人点「这是客服」的那几封',
  },
  {
    name: 'claim',
    in: 'query' as const,
    description:
      '`unclaimed` = 只看「没人接的」（消息页默认视图）；`notice` = 只看「只是通知」那几捆（WP212）',
  },
  {
    name: 'limit',
    in: 'query' as const,
    description: '最多几条',
    schema: { type: 'integer' as const },
  },
]

export function messageRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/messages/accounts',
        operationId: 'listMessageAccounts',
        summary: '连着哪几只邮箱 + 每只的文件夹与未读数（"全部邮箱"那一排）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ accounts: MessageAccountView[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).accounts(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/overview',
        operationId: 'getMessageOverview',
        summary:
          '「没人接的」顶上那一行（已交给岗位 N · 卡片流里 N 张等你批）、「只是通知」几捆、「你教过它」（WP212）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'MessageOverview',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.overview === undefined)
          throw new ApiError('not_implemented', '这个服务进程的消息面还没有「没人接的」总览')
        return ok(c, await port.overview(actorOf(c)))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/notices/ack',
        operationId: 'ackMessageNotices',
        summary:
          '「只是通知」整捆「知道了」：按类型一捆（或可疑那一捆、或点名几条）；标已读跟随「客信怎么动邮箱」开关（WP212）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: NoticeAckBody,
        returns: '{ acked: number; writeback?: MessageWriteback }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.ackNotices === undefined)
          throw new ApiError('not_implemented', '这个服务进程的消息面还没有「只是通知」')
        return ok(
          c,
          await port.ackNotices(
            actorOf(c),
            (await body(c, NoticeAckBody)) as MessageNoticeAckInput,
          ),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/labels',
        operationId: 'listMessageLabels',
        summary: '标签清单（内置十一个 + 用户自建的）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ labels: MessageLabel[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).labels(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/labels',
        operationId: 'putMessageLabel',
        summary: '新建或改一个标签（内置的只能改名改色，删不掉）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: LabelBody,
        returns: '{ label: MessageLabel }',
      },
      async (c, deps) => {
        const input = await body(c, LabelBody)
        return ok(c, await portOf(deps).putLabel(actorOf(c), { ...input, builtin: false }), 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/labels/merge',
        operationId: 'mergeMessageLabels',
        summary: '合并两个标签：`from` 上的信改挂 `into`，然后删掉 `from`',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: MergeLabelsBody,
        returns: '{ moved: number; labels: MessageLabel[] }',
      },
      async (c, deps) => {
        const input = await body(c, MergeLabelsBody)
        return ok(c, await portOf(deps).mergeLabels(actorOf(c), input.from, input.into))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/messages/labels/:id',
        operationId: 'deleteMessageLabel',
        summary: '删一个自建标签（会从所有信上摘干净）。内置的删不掉',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ deleted: boolean }',
      },
      async (c, deps) => ok(c, await portOf(deps).deleteLabel(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/rules',
        operationId: 'listMessageSenderRules',
        summary: '你教过的发件人规则（"以后这个发件人都这样"）：命中数、谁教的、刚删的几条',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'SenderRuleList',
      },
      async (c, deps) => ok(c, await portOf(deps).senderRules(actorOf(c))),
    ),
    route(
      {
        method: 'delete',
        path: '/v1/messages/rules/:id',
        operationId: 'deleteMessageSenderRule',
        summary: '撤掉一条发件人规则（当场生效：下一封那个发件人重新判）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ deleted: boolean; rule?: SenderRule }',
      },
      async (c, deps) => ok(c, await portOf(deps).deleteSenderRule(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/rules/:id/restore',
        operationId: 'restoreMessageSenderRule',
        summary: '撤回刚删的一条发件人规则（WP439，决策 243：删了能撤回）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ restored: boolean; rule?: SenderRule }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.restoreSenderRule === undefined)
          throw new ApiError('not_implemented', '这台机器上删掉的规则撤不回来')
        return ok(c, await port.restoreSenderRule(actorOf(c), param(c, 'id')))
      },
    ),
    /* ── WP441：消息规则（老的 `/v1/messages/rules` 是发件人规则，不动；决策 1356） ── */
    route(
      {
        method: 'get',
        path: '/v1/messages/message-rules',
        operationId: 'listMessageRules',
        summary:
          '消息规则清单（「什么样的信 → 做什么」；顺序就是优先级），带系统规则「今天的简报」（WP441）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'MessageRuleList',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.messageRules === undefined)
          throw new ApiError('not_implemented', '这个服务进程还没有消息规则')
        return ok(c, await port.messageRules(actorOf(c)))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/message-rules',
        operationId: 'createMessageRule',
        summary:
          '建一条消息规则（表单）。动作只有交给岗位 / 只是通知 / 打标签 / 记到某处 / 告诉我 / 进简报 / 起草回复（出卡），没有外发（WP441）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: RuleDraftBody,
        returns: '{ rule: MessageRule }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.createMessageRule === undefined)
          throw new ApiError('not_implemented', '这个服务进程还没有消息规则')
        const input = (await body(c, RuleDraftBody)) as MessageRuleDraft
        return ok(c, await port.createMessageRule(actorOf(c), input), 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/message-rules/trial',
        operationId: 'trialMessageRule',
        summary:
          '试跑一条规则草案：写死条件跑最近 30 天全部，AI 条件最多试最近 50 封；不落库、不执行动作（WP441）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: RuleDraftBody,
        returns: 'MessageRuleTrial',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.trialMessageRule === undefined)
          throw new ApiError('not_implemented', '这个服务进程还没有消息规则')
        const input = (await body(c, RuleDraftBody)) as MessageRuleDraft
        return ok(c, await port.trialMessageRule(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/message-rules/propose',
        operationId: 'proposeMessageRule',
        summary:
          '一句话 → 规则草案 + 试跑 + 「要建这条规则吗」卡（规则只能由人的话建；建了才生效）（WP441）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: RuleProposeBody,
        returns: 'MessageRuleProposal',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.proposeMessageRule === undefined)
          throw new ApiError('not_implemented', '这个服务进程还没有消息规则')
        const input = (await body(c, RuleProposeBody)) as MessageRuleProposeInput
        return ok(c, await port.proposeMessageRule(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/message-rules/order',
        operationId: 'reorderMessageRules',
        summary: '拖动排序：给规则的新顺序（排最前的优先定去向）（WP441）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: RuleOrderBody,
        returns: 'MessageRuleList',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.reorderMessageRules === undefined)
          throw new ApiError('not_implemented', '这个服务进程还没有消息规则')
        return ok(c, await port.reorderMessageRules(actorOf(c), (await body(c, RuleOrderBody)).ids))
      },
    ),
    route(
      {
        method: 'patch',
        path: '/v1/messages/message-rules/:id',
        operationId: 'updateMessageRule',
        summary:
          '改一条消息规则（开关、名字、条件、动作；系统规则改时间）。带版本号，拿旧版本改的回 409（WP441）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: RulePatchBody,
        returns: '{ rule: MessageRule }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.updateMessageRule === undefined)
          throw new ApiError('not_implemented', '这个服务进程还没有消息规则')
        const input = (await body(c, RulePatchBody)) as MessageRulePatch
        return ok(c, await port.updateMessageRule(actorOf(c), param(c, 'id'), input))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/messages/message-rules/:id',
        operationId: 'deleteMessageRule',
        summary: '删一条消息规则（当场生效；系统规则删不掉，只能关）（WP441）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ deleted: boolean }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.deleteMessageRule === undefined)
          throw new ApiError('not_implemented', '这个服务进程还没有消息规则')
        return ok(c, await port.deleteMessageRule(actorOf(c), param(c, 'id')))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/message-rules/:id/restore',
        operationId: 'restoreMessageRule',
        summary: '撤回刚删的一条消息规则（7 天内；决策 243：删了能撤回）（WP441）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ restored: boolean; rule?: MessageRule }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.restoreMessageRule === undefined)
          throw new ApiError('not_implemented', '这台机器上删掉的消息规则撤不回来')
        return ok(c, await port.restoreMessageRule(actorOf(c), param(c, 'id')))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/digest',
        operationId: 'getMessageDigest',
        summary: '今天的简报：命中「进今天的简报」、还没点「知道了」的信，按规则分组（WP441）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'MessageDigest',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.digest === undefined)
          throw new ApiError('not_implemented', '这个服务进程还没有今天的简报')
        return ok(c, await port.digest(actorOf(c)))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/digest/ack',
        operationId: 'ackMessageDigest',
        summary: '简报「全部知道了」（或点名几封）（WP441）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: DigestAckBody,
        returns: '{ acked: number }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.ackDigest === undefined)
          throw new ApiError('not_implemented', '这个服务进程还没有今天的简报')
        const input = await body(c, DigestAckBody)
        return ok(c, await port.ackDigest(actorOf(c), input.message_ids))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/follow-ups',
        operationId: 'listMessageFollowUps',
        summary: '「等对方回」：我们发出去、对方还没回的会话（到期早的在前；WP442 回信跟进）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ rows: MessageFollowUpRow[] }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.followUps === undefined)
          throw new ApiError('not_implemented', '这台机器上没有回信跟进')
        return ok(c, await port.followUps(actorOf(c)))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/follow-ups/settings',
        operationId: 'getMessageFollowUpSettings',
        summary: '系统规则「发出 N 个工作日没回 → 提醒我」：天数、开关、按邮箱分开设的几只',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'MessageFollowUpSettings',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.followUpSettings === undefined)
          throw new ApiError('not_implemented', '这台机器上没有回信跟进')
        return ok(c, await port.followUpSettings(actorOf(c)))
      },
    ),
    route(
      {
        method: 'patch',
        path: '/v1/messages/follow-ups/settings',
        operationId: 'setMessageFollowUpSettings',
        summary: '改系统规则「发出 N 个工作日没回 → 提醒我」（给 account 只改那只邮箱）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: FollowUpSettingsBody,
        returns: 'MessageFollowUpSettings',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.setFollowUpSettings === undefined)
          throw new ApiError('not_implemented', '这台机器上没有回信跟进')
        return ok(
          c,
          await port.setFollowUpSettings(
            actorOf(c),
            (await body(c, FollowUpSettingsBody)) as MessageFollowUpSettingsPatch,
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/threads/:id/follow-up',
        operationId: 'actOnMessageFollowUp',
        summary:
          '「等对方回」那一行上直接点：stop 不用跟了 / wait 再等等（顺延 3 个工作日）/ resume 接着跟 / nudge 现在就出催促卡',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: FollowUpActionBody,
        returns: '{ follow_up: MessageFollowUp }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.followUpAction === undefined)
          throw new ApiError('not_implemented', '这台机器上没有回信跟进')
        const input = (await body(c, FollowUpActionBody)) as { action: MessageFollowUpAction }
        return ok(c, await port.followUpAction(actorOf(c), param(c, 'id'), input.action))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/drafts',
        operationId: 'listMessageDrafts',
        summary: '草稿箱（自动保存的那几份）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ drafts: MessageDraft[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).drafts(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/drafts',
        operationId: 'saveMessageDraft',
        summary: '存一份草稿（写信框每隔几秒自动打这一条）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: DraftBody,
        returns: '{ draft: MessageDraft }',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).saveDraft(actorOf(c), await body(c, DraftBody)), 201),
    ),
    route(
      {
        method: 'delete',
        path: '/v1/messages/drafts/:id',
        operationId: 'discardMessageDraft',
        summary: '丢掉一份草稿',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ deleted: boolean }',
      },
      async (c, deps) => ok(c, await portOf(deps).discardDraft(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/send',
        operationId: 'sendMessage',
        summary:
          '发一封信（**人自己按的发送**）。走现有 outbox 七态 + 对账，不出卡——36「只有要人拍板的才是卡」',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        outbound: true,
        body: SendBody,
        returns: 'MessageSendResult',
      },
      async (c, deps) => ok(c, await portOf(deps).send(actorOf(c), await body(c, SendBody)), 201),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/sync',
        operationId: 'syncMessages',
        summary: '立刻收一次（调度器每分钟自己也会收）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'MessageSyncReport',
      },
      async (c, deps) => ok(c, await portOf(deps).sync(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/backfill',
        operationId: 'backfillMessages',
        summary: '再往前取（首次只回溯 30 天 / 2000 封）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: BackfillBody,
        returns: '{ floor: string }',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).backfill(actorOf(c), await body(c, BackfillBody))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/threads/:id',
        operationId: 'getMessageThread',
        summary: '一条会话里的全部信 + 顶上那条"客服 Agent 在处理"的状态带（63 §9）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'MessageThreadView',
      },
      async (c, deps) => ok(c, await portOf(deps).thread(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/:id/assistant',
        operationId: 'getMailAssistant',
        summary: '右栏那一格：本封摘要、回复建议（**打开时才生成并缓存**）、发件人是谁、相关待办',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'MailAssistantView',
      },
      async (c, deps) => ok(c, await portOf(deps).assistant(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/flags',
        operationId: 'setMessageFlags',
        summary: '已读 / 星标 / 已回。**回写 IMAP**——回到自己的邮箱软件看到的是同一个状态',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: FlagsBody,
        returns: '{ message: MessageRecord; writeback?: MessageWriteback }',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).setFlags(actorOf(c), param(c, 'id'), await body(c, FlagsBody))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/move',
        operationId: 'moveMessage',
        summary:
          '挪一封信（移到客服 / 移到红人 / 移回收件箱 / 归档 / **删除 = 移到垃圾箱**）；可顺手写一条发件人规则',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: MoveBody,
        returns: '{ message: MessageRecord; rule?: SenderRule; writeback?: MessageWriteback }',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).move(
            actorOf(c),
            param(c, 'id'),
            (await body(c, MoveBody)) as MessageMoveInput,
          ),
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/confirm-route',
        operationId: 'confirmMessageRoute',
        summary:
          '人工分拣（写事件）：「这是客服」交给客服那一路（开事项、起 Run），「不是」只记人的判断；WP212 起「交给 X」推广到所有岗位（`route: position` + `position_id`）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ConfirmRouteBody,
        returns: 'MessageConfirmRouteResult',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.confirmRoute === undefined)
          throw new ApiError('not_implemented', '这个服务进程的消息面没有「待确认」这一栏')
        return ok(
          c,
          await port.confirmRoute(
            actorOf(c),
            param(c, 'id'),
            (await body(c, ConfirmRouteBody)) as MessageConfirmRouteInput,
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/rule-exclude',
        operationId: 'excludeFromMessageRule',
        summary: '「这封不该归它」：给那条消息规则加这个发件人的排除，当场生效（WP441）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: RuleExcludeBody,
        returns: '{ rule: MessageRule }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.excludeFromMessageRule === undefined)
          throw new ApiError('not_implemented', '这个服务进程还没有消息规则')
        const input = await body(c, RuleExcludeBody)
        return ok(c, await port.excludeFromMessageRule(actorOf(c), param(c, 'id'), input.rule_id))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/kind',
        operationId: 'setMessageKind',
        summary:
          '改判类型（类型胶囊上的 ✎）；`remember_sender` = 以后这个发件人都这样（写发件人规则，下次不花模型）（WP212）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: KindBody,
        returns: '{ message: MessageRecord; rule?: SenderRule }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.setKind === undefined)
          throw new ApiError('not_implemented', '这个服务进程的消息面还不能改判类型')
        return ok(
          c,
          await port.setKind(
            actorOf(c),
            param(c, 'id'),
            (await body(c, KindBody)) as MessageKindInput,
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/claim',
        operationId: 'claimMessage',
        summary: '「只是通知」/「我自己处理」/ 撤销（`none`）——从「没人接的」里拿掉或放回（WP212）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ClaimBody,
        returns: '{ message: MessageRecord; writeback?: MessageWriteback }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.claim === undefined)
          throw new ApiError('not_implemented', '这个服务进程的消息面还没有「没人接的」')
        return ok(
          c,
          await port.claim(
            actorOf(c),
            param(c, 'id'),
            (await body(c, ClaimBody)) as MessageClaimInput,
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/labels',
        operationId: 'setMessageLabels',
        summary: '给一封信换一组标签（服务器支持 keyword 时顺手同步，不支持就只在本地）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: LabelsBody,
        returns: '{ message: MessageRecord }',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).setLabels(
            actorOf(c),
            param(c, 'id'),
            (await body(c, LabelsBody)).labels,
          ),
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/images',
        operationId: 'showMessageImages',
        summary:
          '显示这封信的远程图片；`always` = 以后总是信任这个发件人（默认不加载，防追踪像素）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ImagesBody,
        returns: '{ message: MessageRecord; images?: MessageImagesReport }',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).showImages(
            actorOf(c),
            param(c, 'id'),
            (await body(c, ImagesBody)).always === true,
          ),
        ),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/:id/attachments/:attachment',
        operationId: 'getMessageAttachment',
        summary: '取一个附件的字节（WP204；从受控原始材料区取，一律按「下载」给，不在页面里打开）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '附件字节（Content-Disposition 带文件名；没有 / 过了保留期 → 404）',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.attachment === undefined)
          throw new ApiError('not_implemented', '这个服务进程的消息面还取不了附件')
        const out = await port.attachment(actorOf(c), param(c, 'id'), param(c, 'attachment'))
        if (out === undefined)
          throw new ApiError('not_found', '这个附件取不到了（原件可能已过保留期）')
        return c.body(out.bytes as unknown as ArrayBuffer, 200, {
          // 一律当下载：外来文件不在工作台同源里打开（HTML / SVG 附件就是一段脚本）
          'content-type': 'application/octet-stream',
          'content-disposition': contentDisposition(out.name),
          'content-length': String(out.bytes.byteLength),
          'x-content-type-options': 'nosniff',
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/auto-replies/:id/not-direct',
        operationId: 'flagMessageAutoReply',
        summary: '「这封不该直接回」：AI 按把握直接回的那封记进学习回路，同类以后先给人批',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        // 只会让 AI 更保守（同类以后转人），看得见这条会话的人就能点（同聊天那一颗）
        authz: READ,
        returns: '{ learned }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.flagAutoReply === undefined)
          throw new ApiError('not_implemented', '这台机器没有邮件「有把握就直接回」')
        const out = await port.flagAutoReply(actorOf(c), param(c, 'id'))
        if (out === undefined)
          throw new ApiError('not_found', '这封不是 AI 直接回的（或已经找不到了）')
        return ok(c, out)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/todo',
        operationId: 'messageToTodo',
        summary: '把这封信转成一条待办（右栏那个一键）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ todo: Todo }',
      },
      async (c, deps) => ok(c, await portOf(deps).toTodo(actorOf(c), param(c, 'id')), 201),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/:id',
        operationId: 'getMessage',
        summary: '一封信（含净化过的 HTML 正文与附件元数据）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ message: MessageRecord }',
      },
      async (c, deps) => ok(c, await portOf(deps).message(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages',
        operationId: 'listMessageThreads',
        summary: '会话列表（中栏那一列）。搜索、文件夹、标签、未读、星标、多邮箱都走这一条',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: LIST_PARAMS,
        returns: '{ threads: MessageThreadSummary[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).threads(actorOf(c), queryOf(c))),
    ),
  ]
}
