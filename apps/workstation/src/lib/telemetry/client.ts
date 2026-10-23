/**
 * WP476（决策 1590）：工作台这一侧的匿名使用数据（posthog-js）。
 *
 * **没配置就不加载**：SDK 是按需 `import()` 的单独一块，只有本机服务说「真的会发」（`active`：开着 + 安装包给了
 * 上报地址 + 云上给了 key）时才拉进来；开发、测试、自建、用户关了开关，这一块一个字节都不加载，`track()` 是空操作。
 *
 * 加载了也只发清单里的、只跟本机说话：
 * - `api_host` 是本机的 `/v1/telemetry`（同源）：浏览器一个外网请求都不发，桌面壳的 CSP 不用放宽；本机服务再过一遍
 *   白名单才转出去；
 * - 关掉自动页面访问 / 离开页面 / 热力图 / 死点击 / 连点 / 性能 / 报错自动抓 / 问卷 / 产品导览；
 * - **autocapture 开着但全遮**（WP477，决策 1617 / 1618）：SDK 里 `mask_all_text` + `mask_all_element_attributes`，
 *   元素的字和属性一样都不采；出门前只补上「点的是哪个 testid」（只认源码里写死的，带变量的只给模板）、标签名、路由模板，
 *   `$elements` / `$elements_chain` / `$el_text` 这些整格丢。认不出 testid 的整条不发；
 *   不拉任何外部脚本（`module.no-external`）；不要远程配置（除非开了录屏）；
 * - **浏览器里什么都不存**（`persistence: 'memory'`）：匿名号直接用本机服务的匿名设备号（`install_id`），
 *   与服务端记的任务 / 卡片是同一个号；
 * - 每条出门前过 `before_send`：先把 `$current_url` / `$pathname` 换成路由模板，再过 `@agentsws/contracts` 的白名单；
 *   `$set` / `$set_once`（SDK 想记的首次来源网址、引荐页）整段丢掉；
 * - 录屏回放默认关；云上开了才开，开了也强制遮住**全部**文字与输入、挡掉图片与画布、不录网络与控制台。
 */
import {
  sanitizeTelemetryProps,
  TELEMETRY_AUTOCAPTURE_EVENTS,
  TELEMETRY_AUTOCAPTURE_TAGS,
  type TelemetryEventName,
  type TelemetryMarketRegion,
  type TelemetryView,
  telemetryMarketRegion,
  telemetrySafeId,
  telemetryTestidOf,
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
  /** 决策 1600：界面中文 → `CN`（以它为准）；不是中文不带，地区交给 PostHog 按 IP 算。由 `lang` 推出，不用传。 */
  market_region?: TelemetryMarketRegion
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

/**
 * WP477（Luoye 10-23：按岗位 / 职责看体验）：这一页是哪个**内置**岗位模板、哪条**内置**职责。
 * 页面拿到数据后用 `useTelemetryContext` 报上来，按**具体地址**记（同一个模板下换了一个岗位不串）；
 * 页面访问、按钮、autocapture 在这一页上都带上它。岗位名永远不带——只带 id，不像编号的换成 `custom`，
 * 本机服务再按内置目录核一遍（不在目录里的也是 `custom`）。
 */
export interface TelemetryPageContext {
  position_template?: string | undefined
  role_id?: string | undefined
}
let pageContext: { path: string; ctx: TelemetryPageContext } | undefined
const contextWaiters = new Set<(path: string) => void>()

function currentPath(): string {
  try {
    return globalThis.location?.pathname ?? '/'
  } catch {
    return '/'
  }
}

/** 页面报上它的岗位 / 职责（`undefined` = 撤掉）。 */
export function setTelemetryContext(path: string, ctx: TelemetryPageContext | undefined): void {
  if (ctx === undefined) {
    if (pageContext?.path === path) pageContext = undefined
    return
  }
  const clean: { position_template?: string; role_id?: string } = {}
  const position = telemetrySafeId(ctx.position_template)
  const role = telemetrySafeId(ctx.role_id)
  if (position !== undefined) clean.position_template = position
  if (role !== undefined) clean.role_id = role
  pageContext = { path, ctx: clean }
  for (const fn of [...contextWaiters]) fn(path)
}

/** 等某个地址的岗位 / 职责报上来（页面访问要等它再记）。返回取消函数。 */
export function onTelemetryContext(fn: (path: string) => void): () => void {
  contextWaiters.add(fn)
  return () => {
    contextWaiters.delete(fn)
  }
}

/** 当前这一页的岗位 / 职责（地址对得上才给）。 */
export function telemetryContextFor(path: string = currentPath()): TelemetryPageContext {
  return pageContext?.path === path ? pageContext.ctx : {}
}

/** 点在一张卡（或卡片那一行）里：那张卡挂在哪条职责上（卡片容器上的 `data-track-role`）。 */
export function cardRoleOf(target: EventTarget | null | undefined): { role_id?: string } {
  if (target === null || target === undefined || typeof (target as Element).closest !== 'function')
    return {}
  const role = telemetrySafeId(
    (target as Element).closest('[data-track-role]')?.getAttribute('data-track-role'),
  )
  return role === undefined ? {} : { role_id: role }
}

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

/**
 * WP477：autocapture 那一下点的是哪个元素。SDK 把属性全遮了（连 `data-testid` 也不采），所以我们自己在
 * document 上先挂一个捕获阶段的监听（比 SDK 的早挂，同一次事件里先跑），记下目标；`before_send` 再从它找 testid。
 */
let lastTarget: { el: Element; at: number } | undefined
const TARGET_TTL_MS = 1000
const CLICKABLE =
  'button, a, input, select, textarea, label, summary, [role="button"], [role="menuitem"], [role="switch"], [role="tab"], [role="option"], [role="checkbox"], [role="link"]'
let listening = false

function rememberTarget(e: Event): void {
  const t = e.target
  if (t !== null && typeof (t as Element).closest === 'function')
    lastTarget = { el: t as Element, at: Date.now() }
}

/** 导出给测试（真 SDK 那条用例自己 init，不走 `applyTelemetry`）。 */
export function listenForTargets(): void {
  if (listening || typeof document === 'undefined') return
  listening = true
  for (const type of TELEMETRY_AUTOCAPTURE_EVENTS)
    document.addEventListener(type, rememberTarget, { capture: true })
}

const TAGS: ReadonlySet<string> = new Set(TELEMETRY_AUTOCAPTURE_TAGS)

/** 刚才那一下：离它最近的 testid（只认表里的 / 模板）和标签名。认不出就 `undefined`。导出给测试。 */
export function autocaptureTarget(
  el: Element | undefined,
): { testid: string; tag?: string } | undefined {
  if (el === undefined) return undefined
  const host = el.closest('[data-testid]')
  const testid = telemetryTestidOf(host?.getAttribute('data-testid'))
  if (testid === undefined) return undefined
  const tag = (el.closest(CLICKABLE) ?? host ?? el).tagName.toLowerCase()
  return { testid, ...(TAGS.has(tag) ? { tag } : {}) }
}

/** 出门前最后一关（posthog-js 的 `before_send`）。导出给测试。 */
export function beforeSend(
  cr: CaptureResult | null,
  opts: { replay: boolean },
): CaptureResult | null {
  // 关了之后 SDK 手上还有的（比如关掉那一刻正在排队的）一条都不放
  if (cr === null || state === false) return null
  const route = currentRoute()
  let picked: Record<string, unknown> = {}
  if (cr.event === '$autocapture') {
    const recent =
      lastTarget !== undefined && Date.now() - lastTarget.at < TARGET_TTL_MS
        ? lastTarget.el
        : undefined
    const target = autocaptureTarget(recent)
    if (target === undefined) return null
    picked = { ...target, route, ...telemetryContextFor(), ...cardRoleOf(recent) }
  }
  const props = {
    ...(cr.properties as Record<string, unknown>),
    // SDK 自己可能带同名的格子：一律以我们算的为准
    testid: undefined,
    tag: undefined,
    ...(cr.event === '$autocapture' ? { position_template: undefined, role_id: undefined } : {}),
    ...picked,
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
    // WP477（决策 1617 / 1618）：autocapture 开着，只记点 / 改 / 提交，不记复制；字和属性全遮（下面两格），
    // 出门前 `beforeSend` 只补 testid / 标签 / 路由模板
    autocapture: {
      dom_event_allowlist: [...TELEMETRY_AUTOCAPTURE_EVENTS],
      capture_copied_text: false,
    },
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
  sup: Omit<TelemetrySuper, 'install_id' | 'account_id' | 'market_region'>,
  load: () => Promise<PostHogModule> = () => import('posthog-js/dist/module.no-external'),
): Promise<void> {
  const client = view?.active === true ? view.client : undefined
  if (view === undefined || client === undefined) {
    stopTelemetry()
    return
  }
  const region = telemetryMarketRegion(sup.lang)
  const full: TelemetrySuper = {
    ...sup,
    ...(region === undefined ? {} : { market_region: region }),
    install_id: view.install_id,
    ...(view.account_id === undefined ? {} : { account_id: view.account_id }),
  }
  if (ph !== undefined) {
    // 已经加载过（可能中途关过又开了）：接着发，更新公共属性（换了语言 / 关联了账号）
    state = true
    ph.register(superProps(full))
    // 中文换成别的语言：之前注册的 market_region 要拿掉（register 只加不减）
    if (region === undefined) ph.unregister('market_region')
    return
  }
  starting ??= (async () => {
    try {
      const mod = await load()
      if (client.replay) await import('posthog-js/dist/posthog-recorder')
      const instance = mod.posthog
      // 先于 SDK 挂上：同一次点击里我们先记下目标，SDK 的 autocapture 后到
      listenForTargets()
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
    const withRoute =
      event === 'app_opened' ? props : { route: currentRoute(), ...telemetryContextFor(), ...props }
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
  lastTarget = undefined
  pageContext = undefined
  contextWaiters.clear()
  ph = undefined
  state = undefined
  pending = []
  starting = undefined
}
