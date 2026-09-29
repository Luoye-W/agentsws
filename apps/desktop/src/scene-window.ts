/**
 * WP184（docs/79 §3.1）：官方场景在我们自己的窗口里打开——判断都在这里（不 import electron）。
 *
 * 移植自官方桌面端（MIT，`deepseek-ai/deepseek-harness@4878cdabd87d4041bdaff61d04c966883b9fd07a`）：
 * - `apps/desktop/src/web-document.ts` 的 `authenticateWebHost`：主进程拿带一次性 token 的网址换一枚
 *   Host 发的 cookie（303 + set-cookie），**cookie 留在主进程**，页面的 cookie 罐里没有它
 *   （同文件 `WITHHELD_RESPONSE_HEADERS` 里的 `set-cookie`）；
 * - `apps/desktop/src/main.ts` 里 `ws://127.0.0.1/*` 的 `onBeforeSendHeaders`：凭据**只附给归属窗口**
 *   （`webContentsId` 对得上、主机对得上），来源不对的 WebSocket 直接拒；
 * - `apps/desktop/src/microphone-permissions.ts`：麦克风只给归属窗口的主 frame、只要音频，
 *   macOS 再问一次系统；
 * - `apps/desktop/src/directory-picker.ts`：原生目录选择只接归属窗口主 frame 发来的请求；
 * - `apps/desktop/src/main.ts` 的 DevTools 菜单项：`toggleDevTools` 的默认快捷键 + F12。
 *
 * 改动：官方用自定义协议 `dsh-app://app` 伺候页面、由壳转发每一个请求；我们起的是标准的
 * `dsh --profile web`（它自己伺候页面），所以窗口直接加载 `http://127.0.0.1:<端口>/`，
 * 凭据在请求发出前由壳补上——效果同一条：token 不进网址、不进渲染进程，cookie 只跟着这个窗口走。
 */

/** 所有官方场景窗口共用的会话分区（与工作台的 defaultSession 分开：CSP、权限、cookie 都不串）。 */
export const SCENE_PARTITION = 'persist:agentsws-dsh-scenes'

/** 主进程里用得着的那一点 fetch（全局 `fetch` 就满足）。 */
export type SceneAuthFetch = (
  url: string,
  init: { redirect: 'manual' },
) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  body?: { cancel(): Promise<void> } | null
}>

/**
 * 带 token 的启动网址 → Host 发的 cookie（`name=value`，不带属性）。
 * 移植自 `web-document.ts` 的 `authenticateWebHost`（只多了注入的 fetch）。
 */
export async function authenticateSceneHost(
  url: string,
  fetchImpl: SceneAuthFetch,
): Promise<string> {
  const response = await fetchImpl(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel().catch(() => undefined)
  if (response.status !== 303 || cookie === null) throw new Error('官方场景没认这个登录网址')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/**
 * 启动网址 → 窗口该加载的干净网址（不带 token）与它的源。只认 `http://127.0.0.1:<端口>`——
 * 服务进程只起回环上的场景，别的样子说明不对，宁可不开。
 */
export function sceneEntry(url: string): { origin: string; entry: string } | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '')
    return undefined
  return { origin: parsed.origin, entry: `${parsed.origin}/` }
}

/** 一个官方场景窗口：它是谁（`webContentsId`）、它的源、主进程替它拿着的那枚 cookie。 */
export interface SceneOwner {
  webContentsId: number
  origin: string
  cookie: string
}

export type SceneRequestDecision =
  | { action: 'pass' }
  | { action: 'cancel' }
  | { action: 'attach'; requestHeaders: Record<string, string> }

/**
 * 请求发出前：要不要替它补上凭据。
 *
 * - 不是官方场景窗口发的、或者发往别的主机：原样放行，**不补**任何凭据；
 * - 带了 `Origin` 而且不是这个场景的源：拒（官方同一条：来源不对的 WebSocket 不接）；
 * - 其余：去掉页面自己带的 cookie，换成主进程拿着的那一枚。
 */
export function sceneRequestHeaders(input: {
  url: string
  webContentsId: number | undefined
  requestHeaders: Readonly<Record<string, string>>
  owners: readonly SceneOwner[]
}): SceneRequestDecision {
  const owner = input.owners.find((o) => o.webContentsId === input.webContentsId)
  if (owner === undefined) return { action: 'pass' }
  let requested: URL
  try {
    requested = new URL(input.url)
  } catch {
    return { action: 'pass' }
  }
  if (requested.host !== new URL(owner.origin).host) return { action: 'pass' }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.requestHeaders))
    headers[name.toLowerCase()] = value
  const origin = headers.origin
  if (origin !== undefined && origin !== owner.origin) return { action: 'cancel' }
  headers.cookie = owner.cookie
  return { action: 'attach', requestHeaders: headers }
}

/** 响应头里去掉 `set-cookie`：Host 的 cookie 归壳拿着，不进页面的 cookie 罐。 */
export function withoutSetCookie(
  headers: Readonly<Record<string, string[] | string>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'set-cookie') continue
    out[name] = Array.isArray(value) ? [...value] : [value]
  }
  return out
}

// ── 权限（移植自 `microphone-permissions.ts`）────────────────────────────────

export type ScenePermissionDecision = 'allow' | 'deny' | 'ask-microphone'

/**
 * 官方场景窗口要一项权限时怎么答。
 *
 * - 不是官方场景窗口、或者不是这个场景的源：一律不给（工作台那边的 defaultSession 本来就全拒，
 *   这个分区里也只认官方场景自己）；
 * - 麦克风（`media`）：只给主 frame、只要音频；macOS 还要系统点头（`ask-microphone`）；
 * - 其他权限：照官方桌面端，留给 Electron 的默认（允许）。
 */
export function decideScenePermission(input: {
  permission: string
  owned: boolean
  isMainFrame: boolean
  requestingUrl: string
  sceneOrigin: string | undefined
  mediaTypes?: readonly string[]
  platform: string
}): ScenePermissionDecision {
  if (!input.owned || input.sceneOrigin === undefined) return 'deny'
  let origin: string
  try {
    origin = new URL(input.requestingUrl).origin
  } catch {
    return 'deny'
  }
  if (origin !== input.sceneOrigin) return 'deny'
  if (input.permission !== 'media') return 'allow'
  const audioOnly = input.mediaTypes?.length === 1 && input.mediaTypes[0] === 'audio'
  if (!input.isMainFrame || !audioOnly) return 'deny'
  return input.platform === 'darwin' ? 'ask-microphone' : 'allow'
}

// ── DevTools 快捷键（官方菜单：`toggleDevTools` 的默认键 + F12）─────────────────

export interface KeyInputLike {
  type: string
  key: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

/** macOS ⌥⌘I、其他系统 Ctrl+Shift+I，再加 F12。只认按下那一下。 */
export function isDevToolsShortcut(input: KeyInputLike, platform: string): boolean {
  if (input.type !== 'keyDown') return false
  if (input.key === 'F12') return true
  const i = input.key.toLowerCase() === 'i'
  if (platform === 'darwin') return i && input.meta && input.alt && !input.control
  return i && input.control && input.shift && !input.alt
}

// ── 原生目录选择（移植自 `directory-picker.ts` 的来源检查）──────────────────────

/**
 * 这次 IPC 是不是某个官方场景窗口的**主 frame**、在它自己的源上发的；是就回那个窗口。
 * 子 frame、别的窗口、页面跳到别处之后发的，一律不认。
 */
export function sceneSender(
  input: { webContentsId: number; isMainFrame: boolean; frameUrl: string },
  owners: readonly SceneOwner[],
): SceneOwner | undefined {
  if (!input.isMainFrame) return undefined
  const owner = owners.find((o) => o.webContentsId === input.webContentsId)
  if (owner === undefined) return undefined
  try {
    return new URL(input.frameUrl).origin === owner.origin ? owner : undefined
  } catch {
    return undefined
  }
}

/** 窗口标题：一眼看出这是 DeepSeek Harness，不是工坊。官方 `web` 场景挂「官方」，自建的挂名字。 */
export function sceneWindowTitle(name: string, language: string): string {
  const en = language === 'en-US'
  if (name === 'web') return en ? 'DeepSeek Harness (official)' : 'DeepSeek Harness（官方）'
  return `DeepSeek Harness · ${name}`
}
