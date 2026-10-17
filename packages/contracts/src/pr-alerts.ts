/**
 * WP387（docs/103 v2 §3.3、R3、T1，Luoye 10-17）：**你的浏览器替你建 / 导入 Google 提醒**。
 *
 * 一期 A（WP386）把监控源与 AI 建议的提醒清单定成了 {@link MonitorSource} / {@link MonitorPlanItem}；
 * 本文件只加「让工坊替你建」这一路要的形状，**不改** `pr-watch.ts` 一个字。
 *
 * 流程（照 §3.3）：
 * 1. 配置卡确认清单后点「让工坊替你建」→ 对话里出**一张**「改东西」卡（`google_alert_change`）：
 *    「要在你的 Google 账号里建 N 条提醒」。卡上列全部 N 条（查询语句 / 语言 / 地区），每条可勾掉，**一次同意**；
 * 2. 同意之后，那一次运行带着 {@link RunBrowserGrant} 去用户自己的浏览器里建（门禁只在这次运行里放行
 *    `google.com/alerts` 上的写操作，见 {@link BROWSER_WRITE_GUARDS}）；
 * 3. 建完把每条的 RSS 链接读回来（{@link GoogleAlertsReport}），写成 `MonitorSource{added_via:'browser'}`，先拉一次验证；
 * 4. 出岔子（没登录 / 验证码 / 页面认不出）就交给人或停下照实说，没建成的退回手动贴链接。
 *
 * 读已有的提醒（{@link ExistingGoogleAlert}）是只读的，不出卡；其中还在用邮箱投递的要改成 RSS，
 * 改投递方式等于又改了用户的账号，所以同样一张卡（`op: 'to_rss'`）一次同意。
 */
import type { MonitorGroup } from './pr-watch.js'

/* ── 门禁：哪些页面上的写操作要先有卡 ───────────────────────────────── */

/** Google 提醒的页面（skill 打开的就是它）。 */
export const GOOGLE_ALERTS_PAGE_URL = 'https://www.google.com/alerts'

/**
 * 一处「写操作要先有卡」的页面。
 *
 * 个人档里浏览器的写操作（点击、输入）本来是放行的——那是用户自己的浏览器。但下面这几页上的点击
 * 改的是用户**外部账号里的东西**（建提醒、改投递方式），所以只在那张卡同意之后的那次运行里放行：
 * 运行请求里带着同一种 `change_kind` 的 {@link RunBrowserGrant} 才放。
 */
export interface BrowserWriteGuard {
  /** 主机名（小写，不带端口）。 */
  host: string
  /** 路径前缀（`/alerts` 也管住 `/alerts/edit…`）。 */
  path_prefix: string
  /** 哪一种卡同意过才放行（与 `ChangeKind` 同名）。 */
  change_kind: 'google_alert_change'
  /** 拦下时给人看的一句。 */
  reason: string
}

export const BROWSER_WRITE_GUARDS: readonly BrowserWriteGuard[] = [
  {
    host: 'www.google.com',
    path_prefix: '/alerts',
    change_kind: 'google_alert_change',
    reason: '改你 Google 账号里的提醒要先在卡上同意',
  },
  {
    host: 'google.com',
    path_prefix: '/alerts',
    change_kind: 'google_alert_change',
    reason: '改你 Google 账号里的提醒要先在卡上同意',
  },
]

/** 一个地址落在哪一条门禁里（落不进回 `undefined`）。 */
export function browserWriteGuardOf(url: string): BrowserWriteGuard | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  const host = u.hostname.toLowerCase().replace(/\.$/u, '')
  const path = u.pathname
  return BROWSER_WRITE_GUARDS.find(
    (g) =>
      g.host === host &&
      (path === g.path_prefix ||
        path.startsWith(`${g.path_prefix}/`) ||
        path.startsWith(`${g.path_prefix}?`)),
  )
}

/**
 * 运行请求上带的一张「这次运行可以改」的凭据（`RunRequest.browser_grants`）。
 *
 * 只由服务端在卡同意之后、给**那一次**运行写上；模型给不了自己。
 */
export interface RunBrowserGrant {
  change_kind: BrowserWriteGuard['change_kind']
  /** 同意的是哪一笔改动（账本里的 change id）。 */
  change_id: string
}

/* ── 卡上那几条 ─────────────────────────────────────────────────────── */

/** 一条要做的事：新建一条提醒 / 把已有那条的投递从邮箱改成 RSS。 */
export type GoogleAlertOp = 'create' | 'to_rss'

/** 卡上的一行（`google_alert_change` 的 `after.lines[]`）。 */
export interface GoogleAlertLine {
  /** 行号（`ga_1`…；卡上勾掉、读回结果都按它对）。 */
  id: string
  op: GoogleAlertOp
  /** Google 查询语句（`"Aventon" -job`）。 */
  query: string
  /** 语言（`en`…；`any` = 不限）。 */
  language: string
  /** 地区（`US`…；`any` = 不限）。 */
  region: string
  /** 人话名（`Aventon`）。 */
  label: string
  group: MonitorGroup
  competitor?: string
  /** 对应配置卡上的哪一行（有才有）。 */
  plan_item_id?: string
  /** 卡上勾着没有（勾掉的不建）。 */
  selected: boolean
}

/** `google_alert_change` 的 `after`。 */
export interface GoogleAlertChangeAfter {
  op: GoogleAlertOp
  lines: GoogleAlertLine[]
}

/** 这张卡的 `form`（卡面按它认）。 */
export const GOOGLE_ALERT_CHANGE_FORM = 'google_alert_change'

/**
 * 一条提醒**必须**这样设（与 `pr-watch.ts` 的 `GOOGLE_ALERTS_REQUIRED_SETTINGS` 同一份意思，
 * 卡上那一句人话）：频率即时、来源自动、数量所有结果、投递 RSS。
 */
export const GOOGLE_ALERT_SETTINGS_SENTENCE = '每条都设成：即时、来源自动、所有结果、投递到 RSS'

/** 卡上最多列几条（一次建太多容易被 Google 当成机器，分两批）。 */
export const GOOGLE_ALERT_CHANGE_MAX_LINES = 40

/* ── 浏览器读回来的 ─────────────────────────────────────────────────── */

/** 用户账号里已经有的一条提醒（读列表页得来；只读）。 */
export interface ExistingGoogleAlert {
  query: string
  /** 投递到哪：RSS / 邮箱 / 认不出。 */
  delivery: 'rss' | 'email' | 'unknown'
  /** RSS 投递才有（`https://www.google.com/alerts/feeds/…`）。 */
  feed_url?: string
  language?: string
  region?: string
}

/** 一行的结局。 */
export type GoogleAlertOutcome =
  /** 新建成了，读回了 RSS 链接。 */
  | 'created'
  /** 账号里已经有同样的查询语句、投递是 RSS：没重复建，直接读回链接。 */
  | 'existing'
  /** 投递从邮箱改成了 RSS，读回了链接。 */
  | 'switched'
  /** 账号里已经有，但投递还是邮箱（建的那张卡不改它，另出一张「改成 RSS」的卡）。 */
  | 'existing_email'
  /** 试了没成（原因见 `reason`）。 */
  | 'failed'
  /** 没轮到（前面卡住、停下了）。 */
  | 'not_attempted'

export interface GoogleAlertReportLine {
  /** 卡上的行号。 */
  id: string
  outcome: GoogleAlertOutcome
  feed_url?: string
  /** 一句人话（失败 / 没轮到时）。 */
  reason?: string
}

/** 这一趟为什么停下（没停 = `done`）。 */
export type GoogleAlertsStop =
  | 'done'
  /** 要登录：交给了人，人没处理完。 */
  | 'not_signed_in'
  /** 验证码 / 人机验证：交给了人，人没处理完。 */
  | 'captcha'
  /** 页面和技能说明里认的不一样了（Google 改版）。 */
  | 'page_changed'
  /** 别的（浏览器没接上、超时…）。 */
  | 'other'

/** 浏览器那一趟交回来的东西（`report_google_alerts` 工具的入参）。 */
export interface GoogleAlertsReport {
  /** 建 / 改：对应哪一笔同意过的改动；只读一遍已有的：不给。 */
  change_id?: string
  lines: GoogleAlertReportLine[]
  /** 顺手读到的账号里已有的提醒（只读）。 */
  existing?: ExistingGoogleAlert[]
  stop: GoogleAlertsStop
  /** 停下时的一句人话。 */
  note?: string
}

/* ── 一趟的记录（存在品牌自己的库里）────────────────────────────────── */

export type GoogleAlertsJobStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed'

/** 一趟「替你建 / 改」的记录。 */
export interface GoogleAlertsJob {
  /** = 账本里那笔改动的 id。 */
  change_id: string
  op: GoogleAlertOp
  /** 同意过的那几行（勾掉的不在里面）。 */
  lines: GoogleAlertLine[]
  status: GoogleAlertsJobStatus
  /** 这一趟跑在哪件事上（「运行中的浏览器」在那里看得到）。 */
  matter_id?: string
  results?: GoogleAlertReportLine[]
  stop?: GoogleAlertsStop
  /** 给人看的一句收尾。 */
  summary?: string
  created_at: string
  updated_at: string
}

/** 读一遍已有提醒的结果（只读；导入要人勾）。 */
export interface GoogleAlertsExistingView {
  read_at?: string
  /** 投递已经是 RSS、还没导入的（可以勾了导入）。 */
  importable: ExistingGoogleAlert[]
  /** 还在用邮箱投递的（要改成 RSS 得出卡）。 */
  email: ExistingGoogleAlert[]
  /** 已经在监控源里的条数。 */
  already: number
}
