/**
 * WP353：应用内搜索浏览器的 Electron 那一半（规则与通道在 `search-browser.ts`）。
 *
 * - 每个品牌一个**不挂到界面上**的 `WebContentsView`（持久 partition，见 `searchPartitionOf`），
 *   AI 的搜索 / 读正文都在它里面开，一次一页、排队；默认静默：不弹窗、不抢焦点。
 * - **不开 remote-debugging、不用 CDP**：结果用 `executeJavaScriptInIsolatedWorld` 跑只读 DOM 提取
 *   （隔离的脚本世界，页面自己的脚本改不了我们的函数）。
 * - 会话收紧：权限请求一律拒、下载一律取消、新窗口一律不开、静音。
 * - **要人介入**（Google 人机验证、网站要登录）时，另开一个同 partition 的「交给人」视图打开那一页，
 *   告诉工作台（第三栏「浏览器」亮出来）；人在那页上自己点。离开验证页就算过了，记下时刻、收起视图。
 *   AI 自己的那个视图照常干活，不碰这一页。
 */
import { type BrowserWindow, session as electronSession, WebContentsView } from 'electron'
import {
  AMAZON_URL_PATTERNS,
  cleanUserAgent,
  type OpenRequest,
  type OpenResult,
  type SearchBrowserDriver,
  type SearchBrowserStatus,
  searchPartitionOf,
  userAgentFor,
} from './search-browser.js'
import { extractData, extractReadable, extractSerp, pageScript } from './search-extract.js'

/** 交给人的那一页（第三栏亮出来的）。 */
export interface SearchHandover {
  workspace_id: string
  reason: 'captcha' | 'login'
  message: string
  url: string
}

export interface ElectronSearchBrowser extends SearchBrowserDriver {
  /** 现在有没有要人介入的那一页。 */
  pending(): SearchHandover | undefined
  /** 工作台第三栏给的位置（窗口内坐标）；`null` = 收起（不挂到界面上）。 */
  place(rect: { x: number; y: number; width: number; height: number } | null): void
  /** 人说「先不管了」：收起那一页（不算验证过）。 */
  dismiss(): void
  close(): void
}

/** 脚本跑在这个隔离世界里（页面自己的脚本看不见、改不了）。 */
const WORLD_ID = 1053

interface Slot {
  view: WebContentsView
  queue: Promise<unknown>
}

export function createElectronSearchBrowser(deps: {
  mainWindow(): BrowserWindow | undefined
  /** 交给人的那一页变了（亮出来 / 收起）——主进程转给工作台。 */
  onChange(handover: SearchHandover | undefined): void
  log(message: string, fields?: Record<string, unknown>): void
}): ElectronSearchBrowser {
  const slots = new Map<string, Slot>()
  const prepared = new Set<string>()
  const verified = new Map<string, number>()
  let handover: (SearchHandover & { view: WebContentsView }) | undefined
  let placed = false

  const sessionOf = (workspace_id: string): Electron.Session => {
    const partition = searchPartitionOf(workspace_id)
    const ses = electronSession.fromPartition(partition)
    if (!prepared.has(partition)) {
      prepared.add(partition)
      ses.setUserAgent(cleanUserAgent(ses.getUserAgent()))
      // WP398（docs/106 §2.1）：访问 Amazon 的每个请求自报 `Agent/AgentsWorkshop`（别的站不加）
      ses.webRequest.onBeforeSendHeaders(
        { urls: [...AMAZON_URL_PATTERNS] },
        (details, callback) => {
          const headers = { ...details.requestHeaders }
          const key =
            Object.keys(headers).find((k) => k.toLowerCase() === 'user-agent') ?? 'User-Agent'
          headers[key] = userAgentFor(details.url, headers[key] ?? ses.getUserAgent())
          callback({ requestHeaders: headers })
        },
      )
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
      ses.setPermissionCheckHandler(() => false)
      ses.on('will-download', (event, item) => {
        event.preventDefault()
        item.cancel()
      })
    }
    return ses
  }

  const newView = (workspace_id: string): WebContentsView => {
    const view = new WebContentsView({
      webPreferences: {
        session: sessionOf(workspace_id),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        // 不挂界面也照常加载、照常跑（不然后台页面会被节流到读不出结果）
        backgroundThrottling: false,
      },
    })
    view.webContents.setAudioMuted(true)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return view
  }

  const slotOf = (workspace_id: string): Slot => {
    let slot = slots.get(workspace_id)
    if (slot === undefined) {
      slot = { view: newView(workspace_id), queue: Promise.resolve() }
      slots.set(workspace_id, slot)
    }
    return slot
  }

  /** 打开一页：等 `dom-ready`（超时 = 打不开）、主文档状态码从 `did-navigate` 来。 */
  async function load(
    wc: Electron.WebContents,
    url: string,
    timeoutMs: number,
  ): Promise<
    { ok: true; status: number } | { ok: false; reason: 'timeout' | 'failed'; message: string }
  > {
    let status = 0
    const onNavigate = (_e: unknown, _url: string, code: number): void => {
      status = code
    }
    wc.on('did-navigate', onNavigate)
    try {
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          cleanup()
          wc.stop()
          resolve({
            ok: false,
            reason: 'timeout',
            message: `${Math.round(timeoutMs / 1000)} 秒内没打开`,
          })
        }, timeoutMs)
        const onReady = (): void => {
          cleanup()
          resolve({ ok: true, status })
        }
        const onFail = (
          _e: unknown,
          code: number,
          desc: string,
          _url: string,
          isMainFrame: boolean,
        ): void => {
          // -3 = 被新的导航顶掉（跳转），不算失败
          if (!isMainFrame || code === -3) return
          cleanup()
          resolve({ ok: false, reason: 'failed', message: `${desc}（${code}）` })
        }
        const cleanup = (): void => {
          clearTimeout(timer)
          wc.removeListener('dom-ready', onReady)
          wc.removeListener('did-fail-load', onFail)
        }
        wc.once('dom-ready', onReady)
        wc.on('did-fail-load', onFail)
        wc.loadURL(url).catch(() => undefined)
      })
    } finally {
      wc.removeListener('did-navigate', onNavigate)
    }
  }

  async function openOnce(req: OpenRequest): Promise<OpenResult> {
    const wc = slotOf(req.workspace_id).view.webContents
    const got = await load(wc, req.url, req.timeout_ms)
    if (!got.ok) return got
    if (req.settle_ms > 0) await new Promise((r) => setTimeout(r, req.settle_ms))
    const script =
      req.kind === 'page'
        ? pageScript(extractReadable, { maxChars: req.max_chars })
        : req.kind === 'data'
          ? pageScript(extractData, { maxChars: req.max_chars })
          : pageScript(extractSerp, { engine: req.kind, limit: 10 })
    try {
      const data = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: script }])
      return {
        ok: true,
        status: got.status,
        final_url: wc.getURL(),
        ...(req.kind === 'page' || req.kind === 'data' ? { page: data } : { serp: data }),
      }
    } catch (err) {
      return { ok: false, reason: 'failed', message: `读不出这一页：${String(err)}` }
    }
  }

  const detach = (): void => {
    const win = deps.mainWindow()
    if (handover !== undefined && placed && win !== undefined && !win.isDestroyed())
      win.contentView.removeChildView(handover.view)
    placed = false
  }

  const closeHandover = (verifiedNow: boolean): void => {
    if (handover === undefined) return
    if (verifiedNow) verified.set(handover.workspace_id, Date.now())
    detach()
    const view = handover.view
    handover = undefined
    try {
      view.webContents.close()
    } catch {
      // 已经关了
    }
    deps.onChange(undefined)
  }

  /** 交给人的那一页离开了验证页（Google 回到 `/search`、页面上没有验证挂件）就算人点过了。 */
  const watchHandover = (view: WebContentsView, workspace_id: string): void => {
    const check = (): void => {
      if (handover?.view !== view) return
      let u: URL
      try {
        u = new URL(view.webContents.getURL())
      } catch {
        return
      }
      const onSorry = u.pathname.startsWith('/sorry') || u.pathname.includes('captcha')
      if (!onSorry && u.pathname === '/search') {
        deps.log('搜索验证：人已经过了验证页', { workspace_id })
        closeHandover(true)
      }
    }
    view.webContents.on('did-navigate', check)
    view.webContents.on('did-navigate-in-page', check)
  }

  return {
    open(req) {
      const slot = slotOf(req.workspace_id)
      const next = slot.queue.then(() => openOnce(req))
      slot.queue = next.catch(() => undefined)
      return next
    },
    async reveal(req) {
      if (handover !== undefined) return { shown: true }
      const view = newView(req.workspace_id)
      handover = { ...req, view }
      watchHandover(view, req.workspace_id)
      view.webContents.loadURL(req.url).catch(() => undefined)
      deps.log('搜索要人介入：亮出那一页', { workspace_id: req.workspace_id, reason: req.reason })
      deps.onChange({
        workspace_id: req.workspace_id,
        reason: req.reason,
        message: req.message,
        url: req.url,
      })
      return { shown: true }
    },
    status(workspace_id): SearchBrowserStatus {
      const at = verified.get(workspace_id)
      return {
        revealed: handover?.workspace_id === workspace_id,
        ...(at === undefined ? {} : { verified_at: at }),
      }
    },
    pending: () =>
      handover === undefined
        ? undefined
        : {
            workspace_id: handover.workspace_id,
            reason: handover.reason,
            message: handover.message,
            url: handover.url,
          },
    place(rect) {
      const win = deps.mainWindow()
      if (handover === undefined || win === undefined || win.isDestroyed()) return
      if (rect === null) {
        detach()
        return
      }
      if (!placed) {
        win.contentView.addChildView(handover.view)
        placed = true
      }
      handover.view.setBounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      })
    },
    dismiss: () => closeHandover(false),
    close() {
      closeHandover(false)
      for (const slot of slots.values()) {
        try {
          slot.view.webContents.close()
        } catch {
          // 已经关了
        }
      }
      slots.clear()
    },
  }
}
