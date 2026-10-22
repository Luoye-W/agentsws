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

/**
 * 事件清单：事件名 → 它自己能带的属性。改这张表就要改 `docs/telemetry-events.md` 和
 * `packages/contracts/test/telemetry.test.ts` 里钉的那份快照。
 */
export const TELEMETRY_EVENTS = {
  /** 页面访问（只带路由模板）。 */
  $pageview: { route: { kind: 'route' } },
  /** 打开一次工作台（日活的口径之一）。 */
  app_opened: {},
  /** 关键按钮点击（固定编号）。 */
  ui_click: { button_id: { kind: 'enum', values: TELEMETRY_BUTTONS }, route: { kind: 'route' } },
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
  /** 一张卡被人定了（服务进程发）：通过 / 改了再过 / 驳回 / 别的，卡的类型。 */
  card_decided: {
    decision: { kind: 'enum', values: TELEMETRY_DECISIONS },
    card_kind: { kind: 'code' },
  },
} as const satisfies Record<string, Record<string, TelemetryRule>>

export type TelemetryEventName = keyof typeof TELEMETRY_EVENTS

/** 每个事件都能带的公共属性（工作台注册成 super property；服务进程每条都带）。 */
export const TELEMETRY_COMMON_PROPS = {
  app_version: { kind: 'version' },
  shell: { kind: 'enum', values: ['desktop', 'web', 'server'] },
  lang: { kind: 'enum', values: ['zh', 'en'] },
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
