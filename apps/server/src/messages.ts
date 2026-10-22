/**
 * WP113（63）：**消息**在服务进程里的真装配。
 *
 * 这一层把四样东西接到一起，自己不写业务：
 *
 * | 来自 | 什么 |
 * |---|---|
 * | `@agentsws/channels` 的 `messages/*` | 消息库、全量同步、分拣的规则层、净化、回复建议的骨架 |
 * | `./connections.ts` | 现在连着哪几只邮箱 + 口令来源（**不新增任何凭据入口**，63 §2） |
 * | `./channels.ts` | 受控原始材料区、outbox 七态 + 对账、真 SMTP |
 * | 模型网关 | 分拣第 ④ 层与回复建议那两处**唯一**的模型调用（63 §10） |
 *
 * 三条纪律在这个文件里落地：
 *
 * 1. **岗位没开就不挪信**。`support_enabled` / `kol_enabled` 每次现查
 *    （看这个品牌里有没有人持着客服 / 红人那几条职责），不缓存——岗位是会变的，
 *    缓存了就会出现"昨天开了今天关了，信还在往 KefuAgents 里挪"。
 * 2. **日志不打正文与完整邮箱地址**（63 §10）。这个文件里每一条 `appendEvent`
 *    的 payload 都只有计数与遮掩过的地址（`a***@b.com`）。
 * 3. **回复建议按需生成**：只有 `GET /v1/messages/:id/assistant` 会触发，
 *    而且缓存 30 分钟。全量预生成是最贵的错法。
 */

import { join } from 'node:path'
import type {
  MailAssistantView,
  MessageAccountView,
  MessageActor,
  MessageAutoReplyMark,
  MessagesPort,
  MessageThreadView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  CredentialSource,
  MailboxAccount,
  MailboxActionRecord,
  MailboxStateStore,
  MailboxWriter,
  MailSource,
  MessageStore,
  RawEmailMessage,
  RawStore,
  RemoteImageLoader,
  SuggestModel,
  SuggestRequest,
  SupportMailboxSwitches,
  TriageContext,
  TriageModel,
} from '@agentsws/channels'
import {
  aggregateThreads,
  applySupportMailboxActions,
  createRemoteImageLoader,
  folderKindOf,
  folderPathFor,
  ImapMailboxWriter,
  ImapMailSource,
  inlineRemoteImages,
  isAgentFolderKind,
  kindOfLegacy,
  MailboxSync,
  MemoryMailboxStateStore,
  MemoryMessageStore,
  mailboxFoldersFrom,
  matchSenderRule,
  POSITION_OF_ROUTE,
  positionForKind,
  promisedReplyAt,
  ReplySuggester,
  recordSenderRuleHit,
  restoreRemoteImages,
  routeOfPosition,
  SqliteMailboxStateStore,
  SqliteMessageStore,
  SUGGEST_PROMPT_MARKER,
  senderRuleForList,
  suggestFor,
  supportIntakeKey,
  supportMailboxSwitches,
  triageMessage,
  undoableDeletedRules,
  userVerdict,
  withAiHand,
} from '@agentsws/channels'
import type {
  ApprovalItem,
  Clock,
  DeletedSenderRule,
  EventEnvelope,
  Halt,
  Iso8601,
  MessageBackfillInput,
  MessageClaimInput,
  MessageConfirmRouteInput,
  MessageConfirmRouteResult,
  MessageCorrection,
  MessageDraft,
  MessageDraftInput,
  MessageFlagsInput,
  MessageFolderKind,
  MessageFollowUp,
  MessageFollowUpAction,
  MessageFollowUpRow,
  MessageFollowUpSettings,
  MessageFollowUpSettingsPatch,
  MessageGuessRow,
  MessageImagesReport,
  MessageKind,
  MessageKindInput,
  MessageLabel,
  MessageListQuery,
  MessageMoveInput,
  MessageNoticeAckInput,
  MessageOverview,
  MessagePositionOption,
  MessageRecord,
  MessageRehandInput,
  MessageRehandResult,
  MessageRoute,
  MessageSendInput,
  MessageSendResult,
  MessageSyncReport,
  MessageThreadSummary,
  MessageTriage,
  MessageWriteback,
  ModelGateway,
  PersonId,
  ReplySuggestion,
  ReplySuggestionKind,
  RoleId,
  SenderRule,
  SenderRuleList,
  SenderRuleView,
  Todo,
  WorkspaceId,
} from '@agentsws/contracts'
import { KOL_FOLDER, SUPPORT_FOLDER } from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import type { Work } from '@agentsws/work'
import type { B2bMail } from './b2b-mail.js'
import type {
  DirectMailInput,
  DirectMailResult,
  SupportMailIntake,
  SupportMailIntakeResult,
} from './channels.js'
import { OUTBOUND_HALTED } from './channels.js'
import type { MailAccount } from './connections.js'
import { MailboxActionFailures, mailboxActionEvent, maskAddress } from './mailbox-actions.js'
import {
  type MailboxSwitchPatch,
  type MailboxSwitchSettings,
  MailboxSwitchStore,
} from './mailbox-switches.js'
import { MESSAGE_RULE_DRAFT_FORM } from './message-rule-cards.js'
import {
  createMessageRuleService,
  type MessageRuleService,
  type MessageRuleServiceOptions,
  TRIAGE_RULES_SYSTEM,
} from './message-rules.js'
import { replyLanguage } from './reply-language.js'

/** 客服岗位的那几条职责（开了其中任何一条就算"启用了客服岗位"）。 */
const SUPPORT_ROLE_PREFIXES = ['dtc.support', 'dtc.aftersales', 'dtc.live-chat', 'support.']
/** 红人营销那几条。 */
const KOL_ROLE_PREFIXES = ['kol.']

export interface MessagesOptions {
  clock: Clock
  workspace_id: WorkspaceId
  /** 给了就落盘（消息库在 `messages.sqlite`，**自己一张库**）；不给全内存（测试）。 */
  dbDir?: string
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  halt: Halt
  /** 现在连着哪几只邮箱（`connections.mailAccounts()`）。**不新增凭据入口**。 */
  accounts(): MailAccount[]
  /** 口令来源（`connections.credentialSource()`）；本文件不碰值。 */
  credentials: CredentialSource
  /** 37 工作模型：转待办与"客服 Agent 在处理"要它。 */
  work?: Work
  /** 本人在这个品牌里现在持有的岗位（转待办挂谁名下）。 */
  position?(): { person_id: PersonId; assignment_id: string; role_id: RoleId } | undefined
  /** 这个品牌里现在有人持着哪几条职责（判断客服 / 红人岗位开没开）。 */
  activeRoles?(): readonly RoleId[]
  /** 模型网关；不给 = 分拣只跑规则、回复建议一条都不出（界面照实说）。 */
  models?: ModelGateway
  /** 人自己按下发送的那一封（`channels.sendMail`）。 */
  sendMail?(input: DirectMailInput): Promise<DirectMailResult>
  /** 受控原始材料区（与渠道**共用同一个**：21 §4「删这个人」不许漏掉一半）。 */
  rawStore?: RawStore
  /** 测试注入：按「邮箱 × 文件夹」开收信端。缺省真 IMAP。 */
  makeSource?(account: MailAccount, folder: string): MailSource
  /** 测试注入：回写端。缺省真 IMAP。 */
  makeWriter?(account: MailAccount): MailboxWriter
  /**
   * 这只邮箱上有哪些文件夹。缺省问回写端（真 IMAP `LIST`）；列不到按
   * {@link DEFAULT_FOLDERS} 的真名试。WP161：岗位文件夹按这份清单认已有的真名。
   */
  listFolders?(account: MailAccount): Promise<string[]>
  /** 知识库检索（回复建议引用出处时用）。不给 = 建议里没有出处。 */
  searchKnowledge?(
    text: string,
    limit: number,
  ): Promise<{ source_id: string; title: string; text: string }[]>
  /**
   * 语气与签名（个人层技能 / 记忆，54 的六层）。
   *
   * WP439（docs/108 §5.7 ①）：回复建议带上**品牌口吻**——宿主按这封信所属品牌取：这封信已归某个岗位
   * （`position_id`：交给过、或「交给 X」的主按钮）就用那条职责的口吻段，没人接的用品牌口吻。
   * 取不到 / 没写过回 `undefined`（提示词里就没有这一段）。
   */
  voice?(ctx: {
    position_id?: string | undefined
  }): string | undefined | Promise<string | undefined>
  /**
   * WP439（决策 336）：品牌默认语言（ISO 639-1：`zh` / `en` / `de`……）。回复建议按来信语言写，
   * 判不出来退回它，再不行中文。
   */
  brandLanguage?(): string | undefined
  /** WP439：规则清单里「谁教的」写名字（同事 / 公司模式）。取不到就不写。 */
  personName?(id: PersonId): string | undefined | Promise<string | undefined>
  /**
   * WP439（决策 243）：这个品牌是不是多人共用（同事互联 / 公司模式）——是的话规则清单写「谁教的」的名字，
   * 删了通知同岗位、能撤回。不给 = 个人模式。
   */
  sharedRules?(): boolean | Promise<boolean>
  /**
   * WP439（决策 243）：共用模式里有人删了 / 撤回了一条发件人规则——告诉同岗位的人一声（WP429 铃铛「同事」类，
   * 点了打开规则清单）。宿主决定发给谁（规则教过岗位 = 做那个岗位的人；没教过 = 品牌里的人），不发给 `by` 自己。
   */
  notifyRuleChange?(input: {
    by: PersonId
    action: 'deleted' | 'restored'
    rule: SenderRule
  }): void | Promise<void>
  /**
   * WP125（72 §P0-1）：**分拣判成 `support` 的来信交给客服判断层**。
   *
   * 63 定的顺序是「消息 → 分拣 → 归到 KefuAgents」；WP125 在它后面接上一步：
   * 分出来的客服信下一步必须进 `support-core` 的那套判断（意图 → 边界 → 起草 →
   * 升级 → 三道自主门），而不是直接落一条事项就完事。
   *
   * 这里只**递一次信号**：真正的判定在 `support-judgment.ts`，落卡与起 Run 在
   * `channels.ts`。不接 = 老行为（信照常归档、照常挂事项，只是没有门）。
   */
  onSupportMail?(input: {
    thread_id: string
    matter_id: string
    text: string
    subject?: string
    from?: string
  }): void | Promise<void>
  /**
   * WP163：判成客服的信在邮箱里怎么动——老产品 KefuAgent 的四个开关（影子模式 /
   * 接管 / 挪信 / 标已读）。**每封现查**。不给 = 老产品的默认值（全开、影子关）。
   *
   * 挪信只由消息同步负责（docs/63 §D「挪信归谁」）：渠道那一路在服务进程里不再挪信。
   *
   * WP167：不给 = 按连接页那只邮箱卡上的三个开关（{@link MessagesAssembly.switches}）；
   * 给了就以它为准（测试与没有界面的装配用）。按邮箱地址各一份。
   */
  supportMailbox?(account: string): Partial<SupportMailboxSwitches>
  /**
   * WP167（docs/63 §D「收信一个入口」）：判成客服的信**递进客服那一路**
   * （`channels.intakeSupportMail`：Amazon 子渠道判定、线程台账、去重、落事项、判断层、起 Run）。
   *
   * 给了它，交接就不再自己开事项、也不再调 {@link MessagesOptions.onSupportMail}——那几步
   * 都在渠道的入站管线里，这里不另写一份。不给 = 老行为（只开事项 + 递一次判断层信号）。
   */
  intakeSupport?(input: SupportMailIntake): Promise<SupportMailIntakeResult>
  /**
   * WP167 终审追加：升级那一拍预写台账（`channels.seedSupportIntake`）。接了 {@link intakeSupport}
   * 才有意义：第一次同步之前，把已有事项钉着的线程里每一封信写进"进过客服管线"的台账，
   * 于是升级后第一次扫描不会给老信再开事项、再起 Run。只做一次（台账里有标记就不再算）。
   */
  seedSupportIntake?(
    marker: string,
    keys: () => Promise<readonly string[]>,
  ): Promise<{ already: boolean; seeded: number }>
  /**
   * WP172（docs/84 §5）：B2B 那一路（`b2b-mail.ts`）。给了它，分拣开始产出 `b2b`——
   * 只在 B2B 岗位开着、而且这只邮箱卡上「收 B2B 信」开着时；判成 B2B 的信落成询盘 /
   * 往来记录（岗位开着才开事项、起 Run），再挪进这只邮箱的 `BtoBAgents`。退订与退信
   * 每封都过一遍（进抑制名单）。不给 = 老行为（一封 B2B 都不产出）。
   */
  b2b?: B2bMail
  /**
   * WP416（自查 kol C1）：红人那一路——回我们开发信的那一封认得出来（分拣按线程归到红人），
   * 交接时对上红人与合作、记往来、推阶段。不给 = 老行为（只开一件事项，不认人、不认合作）。
   */
  kol?: {
    isOurThread(thread_id: string, refs: readonly string[]): boolean
    intake(mail: {
      from_email: string
      subject: string
      text: string
      message_id?: string
      in_reply_to?: string
      references?: readonly string[]
      account?: string
      at?: string
    }): { matched: boolean; creator_id?: string; collaboration_id?: string }
  }
  /**
   * WP204：「显示图片」的本机代取（{@link createRemoteImageLoader}：只取公网 http(s)、
   * 只收图片、限大小）。测试与 demo 注入替身；不给 = 真代取。
   */
  loadRemoteImage?: RemoteImageLoader
  /**
   * WP212：这个品牌里有哪些岗位、开没开（「交给 X ▾」那一列）。不给 = 只有 63 那三条路对应的
   * 三个岗位（客服 / 红人营销 / B2B），开没开按现查的职责算。
   */
  positions?(): MessagePositionOption[]
  /**
   * WP212：「交给 X」推广到所有岗位——客服 / 红人 / B2B 之外的岗位走 54 的「交给这个岗位一件事」
   * （`positions.open`：开事项、岗位内路由挑职责、起 Run；拿不准出选择卡）。事项上钉着这条会话。
   * 交不出去（你名下没有这个岗位的职责）就抛错，界面照实说。不给 = 只能交给那三条路。
   */
  openAtPosition?(input: {
    position_id: string
    person_id: PersonId
    title: string
    summary?: string
    thread_id: string
  }): Promise<{ matter_id: string }>
  /**
   * WP212：卡片流里等你批的卡指着哪条会话 / 哪件事项（「X 在办 · 有 N 张卡等你 →」只报数，不列卡）。
   * 不给 = 数不出，界面不挂这句。
   */
  openCards?(): Promise<readonly { thread_id?: string; matter_id?: string }[]>
  /**
   * WP459（决策 1498）：改判时**撤掉原岗位还没批的卡**（指着这条会话 / 这几件事项的）。回撤了几张。
   * 不给 = 撤不了（改判照样换主人，界面照实说撤了 0 张）。
   */
  withdrawCards?(input: {
    thread_id: string
    matter_ids: readonly string[]
    reason: string
    /** 改判的人（他的队列也看一遍）。 */
    person_id: PersonId
  }): Promise<number>
  /** WP212：一次纠正（没勾「以后都这样」的改判 / 改岗位）进学习回路（24 §3 的 lesson 池）。 */
  onCorrection?(correction: MessageCorrection): void
  /**
   * WP440（docs/108 M9）：这几件事上 AI 按把握直接回的那几封（「全部」时间线那一行「AI 直接回 · 出处」）。
   * 不给 = 不画那一行。
   */
  autoReplies?(matter_ids: readonly string[]): MessageAutoReplyMark[]
  /** WP440：「这封不该直接回」。不是直接回的那封回 `undefined`。 */
  flagAutoReply?(approval_item_id: string, by: string): { learned: boolean } | undefined
  /* ── WP441（docs/108 §5.1 / §5.6）：消息规则要的几样（不给 = 那一项不做，规则照样分拣） ── */
  /** 已配好的记录去处（规则里「记到 X」对上它）。 */
  ruleSinks?: MessageRuleServiceOptions['sinks']
  /** 告诉某人一声（铃铛「消息」类）。 */
  notifyMessages?: MessageRuleServiceOptions['notify']
  /** 共用模式里有人建 / 改 / 删了消息规则。 */
  notifyMessageRuleChange?: MessageRuleServiceOptions['notifyChange']
  /** 规则「记到某处」：写进发出记录（动作 `message_rule`），按去处排写入。 */
  recordRuleMessage?: MessageRuleServiceOptions['record']
  /** 出「要建这条规则吗」卡。 */
  stageRuleCard?: MessageRuleServiceOptions['stageRuleCard']
  /**
   * 出规则起草的回信卡（正文已按来信语言、接口吻写好）。卡给谁由宿主按岗位定；回卡 id。
   */
  stageRuleDraft?(input: {
    record: MessageRecord
    rule: { id: string; name: string }
    subject: string
    text: string
    position_id?: string
  }): Promise<string | undefined>
  /** 用工坊积分时一次试跑大概多少积分。 */
  trialCredits?: MessageRuleServiceOptions['trialCredits']
  /**
   * 本地 / 品牌时区（分钟偏移）。WP441：今天的简报按它到点；WP442：分拣时抽「对方说哪天答复」按它算当地哪一天。
   * 不给 = 0（UTC）。
   */
  tzOffsetMinutes?(): number
  /**
   * WP442（docs/108 §5.3）：回信跟进（`message-follow-up.ts`，晚绑定）。给了：列表 / 会话上挂 `follow_up`，
   * 来信时撤卡收掉，「等对方回」与系统规则那几条接口有东西。不给 = 没有回信跟进。
   */
  followUp?(): MessageFollowUpHooks | undefined
}

/** WP442：消息那一层要回信跟进做的几件事（`MessageFollowUpService` 的子集，免得两个文件互相引用）。 */
export interface MessageFollowUpHooks {
  of(thread_id: string): MessageFollowUp | undefined
  noteInbound(record: Pick<MessageRecord, 'thread_id' | 'date' | 'from' | 'account'>): Promise<void>
  rows(): MessageFollowUpRow[]
  settings(): MessageFollowUpSettings
  setSettings(patch: MessageFollowUpSettingsPatch, by: PersonId): MessageFollowUpSettings
  act(
    thread_id: string,
    action: MessageFollowUpAction,
    by: PersonId,
  ): Promise<MessageFollowUp | undefined>
}

/** WP212：不进「交给 X ▾」的岗位（负责人：自己处理用「我自己回」）。 */
export const NOT_HANDABLE_POSITIONS: readonly string[] = ['owner']

/** WP212：没给 {@link MessagesOptions.positions} 时那三个岗位的名字。 */
const ROUTE_POSITION_NAMES: Record<'support' | 'kol' | 'b2b', { zh: string; en: string }> = {
  support: { zh: '客服', en: 'Customer Care' },
  kol: { zh: '红人营销', en: 'Creator Marketing' },
  b2b: { zh: 'B2B', en: 'B2B' },
}

/** WP212：分拣结论上关于「类型」的那几格（挪信 / 人工分拣重写结论时要带着走，不许冲掉）。 */
function kindFieldsOf(
  triage: MessageTriage | undefined,
): Pick<MessageTriage, 'kind' | 'kind_by' | 'kind_confidence' | 'suggested_position'> {
  if (triage === undefined) return {}
  return {
    ...(triage.kind === undefined ? {} : { kind: triage.kind }),
    ...(triage.kind_by === undefined ? {} : { kind_by: triage.kind_by }),
    ...(triage.kind_confidence === undefined ? {} : { kind_confidence: triage.kind_confidence }),
    ...(triage.suggested_position === undefined
      ? {}
      : { suggested_position: triage.suggested_position }),
  }
}

/** 发件人的域（纠正记录里只留域，63 §10）。 */
function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at < 0 ? '' : email.slice(at + 1).toLowerCase()
}

/** WP204：影子模式下归档 / 删除 / 挪信那一句（界面也按它置灰，这里是兜底）。 */
export const SHADOW_MODE_REFUSAL =
  '这只邮箱开着影子模式（只看不动），归档 / 删除不会动邮箱。要动，先在连接页把影子模式关掉。'

/**
 * 缺省要扫的文件夹真名。
 *
 * 真机器上先问服务器要一份清单（`listFolders`），问不到才用这一份试——
 * 各家名字不一样，硬编码一份名单只会在 Gmail 上跑得好、在 Outlook 上少扫两个。
 *
 * WP161：岗位那两只用与老产品相同的规范名（`KefuAgents` / `KOLAgents`）。
 */
export const DEFAULT_FOLDERS: readonly string[] = [
  'INBOX',
  'Sent',
  'Drafts',
  'Trash',
  'Junk',
  SUPPORT_FOLDER,
  KOL_FOLDER,
]

/**
 * WP167 终审追加：升级那一拍预写台账的标记（写进台账里，有它就不再算第二遍）。
 * 以后要是改了"老信"的口径需要再补一遍，换一个版本号就行。
 */
export const LEGACY_SEED_MARKER = 'meta:wp167_legacy_seed_v1'

/** WP161：每只邮箱的文件夹清单多久重列一次（第一次挪信新建的那只会随手补进去）。 */
export const FOLDER_LIST_TTL_MS = 10 * 60_000

export interface MessagesAssembly {
  store: MessageStore
  sync: MailboxSync
  port: MessagesPort
  /**
   * WP167：连接页那只邮箱卡上的三个开关（影子模式 / 挪进 KefuAgents / 标已读）。
   * 改了立刻生效（消息同步每封现查），改一次写一条 `mailbox.switches_changed`。
   */
  switches: {
    get(address: string): MailboxSwitchSettings & { takeover: boolean; b2b_position: boolean }
    set(
      address: string,
      patch: MailboxSwitchPatch,
      by: string,
    ): MailboxSwitchSettings & { takeover: boolean; b2b_position: boolean }
  }
  /** 调度器消费者：拉一轮所有邮箱的所有文件夹（顺带看今天的简报到没到点）。 */
  poll(): Promise<MessageSyncReport>
  /** WP441：消息规则（一句话转规则的工具、「要建这条规则吗」卡被决定时用它）。 */
  rules: MessageRuleService
  /**
   * WP441：规则起草的回信卡批了 → 从收信那只邮箱回（不是这种卡回 `undefined`，交给别的渠道）。
   * 出站急停、发信失败都照实回失败。
   */
  deliverRuleDraft(
    item: ApprovalItem,
  ): Promise<
    { status: 'ok' | 'failed'; error?: { message: string; retryable?: boolean } } | undefined
  >
  /**
   * WP442：这条会话在别的跟进里吗（红人 / B2B 开发信序列——回信跟进不重复盯）。客服线程不在这里判：
   * 归了客服的信路由就是 `support`，跟进那一侧按路由 / 文件夹自己认。
   */
  otherFollowUp(thread_id: string, refs: readonly string[]): boolean
  close(): void
}

export function createMessages(options: MessagesOptions): MessagesAssembly {
  const { clock, workspace_id } = options
  const store: MessageStore =
    options.dbDir === undefined
      ? new MemoryMessageStore()
      : new SqliteMessageStore({ dbPath: join(options.dbDir, 'messages.sqlite'), clock })

  /**
   * WP161：每只邮箱**各自**的文件夹清单（按连接 id 分）。`listed` = 服务器上列出来的
   * 全部（挪信时按它认岗位文件夹的真名）；`scan` = 要扫的那几只。列不到时只有 `scan`
   * （缺省名单），下一轮再列。
   */
  const folderCache = new Map<string, { listed?: string[]; scan: string[]; at: number }>()
  const writers = new Map<string, MailboxWriter>()

  const writerFor = (account: MailAccount): MailboxWriter | undefined => {
    const made = writers.get(account.connection_id)
    if (made !== undefined) return made
    const writer =
      options.makeWriter?.(account) ??
      new ImapMailboxWriter({
        config: {
          host: account.imap.host,
          port: account.imap.port,
          secure: account.imap.secure,
          user: account.imap.user,
          connection_id: account.connection_id,
        },
        credentials: options.credentials,
        onError: (e) => logQuiet('imap_writeback_failed', account.address, e),
      })
    writers.set(account.connection_id, writer)
    return writer
  }

  const logQuiet = (reason: string, address: string, e?: unknown): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type: 'inbound.dead_letter',
      actor: { kind: 'system', id: 'messages' },
      correlation: { trace_id: `tr_msg_${clock.now()}` },
      // 63 §10：不打正文，也不打完整地址
      payload: {
        reason,
        account: maskAddress(address),
        ...(e === undefined ? {} : { detail: String(e).slice(0, 200) }),
      },
    })
  }

  const foldersOf = (account: MailAccount): string[] =>
    folderCache.get(account.connection_id)?.scan ?? [...DEFAULT_FOLDERS]
  /** 挪信时认真名用的那份：列到过就用服务器的全量清单，否则用扫描清单。 */
  const knownOf = (account: MailAccount): string[] =>
    folderCache.get(account.connection_id)?.listed ?? foldersOf(account)

  /** 每只邮箱先列服务器上的文件夹（有缓存且没过期就不列）。一只列不动不拖垮别的。 */
  const refreshFolders = async (): Promise<void> => {
    const now = Date.parse(clock.now())
    for (const account of options.accounts()) {
      const cached = folderCache.get(account.connection_id)
      if (cached?.listed !== undefined && now - cached.at < FOLDER_LIST_TTL_MS) continue
      let listed: string[] = []
      try {
        listed =
          (await (options.listFolders?.(account) ?? writerFor(account)?.listFolders?.())) ?? []
      } catch (e) {
        logQuiet('imap_list_failed', account.address, e)
      }
      const scan = mailboxFoldersFrom(listed)
      folderCache.set(
        account.connection_id,
        scan === undefined ? { scan: [...DEFAULT_FOLDERS], at: now } : { listed, scan, at: now },
      )
    }
  }

  /** 挪进一只新建的岗位文件夹之后顺手记上：下一轮就扫它，不用等清单过期。 */
  const noteFolder = (account: MailAccount, path: string): void => {
    const cached = folderCache.get(account.connection_id)
    if (cached?.listed === undefined || cached.listed.includes(path)) return
    const listed = [...cached.listed, path]
    folderCache.set(account.connection_id, {
      ...cached,
      listed,
      scan: mailboxFoldersFrom(listed) ?? cached.scan,
    })
  }

  const mailboxAccounts = (): MailboxAccount[] =>
    options.accounts().map((account) => {
      const inner = writerFor(account)
      const writer: MailboxWriter | undefined =
        inner === undefined
          ? undefined
          : {
              setFlags: (folder, uid, add, remove) => inner.setFlags(folder, uid, add, remove),
              move: async (folder, uid, to) => {
                const moved = await inner.move(folder, uid, to)
                if (moved) noteFolder(account, to)
                return moved
              },
            }
      return {
        address: account.address,
        folders: foldersOf(account),
        known_folders: knownOf(account),
        open: (folder) =>
          options.makeSource?.(account, folder) ??
          new ImapMailSource({
            config: {
              host: account.imap.host,
              port: account.imap.port,
              secure: account.imap.secure,
              user: account.imap.user,
              connection_id: account.connection_id,
              mailbox: folder,
            },
            credentials: options.credentials,
          }),
        ...(writer === undefined ? {} : { writer }),
      }
    })

  /* ── 岗位开没开（每次现查，不缓存） ─────────────────────────────────── */

  const roles = (): readonly RoleId[] => options.activeRoles?.() ?? []
  const supportEnabled = (): boolean =>
    roles().some((r) => SUPPORT_ROLE_PREFIXES.some((p) => r === p || r.startsWith(p)))
  const kolEnabled = (): boolean =>
    roles().some((r) => KOL_ROLE_PREFIXES.some((p) => r.startsWith(p)))
  /** WP172：B2B 岗位开着（有人持着 `b2b.*`）——看的是 B2B 那一路自己的现查。 */
  const b2bEnabled = (): boolean => options.b2b?.enabled() ?? false
  /** 这只邮箱收不收 B2B 信：岗位开着 + 邮箱卡上「收 B2B 信」开着（缺省开）。 */
  const b2bEnabledFor = (account: string): boolean => b2bEnabled() && switchStore.get(account).b2b

  /* ── 分拣 ───────────────────────────────────────────────────────────── */

  const triageModel: TriageModel | undefined =
    options.models === undefined
      ? undefined
      : {
          classify: async (input) => classifyWithGateway(input, options, workspace_id),
        }

  /** 客服 / 红人已有线程：看工作模型里有没有钉了这条线程的事项。 */
  const knownThread = (thread_id: string, refs: readonly string[]): boolean => {
    const work = options.work
    if (work === undefined) return false
    const ids = new Set([thread_id, ...refs])
    return work
      .listMatters({ kind: 'conversation' })
      .some((m) => m.context.pinned.some((p) => p.type === 'thread' && ids.has(p.id)))
  }

  /**
   * WP163：分拣第 ① 层（线程归并）只认**后续来信**——带 In-Reply-To / References 的那种。
   *
   * 同一拍里渠道那一路（`channels.ts`）先跑，它会给 INBOX 里**每一封**新信都开一条
   * 钉着自己线程的事项；要是一封全新的群发信也拿自己的线程 id 去对，就会"命中客服已有
   * 线程"、被挪进 `KefuAgents`——正是 WP163 要堵的那条缝。63 §D ① 的原话本来就是
   * "In-Reply-To / References 命中"。
   */
  const triageCtx = (followUp = true, account?: string): TriageContext => ({
    support_enabled: supportEnabled(),
    kol_enabled: kolEnabled(),
    // WP172：B2B 按邮箱开关算（「收 B2B 信」），线程归并同样只认后续来信
    b2b_enabled: account === undefined ? b2bEnabled() : b2bEnabledFor(account),
    isB2bThread: (id, refs) => followUp && (options.b2b?.isOurThread(id, refs) ?? false),
    isB2bSender: (email) => options.b2b?.isKnownSender(email) ?? false,
    isSupportThread: (id, refs) => followUp && supportEnabled() && knownThread(id, refs),
    isKolThread: (id, refs) =>
      followUp &&
      kolEnabled() &&
      (knownThread(id, refs) || (options.kol?.isOurThread(id, refs) ?? false)),
    senderRules: rulesCache,
    model_halted: options.halt.isHalted('model') || options.halt.isHalted('all'),
    at: clock.now(),
    // WP441：开着的消息规则（清单顺序；系统规则分拣自己跳过）
    messageRules: ruleService.cache(),
  })

  /** 发件人规则在同步那一轮里要被读很多次，开轮时刷一次就够。 */
  let rulesCache: SenderRule[] = []

  /** WP439：一封信按发件人规则直达了——那条规则的命中账记一笔（按信的日期算，早于 30 天的不记）。 */
  const noteRuleHit = async (record: MessageRecord): Promise<void> => {
    const rule = matchSenderRule(rulesCache, record.from.email)
    if (rule === undefined) return
    const next = recordSenderRuleHit(rule, record.date, clock.now())
    if (next === rule) return
    await store.putSenderRule(next)
    rulesCache = rulesCache.map((r) => (r.id === next.id ? next : r))
  }

  /** WP163：每只邮箱最近一次没动成的邮箱动作（「消息」页左栏那一行）。 */
  const mailboxFailures = new MailboxActionFailures()

  const onMailboxAction = (record: MailboxActionRecord): void => {
    const at = clock.now()
    mailboxFailures.note(record, at)
    options.appendEvent(mailboxActionEvent({ workspace_id, actor_id: 'messages', at, record }))
  }

  /* ── WP167：连接页那只邮箱卡上的三个开关 ───────────────────────────────── */

  const switchStore = new MailboxSwitchStore(
    options.dbDir === undefined ? {} : { dir: options.dbDir },
  )
  /** 这只邮箱现在按什么开关动邮箱：装配方给了就以它为准，否则取卡上那三个。 */
  const switchesOf = (account: string): Partial<SupportMailboxSwitches> =>
    options.supportMailbox?.(account) ?? switchStore.get(account)

  /* ── 交给客服 / 红人那一路 ─────────────────────────────────────────── */

  /**
   * 这封信的原始 MIME（人在「待确认」里点「这是客服」时，同步那一拍早过去了）：
   * 从受控原始材料区取回。取不到（没接原始材料区、材料过了保留期）= 交不出去。
   */
  const rawOf = async (record: MessageRecord): Promise<RawEmailMessage | undefined> => {
    if (options.rawStore === undefined || record.raw_ref === undefined) return undefined
    const row = await options.rawStore.get(record.raw_ref)
    const payload = row?.payload
    const source =
      typeof payload === 'string'
        ? payload
        : payload instanceof Uint8Array
          ? new TextDecoder().decode(payload)
          : undefined
    if (source === undefined) return undefined
    return { uid: record.uid ?? 0, mailbox: record.folder, source }
  }

  /** 钉着这条线程的那条事项（有就给，没有不开）。 */
  const matterOfThread = (thread_id: string): string | undefined =>
    options.work
      ?.listMatters({ kind: 'conversation' })
      .find((m) => m.context.pinned.some((p) => p.type === 'thread' && p.id === thread_id))?.id

  /**
   * 一封信交给客服 / 红人那一路（分拣判的，或人在「待确认」里点的）。
   *
   * 客服信（WP167，docs/63 §D「收信一个入口」）：递进渠道的入站管线——Amazon 子渠道判定、
   * 线程台账、去重、落事项、判断层、起 Run 都在那一条里；同一封信只进一次（渠道那边按
   * Message-ID 记台账）。**已经在岗位文件夹里的信**（老产品或人自己的过滤规则挪过去的）
   * 不再开事项、不起 Run：有事项就挂上，算"那一侧早就接了"，信不动。
   *
   * 红人信照现在的规矩：归并到那条合作线程的事项上。
   */
  const handOff = async (
    record: MessageRecord,
    route: 'support' | 'kol' | 'b2b',
    raw: RawEmailMessage | undefined,
    by: 'triage' | 'user',
    triage?: MessageTriage,
  ): Promise<{ accepted: boolean; matter_id?: string }> => {
    const link = async (matter_id: string | undefined): Promise<void> => {
      if (matter_id === undefined) return
      await store.update(record.id, { linked: { type: 'matter', id: matter_id } })
    }
    /*
     * WP172：B2B 那一路落成询盘 / 往来记录（开事项、起 Run 在 `b2b-mail.ts` 里，只在 B2B 岗位开着时）。
     * 没开 B2B 岗位、或这只邮箱不收 B2B 信 → 不接（信不挪、不开事项，同 WP163 的规矩）。
     * 已经在岗位文件夹里的信（人自己的过滤规则挪过去的）同客服那条：不开事项、不起 Run。
     */
    if (route === 'b2b') {
      const b2b = options.b2b
      if (b2b === undefined || !b2bEnabledFor(record.account)) return { accepted: false }
      if (isAgentFolderKind(record.folder_kind)) {
        const existing = matterOfThread(record.thread_id)
        await link(existing)
        return existing === undefined ? { accepted: true } : { accepted: true, matter_id: existing }
      }
      const out = await b2b.intake(record, triage ?? userVerdict('b2b', clock.now()), by)
      if (!out.accepted) return { accepted: false }
      await link(out.matter_id)
      return out.matter_id === undefined
        ? { accepted: true }
        : { accepted: true, matter_id: out.matter_id }
    }
    const work = options.work
    const position = options.position?.()
    if (work === undefined || position === undefined) return { accepted: false }
    if (route === 'support' && !supportEnabled()) return { accepted: false }
    if (route === 'kol' && !kolEnabled()) return { accepted: false }
    const intake = options.intakeSupport
    if (route === 'support' && intake !== undefined) {
      if (isAgentFolderKind(record.folder_kind)) {
        const existing = matterOfThread(record.thread_id)
        await link(existing)
        return existing === undefined ? { accepted: true } : { accepted: true, matter_id: existing }
      }
      const source = raw ?? (await rawOf(record))
      if (source === undefined) return { accepted: false }
      const out = await intake({
        account: record.account,
        raw: source,
        ...(record.message_id === undefined ? {} : { message_id: record.message_id }),
        by,
      })
      if (!out.accepted) return { accepted: false }
      const matter_id = out.matter_id ?? matterOfThread(record.thread_id)
      await link(matter_id)
      return matter_id === undefined ? { accepted: true } : { accepted: true, matter_id }
    }
    // WP416：红人回信先对上人和合作（记往来、推阶段）；对不上照旧只开一件事项
    if (route === 'kol') {
      try {
        options.kol?.intake({
          from_email: record.from.email,
          subject: record.subject,
          text: record.text,
          ...(record.message_id === undefined ? {} : { message_id: record.message_id }),
          ...(record.in_reply_to === undefined ? {} : { in_reply_to: record.in_reply_to }),
          references: record.references,
          account: record.account,
          at: record.date,
        })
      } catch (e) {
        logQuiet('kol_reply_intake_failed', record.account, e)
      }
    }
    const ref = { type: 'thread' as const, id: record.thread_id }
    const existing = work
      .listMatters({ kind: 'conversation' })
      .find((m) => m.context.pinned.some((p) => p.type === ref.type && p.id === ref.id))
    const matter =
      existing ??
      work.createMatter({
        kind: 'conversation',
        title: `与 ${record.from.name ?? record.from.email} 的往来`,
        pinned: [ref],
        position_id: position.assignment_id,
      })
    await link(matter.id)
    // WP125（72 §P0-1）：没接渠道那一路的老装配——分拣判成 `support` 的那一封递一次判断层信号
    if (route === 'support') {
      await options.onSupportMail?.({
        thread_id: record.thread_id,
        matter_id: matter.id,
        text: record.text,
        subject: record.subject,
        from: record.from.email,
      })
    }
    return { accepted: true, matter_id: matter.id }
  }

  const sync = new MailboxSync({
    clock,
    workspace_id,
    store,
    state: mailboxState(options),
    accounts: mailboxAccounts,
    ...(options.rawStore === undefined ? {} : { rawStore: options.rawStore }),
    triage: async (record) =>
      triageMessage(
        {
          from_email: record.from.email,
          ...(record.from.name === undefined ? {} : { from_name: record.from.name }),
          subject: record.subject,
          text: record.text,
          thread_id: record.thread_id,
          ...(record.in_reply_to === undefined ? {} : { in_reply_to: record.in_reply_to }),
          references: record.references,
          headers: record.headers,
          has_attachments: record.attachments.length > 0,
          // WP441：消息规则的收信邮箱 / 来源条件与「生效只管以后进来的」
          account: record.account,
          source: record.source,
          date: record.date,
        },
        triageCtx(record.in_reply_to !== undefined || record.references.length > 0, record.account),
        triageModel,
      ).then(async (verdict) => {
        // WP441：命中消息规则之后的动作（命中账、记到某处、告诉我、进简报、起草回复出卡）
        await ruleService.afterTriage(record, verdict)
        // WP172（docs/84 §5 第 5 条）：退订回信、硬退信分拣时直接进抑制名单，不等 Run
        try {
          options.b2b?.observe(record)
        } catch (e) {
          logQuiet('b2b_suppression_failed', record.account, e)
        }
        // WP439：按发件人规则直达的那一封——那条规则上记一笔（规则清单「最近 30 天命中几次」）
        if (verdict.kind_by === 'sender_rule') {
          try {
            await noteRuleHit(record)
          } catch (e) {
            logQuiet('sender_rule_hit_failed', record.account, e)
          }
        }
        // WP442：对方回了 → 在跟的那条收掉、卡撤掉；对方说过「哪天答复」→ 顺手抽出来（到那天再过 1 个工作日才提醒）
        try {
          await options.followUp?.()?.noteInbound(record)
        } catch (e) {
          logQuiet('follow_up_inbound_failed', record.account, e)
        }
        const promised = promisedReplyAt(record.text, record.date, options.tzOffsetMinutes?.() ?? 0)
        const dated = promised === undefined ? verdict : { ...verdict, promised_reply_at: promised }
        // WP459（决策 1498）：AI 猜得出岗位就直接交过去（把握不够的标「AI 猜的」）；猜不出 / 只能你定的留在收件箱
        // 63 那三条路得真开着（职责在、这只邮箱收这类信）才算这个岗位开着——不然交过去也接不住
        const open = (route: 'support' | 'kol' | 'b2b'): boolean =>
          route === 'support'
            ? supportEnabled()
            : route === 'kol'
              ? kolEnabled()
              : b2bEnabledFor(record.account)
        return withAiHand(
          dated,
          positionOptions().map((p) => {
            const route = routeOfPosition(p.id)
            return route === undefined ? p : { ...p, open: p.open && open(route) }
          }),
        )
      }),
    /**
     * 交给客服 / 红人那一路；那一侧不接就回 `false`——于是信不挪、留在收件箱里可见。
     *
     * WP167：客服信递进渠道的入站管线（开事项、判断层、起 Run 都在那里），见 {@link handOff}。
     * 交接炸了不让这封信变成毒消息：它已经落进消息库了，只是没交出去——记一笔、信不动。
     */
    handoff: async (record, triage, raw) => {
      if (triage.route !== 'support' && triage.route !== 'kol' && triage.route !== 'b2b')
        return false
      try {
        return (await handOff(record, triage.route, raw, 'triage', triage)).accepted
      } catch (e) {
        logQuiet('support_intake_failed', record.account, e)
        return false
      }
    },
    // WP212：「记住」过岗位的发件人——下一封直接交给那个岗位（63 那三条之外的岗位在这里交）
    after_triage: (record, triage) => autoHand(record, triage),
    // WP163 / WP167：四个开关每封现查（按邮箱各一份）；每个动作一条事件 + 记住最近一次失败
    support_mailbox: (account) => switchesOf(account),
    on_mailbox_action: onMailboxAction,
    on_error: (e) => logQuiet('message_sync_failed', '', e),
    on_folder_fault: (fault) => {
      options.appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'inbound.folder_fault',
        actor: { kind: 'system', id: 'messages' },
        correlation: { trace_id: `tr_msgfault_${clock.now()}` },
        payload: {
          account: maskAddress(fault.account),
          folder: fault.folder,
          failed_uid: fault.failed_uid,
          fail_count: fault.fail_count,
          quarantined: fault.quarantined,
        },
      })
    },
  })

  const suggester = new ReplySuggester({
    now: () => Date.parse(clock.now()),
    ...(options.models === undefined
      ? {}
      : { model: suggestModel(options, workspace_id) satisfies SuggestModel }),
  })

  /* ── 端口实现 ───────────────────────────────────────────────────────── */

  const accountOf = (address: string): MailAccount | undefined =>
    options.accounts().find((a) => a.address === address)

  /*
   * WP441（docs/108 §5.1）：消息规则。起草回复那一下在这里写正文（与「AI 助手」三条建议同一套：
   * 品牌 / 岗位口吻、按来信语言），出卡交给宿主；规则自己不发信。
   */
  const draftKind = (instruction: string | undefined): ReplySuggestionKind =>
    instruction !== undefined && /婉拒|拒绝|decline/i.test(instruction)
      ? 'decline'
      : instruction !== undefined && /详细|detail/i.test(instruction)
        ? 'detailed'
        : 'short'
  const ruleService: MessageRuleService = createMessageRuleService({
    clock,
    workspace_id,
    store,
    appendEvent: options.appendEvent,
    logQuiet,
    models: options.models,
    ...(options.position === undefined ? {} : { position: options.position }),
    positions: () => positionOptions(),
    ...(options.ruleSinks === undefined ? {} : { sinks: options.ruleSinks }),
    ...(options.personName === undefined ? {} : { personName: options.personName }),
    ...(options.sharedRules === undefined ? {} : { shared: options.sharedRules }),
    ...(options.notifyMessages === undefined ? {} : { notify: options.notifyMessages }),
    ...(options.notifyMessageRuleChange === undefined
      ? {}
      : { notifyChange: options.notifyMessageRuleChange }),
    ...(options.recordRuleMessage === undefined ? {} : { record: options.recordRuleMessage }),
    ...(options.stageRuleCard === undefined ? {} : { stageRuleCard: options.stageRuleCard }),
    ...(options.trialCredits === undefined ? {} : { trialCredits: options.trialCredits }),
    ...(options.tzOffsetMinutes === undefined ? {} : { tzOffsetMinutes: options.tzOffsetMinutes }),
    // WP442：系统规则「回信跟进」并进同一张清单（`MessageRule.system = 'follow_up'`）
    followUp: () => options.followUp?.(),
    ...(options.stageRuleDraft === undefined
      ? {}
      : {
          stageDraft: async ({ record, rule, instruction, position_id }) => {
            const stage = options.stageRuleDraft
            if (stage === undefined) return undefined
            const kind = draftKind(instruction)
            const voice = await Promise.resolve(options.voice?.({ position_id })).catch(
              () => undefined,
            )
            const knowledge =
              options.searchKnowledge === undefined
                ? []
                : await options
                    .searchKnowledge(`${record.subject}\n${record.text.slice(0, 500)}`, 3)
                    .catch(() => [])
            const out = await suggester.suggest(`${record.id}:rule`, {
              subject: record.subject,
              from: record.from.email,
              body: record.text.slice(0, 2000),
              context: instruction === undefined ? [] : [`要求：${instruction}`],
              ...(voice === undefined || voice === '' ? {} : { voice }),
              knowledge,
              kinds: [kind],
              lang: replyLanguage(
                `${record.subject}\n${record.text.slice(0, 2000)}`,
                options.brandLanguage?.(),
              ),
            })
            const text = out.find((x) => x.kind === kind)?.text ?? out[0]?.text
            if (text === undefined || text.trim() === '') return undefined
            return stage({
              record,
              rule,
              subject: record.subject,
              text,
              ...(position_id === undefined ? {} : { position_id }),
            })
          },
        }),
  })

  /** WP204：这只邮箱开着影子模式（只看不动）——人按的已读 / 星标只在本机标，归档 / 删除不做。 */
  const shadowOf = (address: string): boolean =>
    supportMailboxSwitches(switchesOf(address)).shadow_mode

  /**
   * 旗标回写：本机先改，IMAP 尽力（写不动只 log）。WP204：回一句"邮箱里动成了没有"，
   * 界面据此说人话（以前写不动就静默，人以为邮箱里也改了）。
   */
  const writeFlags = async (
    record: MessageRecord,
    input: MessageFlagsInput,
  ): Promise<MessageWriteback> => {
    const account = accountOf(record.account)
    const uid = record.uid
    if (account === undefined || uid === undefined) return 'no_mailbox'
    if (shadowOf(record.account)) return 'local_only'
    const writer = writerFor(account)
    if (writer === undefined) return 'no_mailbox'
    const add: string[] = []
    const remove: string[] = []
    const flag = (on: boolean | undefined, name: string): void => {
      if (on === true) add.push(name)
      if (on === false) remove.push(name)
    }
    flag(input.read, '\\Seen')
    flag(input.starred, '\\Flagged')
    flag(input.answered, '\\Answered')
    if (add.length === 0 && remove.length === 0) return 'written'
    return (await writer.setFlags(record.folder, uid, add, remove)) ? 'written' : 'failed'
  }

  /**
   * WP167：人工分拣交出去之后，按这只邮箱的开关动邮箱（与同步那一路同一套：
   * `applySupportMailboxActions` 的顺序与记账，红人那只只看影子模式）。
   * 已经在岗位文件夹里的信不挪（WP163）。
   */
  const moveAfterHandoff = async (
    record: MessageRecord,
    route: 'support' | 'kol' | 'b2b',
  ): Promise<MessageRecord> => {
    const account = accountOf(record.account)
    const uid = record.uid
    if (account === undefined || uid === undefined || isAgentFolderKind(record.folder_kind)) {
      return record
    }
    const writer = writerFor(account)
    const to = folderPathFor(route, knownOf(account))
    const switches = supportMailboxSwitches(switchesOf(record.account))
    const from_folder = record.folder
    const moveOne = async (dest: string): Promise<boolean> => {
      const moved = (await writer?.move(from_folder, uid, dest)) ?? false
      if (moved) noteFolder(account, dest)
      return moved
    }
    if (route === 'support') {
      const done = await applySupportMailboxActions({
        switches,
        account: record.account,
        uid,
        from_folder,
        to_folder: to,
        ops:
          writer === undefined
            ? {}
            : {
                markRead: async () => writer.setFlags(from_folder, uid, ['\\Seen'], []),
                move: async (dest) => moveOne(dest),
              },
        record: onMailboxAction,
      })
      const patch: Partial<MessageRecord> = {
        ...(done.marked_read ? { flags: { ...record.flags, read: true } } : {}),
        ...(done.moved ? { folder: to, folder_kind: folderKindOf(to) } : {}),
      }
      return Object.keys(patch).length === 0
        ? record
        : ((await store.update(record.id, patch)) ?? record)
    }
    if (switches.shadow_mode) {
      onMailboxAction({
        account: record.account,
        uid,
        from_folder,
        action: 'observe',
        status: 'skipped',
        reason: 'shadow_mode',
      })
      return record
    }
    const moved = await moveOne(to)
    onMailboxAction({
      account: record.account,
      uid,
      from_folder,
      to_folder: to,
      action: 'move',
      ...(moved
        ? { status: 'completed' as const }
        : { status: 'failed' as const, reason: 'server_refused' as const }),
    })
    return moved
      ? ((await store.update(record.id, { folder: to, folder_kind: folderKindOf(to) })) ?? record)
      : record
  }

  /** WP204：「显示图片」的本机代取（测试 / demo 注入替身）。 */
  const loadImage: RemoteImageLoader = options.loadRemoteImage ?? createRemoteImageLoader()

  const requireMessage = async (id: string): Promise<MessageRecord> => {
    const row = await store.get(id)
    // WP204：以前抛裸 Error → 500「internal error」，界面只能说"出错了"
    if (row === undefined)
      throw new ApiError('not_found', '这封信不在了（可能刚被别处挪走），刷新一下列表。')
    return row
  }

  /* ── WP212：岗位、归属、卡片数 ─────────────────────────────────────── */

  /** 「交给 X ▾」那一列：装配方给了就用它，否则只有 63 那三条路对应的三个岗位。 */
  const positionOptions = (): MessagePositionOption[] => {
    const given = options.positions?.()
    // Fable 09-30：「负责人」不进「交给 X ▾」——负责人自己处理用「我自己回」
    if (given !== undefined) return given.filter((p) => !NOT_HANDABLE_POSITIONS.includes(p.id))
    const open = { support: supportEnabled(), kol: kolEnabled(), b2b: b2bEnabled() }
    return (['support', 'kol', 'b2b'] as const).map((route) => ({
      id: POSITION_OF_ROUTE[route],
      name_zh: ROUTE_POSITION_NAMES[route].zh,
      name_en: ROUTE_POSITION_NAMES[route].en,
      open: open[route],
      route,
    }))
  }

  /** 卡片流里等你批的卡（数不出就是空）。 */
  const waitingCards = async (): Promise<readonly { thread_id?: string; matter_id?: string }[]> => {
    try {
      return (await options.openCards?.()) ?? []
    } catch (e) {
      logQuiet('open_cards_failed', '', e)
      return []
    }
  }

  /** 一条会话在卡片流里还有几张卡等你批、跳到哪（事项页列着这件事的卡）。 */
  const cardsOf = (
    messages: readonly MessageRecord[],
    cards: readonly { thread_id?: string; matter_id?: string }[],
  ): { open_card_count: number; card_link?: string } => {
    const threads = new Set(messages.map((m) => m.thread_id))
    const matters = new Set(
      messages.flatMap((m) => [
        ...(m.linked?.type === 'matter' ? [m.linked.id] : []),
        ...(m.handled?.matter_id === undefined ? [] : [m.handled.matter_id]),
      ]),
    )
    const hit = cards.filter(
      (c) =>
        (c.thread_id !== undefined && threads.has(c.thread_id)) ||
        (c.matter_id !== undefined && matters.has(c.matter_id)),
    )
    const matter = hit.find((c) => c.matter_id !== undefined)?.matter_id ?? [...matters][0]
    return {
      open_card_count: hit.length,
      ...(matter === undefined ? {} : { card_link: `/matters/${matter}` }),
    }
  }

  /**
   * 列表上的一行补上三样只有服务进程知道的：AI 挑的主按钮（要知道哪些岗位开着）、
   * 卡片流里还有几张卡、跳过去的链接。
   */
  const enrich = async (rows: MessageThreadSummary[]): Promise<MessageThreadSummary[]> => {
    const positions = positionOptions()
    const cards = await waitingCards()
    const out: MessageThreadSummary[] = []
    for (const row of rows) {
      let next = row
      if (
        row.claim === 'unclaimed' &&
        row.kind !== undefined &&
        row.claim_message_id !== undefined
      ) {
        const m = await store.get(row.claim_message_id)
        next = {
          ...next,
          suggest: suggestFor(
            {
              kind: row.kind,
              needs_reply: m?.triage?.needs_reply !== false,
              suggested_position: m?.triage?.suggested_position,
              suggested_route: m?.triage?.suggested_route,
            },
            positions,
          ),
        }
      }
      if (row.claim === 'handed' && cards.length > 0) {
        const c = cardsOf(await store.thread(row.thread_id), cards)
        next = { ...next, open_card_count: c.open_card_count }
        if (c.card_link !== undefined) next = { ...next, card_link: c.card_link }
      }
      // WP442：回信跟进（在等对方回 / 出了催促卡 / 不跟了）
      const followUp = options.followUp?.()?.of(row.thread_id)
      if (followUp !== undefined) next = { ...next, follow_up: followUp }
      out.push(next)
    }
    return out
  }

  /** 一条会话现在归谁（同 {@link aggregateThreads} 的派生），外加卡片数。 */
  const claimOfThreadId = async (
    thread_id: string,
  ): Promise<{ summary?: MessageThreadSummary; messages: MessageRecord[] }> => {
    const messages = await store.thread(thread_id)
    const summary = (await enrich(aggregateThreads(messages)))[0]
    return summary === undefined ? { messages } : { summary, messages }
  }

  /**
   * 交给 63 那三条路之外的岗位（54 的「交给这个岗位一件事」）。岗位没开 / 没接装配口 / 那边不接
   * → 不交，回一句人话。人点的「交给 X」与「记住」过的发件人自动交走同一条。
   */
  const handToPosition = async (
    row: MessageRecord,
    position_id: string,
    person_id: PersonId,
  ): Promise<{ accepted: boolean; matter_id?: string; refused?: string }> => {
    const option = positionOptions().find((p) => p.id === position_id)
    const open = options.openAtPosition
    if (open === undefined || option === undefined || !option.open)
      return { accepted: false, refused: `${option?.name_zh ?? position_id}岗位没开，开了才能交。` }
    try {
      const out = await open({
        position_id,
        person_id,
        title: row.subject.trim() === '' ? `来自 ${row.from.email} 的信` : row.subject,
        ...(row.triage?.summary === undefined || row.triage.summary === ''
          ? {}
          : { summary: row.triage.summary }),
        thread_id: row.thread_id,
      })
      return { accepted: true, matter_id: out.matter_id }
    } catch (e) {
      return {
        accepted: false,
        refused: e instanceof Error && e.message !== '' ? e.message : '这个岗位没接住。',
      }
    }
  }

  /**
   * WP212（Fable 09-30）：勾过「记住」的发件人，下一封**直接交给那个岗位**——所有岗位都一样，
   * 「记住」就是人已经表过态了。63 那三条路由规则里的 `route` 管（分拣直接交）；其余岗位在这里交。
   * 交不出去（岗位关了、那人名下没这个岗位的职责）就留在没人接的里，主按钮仍是那个岗位。
   */
  const autoHand = async (record: MessageRecord, triage: MessageTriage): Promise<void> => {
    // WP459（决策 1498）：AI 交给 63 那三条路之外的岗位——在这里交（那三条路由分拣直接交）
    if (triage.ai_hand !== undefined) {
      await aiHand(record, triage.ai_hand.position_id)
      return
    }
    const position_id = triage.suggested_position
    // WP441：消息规则定了「交给 X」（63 那三条路之外的岗位）也在这里交——规则就是人表过态了
    const byMessageRule =
      triage.rule_route !== undefined &&
      ruleService
        .cache()
        .find((r) => r.id === triage.rule_route)
        ?.actions.some((a) => a.type === 'hand_to' && a.position_id === position_id) === true
    if ((triage.kind_by !== 'sender_rule' && !byMessageRule) || position_id === undefined) return
    if (routeOfPosition(position_id) !== undefined) return
    const rule = byMessageRule ? undefined : matchSenderRule(rulesCache, record.from.email)
    const ruleBy = byMessageRule
      ? ruleService.cache().find((r) => r.id === triage.rule_route)?.by
      : undefined
    const person = rule?.by ?? ruleBy ?? options.position?.()?.person_id
    if (person === undefined) return
    const out = await handToPosition(record, position_id, person)
    if (!out.accepted) return
    const at = clock.now()
    await store.update(record.id, {
      handled: {
        as: 'position',
        position_id,
        ...(out.matter_id === undefined ? {} : { matter_id: out.matter_id }),
        by: person,
        at,
      },
      ...(out.matter_id === undefined
        ? {}
        : { linked: { type: 'matter' as const, id: out.matter_id } }),
    })
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type: 'messages.route_confirmed',
      actor: { kind: 'system', id: byMessageRule ? 'message_rule' : 'sender_rule' },
      subject: { type: 'message', id: record.id },
      correlation: { trace_id: `tr_msgauto_${record.id}_${at}` },
      // 63 §10：没有正文、地址遮过
      payload: {
        route: 'position',
        handed_off: true,
        by: byMessageRule ? 'message_rule' : 'sender_rule',
        position_id,
        account: maskAddress(record.account),
        ...(out.matter_id === undefined ? {} : { matter_id: out.matter_id }),
      },
    })
  }

  /** WP459：AI 交给某个岗位（「交给这个岗位一件事」那一路）。交不出去就留在收件箱，主按钮仍是那个岗位。 */
  const aiHand = async (record: MessageRecord, position_id: string): Promise<void> => {
    if (routeOfPosition(position_id) !== undefined) return
    const person = options.position?.()?.person_id
    if (person === undefined) return
    const out = await handToPosition(record, position_id, person)
    if (!out.accepted) return
    const at = clock.now()
    await store.update(record.id, {
      handled: {
        as: 'position',
        position_id,
        ...(out.matter_id === undefined ? {} : { matter_id: out.matter_id }),
        by: person,
        at,
        by_ai: true,
      },
      ...(out.matter_id === undefined
        ? {}
        : { linked: { type: 'matter' as const, id: out.matter_id } }),
    })
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type: 'messages.route_confirmed',
      actor: { kind: 'system', id: 'triage' },
      subject: { type: 'message', id: record.id },
      correlation: { trace_id: `tr_msgai_${record.id}_${at}` },
      // 63 §10：没有正文、地址遮过
      payload: {
        route: 'position',
        handed_off: true,
        by: 'ai_guess',
        position_id,
        account: maskAddress(record.account),
        ...(out.matter_id === undefined ? {} : { matter_id: out.matter_id }),
      },
    })
  }

  /** 一次纠正：存下来（「你教过它」），没勾「以后都这样」的进学习回路。 */
  const correct = async (
    row: MessageRecord,
    input: Omit<MessageCorrection, 'id' | 'message_id' | 'sender_domain' | 'at'>,
  ): Promise<void> => {
    const at = clock.now()
    const correction: MessageCorrection = {
      id: `corr_${sha256(`${workspace_id}|${row.id}|${input.field}|${at}`).slice(0, 16)}`,
      message_id: row.id,
      sender_domain: domainOf(row.from.email),
      at,
      ...input,
    }
    await store.putCorrection?.(correction)
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type: 'messages.triage_corrected',
      actor: { kind: 'person', id: input.by },
      subject: { type: 'message', id: row.id },
      correlation: { trace_id: `tr_msgcorr_${row.id}_${at}` },
      // 63 §10：只有域与改前改后，没有正文与完整地址
      payload: {
        field: input.field,
        ...(input.from === undefined ? {} : { from: input.from }),
        to: input.to,
        sender_domain: correction.sender_domain,
        remembered: input.remembered,
      },
    })
    if (!input.remembered) {
      try {
        options.onCorrection?.(correction)
      } catch (e) {
        logQuiet('lesson_pool_failed', row.account, e)
      }
    }
  }

  /** 「以后这个发件人都这样」：一个发件人一条规则，新教的几格盖在老规则上（路由 / 标签 / 类型 / 岗位）。 */
  const rememberSender = async (
    row: MessageRecord,
    patch: Partial<Pick<SenderRule, 'route' | 'kind' | 'position'>>,
    by: PersonId,
    source: 'user' | 'ai' = 'user',
  ): Promise<SenderRule> => {
    const id = `rule_${sha256(`${workspace_id}|${row.from.email}`).slice(0, 16)}`
    const prior = (await store.senderRules()).find((r) => r.id === id)
    const rule: SenderRule = {
      ...(prior ?? {}),
      id,
      sender: row.from.email,
      labels: prior?.labels ?? [...row.labels],
      by,
      created_at: clock.now(),
      // WP439：人教的盖过 AI 自己学的（docs/108 §5.2「人的优先」）；WP459：改判两次 AI 自己记的是 `ai`
      source,
      ...patch,
    }
    await store.putSenderRule(rule)
    rulesCache = await store.senderRules()
    return rule
  }

  /** 「只是通知」那一下顺手标已读：本机一定标；邮箱里标不标跟随「客信怎么动邮箱」开关。 */
  const readForNotice = async (row: MessageRecord): Promise<MessageWriteback> => {
    if (row.flags.read) return 'written'
    await store.update(row.id, { flags: { ...row.flags, read: true } })
    const switches = supportMailboxSwitches(switchesOf(row.account))
    if (accountOf(row.account) === undefined) return 'no_mailbox'
    if (switches.shadow_mode || !switches.mark_read) return 'local_only'
    return writeFlags(row, { read: true })
  }

  /** WP440：这条会话上 AI 直接回的那几封（没有就不出这一格）。 */
  const autoRepliesOf = (
    messages: readonly MessageRecord[],
  ): { auto_replies?: MessageAutoReplyMark[] } => {
    if (options.autoReplies === undefined) return {}
    const matters = [
      ...new Set(
        messages.flatMap((m) => [
          ...(m.linked?.type === 'matter' ? [m.linked.id] : []),
          ...(m.handled?.matter_id === undefined ? [] : [m.handled.matter_id]),
        ]),
      ),
    ]
    if (matters.length === 0) return {}
    const marks = options.autoReplies(matters)
    return marks.length === 0 ? {} : { auto_replies: marks }
  }

  /** WP442：回信跟进没装配时那几条接口照实说。 */
  const followUpOrThrow = (): MessageFollowUpHooks => {
    const f = options.followUp?.()
    if (f === undefined) throw new ApiError('not_implemented', '这台机器上没有装回信跟进。')
    return f
  }

  const port: MessagesPort = {
    flagAutoReply(actor, approval_item_id) {
      return options.flagAutoReply?.(approval_item_id, actor.person_id)
    },
    // WP442：「等对方回」那一堆、系统规则「发出 N 个工作日没回 → 提醒我」、行上直接点的
    followUps() {
      return { rows: followUpOrThrow().rows() }
    },
    followUpSettings() {
      return followUpOrThrow().settings()
    },
    setFollowUpSettings(actor, patch) {
      return followUpOrThrow().setSettings(patch, actor.person_id as PersonId)
    },
    async followUpAction(actor, thread_id, action) {
      const out = await followUpOrThrow().act(thread_id, action, actor.person_id as PersonId)
      if (out === undefined)
        throw new ApiError(
          'not_found',
          '这条会话现在不在跟进里（对方回过了，或者最后一封不是我们发的）。',
        )
      return { follow_up: out }
    },
    async accounts(): Promise<{ accounts: MessageAccountView[] }> {
      const known = options.accounts().map((a) => a.address)
      const seen = await store.accounts()
      const all = [...new Set([...known, ...seen])]
      const out: MessageAccountView[] = []
      for (const address of all) {
        const folders = await store.folders(address)
        const failure = mailboxFailures.of(address)
        out.push({
          address,
          unread: folders.reduce((n, f) => n + (f.kind === 'inbox' ? f.unread : 0), 0),
          folders,
          backfill_floor: sync.backfillFloor(address),
          ...(failure === undefined ? {} : { last_mailbox_failure: failure }),
          ...(b2bEnabledFor(address) ? { b2b: true } : {}),
          // WP204：影子模式开着——消息页把归档 / 删除置灰并说为什么
          ...(accountOf(address) !== undefined && shadowOf(address) ? { shadow_mode: true } : {}),
        })
      }
      return { accounts: out }
    },

    async threads(
      _actor: MessageActor,
      query: MessageListQuery,
    ): Promise<{ threads: MessageThreadSummary[] }> {
      // WP212：补上主按钮与卡片数（只有服务进程知道哪些岗位开着、卡片流里有几张）
      return { threads: await enrich(await store.threads(query)) }
    },

    async thread(_actor: MessageActor, thread_id: string): Promise<MessageThreadView> {
      const messages = await store.thread(thread_id)
      const last = messages[messages.length - 1]
      // 状态带只给有 Agent 在处理的那几条路（WP172 起 B2B 也算）
      const agentRoute = messages
        .map((m) => m.route)
        .find((r): r is 'support' | 'kol' | 'b2b' => r === 'support' || r === 'kol' || r === 'b2b')
      const linked = messages.find((m) => m.linked !== undefined)?.linked
      // WP212：这条会话归谁（与列表同一份派生）+ 卡片流里还有几张卡
      const summary = (await enrich(aggregateThreads(messages)))[0]
      return {
        thread_id,
        subject: last?.subject ?? '',
        messages,
        ...(summary?.claim === undefined ? {} : { claim: summary.claim }),
        ...(summary?.claim_message_id === undefined
          ? {}
          : { claim_message_id: summary.claim_message_id }),
        ...(summary?.handed_to === undefined ? {} : { handed_to: summary.handed_to }),
        ...(summary?.open_card_count === undefined
          ? {}
          : { open_card_count: summary.open_card_count }),
        ...(summary?.card_link === undefined ? {} : { card_link: summary.card_link }),
        ...(summary?.suggest === undefined ? {} : { suggest: summary.suggest }),
        ...(summary?.kind === undefined ? {} : { kind: summary.kind }),
        // WP440：AI 按把握直接回的那几封（按这条会话落成的事项找）
        ...autoRepliesOf(messages),
        // WP442：回信跟进
        ...(summary?.follow_up === undefined ? {} : { follow_up: summary.follow_up }),
        ...(agentRoute === undefined
          ? {}
          : {
              agent_status: {
                route: agentRoute,
                state: agentState(options, linked?.id),
                ...(linked === undefined
                  ? {}
                  : { href: `/matters/${linked.id}`, takeover_matter_id: linked.id }),
              },
            }),
      }
    },

    async message(_actor: MessageActor, id: string): Promise<{ message: MessageRecord }> {
      const row = await requireMessage(id)
      // 「总是信任这个发件人」名单里的：正文里的远程图片直接搬回 src
      const trusted = await store.trustedSenders()
      if (row.has_remote_images && row.html !== undefined && trusted.includes(row.from.email)) {
        return {
          message: { ...row, html: restoreRemoteImages(row.html), has_remote_images: false },
        }
      }
      return { message: row }
    },

    async setFlags(
      _actor: MessageActor,
      id: string,
      input: MessageFlagsInput,
    ): Promise<{ message: MessageRecord; writeback: MessageWriteback }> {
      const row = await requireMessage(id)
      const flags = {
        ...row.flags,
        ...(input.read === undefined ? {} : { read: input.read }),
        ...(input.starred === undefined ? {} : { starred: input.starred }),
        ...(input.answered === undefined ? {} : { answered: input.answered }),
      }
      const next = await store.update(id, { flags })
      // 回写 IMAP：用户回到自己的邮箱软件看到的必须是同一个状态（63 §7）。
      // WP204：影子模式开着就只在本机标（`local_only`），邮箱一下都不动
      const writeback = await writeFlags(row, input)
      return { message: next ?? row, writeback }
    },

    async move(
      actor: MessageActor,
      id: string,
      input: MessageMoveInput,
    ): Promise<{ message: MessageRecord; rule?: SenderRule; writeback: MessageWriteback }> {
      const row = await requireMessage(id)
      const account = accountOf(row.account)
      // WP161：按这只邮箱上已有的真名走（`kefuagents` 在就沿用，不另建 `KefuAgents`）
      const known = account === undefined ? [] : knownOf(account)
      const to = folderPathFor(input.to, known)
      const route: MessageRoute =
        input.to === 'support' || input.to === 'kol' || input.to === 'b2b' ? input.to : 'inbox'
      /*
       * WP204：分两种挪。
       * - **纠错**（移到客服 / 红人 / B2B、从岗位文件夹移回收件箱、或勾了"以后都这样"）：
       *   改路由、分拣结论记"人"（63 §D「纠错」）；
       * - **收拾**（归档、删除 = 移到垃圾箱、以及撤销它们）：只换文件夹，**路由与分拣结论不动**——
       *   以前归档一下摘要就变成"你挪过这封信"、要不要回也被清掉，撤销回来也找不回。
       */
      const correcting =
        isAgentFolderKind(input.to) ||
        (input.to === 'inbox' && row.route !== 'inbox') ||
        input.remember_sender === true
      const shadow = account !== undefined && shadowOf(row.account)
      // 影子模式 = 这只邮箱一下都不动：收拾类的挪不做（界面已置灰，这里兜底）；纠错只改本机的路由
      if (shadow && !correcting) throw new ApiError('conflict', SHADOW_MODE_REFUSAL)
      const next =
        (await store.update(id, {
          ...(shadow ? {} : { folder: to, folder_kind: folderKindOf(to) }),
          ...(correcting
            ? {
                route,
                // WP212：纠错改的是路由，类型那几格带着走（不许冲掉）
                triage: {
                  ...userVerdict(route, clock.now(), row.labels),
                  ...kindFieldsOf(row.triage),
                },
              }
            : {}),
        })) ?? row
      suggester.invalidate(id)
      let writeback: MessageWriteback = shadow ? 'local_only' : 'no_mailbox'
      if (!shadow && account !== undefined && row.uid !== undefined) {
        const moved = await writerFor(account)?.move(row.folder, row.uid, to)
        if (moved === true) noteFolder(account, to)
        writeback = moved === true ? 'written' : moved === false ? 'failed' : 'no_mailbox'
      }
      if (input.remember_sender !== true) return { message: next, writeback }
      // 「以后这个发件人都这样？」——教一次，下一封直达，不再花模型（63 §4 ②）
      const ruleId = `rule_${sha256(`${workspace_id}|${row.from.email}`).slice(0, 16)}`
      const prior = (await store.senderRules()).find((r) => r.id === ruleId)
      const rule: SenderRule = {
        id: ruleId,
        sender: row.from.email,
        route,
        labels: [...row.labels],
        by: actor.person_id,
        created_at: clock.now(),
        source: 'user',
        // WP439：重教一次不清命中账
        ...(prior?.hit_days === undefined ? {} : { hit_days: prior.hit_days }),
        ...(prior?.last_hit_at === undefined ? {} : { last_hit_at: prior.last_hit_at }),
      }
      await store.putSenderRule(rule)
      rulesCache = await store.senderRules()
      return { message: next, rule, writeback }
    },

    async setLabels(
      _actor: MessageActor,
      id: string,
      labels: string[],
    ): Promise<{ message: MessageRecord }> {
      const row = await requireMessage(id)
      const next = (await store.update(id, { labels })) ?? row
      // 服务器支持 keyword 才顺手同步；不支持就只在本地——**不为了标签去挪信**（63 §5）
      const account = accountOf(row.account)
      if (account !== undefined && row.uid !== undefined) {
        const writer = writerFor(account)
        const supported = (await writer?.keywordsSupported?.(row.folder)) ?? false
        if (supported && writer !== undefined) {
          const add = labels.filter((l) => !row.labels.includes(l)).map(keywordOf)
          const remove = row.labels.filter((l) => !labels.includes(l)).map(keywordOf)
          await writer.setFlags(row.folder, row.uid, add, remove)
        }
      }
      return { message: next }
    },

    async showImages(
      _actor: MessageActor,
      id: string,
      always: boolean,
    ): Promise<{ message: MessageRecord; images: MessageImagesReport }> {
      const row = await requireMessage(id)
      if (always) await store.trustSender(row.from.email)
      if (row.html === undefined || !row.has_remote_images)
        return { message: row, images: { shown: 0, failed: 0 } }
      // WP204：本机代取、内联成 data:——浏览器不直连对方服务器（桌面壳的 CSP 也只认 data:）。
      // 只对这一封、这一次生效：库里那一份照旧挡着，下次打开还是先不加载。
      const out = await inlineRemoteImages(row.html, loadImage)
      return {
        message: { ...row, html: out.html, has_remote_images: out.failed > 0 },
        images: { shown: out.shown, failed: out.failed },
      }
    },

    async attachment(
      _actor: MessageActor,
      id: string,
      attachment_id: string,
    ): Promise<{ name: string; mime: string; bytes: Uint8Array } | undefined> {
      const row = await requireMessage(id)
      const meta = row.attachments.find((a) => a.id === attachment_id)
      if (meta?.ref === undefined || options.rawStore === undefined) return undefined
      const payload = (await options.rawStore.get(meta.ref))?.payload
      const bytes =
        payload instanceof Uint8Array
          ? payload
          : typeof payload === 'string'
            ? new TextEncoder().encode(payload)
            : undefined
      return bytes === undefined ? undefined : { name: meta.name, mime: meta.mime, bytes }
    },

    async labels(): Promise<{ labels: MessageLabel[] }> {
      return { labels: await store.labels() }
    },

    async putLabel(_actor: MessageActor, label: MessageLabel): Promise<{ label: MessageLabel }> {
      const existing = (await store.labels()).find((l) => l.id === label.id)
      // 内置的只能改名改色：`builtin` 由库说了算，不由入参说了算
      const next: MessageLabel = { ...label, builtin: existing?.builtin ?? false }
      await store.putLabel(next)
      return { label: next }
    },

    async deleteLabel(_actor: MessageActor, id: string): Promise<{ deleted: boolean }> {
      return { deleted: await store.deleteLabel(id) }
    },

    async mergeLabels(
      _actor: MessageActor,
      from: string,
      into: string,
    ): Promise<{ moved: number; labels: MessageLabel[] }> {
      let moved = 0
      for (const m of await store.list({ label: from, limit: 100_000 })) {
        const labels = [...new Set([...m.labels.filter((l) => l !== from), into])]
        await store.update(m.id, { labels })
        moved += 1
      }
      await store.deleteLabel(from)
      return { moved, labels: await store.labels() }
    },

    /**
     * WP439（docs/108 §5.1.5）：规则清单——你教过的发件人（命中数现算），共用模式写「谁教的」名字，
     * 外加刚删的几条（能撤回）。
     */
    async senderRules(actor: MessageActor): Promise<SenderRuleList> {
      const now = clock.now()
      const shared = (await options.sharedRules?.()) === true
      const names = new Map<string, string | undefined>()
      const nameOf = async (id: PersonId): Promise<string | undefined> => {
        if (!shared || options.personName === undefined) return undefined
        if (!names.has(id))
          names.set(id, await Promise.resolve(options.personName(id)).catch(() => undefined))
        return names.get(id)
      }
      const rules: SenderRuleView[] = []
      for (const r of await store.senderRules()) {
        const by_name = await nameOf(r.by)
        rules.push({
          ...senderRuleForList(r, now),
          ...(by_name === undefined ? {} : { by_name }),
          ...(r.by === actor.person_id ? { by_me: true } : {}),
        })
      }
      // 命中多的在前；一样多按最近命中、再按教的先后
      rules.sort(
        (a, b) =>
          (b.hits_30d ?? 0) - (a.hits_30d ?? 0) ||
          (b.last_hit_at ?? '').localeCompare(a.last_hit_at ?? '') ||
          b.created_at.localeCompare(a.created_at),
      )
      const recently_deleted: DeletedSenderRule[] = []
      for (const d of undoableDeletedRules((await store.deletedSenderRules?.()) ?? [], now)) {
        const deleted_by_name = await nameOf(d.deleted_by)
        recently_deleted.push({
          ...d,
          rule: senderRuleForList(d.rule, now),
          ...(deleted_by_name === undefined ? {} : { deleted_by_name }),
          ...(d.deleted_by === actor.person_id ? { deleted_by_me: true } : {}),
        })
      }
      return { rules, shared, recently_deleted }
    },

    /**
     * 删一条发件人规则：当场生效（下一封那个发件人重新走模型）。WP439：留一份「刚删的」能撤回；
     * 共用模式里通知同岗位（决策 243：谁都能删、留名、通知、能撤回）。
     */
    async deleteSenderRule(
      actor: MessageActor,
      id: string,
    ): Promise<{ deleted: boolean; rule?: SenderRule }> {
      const prior = (await store.senderRules()).find((r) => r.id === id)
      const deleted = await store.deleteSenderRule(id)
      rulesCache = await store.senderRules()
      if (!deleted || prior === undefined) return { deleted }
      const at = clock.now()
      await store.putDeletedSenderRule?.({
        rule: prior,
        deleted_by: actor.person_id,
        deleted_at: at,
      })
      options.appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'messages.sender_rule_deleted',
        actor: { kind: 'person', id: actor.person_id },
        subject: { type: 'sender_rule', id },
        correlation: { trace_id: `tr_msgrule_${id}_${at}` },
        // 63 §10：只有域，没有完整地址
        payload: { sender_domain: domainOf(prior.sender), source: prior.source ?? 'user' },
      })
      if ((await options.sharedRules?.()) === true) {
        try {
          await options.notifyRuleChange?.({ by: actor.person_id, action: 'deleted', rule: prior })
        } catch (e) {
          logQuiet('sender_rule_notify_failed', '', e)
        }
      }
      return { deleted, rule: senderRuleForList(prior, at) }
    },

    /** WP439：撤回刚删的那一条（同一个 id 放回去，命中账一起回来）。已经又教过同一个发件人的不覆盖。 */
    async restoreSenderRule(
      actor: MessageActor,
      id: string,
    ): Promise<{ restored: boolean; rule?: SenderRule }> {
      const now = clock.now()
      const row = undoableDeletedRules((await store.deletedSenderRules?.()) ?? [], now).find(
        (d) => d.rule.id === id,
      )
      if (row === undefined) return { restored: false }
      await store.dropDeletedSenderRule?.(id)
      const current = await store.senderRules()
      if (current.some((r) => r.id === id)) return { restored: false }
      await store.putSenderRule(row.rule)
      rulesCache = await store.senderRules()
      options.appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'messages.sender_rule_restored',
        actor: { kind: 'person', id: actor.person_id },
        subject: { type: 'sender_rule', id },
        correlation: { trace_id: `tr_msgrule_${id}_${now}` },
        payload: { sender_domain: domainOf(row.rule.sender) },
      })
      if ((await options.sharedRules?.()) === true && actor.person_id !== row.deleted_by) {
        try {
          await options.notifyRuleChange?.({
            by: actor.person_id,
            action: 'restored',
            rule: row.rule,
          })
        } catch (e) {
          logQuiet('sender_rule_notify_failed', '', e)
        }
      }
      return { restored: true, rule: senderRuleForList(row.rule, now) }
    },

    /* ── WP441：消息规则 ─────────────────────────────────────────────── */

    messageRules: (actor) => ruleService.list(actor),
    async createMessageRule(actor, draft) {
      return { rule: await ruleService.create(actor, draft) }
    },
    async updateMessageRule(actor, id, patch) {
      return { rule: await ruleService.update(actor, id, patch) }
    },
    async deleteMessageRule(actor, id) {
      return { deleted: await ruleService.remove(actor, id) }
    },
    async restoreMessageRule(actor, id) {
      const rule = await ruleService.restore(actor, id)
      return rule === undefined ? { restored: false } : { restored: true, rule }
    },
    reorderMessageRules: (actor, ids) => ruleService.reorder(actor, ids),
    trialMessageRule: (_actor, draft) => ruleService.trial(draft),
    proposeMessageRule: (actor, input) =>
      ruleService.propose(
        {
          person_id: actor.person_id,
          ...(actor.assignment_id === '' ? {} : { assignment_id: actor.assignment_id }),
        },
        input,
      ),
    async excludeFromMessageRule(actor, message_id, rule_id) {
      const rule = await ruleService.exclude(actor, message_id, rule_id)
      suggester.invalidate(message_id)
      return { rule }
    },
    digest: () => ruleService.digest(),
    async ackDigest(_actor, message_ids) {
      return { acked: await ruleService.ackDigest(message_ids) }
    },

    async drafts(): Promise<{ drafts: MessageDraft[] }> {
      return { drafts: await store.drafts() }
    },

    async saveDraft(
      _actor: MessageActor,
      input: MessageDraftInput,
    ): Promise<{ draft: MessageDraft }> {
      const id = input.id ?? `dft_${sha256(`${workspace_id}|${clock.now()}`).slice(0, 16)}`
      const prior = await store.getDraft(id)
      const draft: MessageDraft = {
        id,
        workspace_id,
        account: input.account ?? prior?.account ?? options.accounts()[0]?.address ?? '',
        ...((input.thread_id ?? prior?.thread_id) === undefined
          ? {}
          : { thread_id: (input.thread_id ?? prior?.thread_id) as string }),
        ...((input.in_reply_to ?? prior?.in_reply_to) === undefined
          ? {}
          : { in_reply_to: (input.in_reply_to ?? prior?.in_reply_to) as string }),
        to: input.to ?? prior?.to ?? [],
        cc: input.cc ?? prior?.cc ?? [],
        bcc: input.bcc ?? prior?.bcc ?? [],
        subject: input.subject ?? prior?.subject ?? '',
        text: input.text ?? prior?.text ?? '',
        attachments: prior?.attachments ?? [],
        updated_at: clock.now(),
      }
      await store.putDraft(draft)
      return { draft }
    },

    async discardDraft(_actor: MessageActor, id: string): Promise<{ deleted: boolean }> {
      return { deleted: await store.deleteDraft(id) }
    },

    async send(_actor: MessageActor, input: MessageSendInput): Promise<MessageSendResult> {
      const draft = input.draft_id === undefined ? undefined : await store.getDraft(input.draft_id)
      const to = (input.to ?? draft?.to ?? []).map((a) => a.email)
      const cc = (input.cc ?? draft?.cc ?? []).map((a) => a.email)
      const bcc = (input.bcc ?? draft?.bcc ?? []).map((a) => a.email)
      const subject = input.subject ?? draft?.subject ?? ''
      const text = input.text ?? draft?.text ?? ''
      const thread_id = input.thread_id ?? draft?.thread_id
      const in_reply_to = input.in_reply_to ?? draft?.in_reply_to
      const account = input.account ?? draft?.account ?? options.accounts()[0]?.address
      // 幂等键按"草稿 + 内容"算：网络抖了一下人又按了一次，只会发出一封
      const idempotency_key = `msg_send_${sha256(
        JSON.stringify({ to, cc, bcc, subject, text, thread_id }),
      ).slice(0, 24)}`
      const references =
        thread_id === undefined
          ? []
          : (await store.thread(thread_id)).flatMap((m) =>
              m.message_id === undefined ? [] : [m.message_id],
            )
      const send = options.sendMail
      if (send === undefined)
        throw new ApiError('not_implemented', '这台机器上没接发信，这封没发出去。')
      const result = await send({
        ...(account === undefined ? {} : { account }),
        to,
        cc,
        bcc,
        subject,
        text,
        ...(in_reply_to === undefined ? {} : { in_reply_to }),
        references,
        ...(thread_id === undefined ? {} : { thread_ref: thread_id }),
        idempotency_key,
      })
      // WP204：以前抛裸 Error → 500「internal error」，人只看到"出错了"，信还以为发了
      if (!result.ok) {
        const why = result.error ?? '发送失败，这封没发出去。'
        throw new ApiError(why === OUTBOUND_HALTED ? 'halted' : 'provider_unavailable', why)
      }
      if (input.draft_id !== undefined) await store.deleteDraft(input.draft_id)
      // 回信之后把被回的那封标成"已回"（也回写 IMAP）
      if (thread_id !== undefined) {
        for (const m of await store.thread(thread_id)) {
          if (m.message_id !== in_reply_to) continue
          await store.update(m.id, { flags: { ...m.flags, answered: true, read: true } })
          await writeFlags(m, { answered: true, read: true })
        }
      }
      return { outbox_id: result.outbox_id, message_id: result.message_id }
    },

    async assistant(_actor: MessageActor, id: string): Promise<MailAssistantView> {
      const row = await requireMessage(id)
      const history = await store.list({ q: row.from.email, limit: 200 })
      /*
       * WP212（docs/88 §5.1b）：助手是**兜底处理的助手**——只在没人接的信上生成回复建议（花 token）；
       * 岗位在办的信只挂「X 在办 · 有 N 张卡等你 →」，一条建议都不生成。
       */
      const { summary: owner } = await claimOfThreadId(row.thread_id)
      const handed = owner?.claim === 'handed'
      const needsReply = row.triage?.needs_reply === true && !handed
      const knowledge =
        needsReply && options.searchKnowledge !== undefined
          ? await options.searchKnowledge(`${row.subject}\n${row.text.slice(0, 500)}`, 3)
          : []
      const context = (await store.thread(row.thread_id))
        .filter((m) => m.id !== row.id)
        .slice(-3)
        .map((m) => `${m.from.email}: ${m.snippet}`)
      /*
       * WP439（docs/108 §5.7 ①）：品牌口吻——已归某个岗位的（交给过 / 「交给 X」是主按钮的）用那条职责的
       * 口吻段，没人接的用品牌口吻；语言按来信（决策 336），判不出退回品牌默认语言，再不行中文。
       */
      const handTo = needsReply
        ? suggestFor(
            {
              kind: kindOfLegacy(row.triage, row.labels, row.route).kind,
              needs_reply: true,
              suggested_position: row.triage?.suggested_position,
              suggested_route: row.triage?.suggested_route,
            },
            positionOptions(),
          )
        : undefined
      const voicePosition =
        row.handled?.position_id ?? (handTo?.action === 'hand' ? handTo.position : undefined)
      const voice = needsReply
        ? await Promise.resolve(options.voice?.({ position_id: voicePosition })).catch(
            () => undefined,
          )
        : undefined
      const suggestions: ReplySuggestion[] = needsReply
        ? await suggester.suggest(row.id, {
            subject: row.subject,
            from: row.from.email,
            body: row.text.slice(0, 2000),
            context,
            ...(voice === undefined || voice === '' ? {} : { voice }),
            knowledge,
            kinds: ['short', 'detailed', 'decline'],
            lang: replyLanguage(
              `${row.subject}\n${row.text.slice(0, 2000)}`,
              options.brandLanguage?.(),
            ),
          })
        : []
      const todos =
        options.work === undefined
          ? []
          : options.work
              .listTodos({})
              .filter((t) => t.note?.includes(row.from.email) === true)
              .slice(0, 5)
              .map((t) => ({ id: t.id, title: t.title, status: t.status }))
      return {
        message_id: row.id,
        summary: row.triage?.summary ?? '',
        needs_reply: needsReply,
        suggestions,
        sender: {
          address: row.from.email,
          ...(row.from.name === undefined ? {} : { name: row.from.name }),
          history_count: history.length,
          linked:
            row.linked === undefined
              ? []
              : [{ type: row.linked.type, id: row.linked.id, label: row.linked.id }],
        },
        todos,
        model_available: options.models !== undefined,
        ...(owner?.claim === undefined ? {} : { claim: owner.claim }),
        ...(owner?.handed_to === undefined ? {} : { handed_to: owner.handed_to }),
        ...(owner?.open_card_count === undefined ? {} : { open_card_count: owner.open_card_count }),
        ...(owner?.card_link === undefined ? {} : { card_link: owner.card_link }),
      }
    },

    /**
     * WP167：「待确认」那一栏上人点的那一下——**人工分拣**，写事件。
     *
     * 「这是客服」= 交给客服那一路（开事项、判断层、起 Run），再按这只邮箱的开关动邮箱；
     * 交不出去（客服岗位没开、原信取不回）就什么都不改，信还挂在待确认里，界面照实说。
     * 「不是」= 只记人的判断，信留在收件箱，从待确认里消失。
     *
     * WP212：「交给 X」推广到所有岗位（`route: 'position'` + 岗位模板 id）。客服 / 红人 / B2B
     * 那三个岗位仍走 63 的老路；其余岗位走 54 的「交给这个岗位一件事」（开事项、岗位内路由、
     * 起 Run，有要你定的出卡——卡在卡片流里，消息页不再催）。交出去的信记 `handled`。
     */
    async confirmRoute(
      actor: MessageActor,
      id: string,
      input: MessageConfirmRouteInput,
    ): Promise<MessageConfirmRouteResult> {
      await ensureSeeded()
      const row = await requireMessage(id)
      const at = clock.now()
      // WP212：给的是那三个岗位之一就走对应的老路；给的是老路就补上岗位 id
      let route: MessageConfirmRouteInput['route'] = input.route
      let position_id = input.position_id
      if (route === 'position') {
        if (position_id === undefined)
          throw new ApiError('invalid_input', '要交给哪个岗位？没给岗位。')
        route = routeOfPosition(position_id) ?? 'position'
      } else if (route !== 'inbox') {
        position_id = POSITION_OF_ROUTE[route]
      }
      let handed: { accepted: boolean; matter_id?: string; refused?: string } = {
        accepted: false,
      }
      if (route === 'position') {
        handed = await handToPosition(row, position_id as string, actor.person_id)
      } else if (route !== 'inbox') {
        try {
          handed = await handOff(row, route, undefined, 'user')
        } catch (e) {
          logQuiet('support_intake_failed', row.account, e)
        }
        if (!handed.accepted)
          handed = {
            ...handed,
            refused:
              route === 'support' && !supportEnabled()
                ? '客服岗位没开，开了才能交。'
                : route === 'kol' && !kolEnabled()
                  ? '红人营销岗位没开，开了才能交。'
                  : route === 'b2b' && !b2bEnabledFor(row.account)
                    ? 'B2B 岗位没开（或这只邮箱不收 B2B 信），开了才能交。'
                    : // WP417（自查 U13）：说人话、给下一步
                      '没交成功：这封信的原文没取回来。可以再点一次，或者点「我自己回」。',
          }
      }
      const event = (handed_off: boolean): void =>
        options.appendEvent({
          schema_version: 1,
          workspace_id,
          type: 'messages.route_confirmed',
          actor: { kind: 'person', id: actor.person_id },
          subject: { type: 'message', id: row.id },
          correlation: { trace_id: `tr_msgconfirm_${row.id}_${at}` },
          // 63 §10：没有正文、地址遮过
          payload: {
            route,
            handed_off,
            account: maskAddress(row.account),
            ...(position_id === undefined ? {} : { position_id }),
            ...(row.triage?.suggested_route === undefined
              ? {}
              : { suggested_route: row.triage.suggested_route }),
            ...(handed.matter_id === undefined ? {} : { matter_id: handed.matter_id }),
          },
        })
      if (route !== 'inbox' && !handed.accepted) {
        event(false)
        return {
          message: row,
          handed_off: false,
          ...(handed.refused === undefined ? {} : { refused: handed.refused }),
        }
      }
      const storedRoute: MessageRoute = route === 'position' ? 'inbox' : route
      const triage: MessageTriage = {
        ...userVerdict(storedRoute, at, row.labels),
        ...kindFieldsOf(row.triage),
        summary: row.triage?.summary ?? '',
        reasons: [
          route === 'position' || input.position_id !== undefined
            ? '人工分拣：在「没人接的」里点的「交给 X」'
            : '人工分拣：在「待确认」里点的',
        ],
      }
      let next =
        (await store.update(row.id, {
          route: storedRoute,
          triage,
          ...(handed.matter_id === undefined
            ? {}
            : { linked: { type: 'matter' as const, id: handed.matter_id } }),
          ...(route === 'inbox' || position_id === undefined
            ? {}
            : {
                handled: {
                  as: 'position' as const,
                  position_id,
                  ...(handed.matter_id === undefined ? {} : { matter_id: handed.matter_id }),
                  by: actor.person_id,
                  at,
                },
              }),
        })) ?? row
      suggester.invalidate(row.id)
      if (route === 'support' || route === 'kol' || route === 'b2b')
        next = await moveAfterHandoff(next, route)
      event(route !== 'inbox')
      // WP212：交给的不是 AI 建议的那个岗位 → 一次纠正（进学习回路、「你教过它」里看得见）
      if (position_id !== undefined) {
        const kind = kindOfLegacy(row.triage, row.labels, row.route).kind
        const suggested = row.triage?.suggested_position ?? positionForKind(kind)
        if (suggested !== position_id)
          await correct(row, {
            field: 'position',
            ...(suggested === undefined ? {} : { from: suggested }),
            to: position_id,
            remembered: input.remember_sender === true,
            by: actor.person_id,
          })
      }
      const rule =
        input.remember_sender === true && position_id !== undefined
          ? await rememberSender(
              row,
              {
                position: position_id,
                ...(route === 'support' || route === 'kol' || route === 'b2b' ? { route } : {}),
                kind: kindOfLegacy(row.triage, row.labels, row.route).kind,
              },
              actor.person_id,
            )
          : undefined
      return {
        message: next,
        handed_off: route !== 'inbox',
        ...(handed.matter_id === undefined ? {} : { matter_id: handed.matter_id }),
        ...(position_id === undefined || route === 'inbox' ? {} : { position_id }),
        ...(rule === undefined ? {} : { rule }),
      }
    },

    /** WP212：改判类型。勾「以后都这样」写发件人规则（下次不花模型），不勾进学习回路。 */
    async setKind(
      actor: MessageActor,
      id: string,
      input: MessageKindInput,
    ): Promise<{ message: MessageRecord; rule?: SenderRule }> {
      const row = await requireMessage(id)
      const before = kindOfLegacy(row.triage, row.labels, row.route).kind
      const at = clock.now()
      const base: MessageTriage = row.triage ?? {
        route: row.route,
        labels: [...row.labels],
        needs_reply: true,
        priority: 'normal',
        summary: '',
        confidence: 1,
        by: 'user',
        reasons: [],
        at,
      }
      const next =
        (await store.update(id, {
          triage: { ...base, kind: input.kind, kind_by: 'user', kind_confidence: 1 },
        })) ?? row
      suggester.invalidate(id)
      const remembered = input.remember_sender === true
      if (before !== input.kind)
        await correct(row, {
          field: 'kind',
          from: before,
          to: input.kind,
          remembered,
          by: actor.person_id,
        })
      if (!remembered) return { message: next }
      const rule = await rememberSender(row, { kind: input.kind }, actor.person_id)
      return { message: next, rule }
    },

    /** WP212：「只是通知」/「我自己处理」/ 撤销。 */
    async claim(
      actor: MessageActor,
      id: string,
      input: MessageClaimInput,
    ): Promise<{ message: MessageRecord; writeback?: MessageWriteback }> {
      const row = await requireMessage(id)
      if (input.as === 'none') {
        const { handled: _dropped, ...rest } = row
        await store.put(rest)
        return { message: rest }
      }
      const next =
        (await store.update(id, {
          handled: { as: input.as, by: actor.person_id, at: clock.now() },
        })) ?? row
      if (input.as !== 'notice') return { message: next }
      const writeback = await readForNotice(next)
      return { message: (await store.get(id)) ?? next, writeback }
    },

    /**
     * WP459（决策 1498 / 1504）：**改判**「AI 猜的」——交给别的岗位 / 我自己处理 / 只是通知。
     *
     * 先把信交给新主人（交不出去就什么都不改，原岗位照旧在办）；交出去之后撤掉原岗位还没批的卡、
     * 关掉那件事项。一封信同一时刻只有一个主人（v1 §1.3）。
     * 不勾「以后都交给 X」时，同一个发件人第二次被改判到同一个岗位，AI 自己记住（`source: 'ai'`，规则面板能撤）。
     */
    async rehand(
      actor: MessageActor,
      id: string,
      input: MessageRehandInput,
    ): Promise<MessageRehandResult> {
      await ensureSeeded()
      const row = await requireMessage(id)
      const thread = await store.thread(row.thread_id)
      const before = aggregateThreads(thread)[0]
      const from = before?.handed_to
      if (input.to === 'position') {
        const target = input.position_id
        if (target === undefined) throw new ApiError('invalid_input', '要交给哪个岗位？没给岗位。')
        if (target === from)
          return { message: row, withdrawn: 0, handed_off: true, position_id: target }
        const option = positionOptions().find((p) => p.id === target)
        if (option === undefined || !option.open)
          return {
            message: row,
            withdrawn: 0,
            handed_off: false,
            refused: `${option?.name_zh ?? target}岗位没开，开了才能交。`,
          }
      }
      // 原主人名下的事项（交新主人之前记下：新主人可能接着用同一条会话开新的）
      const oldMatters = [
        ...new Set(
          thread.flatMap((m) => [
            ...(m.linked?.type === 'matter' ? [m.linked.id] : []),
            ...(m.handled?.matter_id === undefined ? [] : [m.handled.matter_id]),
          ]),
        ),
      ]
      let handed: MessageConfirmRouteResult | undefined
      let next: MessageRecord = row
      if (input.to === 'position') {
        const confirm = port.confirmRoute
        if (confirm === undefined) throw new ApiError('not_implemented', '这里改判不了')
        handed = await confirm(actor, row.id, {
          route: 'position',
          position_id: input.position_id,
          ...(input.remember_sender === true ? { remember_sender: true } : {}),
        })
        if (!handed.handed_off)
          return {
            message: handed.message,
            withdrawn: 0,
            handed_off: false,
            ...(handed.refused === undefined ? {} : { refused: handed.refused }),
          }
        next = handed.message
      } else {
        const at = clock.now()
        const triage: MessageTriage | undefined =
          row.triage === undefined
            ? undefined
            : (() => {
                const { ai_hand: _a, suggested_route: _r, ...rest } = row.triage
                return { ...rest, route: 'inbox' as const, by: 'user' as const }
              })()
        next =
          (await store.update(row.id, {
            route: 'inbox',
            ...(triage === undefined ? {} : { triage }),
            handled: { as: input.to, by: actor.person_id, at },
          })) ?? row
        if (input.to === 'notice') await readForNotice(next)
        next = (await store.get(row.id)) ?? next
      }
      // 同一条会话里别的信也还挂在原来那条路上（客服 / 红人 / B2B）：收回到收件箱，主人只认新的这一个
      for (const m of thread) {
        if (m.id === row.id || m.route === 'inbox') continue
        if (input.to === 'position' && routeOfPosition(input.position_id ?? '') === m.route)
          continue
        await store.update(m.id, { route: 'inbox' })
      }
      suggester.invalidate(row.id)
      const keep = new Set(handed?.matter_id === undefined ? [] : [handed.matter_id])
      const stale = oldMatters.filter((m) => !keep.has(m))
      let withdrawn = 0
      try {
        withdrawn =
          (await options.withdrawCards?.({
            thread_id: row.thread_id,
            matter_ids: stale,
            reason: 'message_rehand',
            person_id: actor.person_id,
          })) ?? 0
      } catch (e) {
        logQuiet('rehand_withdraw_failed', row.account, e)
      }
      for (const matter_id of stale) {
        try {
          options.work?.closeMatter(matter_id, { unfinished: 'close_all', by: actor.person_id })
        } catch (e) {
          logQuiet('rehand_close_matter_failed', row.account, e)
        }
      }
      // 决策 1504：同一个发件人改判到同一个岗位第二次 → AI 自己记住（人教过的不动）
      let rule = handed?.rule
      let learned = false
      if (
        input.to === 'position' &&
        input.remember_sender !== true &&
        input.position_id !== undefined
      ) {
        const sender = row.from.email.trim().toLowerCase()
        const prior = (await store.senderRules()).find(
          (r) => r.sender.trim().toLowerCase() === sender,
        )
        if (prior === undefined || prior.source === 'ai') {
          const corrections = (await store.corrections?.(500)) ?? []
          let times = 0
          for (const c of corrections) {
            if (c.field !== 'position' || c.to !== input.position_id) continue
            const m = c.message_id === row.id ? row : await store.get(c.message_id)
            if (m?.from.email.trim().toLowerCase() === sender) times += 1
          }
          if (times >= 2 && prior?.position !== input.position_id) {
            const route = routeOfPosition(input.position_id)
            rule = await rememberSender(
              row,
              {
                position: input.position_id,
                ...(route === undefined ? {} : { route }),
                kind: kindOfLegacy(row.triage, row.labels, row.route).kind,
              },
              actor.person_id,
              'ai',
            )
            learned = true
          }
        }
      }
      const at = clock.now()
      options.appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'messages.rehanded',
        actor: { kind: 'person', id: actor.person_id },
        subject: { type: 'message', id: row.id },
        correlation: { trace_id: `tr_msgrehand_${row.id}_${at}` },
        // 63 §10：没有正文、地址遮过
        payload: {
          ...(from === undefined ? {} : { from }),
          to: input.to === 'position' ? (input.position_id ?? '') : input.to,
          withdrawn,
          learned,
          account: maskAddress(row.account),
        },
      })
      return {
        message: next,
        withdrawn,
        handed_off: true,
        ...(input.to === 'position' && input.position_id !== undefined
          ? { position_id: input.position_id }
          : {}),
        ...(rule === undefined ? {} : { rule }),
        ...(learned ? { learned: true } : {}),
      }
    },

    /**
     * WP459：最近 7 天 AI 猜着交给岗位的那几封（收件箱认「AI 猜的 · 改」；简报只数今天的）。
     */
    async guessed(): Promise<{ rows: MessageGuessRow[] }> {
      await ensureSeeded()
      const since = Date.parse(clock.now()) - 7 * 24 * 3_600_000
      const all = await store.list({ limit: 100_000 })
      const threads = aggregateThreads(all).filter(
        (t) => t.ai_hand?.guessed === true && Date.parse(t.last_at) >= since,
      )
      const cards = await waitingCards()
      const matterOf = (m: MessageRecord): string | undefined =>
        m.handled?.matter_id ?? (m.linked?.type === 'matter' ? m.linked.id : undefined)
      const rows: MessageGuessRow[] = []
      for (const t of threads) {
        const ai = t.ai_hand
        if (ai === undefined) continue
        const m = all.find((x) => x.id === ai.message_id)
        if (m === undefined) continue
        const open =
          cards.length === 0
            ? 0
            : cardsOf(
                all.filter((x) => x.thread_id === t.thread_id),
                cards,
              ).open_card_count
        rows.push({
          message_id: m.id,
          thread_id: t.thread_id,
          subject: m.subject,
          from: m.from,
          position_id: ai.position_id,
          confidence: ai.confidence,
          at: m.date,
          ...(open > 0 ? { open_card_count: open } : {}),
          ...(matterOf(m) === undefined ? {} : { matter_id: matterOf(m) as string }),
        })
      }
      return { rows: rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) }
    },

    /** WP212：「只是通知」整捆「知道了」。 */
    async ackNotices(
      actor: MessageActor,
      input: MessageNoticeAckInput,
    ): Promise<{ acked: number; writeback?: MessageWriteback }> {
      const rows = await store.threads({ claim: 'notice', limit: 5000 })
      const wanted = new Set(input.thread_ids ?? [])
      let acked = 0
      let failed = false
      let local = false
      for (const row of rows) {
        const suspicious = row.labels.includes('suspicious')
        if (input.suspicious === true && !suspicious) continue
        if (input.kind !== undefined && (suspicious || row.kind !== input.kind)) continue
        if (wanted.size > 0 && !wanted.has(row.thread_id)) continue
        if (row.claim_message_id === undefined) continue
        const m = await store.update(row.claim_message_id, {
          handled: { as: 'notice', by: actor.person_id, at: clock.now() },
        })
        if (m === undefined) continue
        const wb = await readForNotice(m)
        if (wb === 'failed') failed = true
        if (wb === 'local_only') local = true
        acked += 1
      }
      return {
        acked,
        ...(acked === 0 ? {} : { writeback: failed ? 'failed' : local ? 'local_only' : 'written' }),
      }
    },

    /** WP212：「没人接的」顶上那一行、「只是通知」几捆、「你教过它」。 */
    async overview(): Promise<MessageOverview> {
      const all = await store.list({ limit: 100_000 })
      const threads = aggregateThreads(all)
      const byPosition = new Map<string, number>()
      const groups = new Map<MessageKind | 'suspicious', { count: number; senders: Set<string> }>()
      let unclaimed = 0
      let notice = 0
      let handed = 0
      for (const t of threads) {
        if (t.claim === 'unclaimed') unclaimed += 1
        if (t.claim === 'handed') {
          handed += 1
          const to = t.handed_to
          if (to !== undefined && to !== 'me' && to !== 'notice')
            byPosition.set(to, (byPosition.get(to) ?? 0) + 1)
        }
        if (t.claim === 'notice') {
          notice += 1
          const key = t.labels.includes('suspicious') ? 'suspicious' : (t.kind ?? 'marketing')
          const g = groups.get(key) ?? { count: 0, senders: new Set<string>() }
          g.count += 1
          const who = t.participants[0]
          if (who !== undefined && g.senders.size < 4) g.senders.add(who.name ?? who.email)
          groups.set(key, g)
        }
      }
      const cards = await waitingCards()
      const cards_waiting =
        cards.length === 0
          ? 0
          : cardsOf(
              all.filter((m) => m.route !== 'inbox' || m.handled?.as === 'position'),
              cards,
            ).open_card_count
      const rules = await store.senderRules()
      return {
        unclaimed,
        notice,
        handed,
        handed_by_position: [...byPosition.entries()]
          .map(([position_id, count]) => ({ position_id, count }))
          .sort((a, b) => b.count - a.count),
        cards_waiting,
        notice_groups: [...groups.entries()].map(([kind, g]) => ({
          kind,
          count: g.count,
          senders: [...g.senders],
        })),
        positions: positionOptions(),
        taught: {
          rules: rules.length,
          // 按发件人规则直达的信——每一封都是"少问你一次"、少花一次模型
          saved: all.filter((m) => m.triage?.reasons.some((r) => r.startsWith('发件人规则')))
            .length,
          recent: (await store.corrections?.(5)) ?? [],
        },
      }
    },

    async toTodo(actor: MessageActor, id: string): Promise<{ todo: Todo }> {
      const work = options.work
      if (work === undefined) throw new Error('这个服务进程没装工作模型，转不了待办')
      const row = await requireMessage(id)
      const position = options.position?.()
      const todo = work.createTodo({
        title: row.subject.trim() === '' ? `回 ${row.from.email}` : row.subject,
        owner: actor.person_id,
        note: `来自消息：${row.from.email}\n${row.snippet}`,
        horizon: 'today',
        ...(position === undefined ? {} : { position_id: position.assignment_id }),
      })
      return { todo }
    },

    async sync(): Promise<MessageSyncReport> {
      await ensureSeeded()
      rulesCache = await store.senderRules()
      await ruleService.refresh()
      await refreshFolders()
      return sync.sync()
    },

    async backfill(_actor: MessageActor, input: MessageBackfillInput): Promise<{ floor: string }> {
      const address = input.account ?? options.accounts()[0]?.address ?? ''
      return { floor: sync.backfill(address, input.days ?? 30) }
    },
  }

  /**
   * WP167 终审追加：升级那一拍预写台账（本进程只跑一次；台账里有标记就不再算）。
   *
   * 算的是"老版本已经交给客服那一路的信"：工作模型里每条会话事项钉着的线程——线程 id 就是
   * 那条线程第一封信的 Message-ID——外加消息库里这些线程下的每一封信。INBOX 里老版本处理过
   * 但消息库还没见过的信，由渠道那边按适配器原先的游标认（见 `channels.ts` 的 `legacyCutoffOf`）。
   */
  let seeding: Promise<void> | undefined
  const ensureSeeded = (): Promise<void> => {
    const seed = options.seedSupportIntake
    if (seed === undefined || options.intakeSupport === undefined) return Promise.resolve()
    seeding ??= seed(LEGACY_SEED_MARKER, async () => {
      const threads = new Set<string>()
      for (const m of options.work?.listMatters({ kind: 'conversation' }) ?? []) {
        for (const p of m.context.pinned) if (p.type === 'thread') threads.add(p.id)
      }
      const keys = new Set<string>()
      for (const thread of threads) {
        // 渠道那一路给没有 Message-ID 的信造的线程 id（`email-thread:…`）不是一封信的身份
        if (!thread.startsWith('email-thread:')) {
          keys.add(supportIntakeKey({ account: '', message_id: thread, folder: '' }))
        }
        for (const row of await store.thread(thread)) {
          keys.add(
            supportIntakeKey({
              account: row.account,
              message_id: row.message_id,
              folder: row.folder,
              uid: row.uid,
            }),
          )
        }
      }
      return [...keys]
    }).then(
      () => undefined,
      (e) => {
        // 这一次没写成：下一轮再来（标记没写，重来一遍是幂等的）
        seeding = undefined
        logQuiet('support_intake_seed_failed', '', e)
      },
    )
    return seeding
  }

  const takeover = (): boolean => supportEnabled()
  const switches: MessagesAssembly['switches'] = {
    get: (address) => ({
      ...switchStore.get(address),
      takeover: takeover(),
      b2b_position: b2bEnabled(),
    }),
    set: (address, patch, by) => {
      const { after, changed } = switchStore.set(address, patch)
      if (changed.length > 0) {
        options.appendEvent({
          schema_version: 1,
          workspace_id,
          type: 'mailbox.switches_changed',
          actor: { kind: 'person', id: by },
          correlation: { trace_id: `tr_mbxsw_${clock.now()}` },
          // 只有改了哪几个、改成什么；地址遮过（63 §10）
          payload: {
            account: maskAddress(address),
            changed: Object.fromEntries(changed.map((k) => [k, after[k]])),
          },
        })
      }
      return { ...after, takeover: takeover(), b2b_position: b2bEnabled() }
    },
  }

  /** WP441：规则起草的回信卡批了 → 从收信那只邮箱回（同人自己按发送那一条路，过出站急停）。 */
  const deliverRuleDraft: MessagesAssembly['deliverRuleDraft'] = async (item) => {
    const p = item.payload as Record<string, unknown> | undefined
    if (item.kind !== 'outbound_draft' || p?.form !== MESSAGE_RULE_DRAFT_FORM) return undefined
    const message_id = typeof p.message_id === 'string' ? p.message_id : ''
    const row = await store.get(message_id)
    const body =
      (item.decision?.edited_payload as Record<string, unknown> | undefined)?.body ?? p.body
    const text =
      typeof (body as { text?: unknown })?.text === 'string' ? (body as { text: string }).text : ''
    const subject =
      typeof (body as { subject?: unknown })?.subject === 'string'
        ? (body as { subject: string }).subject
        : `Re: ${row?.subject ?? ''}`
    if (row === undefined || text.trim() === '')
      return {
        status: 'failed',
        error: { message: '没发出去：原来那封信不在了，或者回信是空的。', retryable: false },
      }
    try {
      await port.send(
        {
          workspace_id,
          person_id: item.routing.recipients[0]?.person ?? ('' as PersonId),
          assignment_id: '',
        },
        {
          account: row.account,
          to: [
            {
              email: row.from.email,
              ...(row.from.name === undefined ? {} : { name: row.from.name }),
            },
          ],
          subject,
          text,
          thread_id: row.thread_id,
          ...(row.message_id === undefined ? {} : { in_reply_to: row.message_id }),
        },
      )
      return { status: 'ok' }
    } catch (e) {
      return {
        status: 'failed',
        error: {
          message: e instanceof Error && e.message !== '' ? e.message : '没发出去。',
          retryable: true,
        },
      }
    }
  }

  return {
    store,
    sync,
    port,
    switches,
    rules: ruleService,
    deliverRuleDraft,
    async poll(): Promise<MessageSyncReport> {
      await ensureSeeded()
      rulesCache = await store.senderRules()
      await ruleService.refresh()
      // WP161：每只邮箱先列文件夹（各列各的、各缓存各的），再扫
      await refreshFolders()
      const report = await sync.sync()
      // WP441：今天的简报到点了就发一条铃铛（一天一次，0 封不发）
      try {
        await ruleService.digestTick()
      } catch (e) {
        logQuiet('message_digest_failed', '', e)
      }
      return report
    },
    otherFollowUp(thread_id, refs) {
      return (
        (options.kol?.isOurThread(thread_id, refs) ?? false) ||
        (options.b2b?.isOurThread(thread_id, refs) ?? false)
      )
    },
    close(): void {
      store.close?.()
    },
  }
}

/* ── 小零件 ───────────────────────────────────────────────────────────── */

/** 63 §10：日志里的地址一律遮掩（WP163 起实现挪到 `mailbox-actions.ts`，两处共用）。 */
export { maskAddress }

/** 标签同步成 IMAP keyword 时的名字（前缀避开别的软件自己的 keyword）。 */
export function keywordOf(label: string): string {
  return `agentsws_${label.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

/**
 * 「客服 Agent 在处理 / 等你拍板 / 已回复」（63 §9）。
 *
 * 判据取自工作模型：那条事项上还有没有等人定的卡。**不猜**——猜错的代价是
 * 人以为 Agent 在忙，其实那条线程停在等他点头。
 */
function agentState(
  options: MessagesOptions,
  matter_id: string | undefined,
): 'working' | 'waiting_for_you' | 'replied' {
  const work = options.work
  if (work === undefined || matter_id === undefined) return 'working'
  const matter = work.listMatters({}).find((m) => m.id === matter_id)
  if (matter === undefined) return 'working'
  if (matter.status === 'closed') return 'replied'
  if (matter.status === 'waiting') return 'waiting_for_you'
  return 'working'
}

/**
 * 每文件夹游标 / 毒消息隔离 / 租约。
 *
 * **自己一张库**（`messages-state.sqlite`），不与渠道那张 `channels.sqlite` 共用：
 * 两边扫的是同一只邮箱但推的是两条水位（那边只扫 INBOX 且只为落事项，这边扫六个
 * 文件夹且要落库）。共用一张表等于两条水位互相踩。租约 key 也已经错开成
 * `msg:<地址>`（见 `sync.ts` 的注释）。
 */
function mailboxState(options: MessagesOptions): MailboxStateStore {
  return options.dbDir === undefined
    ? new MemoryMailboxStateStore()
    : new SqliteMailboxStateStore({
        dbPath: join(options.dbDir, 'messages-state.sqlite'),
        clock: options.clock,
      })
}

/* ── 模型那两处（63 §10：全仓只有这两处把信件内容送出去） ─────────────── */

const TRIAGE_SYSTEM = [
  '你是一个邮件分拣助手。读一封邮件的头与正文前 2000 字，判断它归哪一类。',
  'route 的含义：support = 零售顾客的售后 / 订单问题；kol = 红人 / 博主想谈合作；',
  'b2b = 企业买家的询盘（询价、要目录、问起订量、要样品、找代理 / 分销、OEM）；inbox = 其他。',
  '只输出一个 JSON 对象，不要任何解释文字。字段：',
  'route（只能是给定 allowed_routes 里的一个）、labels（给定 allowed_labels 的子集）、',
  'needs_reply（布尔）、priority（high/normal/low）、summary（≤40 个字的中文一句话，',
  '说的是"这封信要你干什么"）、confidence（0–1）、',
  'kind（这件事是什么，只能是给定 allowed_kinds 里的一个：customer_question 客户问题 / after_sales 售后 /',
  'inquiry 询盘 / creator_reply 红人回复 / partnership 合作 / media 媒体 / billing_system 账单与系统通知 /',
  'logistics 物流 / marketing 垃圾与营销 / personal_other 个人与其他）。',
  '拿不准就把 confidence 写低——写低不会有人骂你，猜高了信会被挪错地方。',
].join('\n')

async function classifyWithGateway(
  input: Parameters<TriageModel['classify']>[0],
  options: MessagesOptions,
  workspace_id: WorkspaceId,
): Promise<Awaited<ReturnType<TriageModel['classify']>>> {
  const models = options.models
  if (models === undefined) throw new Error('没有模型网关')
  const position = options.position?.()
  // WP441：带了要顺带判的消息规则就多一段说明（同一次调用；没有规则时提示词与老的一字不差）
  const rules = input.rules ?? []
  const completion = await models.complete({
    messages: [
      {
        role: 'system',
        content: rules.length === 0 ? TRIAGE_SYSTEM : `${TRIAGE_SYSTEM}\n${TRIAGE_RULES_SYSTEM}`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          from: input.from_email,
          from_name: input.from_name ?? '',
          subject: input.subject,
          // **不送附件**（63 §4 ④）
          body: input.body,
          allowed_routes: input.allowed_routes,
          allowed_labels: input.allowed_labels,
          ...(input.allowed_kinds === undefined ? {} : { allowed_kinds: input.allowed_kinds }),
          ...(rules.length === 0 ? {} : { rules }),
        }),
      },
    ],
    meta: {
      workspace_id,
      assignment_id: position?.assignment_id ?? 'asg_unknown',
      role_id: position?.role_id ?? 'common.member',
      run_id: 'run_message_triage',
      // 便宜档：分拣与抽取同一档预算，不占运行时那一档
      purpose: 'extraction',
    },
  })
  const parsed = parseJsonObject(completion.text)
  return {
    route: (parsed.route as MessageRoute) ?? 'inbox',
    labels: Array.isArray(parsed.labels) ? (parsed.labels as string[]) : [],
    needs_reply: parsed.needs_reply === true,
    priority:
      parsed.priority === 'high' || parsed.priority === 'low'
        ? (parsed.priority as 'high' | 'low')
        : 'normal',
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    // WP212：认不认得由分拣那一侧判（`normalizeVerdict`），这里原样递过去
    ...(typeof parsed.kind === 'string' ? { kind: parsed.kind } : {}),
    // WP441：顺带判的规则（只认递过去的那几条，由分拣那一侧筛）
    ...(parsed.rule_hits === undefined ? {} : { rule_hits: parsed.rule_hits }),
  }
}

const SUGGEST_SYSTEM = [
  `${SUGGEST_PROMPT_MARKER}给出若干条**互相有差别**的回复草稿——`,
  '不是同义改写：短的那条只说结论，详细的那条把理由与下一步写清楚，婉拒的那条要礼貌但明确。',
  '只输出 JSON 数组，每项 `{ "kind": "short"|"detailed"|"decline", "text": "..." }`。',
  // WP439（决策 336）：按来信语言写；口吻段是品牌话术，照它说话
  '草稿一律用 `lang` 那种语言写（ISO 639-1，`zh` = 中文、`en` = 英文……），和来信同一种语言。',
  '`voice` 不为空时是这个品牌的说话方式（语气、用词、签名），照它写；为空就用平实、礼貌的语气。',
  '引用到知识库内容时照原意说，不要编造政策或承诺。',
].join('\n')

function suggestModel(options: MessagesOptions, workspace_id: WorkspaceId): SuggestModel {
  return {
    async suggest(req: SuggestRequest) {
      const models = options.models
      if (models === undefined) return []
      const position = options.position?.()
      const completion = await models.complete({
        messages: [
          { role: 'system', content: SUGGEST_SYSTEM },
          {
            role: 'user',
            /*
             * WP471（docs/116 §2 第 9 条，决策 1549）：品牌话术 `voice` 同一品牌每封信都一样，
             * 排在 JSON 最前面（紧跟固定的系统提示），开头逐字相同、能命中缓存；
             * 这封信的主题、发件人、正文、材料在后面。字段不变、只换顺序。
             */
            content: JSON.stringify({
              voice: req.voice ?? '',
              subject: req.subject,
              from: req.from,
              body: req.body,
              context: req.context,
              knowledge: req.knowledge.map((k) => ({ title: k.title, text: k.text })),
              kinds: req.kinds,
              lang: req.lang,
            }),
          },
        ],
        meta: {
          workspace_id,
          assignment_id: position?.assignment_id ?? 'asg_unknown',
          role_id: position?.role_id ?? 'common.member',
          run_id: 'run_message_suggest',
          purpose: 'extraction',
        },
      })
      const rows = parseJsonArray(completion.text)
      return rows.flatMap((r) => {
        const kind = (r as { kind?: string }).kind
        const text = (r as { text?: string }).text
        if (typeof text !== 'string' || text.trim() === '') return []
        const k: ReplySuggestionKind = kind === 'detailed' || kind === 'decline' ? kind : 'short'
        return [{ kind: k, text }]
      })
    },
  }
}

/** 模型爱在 JSON 外面裹一层 ```；这里只认第一个 `{…}`。 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function parseJsonArray(text: string): unknown[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export type { Iso8601, MessageFolderKind }
