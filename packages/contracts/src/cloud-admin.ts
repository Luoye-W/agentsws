/**
 * 65 · 云端运营后台（WP115）的契约。
 *
 * 为什么单开一个文件而不是往 `cloud.ts` / `cloud-entry.ts` 里塞：那两份是**用户侧**的
 * 契约（账号、令牌、钱包、计量），这一份是**我们自己看后台**用的。两边的读者不同、
 * 变更节奏不同；更实际的理由是 `cloud.ts` 与 `cloud-entry.ts` 正被别的 WP 改着，
 * 新东西写进新文件，合并时不用逐行看冲突。
 *
 * 四条贯穿全篇的纪律：
 *
 * 1. **后台看不见商家的业务正文**（21 §3）。云上本来就没有正文——这里的每一个对象
 *    都只有账号、组织、令牌前缀、钱、计量。所以后台也**不做模拟登录**："以他的身份
 *    看一眼"在 agentsws 上没有东西可看，那个按钮只会制造一种我们能看的错觉。
 * 2. **审计只增不改**（{@link AuditEntry}）。危险动作**先写审计再执行**——执行到一半
 *    崩了，至少留着"谁打算做什么"。
 * 3. **`support` 只读**。角色是一列，不是一张表；`user` 是默认值，旧行没有这一列时
 *    当 `user`。
 * 4. **删除不抹账**：人可以删，钱与计量流水**保留并匿名化**（`org_id` 换成墓碑 id），
 *    否则历史收入会随着删号一起缩水，而那一块钱是真收过的。
 */

import type { CloudAccountId, CloudOrgId } from './cloud.js'
import type { Iso8601 } from './common.js'

/* ------------------------------------------------------------------ */
/* 角色与会话                                                           */
/* ------------------------------------------------------------------ */

/**
 * 账号的角色。**只加一列**，不新开一张表。
 *
 * - `user`：普通用户（默认；旧行这一列为空时当它）。
 * - `support`：**只读**后台——看得到用户、组织、用量、审计，一个写接口都调不动。
 * - `admin`：能写（封禁 / 发积分 / 开会员 / 删除）。
 */
export type CloudRole = 'user' | 'support' | 'admin'

export const CLOUD_ROLES: readonly CloudRole[] = ['user', 'support', 'admin']

/** 能进后台的那两档。`user` 进去与没登录一样：404。 */
export const CLOUD_STAFF_ROLES: readonly CloudRole[] = ['support', 'admin']

export const isStaffRole = (role: CloudRole | undefined): boolean =>
  role === 'support' || role === 'admin'

/**
 * 后台的网页会话（与 `cloud_sessions` 那张**分开**）。
 *
 * 分开的理由：那一张是给本地关联向导用的 Bearer token，会被本机服务进程存进加密库；
 * 这一张是 httpOnly cookie，12 小时滑动过期，浏览器里没有 JS 读得到。混在一张表里
 * 意味着"吊销某人的后台会话"会顺手把他电脑上的关联也断掉。
 */
export interface AdminSession {
  id: string
  account_id: CloudAccountId
  role: CloudRole
  created_at: Iso8601
  /** 滑动过期：每次用到都往后推，上限 {@link ADMIN_SESSION_ABSOLUTE_TTL_MS}。 */
  expires_at: Iso8601
  /** 绝对上限；到了这个点再活跃也得重新登录。 */
  absolute_expires_at: Iso8601
  last_seen_at: Iso8601
  revoked_at?: Iso8601
}

/** 后台会话 cookie 的名字。`__Host-` 前缀：只有同源、全站路径、必须 Secure。 */
export const ADMIN_SESSION_COOKIE = '__Host-agentsws_admin'
/** CSRF 双提交的那一枚（**不是** httpOnly——前端要读出来放进请求头）。 */
export const ADMIN_CSRF_COOKIE = 'agentsws_admin_csrf'
export const ADMIN_CSRF_HEADER = 'X-Agentsws-Csrf'

/** 滑动窗口：12 小时不动就过期。 */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000
/** 绝对上限：7 天。一直开着的标签页也得重新登录一次。 */
export const ADMIN_SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/* ------------------------------------------------------------------ */
/* 封禁与黑名单                                                         */
/* ------------------------------------------------------------------ */

/** 一次封禁。理由**必填**——三个月后回头看"为什么这个人被封了"必须有答案。 */
export interface AccountBan {
  account_id: CloudAccountId
  reason: string
  banned_by: CloudAccountId
  banned_at: Iso8601
  /** 不给 = 永久。给了就是到点自动解封（到期判定在读的时候做，不靠定时任务）。 */
  expires_at?: Iso8601
  lifted_at?: Iso8601
  lifted_by?: CloudAccountId
}

/**
 * 删号之后留下的那一行：这个邮箱**以及它的规范化别名**都不许再注册。
 *
 * 只记 `email_sha256` 与 `alias_sha256`，不记明文：黑名单是一张"我们讨厌过谁"的
 * 清单，它没有理由以明文形式躺在库里（21 §1）。比对时把来人的邮箱同样规范化再哈希。
 */
export interface BannedEmail {
  email_sha256: string
  /** {@link normalizeEmailAlias} 之后再哈希。`a.b+x@gmail.com` 与 `ab@gmail.com` 同一格。 */
  alias_sha256: string
  reason: string
  banned_by: CloudAccountId
  banned_at: Iso8601
}

/**
 * 邮箱的**规范化别名**：`A.B+tag@Gmail.com` → `ab@gmail.com`。
 *
 * 为什么要有它：删号封邮箱的时候只封字面量，那个人五秒钟就能拿 `me+2@gmail.com`
 * 回来。三条规则，只对**确实这么实现**的域名生效——对别的域名点号是有意义的，
 * 乱删会把两个不同的人算成一个：
 *
 * - `+tag` 一律去掉（几乎所有邮件服务都这么认）；
 * - 点号只对 gmail / googlemail 去掉；
 * - 大小写一律小写（本地部分理论上区分大小写，但没有一家真这么做）。
 */
export function normalizeEmailAlias(email: string): string {
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return trimmed
  let local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replaceAll('.', '')
  return `${local}@${domain}`
}

/* ------------------------------------------------------------------ */
/* 审计                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 审计里记的动作名。加动作就加成员（只加不删）——旧行里的字符串永远读得懂。
 */
export type AuditAction =
  | 'admin.login'
  | 'admin.logout'
  | 'admin.bootstrap'
  | 'account.ban'
  | 'account.unban'
  | 'account.role_change'
  | 'account.revoke_sessions'
  | 'account.delete'
  | 'org.suspend'
  | 'org.resume'
  | 'link.revoke'
  | 'credits.grant'
  | 'credits.revoke'
  | 'membership.start'
  | 'membership.cancel'
  | 'membership.cycle_grant'
  | 'usage.export'
  /**
   * 注册赠送（70 §2，WP121）。
   *
   * 三种结局都记：`done` = 真送出去了；`failed` = 没送（黑名单 / 钱包还没装起来）。
   * "已经送过了"**不记**——那不是一件事发生了，那是一件事没再发生一次。
   */
  | 'signup.bonus'

/**
 * 一条审计。**只增不改**：没有 update，没有 delete，主键是自增号。
 *
 * `details` 是一个小 JSON。**里面不许有令牌、不许有完整邮箱、不许有任何业务正文**
 * （21 §1）：邮箱只到域名，令牌只到前缀。写审计的那个函数**永不抛**——审计写失败
 * 不该把"封禁这个人"也一起失败掉（KOLAgents 那条，照搬）。
 */
export interface AuditEntry {
  id: number
  at: Iso8601
  action: AuditAction
  /** 谁干的。系统自己干的（定时续发）记 `system`。 */
  actor_account_id: CloudAccountId | 'system'
  actor_role: CloudRole | 'system'
  /** 对谁干的：账号 id / 组织 id / 关联 id，看动作。 */
  target_kind: 'account' | 'org' | 'link' | 'system'
  target_id: string
  /** `intent` = 还没执行（危险动作先写这一条），`done` / `failed` = 执行之后补一条。 */
  outcome: 'intent' | 'done' | 'failed'
  details: Record<string, unknown>
  /** 来源 IP（限流那份同一个取法）。取不到就 `unknown`。 */
  ip: string
}

/* ------------------------------------------------------------------ */
/* 计量的扩列（我方成本与扣费状态）                                      */
/* ------------------------------------------------------------------ */

/**
 * 这一条计量最后到底扣上钱没有。
 *
 * - `charged`：扣了。
 * - `insufficient_credits`：余额不够，没扣（这一次也没放行）。
 * - `skipped`：本来就免费（浏览、基准、`/v1/ai/models`）。
 * - `error`：上游或我们自己出错，预扣已释放。
 * - `admin_exempt`：调用方是我们自己的管理员账号——**不计费也不进失败统计**
 *   （KefuAgent 那条：自己测试把"失败率"顶到天上，看板从此没人信）。
 */
export type ChargeStatus = 'charged' | 'insufficient_credits' | 'skipped' | 'error' | 'admin_exempt'

export const CHARGE_STATUSES: readonly ChargeStatus[] = [
  'charged',
  'insufficient_credits',
  'skipped',
  'error',
  'admin_exempt',
]

/**
 * 计量事件上新增的那几个**可选**字段（49 M6 的白名单从八个扩到十六个）。
 *
 * 为什么这不算违反"只记计量不记正文"：这几列全是**成本会计**的量——供应商、
 * 模型名、进出 token 数、我方成本、扣费状态。它们没有一个字来自用户的 prompt、
 * 响应、附件或订单。M6 真正要挡的是"从上游响应里 spread 一把过来"，而扩白名单
 * 之后那道运行时断言**还在**：不在这十六个名字里的键，照样抛。
 *
 * 旧行这些列是 `null`，聚合时当 0（不是"未知"，是"那时候没记”）。
 */
export const METERING_COST_FIELDS = [
  'provider',
  'model',
  'input_tokens',
  'output_tokens',
  'cost_micros',
  'cost_currency',
  'charge_status',
  'account_id',
] as const

export type MeteringCostField = (typeof METERING_COST_FIELDS)[number]

/**
 * 我方成本用**整数微单位**存（1 元 = 1_000_000 微元）。
 *
 * 为什么不是"分"：KefuAgent 曾经把成本四舍五入到分，于是每次 200 token 的便宜模型
 * 成本恒等于 0，一年之后毛利率显示 100%。微单位下最便宜的模型一次调用也有三位数。
 */
export const COST_MICRO_UNIT = 1_000_000

/** 微单位 → 元（只在**显示**的时候做这一步，聚合永远在整数上做）。 */
export const microsToCurrency = (micros: number): number =>
  Math.round((micros / COST_MICRO_UNIT) * 100) / 100

/* ------------------------------------------------------------------ */
/* 会员（term / cycle）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 一个会员档位。**档位是数据不是代码**（照 `pricing.json` 那条）。
 *
 * 本版只有一个占位档 `beta-tester`：agentsws 到今天还**没有定义过任何会员权益**
 * （49 通篇只有积分，没有套餐），所以这里只把**机制**建好，不发明权益体系。
 */
export interface MembershipPlan {
  id: string
  label_zh: string
  label_en: string
  /** 每个 cycle（一个日历月）送多少积分，`granted` 那一类。 */
  credits_per_cycle: number
  /** 送的那一笔多少天后清零；不给 = 跟着 cycle 走（下一个 cycle 开始时到期）。 */
  note_zh: string
}

/**
 * 一段手动开通的会员（KefuAgent 的 term / cycle 模型）。
 *
 * **term 是一段时间，cycle 是里面的一个月**。开通 24 个月 = 一个 term + 24 个 cycle，
 * 每个 cycle 到点发一次积分、各自带各自的到期日、且被 term 末尾封顶（最后一个
 * cycle 送的积分不该比 term 活得更久）。
 *
 * 为什么不是"开通时一次性发 24 个月的量"：用户第三个月不用了，我们已经把 24 个月
 * 的积分给出去了，而它们永不过期。
 */
export interface MembershipTerm {
  id: string
  org_id: CloudOrgId
  plan_id: string
  /** 计算所有 cycle 边界的锚点。调档时**沿用旧 anchor**，不重新起算。 */
  anchor_at: Iso8601
  starts_at: Iso8601
  /** term 的末尾（绝对到期日，或 anchor + N 个日历月）。 */
  ends_at: Iso8601
  status: 'active' | 'cancelled' | 'expired'
  /** 谁开的。定时续发记 `system`。 */
  created_by: CloudAccountId | 'system'
  created_at: Iso8601
  note?: string
  cancelled_at?: Iso8601
  cancelled_by?: CloudAccountId
}

/** term 里的一个月：发没发、发了哪一笔。 */
export interface MembershipCycle {
  id: string
  term_id: string
  org_id: CloudOrgId
  /** 第几个（从 1 起）。 */
  index: number
  starts_at: Iso8601
  /** 被 term 的 `ends_at` 封顶。 */
  ends_at: Iso8601
  /**
   * 幂等键：由 `(org_id, term_id, cycle_start)` 推出来，**绝不用 `Date.now()`**。
   * KefuAgent 那条真事：key 里带了时间戳，定时任务每跑一次就重发一次，白送了一个月。
   */
  grant_key: string
  credits: number
  granted_at?: Iso8601
  /** 发出去的那个 lot。 */
  lot_id?: string
}

/** 手动开通最多几个月。60 = 五年，再长就不是"手动开通"了。 */
export const MEMBERSHIP_MAX_TERM_MONTHS = 60

/**
 * 日历月一律按**固定时区**算，不用本机时区（KefuAgent 那条）。
 *
 * 服务器换个机房、容器里没设 TZ，"这个月的第一天"就漂了一天，于是同一个 cycle
 * 在两台机器上算出两个 grant_key，幂等失效。
 */
export const MEMBERSHIP_TIMEZONE = 'Asia/Shanghai'
/** `Asia/Shanghai` = UTC+8，没有夏令时（1991 年之后）。写成偏移量免得拖进 tz 库。 */
export const MEMBERSHIP_UTC_OFFSET_MINUTES = 8 * 60

/* ------------------------------------------------------------------ */
/* 后台读接口的返回形状                                                 */
/* ------------------------------------------------------------------ */

/** 服务端分页的统一信封。`total` 是**过滤之后**的总数（不是全表）。 */
export interface AdminPage<T> {
  rows: T[]
  total: number
  limit: number
  offset: number
}

/** 用户列表的一行。综合状态徽章：封禁 > 会员 > 付费过 > 免费。 */
export type AccountBadge = 'banned' | 'member' | 'paid' | 'free'

export interface AdminAccountRow {
  account_id: CloudAccountId
  email: string
  role: CloudRole
  created_at: Iso8601
  /** 这个邮箱验证过没有——云侧的 magic link 登录成功过一次就算验过。 */
  email_verified: boolean
  badge: AccountBadge
  org_id: CloudOrgId | null
  org_name: string | null
  /** 两类积分分开显示（合成一个数会让"送的"看起来像"买的"）。 */
  credits_granted: number
  credits_purchased: number
  banned: boolean
  ban_reason?: string
  ban_expires_at?: Iso8601
}

export interface AdminOrgRow {
  org_id: CloudOrgId
  name: string
  owner_account_id: CloudAccountId
  owner_email: string
  created_at: Iso8601
  members: number
  /** 活着的工作区关联数。 */
  active_links: number
  credits_available: number
  /** 近 30 天：向用户收的积分 / 我方成本（微单位）/ 调用数。 */
  credits_30d: number
  cost_micros_30d: number
  calls_30d: number
  suspended: boolean
}

/** 用量台账的一行（**就是计量事件本身**，加上给人看的组织名）。 */
export interface AdminUsageRow {
  id: number
  at: Iso8601
  org_id: CloudOrgId
  org_name: string | null
  workspace_id: string
  capability: string
  provider: string | null
  model: string | null
  unit: string
  quantity: number
  input_tokens: number
  output_tokens: number
  /** 向用户收的积分（1 积分 = ¥1）。 */
  credits: number
  /** 我方成本，微单位整数。 */
  cost_micros: number
  cost_currency: string
  charge_status: ChargeStatus
  request_id: string
}

/**
 * 亏本告警：收的比成本少的那些行。
 *
 * 为什么单独出一块而不是让人自己去表里找：这是**唯一**一个"看板上出现了就必须
 * 有人动手"的数。0 行时**整张卡不渲染**——一张永远显示"一切正常"的卡，人三天
 * 之后就不看了（KOLAgents 那条）。
 */
export interface LossAlert {
  /** 亏本的行数。0 = 前端不渲染这张卡。 */
  rows: number
  /** 合计亏了多少（微单位，正数）。 */
  loss_micros: number
  /** 单行最大亏损（微单位）。 */
  worst_micros: number
  /** 亏得最多的那几行的能力 / 模型（只给名字与数，不给正文）。 */
  worst: { capability: string; model: string | null; loss_micros: number; at: Iso8601 }[]
}

/** 总览页的一格 KPI。`window_days` 的窗口内一个数 + 两个环比。 */
export interface AdminKpi {
  key: string
  value: number
  /** 近 7 天与近 30 天的增量（`+N/7d · +N/30d`，KOLAgents 那条）。 */
  delta_7d?: number
  delta_30d?: number
}

/** 总览的日趋势一行（窗口 7 / 30 / 90 可切）。 */
export interface AdminTrendPoint {
  day: string
  credits: number
  cost_micros: number
  calls: number
  input_tokens: number
  output_tokens: number
}

/** 按能力 / 供应商 / 模型三张表共用的一行。 */
export interface AdminBreakdownRow {
  key: string
  calls: number
  quantity: number
  credits: number
  cost_micros: number
  input_tokens: number
  output_tokens: number
  /** 毛利 = credits × 1_000_000 − cost_micros（1 积分 = ¥1，49 M4）。 */
  margin_micros: number
}

export interface AdminOverview {
  window_days: number
  from: Iso8601
  to: Iso8601
  kpis: AdminKpi[]
  trend: AdminTrendPoint[]
  by_capability: AdminBreakdownRow[]
  by_provider: AdminBreakdownRow[]
  by_model: AdminBreakdownRow[]
  /** 成本最高的十个组织。 */
  top_orgs: (AdminBreakdownRow & { org_name: string | null })[]
  loss: LossAlert
  /** 扣费健康：各 `charge_status` 多少条。 */
  charge_health: { status: ChargeStatus; rows: number }[]
}

/** 健康页的一项。`measures` 是"它到底测量了什么"——每一项都必须写（KOLAgents 那条）。 */
export interface AdminHealthItem {
  key: string
  label_zh: string
  /** 一句话：这一格绿了意味着什么、红了又意味着什么。 */
  measures_zh: string
  status: 'ok' | 'warn' | 'bad' | 'unknown'
  detail?: string
  at?: Iso8601
}

/** 总览可切的三个窗口。 */
export const ADMIN_TREND_WINDOWS: readonly number[] = [7, 30, 90]
