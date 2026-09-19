/**
 * 红人营销增值服务（67，WP118）：订阅状态 + 云端红人库的双向同步。
 *
 * **这一块买的不是备份。** Luoye 2026-09-19 定的话：它是为「红人营销以后不依赖
 * 本地 Agents 工坊也能跑起来」做的地基——像 KOLAgents 那样数据在云端，区别只是
 * 本地有一份、云端也有一份。所以：
 *
 * 1. **云端要读得懂数据**。没有端到端加密、没有恢复口令——那一套的前提是「云上
 *    存的是一坨我们看不懂的字节」，而看不懂就替用户跑不了任务。加密在传输
 *    （TLS）与静态（平台能力）两层，联系方式再包一层本机密钥（见 `kol.ts`
 *    `CreatorContact.value_ref`）。
 * 2. **同步是双向的**，不是上传。两头都能改，冲突按「最后写入者胜」定谁是当前值，
 *    **输的那一份留着**（{@link KolSyncConflict}）并在界面上标出来。静默丢掉用户
 *    在另一台机器上写的半句话，是这类功能最常见也最伤的事故。
 * 3. **没订阅就不给同步**（402），但**不删数据**。余额不足也一样：同步暂停、宽限
 *    30 天、界面说人话。删数据只能由用户自己按那颗按钮。
 */

import type { Iso8601 } from './common.js'

/* ------------------------------------------------------------------ */
/* 订阅                                                                */
/* ------------------------------------------------------------------ */

/** 计费用的能力名。价目表里那一条（`pricing.json`）就是它。 */
export const KOL_SERVICE_CAPABILITY = 'kol.service.monthly'

/** 每月多少积分。30 积分 = ¥30 / 月（Luoye 2026-09-19 定）。 */
export const KOL_SERVICE_CREDITS_PER_MONTH = 30

/**
 * 余额不足之后还能拖多少天。
 *
 * 30 天不是随手写的：用户这个月没充上钱，不该第二天就看不到自己的红人库。
 * 宽限期内**同步暂停、数据一条不动**；过了宽限期仍然只是暂停（`suspended`），
 * 依旧不删——删数据的按钮只在用户自己手里。
 */
export const KOL_SERVICE_GRACE_DAYS = 30

/**
 * 订阅现在是什么状态。
 *
 * - `none`：从来没开通过（或者已经彻底结束了）。
 * - `active`：正常。
 * - `grace`：这一期的钱没扣上（余额不足），在 30 天宽限里——同步暂停，数据不动。
 * - `suspended`：宽限期过了，还是没充上钱。同步仍然停、数据仍然不动。
 * - `cancelling`：用户点了取消，**当期用完为止**（`current_cycle_end` 之前照常用）。
 *
 * 为什么把 `grace` 与 `suspended` 分开：前者界面上是一句提醒，后者是一张要人
 * 拍板的卡（充值 / 导出 / 删除三个选项）。合成一态就没法区分这两句话。
 */
export type KolServiceStatus = 'none' | 'active' | 'grace' | 'suspended' | 'cancelling'

export const KOL_SERVICE_STATUSES: readonly KolServiceStatus[] = [
  'none',
  'active',
  'grace',
  'suspended',
  'cancelling',
]

/** 这个状态下同步能不能做。只有 `active` 与 `cancelling` 能。 */
export function kolSyncAllowed(status: KolServiceStatus): boolean {
  return status === 'active' || status === 'cancelling'
}

/**
 * 一个组织的订阅。
 *
 * 时间字段全是可选的，因为 `none` 那一态什么都没有——写成必填就得塞一个假日期，
 * 而假日期会被当真日期算出一个假的 cycle。
 */
export interface KolServiceSubscription {
  org_id: string
  status: KolServiceStatus
  /** 第一次开通的时刻。取消再开通不改它（用来回答「用了多久」）。 */
  started_at?: Iso8601
  /**
   * 算所有 cycle 边界的锚点。**取消再开通会换一个新的**，但调档不换
   * （65 §7 第 3 条：换档沿用旧 anchor，否则这个月会扣两次）。
   */
  anchor_at?: Iso8601
  current_cycle_start?: Iso8601
  current_cycle_end?: Iso8601
  /** 用户点过取消（当期用完为止）。等价于 `status === 'cancelling'`，但存下来便于审计。 */
  cancel_at_period_end: boolean
  /** 从哪一刻开始欠着这一期（余额不足那一刻）。 */
  unpaid_since?: Iso8601
  /** 宽限到哪天。`unpaid_since + 30 天`。 */
  grace_until?: Iso8601
  /** 运营后台赠送还剩几个月。赠送的那些 cycle **不扣钱**。 */
  granted_months: number
  last_charge_at?: Iso8601
  /** 最后扣成功的那个 cycle 的起点（幂等的可读版本，真幂等靠 charge key）。 */
  last_charged_cycle_start?: Iso8601
  /** 云端这份有多少个对象（后台抽屉那一行）。 */
  object_count: number
  last_sync_at?: Iso8601
  updated_at: Iso8601
}

/** 一个没开通过的组织长什么样。**不是** `undefined`——界面上那张卡总要有东西渲染。 */
export function emptyKolSubscription(org_id: string, at: Iso8601): KolServiceSubscription {
  return {
    org_id,
    status: 'none',
    cancel_at_period_end: false,
    granted_months: 0,
    object_count: 0,
    updated_at: at,
  }
}

/* ------------------------------------------------------------------ */
/* 云端红人库的对象                                                     */
/* ------------------------------------------------------------------ */

/**
 * 云端存的对象种类。
 *
 * 前六种与本地 `KolStore` 的六张表**一一对应**（`apps/server/src/kol.ts`），
 * 后三种是 Luoye 点名要的那几样里还没有本地实现的部分（活动、候选池、备注）——
 * 契约先到位，本地那一头补上就直接能同步，不用再改一次协议。
 *
 * 同步协议对「种类」是不关心的：它只认 `(kind, id)` 这个主键和版本号。
 * 加一种就是往这张表里加一行，不改任何一条路由。
 */
export type KolObjectKind =
  | 'creator'
  | 'platform_account'
  | 'creator_contact'
  | 'collaboration'
  | 'deliverable'
  | 'tracked_link'
  | 'campaign'
  | 'candidate'
  | 'note'

export const KOL_OBJECT_KINDS: readonly KolObjectKind[] = [
  'creator',
  'platform_account',
  'creator_contact',
  'collaboration',
  'deliverable',
  'tracked_link',
  'campaign',
  'candidate',
  'note',
]

export function isKolObjectKind(raw: string): raw is KolObjectKind {
  return (KOL_OBJECT_KINDS as readonly string[]).includes(raw)
}

/**
 * 同步单元：一个对象的一个版本。
 *
 * - `version` **每对象自己数**，从 1 起，每写一次 +1。它不是时间戳：两台机器的钟
 *   差几秒是常事，用时间当版本号会让「谁更新」变成「谁的钟快」。
 * - `updated_at` 才是定胜负的那个（最后写入者胜），`writer` 只在同一毫秒撞上时
 *   当平手裁判——两个都相同才比 writer 的字典序，纯粹为了让两头算出同一个结果。
 * - `deleted` 的那些**留一行墓碑**（没有 `body`）。不留的话，一台机器删掉的东西
 *   会被另一台还没同步的机器当成「新对象」推回来，删不掉。
 */
export interface KolSyncObject {
  kind: KolObjectKind
  id: string
  /** 每对象版本号，从 1 起。 */
  version: number
  updated_at: Iso8601
  /** 谁写的：本地那台机器的 id（`device:<uuid>`）或 `cloud`。 */
  writer: string
  /** 删除的墓碑。`true` 的时候 `body` 不出现。 */
  deleted?: boolean
  /** 正文（`Creator` / `Collaboration` … 原样那个 json）。删除的那些没有。 */
  body?: Record<string, unknown>
}

/** 两头同时改了同一条：谁赢、输的那份是什么。**输的留着**，不静默丢。 */
export interface KolSyncConflict {
  kind: KolObjectKind
  id: string
  /** 赢的那一份（当前值）。 */
  winner: KolSyncObject
  /** 输的那一份（原样留着，界面上让用户看得见、必要时挑回来）。 */
  loser: KolSyncObject
  at: Iso8601
}

/**
 * 「最后写入者胜」的判定。回 `true` 表示 `candidate` 该盖掉 `current`。
 *
 * 三级比较：先 `updated_at`，再 `version`（同一刻但版本更高的更新），
 * 最后 `writer` 的字典序。**第三级不是为了公平，是为了确定性**：两头各算一次
 * 必须算出同一个结果，否则同步永远收敛不了，两台机器会互相推翻。
 */
export function kolWinsOver(candidate: KolSyncObject, current: KolSyncObject): boolean {
  if (candidate.updated_at !== current.updated_at) return candidate.updated_at > current.updated_at
  if (candidate.version !== current.version) return candidate.version > current.version
  return candidate.writer > current.writer
}

/* ------------------------------------------------------------------ */
/* 同步的四条路由                                                       */
/* ------------------------------------------------------------------ */

/** 一次上行最多推多少条。超了回 `invalid_input`，让本地自己分批。 */
export const KOL_SYNC_MAX_BATCH = 500

/** 上行：本地把自己改过的那些推上去。 */
export interface KolSyncPushRequest {
  /** 本地那台机器的 id。同一台机器推上来的东西不会再被拉回去（省一趟）。 */
  writer: string
  objects: KolSyncObject[]
}

export interface KolSyncPushResult {
  /** 写进去了几条。 */
  accepted: number
  /**
   * 云端赢了、没被盖掉的那几条（本地要把这些覆盖回本地）。
   *
   * 这不是「失败」——这是双向同步的正常一半：本地推了个旧版本上来，
   * 云端把当前值回给它。
   */
  rejected: KolSyncObject[]
  /** 这一批里撞上的冲突（`rejected` 的那些里，两头都真改过的）。 */
  conflicts: KolSyncConflict[]
  /** 推完之后的游标（下一次 pull 从这里往后要）。 */
  cursor: string
  at: Iso8601
}

/** 下行：把游标之后云端改过的那些拉下来。 */
export interface KolSyncPullResult {
  objects: KolSyncObject[]
  /** 下一次带上它。第一次不带（或者带空串）= 从头全量。 */
  cursor: string
  /** 还有没有下一页。有就接着用新游标再拉一次。 */
  has_more: boolean
  at: Iso8601
}

/** 同步状态（界面上那一行「最近同步：3 分钟前 · 云端 1,204 条」）。 */
export interface KolSyncStatus {
  org_id: string
  subscription: KolServiceSubscription
  /** 云端有多少条（不含墓碑）。 */
  object_count: number
  /** 按种类分的条数（界面上折叠着看）。 */
  by_kind: { kind: KolObjectKind; count: number }[]
  /** 云端当前游标。本地拿它和自己存的那个比，就知道落后没有。 */
  cursor: string
  /** 还没被人处理的冲突条数。**不为 0 就在界面上挂一个标**。 */
  pending_conflicts: number
  last_sync_at?: Iso8601
  at: Iso8601
}

/* ------------------------------------------------------------------ */
/* 用户的数据权利（49 §5 / 21 §4）                                      */
/* ------------------------------------------------------------------ */

/**
 * 云端这一份的导出包。
 *
 * **一个文件、可读的 json**，不是我们自己的备份格式——用户要能拿着它走。
 * 本地那一份不在里面（本地有本地的导出）。
 */
export interface KolCloudExport {
  /** 导出格式版本。加字段不改它，改结构才改。 */
  format: 1
  org_id: string
  at: Iso8601
  subscription: KolServiceSubscription
  objects: KolSyncObject[]
  /** 留着的那些冲突版本也一起带走（不然「输的那一份」就真丢了）。 */
  conflicts: KolSyncConflict[]
}

/** 删除云端这一份的结果。**本地一条不动**——这是两份数据，不是一份。 */
export interface KolCloudDeleteResult {
  org_id: string
  /** 删掉了多少条。 */
  deleted: number
  /** 订阅还在不在（删数据不等于退订；用户可能只是想清空重来）。 */
  subscription_kept: boolean
  at: Iso8601
}
