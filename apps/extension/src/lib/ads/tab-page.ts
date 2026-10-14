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

export interface TabPageOptions {
  driver: TabDriver
  /** 这件活的白名单站点（截图前再核一次）。 */
  hosts: readonly string[]
  /** 横条当前的样子（截图后恢复用）。 */
  bannerState(): BannerState | null
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
    return (await this.o.driver.dom({ type: 'ads-dom', op: 'look' })) as PageLook
  }

  async waitFor(selector: string, timeoutMs: number): Promise<boolean> {
    for (let waited = 0; ; waited += POLL_MS) {
      if ((await this.count(selector)) > 0) return true
      if (waited >= timeoutMs) return false
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
    const state = this.o.bannerState()
    await d.banner(state === null ? null : { ...state, hidden: true })
    try {
      const dataUrl = await d.capture(f.windowId)
      const b64 = dataUrl.replace(/^data:image\/png;base64,/u, '')
      // 解得开才算截到了
      base64ToBytes(b64)
      return { ok: true, png_base64: b64 }
    } catch {
      return {
        ok: false,
        why: '截图没被浏览器允许。点一下浏览器右上角的插件图标授权截图，再让它接着做。',
      }
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
