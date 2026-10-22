/**
 * WP429：**站内通知**——「告诉你一声」的事，不要人拍板。
 *
 * 卡 ≠ 通知：卡是要人定的（批 / 不要 / 修改）；通知只是说一件已经发生的事（同事回你了、任务跑完了、
 * 连接断了、积分快用完了、同事接下了你交的事、本周岗位更新到了……），点一下跳到那件事。
 *
 * - 每人各自一份（按品牌分开：和卡片队列同一个口径）；
 * - 已读 / 全部已读；保留 {@link NOTIFICATION_RETENTION_DAYS} 天；
 * - **同一件事合并**：同一个 `key` 还没读时再来一次，不另起一条，只把那一条顶上来、计数加一；
 * - 设置 → 通知按类别开关，「站内」「系统」各一列（系统 = 桌面版的系统通知，重要的几类默认开）。
 */
import type { Iso8601, PersonId, WorkspaceId } from './common.js'

/** 通知的几类（设置 → 通知里一类一行）。 */
export type NotificationCategory =
  | 'team'
  | 'task'
  | 'connection'
  | 'credits'
  | 'update'
  /** WP432：批过的 Reddit 回复 / 帖子等你在浏览器插件里打开、自己点发送（插件图标上也有数字）。 */
  | 'outbound'
  /** WP441（docs/108 §5.6）：消息规则「告诉我一声」、今天的简报。 */
  | 'messages'
  /**
   * WP466（决策 1311）：原来首页告警区那几样（店铺日报异常、广告改动、改版回归、目标市场校正、
   * 退役模型换了……）——服务端 `system_alert` 系统卡，现在每张一条进铃铛。
   */
  | 'alert'
  /** WP475：你提的反馈有了回复（或者修好了）。 */
  | 'feedback'

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'team',
  'task',
  'connection',
  'credits',
  'update',
  'outbound',
  'messages',
  'alert',
  'feedback',
]

/** 保留多少天（按最后一次更新算）。 */
export const NOTIFICATION_RETENTION_DAYS = 30

/** 一个人最多留多少条（超了先删最老的已读）。 */
export const NOTIFICATION_MAX_PER_PERSON = 500

/** 一条站内通知。 */
export interface InboxNotification {
  id: string
  workspace_id: WorkspaceId
  person_id: PersonId
  category: NotificationCategory
  /** 一行字（人话，名字不是 id）。 */
  text: string
  /** 点了去哪：工作台里的地址（`/` 开头）；没有就只是告诉一声。 */
  href?: string
  /** 同一件事的键：还没读时同键合并成一条。 */
  key: string
  /** 合并了几次（≥ 1）。 */
  count: number
  created_at: Iso8601
  updated_at: Iso8601
  read_at?: Iso8601
  /** 这一条要不要同时弹系统通知（来的那一刻按本人设置算好）。 */
  system: boolean
  /**
   * WP466：紧急档（店铺日报异常、改版回归·严重……）。没读时排在最上面、红点；没有这一格 = 普通。
   */
  urgent?: boolean
}

/** 发一条通知要给的东西。 */
export interface NotificationInput {
  workspace_id: WorkspaceId
  person_id: PersonId
  category: NotificationCategory
  text: string
  href?: string
  /** 同一件事的键（不给 = 每次都是新的一条）。 */
  key?: string
  /** WP466：紧急档（见 {@link InboxNotification.urgent}）。 */
  urgent?: boolean
}

/** 一类通知的两个开关。 */
export interface NotificationChannelPrefs {
  /** 进站内通知（铃铛）。关了这一类就不记。 */
  inbox: boolean
  /** 同时弹系统通知（桌面版）。站内关了它也不弹。 */
  system: boolean
}

export type NotificationPrefs = Record<NotificationCategory, NotificationChannelPrefs>

/**
 * 默认：站内全开；系统通知只开「有人等你 / 东西坏了」的几类——同事、连接、积分。
 * 任务跑完、岗位更新只进铃铛（不打扰）。告警这一类「系统」开着也只弹紧急档的那几条。
 */
export const DEFAULT_NOTIFICATION_PREFS: Readonly<NotificationPrefs> = {
  team: { inbox: true, system: true },
  task: { inbox: true, system: false },
  connection: { inbox: true, system: true },
  credits: { inbox: true, system: true },
  update: { inbox: true, system: false },
  // WP432：等你发——有东西在等你亲手点发送，默认系统通知也开（插件里也弹一句）
  outbound: { inbox: true, system: true },
  // WP441：消息规则的「告诉我一声」与简报——默认只进铃铛，不弹系统通知
  messages: { inbox: true, system: false },
  // WP466：告警——系统通知只弹紧急档的（店铺日报异常、改版回归·严重）；普通的只进铃铛
  alert: { inbox: true, system: true },
  // WP475：反馈有了回复——只进铃铛
  feedback: { inbox: true, system: false },
}

/** 合并默认值与人改过的（缺的类别用默认；站内关了系统也算关）。 */
export function resolveNotificationPrefs(
  saved: Partial<Record<string, Partial<NotificationChannelPrefs>>> | undefined,
): NotificationPrefs {
  const out = {} as NotificationPrefs
  for (const c of NOTIFICATION_CATEGORIES) {
    const d = DEFAULT_NOTIFICATION_PREFS[c]
    const s = saved?.[c]
    const inbox = typeof s?.inbox === 'boolean' ? s.inbox : d.inbox
    const system = typeof s?.system === 'boolean' ? s.system : d.system
    out[c] = { inbox, system: inbox && system }
  }
  return out
}

/** `GET /v1/notifications` 回的样子。 */
export interface NotificationList {
  items: InboxNotification[]
  /** 本人在这个品牌里还没读的条数（铃铛上的数）。 */
  unread: number
}
