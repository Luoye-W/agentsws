/**
 * 广告动作通道测试用的替身：一个只在内存里的假后台标签页 + 一个假的本机服务。
 * **不联网、不碰真站**：网址照真站的样子写，jsdom 里渲染，没有任何请求发出去。
 */
import { JSDOM } from 'jsdom'
import type { BannerState } from '../src/lib/ads/dom-messages'
import { handleDomRequest } from '../src/lib/ads/dom-messages'
import type { TabDriver, TabFacts } from '../src/lib/ads/tab-page'

export interface FakeAds {
  status: Record<string, 'Enabled' | 'Paused'>
  uploadedName?: string
  previewed: boolean
  applied: boolean
  previewErrors: number
}

function render(url: string, s: FakeAds): string {
  const u = new URL(url)
  if (u.pathname === '/aw/bulk/uploads') {
    const preview = s.previewed
      ? `<div data-bulk-upload="preview"><div data-bulk-upload="summary">3 changes</div>${'<div data-severity="error">x</div>'.repeat(s.previewErrors)}</div>`
      : ''
    return `<button aria-label="Upload">+</button><input type="file"><material-button>Preview</material-button><material-button>Apply</material-button>${preview}${s.applied ? '<div data-bulk-upload="status">Applied</div>' : ''}`
  }
  if (u.pathname.startsWith('/aw/billing')) return '<h1>Billing</h1>'
  const id = u.searchParams.get('campaignId') ?? '111'
  return `<button aria-label="Download">Download</button>
    <div data-row-id="${id}"><span data-column="status"><span role="button">${s.status[id] ?? 'Enabled'}</span></span></div>
    <div role="menuitem">Enabled</div><div role="menuitem">Paused</div><div role="menuitem">.csv</div>`
}

/** 一个假的「看得见的标签页」。 */
export class FakeTab {
  doc: Document = new JSDOM('').window.document
  url = 'https://ads.google.com/aw/overview'
  active = true
  status: 'loading' | 'complete' = 'complete'
  injected = 0
  banners: (BannerState | null)[] = []
  captures = 0
  captureThrows = false
  downloads = true
  readonly state: FakeAds

  constructor(state: Partial<FakeAds> = {}) {
    this.state = {
      status: { '111': 'Enabled' },
      previewed: false,
      applied: false,
      previewErrors: 0,
      ...state,
    }
    this.load(this.url)
  }

  load(url: string): void {
    this.url = url
    this.doc = new JSDOM(
      `<!doctype html><html><head><title>Google Ads</title></head><body>${render(url, this.state)}</body></html>`,
      {
        url,
      },
    ).window.document
    const id = new URL(url).searchParams.get('campaignId') ?? '111'
    const on = (sel: string, text: string, fn: () => void) => {
      for (const el of Array.from(this.doc.querySelectorAll(sel)))
        if (el.textContent?.trim() === text)
          el.addEventListener('click', () => {
            fn()
            this.load(this.url)
          })
    }
    on('[role="menuitem"]', 'Paused', () => {
      this.state.status[id] = 'Paused'
    })
    on('material-button', 'Preview', () => {
      this.state.previewed = this.state.uploadedName !== undefined
    })
    on('material-button', 'Apply', () => {
      this.state.applied = true
    })
    this.doc.querySelector('input[type="file"]')?.addEventListener('change', (e) => {
      const f = (e.target as HTMLInputElement).files?.[0]
      if (f !== undefined) this.state.uploadedName = f.name
    })
  }

  driver(): TabDriver {
    return {
      facts: async (): Promise<TabFacts> => ({
        url: this.url,
        status: this.status,
        active: this.active,
        windowId: 1,
      }),
      navigate: async (url) => {
        this.load(url)
      },
      activate: async () => {
        this.active = true
      },
      inject: async () => {
        this.injected += 1
      },
      dom: async (req) => handleDomRequest(this.doc, this.url, req),
      banner: async (state) => {
        this.banners.push(state)
      },
      capture: async () => {
        if (this.captureThrows)
          throw new Error('Either the <all_urls> or activeTab permission is required.')
        this.captures += 1
        return 'data:image/png;base64,iVBORw0KGgo='
      },
      downloadsAllowed: async () => this.downloads,
      watchDownload: async (click) => {
        const out = await click()
        if (!out.ok) return out
        return {
          ok: true,
          path: '/Users/me/Downloads/campaigns.csv',
          name: 'campaigns.csv',
          bytes: 10,
        }
      },
      sleep: async () => {},
    }
  }
}

/** 假的本机服务（只认动作通道那几条）。 */
export function fakeLocal(options: {
  job?: unknown
  sheet?: { name: string; mime: string; base64: string; fingerprint: string }
  confirmed?: boolean
  stop?: boolean
  evidenceFails?: boolean
  needsConsent?: string[]
  down?: boolean
}) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  let handedOut = false
  const json = (data: unknown, status = 200) =>
    new Response(
      JSON.stringify({
        ok: status < 300,
        data,
        error: status < 300 ? undefined : { message: '不行' },
      }),
      { status },
    )
  const fetchLike = (async (input: string | URL | Request, init?: RequestInit) => {
    if (options.down === true) throw new Error('ECONNREFUSED')
    const u = new URL(String(input))
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    calls.push({
      method: init?.method ?? 'GET',
      path: u.pathname,
      ...(body === undefined ? {} : { body }),
    })
    if (u.pathname === '/v1/extension/actions/next') {
      const give = options.job !== undefined && !handedOut
      handedOut = handedOut || give
      return json({
        ...(give ? { job: options.job } : {}),
        retry_after_ms: give ? 0 : 60_000,
        ...(options.needsConsent === undefined ? {} : { needs_consent: options.needsConsent }),
      })
    }
    if (u.pathname.endsWith('/sheet')) return json(options.sheet)
    if (u.pathname.endsWith('/progress'))
      return json({ stop: options.stop === true, confirmed: options.confirmed === true })
    if (u.pathname.endsWith('/evidence'))
      return options.evidenceFails === true
        ? json(undefined, 500)
        : json({ id: 'ev_1', kept_until: 'x' })
    if (u.pathname.endsWith('/download')) return json({ recorded: true })
    if (u.pathname.endsWith('/result')) return json({ id: 'x' })
    if (u.pathname === '/v1/extension/ads-consent') return json({ zones: {}, consent: {} })
    return json(undefined, 404)
  }) as typeof globalThis.fetch
  return { fetch: fetchLike, calls }
}
