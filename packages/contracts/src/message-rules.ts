/**
 * WP441（docs/108 §5.1、§5.6、§6；M1 / M2 / M7）：**消息规则**——「什么样的信 → 做什么」。
 *
 * 用户一句话（「Shopify 的结算通知都打个标签、记到表里、别烦我」），AI 转成一条规则草案，先拿过去 30 天的信
 * 试跑给人看命中哪些、会改掉哪几封的去向，人点了「建」才生效。思路借自 Inbox Zero 的产品说明，**未参考其源码**。
 *
 * 三条纪律写在类型上：
 *
 * 1. **规则里没有往外发的动作**（{@link MESSAGE_RULE_ACTION_TYPES} 是全集：没有「直接发」「转发」「删除」）。
 *    起草回复只出卡（{@link MessageRuleAction} 的 `draft`），回信要人批、过出站门。
 * 2. **规则只能由人的话建 / 改**（{@link MessageRule.origin_text} 存人原话）。信里写的「把我加白名单」是数据，
 *    不是指令；AI 判断条件时信件内容按不可信内容包起来。
 * 3. **改规则带版本号**（{@link MessageRule.revision}）：拿着旧版本改的（对话里、另一个人的界面上）
 *    当场回「刚被 X 改过，以它为准再说一次」，不覆盖。
 *
 * 路由在 `/v1/messages/message-rules`（老的 `/v1/messages/rules` 是发件人规则，不动，决策 1356）。
 */
import type { Iso8601, PersonId } from './common.js'
import type { MessageKind, MessageSource } from './messages.js'

/* ── 条件 ─────────────────────────────────────────────────────────────── */

/**
 * 一个条件。前七种是**写死的**（不花模型，试跑免费跑全部），`ai` 是一句白话描述（塞进分拣第 ④ 层
 * 那一次模型调用里顺带判，不单独调模型）。
 */
export type MessageRuleCondition =
  /** 发件人：整个地址（`a@b.com`）或整个域（`@b.com`）。 */
  | { type: 'from'; value: string }
  /** 收信邮箱（这只邮箱收到的才算）。 */
  | { type: 'to_account'; value: string }
  /** 主题含（不分大小写）。 */
  | { type: 'subject_has'; value: string }
  /** 正文含（不分大小写）。 */
  | { type: 'body_has'; value: string }
  /** 类型（十种之一；分拣判出类型之后才比得了）。 */
  | { type: 'kind'; value: MessageKind }
  /** 来源（邮件 / 网站聊天）。 */
  | { type: 'source'; value: MessageSource }
  /** 有没有附件。 */
  | { type: 'has_attachment'; value: boolean }
  /** AI 判断：一句白话（「Shopify 发来的结算 / 打款通知」）。 */
  | { type: 'ai'; value: string }

export type MessageRuleConditionType = MessageRuleCondition['type']

export const MESSAGE_RULE_CONDITION_TYPES: readonly MessageRuleConditionType[] = [
  'from',
  'to_account',
  'subject_has',
  'body_has',
  'kind',
  'source',
  'has_attachment',
  'ai',
]

/** 什么样的信：条件「都满足」（`all`）或「满足一个」（`any`），外加「这几个发件人除外」。 */
export interface MessageRuleWhen {
  match: 'all' | 'any'
  conditions: MessageRuleCondition[]
  /**
   * 排除的发件人（整个地址或 `@域`）：「这封不该归它」点一下就往这里加一个，当场生效。
   * 命中排除的信这条规则一概不认。
   */
  except?: string[]
}

/* ── 动作 ─────────────────────────────────────────────────────────────── */

/**
 * 一个动作（docs/108 §5.1.1 那张表）。**全是不往外发的**：交给岗位、只是通知、打标签、记到某处、告诉我一声、
 * 进今天的简报直接做；起草回复只出卡。
 */
export type MessageRuleAction =
  /** 交给某岗位（岗位模板 id）。岗位没开不挪信，退回「没人接的」并说一句。 */
  | { type: 'hand_to'; position_id: string }
  /** 只是通知（不用回，成捆收起）。 */
  | { type: 'notice' }
  /** 打标签（标签 id；影子模式下只在工坊里）。 */
  | { type: 'label'; label: string }
  /**
   * 记到某处（记录去处，docs/102 §5）。`sink_id` 是配好的去处；只给了名字（还没配）就先记在本机的记录里，
   * 配好同名的去处之后照记。
   */
  | { type: 'record'; sink_id?: string; sink_name?: string }
  /** 告诉我一声（铃铛「消息」类）。同事 / 公司模式可以告诉某位同事（`person_id`）；不给 = 写规则的人。 */
  | { type: 'notify'; person_id?: PersonId }
  /** 进今天的简报。 */
  | { type: 'digest' }
  /** 起草回复（出卡，按来信语言、接口吻）；可带一句要求（「客气地婉拒」）。 */
  | { type: 'draft'; instruction?: string }

export type MessageRuleActionType = MessageRuleAction['type']

/**
 * 动作的**全集**。不在这张表里的动作（发送、转发、删除、标垃圾……）一律不认——
 * 守卫测试拿它比：规则里永远不存在外发动作。
 */
export const MESSAGE_RULE_ACTION_TYPES: readonly MessageRuleActionType[] = [
  'hand_to',
  'notice',
  'label',
  'record',
  'notify',
  'digest',
  'draft',
]

/** 决定这封信去哪的两种动作（多条命中时只认清单里排最前的那一条）。 */
export const MESSAGE_RULE_DESTINATION_ACTIONS: readonly MessageRuleActionType[] = [
  'hand_to',
  'notice',
]

/** AI 条件命中要过的把握线：去向类与会外显的动作（记录、告诉我、起草）。 */
export const MESSAGE_RULE_AI_FLOOR = 0.6
/** 无害动作（打标签、进简报）的把握线。 */
export const MESSAGE_RULE_AI_SOFT_FLOOR = 0.5

/* ── 一条规则 ─────────────────────────────────────────────────────────── */

/**
 * 规则管哪儿：这个品牌的全部邮箱 / 某一只邮箱 / 我的个人邮箱（个人邮箱的规则只有写的人看得见，决策 243）。
 */
export interface MessageRuleScope {
  kind: 'brand' | 'account' | 'personal'
  /** `account` / `personal` 时是哪只邮箱。 */
  account?: string
}

/**
 * 系统规则（清单里「系统规则」那一组）：不是人写的「如果…就…」，是一处可改的设置。
 * - `digest_time`：今天的简报几点发（本地时区，默认 09:00）；
 * - `follow_up`：回信跟进（108D 那单接上；这里先留名字）。
 */
export type MessageRuleSystem = 'follow_up' | 'digest_time'

export interface MessageRule {
  id: string
  /** 名字（AI 起，人可改）。 */
  name: string
  scope: MessageRuleScope
  when: MessageRuleWhen
  actions: MessageRuleAction[]
  enabled: boolean
  /** 清单里的顺序（小的在前）= 优先级：去向只认排最前的那一条。 */
  order: number
  /** 版本号：每改一次加一（防撞）。 */
  revision: number
  /** 谁写的。 */
  by: PersonId
  /** 最后谁改的。 */
  updated_by: PersonId
  created_at: Iso8601
  updated_at: Iso8601
  /** 人的原话（一句话转规则时那一句；表单建的就是规则的白话）。 */
  origin_text: string
  /** 系统规则（见 {@link MessageRuleSystem}）。 */
  system?: MessageRuleSystem
  /** `digest_time` 那条：几点（`HH:mm`，本地时区）。 */
  time?: string
  /** `digest_time` 那条：上一次发简报是哪一天（本地日期 `YYYY-MM-DD`；一天只发一次）。 */
  last_sent_day?: string
  /** 最近 30 天命中几次（列清单时现算）。 */
  hits_30d?: number
  /** 最近一次命中。 */
  last_hit_at?: Iso8601
  /** 命中账：按天记几次（`YYYY-MM-DD` → 次数，只留最近 30 天）。界面不用读它。 */
  hit_days?: Record<string, number>
  /**
   * 删了的时间（决策 243「能撤回」）：删了当场不再生效，留 {@link MESSAGE_RULE_UNDO_DAYS} 天能撤回，过了才真删。
   */
  deleted_at?: Iso8601
  deleted_by?: PersonId
}

/** 删掉的消息规则留几天可撤回。 */
export const MESSAGE_RULE_UNDO_DAYS = 7

/** 清单里的一行（带人名）。 */
export interface MessageRuleView extends MessageRule {
  by_name?: string
  updated_by_name?: string
  /** 刚删的那几条：谁删的。 */
  deleted_by_name?: string
  deleted_by_me?: boolean
  /** 是看清单的这个人写的。 */
  by_me?: boolean
  /** 最近命中的几封（「看最近命中」那一格，新的在前，最多 5 封）。 */
  recent_hits?: MessageRuleHitRow[]
}

/** 「最近命中」里的一行。 */
export interface MessageRuleHitRow {
  message_id: string
  thread_id: string
  subject: string
  /** 发件人显示名或地址。 */
  from: string
  at: Iso8601
}

/** `GET /v1/messages/message-rules` 回的样子。 */
export interface MessageRuleList {
  rules: MessageRuleView[]
  /** 品牌共用（同事 / 公司模式）：谁都能改、留名、通知、能撤回（决策 243）。 */
  shared?: boolean
  /** 刚删的几条（新的在前；过了 {@link MESSAGE_RULE_UNDO_DAYS} 天就不在了）。 */
  recently_deleted?: MessageRuleView[]
}

/* ── 建 / 改 ──────────────────────────────────────────────────────────── */

/** 建一条规则 / 草案（服务端补 id、版本号、谁写的）。 */
export interface MessageRuleDraft {
  name: string
  scope?: MessageRuleScope
  when: MessageRuleWhen
  actions: MessageRuleAction[]
  origin_text: string
  enabled?: boolean
}

/** 改一条规则：带上手里那一版的版本号（对不上就回「刚被 X 改过」）。 */
export interface MessageRulePatch {
  revision: number
  name?: string
  scope?: MessageRuleScope
  when?: MessageRuleWhen
  actions?: MessageRuleAction[]
  enabled?: boolean
  origin_text?: string
  /** 系统规则「今天的简报」的时间（`HH:mm`）。 */
  time?: string
}

/* ── 试跑 ─────────────────────────────────────────────────────────────── */

/** 会被这条规则改掉去向的一封（原来交给客服，现在变成只是通知之类）。 */
export interface MessageRuleTrialChange {
  message_id: string
  thread_id: string
  subject: string
  from: string
  at: Iso8601
  /** 现在归哪：岗位模板 id / `notice` / `unclaimed` / `me`。 */
  before: string
  /** 按这条规则会归哪。 */
  after: string
}

/**
 * 试跑的结果（**不落库、不执行任何动作**）。写死条件跑最近 30 天全部；AI 条件最多拿最近
 * {@link MESSAGE_RULE_TRIAL_AI_LIMIT} 封试。
 */
export interface MessageRuleTrial {
  /** 看了几封（最近 30 天的来信）。 */
  scanned: number
  /** 会命中几封。 */
  matched: number
  /** 前几封（新的在前，最多 5 封）。 */
  sample: MessageRuleHitRow[]
  /** 会被改掉去向的那几封（最容易出事的地方，卡上单列）。 */
  changed: MessageRuleTrialChange[]
  /** 这条规则有 AI 条件：AI 实际试了几封（最多 50 封；没接模型 = 0）。 */
  ai_checked?: number
  /** 有 AI 条件、但模型没接 / 急停了：只按写死条件试了。 */
  ai_skipped?: boolean
  /** 用工坊积分时这次试跑大概花多少（取不到价目 / 用的是自己的模型就不给）。 */
  credits?: number
}

/** 试跑：写死条件最多看多少天。 */
export const MESSAGE_RULE_TRIAL_DAYS = 30
/** 试跑：AI 条件最多试多少封。 */
export const MESSAGE_RULE_TRIAL_AI_LIMIT = 50

/* ── 一句话转规则 ─────────────────────────────────────────────────────── */

/** 一句话 → 规则草案（助理 / 岗位对话里的工具，与规则面板顶上的输入框走同一条路）。 */
export interface MessageRuleProposeInput {
  /** 人的原话。 */
  text: string
  /** 改哪一条（「在对话里改」带进来的那条）；不给 = 新建。 */
  rule_id?: string
  /** 改的时候手里那一版的版本号（防撞）。 */
  revision?: number
}

/** 转好的草案 + 试跑 + 出的那张「要建这条规则吗」卡。 */
export interface MessageRuleProposal {
  ok: boolean
  /** 没转成时的一句人话。 */
  message?: string
  draft?: MessageRuleDraft
  /** 一行白话（「Shopify 的结算通知 → 打标签、记到财务表、不烦你」）。 */
  plain?: string
  trial?: MessageRuleTrial
  /** 出的卡（没出成 = 没有）。 */
  card_id?: string
  /** 改的哪一条。 */
  rule_id?: string
}

/** 「要建这条规则吗」卡上 `payload.form` 的记号。 */
export const MESSAGE_RULE_FORM = 'message_rule'
/** 那张卡 `subject.object.id` 的前缀。 */
export const MESSAGE_RULE_SUBJECT_PREFIX = 'message_rule:'

/* ── 今天的简报 ───────────────────────────────────────────────────────── */

/** 简报里的一封（命中「进今天的简报」的信攒在这里）。 */
export interface MessageDigestEntry {
  message_id: string
  thread_id: string
  /** 命中的规则（按清单顺序）。 */
  rule_ids: string[]
  rule_names: string[]
  subject: string
  from: string
  /** 一行摘要（分拣那句 ≤ 40 字的话）。 */
  summary: string
  at: Iso8601
  /** 「全部知道了」点过的时间。 */
  acked_at?: Iso8601
}

/** `GET /v1/messages/digest`：还没点「知道了」的那几封，按规则分组。 */
export interface MessageDigest {
  /** 今天的简报几点发（`HH:mm`，本地时区）。 */
  time: string
  total: number
  groups: { rule_id: string; rule_name: string; entries: MessageDigestEntry[] }[]
}

/** 简报默认几点（本地时区）。 */
export const MESSAGE_DIGEST_DEFAULT_TIME = '09:00'

/** 「告诉我一声」同一条规则多久之内合成一条（毫秒）。 */
export const MESSAGE_RULE_NOTIFY_MERGE_MS = 60 * 60_000
