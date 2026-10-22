/**
 * WP323（docs/102 §5，决策 665 / 666 / 667）：**发出记录**与**记录去处**的形状。
 *
 * - **发出记录**（固定能力，永远有）：工坊替用户发出去的每一条（帖子 / 评论 / 回复 / 邮件 / 消息…）
 *   在发送确认成功那一刻自动记一行；之后对方的回复挂在这一行下面。对方删了原话，我们也清掉原话（667）。
 * - **记录去处**（通用机制，不内置任何一家，665）：用户用几句话交代「记到哪、哪些列、每列填什么、什么格式」，
 *   工坊读目标表的表头、生成「列 ← 填什么」的对照，出一张「定规矩」卡确认，之后每发一条照着写一行。
 *   去处的种类（飞书、Google Sheets、钉钉……）是藏在机制后面的**适配器**，界面上只显示用户自己交代的去处名字。
 *
 * 纪律（docs/29「数字不经模型手」）：AI 只负责选「这一列对应哪个字段 / 固定值 / 格式」，
 * 写进去的值永远从记录里直接取。
 */
import type { Iso8601, WorkspaceId } from './common.js'

/** 一条发出记录的状态：已发 / 失败（发送那一跳回了失败，仍留一行）/ 后来被删。 */
export type OutboundStatus = 'sent' | 'failed' | 'deleted'

/** 挂在一行发出记录下面的后续（对方的回复、我们的再回）。 */
export interface OutboundFollowUp {
  id: string
  at: Iso8601
  /** `them` = 对方回了我们；`us` = 我们又回了一条（它自己也是一行发出记录，这里只挂链接）。 */
  from: 'them' | 'us'
  author?: string
  /** 对方原话（外部文本）。对方删了就清空，`deleted: true`（667）。 */
  text?: string
  url?: string
  external_id?: string
  deleted?: boolean
  /** 要回的话出了哪张卡（链回卡片流）。 */
  approval_item_id?: string
  /** `from: 'us'` 时那一行发出记录的 id。 */
  record_id?: string
}

/** 一行发出记录。 */
export interface OutboundRecord {
  id: string
  workspace_id: WorkspaceId
  /** 同一条只记一次的那把键（`approval:<卡 id>` / `change:<变更 id>[:n]` / `post:<帖子 id>`）。 */
  source_key: string
  sent_at: Iso8601
  /** 渠道：`reddit` / `email` / `x` / `discord` / `chat` …（与 `SocialChannel`、邮件渠道同名）。 */
  channel: string
  /** 动作：`reply` / `post` / `comment` / `email` / `message` / `broadcast` …。 */
  action: string
  /** 出自哪种卡 / 变更（`outbound_draft`、`b2b_outreach`、`social_post` …）。 */
  kind: string
  /** 发到哪（版块 / 群 / 收件人）。 */
  destination?: string
  /** 原帖 / 原线程标题。 */
  thread_title?: string
  /** 原帖 / 原线程链接。 */
  thread_url?: string
  /** 对方（用户名 / 联系人）。 */
  counterpart?: string
  /** 对方原话摘要（外部文本）。对方删了就清空（667）。 */
  counterpart_text?: string
  counterpart_deleted?: boolean
  /** 邮件主题。 */
  subject?: string
  /** 我们发的全文。永远保留。 */
  content: string
  /** 我们发的那一条的链接。 */
  link?: string
  /** 我们发的那一条在平台上的 id（之后挂后续用）。 */
  external_id?: string
  /** 回的是哪一条（平台 id）。 */
  parent_external_id?: string
  /** 为什么发：AI 判的档位、用到的 FAQ。 */
  reason?: { tier?: string; faq?: string[] }
  approval_item_id?: string
  change_id?: string
  matter_id?: string
  role_id?: string
  /** 谁批的（人名；系统自动批 = 「自动」）。 */
  approved_by?: string
  approved_at?: Iso8601
  /** WP413（只加）：在哪儿批的（`extension` = 在浏览器插件侧边栏里批的；没有 = 工坊里）。 */
  approved_via?: 'workstation' | 'im_card' | 'email' | 'api' | 'batch' | 'extension'
  status: OutboundStatus
  /**
   * WP415（只加）：发出去之后读回来核对过（链接 / 平台 id 对得上）。`false` = 发了但没能核对；
   * 没有这一格 = 老记录或写入点没说。
   */
  verified?: boolean
  /** 失败时的原话。 */
  failure?: string
  /**
   * WP432（只加）：AI 起草、人批的那一版——批了之后人又改过（在插件里改、或在页面上改了再发）才有；
   * `content` 永远是真发出去的那一版。两版的差进学习回路。
   */
  draft_content?: string
  /** WP432（只加）：这一条现在的票数（巡查时读回；没读过就没有）。 */
  score?: number
  /** WP432：票数是什么时候读的。 */
  score_at?: Iso8601
  /**
   * WP441（docs/108 §5.1.1「记到某处」）：消息规则记下的**一封来信**（动作 `message_rule`，只有点名的去处才记）。
   * 不是我们发出去的东西：`content` 放摘要，原文不进这一行。
   */
  message?: {
    sender: string
    received_at: Iso8601
    kind?: string
    summary?: string
    rule_names: string[]
    /** 工作台里打开这封信的地址（`/messages?thread=…`）。 */
    link: string
  }
  /** WP441：只写进这几个去处（消息规则点名的那一个）；不给 = 按各去处的筛选。 */
  only_sinks?: string[]
  follow_ups: OutboundFollowUp[]
}

/** 写入点交给发出记录的那一份（id / 时间 / 后续由发出记录自己补）。 */
export type OutboundRecordInput = Omit<
  OutboundRecord,
  'id' | 'workspace_id' | 'sent_at' | 'follow_ups' | 'status'
> & {
  sent_at?: Iso8601
  status?: OutboundStatus
}

/**
 * 记录去处能用的**标准字段**（列对照的右边只能是这些、一个固定值、或留空）。
 * `zh` 是给人看的名字（卡上、AI 读的说明都用它）。
 */
export const OUTBOUND_FIELDS = [
  { id: 'sent_at', zh: '发出时间' },
  { id: 'sent_date', zh: '发出日期' },
  { id: 'channel', zh: '渠道' },
  { id: 'action', zh: '动作' },
  { id: 'destination', zh: '发到哪' },
  { id: 'thread_title', zh: '原帖标题' },
  { id: 'thread_url', zh: '原帖链接' },
  { id: 'counterpart', zh: '对方' },
  { id: 'counterpart_text', zh: '对方原话' },
  { id: 'subject', zh: '主题' },
  { id: 'content', zh: '我们发的内容' },
  { id: 'link', zh: '我们发的链接' },
  { id: 'status', zh: '状态' },
  { id: 'approved_by', zh: '谁批的' },
  { id: 'approved_at', zh: '批的时间' },
  { id: 'tier', zh: 'AI 判的档位' },
  { id: 'faq', zh: '用到的 FAQ' },
  { id: 'follow_up_count', zh: '对方回了几条' },
  { id: 'record_id', zh: '记录编号' },
  // WP432（只加）：人改过时 AI 起草的那一版、读回的票数
  { id: 'draft_content', zh: 'AI 草稿（人改过才有）' },
  { id: 'score', zh: '票数' },
  // WP441（docs/108 §6）：消息规则「记到某处」那一组（主题用上面的 subject）
  { id: 'sender', zh: '发件人' },
  { id: 'received_at', zh: '收到时间' },
  { id: 'message_kind', zh: '类型' },
  { id: 'summary', zh: '摘要' },
  { id: 'rule_names', zh: '命中规则' },
  { id: 'message_link', zh: '原件链接' },
] as const

export type OutboundField = (typeof OUTBOUND_FIELDS)[number]['id']

export const isOutboundField = (v: unknown): v is OutboundField =>
  typeof v === 'string' && OUTBOUND_FIELDS.some((f) => f.id === v)

/** 一列的简单格式（都是确定性的变换，不经模型）。 */
export interface SinkFormat {
  /** 日期 / 时间的写法：`YYYY/MM/DD`、`YYYY-MM-DD HH:mm` …（只认 YYYY MM DD HH mm ss 这几个记号）。 */
  date?: string
  /** 最多多少字（多了截断加「…」）。 */
  max_chars?: number
  /** 值的替换表（`reply` → `回复`）；没命中的原样写。 */
  map?: Record<string, string>
}

/** 一列填什么：标准字段（可带格式）/ 固定值 / 留空。 */
export type SinkColumnSource =
  | { from: 'field'; field: OutboundField; format?: SinkFormat }
  | { from: 'const'; value: string }
  | { from: 'empty' }

/** 列对照里的一列。 */
export interface SinkColumn {
  /** 目标表里的列名（与表头一字不差）。 */
  column: string
  /** 目标表告诉我们的列类型（`text` / `number` / `select` / `multi_select` / `date` / `url` / `checkbox` / `other`）。 */
  type?: SinkColumnType
  /** 单选 / 多选列的可选项（多维表格会告诉我们）。 */
  options?: string[]
  source: SinkColumnSource
}

export type SinkColumnType =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'url'
  | 'checkbox'
  | 'other'

/** 只记哪些（空 = 全记）。 */
export interface SinkFilter {
  channels?: string[]
  actions?: string[]
  kinds?: string[]
}

/** 去处的状态：等确认 / 在记 / 停了 / 写不进去（等人处理）。 */
export type SinkState = 'pending_confirm' | 'active' | 'paused' | 'broken'

/** 写失败的种类：临时的自动退避重试；其余停下来照实说。 */
export type SinkErrorCode =
  | 'transient'
  | 'no_permission'
  | 'not_found'
  | 'columns_changed'
  | 'not_configured'
  | 'not_supported'
  | 'bad_value'

/** 一个记录去处（用户交代的，名字也是用户的）。 */
export interface RecordSink {
  id: string
  workspace_id: WorkspaceId
  /** 用户交代的去处名字（「IVRA 回复记录表」）；界面上只显示它。 */
  name: string
  /** 用户的原话（留底，改的时候 AI 再读）。 */
  instruction: string
  /** 适配器 id（`feishu_bitable` / `feishu_sheet` …）——只给机器看，界面不显示。 */
  adapter: string
  /** 表格链接（用户贴的那一条）。 */
  url: string
  /** 适配器从链接里认出来的定位（表 id、页签 id…）。 */
  ref: Record<string, string>
  columns: SinkColumn[]
  filter: SinkFilter
  state: SinkState
  created_at: Iso8601
  updated_at: Iso8601
  confirmed_at?: Iso8601
  /** 等确认的那张「定规矩」卡。 */
  card_id?: string
  /** 改规矩时：等确认的新对照（批了替换 `columns` / `filter`）。 */
  draft?: { columns: SinkColumn[]; filter: SinkFilter; name: string; card_id?: string }
  last_error?: { code: SinkErrorCode; message: string; at: Iso8601 }
  /** 谁交代的（之后表头变了重出「定规矩」卡时发给他）。 */
  created_by?: { person_id: string; assignment_id?: string; role_id?: string }
}

/** 去处列表里一行（带写入计数）。 */
export interface RecordSinkView extends RecordSink {
  written: number
  /** 待补写（含正在退避重试的）。 */
  pending: number
}

/** 一条发出记录写进某个去处的状态。 */
export interface SinkWrite {
  sink_id: string
  record_id: string
  status: 'pending' | 'written'
  attempts: number
  next_at?: Iso8601
  written_at?: Iso8601
  /** 对方表里那一行的引用（多维表格的 record_id / 电子表格写到的范围）。 */
  row_ref?: string
  last_error?: { code: SinkErrorCode; message: string }
}

/** 「定规矩」卡上 `payload.form` 的记号。 */
export const RECORD_SINK_FORM = 'record_sink'

/** 「定规矩」卡上 `subject.object.id` 的前缀。 */
export const RECORD_SINK_SUBJECT_PREFIX = 'record_sink:'

/** 查发出记录的条件。 */
export interface OutboundQuery {
  channel?: string
  status?: OutboundStatus
  /** 只要这之后的。 */
  since?: Iso8601
  until?: Iso8601
  limit?: number
}
