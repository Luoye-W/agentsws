/**
 * 本地假后台（只在内存里，**不联网、不碰真站**）：照步骤表里的选择器搭出最小的页面，
 * 点了按钮就按「平台」会做的那样改页面。网址用真站的样子写，是为了让「默认不碰」区域的
 * 网址规则也能在这里走一遍——没有任何请求会发出去。
 */
import { JSDOM } from 'jsdom'
import {
  type ActionPage,
  domClick,
  domCount,
  domFill,
  domLook,
  domPaste,
  domSetFile,
  domText,
  type SheetFile,
} from '../src/index.js'

export interface FakeState {
  previewErrors: number
  applied: boolean
  previewed: boolean
  uploaded?: SheetFile
  pasted?: string
  status: Record<string, 'Enabled' | 'Paused'>
  budget: Record<string, string>
  /** 打开某个网址时被换成验证码页 / 跳去别处。 */
  captchaOn?: RegExp
  redirect?: { from: RegExp; to: string }
  /** 点了「应用」平台却没生效（读回要对不上）。 */
  applyNoop?: boolean
}

export function fakeState(patch: Partial<FakeState> = {}): FakeState {
  return {
    previewErrors: 0,
    applied: false,
    previewed: false,
    status: { '111': 'Enabled' },
    budget: { '111': '200' },
    ...patch,
  }
}

function html(body: string, title = 'Google Ads'): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
}

function render(url: string, s: FakeState): string {
  const u = new URL(url)
  const p = u.pathname
  if (s.captchaOn?.test(url))
    return html('<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>', 'Verify')
  if (p.startsWith('/aw/billing')) return html('<h1>Billing</h1>', 'Billing')
  if (p === '/aw/bulk/uploads') {
    const preview = s.previewed
      ? `<div data-bulk-upload="preview"><div data-bulk-upload="summary">3 changes</div>${'<div data-severity="error">Missing column</div>'.repeat(s.previewErrors)}</div>`
      : ''
    const status = s.applied ? '<div data-bulk-upload="status">Applied</div>' : ''
    return html(
      `<button aria-label="Upload">+</button><input type="file"><material-button>Preview</material-button><material-button>Apply</material-button>${preview}${status}`,
    )
  }
  if (p.startsWith('/aw/campaigns') || p.startsWith('/aw/reporting')) {
    const id = u.searchParams.get('campaignId') ?? '111'
    return html(
      `<button aria-label="Download">Download</button>
       <div data-row-id="${id}">
         <span data-column="status"><span role="button">${s.status[id] ?? 'Enabled'}</span></span>
         <span data-column="budget">$${s.budget[id] ?? '0'}.00/day<button aria-label="Edit budget">e</button></span>
       </div>
       <div role="menu"><div role="menuitem">Enabled</div><div role="menuitem">Paused</div></div>
       <div role="dialog"><input aria-label="Budget"><material-button>Save</material-button></div>`,
    )
  }
  if (p.startsWith('/adsmanager/manage')) {
    const id = u.searchParams.get('selected_campaign_ids') ?? '222'
    const on = (s.status[id] ?? 'Enabled') === 'Enabled'
    const summary = s.previewed
      ? `<div data-bulk-import="summary">Imported 2 ads${'<div data-severity="error">Bad</div>'.repeat(s.previewErrors)}</div>`
      : ''
    const published = s.applied ? '<div data-publish="status">Published</div>' : ''
    return html(
      `<div role="button">Export</div><div role="button">Export &amp; import</div>
       <div role="menuitem">Import ads in bulk</div>
       <div role="dialog"><div role="tab">Paste text</div><textarea></textarea>
         <div role="button">Import</div><div role="button">Publish</div></div>
       <div role="button">Review and publish</div>
       <div data-row-id="${id}"><input role="switch" aria-checked="${on}"></div>
       ${summary}${published}`,
      'Ads Manager',
    )
  }
  return html('<p>not found</p>', '404')
}

/** 点了什么就改什么（平台的反应）。 */
function wire(url: string, doc: Document, s: FakeState, rerender: () => void): void {
  const on = (selector: string, text: string | undefined, fn: () => void) => {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      if (text !== undefined && el.textContent?.trim() !== text) continue
      el.addEventListener('click', () => {
        fn()
        rerender()
      })
    }
  }
  on('material-button', 'Preview', () => {
    s.previewed = s.uploaded !== undefined
  })
  on('material-button', 'Apply', () => {
    if (!s.applyNoop) s.applied = true
  })
  on('[role="dialog"] [role="button"]', 'Import', () => {
    s.previewed = s.pasted !== undefined || s.uploaded !== undefined
  })
  on('[role="dialog"] [role="button"]', 'Publish', () => {
    if (!s.applyNoop) s.applied = true
  })
  const u = new URL(url)
  const id = u.searchParams.get('campaignId') ?? u.searchParams.get('selected_campaign_ids') ?? ''
  on('[role="menuitem"]', 'Paused', () => {
    s.status[id] = 'Paused'
  })
  on('[role="menuitem"]', 'Enabled', () => {
    s.status[id] = 'Enabled'
  })
  on('input[role="switch"]', undefined, () => {
    s.status[id] = s.status[id] === 'Paused' ? 'Enabled' : 'Paused'
  })
  on('[role="dialog"] material-button', 'Save', () => {
    const v = (
      doc.querySelector('[role="dialog"] input[aria-label="Budget"]') as HTMLInputElement | null
    )?.value
    if (v !== undefined && v !== '') s.budget[id] = v
  })
  doc.querySelector('input[type="file"]')?.addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (f !== undefined) s.uploaded = { name: f.name, mime: f.type, bytes: new Uint8Array() }
  })
  doc.querySelector('[role="dialog"] textarea')?.addEventListener('change', (e) => {
    s.pasted = (e.target as HTMLTextAreaElement).value
  })
}

export class FakePage implements ActionPage {
  doc: Document = new JSDOM('').window.document
  current = 'about:blank'
  readonly visited: string[] = []
  readonly clicks: string[] = []
  readonly captures: number[] = []

  constructor(readonly state: FakeState) {}

  private load(url: string): void {
    const target = this.state.redirect?.from.test(url) === true ? this.state.redirect.to : url
    this.current = target
    const dom = new JSDOM(render(target, this.state), { url: target })
    this.doc = dom.window.document
    wire(target, this.doc, this.state, () => this.load(this.current))
  }

  async url(): Promise<string> {
    return this.current
  }
  async goto(url: string): Promise<{ finalUrl: string }> {
    this.visited.push(url)
    this.load(url)
    return { finalUrl: this.current }
  }
  async look() {
    return domLook(this.doc, this.current)
  }
  async waitFor(selector: string): Promise<boolean> {
    return domCount(this.doc, selector) > 0
  }
  async click(selector: string) {
    this.clicks.push(selector)
    return domClick(this.doc, selector)
  }
  async fill(selector: string, value: string) {
    return domFill(this.doc, selector, value)
  }
  async setFile(selector: string, file: SheetFile) {
    const out = domSetFile(this.doc, selector, file)
    // jsdom 的 change 监听拿不到 File 的字节：这里把整份记下来给断言用
    if (out.ok) this.state.uploaded = file
    return out
  }
  async paste(selector: string, text: string) {
    return domPaste(this.doc, selector, text)
  }
  async text(selector: string) {
    return domText(this.doc, selector)
  }
  async count(selector: string) {
    return domCount(this.doc, selector)
  }
  async capture() {
    this.captures.push(this.visited.length)
    return { ok: true as const, png_base64: 'iVBORw0KGgo=' }
  }
  async download(selector: string) {
    const out = domClick(this.doc, selector)
    if (!out.ok) return out
    return { ok: true as const, path: '/fake/downloads/export.csv', name: 'export.csv', bytes: 12 }
  }
}
