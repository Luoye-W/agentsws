/**
 * WP476（决策 1590）：产品使用数据——**事件清单 + 属性白名单**，工作台（posthog-js）与本机服务进程
 * （批量上报）共用这一份。给贡献者看的白话版在 `docs/telemetry-events.md`。
 *
 * 三条纪律：
 *
 * 1. **只认清单里的事件名**。清单外的一律丢（SDK 自己想发的 `$autocapture`、`$exception`、`$web_vitals`
 *    这些也一样）——加一个事件 = 在这里加一行 + 在文档里加一行 + 测试里钉一条。
 * 2. **只认清单里的属性，值还要过规则**。规则只放「代码里的标识」：枚举、小写 ASCII 的编号、
 *    路由模板、版本号。中文、空格、大写、邮箱、长串数字、网址一律过不去——信件、草稿、客户名、商品名、
 *    输入框内容、地址栏里的业务参数因此**从结构上**出不了门，不靠每个调用处记得洗。
 * 3. **没配置就整套不发**。上报地址只在桌面安装包里由壳给（`AGENTSWS_TELEMETRY_HOST`），项目 key 由云上
 *    `/config` 给；两样缺一样，工作台不加载 SDK、服务进程不排队。开发、测试、自建默认都是这一档。
 */

import { TELEMETRY_TESTID_TEMPLATES, TELEMETRY_TESTIDS } from './telemetry-testids.js'

export { TELEMETRY_TESTID_TEMPLATES, TELEMETRY_TESTIDS }

/** 上报地址（自家域名的转发，见私有云仓 telemetry Worker）。只有桌面安装包的壳会给它。 */
export const TELEMETRY_HOST_ENV = 'AGENTSWS_TELEMETRY_HOST'
/** 桌面安装包默认给的那一条。**开源仓的开发、测试、自建都不会自己用它**——要壳显式传下去。 */
export const DEFAULT_TELEMETRY_HOST = 'https://t.agentsws.com'
/**
 * 工作台把事件交给本机服务的那条路（posthog-js 的 `api_host`）。同源：桌面壳的 CSP 不用放宽，浏览器一个
 * 外网请求都不发；本机服务再过一遍白名单才转出去。
 */
export const TELEMETRY_RELAY_PATH = '/v1/telemetry'

/** 工作台读的那一份（`GET /v1/settings/telemetry`，本机服务进程给）。 */
export interface TelemetryView {
  /** 人在设置里开着没有（测试阶段默认开）。 */
  enabled: boolean
  /** 第一次启动那句提示看过 / 关过没有。 */
  notice_seen: boolean
  /** 这台机器上工坊的匿名设备号。 */
  install_id: string
  /** 这个安装包有没有上报地址（没有 = 开发 / 自建，整套不发，设置里那一行照常能开关）。 */
  configured: boolean
  /** 真的会发：开着 + 有地址 + 云上给了 key。工作台只在这一格为真时加载 SDK。 */
  active: boolean
  /**
   * `active` 时才有：工作台初始化 posthog-js 用。`api_host` 永远是本机的 `TELEMETRY_RELAY_PATH`
   * （浏览器只跟本机说话，外网那一跳在服务进程里）；`replay` = 云上开没开录屏回放（默认关）。
   */
  client?: { api_host: string; key: string; replay: boolean }
  /** 关联了云账号时的账号 id（不是邮箱）。 */
  account_id?: string
  /**
   * WP477：工作台最近一次告诉本机服务的界面语言（只用来按决策 1600 算 `market_region`）。
   * 工作台发现它和自己当前的语言不一样就 PUT 一次。
   */
  lang?: 'zh' | 'en'
}

/** posthog-js 打到本机 `/v1/telemetry/<口>` 的一次请求。 */
export interface TelemetryIngest {
  /** `e`（事件）、`batch`、`s`（录屏）、`flags` / `config`（只在开了录屏时用：录屏要远程配置）。 */
  kind: 'e' | 'batch' | 's' | 'flags' | 'config'
  query: string
  contentType?: string
  body: Uint8Array
}

export interface TelemetryIngestReply {
  status: number
  body: string
}

export interface TelemetryPatch {
  enabled?: boolean
  notice_seen?: boolean
  /** WP477：工作台当前的界面语言。 */
  lang?: 'zh' | 'en'
}

/** 值规则：每个属性只许是这几种之一。 */
export type TelemetryRule =
  | { kind: 'enum'; values: readonly string[] }
  /** 小写 ASCII 编号：`dtc.customer-care`、`outbound_draft`、`model_timeout`。 */
  | { kind: 'code' }
  /** 路由模板：`/positions/:id/duties/:role_id`（具体的 id 都已换成 `:名字`）。 */
  | { kind: 'route' }
  /** 错误类名：`TypeError`、`ApiError`。 */
  | { kind: 'error_name' }
  /** 版本号：`0.2.1-beta.5`。 */
  | { kind: 'version' }
  /**
   * 不透明编号（匿名设备号、云账号 id、SDK 的会话号）：8–64 位字母数字下划线连字符，至少一个字母（纯数字的电话 / 单号过不去）。
   * 这几格**只由代码填**（随机生成的号），没有一处从界面或业务数据里取值。
   */
  | { kind: 'opaque_id' }
  | { kind: 'bool' }
  /**
   * WP477（决策 1617 / 1618）：autocapture 的元素编号——只许是工作台源码里写死的 testid（`TELEMETRY_TESTIDS`），
   * 或带变量 testid 的模板（`TELEMETRY_TESTID_TEMPLATES`，变量那段是 `:x`）。见 `telemetryTestidOf`。
   */
  | { kind: 'testid' }
  /** 非负整数（屏幕宽高这类），上限防滥用。 */
  | { kind: 'int'; max: number }

const CODE = /^[a-z][a-z0-9_.:-]{0,63}$/
const ROUTE =
  /^\/(?:(?::[a-z_]{1,24}|[a-z][a-z0-9-]{0,31})(?:\/(?::[a-z_]{1,24}|[a-z][a-z0-9-]{0,31}))*)?$/
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z]+(?:\.\d{1,4})?)?$/
const OPAQUE = /^[A-Za-z0-9_-]{8,64}$/
/** 连着 5 位以上数字（电话、订单号这类）的编号一律不要——编号里不该有业务数字。 */
const LONG_DIGITS = /\d{5,}/

export function passesRule(rule: TelemetryRule, value: unknown): boolean {
  switch (rule.kind) {
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value)
    case 'code':
      return typeof value === 'string' && CODE.test(value) && !LONG_DIGITS.test(value)
    case 'route':
      return typeof value === 'string' && value.length <= 120 && ROUTE.test(value)
    case 'error_name':
      return typeof value === 'string' && ERROR_NAME.test(value)
    case 'version':
      return typeof value === 'string' && VERSION.test(value)
    case 'opaque_id':
      return typeof value === 'string' && OPAQUE.test(value) && /[A-Za-z]/.test(value)
    case 'bool':
      return typeof value === 'boolean'
    case 'testid':
      return typeof value === 'string' && telemetryTestidOf(value) === value
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= rule.max
  }
}

/**
 * 关键按钮的固定编号（`ui_click.button_id`）。不靠 autocapture 抓按钮上的字——按钮上的字可能就是
 * 一个客户名。工作台里哪颗按钮对应哪个编号，见 `apps/workstation/src/lib/telemetry/buttons.ts`。
 */
export const TELEMETRY_BUTTONS = [
  'assistant.send',
  'matter.send',
  'messages.send',
  'report.send',
  'card.approve',
  'card.reject',
  'matter.handoff',
  'palette.handoff',
  'onboarding.finish',
  'cloud_login.send_code',
  'cloud_login.verify',
  'account.topup',
  'nav.settings',
  'shell.search',
  'role.reconfirm',
  'position.settings',
  'connection.go',
  'shopify.connect',
  'setup.connect_start',
  'update.check',
  'update.restart',
] as const
export type TelemetryButton = (typeof TELEMETRY_BUTTONS)[number]

export const TELEMETRY_OUTCOMES = ['success', 'failure', 'cancelled'] as const
/** 花费档（一次运行的 `cost_base`，单位见 `RunUsage`）。具体数字不出门，只出档。 */
export const TELEMETRY_COST_TIERS = ['none', 'low', 'mid', 'high', 'top'] as const
/** 缓存命中率档（`cached_tokens / input_tokens`）。 */
export const TELEMETRY_CACHE_TIERS = ['none', 'low', 'mid', 'high'] as const
export const TELEMETRY_DECISIONS = ['approve', 'edit', 'reject', 'other'] as const
export const TELEMETRY_ERROR_KINDS = ['boundary', 'panel', 'error', 'rejection', 'preload'] as const
/** WP477：autocapture 只开这三种 DOM 事件（posthog-js 的 `dom_event_allowlist`）。 */
export const TELEMETRY_AUTOCAPTURE_EVENTS = ['click', 'change', 'submit'] as const
/** WP477：autocapture 记的元素标签（只是标签名；不在表里的不带）。 */
export const TELEMETRY_AUTOCAPTURE_TAGS = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'form',
  'option',
  'summary',
  'details',
  'li',
  'tr',
  'td',
  'div',
  'span',
  'p',
  'img',
  'svg',
  'section',
  'article',
  'nav',
  'header',
  'footer',
  'aside',
  'main',
  'h1',
  'h2',
  'h3',
  'h4',
] as const

let testidStatics: ReadonlySet<string> | undefined
let testidPatterns: readonly { template: string; re: RegExp }[] | undefined

/**
 * WP477（决策 1617 / 1618）：一个元素的 `data-testid` → 能出门的样子。
 * 源码里写死的原样给；套得上带变量模板的给模板本身（`brand-row-:x`，变量那段永远不出门）；都不是 → `undefined`（整条不发）。
 */
export function telemetryTestidOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '' || raw.length > 200) return undefined
  testidStatics ??= new Set(TELEMETRY_TESTIDS)
  if (testidStatics.has(raw)) return raw
  testidPatterns ??= TELEMETRY_TESTID_TEMPLATES.map((template) => ({
    template,
    re: new RegExp(
      `^${template
        .split(':x')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.+?')}$`,
      's',
    ),
  }))
  // 模板本身（`brand-row-:x`）也认：服务进程那一关收到的就是它
  if (TELEMETRY_TESTID_TEMPLATES.includes(raw)) return raw
  for (const { template, re } of testidPatterns) if (re.test(raw)) return template
  return undefined
}

/**
 * 事件清单：事件名 → 它自己能带的属性。改这张表就要改 `docs/telemetry-events.md` 和
 * `packages/contracts/test/telemetry.test.ts` 里钉的那份快照。
 */
export const TELEMETRY_EVENTS = {
  /**
   * 页面访问（只带路由模板）。WP477：岗位 / 职责 / 事项 / 卡片页另带这一页是哪个**内置**岗位模板、哪条**内置**职责
   * （本机服务转发前再核一遍：不在内置目录里的一律 `custom`；岗位名永远不带）。
   */
  $pageview: {
    route: { kind: 'route' },
    position_template: { kind: 'code' },
    role_id: { kind: 'code' },
  },
  /** 打开一次工作台（日活的口径之一）。 */
  app_opened: {},
  /**
   * WP477（按岗位 / 职责看体验）：离开一页时记一条——这一页看了多少秒（封顶 1800，挂着不动不算进来太多）。
   * 岗位 / 职责是**打开那一刻**那一页的。
   */
  page_left: {
    route: { kind: 'route' },
    position_template: { kind: 'code' },
    role_id: { kind: 'code' },
    seconds: { kind: 'int', max: 1800 },
  },
  /** 关键按钮点击（固定编号）。 */
  ui_click: {
    button_id: { kind: 'enum', values: TELEMETRY_BUTTONS },
    route: { kind: 'route' },
    // WP477：在哪个内置岗位 / 职责的页面上点的；点在一张卡上时 `role_id` 是那张卡的职责
    position_template: { kind: 'code' },
    role_id: { kind: 'code' },
  },
  /** 前端报错（只有错误类名与在哪一层接住的，不带报错文字）。 */
  client_error: {
    error_kind: { kind: 'enum', values: TELEMETRY_ERROR_KINDS },
    error_name: { kind: 'error_name' },
    scope: { kind: 'code' },
    route: { kind: 'route' },
  },
  /** 一次 AI 运行收尾（服务进程发）：成没成、花费档、缓存命中档、哪条内置职责 / 岗位、失败码。 */
  task_finished: {
    outcome: { kind: 'enum', values: TELEMETRY_OUTCOMES },
    cost_tier: { kind: 'enum', values: TELEMETRY_COST_TIERS },
    cache_tier: { kind: 'enum', values: TELEMETRY_CACHE_TIERS },
    role_id: { kind: 'code' },
    position_id: { kind: 'code' },
    error_code: { kind: 'code' },
    runtime: { kind: 'code' },
  },
  /**
   * WP477（决策 1617 / 1618）：posthog-js 的 autocapture。文字与属性在 SDK 里就全遮了（`mask_all_text`、
   * `mask_all_element_attributes`）；这里再只留四样：哪种 DOM 事件、元素的 testid（只许源码里写死的 / 模板）、
   * 标签名、路由模板。`$el_text`、`$elements`、`$elements_chain`、`$external_click_url`、`attr__*` 一律丢。
   */
  $autocapture: {
    $event_type: { kind: 'enum', values: TELEMETRY_AUTOCAPTURE_EVENTS },
    testid: { kind: 'testid' },
    tag: { kind: 'enum', values: TELEMETRY_AUTOCAPTURE_TAGS },
    route: { kind: 'route' },
    position_template: { kind: 'code' },
    role_id: { kind: 'code' },
  },
  /** 一张卡被人定了（服务进程发）：通过 / 改了再过 / 驳回 / 别的，卡的类型。 */
  card_decided: {
    decision: { kind: 'enum', values: TELEMETRY_DECISIONS },
    card_kind: { kind: 'code' },
    /** WP477：卡挂在哪条内置职责上（用户自建的记 `custom`）。 */
    role_id: { kind: 'code' },
  },
} as const satisfies Record<string, Record<string, TelemetryRule>>

export type TelemetryEventName = keyof typeof TELEMETRY_EVENTS

export const TELEMETRY_MARKET_REGIONS = ['CN'] as const
export type TelemetryMarketRegion = (typeof TELEMETRY_MARKET_REGIONS)[number]

/**
 * 决策 1600：界面语言 → `market_region`。中文（`zh`、`zh-CN`、`zh-Hans`…）→ `'CN'`；别的 → `undefined`（不带，
 * 让 PostHog 按 IP 定地区）。工作台注册公共属性、服务进程发自己的事件，都用这一处。
 */
export function telemetryMarketRegion(lang: string | undefined): TelemetryMarketRegion | undefined {
  return lang !== undefined && /^zh(?:[-_]|$)/i.test(lang) ? 'CN' : undefined
}

/** 每个事件都能带的公共属性（工作台注册成 super property；服务进程每条都带）。 */
export const TELEMETRY_COMMON_PROPS = {
  app_version: { kind: 'version' },
  shell: { kind: 'enum', values: ['desktop', 'web', 'server'] },
  lang: { kind: 'enum', values: ['zh', 'en'] },
  /**
   * 决策 1600：界面是中文（`zh*`）就当中国用户，带 `market_region: 'CN'`，以它为准；
   * 不是中文就**不带**，地区交给 PostHog 按 IP 算（PostHog 里开着 Discard client IP data）。只有 `CN` 一个值。
   */
  market_region: { kind: 'enum', values: TELEMETRY_MARKET_REGIONS },
  mode: { kind: 'enum', values: ['solo', 'peers', 'company'] },
  /** 这台机器上工坊的匿名设备号（服务进程生成，与任何账号无关）。 */
  install_id: { kind: 'opaque_id' },
  /** 关联了云账号时的账号 id（不传邮箱）。 */
  account_id: { kind: 'opaque_id' },
} as const satisfies Record<string, TelemetryRule>

/**
 * posthog-js 自己加的那些 `$` 属性里**留下的**几样（设备 / 浏览器大类、屏幕尺寸、会话号）。
 * 不在这里的一律丢：`$current_url`、`$referrer`、`$host`、`$raw_user_agent`、`$initial_*`……
 * `$current_url` / `$pathname` 由工作台先换成路由模板再过这一关（见 `sanitizeTelemetryEvent` 的 `route`）。
 */
export const TELEMETRY_SDK_PROPS = {
  token: { kind: 'opaque_id' },
  distinct_id: { kind: 'opaque_id' },
  $device_id: { kind: 'opaque_id' },
  $session_id: { kind: 'opaque_id' },
  $window_id: { kind: 'opaque_id' },
  $insert_id: { kind: 'opaque_id' },
  $pageview_id: { kind: 'opaque_id' },
  $lib: { kind: 'code' },
  $lib_version: { kind: 'version' },
  $os: { kind: 'enum', values: ['Mac OS X', 'Windows', 'Linux', 'iOS', 'Android', 'Chrome OS'] },
  $browser: {
    kind: 'enum',
    values: ['Chrome', 'Safari', 'Firefox', 'Microsoft Edge', 'Opera', 'Electron', 'Mobile Safari'],
  },
  $device_type: { kind: 'enum', values: ['Desktop', 'Mobile', 'Tablet'] },
  $screen_height: { kind: 'int', max: 20000 },
  $screen_width: { kind: 'int', max: 20000 },
  $viewport_height: { kind: 'int', max: 20000 },
  $viewport_width: { kind: 'int', max: 20000 },
  $process_person_profile: { kind: 'bool' },
  $is_identified: { kind: 'bool' },
  $current_url: { kind: 'route' },
  $pathname: { kind: 'route' },
} as const satisfies Record<string, TelemetryRule>

/** 录屏回放（默认关）开着时，`$snapshot` 事件只许带这几样；画面本身在 SDK 里已强制遮住全部文字与输入。 */
export const TELEMETRY_REPLAY_PROPS = [
  '$snapshot_data',
  '$snapshot_bytes',
  '$session_id',
  '$window_id',
  '$lib',
] as const

export type TelemetryProps = Record<string, string | number | boolean>

const COMMON: Readonly<Record<string, TelemetryRule>> = TELEMETRY_COMMON_PROPS
const SDK: Readonly<Record<string, TelemetryRule>> = TELEMETRY_SDK_PROPS

export interface SanitizeOptions {
  /** 录屏回放开着才放 `$snapshot` 过去。 */
  replay?: boolean
}

/**
 * 一条事件出门前的最后一关：事件名不在清单 → `null`；属性只留白名单里、值过得了规则的。
 * 被丢掉的属性不报错（SDK 会不停加新的 `$` 属性，丢掉就是默认）。
 */
export function sanitizeTelemetryProps(
  event: string,
  props: Readonly<Record<string, unknown>>,
  options: SanitizeOptions = {},
): Record<string, unknown> | null {
  if (event === '$snapshot') {
    if (options.replay !== true) return null
    const out: Record<string, unknown> = {}
    for (const key of TELEMETRY_REPLAY_PROPS) if (key in props) out[key] = props[key]
    for (const [key, rule] of Object.entries(SDK))
      if (key in props && passesRule(rule, props[key])) out[key] = props[key]
    return out
  }
  if (!Object.hasOwn(TELEMETRY_EVENTS, event)) return null
  const own = TELEMETRY_EVENTS[event as TelemetryEventName] as Record<string, TelemetryRule>
  const out: TelemetryProps = {}
  for (const [key, value] of Object.entries(props)) {
    const rule = own[key] ?? COMMON[key] ?? SDK[key]
    if (rule !== undefined && passesRule(rule, value)) out[key] = value as string | number | boolean
  }
  // WP477：认不出是哪个元素的 autocapture（没有 testid / testid 不在表里）整条不要
  if (event === '$autocapture' && out.testid === undefined) return null
  return out
}

/** 一次运行的花费 → 档（`cost_base` 与价目同一单位；分档线粗一点，只看分布）。 */
export function telemetryCostTier(cost_base: number): (typeof TELEMETRY_COST_TIERS)[number] {
  if (!Number.isFinite(cost_base) || cost_base <= 0) return 'none'
  if (cost_base < 0.01) return 'low'
  if (cost_base < 0.1) return 'mid'
  if (cost_base < 1) return 'high'
  return 'top'
}

/** 缓存命中 → 档（没有输入 token 的算 `none`）。 */
export function telemetryCacheTier(
  cached_tokens: number,
  input_tokens: number,
): (typeof TELEMETRY_CACHE_TIERS)[number] {
  if (!(input_tokens > 0) || !(cached_tokens > 0)) return 'none'
  const rate = cached_tokens / input_tokens
  if (rate < 0.3) return 'low'
  if (rate < 0.7) return 'mid'
  return 'high'
}

/* ───────────────────────── WP477（决策 1609）：软件的几件关键事 → GA4 ───────────────────────── */

/**
 * 官网与软件共用的那个 GA4 媒体资源的衡量 ID（官网页面里本来就公开写着）。云上转发 Worker 的配置里也写一份。
 */
export const GA4_MEASUREMENT_ID = 'G-P4LBL51H3P'

/** 本机服务把关键事交给上报地址的那条路（`<上报地址>/mp/collect`，云上 Worker 再转 Measurement Protocol）。 */
export const GA4_RELAY_PATH = '/mp/collect'

/**
 * 软件只往 GA4 报这四件事（决策 1609），名字按 GA4 规范：
 *
 * - `app_first_open`：第一次打开工作台（`first_open` 是 GA4 保留名，Measurement Protocol 不收，所以加了 `app_` 前缀）；
 * - `setup_complete`：首次设置向导走完（建好了岗位）；
 * - `first_task`：第一次有一次 AI 任务跑成；
 * - `daily_active`：每天第一次打开工作台（按这台电脑的本地日期）。
 *
 * 前三件每台电脑只发一次，`daily_active` 一天一次。加一件 = 在这里加一行 + 文档加一行 + 云上 Worker 的白名单加一行。
 */
export const GA4_APP_EVENTS = [
  'app_first_open',
  'setup_complete',
  'first_task',
  'daily_active',
] as const
export type Ga4AppEvent = (typeof GA4_APP_EVENTS)[number]

/**
 * 每件事能带的参数（全部是代码里的标识，没有业务内容）：
 * - `app_version`：版本号；
 * - `market_region`：界面是中文就带 `CN`（决策 1600），不是中文不带；
 * - `session_id`：这次进程起来的时间（秒），GA4 要它才把事件算进会话 / 实时；
 * - `engagement_time_msec`：固定 1（同上，GA4 要它才算「活跃」）。
 */
export const GA4_APP_PARAMS = {
  app_version: { kind: 'version' },
  market_region: { kind: 'enum', values: TELEMETRY_MARKET_REGIONS },
  session_id: { kind: 'int', max: 9_999_999_999 },
  engagement_time_msec: { kind: 'int', max: 60_000 },
} as const satisfies Record<string, TelemetryRule>

/** 本机服务 POST 到 `<上报地址>/mp/collect` 的请求体（Worker 再拼成 Measurement Protocol 的样子）。 */
export interface Ga4RelayBody {
  /** GA4 的 `client_id`：就是匿名设备号 `install_id`。 */
  client_id: string
  events: { name: Ga4AppEvent; params: Record<string, string | number> }[]
}

/** 一件关键事出门前的最后一关：名字不在四件里 → `null`；参数只留白名单里、值过得了规则的。 */
export function sanitizeGa4Event(
  name: string,
  params: Readonly<Record<string, unknown>>,
): { name: Ga4AppEvent; params: Record<string, string | number> } | null {
  if (!(GA4_APP_EVENTS as readonly string[]).includes(name)) return null
  const rules: Readonly<Record<string, TelemetryRule>> = GA4_APP_PARAMS
  const out: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(params)) {
    const rule = rules[key]
    if (rule !== undefined && passesRule(rule, value)) out[key] = value as string | number
  }
  return { name: name as Ga4AppEvent, params: out }
}

/**
 * WP477：内置目录之外的岗位 / 职责一律记成这个（名字里可能有品牌或商品，id 也可能是从名字算出来的）。
 */
export const TELEMETRY_CUSTOM = 'custom'

/** WP477：工作台这一侧先把不像编号的岗位 / 职责 id 换成 `custom`（本机服务再按内置目录核一遍）。 */
export function telemetrySafeId(id: unknown): string | undefined {
  if (id === undefined || id === null || id === '') return undefined
  return passesRule({ kind: 'code' }, id) ? (id as string) : TELEMETRY_CUSTOM
}
