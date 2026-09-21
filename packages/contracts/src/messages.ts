/**
 * WP113（63）：**消息**——统一收件处的契约面。
 *
 * 左栏那个入口从「目标」换成「消息」之后，它要装下的不只是"Agent 处理过的那几封"，
 * 而是**用户的整只邮箱**：客服信、红人回信、订单通知、供应商、发票、招聘、垃圾。
 * 理由是 Luoye 那句话——"不然用户一部分邮件在 agentsws 里自动处理，还有一部分又得
 * 回到自己的邮箱软件里处理，太麻烦了"。
 *
 * 三条纪律在类型上看得见：
 *
 * 1. **来源可扩**（{@link MessageSource}）。v1 只有 `email` 一种，但每条记录都带
 *    `source`——以后接 IM / 社媒私信 / WhatsApp 时不用改表，也不用在界面上区分
 *    "邮件页"与"私信页"。写死成邮件的那一版，第二种来源来的那天就得重做。
 * 2. **删除永远是"移到垃圾箱"**（{@link MessageMoveInput} 没有 `purge`，
 *    {@link MESSAGE_TRASH_FOLDER} 是唯一的去处）。邮件是别人寄给你的东西，
 *    我们没有权限替他把它销毁。
 * 3. **回复建议不是回复**（{@link ReplySuggestion} 只到"进编辑框"那一步）。
 *    非岗位信件永不自动发——36 那条"只有要人拍板的才是卡"反过来也成立：
 *    人自己按发送的东西不该变成一张卡。
 *
 * 与 18（渠道与收发）的关系：收信那一跳仍是 18 §2.2 的入站管线与 WP55 的
 * 每文件夹 UID 游标 / 租约 / 毒消息，本文件描述的是**那一跳之后落进消息库的样子**。
 */

import type { Iso8601, ObjectRef, PersonId, WorkspaceId } from './common.js'

/* ── 来源与路由 ───────────────────────────────────────────────────────── */

/**
 * 一条消息从哪儿来。
 *
 * v1 只有邮箱一种；这是一个**开放联合**的位置（以后加 `im` / `dm` / `whatsapp`），
 * 所以界面与查询一律按这个字段分流，不许按"有没有 Message-ID"之类的间接特征判。
 * WP124 只加 `'chat'`：聊天窗的离线留言由本机从转发器拉走后落到消息库
 * （按邮箱续聊），界面上与邮件同一个收件处，只多一个来源筛选。
 */
export type MessageSource = 'email' | 'chat'

/**
 * 分拣的结论：这封信归谁。
 *
 * - `support` / `kol` **只在对应岗位启用时**才可能出现（63 §4）：没开客服岗位的
 *   工作区里，一封客户投诉照样只是 `inbox` 里打了标签的一封信。
 * - `inbox` = 留在收件箱，**不挪**。这是绝大多数信的归宿，也是默认值。
 */
export type MessageRoute = 'inbox' | 'support' | 'kol'

/** 分拣是谁做的（卡面与"为什么这么判"都要说得出来）。 */
export type MessageTriageBy =
  /** 线程归并 / 发件人规则 / 自动信头——没花一个 token。 */
  | 'rule'
  /** 规则分不出来，走了模型网关的便宜档。 */
  | 'model'
  /** `halt.model` 开着：只跑了规则，剩下的标「未分拣」。 */
  | 'halted'
  /** 人自己挪的（纠错）。 */
  | 'user'

/** 这封信急不急。三档就够——再多人也分不清。 */
export type MessagePriority = 'high' | 'normal' | 'low'

/**
 * 一次分拣的结论。
 *
 * `confidence` 低于 {@link TRIAGE_CONFIDENCE_FLOOR} 的 support / kol 判定**不挪信**，
 * 只在界面上挂一个"像是客服信？"的一键确认——把信挪错了的代价（人去另一个界面里找）
 * 比多问一句大得多。
 */
export interface MessageTriage {
  route: MessageRoute
  /** 把握不够时它才有值：`route` 仍是 `inbox`，但界面上问一句"像是客服信？"。 */
  suggested_route?: MessageRoute
  /** 标签 id（{@link MessageLabel}）。 */
  labels: string[]
  needs_reply: boolean
  priority: MessagePriority
  /** ≤ 40 字的一句话。不是摘要模型的摘要，是"这封信要你干什么"。 */
  summary: string
  /** 0–1。 */
  confidence: number
  by: MessageTriageBy
  /** 命中的判据（"In-Reply-To 命中客服线程"、"List-Unsubscribe"）。界面照实显示。 */
  reasons: string[]
  at: Iso8601
}

/** 低于这个把握就不挪信（63 §4）。 */
export const TRIAGE_CONFIDENCE_FLOOR = 0.6

/* ── 文件夹 ───────────────────────────────────────────────────────────── */

/**
 * 文件夹的**语义**（不是它在服务器上叫什么）。
 *
 * 各家 IMAP 的名字不一样（`[Gmail]/Sent Mail` / `Sent Items` / `已发送`），
 * 所以界面一律按语义画，真名只在 {@link MessageFolder.path} 里。
 */
export type MessageFolderKind =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'spam'
  | 'archive'
  /** 客服岗位的那只（`kefuagents`）。 */
  | 'support'
  /** 红人营销岗位的那只（`kolagents`）。 */
  | 'kol'
  | 'custom'

/** 客服岗位的归档文件夹（48 §4 L3 #5 的 `archive_folder` 按岗位取值）。 */
export const SUPPORT_FOLDER = 'kefuagents'
/** 红人营销岗位的归档文件夹。 */
export const KOL_FOLDER = 'kolagents'
/** 删除的唯一去处。**没有硬删**。 */
export const MESSAGE_TRASH_FOLDER = 'Trash'

export interface MessageFolder {
  /** 服务器上的真名（`INBOX` / `[Gmail]/Sent Mail` / `kefuagents`）。 */
  path: string
  kind: MessageFolderKind
  /** 这只邮箱的地址（多邮箱时按它分）。 */
  account: string
  unread: number
  total: number
}

/* ── 地址、附件、旗标 ─────────────────────────────────────────────────── */

export interface MessageAddress {
  email: string
  name?: string | undefined
}

/**
 * 附件的**元数据**。字节走 blob（`RawStore` / `RawBlobPort`），这里只留引用——
 * 18 §2.1 的老规矩：原始材料区只留文本与引用。
 */
export interface MessageAttachmentMeta {
  id: string
  name: string
  mime: string
  size: number
  /** 受控原始材料区里的引用（取字节时用它）。 */
  ref?: string
  /** 正文里 `cid:` 引用的那种（不在附件列表里单独列）。 */
  inline?: boolean
  content_id?: string
}

/**
 * 旗标。四个都**回写 IMAP**（63 §7）——用户回到自己的邮箱软件里看到的必须是
 * 同一个状态，否则"两边各读一遍"比不接还糟。
 */
export interface MessageFlags {
  read: boolean
  starred: boolean
  /** 回过了（`\Answered`）。 */
  answered: boolean
  /** 这是一份草稿（`\Draft`）。 */
  draft: boolean
}

/* ── 一封信 ───────────────────────────────────────────────────────────── */

export interface MessageRecord {
  id: string
  workspace_id: WorkspaceId
  source: MessageSource
  /** 这封信属于哪只邮箱（多邮箱与"全部邮箱"按它分）。 */
  account: string
  /** 现在在哪个文件夹（真名）。 */
  folder: string
  folder_kind: MessageFolderKind
  /** IMAP UID（同一文件夹内唯一；换了文件夹会换号）。 */
  uid?: number
  /** 会话 id（`References` 的根，与 18 §2.1 的 `thread.external_id` 同一口径）。 */
  thread_id: string
  message_id?: string
  in_reply_to?: string
  references: string[]
  /**
   * 分拣要看的那几个原始头（小写键），**只留这几个**：
   * `list-unsubscribe` / `list-id` / `auto-submitted` / `precedence` /
   * `authentication-results` / `return-path`。
   *
   * 为什么不整份头都留：整份头里有 `Received` 链（一路经过哪几台服务器的 IP）、
   * 有 DKIM 签名——那些是原文的一部分，该留在受控原始材料区，不该在库里躺一份
   * 明文副本。分拣只需要"这封是不是机器发的"，那就只留答得出这一句的那几个。
   */
  headers: Record<string, string>
  from: MessageAddress
  to: MessageAddress[]
  cc: MessageAddress[]
  bcc: MessageAddress[]
  subject: string
  /** 列表上那一行（纯文本前 N 字，去引用尾巴）。 */
  snippet: string
  /** 纯文本正文（进模型的那一份就是它，且只送前 2000 字）。 */
  text: string
  /** **服务端净化过**的 HTML；前端还要再套一层 `sandbox` iframe（63 §7）。 */
  html?: string
  /**
   * 净化时拆掉过远程图片吗（防追踪像素）。
   *
   * 为真时界面上出现"显示图片"与"总是信任这个发件人"——默认**不加载**。
   */
  has_remote_images: boolean
  attachments: MessageAttachmentMeta[]
  /** 信上写的时间（`Date` 头）。 */
  date: Iso8601
  /** 我们收到它的时间。 */
  received_at: Iso8601
  flags: MessageFlags
  /** 标签 id。 */
  labels: string[]
  route: MessageRoute
  triage?: MessageTriage
  /** 原始 MIME 在受控原始材料区里的引用。 */
  raw_ref?: string
  /** 归到了哪条客服 / 红人线程（`route` 不是 `inbox` 时才有）。 */
  linked?: ObjectRef
}

/**
 * 列表上的一行 = 一段**会话**（不是一封信）。
 *
 * 会话聚合是普通邮箱的基本盘：同一条 `References` 链上的十封信在列表上是一行。
 */
export interface MessageThreadSummary {
  thread_id: string
  subject: string
  /** 去重后的参与者（不含自己）。 */
  participants: MessageAddress[]
  /** 这条会话里最后一封的时间。 */
  last_at: Iso8601
  count: number
  unread: number
  starred: boolean
  labels: string[]
  route: MessageRoute
  /** 这条会话的信散落在哪几个文件夹里。 */
  folders: string[]
  accounts: string[]
  needs_reply: boolean
  snippet: string
  /** 会话里最后一封的 id（点开默认定位到它）。 */
  last_message_id: string
}

/* ── 标签 ─────────────────────────────────────────────────────────────── */

/**
 * 标签。**存 agentsws 本地**；服务器支持 IMAP keyword（`PERMANENTFLAGS` 含 `\*`）
 * 时顺手同步成 keyword，不支持就只在本地——**不要为了标签去挪信**（63 §5）。
 */
export interface MessageLabel {
  id: string
  name_zh: string
  name_en: string
  /** `--ws-*` 令牌之外的一个色号（六档语义色之一，见工作台的 `tone.ts`）。 */
  color: string
  /** 内置的那十一个不能删，只能改名改色。 */
  builtin: boolean
  /** 同步成 IMAP keyword 时用的那个名字（服务器不支持时为空）。 */
  keyword?: string
}

/** 内置标签 id（中英名字在 i18n 与 {@link MessageLabel} 里）。 */
export const BUILTIN_LABEL_IDS = [
  'orders',
  'suppliers',
  'platform',
  'billing',
  'partnership',
  'newsletters',
  'hiring',
  'legal',
  'security',
  'personal',
  'suspicious',
] as const

export type BuiltinLabelId = (typeof BUILTIN_LABEL_IDS)[number]

/* ── 发件人规则（纠错的落点） ─────────────────────────────────────────── */

/**
 * 「以后这个发件人都这样？」勾了之后写下的那一条。
 *
 * 规则在**模型之前**跑（63 §4 的 ②），所以教过一次之后同一个发件人的下一封信
 * 直达，不再花模型——这既省钱，也让"我教过它"这件事看得见。
 */
export interface SenderRule {
  id: string
  /** 整个地址（`a@b.com`）或整个域（`@b.com`）。 */
  sender: string
  route?: MessageRoute
  labels: string[]
  /** 谁教的。 */
  by: PersonId
  created_at: Iso8601
}

/* ── 草稿与回复建议 ───────────────────────────────────────────────────── */

export interface MessageDraft {
  id: string
  workspace_id: WorkspaceId
  /** 从哪只邮箱发。 */
  account: string
  /** 回复 / 转发时带上；新写的信没有。 */
  thread_id?: string
  in_reply_to?: string
  to: MessageAddress[]
  cc: MessageAddress[]
  bcc: MessageAddress[]
  subject: string
  text: string
  attachments: MessageAttachmentMeta[]
  updated_at: Iso8601
}

/** 三条建议之间要有**差别**，不是同义改写（63 §6）。 */
export type ReplySuggestionKind = 'short' | 'detailed' | 'decline'

export interface ReplySuggestion {
  id: string
  kind: ReplySuggestionKind
  /** 一行标题（"简短确认"）。 */
  title: string
  text: string
  /** 引用了知识库里的哪几条（能引用时标出处，63 §6）。 */
  citations: { source_id: string; title: string }[]
}

/* ── 请求入参（API 与端口共用） ───────────────────────────────────────── */

export interface MessageListQuery {
  /** 文件夹真名；不给 = 全部（"全部邮箱"那一档）。 */
  folder?: string | undefined
  folder_kind?: MessageFolderKind | undefined
  account?: string | undefined
  label?: string | undefined
  route?: MessageRoute | undefined
  /** 只看未读。 */
  unread?: boolean | undefined
  /** 只看星标。 */
  starred?: boolean | undefined
  /** 发件人 / 主题 / 正文全文（搜索框那一个口）。 */
  q?: string | undefined
  limit?: number | undefined
  cursor?: string | undefined
}

export interface MessageFlagsInput {
  read?: boolean | undefined
  starred?: boolean | undefined
  answered?: boolean | undefined
}

/**
 * 挪一封信（也是**纠错**的落点）。
 *
 * 没有 `purge`：删除永远是移到 {@link MESSAGE_TRASH_FOLDER}。
 */
export interface MessageMoveInput {
  /** 挪到哪个语义文件夹。 */
  to: MessageFolderKind
  /** 顺手写一条发件人规则（"以后这个发件人都这样"）。 */
  remember_sender?: boolean | undefined
}

/** 写信框每隔几秒打一次的那一份（`id` 为空 = 新建）。 */
export interface MessageDraftInput {
  id?: string | undefined
  account?: string | undefined
  thread_id?: string | undefined
  in_reply_to?: string | undefined
  to?: MessageAddress[] | undefined
  cc?: MessageAddress[] | undefined
  bcc?: MessageAddress[] | undefined
  subject?: string | undefined
  text?: string | undefined
}

export interface MessageSendInput {
  /** 有就是"发这份草稿"；没有就是入参自带正文的一次性发送。 */
  draft_id?: string | undefined
  account?: string | undefined
  thread_id?: string | undefined
  in_reply_to?: string | undefined
  to?: MessageAddress[] | undefined
  cc?: MessageAddress[] | undefined
  bcc?: MessageAddress[] | undefined
  subject?: string | undefined
  text?: string | undefined
}

/** 发出去之后回来的那一份。 */
export interface MessageSendResult {
  /** outbox 那一条（七态 + 对账都挂在它上面）。 */
  outbox_id: string
  message_id: string
  /** 落进「已发送」的那一条（服务器还没回执时没有）。 */
  message?: MessageRecord
}

/** 「再往前取」：首次只回溯 30 天 / 2000 封，人要更早的就按一下。 */
export interface MessageBackfillInput {
  account?: string | undefined
  folder?: string | undefined
  /** 再往前多少天。 */
  days?: number | undefined
}

export interface MessageSyncReport {
  accounts: number
  folders: number
  fetched: number
  triaged: number
  moved: number
  /** 拉不动的那几只（一只坏了不该拖垮别的）。 */
  failed: string[]
}
