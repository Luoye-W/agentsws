/**
 * WP194：公司统一充值、给成员 / 岗位分配积分。
 *
 * 一句话：**分配 = 在公司共用余额上给每个人 / 每个岗位设「每月上限」**，不是把积分划成
 * 一个个小钱包（划拨会让积分卡在不用的人手里，退回又要一套流程）。默认**不设上限**
 * ——和 WP194 之前一样，谁都能用到公司余额见底为止。
 *
 * 执行在云上（`WalletDO` 预扣那一刻判）：「组织余额够 + 这个人没超 + 这个岗位没超」三样
 * 都过才扣。所以不管成员用哪台电脑、走 AI / 数据 / 任务哪一条，都算在同一本账上。
 *
 * **「谁」怎么带上去**：云上的工作区服务令牌是**工作区级**的（签给关联那个人，本版云上
 * 一个组织只有 owner 一个账号），分不出本机公司里的哪个成员。所以「谁」「哪个岗位」
 * 由持有令牌的本机服务在请求头里声明（{@link MEMBER_HEADER} / {@link POSITION_HEADER}），
 * 值是**本机**的 `person_id` 与岗位 id——云上只把它当成一串标签按组织记账，不认人名、
 * 不认邮箱。不带这两个头的调用（老客户端、别的产品还没接）只受组织余额限制，
 * 报表里记在「没标注」那一格。
 */
import type { MemberUsageReport, WalletBalance } from './cloud-entry.js'
import type { Iso8601 } from './common.js'

/** 请求头：这一次是谁在用（本机公司成员的 `person_id`）。 */
export const MEMBER_HEADER = 'X-Agentsws-Member'
/** 请求头：这一次是哪个岗位在用（本机岗位 id，如 `web-ops`）。 */
export const POSITION_HEADER = 'X-Agentsws-Position'
/** 两个头的值最长多少（再长的一律当没带——不截断，截断会把两个人记成一个）。 */
export const ATTRIBUTION_ID_MAX = 128

/** 两个归属头（契约里挂在会扣积分的路由上）。 */
export interface AttributionHeaders {
  'X-Agentsws-Member'?: string
  'X-Agentsws-Position'?: string
}

/** 一次调用算在谁头上（从请求头 / 内部调用的参数里来）。 */
export interface Attribution {
  member_id?: string
  position_id?: string
}

/**
 * 归属头的值合不合法：非空、不超长、只有字母数字与 `_ - . : @`。
 * 不合法的**当没带**（不猜、不截断），于是这一次只受组织余额限制。
 */
export function attributionIdOk(raw: string | undefined | null): raw is string {
  if (raw === undefined || raw === null) return false
  if (raw === '' || raw.length > ATTRIBUTION_ID_MAX) return false
  return /^[A-Za-z0-9_.:@-]+$/.test(raw)
}

/** 从请求头里取归属（大小写不敏感的取头函数）。 */
export function attributionFromHeaders(
  header: (name: string) => string | undefined | null,
): Attribution {
  const member = header(MEMBER_HEADER)?.trim()
  const position = header(POSITION_HEADER)?.trim()
  return {
    ...(attributionIdOk(member) ? { member_id: member } : {}),
    ...(attributionIdOk(position) ? { position_id: position } : {}),
  }
}

/** 归属 → 请求头（不合法 / 没有的那一项不带）。本机打云的每一处都用这一份。 */
export function attributionHeaders(a: Attribution | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (attributionIdOk(a?.member_id)) out[MEMBER_HEADER] = a.member_id
  if (attributionIdOk(a?.position_id)) out[POSITION_HEADER] = a.position_id
  return out
}

/** 上限挂在谁身上。 */
export type AllocationSubjectKind = 'member' | 'position'

/** 按能力分的四格（报表「本月按能力分的花费」）。 */
export type AllocationBucket = 'ai' | 'data' | 'task' | 'other'
export const ALLOCATION_BUCKETS: readonly AllocationBucket[] = ['ai', 'data', 'task', 'other']

/**
 * 能力名 → 四格之一。调用方能给就给（异步任务那条明说自己是 `task`），给不了按名字判：
 * `ai.*` 是 AI；`task.*` 是任务；月费（`*.service.monthly`、`standby.*`）归其它；余下都是数据。
 */
export function allocationBucketOf(capability: string): AllocationBucket {
  if (capability.startsWith('ai.')) return 'ai'
  if (capability.startsWith('task.')) return 'task'
  if (capability.startsWith('standby.') || /\.service\.monthly$/.test(capability)) return 'other'
  return 'data'
}

/** 用到上限的几成时提醒（各一次，本人与管理员都看得到）。 */
export type AllocationNoticeLevel = 80 | 100
export const ALLOCATION_NOTICE_LEVELS: readonly AllocationNoticeLevel[] = [80, 100]

/** 自然月按哪个时区切（公司没设就用它：前期客户主要在中国）。 */
export const DEFAULT_ALLOCATION_TIMEZONE = 'Asia/Shanghai'

/** 402 时 `details.reason`：公司没钱了 / 你的额度到了 / 这个岗位的额度到了。 */
export type InsufficientCreditsReason =
  | 'org_balance'
  | 'member_limit'
  | 'position_limit'
  /** WP206：这个人已经不在公司了（名册里没有他了 / 被移出），新的预扣一律拒。 */
  | 'member_left'
  /** WP206：这个岗位已经删了，新的预扣一律拒。 */
  | 'position_removed'

/** 「你的额度到了」那一句（云上 402 的 `message` 就是它；本机出错处原样显示）。 */
export const ALLOCATION_EXHAUSTED_MESSAGE = '本月额度用完了，找管理员加。'
/** 「这个岗位的额度到了」那一句。 */
export const POSITION_ALLOCATION_EXHAUSTED_MESSAGE = '这个岗位本月的额度用完了，找管理员加。'
/** WP206：这个人已经不在公司了（离职 / 被移出之后，名册同步上去就这么判）。 */
export const MEMBER_LEFT_MESSAGE = '这个人已经不在公司了。'
/** WP206：这个岗位已经删了。 */
export const POSITION_REMOVED_MESSAGE = '这个岗位已经不在公司了。'
/** 成员视角的「公司没钱了」那一句（云上原句说的是「去充值」，那是给管理员的）。 */
export const ORG_BALANCE_EXHAUSTED_MESSAGE = '公司的积分用完了，找管理员充值。'

/** 一个人 / 一个岗位本月的用量与上限。 */
export interface AllocationRow {
  kind: AllocationSubjectKind
  subject_id: string
  /** 本月已结算的积分。 */
  used: number
  /** 正在预扣中的（还没结算）。判上限时算在里面。 */
  reserved: number
  calls: number
  /** 每月上限；没有这一格 = 不设上限。 */
  monthly_limit?: number
  /** `used / monthly_limit` 的百分数（取整）；没上限就没有。 */
  percent?: number
  /** 上限最近一次改的时间。 */
  updated_at?: Iso8601
}

/** 本月按能力分的一格。 */
export interface AllocationBucketRow {
  bucket: AllocationBucket
  credits: number
  calls: number
}

/** 成员 × 岗位 × 能力的一格（本月）。没带归属的那一格没有 `member_id` / `position_id`。 */
export interface AllocationCell {
  member_id?: string
  position_id?: string
  bucket: AllocationBucket
  credits: number
  calls: number
}

/** 发过的一次提醒（80% / 100%，每人每月每档一次）。 */
export interface AllocationNotice {
  kind: AllocationSubjectKind
  subject_id: string
  level: AllocationNoticeLevel
  month: string
  at: Iso8601
}

/** `GET /v1/wallet/allocation`：管理员看的本月额度与用量（按人 / 按岗位 / 按能力）。 */
export interface AllocationReport {
  /** `YYYY-MM`（按 {@link timezone} 的自然月）。 */
  month: string
  timezone: string
  from: Iso8601
  to: Iso8601
  members: AllocationRow[]
  positions: AllocationRow[]
  buckets: AllocationBucketRow[]
  cells: AllocationCell[]
  total_credits: number
  /** 没带「谁」的那部分（老客户端、别的产品还没接归属头）。 */
  unattributed_credits: number
  notices: AllocationNotice[]
}

/** `GET /v1/wallet/allocation` 的查询参数。 */
export interface AllocationReportQuery {
  /** `YYYY-MM`；缺省本月。 */
  month?: string
}

/** `POST /v1/wallet/allocation/limits`：设 / 清一个上限。`null` = 不设上限。 */
export interface AllocationLimitRequest {
  kind: AllocationSubjectKind
  subject_id: string
  monthly_limit: number | null
  /**
   * 给人看的名字（「王岚」「客服」）。**只用在用到 100% 时那封提醒信里**——云上别处只认 id。
   * 不给就在信里写「一位成员 / 一个岗位」。最长 60 字。
   */
  label?: string
}

/** 改额度的一条审计（谁、从多少改到多少）。`from` / `to` 没有 = 不设上限。 */
export interface AllocationAuditEntry {
  id: string
  at: Iso8601
  /** 谁改的：本机声明的那个成员（`X-Agentsws-Member`）；没声明就是 `account:<云账号>`。 */
  actor: string
  /**
   * `set` / `clear`：改上限；`member_removed`：删人清额度（WP194）。
   * WP206 加：`reclaim`（管理员在网页上点「收回」= 上限设成 0）；`auto_reclaim`（名册同步时这个人 /
   * 岗位没了，云上自动停用）；`returned`（又出现在名册里，停用解除）。
   */
  action: 'set' | 'clear' | 'member_removed' | 'reclaim' | 'auto_reclaim' | 'returned'
  kind: AllocationSubjectKind
  subject_id: string
  from?: number
  to?: number
}

/** `POST /v1/wallet/allocation/limits` 的结果。 */
export interface AllocationLimitChanged {
  row: AllocationRow
  audit: AllocationAuditEntry
}

/** `GET /v1/wallet/allocation/audit`：最近的改额度记录（新的在前）。 */
export interface AllocationAuditList {
  entries: AllocationAuditEntry[]
}

/** `POST /v1/wallet/allocation/settings`：公司时区与提醒信发给谁（两样都可以只给一样）。 */
export interface AllocationSettings {
  /** IANA 时区名（`Asia/Shanghai`、`Etc/GMT-8`）。 */
  timezone?: string
  /**
   * 用到 100% 时那封提醒信发给谁：公司的 owner 与 admin（本机按公司成员表给）。云上另外总会加上
   * 这个组织 owner 的云账号邮箱。每人每月每个对象只发一次。整张表一次给全（给空数组 = 清空）；最多 20 个。
   */
  notify_emails?: string[]
}

/** 设完之后的样子（不回邮箱本身，只回有几个收件人）。 */
export interface AllocationSettingsView {
  timezone: string
  notify_recipients: number
}

/** 不带时区时（或认不出）按它切自然月。 */
export const ALLOCATION_FALLBACK_TIMEZONE_NOTE = '按北京时间切月'

/**
 * 本机的公司时区 → 推给云的 IANA 名。`Asia/Shanghai` 这种原样；`+08:00` / `UTC+8` / `-05:00` 这种偏移
 * 换成 `Etc/GMT∓h`（整点）或常见的半点时区；认不出回 `undefined`（云上按上海切）。
 */
export function allocationTimezoneOf(raw: string | undefined): string | undefined {
  const tz = raw?.trim() ?? ''
  if (tz === '') return undefined
  if (tz === 'UTC' || tz === 'GMT' || tz.includes('/')) return tz
  const m = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(tz)
  if (m === null) return undefined
  const sign = m[1] === '-' ? -1 : 1
  const hours = Number(m[2])
  const minutes = m[3] === undefined ? 0 : Number(m[3])
  if (hours > 14 || minutes >= 60) return undefined
  if (minutes === 0) {
    if (hours === 0) return 'UTC'
    // IANA 的 Etc/GMT 符号是反的：东八区是 Etc/GMT-8
    return `Etc/GMT${sign > 0 ? '-' : '+'}${String(hours)}`
  }
  const HALF: Record<string, string> = {
    '+3:30': 'Asia/Tehran',
    '+4:30': 'Asia/Kabul',
    '+5:30': 'Asia/Kolkata',
    '+5:45': 'Asia/Kathmandu',
    '+6:30': 'Asia/Yangon',
    '+9:30': 'Australia/Darwin',
    '+10:30': 'Australia/Lord_Howe',
    '-3:30': 'America/St_Johns',
    '-9:30': 'Pacific/Marquesas',
  }
  return HALF[`${sign > 0 ? '+' : '-'}${String(hours)}:${String(minutes).padStart(2, '0')}`]
}

/** `POST /v1/wallet/allocation/members/remove`：删成员时清掉他的额度行（历史用量保留）。 */
export interface AllocationMemberRemoveRequest {
  member_id: string
}

export interface AllocationMemberRemoved {
  member_id: string
  /** 清掉了几行上限（0 = 他本来就没设）。 */
  cleared: number
}

/* ------------------------------------------------------------------ */
/* WP206：名册（网页版账号页「成员额度」要列人）                           */
/* ------------------------------------------------------------------ */

/**
 * 名册里的一个成员：本机 `person_id` + 显示名 + 他手上的岗位 id。**只有这些名字，不带任何业务内容。**
 * 网页端要能给还没设过上限的人设上限，所以得知道公司里有谁。
 */
export interface AllocationRosterMember {
  id: string
  name: string
  /** 他持有的岗位 id（与打云时 `X-Agentsws-Position` 带的是同一套）。 */
  positions?: string[]
}

/** 名册里的一个岗位：岗位 id + 名字。 */
export interface AllocationRosterPosition {
  id: string
  name: string
}

/**
 * `POST /v1/wallet/allocation/roster`：本机服务把**这个工作区**的名册整张推上来（启动时一次、名册变了一次、
 * 之后每天一次）。云上按「组织 × 工作区」存，网页页取同一组织下各工作区的并集。
 *
 * 推上来以后，之前在名册里、这次不在了的成员 / 岗位（并集里也没了）→ 云上**自动收回**：标成停用，
 * 新的预扣一律拒（402，`member_left` / `position_removed`）；正在预扣中的照常结算。又出现了就解除。
 * 成员至少一个（一家公司至少有所有者；空名册多半是本机读坏了，一律拒，免得把全公司都停了）。
 */
export interface AllocationRosterRequest {
  members: AllocationRosterMember[]
  positions: AllocationRosterPosition[]
}

/** 名册最多多少人 / 多少岗位、名字最长多少字（再长的截断）。 */
export const ALLOCATION_ROSTER_MAX_MEMBERS = 2000
export const ALLOCATION_ROSTER_MAX_POSITIONS = 500
export const ALLOCATION_ROSTER_NAME_MAX = 60

/** 名册同步时变了状态的一个成员 / 岗位。 */
export interface AllocationRosterChange {
  kind: AllocationSubjectKind
  subject_id: string
}

/** `POST /v1/wallet/allocation/roster` 的结果。 */
export interface AllocationRosterSynced {
  members: number
  positions: number
  /** 这一次自动收回（停用）了谁。 */
  reclaimed: AllocationRosterChange[]
  /** 这一次解除停用的（之前没了、这次又回到名册里）。 */
  returned: AllocationRosterChange[]
  synced_at: Iso8601
  /**
   * 这一次被保护拦下了：一下子没了的成员超过现有人数的一半、且至少 {@link ALLOCATION_ROSTER_GUARD_MIN} 人
   * （多半是本机名册读坏了）。这时**谁都不自动收回**，没了的那几个照旧留在名册里，只记一条日志、给公司的
   * owner / admin 发一封提醒信（同一件事一天一封）。真是一批人走了，在网页上逐个收回。
   */
  guarded?: { missing: number; of: number }
}

/** 名册保护：一次同步里至少没了这么多人、且超过一半，才算「可疑」。 */
export const ALLOCATION_ROSTER_GUARD_MIN = 3

/** 这一次同步是不是该被保护拦下（没了的成员数 vs 同步前的成员数）。 */
export function allocationRosterGuarded(missing: number, before: number): boolean {
  return missing >= ALLOCATION_ROSTER_GUARD_MIN && missing * 2 > before
}

/** 网页版账号页上「成员额度」那一页的路径（工作台「设置 → 积分」链过去）。 */
export const ALLOCATION_WEB_PATH = '/account/allocation'

/** `GET /v1/wallet/allocation/me`：成员自己的「本月额度：已用 X / 上限 Y」。 */
export interface MyAllocation {
  month: string
  timezone: string
  /** 这一次声明的是谁；没声明就没有这一格（也就没有个人上限）。 */
  member_id?: string
  used: number
  reserved: number
  monthly_limit?: number
  percent?: number
  /** 这一次声明的岗位（有才给）。 */
  position?: AllocationRow
  /** 本月到过的最高提醒档。 */
  notice?: AllocationNoticeLevel
}

/* ------------------------------------------------------------------ */
/* 本机那一面（`/v1/cloud/allocation*`，本机服务进程透传云上那一份）       */
/* ------------------------------------------------------------------ */

/**
 * 本机 `GET /v1/cloud/allocation`：公司「积分」那一页。**本地不算账**——报表是云上那一份的透传。
 * 没关联账号 / 云连不上都不是错：`linked` + 一句人话，界面据此画「先关联」而不是一堆 0。
 */
export interface CloudAllocationView {
  linked: boolean
  reason?: string
  report?: AllocationReport
  /** 公司余额（与设置 → 积分同一份透传；公司的 admin 不一定看得到设置那一页，所以在这里一并给）。 */
  balance?: WalletBalance
  /** 本机的名字：成员 `person_id` → 名字、岗位 id → 名字（云上只有 id）。 */
  names?: { members: Record<string, string>; positions: Record<string, string> }
  /** 看这一页的人在公司里是什么身份（admin 只开这一页，公司页其它 tab 照旧只给所有者）。 */
  role?: 'owner' | 'admin'
}

/** 本机 `GET /v1/cloud/allocation/me`：设置 → 积分里的「我的本月额度」。 */
export interface CloudMyAllocationView {
  linked: boolean
  reason?: string
  mine?: MyAllocation
  /**
   * WP206：看这一块的人在公司里是 owner / admin 时才有——设置 → 积分据此画「给同事分额度 → 在网页上」。
   * 额度分配只在网页版账号页做（Luoye 09-30 定：不属于公司的日常工作，不放工作台）。
   */
  role?: 'owner' | 'admin'
  /** WP206：网页「成员额度」页的地址（`${云地址}/account/allocation`）；只 owner / admin 给。 */
  allocation_url?: string
}

/**
 * WP282（决策 281 / 286–290）：本机 `GET /v1/cloud/usage/members`——按人看积分（云上 `group=member` 的透传，
 * 本机补名字与 0 行）。
 *
 * 看得到谁**判在本机**（云上一把工作区令牌分不出本机里谁是谁）：
 * - ② 同事互联：谁都看全员（共用一个余额，用量按人看得见）；
 * - ③ 公司集体：owner / admin 看全员，别人只看自己（本机强制带 `member=<他自己>`）；
 * - ① 个人：只有自己。
 */
export interface CloudMemberUsageView {
  linked: boolean
  /** 没关联 / 取不到时的一句人话。 */
  reason?: string
  /** `all` = 看全员；`self` = 只看自己（那时 `rows` 里只有本人一行，没有「没标注」）。 */
  scope: 'all' | 'self'
  /**
   * 云上那一份，本机加工过：名字按本机名册补上；`all` 时名册里没用量的人补 0 行（排在后面），
   * `self` 时本人没用量也补一行 0。
   */
  report?: MemberUsageReport
}
