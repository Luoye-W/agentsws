/**
 * 49 §6 WP60 / 48 L6：在线值守与聊天窗托管的契约面。
 *
 * 一句话：**同一时刻只有一个服务进程**（48 L6）。值守开 = 你的工作区服务进程在
 * 云上跑，本地桌面变成"远程窗口"；不做本地与云的双活，也不做同步——同步要解决的
 * 那个问题（两份真源打架）在这里根本不存在，因为只有一份。
 *
 * 三条边界，写在类型里而不是写在注释里：
 *
 * 1. **一个值守工作区 = 一个子进程 + 一个数据目录 + 一把自己的库密钥**（21 按租户加密）。
 *    {@link StandbyWorkspace} 里有 `port` 与 `last_health_at`，**没有密钥**——
 *    编排层的库里一个字节的租户密钥都不该有。
 * 2. **账在组织级**（52 O3）。`org_id` 是计费主体，`workspace_id` 是被托管的那一个。
 * 3. **聊天 widget 的公开面按来源域名放行**（{@link ChatWidgetConfig.allowed_origins}）。
 *    空列表 = 一个外部来源都不放行（不是"放行所有"）：一条不需要凭据就能写进工作区的
 *    路由，默认值只能是关着的。
 */

import type { Iso8601, WorkspaceId } from './common.js'

/** 值守订阅按这个能力名计价（价目表 `pricing.json` 里那一条）。 */
export const STANDBY_CAPABILITY = 'standby.seat.month'

/** 值守订阅的单位：一个座位一个月。 */
export const STANDBY_UNIT = 'seat_month'

/** 一个订阅周期多少天。按 30 天一档记，账面上"一个月"就是 30 天，不随月份长短浮动。 */
export const STANDBY_PERIOD_DAYS = 30

/** 到期前多少天出 `standby.renewal_due`。 */
export const STANDBY_RENEWAL_LEAD_DAYS = 3

/**
 * 一个值守工作区现在是什么状态。
 *
 * - `starting`：进程已经拉起来了，但健康检查还没过（第一次起库、跑迁移要几秒）。
 * - `running`：健康检查过了，公网入口可以往里转发。
 * - `stopped`：用户自己停的，或者崩了还在退避等重启。数据还在，导出照常。
 * - `expired`：订阅到期且余额不足。**数据不删**——导出仍然可以（41 §2.3 三条纪律之一：随时搬家）。
 */
export type StandbyStatus = 'starting' | 'running' | 'stopped' | 'expired'

/**
 * 云上的一个值守工作区。
 *
 * `port` 是**本机回环口**（子进程只监听 127.0.0.1，公网进来的一律走云进程那层反向代理），
 * 所以它出现在这里不等于它对外可达。`last_health_at` 从没成功过就没有这一格——
 * 不要拿 `created_at` 冒充一次没发生过的健康检查。
 */
export interface StandbyWorkspace {
  workspace_id: WorkspaceId
  /** 计费主体（52 O3）。 */
  org_id: string
  status: StandbyStatus
  /** 座位数（按 `standby.seat.month` × 座位数计价）。 */
  seats: number
  /** 这一期付到什么时候。 */
  period_end: Iso8601
  /** 子进程的回环端口；没在跑就没有这一格。 */
  port?: number
  /** 最近一次健康检查通过的时间；从没过过就没有这一格。 */
  last_health_at?: Iso8601
}

/** 值守发出去的三种事件。 */
export type StandbyEventType = 'standby.started' | 'standby.stopped' | 'standby.renewal_due'

/**
 * 一条值守事件。
 *
 * 与 49 M6 的 `MeteringEvent` 分开是有意的：那张表只有八个字段、只记计量，
 * 多一个键就抛。值守的"起来了 / 停了 / 快到期了"不是计量，硬塞进去要么破白名单，
 * 要么把 `quantity` 当成状态位用——两条都比多一个类型糟。
 *
 * 这里同样**没有正文**：没有工作区名字、没有邮箱、没有端口、没有密钥。
 */
export interface StandbyEvent {
  type: StandbyEventType
  workspace_id: WorkspaceId
  org_id: string
  at: Iso8601
  /** `standby.stopped` / `standby.renewal_due` 说明原因（人话，不含任何标识符）。 */
  reason?: string
  /** `standby.renewal_due`：这一期什么时候到。 */
  period_end?: Iso8601
  /** `standby.renewal_due`：续一期要多少积分。 */
  credits_due?: number
}

/**
 * 网站聊天窗（widget）的配置（48 §4 L3 #11 的云端部分）。
 *
 * `allowed_origins` 是这一整条公开面唯一的门：访客路由不需要任何凭据就能建会话，
 * 所以"谁能建"只能按浏览器报的 `Origin` 判。**空列表 = 全拒**，
 * 不是"全放"——默认值要是放行所有，那么每一个开了值守的工作区都自带一个
 * 任何人可写的入口，而用户根本不知道自己开过它。
 */
export interface ChatWidgetConfig {
  /** 允许嵌入的来源（`https://shop.example.com`，只比源不比路径）。空 = 全拒。 */
  allowed_origins: string[]
  /** 气泡与按钮的主色（`#RRGGBB`）；不填用内置的那个。 */
  accent?: string
  /** 打开时的第一句话；不填用内置的那句。 */
  greeting?: string
  /**
   * WP124（修订第 3 条）：求助等待时长（秒）。默认 30，范围 10–600，
   * 非法值回落 30（服务端白名单，与 `normalizeAssistWaitSeconds` 同一条规则）。
   * 死线在求助那一刻固化，改它只影响新的求助。
   */
  assist_wait_seconds?: number
  /** 挂件在页面上的位置（预设二选一；36 §原则 16：开关与预设，不做自由画布）。 */
  position?: 'left' | 'right'
  /** 挂件界面语言。`auto` 跟宿主页 `<html lang>`，`zh` / `en` 强制。 */
  language?: 'auto' | 'zh' | 'en'
}

/** widget 的默认配置：**一个来源都不放行**。 */
export const DEFAULT_CHAT_WIDGET_CONFIG: ChatWidgetConfig = { allowed_origins: [] }

/**
 * 访客那一面能看到的 widget 配置（`GET /v1/chat/widget-config`）。
 *
 * **不回 `allowed_origins`**：一个访客没有任何理由知道这家店还允许哪些站点嵌它。
 * 放不放行这件事由 `enabled` 一个布尔说完。
 */
export interface ChatWidgetPublicConfig {
  enabled: boolean
  accent: string
  greeting: string
}

/** 本地"在线值守"那一格看到的样子（`GET /v1/standby`）。 */
export interface StandbyLocalView {
  /** 关联 agentsws 账号了没有（没关联就先去关联，向导第一步）。 */
  linked: boolean
  /** 没关联 / 云连不上时的人话。**不是错**——界面据此换按钮，而不是画一堆 0。 */
  reason?: string
  /** 这台机器现在是不是"远程窗口"（本地服务进程已经让位给云上那个）。 */
  remote: boolean
  /**
   * 桌面壳**该**指到的地址（`https://<云>/w/<ws>`）。
   *
   * 与 `remote` 是两件事：这一格是"该填什么"，那一格是"填过没有"。
   * 合成一格的话，还没切过去的人就看不到该填什么——而那正是他这一刻唯一需要的信息。
   */
  remote_url?: string
  /** 云上那一份的状态（没开通就没有这一格）。 */
  cloud?: StandbyWorkspace
  /** 一个座位一个月多少积分（价目表里那条 `standby.seat.month`）。 */
  seat_price?: number
  /** 可复制的嵌入脚本（开通后才有）。 */
  embed_snippet?: string
}
