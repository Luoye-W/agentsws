/**
 * WP476（决策 1590）：工作台这一侧的匿名使用数据（posthog-js）。
 *
 * **没配置就不加载**：SDK 是按需 `import()` 的单独一块，只有本机服务说「真的会发」（`active`：开着 + 安装包给了
 * 上报地址 + 云上给了 key）时才拉进来；开发、测试、自建、用户关了开关，这一块一个字节都不加载，`track()` 是空操作。
 *
 * 加载了也只发清单里的、只跟本机说话：
 * - `api_host` 是本机的 `/v1/telemetry`（同源）：浏览器一个外网请求都不发，桌面壳的 CSP 不用放宽；本机服务再过一遍
 *   白名单才转出去；
 * - 关掉 autocapture / 自动页面访问 / 离开页面 / 热力图 / 死点击 / 性能 / 报错自动抓 / 问卷 / 产品导览；
 *   不拉任何外部脚本（`module.no-external`）；不要远程配置（除非开了录屏）；
 * - **浏览器里什么都不存**（`persistence: 'memory'`）：匿名号直接用本机服务的匿名设备号（`install_id`），
 *   与服务端记的任务 / 卡片是同一个号；
 * - 每条出门前过 `before_send`：先把 `$current_url` / `$pathname` 换成路由模板，再过 `@agentsws/contracts` 的白名单；
 *   `$set` / `$set_once`（SDK 想记的首次来源网址、引荐页）整段丢掉；
 * - 录屏回放默认关；云上开了才开，开了也强制遮住**全部**文字与输入、挡掉图片与画布、不录网络与控制台。
 */
import {
  sanitizeTelemetryProps,
  type TelemetryEventName,
  type TelemetryView,
} from '@agentsws/contracts'
import type { CaptureResult, PostHog, PostHogConfig } from 'posthog-js/dist/module.no-external'
import { routeTemplate } from './routes'

type Client = NonNullable<TelemetryView['client']>
type PostHogModule = typeof import('posthog-js/dist/module.no-external')

/** 公共属性（注册成 super property，每条都带）。 */
export interface TelemetrySuper {
  app_version?: string
  shell: 'desktop' | 'web'
  lang: 'zh' | 'en'
  mode?: 'solo' | 'peers' | 'company'
  install_id: string
  account_id?: string
}

const PENDING_MAX = 50

let ph: PostHog | undefined
/** `undefined` = 还不知道（先攒着）；`false` = 不发（攒的扔掉、之后不攒）；`true` = 在发。 */
let state: boolean | undefined
let pending: [TelemetryEventName, Record<string, unknown>][] = []
let starting: Promise<void> | undefined

function currentRoute(): string {
  try {
    const loc = globalThis.location
    return loc === undefined
      ? '/'
      : routeTemplate({ pathname: loc.pathname, search: loc.search, hash: loc.hash })
  } catch {
    return '/'
  }
}

/** 出门前最后一关（posthog-js 的 `before_send`）。导出给测试。 */
export function beforeSend(
  cr: CaptureResult | null,
  opts: { replay: boolean },
): CaptureResult | null {
  // 关了之后 SDK 手上还有的（比如关掉那一刻正在排队的）一条都不放
  if (cr === null || state === false) return null
  const route = currentRoute()
  const props = {
    ...(cr.properties as Record<string, unknown>),
    $current_url: route,
    $pathname: route,
  }
  const clean = sanitizeTelemetryProps(cr.event, props, { replay: opts.replay })
  if (clean === null) return null
  // `$set` / `$set_once` / `$unset`（首次来源网址、引荐页这类人物属性）整段不要
  return {
    uuid: cr.uuid,
    event: cr.event,
    properties: clean,
    ...(cr.timestamp === undefined ? {} : { timestamp: cr.timestamp }),
  } as CaptureResult
}

/** 给 posthog-js 的初始化参数。导出给测试钉住每一个开关。 */
export function posthogConfig(client: Client, sup: TelemetrySuper): Partial<PostHogConfig> {
  return {
    // 同源的本机转发（`/v1/telemetry`）；外网那一跳在本机服务里
    api_host: client.api_host,
    ui_host: null,
    // 浏览器里什么都不存；匿名号就是这台机器的匿名设备号
    persistence: 'memory',
    disable_persistence: true,
    bootstrap: { distinctID: sup.install_id, isIdentifiedID: false },
    person_profiles: 'identified_only',
    // 只发我们手写的那几样
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    rageclick: false,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    capture_performance: false,
    capture_exceptions: false,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    disable_scroll_properties: true,
    save_referrer: false,
    mask_all_text: true,
    mask_all_element_attributes: true,
    // 请求体就是 JSON：本机服务好解、好再查一遍
    disable_compression: true,
    // 不从 CDN 拉脚本；不要远程配置 / 功能开关（只有开了录屏才要：录屏等远程配置说「开」才启动）
    disable_external_dependency_loading: true,
    advanced_disable_flags: !client.replay,
    // 录屏回放：默认关；开了也遮住全部文字与输入、挡掉图片 / 视频 / 画布 / 内嵌页
    disable_session_recording: !client.replay,
    enable_recording_console_log: false,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*',
      maskAllElementAttributes: true,
      blockSelector: 'img, video, canvas, iframe, picture, svg image',
      recordHeaders: false,
      recordBody: false,
      captureJsonLd: false,
    },
    before_send: (cr) => beforeSend(cr, { replay: client.replay }),
    loaded: (instance) => {
      instance.register(superProps(sup))
    },
  }
}

function superProps(sup: TelemetrySuper): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sup).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  )
}

/**
 * 本机服务回的那一份 → 加载 / 不加载。不 `active` 就扔掉攒着的、之后不攒、SDK 手上的也不放。
 * 测试传 `load` 换掉真 SDK。
 */
export async function applyTelemetry(
  view: TelemetryView | undefined,
  sup: Omit<TelemetrySuper, 'install_id' | 'account_id'>,
  load: () => Promise<PostHogModule> = () => import('posthog-js/dist/module.no-external'),
): Promise<void> {
  const client = view?.active === true ? view.client : undefined
  if (view === undefined || client === undefined) {
    stopTelemetry()
    return
  }
  const full: TelemetrySuper = {
    ...sup,
    install_id: view.install_id,
    ...(view.account_id === undefined ? {} : { account_id: view.account_id }),
  }
  if (ph !== undefined) {
    // 已经加载过（可能中途关过又开了）：接着发，更新公共属性（换了语言 / 关联了账号）
    state = true
    ph.register(superProps(full))
    return
  }
  starting ??= (async () => {
    try {
      const mod = await load()
      if (client.replay) await import('posthog-js/dist/posthog-recorder')
      const instance = mod.posthog
      state = true
      instance.init(client.key, posthogConfig(client, full))
      ph = instance
      const queued = pending
      pending = []
      for (const [event, props] of queued) instance.capture(event, props)
    } catch {
      stopTelemetry()
    } finally {
      starting = undefined
    }
  })()
  await starting
}

/** 关掉：攒的扔掉、之后 `track` 空操作；SDK 手上还没发的由 `before_send` 一条条挡掉。 */
export function stopTelemetry(): void {
  state = false
  pending = []
}

/** 记一条（清单里的事件）。没配置 / 关了就是空操作；还不知道配不配时先攒一小批。 */
export function track(event: TelemetryEventName, props: Record<string, unknown> = {}): void {
  try {
    if (state === false) return
    const withRoute = event === 'app_opened' ? props : { route: currentRoute(), ...props }
    if (ph === undefined) {
      if (pending.length < PENDING_MAX) pending.push([event, withRoute])
      return
    }
    ph.capture(event, withRoute)
  } catch {
    // 记数据这件事绝不能把页面带坏
  }
}

/** 测试用：回到「还不知道」。 */
export function _resetTelemetry(): void {
  ph = undefined
  state = undefined
  pending = []
  starting = undefined
}
