/**
 * 执行器的「手」：一个**看得见的**广告后台标签页（docs/101 §4.3 第 6 条：不在后台偷偷开无界面浏览器）。
 *
 * `chrome.*` 全收在 {@link TabDriver} 里（测试塞假的）。这里只管几件容易做错的事：
 * - 换页之后等它加载完、把页面脚本重新放进去（换页会把旧的整个扔掉）；
 * - 截图前确认这个标签页**还在广告后台**、而且是这个窗口正在显示的那一个——只截它（决策 556）；
 *   截之前把横条藏一下，截的是后台本身；
 * - 下载：点之前先开始盯下载，点完等浏览器把文件下完，回文件路径（桌面端去读）。
 */

import {
  type ActionPage,
  base64ToBytes,
  bytesToBase64,
  type DomOpResult,
  hostMatches,
  hostOfUrl,
  type PageLook,
  type PostedHit,
  type SheetFile,
} from '@agentsws/browser-action'
import type { AdsDomRequest, AdsDomResponse, BannerState } from './dom-messages'

export interface TabFacts {
  url: string
  /** `loading` / `complete`。 */
  status?: string | undefined
  active: boolean
  windowId: number
}

export interface DownloadDone {
  path: string
  name: string
  bytes?: number
}

/** `chrome.*` 那一层（真的在 {@link chromeTabDriver}）。 */
export interface TabDriver {
  facts(): Promise<TabFacts | undefined>
  navigate(url: string): Promise<void>
  /** 让这个标签页成为窗口里正在显示的那一个。 */
  activate(): Promise<void>
  /** 把页面脚本放进去（重复放没关系，脚本自己认得）。 */
  inject(): Promise<void>
  dom(req: AdsDomRequest): Promise<AdsDomResponse>
  banner(state: BannerState | null): Promise<void>
  /** `captureVisibleTab`：回 data URL。没权限会抛。 */
  capture(windowId: number): Promise<string>
  /**
   * 截不到时等用户点一下工具栏上的插件图标（点了 = 这个标签页拿到 activeTab）。
   * 没有这一项就不等，直接照实说截不到。
   */
  waitCaptureGrant?(timeoutMs: number): Promise<boolean>
  downloadsAllowed(): Promise<boolean>
  /** 先开始盯下载，再调 `click`，等它下完。 */
  watchDownload(
    click: () => Promise<DomOpResult>,
    timeoutMs: number,
  ): Promise<({ ok: true } & DownloadDone) | { ok: false; why: string }>
  sleep(ms: number): Promise<void>
}

const LOAD_TIMEOUT_MS = 60_000
const POLL_MS = 250
const DOWNLOAD_TIMEOUT_MS = 120_000
/** 等用户点插件图标授权截图最多等多久。 */
export const CAPTURE_GRANT_WAIT_MS = 10 * 60 * 1000
const GRANT_SLICE_MS = 2_000
export const ASK_GRANT = '点右上角插件图标，允许截图'
const NO_CAPTURE = '截图没被浏览器允许（要点一下右上角的插件图标）。已停下，没往下做。'

export interface TabPageOptions {
  driver: TabDriver
  /** 这件活的白名单站点（截图前再核一次）。 */
  hosts: readonly string[]
  /** 横条当前的样子（截图后恢复用）。 */
  bannerState(): BannerState | null
  /** 用户点了停止没有（等页面 / 等授权的时候也要停得住）。 */
  stopped?(): boolean
}

export class TabPage implements ActionPage {
  constructor(private readonly o: TabPageOptions) {}

  private async ready(): Promise<void> {
    const d = this.o.driver
    for (let waited = 0; waited < LOAD_TIMEOUT_MS; waited += POLL_MS) {
      const f = await d.facts()
      if (f === undefined) throw new Error('广告后台那个标签页被关掉了')
      if (f.status === 'complete') break
      await d.sleep(POLL_MS)
    }
    await d.inject()
    await d.banner(this.o.bannerState())
  }

  async url(): Promise<string> {
    return (await this.o.driver.facts())?.url ?? ''
  }

  async goto(url: string): Promise<{ finalUrl: string }> {
    await this.o.driver.navigate(url)
    // 给浏览器一拍把状态改成 loading，免得读到上一页的 complete
    await this.o.driver.sleep(POLL_MS)
    await this.ready()
    return { finalUrl: await this.url() }
  }

  async look(): Promise<PageLook> {
    const url = await this.url()
    // 不在白名单站点上就不往里放脚本、不读它（执行器会因为主机对不上停下）
    if (!hostMatches(hostOfUrl(url), this.o.hosts))
      return { url, title: '', text: '', frameSources: [], passwordInputs: 0 }
    try {
      return (await this.o.driver.dom({ type: 'ads-dom', op: 'look' })) as PageLook
    } catch {
      // WP329：人点了发送、页面自己换了（发新帖会跳到帖子页）：等它加载完、把脚本放回去再看一次
      await this.ready()
      return (await this.o.driver.dom({ type: 'ads-dom', op: 'look' })) as PageLook
    }
  }

  /**
   * WP329：页面上正文含这段字的那几条（等人点发送时一直在看）。页面正在换（脚本被扔掉了）就回空，
   * 等它加载完把脚本放回去，下一眼接着看——**这里不点任何东西**。
   */
  async findPosted(selector: string, body: string, text: string): Promise<PostedHit[]> {
    try {
      const out = await this.o.driver.dom({
        type: 'ads-dom',
        op: 'find-posted',
        selector,
        body,
        text,
      })
      return Array.isArray(out) ? (out as PostedHit[]) : []
    } catch {
      const f = await this.o.driver.facts()
      if (f?.status === 'complete' && hostMatches(hostOfUrl(f.url), this.o.hosts))
        await this.ready().catch(() => undefined)
      return []
    }
  }

  async waitFor(selector: string, timeoutMs: number): Promise<boolean> {
    for (let waited = 0; ; waited += POLL_MS) {
      if ((await this.count(selector)) > 0) return true
      if (waited >= timeoutMs || this.o.stopped?.() === true) return false
      await this.o.driver.sleep(POLL_MS)
    }
  }

  async click(selector: string): Promise<DomOpResult> {
    return (await this.o.driver.dom({ type: 'ads-dom', op: 'click', selector })) as DomOpResult
  }

  async fill(selector: string, value: string): Promise<DomOpResult> {
    return (await this.o.driver.dom({
      type: 'ads-dom',
      op: 'fill',
      selector,
      value,
    })) as DomOpResult
  }

  async setFile(selector: string, file: SheetFile): Promise<DomOpResult> {
    return (await this.o.driver.dom({
      type: 'ads-dom',
      op: 'file',
      selector,
      name: file.name,
      mime: file.mime,
      base64: bytesToBase64(file.bytes),
    })) as DomOpResult
  }

  async paste(selector: string, text: string): Promise<DomOpResult> {
    return (await this.o.driver.dom({
      type: 'ads-dom',
      op: 'paste',
      selector,
      value: text,
    })) as DomOpResult
  }

  async text(selector: string): Promise<string> {
    return String(await this.o.driver.dom({ type: 'ads-dom', op: 'text', selector }))
  }

  async count(selector: string): Promise<number> {
    return Number(await this.o.driver.dom({ type: 'ads-dom', op: 'count', selector }))
  }

  async capture(): Promise<{ ok: true; png_base64: string } | { ok: false; why: string }> {
    const d = this.o.driver
    const f = await d.facts()
    if (f === undefined) return { ok: false, why: '广告后台那个标签页被关掉了，没截到图。' }
    if (!hostMatches(hostOfUrl(f.url), this.o.hosts))
      return { ok: false, why: '当前页面不在广告后台，不截。' }
    if (!f.active) await d.activate()
    const first = await this.shoot(f.windowId)
    if (first !== undefined || d.waitCaptureGrant === undefined)
      return first === undefined ? { ok: false, why: NO_CAPTURE } : { ok: true, png_base64: first }
    // 截不到：请用户点一下插件图标（给这个标签页 activeTab），点了再截一次
    const state = this.o.bannerState()
    if (state !== null) await d.banner({ ...state, label: ASK_GRANT })
    // 一小段一小段地等：中间点了停止要停得住
    let granted = false
    for (let waited = 0; waited < CAPTURE_GRANT_WAIT_MS && !granted; waited += GRANT_SLICE_MS) {
      if (this.o.stopped?.() === true) break
      granted = await d.waitCaptureGrant(GRANT_SLICE_MS)
    }
    await d.banner(state)
    if (!granted) return { ok: false, why: NO_CAPTURE }
    const second = await this.shoot(f.windowId)
    return second === undefined ? { ok: false, why: NO_CAPTURE } : { ok: true, png_base64: second }
  }

  /** 截一张（截的时候横条先藏起来）。截不到回 `undefined`。 */
  private async shoot(windowId: number): Promise<string | undefined> {
    const d = this.o.driver
    const state = this.o.bannerState()
    await d.banner(state === null ? null : { ...state, hidden: true })
    try {
      const dataUrl = await d.capture(windowId)
      const b64 = dataUrl.replace(/^data:image\/png;base64,/u, '')
      base64ToBytes(b64)
      return b64
    } catch {
      return undefined
    } finally {
      await d.banner(state)
    }
  }

  async download(
    selector: string,
  ): Promise<({ ok: true } & DownloadDone) | { ok: false; why: string }> {
    const d = this.o.driver
    if (!(await d.downloadsAllowed()))
      return { ok: false, why: '插件还没有「下载」权限。去插件设置页重新连接一次广告后台。' }
    return d.watchDownload(() => this.click(selector), DOWNLOAD_TIMEOUT_MS)
  }
}
