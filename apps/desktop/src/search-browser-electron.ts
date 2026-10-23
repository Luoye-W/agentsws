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
 *
 * WP484（WP464 §8 实测的三个毛病）：AI 读页 / 搜索用的不再是一个一直开着、反复换页的视图，而是
 * **每开一页现开一个不显示的离屏窗口**（`show: false` + `offscreen`，同一个品牌 partition），读完就关：
 * - 上一页的脚本（Bing 结果页过一会儿自己跳 `&rdr=1`）顶掉下一页的导航、把上一页当成这一页读回去（串页）——没有上一页了；
 * - 一页卡住（`executeJavaScript*` 要等整页停止加载才执行，重的站几十秒不停），后面排队的几页跟着「连不上」——
 *   读之前先停下加载；整次另有总上限（{@link OPEN_DEADLINE_EXTRA_MS}），到点关掉这一页、交回超时，后面照常；
 * - 不挂界面的视图在页面看来是「隐藏、0×0」，YouTube 这类页面不画列表——离屏窗口在页面看来是可见的 1280×900。
 *   离屏窗口从不显示、不进任务栏、不抢焦点；只渲染到内存里（每秒 {@link READER_FRAME_RATE} 帧，没人取画面）。
 */
import { BrowserWindow, session as electronSession, net, WebContentsView } from 'electron'
import { setAmazonDeliveryZip } from './amazon-delivery.js'
import {
  AMAZON_URL_PATTERNS,
  type AmazonDeliveryResult,
  cleanUserAgent,
  dataUserAgent,
  isGoogleCookieDomain,
  type OpenRequest,
  type OpenResult,
  type SearchBrowserDriver,
  type SearchBrowserStatus,
  searchPartitionOf,
  userAgentFor,
} from './search-browser.js'
import {
  extractData,
  extractHtml,
  extractReadable,
  extractSerp,
  pageScript,
  type ReadableExtract,
  type SerpExtract,
  type SerpProbe,
  serpState,
} from './search-extract.js'
import {
  isTransientLoadFailure,
  type LoadableContents,
  loadPage,
  settleText,
  withDeadline,
} from './search-load.js'
import { resolveSerpRedirects } from './search-redirect.js'

/** WP454：搜索结果页 `dom-ready` 之后最多再等多久（等过渡页自己跳到真结果页）。 */
export const SERP_READY_WAIT_MS = 8_000

/** WP484：读正文前最多等多久让字数稳住（从 `dom-ready` 算）。 */
export const PAGE_SETTLE_MAX_MS = 8_000
/** WP484：数据原文 / Amazon HTML 读之前最多再等多久让页面自己停止加载（过了就停下来读）。 */
export const IDLE_WAIT_MAX_MS = 6_000
/** WP484：一次开页的总上限 = 请求的 `timeout_ms` + 这么多（通道那边等 `timeout_ms` + 30 秒，先到我们这边）。 */
export const OPEN_DEADLINE_EXTRA_MS = 25_000
/** WP484：Google 结果跳转地址换目标网址，一条最多等多久。 */
export const REDIRECT_HOP_TIMEOUT_MS = 5_000
/** WP484：连接断了一下（-100 这种）隔多久重开。 */
export const TRANSIENT_RETRY_DELAY_MS = 1_000
/** WP484：离屏窗口每秒画几帧（够页面的动画帧回调跑起来就行，没人取画面）。 */
export const READER_FRAME_RATE = 10
const READER_SIZE = { width: 1280, height: 900 }

/** 交给人的那一页（第三栏亮出来的）。WP454：`consent` = Google 的 cookie 同意页。 */
export interface SearchHandover {
  workspace_id: string
  reason: 'captcha' | 'login' | 'consent'
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
  /**
   * WP484：这个页面是不是内置浏览器的（AI 读页的离屏窗口、交给人的那一页）——壳的「外链交系统浏览器」那一道
   * 要跳过它们（见 `searchNavigationAllowed`）。
   */
  owns(contents: Electron.WebContents): boolean
  close(): void
}

/** 脚本跑在这个隔离世界里（页面自己的脚本看不见、改不了）。 */
const WORLD_ID = 1053

interface Slot {
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

  /** 交给人的那一页（第三栏）：挂到主窗口上的视图。 */
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

  /** WP484：AI 读一页用的离屏窗口（每开一页现开一个，读完就关；见文件头）。 */
  const readers = new Set<BrowserWindow>()
  const newReader = (workspace_id: string): BrowserWindow => {
    const win = new BrowserWindow({
      show: false,
      ...READER_SIZE,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        session: sessionOf(workspace_id),
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    })
    readers.add(win)
    win.once('closed', () => readers.delete(win))
    win.webContents.setFrameRate(READER_FRAME_RATE)
    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return win
  }
  const dropReader = (win: BrowserWindow): void => {
    readers.delete(win)
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      // 已经关了
    }
  }

  const slotOf = (workspace_id: string): Slot => {
    let slot = slots.get(workspace_id)
    if (slot === undefined) {
      slot = { queue: Promise.resolve() }
      slots.set(workspace_id, slot)
    }
    return slot
  }

  /** WP454：核实一次就够（页面看到的可见性 / 视口），记进日志。 */
  let probeLogged = false

  /** 打开一页（WP454 起拎到 `search-load.ts`；搜索结果页会等到真结果页再交回）。 */
  const load = (
    wc: Electron.WebContents,
    url: string,
    timeoutMs: number,
    opts: { userAgent?: string; partial_on_timeout?: boolean } = {},
  ): ReturnType<typeof loadPage> =>
    loadPage(wc as unknown as LoadableContents, url, timeoutMs, opts)

  /** WP484：页面还在加载就最多再等 `ms`，还没停就停下来（`executeJavaScript*` 要等停止加载才执行）。 */
  const untilIdle = async (wc: Electron.WebContents, ms: number): Promise<void> => {
    if (wc.isLoadingMainFrame() && ms > 0)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms)
        function done(): void {
          clearTimeout(timer)
          wc.removeListener('did-stop-loading', done)
          resolve()
        }
        wc.once('did-stop-loading', done)
      })
    if (wc.isLoadingMainFrame()) wc.stop()
  }

  /** WP484：Google 结果跳转地址 → 302 的 `Location`（同一个品牌 partition；不跟过去）。 */
  const hop =
    (ses: Electron.Session) =>
    (url: string): Promise<string | undefined> =>
      new Promise((resolve) => {
        let req: Electron.ClientRequest
        const finish = (v: string | undefined): void => {
          clearTimeout(timer)
          try {
            req.abort()
          } catch {
            // 已经完了
          }
          resolve(v)
        }
        const timer = setTimeout(() => finish(undefined), REDIRECT_HOP_TIMEOUT_MS)
        try {
          req = net.request({ url, session: ses, redirect: 'manual', useSessionCookies: true })
        } catch {
          finish(undefined)
          return
        }
        req.on('redirect', (_status, _method, location) => finish(location))
        req.on('response', (res) => {
          const loc = res.headers.location
          finish(Array.isArray(loc) ? loc[0] : loc)
        })
        req.on('error', () => finish(undefined))
        req.end()
      })

  async function readOnce(wc: Electron.WebContents, req: OpenRequest): Promise<OpenResult> {
    // WP402（不伪装 UA）：读数据地址原文那一次导航自报 Agent 身份
    const serp = req.kind === 'google' || req.kind === 'bing' ? req.kind : undefined
    const got =
      serp === undefined
        ? await load(wc, req.url, req.timeout_ms, {
            ...(req.kind === 'data' ? { userAgent: dataUserAgent(wc.session.getUserAgent()) } : {}),
            // WP484：普通网页到时间还没 `dom-ready`、但已经显示出来了——读到多少算多少
            ...(req.kind === 'page' ? { partial_on_timeout: true } : {}),
          })
        : // WP454：搜索结果页等到真结果页（过渡页的二次导航接着等），等到了就读、不再另等
          await loadPage(wc as unknown as LoadableContents, req.url, req.timeout_ms, {
            ready: {
              max_wait_ms: SERP_READY_WAIT_MS,
              interval_ms: 250,
              // WP454：探针走主框架那一口——`webContents.executeJavaScript*` 要等整页停止加载才执行
              // （10-21 真机：Google 结果页常要 40–50 秒才停，等到通道超时）；探针只读、只回一个状态，
              // 读结果仍在隔离世界里跑
              probe: () =>
                wc.mainFrame.executeJavaScript(
                  pageScript(serpState, { engine: serp }),
                ) as Promise<SerpProbe>,
            },
          })
    if (!got.ok) return got
    // WP454：热身只开不读（看地址认 /sorry、同意页就够）——不跑脚本，也就不用等整页停止加载
    if (req.no_read === true) {
      if (req.settle_ms > 0) await new Promise((r) => setTimeout(r, req.settle_ms))
      return { ok: true, status: got.status, final_url: wc.getURL() }
    }
    if (serp !== undefined) {
      // 结果已经在 DOM 里了：剩下的图片、脚本不等，停下加载好让隔离世界的读取马上跑
      if (wc.isLoadingMainFrame()) wc.stop()
      if (!probeLogged && got.probe !== undefined) {
        probeLogged = true
        deps.log('搜索浏览器：页面看到的可见性与视口（WP454 核实）', {
          visibility: got.probe.visibility,
          width: got.probe.width,
          height: got.probe.height,
        })
      }
      deps.log('搜索浏览器：结果页状态', {
        engine: serp,
        state: got.state,
        waited_ms: got.waited_ms,
        renavigations: got.renavigations,
      })
    } else if (req.kind === 'page') {
      // WP484：等字数稳住（列表、评论这些 `dom-ready` 之后才画出来），再停下加载读
      const settled = await settleText({
        min_ms: req.settle_ms,
        max_ms: Math.max(req.settle_ms, PAGE_SETTLE_MAX_MS),
        interval_ms: 500,
        probe: () =>
          wc.mainFrame.executeJavaScript(
            '(document.body && document.body.innerText || "").length',
          ) as Promise<number>,
      })
      deps.log('搜索浏览器：正文等稳', {
        waited_ms: settled.waited_ms,
        chars: settled.chars,
        stable: settled.stable,
        ...(got.partial === true ? { partial: true } : {}),
      })
      if (wc.isLoadingMainFrame()) wc.stop()
    } else {
      if (req.settle_ms > 0) await new Promise((r) => setTimeout(r, req.settle_ms))
      await untilIdle(wc, IDLE_WAIT_MAX_MS)
    }
    const script =
      req.kind === 'page'
        ? pageScript(extractReadable, { maxChars: req.max_chars })
        : req.kind === 'data'
          ? pageScript(extractData, { maxChars: req.max_chars })
          : req.kind === 'html'
            ? pageScript(extractHtml, { maxChars: req.max_chars })
            : pageScript(extractSerp, { engine: req.kind, limit: 10, redirects: true })
    let data: unknown
    try {
      data = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: script }])
    } catch (err) {
      return { ok: false, reason: 'failed', message: `读不出这一页：${String(err)}` }
    }
    const final_url = wc.getURL()
    if (req.kind === 'page' || req.kind === 'data' || req.kind === 'html')
      return { ok: true, status: got.status, final_url, page: data as ReadableExtract }
    const extract = data as SerpExtract
    if (extract.items.some((i) => i.redirect === true)) {
      // WP484：Google 结果链接只有跳转地址——换成目标网址（换不出来的那条不要）
      const r = await resolveSerpRedirects(extract.items, hop(wc.session))
      deps.log('搜索浏览器：结果跳转地址换目标网址', { resolved: r.resolved, dropped: r.dropped })
      return { ok: true, status: got.status, final_url, serp: { ...extract, items: r.items } }
    }
    return { ok: true, status: got.status, final_url, serp: extract }
  }

  /** WP484：现开一个离屏窗口读这一页；总上限到了就关掉它、交回超时（后面排队的照常）。 */
  async function openFresh(req: OpenRequest): Promise<OpenResult & { code?: number }> {
    const win = newReader(req.workspace_id)
    try {
      return await withDeadline(
        readOnce(win.webContents, req),
        req.timeout_ms + OPEN_DEADLINE_EXTRA_MS,
        (): OpenResult => {
          deps.log('搜索浏览器：这一页超过总上限，关掉', { kind: req.kind })
          return {
            ok: false,
            reason: 'timeout',
            message: `${Math.round((req.timeout_ms + OPEN_DEADLINE_EXTRA_MS) / 1000)} 秒内没读完这一页`,
          }
        },
      )
    } catch (err) {
      return { ok: false, reason: 'failed', message: `读不出这一页：${String(err)}` }
    } finally {
      dropReader(win)
    }
  }

  /** WP484：连接层抖一下（{@link isTransientLoadFailure}）就隔一秒换个窗口重开一次。 */
  async function openOnce(req: OpenRequest): Promise<OpenResult> {
    const first = await openFresh(req)
    if (!isTransientLoadFailure(first)) return first
    deps.log('搜索浏览器：连接断了一下，重开一次', { kind: req.kind, code: first.code })
    await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS))
    return openFresh(req)
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
      // WP454：cookie 同意页在 consent.google.*；人选完会跳回原来的 /search
      const onConsent = u.hostname.startsWith('consent.')
      if (!onSorry && !onConsent && u.pathname === '/search') {
        deps.log('搜索验证：人已经过了验证页', { workspace_id })
        closeHandover(true)
      }
    }
    view.webContents.on('did-navigate', check)
    view.webContents.on('did-navigate-in-page', check)
  }

  /** WP394：开站点首页 → 在页面里走 Amazon 自己的改地址接口交邮编（一页额度）。 */
  async function setZip(
    wc: Electron.WebContents,
    req: { url: string; zip: string; timeout_ms: number },
  ): Promise<AmazonDeliveryResult> {
    const got = await load(wc, `${req.url}/`, req.timeout_ms)
    if (!got.ok) return got
    await untilIdle(wc, IDLE_WAIT_MAX_MS)
    const first = (await wc
      .executeJavaScriptInIsolatedWorld(WORLD_ID, [
        { code: pageScript(extractHtml, { maxChars: 400_000 }) },
      ])
      .catch(() => undefined)) as { signals?: { captcha?: boolean } } | undefined
    if (first?.signals?.captcha === true)
      return { ok: false, reason: 'blocked', message: 'Amazon 要人机验证，没设配送地址' }
    // 主世界里跑：要用这一页自己的源（同源请求、带这个 partition 的 cookie）；脚本只调 Amazon 自己的改地址接口
    const r = (await wc
      .executeJavaScript(pageScript(setAmazonDeliveryZip, { zip: req.zip }))
      .catch((e: unknown) => ({ ok: false, status: 0, message: String(e) }))) as {
      ok: boolean
      message?: string
    }
    if (!r.ok) return { ok: false, reason: 'failed', message: r.message ?? '没设上' }
    // 不再开一次首页确认：下一页商品页页头那一行就是「配送到」，服务进程在那里核对（省一页额度）
    return { ok: true }
  }

  /** WP484：同 {@link openOnce}——现开一个离屏窗口、有总上限、用完就关（邮编记在 partition 的 cookie 里）。 */
  async function deliveryOnce(req: {
    workspace_id: string
    url: string
    zip: string
    timeout_ms: number
  }): Promise<AmazonDeliveryResult> {
    const win = newReader(req.workspace_id)
    try {
      return await withDeadline(
        setZip(win.webContents, req),
        req.timeout_ms + OPEN_DEADLINE_EXTRA_MS,
        (): AmazonDeliveryResult => ({
          ok: false,
          reason: 'timeout',
          message: '设配送地址超时',
        }),
      )
    } catch (err) {
      return { ok: false, reason: 'failed', message: String(err) }
    } finally {
      dropReader(win)
    }
  }

  return {
    open(req) {
      const slot = slotOf(req.workspace_id)
      const next = slot.queue.then(() => openOnce(req))
      slot.queue = next.catch(() => undefined)
      return next
    },
    amazonDelivery(req) {
      const slot = slotOf(req.workspace_id)
      const next = slot.queue.then(() => deliveryOnce(req))
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
    async googleCookies(workspace_id) {
      try {
        const all = await sessionOf(workspace_id).cookies.get({})
        return all.some((c) => isGoogleCookieDomain(c.domain ?? ''))
      } catch {
        return false
      }
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
    owns: (contents) =>
      handover?.view.webContents === contents ||
      [...readers].some((w) => !w.isDestroyed() && w.webContents === contents),
    close() {
      closeHandover(false)
      for (const win of [...readers]) dropReader(win)
      slots.clear()
    },
  }
}
