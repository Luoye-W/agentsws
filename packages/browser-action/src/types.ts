/**
 * WP313（docs/101 §5.4，决策 550 / 555 / 557 / 558）：浏览器动作的**线上形状**。
 *
 * 规矩照搬 Reddit 官方号浏览器通道（WP249，`social-core/channels/reddit-browser.ts`）：
 * 每个动作是一张**写死的步骤表**，不让模型自己找按钮；执行器只放行这个动作白名单里的点击 / 填写；
 * 做完读回页面确认；被拦 / 页面对不上就停、交给人。区别只在执行的地方：
 * Reddit 是本机服务另开的浏览器，广告是**用户日常用的 Chrome 里的插件**（决策 550）。
 *
 * 这一份类型插件与本机服务共用，所以这里一个 `node:` 都不许出现。
 */

/** 两家广告后台（WP313）。 */
export type AdsPlatform = 'google_ads' | 'meta_ads'

/**
 * 哪家后台。WP329 加了 `reddit`：Reddit 的回复 / 评论 / 发帖也走这条插件动作通道
 * （docs/102 §2.3：插件把草稿填进用户已登录的 Reddit 页面，**人自己点发送**）。
 */
export type ActionPlatform = AdsPlatform | 'reddit'

/** 这个动作算读还是写（限速分开算：决策 555）。 */
export type ActionPace = 'read' | 'write'

/**
 * 一步。`goto` / `click` / `fill` 与 Reddit 通道的 `BrowserStep` 同形（它是这里的子集）。
 *
 * 选择器是 CSS，可以在末尾带一段 `>> text=…`（元素的文字要**完全等于**它，去首尾空白），
 * 因为后台的按钮多半只有文字靠得住。解析在 {@link resolveSelector}（`selector.ts`）。
 */
export type ActionStep =
  | {
      op: 'goto'
      url: string
      /**
       * WP467：这一页是哪个 Reddit 帖子（不带 `t3_`）。当前标签页**已经在这个帖子上**（用户自己开着的原帖页）
       * 就不再跳转、就地填（`need` 给了还要它在页面上：回某条评论时那一条要在）。不在就照常打开 `url`。
       */
      post?: string
      need?: string
    }
  /**
   * WP432：`soft` = 对不上不停（Reddit 新版页面的选择器没对真站核过）：执行器记一笔「没填上」、跳过后面的
   * 软步骤，直接去等人自己粘贴、点发送（侧边栏里有「复制草稿」）。**软步骤照样过白名单**。
   */
  | {
      op: 'click'
      selector: string
      soft?: boolean
      /** WP467：页面上已经有这个了就不点（框已经展开着：用户先点过 Reply / 评论框）。 */
      unless?: string
    }
  /** WP432：`highlight` = 填完把那个框描一圈、滚到眼前（人一眼看到填在哪）。 */
  | { op: 'fill'; selector: string; value: string; soft?: boolean; highlight?: boolean }
  /** 等某个元素出现（平台生成预览要时间）。等不到 = 页面对不上，停（`soft` 的不停）。 */
  | {
      op: 'wait'
      selector: string
      timeout_ms?: number
      soft?: boolean
      /**
       * WP467：等之前先把这一个滚到眼前（新版 Reddit 的评论按钮要滚到看得见才长出来）。只滚，不点。
       */
      reveal?: string
      /** WP467：等不到也往下走（下一步自己会再看；不算「对不上页面」）。 */
      optional?: boolean
    }
  /** 把审批绑定的那张上传表放进文件框（浏览器标准的 DataTransfer 做法）。 */
  | { op: 'upload'; selector: string }
  /** 把审批绑定的那张上传表的**文字**粘进文本框（Meta 导入框本来就支持粘贴）。 */
  | { op: 'paste'; selector: string }
  /**
   * 截一张当前标签页（只截广告后台那个标签页；决策 556）。
   *
   * WP316（决策 600 C）：`optional` = 截不到也往下做（止损这类人不在也要先停住的），
   * 结果里记 `reads.evidence_missing`（逗号隔开的几格），账本用前后导出作证；
   * 这种截图也不等人去点插件图标授权（不让钱多烧十分钟）。
   */
  | { op: 'capture'; tag: EvidenceTag; optional?: boolean }
  /** 点一下导出按钮，等浏览器把文件下完，记下文件存在哪（桌面端去读）。 */
  | { op: 'download'; selector: string; tag: DownloadTag }
  /** 读一段字记进结果（平台报了几个错误 / 警告之类）。读不到不算错。 */
  | { op: 'read'; selector: string; key: string }
  /** 页面上这类元素必须一个都没有（平台报了阻断错误就不给提交，退回去改）。 */
  | { op: 'expect_none'; selector: string; why: string }
  /** 停下来等人再确认一次（横条上的「确认提交」，或工坊卡上的同一个按钮）。 */
  | { op: 'confirm'; prompt: string }
  /**
   * WP329：**等人自己点发送，再读回**。插件从不点发送（Reddit 写一律人点：决策 663、docs/102 §2.2）：
   * 草稿填好后停在这一步，盯着页面上出没出现一条**新的**、正文含 `text` 的 `selector`
   * （`body` 是它里面放正文的那一块，相对它自己写，可以用 `:scope`）。出现了就把它的
   * `data-fullname` / `data-permalink` 记进结果（`reads.fullname` / `reads.permalink`）。
   * 等不到（人没点 / 被版规或频率拦了）就停下照实报，**不重试、不代点**。
   */
  | {
      op: 'await_sent'
      selector: string
      body: string
      text: string
      prompt: string
      timeout_ms?: number
      /**
       * WP432：品牌号用户名（不带 `u/`）。人在页面上把草稿改了再发、正文对不上那一截时，
       * 新出现的、这个号发的那一条也算（读回它真发出去的字，记进发出记录、改了多少进学习回路）。
       */
      author?: string
    }

export type ActionStepOp = ActionStep['op']

/** 截图挂在哪一格（前 / 平台预览 / 后）。 */
export type EvidenceTag = 'before' | 'preview' | 'after'

/** 下载下来的是什么（改前快照 / 报表 / 平台给的结果文件）。 */
export type DownloadTag = 'snapshot' | 'report' | 'result'

/** 做完之后怎么确认真做成了（读回页面）。 */
export type ActionVerify =
  | { op: 'none' }
  | { op: 'present'; url?: string; selector: string; text?: string }
  | { op: 'absent'; url?: string; selector: string }

/** 一个动作的白名单（**按动作种类算**，与步骤表分开写，对不上测试会喊）。 */
export interface ActionAllowlist {
  /** 能打开的站（`*.` 前缀认子域）。 */
  hosts: readonly string[]
  click: readonly string[]
  fill: readonly string[]
  /** 能填的字只能是审批卡上的那几段。 */
  values: readonly string[]
  wait?: readonly string[]
  upload?: readonly string[]
  paste?: readonly string[]
  download?: readonly string[]
}

/** 「默认不碰」的区域（决策 557）。见 `zones.ts`。 */
export type GuardedZoneId =
  | 'payment'
  | 'billing'
  | 'balance'
  | 'users'
  | 'business_settings'
  | 'verification'
  | 'appeal'
  | 'new_account'
  | 'pixel_conversion'
  | 'delete_campaign'

/** 一个动作的完整计划：步骤 + 白名单 + 读回。 */
export interface ActionPlan {
  /** 动作种类（`upload_sheet` / `pause` …），白名单按它算。 */
  kind: string
  platform: ActionPlatform
  pace: ActionPace
  steps: ActionStep[]
  allow: ActionAllowlist
  verify: ActionVerify
  /** 这个动作**本身**要进的「默认不碰」区域（绝大多数动作是空的）。 */
  zones: GuardedZoneId[]
  /** 要不要上传表（upload / paste 步骤用它）。 */
  needs_sheet: boolean
}

/** 广告账户（同一账户一次一件、每天写 ≤ 20、读 ≤ 2 都按它算）。 */
export interface ActionAccount {
  platform: ActionPlatform
  /** Google：客户 id（`123-456-7890`）；Meta：广告账户 id（`act_…` 后面那串数字）。 */
  id: string
  /**
   * Google 后台网址里的 `ocid`（内部编号，不是客户 id）。连接时从用户自己打开的那一页网址里读，
   * 没有就用客户 id 拼不出网址——这一格对不上真站的风险列进了报告。
   */
  ocid?: string
}

/** 审批绑定的那张上传表（决策 552：改 3 条以上一律走表）。 */
export interface SheetRef {
  name: string
  mime: string
  /** `sha256:<hex>`，审批时算好绑在卡上；执行前插件再算一次，对不上就拒。 */
  fingerprint: string
  bytes: number
}

/** 排队里的一件活（本机服务发给插件的就是这个）。 */
export interface ActionJob {
  id: string
  workspace_id: string
  account: ActionAccount
  plan: ActionPlan
  /** 审批编号。写操作没有它不进队。 */
  approval_id?: string
  /** 审批级别（放开的「默认不碰」区域一律 L1：决策 557）。 */
  approval_level?: 'L1' | 'L2' | 'L3'
  sheet?: SheetRef
  /** 这件活**被允许**进的「默认不碰」区域（= 计划要进的 ∩ 用户在设置里放开的，且审批是 L1）。 */
  zones_allowed: GuardedZoneId[]
  /** 卡上的一句话（横条上显示）。 */
  title: string
  created_at: string
}

export type ActionJobStatus =
  | 'queued'
  | 'running'
  | 'waiting_confirm'
  | 'done'
  | 'failed'
  | 'handover'
  | 'stopped'
  | 'rejected'
  | 'expired'

/** 跑完的结局（与 Reddit 的 ok / failed / handover 同一个意思，多三种）。 */
export type ActionOutcome =
  /** 做完了，读回也对上了。 */
  | 'done'
  /** 没做成（白名单拦了、指纹对不上、读回对不上……）。不重试。 */
  | 'failed'
  /** 被拦了 / 登录掉了 / 进了不碰的区域 / 页面对不上：停下，交给人。 */
  | 'handover'
  /** 用户点了停止。 */
  | 'stopped'
  /** 平台报了阻断错误，或人在再确认时没同意：退回 AI 改。 */
  | 'rejected'

export interface ActionResult {
  outcome: ActionOutcome
  message: string
  /** 停在第几步（从 1 数；没开始就是 0）。 */
  step: number
  /** `read` 步骤读到的字。 */
  reads: Record<string, string>
}
