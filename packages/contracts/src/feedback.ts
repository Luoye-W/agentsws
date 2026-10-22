/**
 * WP475（决策 1591、1592）：左下角「反馈」——测试阶段用户最快反映问题的地方。
 *
 * 这一份是开源侧与私有云之间关于反馈的约定（云端对外契约 `CloudFeedbackApi` 引用这里的类型）：
 *
 * - 本机服务把一条反馈发到云：`POST /v1/feedback`（{@link FeedbackSubmitRequest} → {@link FeedbackSubmitted}）。
 *   **不要求登录**：没登录云账号的本机用户也能发（匿名 + 设备号）。
 * - 「我的反馈」看进度：`POST /v1/feedback/status`，拿提交时云给的 `ticket` 换回状态与回复
 *   （{@link FeedbackStatusRequest} → {@link FeedbackStatusList}）。`ticket` 只在提交的那台电脑上，
 *   放在请求体里（不进网址）；云只存它的哈希。
 *
 * 诊断信息（{@link FeedbackDiagnostics}）是白名单：版本、系统、语言、当前页面路径、最近的错误日志
 * （本机已经脱敏过）。**没有业务内容、没有密钥、没有邮件正文**——本机出门前洗一遍，云收到再洗一遍。
 */
import type { Iso8601 } from './common.js'

/** 反馈类型：问题 / 建议 / 其他（默认问题）。 */
export type FeedbackKind = 'bug' | 'idea' | 'other'

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'other']

/** 处理状态：新 / 处理中 / 已修 / 不修。 */
export type FeedbackStatus = 'new' | 'in_progress' | 'fixed' | 'wont_fix'

export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = [
  'new',
  'in_progress',
  'fixed',
  'wont_fix',
]

/** 一句话最长多少字。 */
export const FEEDBACK_MESSAGE_MAX = 2000
/** 联系方式最长多少字。 */
export const FEEDBACK_CONTACT_MAX = 200
/** 诊断里最多带几条错误日志。 */
export const FEEDBACK_ERRORS_MAX = 50
/** 每条错误日志最长多少字。 */
export const FEEDBACK_ERROR_LINE_MAX = 500
/** 截图最大多少字节（解码后）。 */
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024
/** 截图认的格式。 */
export const FEEDBACK_SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type FeedbackScreenshotType = (typeof FEEDBACK_SCREENSHOT_TYPES)[number]
/** 一次查进度最多带几个 ticket。 */
export const FEEDBACK_STATUS_MAX_TICKETS = 100
/** 一条回复最长多少字。 */
export const FEEDBACK_REPLY_MAX = 4000

/** 附上的诊断信息（白名单，一项一项列；不在这里的一律不发）。 */
export interface FeedbackDiagnostics {
  /** 工坊版本（桌面壳版本；浏览器里是服务版本）。 */
  app_version: string
  /** 系统：平台 + 架构 + 系统版本（如 `darwin arm64 25.6.0`）。 */
  os: string
  /** 界面语言（如 `zh-CN`）。 */
  locale: string
  /** 当时在哪一页（只有路径，没有查询串）。 */
  route: string
  /** 桌面版还是浏览器里打开的。 */
  shell?: 'desktop' | 'browser'
  /** 最近的错误日志（至多 {@link FEEDBACK_ERRORS_MAX} 条，每条已脱敏、截长）。 */
  errors: string[]
}

/** 附上的截图（JSON 里带 base64，解码后至多 {@link FEEDBACK_SCREENSHOT_MAX_BYTES}）。 */
export interface FeedbackScreenshot {
  content_type: FeedbackScreenshotType
  data_base64: string
}

/** 本机服务 → 云：一条反馈。 */
export interface FeedbackSubmitRequest {
  /** 本机生成的一次性 id：离线补发时同一条只收一次（同设备同 id 回同一个结果）。 */
  client_id: string
  /** 本机设备号（随机生成，存在本机；匿名用户靠它区分是哪台电脑）。 */
  device_id: string
  kind: FeedbackKind
  /** 一句话（必填）。 */
  message: string
  /** 联系方式（默认当前登录账号邮箱，用户可改、可空）。 */
  contact?: string
  /** 用户勾了「附上诊断信息」才有。 */
  diagnostics?: FeedbackDiagnostics
  /** 用户附了截图才有。 */
  screenshot?: FeedbackScreenshot
  /** 本机写下这条的时间（离线补发时早于云收到的时间）。 */
  written_at?: Iso8601
}

/** 云 → 本机：收到了。 */
export interface FeedbackSubmitted {
  /** 反馈编号（`fb_…`，后台与用户都看得到）。 */
  id: string
  /** 查进度用的凭据（`fbt_…`）：只回给提交的那台电脑，云只存哈希。 */
  ticket: string
  status: FeedbackStatus
  created_at: Iso8601
}

/** 运营给的一条回复。 */
export interface FeedbackReply {
  at: Iso8601
  text: string
}

/** 「我的反馈」里的一条（按 ticket 查回来的）。 */
export interface FeedbackTicketView {
  id: string
  kind: FeedbackKind
  status: FeedbackStatus
  /** 用户当时写的那一句（原样带回，本机丢了也能显示）。 */
  message: string
  created_at: Iso8601
  updated_at: Iso8601
  /** 运营的回复（按时间先后）。 */
  replies: FeedbackReply[]
}

/** 本机 → 云：查这几条的进度。 */
export interface FeedbackStatusRequest {
  /** 至多 {@link FEEDBACK_STATUS_MAX_TICKETS} 个；查不到的不回（不说是哪一个错了）。 */
  tickets: string[]
}

export interface FeedbackStatusList {
  items: FeedbackTicketView[]
}
