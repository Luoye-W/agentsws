/**
 * WP315：本地假后台的「报表」那几页（只在内存里，**不联网、不碰真站**）。照步骤表里的选择器搭出最小的页面：
 * 另存为会把名字记进「保存报表」，点报表名字打开它，点下载回一个假路径（文件名就是报表名）。
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
  GOOGLE_REPORT_COLUMNS,
  META_REPORT_BREAKDOWNS,
  META_REPORT_METRICS,
  type SheetFile,
} from '../src/index.js'

export interface FakeReportState {
  saved: string[]
  opened?: string
  downloads: string[]
  /** 打开报表编辑器时被换成验证码页。 */
  captcha?: boolean
}

const page = (body: string): string =>
  `<!doctype html><html><head><title>Reports</title></head><body>${body}</body></html>`
const opts = (names: readonly string[]): string =>
  [...new Set(names)].map((n) => `<div role="option">${n}</div>`).join('')
const links = (s: FakeReportState): string => s.saved.map((n) => `<a href="#">${n}</a>`).join('')

function render(url: string, s: FakeReportState): string {
  const p = new URL(url).pathname
  if (s.captcha === true)
    return page('<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>')
  if (p === '/aw/reporting/reporteditor') {
    const presets = ['Campaign', 'Ad group', 'Ad', 'Search keyword', 'Search terms']
    return page(`
      <material-button>Predefined reports (Dimensions)</material-button>
      ${presets.map((x) => `<div role="menuitem">${x}</div>`).join('')}
      <div data-report="table"></div>
      <button aria-label="Columns">c</button><button aria-label="Segment">s</button>
      <div role="menuitem">Day</div>
      <button aria-label="Date range">d</button><div role="menuitem">Last 7 days</div>
      <div role="checkbox" aria-label="Include today"></div>
      <material-button>Save as</material-button>
      <button aria-label="Download">dl</button><div role="menuitem">.csv</div>
      <div role="dialog">
        <input aria-label="Search columns">${opts(Object.values(GOOGLE_REPORT_COLUMNS).flat())}
        <material-button>Apply</material-button>
        <input aria-label="Report name"><material-button>Save</material-button>
      </div>
      ${links(s)}`)
  }
  if (p === '/adsmanager/reporting/manage')
    return page(`
      <div role="button">Create report</div><div role="menuitem">Pivot table</div>
      <div data-report="editor"></div>
      <button aria-label="Breakdowns">b</button><button aria-label="Metrics">m</button>
      <button aria-label="Date range">d</button><div role="menuitem">Last 7 days</div>
      <div role="checkbox" aria-label="Include today"></div><div role="button">Update</div>
      <div role="button">Save as</div><div role="button">Export</div><div role="menuitem">.csv</div>
      <div role="dialog">
        <input type="search">${opts([...META_REPORT_BREAKDOWNS, ...META_REPORT_METRICS])}
        <div role="button">Done</div>
        <input name="report_name"><div role="button">Save</div>
      </div>
      ${links(s)}`)
  return page('<p>not found</p>')
}

export class FakeReportPage implements ActionPage {
  doc: Document = new JSDOM('').window.document
  current = 'about:blank'
  readonly visited: string[] = []

  constructor(readonly state: FakeReportState) {}

  private load(url: string): void {
    this.current = url
    this.doc = new JSDOM(render(url, this.state), { url }).window.document
    const save = Array.from(this.doc.querySelectorAll('[role="dialog"] *')).find(
      (el) => el.textContent?.trim() === 'Save',
    )
    save?.addEventListener('click', () => {
      const input = this.doc.querySelector<HTMLInputElement>(
        '[role="dialog"] input[aria-label="Report name"], [role="dialog"] input[name="report_name"]',
      )
      const name = input?.value ?? ''
      if (name !== '' && !this.state.saved.includes(name)) this.state.saved.push(name)
      this.load(this.current)
    })
    for (const a of Array.from(this.doc.querySelectorAll('a')))
      a.addEventListener('click', () => {
        this.state.opened = a.textContent?.trim()
      })
  }

  async url() {
    return this.current
  }
  async goto(url: string) {
    this.visited.push(url)
    this.load(url)
    return { finalUrl: this.current }
  }
  async look() {
    return domLook(this.doc, this.current)
  }
  async waitFor(selector: string) {
    return domCount(this.doc, selector) > 0
  }
  async click(selector: string) {
    return domClick(this.doc, selector)
  }
  async fill(selector: string, value: string) {
    return domFill(this.doc, selector, value)
  }
  async setFile(selector: string, file: SheetFile) {
    return domSetFile(this.doc, selector, file)
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
    return { ok: true as const, png_base64: 'iVBORw0KGgo=' }
  }
  async download(selector: string) {
    const out = domClick(this.doc, selector)
    if (!out.ok) return out
    const name = `${this.state.opened ?? 'report'}.csv`
    this.state.downloads.push(name)
    return { ok: true as const, path: `/fake/downloads/${name}`, name, bytes: 100 }
  }
}
