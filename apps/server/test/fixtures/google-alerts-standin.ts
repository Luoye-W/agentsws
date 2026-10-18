/**
 * WP387：Google 提醒页的**替身浏览器**（测试用，不连真 Google）。
 *
 * - {@link FakeGoogleAlerts}：一个记状态的假提醒页（列表 / 显示选项后的表单 / 登录页 / 验证码页 / 改版后认不出的页），
 *   页面用 `google-alerts/*.html` 那几份手写替身渲染；
 * - {@link FakeBsk}：替身版的六个 `bsk_*` 工具（打开、看页面、填、点、选、请人接管）。**每一次调用都先过真门禁那一道**
 *   （`dsh-adapter` 的读写分类 + 受保护页面的「先有卡」），被拦了就不执行；
 * - {@link driveAlerts}：照技能说明「google-alerts」一步步做的剧本（替身模型）。认页面用的字**从技能说明那张表里读**——
 *   页面改版时只改说明，剧本跟着变。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ExistingGoogleAlert,
  GoogleAlertLine,
  GoogleAlertReportLine,
  GoogleAlertsReport,
  RunBrowserGrant,
} from '@agentsws/contracts'
import { GOOGLE_ALERTS_PAGE_URL } from '@agentsws/contracts'
import { classifyBrowserSkillEffect, createBrowserWriteGuard } from '@agentsws/dsh-adapter'
import { normalizeAlertQuery } from '@agentsws/pr-core'
import { readBundledSkill } from '@agentsws/skills'

const DIR = join(__dirname, 'google-alerts')
const tpl = (name: string): string => readFileSync(join(DIR, name), 'utf8')
const esc = (s: string): string =>
  s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
const unesc = (s: string): string =>
  s.replace(/&quot;/gu, '"').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&')

export interface FakeAlert {
  id: string
  query: string
  delivery: 'rss' | 'email'
  frequency: string
  sources: string
  language: string
  region: string
  how_many: string
}

interface Form {
  query: string
  open: boolean
  editing?: string
  frequency: string
  sources: string
  language: string
  region: string
  how_many: string
  deliver: string
}

const blank = (): Form => ({
  query: '',
  open: false,
  frequency: 'once_a_day',
  sources: 'automatic',
  language: 'en',
  region: 'any',
  how_many: 'best',
  deliver: 'email',
})

const OPTIONS: Record<string, [string, string][]> = {
  frequency: [
    ['as_it_happens', 'As-it-happens'],
    ['once_a_day', 'At most once a day'],
    ['once_a_week', 'At most once a week'],
  ],
  sources: [
    ['automatic', 'Automatic'],
    ['news', 'News'],
    ['blogs', 'Blogs'],
    ['web', 'Web'],
  ],
  language: [
    ['any', 'Any Language'],
    ['en', 'English'],
    ['de', 'German'],
    ['fr', 'French'],
  ],
  region: [
    ['any', 'Any Region'],
    ['US', 'United States'],
    ['DE', 'Germany'],
    ['GB', 'United Kingdom'],
  ],
  how_many: [
    ['best', 'Only the best results'],
    ['all', 'All results'],
  ],
  deliver: [
    ['email', 'you@example.test'],
    ['rss', 'RSS feed'],
  ],
}
const FIELD_OF_LABEL: Record<string, keyof typeof OPTIONS> = {
  'How often': 'frequency',
  Sources: 'sources',
  Language: 'language',
  Region: 'region',
  'How many': 'how_many',
  'Deliver to': 'deliver',
}

/** 一个记状态的假提醒页。 */
export class FakeGoogleAlerts {
  signedIn = true
  captcha = false
  redesigned = false
  /** 请人接管时，人能不能把登录 / 验证码处理掉。 */
  helpResolves = true
  alerts: FakeAlert[] = []
  form: Form = blank()
  created = 0
  updated = 0
  deleted = 0
  helps = 0
  private seq = 1000

  feedUrl(id: string): string {
    return `https://www.google.com/alerts/feeds/00000000000000000000/${id}`
  }

  add(query: string, delivery: 'rss' | 'email', extra: Partial<FakeAlert> = {}): FakeAlert {
    const a: FakeAlert = {
      id: String(this.seq++),
      query,
      delivery,
      frequency: delivery === 'rss' ? 'as_it_happens' : 'once_a_day',
      sources: 'automatic',
      language: 'en',
      region: 'any',
      how_many: 'best',
      ...extra,
    }
    this.alerts.push(a)
    return a
  }

  page(): 'signin' | 'captcha' | 'redesigned' | 'list' {
    if (!this.signedIn) return 'signin'
    if (this.captcha) return 'captcha'
    return this.redesigned ? 'redesigned' : 'list'
  }

  private rows(): string {
    const row = tpl('alert-row.html')
    return this.alerts
      .map((a) =>
        row
          .replace('{{ID}}', a.id)
          .replace('{{QUERY}}', esc(a.query))
          .replace(
            '{{RSS}}',
            a.delivery === 'rss'
              ? `<a href="${this.feedUrl(a.id)}" aria-label="RSS feed">RSS</a>`
              : '',
          ),
      )
      .join('\n')
  }

  html(): string {
    const p = this.page()
    if (p === 'signin') return tpl('signin.html')
    if (p === 'captcha') return tpl('captcha.html')
    if (p === 'redesigned')
      return tpl('redesigned.html')
        .replace('{{COUNT}}', String(this.alerts.length))
        .replace('{{ALERTS}}', this.rows())
    const select = (field: keyof Form & keyof typeof OPTIONS): string =>
      (OPTIONS[field] ?? [])
        .map(([v, label]) => {
          const disabled = field === 'deliver' && v === 'rss' && this.form.frequency !== 'as_it_happens'
          return `<option value="${v}"${this.form[field] === v ? ' selected' : ''}${disabled ? ' disabled' : ''}>${label}</option>`
        })
        .join('')
    const options = this.form.open
      ? tpl('options.html')
          .replace('{{FREQUENCY}}', select('frequency'))
          .replace('{{SOURCES}}', select('sources'))
          .replace('{{LANGUAGE}}', select('language'))
          .replace('{{REGION}}', select('region'))
          .replace('{{HOW_MANY}}', select('how_many'))
          .replace('{{DELIVER}}', select('deliver'))
      : ''
    return tpl('list.html')
      .replace('{{QUERY}}', esc(this.form.query))
      .replace('{{OPEN}}', String(this.form.open))
      .replace('{{OPTIONS}}', options)
      .replace('{{SUBMIT}}', this.form.editing === undefined ? 'Create Alert' : 'Update alert')
      .replace('{{COUNT}}', String(this.alerts.length))
      .replace('{{ALERTS}}', this.rows())
  }

  /** 点「创建 / 更新」。 */
  submit(): string | undefined {
    const f = this.form
    if (f.query.trim() === '') return '查询语句是空的'
    const fields = {
      frequency: f.frequency,
      sources: f.sources,
      language: f.language,
      region: f.region,
      how_many: f.how_many,
      delivery: f.deliver === 'rss' ? ('rss' as const) : ('email' as const),
    }
    if (f.editing !== undefined) {
      const a = this.alerts.find((x) => x.id === f.editing)
      if (a === undefined) return '这条提醒不在了'
      Object.assign(a, fields)
      this.updated += 1
    } else {
      this.alerts.push({ id: String(this.seq++), query: f.query.trim(), ...fields })
      this.created += 1
    }
    this.form = blank()
    return undefined
  }
}

/* ── 替身版 bsk_* ───────────────────────────────────────────────────── */

interface El {
  ref: string
  role: 'textbox' | 'link' | 'button' | 'combobox' | 'checkbox'
  label: string
  href?: string
  value?: string
  options?: { value: string; label: string; disabled: boolean }[]
  /** 在列表的哪一行里（那一行的提醒 id）。 */
  row?: string
}

const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`${name}="([^"]*)"`, 'u').exec(attrs)
  return m?.[1] === undefined ? undefined : unesc(m[1])
}
const text = (s: string): string => unesc(s.replace(/<[^>]+>/gu, '').trim())

/** 页面 → 一份「看得见的东西」（像 snapshot：可操作的元素带 @eN）。 */
export function snapshotOf(html: string): { lines: string[]; els: El[] } {
  const re =
    /<input\b([^>]*)>|<a\b([^>]*)>(.*?)<\/a>|<button\b([^>]*)>(.*?)<\/button>|<select\b([^>]*)>(.*?)<\/select>|<h[12]\b[^>]*>(.*?)<\/h[12]>|<p\b[^>]*>(.*?)<\/p>|<li\b([^>]*)>|(<\/li>)|<span class="query">(.*?)<\/span>|<title>(.*?)<\/title>/gsu
  const lines: string[] = []
  const els: El[] = []
  let row: string | undefined
  let n = 0
  const push = (el: Omit<El, 'ref'>): void => {
    n += 1
    const e: El = { ref: `@e${n}`, ...el, ...(row === undefined ? {} : { row }) }
    els.push(e)
    const extra = [
      e.href === undefined ? '' : ` href="${e.href}"`,
      e.value === undefined ? '' : ` value="${e.value}"`,
      e.options === undefined
        ? ''
        : ` options="${e.options.map((o) => `${o.label}${o.disabled ? '(disabled)' : ''}`).join(' | ')}"`,
    ].join('')
    lines.push(`${row === undefined ? '' : '  '}${e.ref} ${e.role} "${e.label}"${extra}`)
  }
  for (const m of html.matchAll(re)) {
    if (m[1] !== undefined) {
      const type = attr(m[1], 'type') ?? 'text'
      push({
        role: type === 'checkbox' ? 'checkbox' : 'textbox',
        label: attr(m[1], 'aria-label') ?? attr(m[1], 'placeholder') ?? '',
        value: attr(m[1], 'value') ?? '',
      })
    } else if (m[2] !== undefined) {
      const href = attr(m[2], 'href')
      push({
        role: 'link',
        label: attr(m[2], 'aria-label') ?? text(m[3] ?? ''),
        ...(href === undefined || href === '#' ? {} : { href }),
      })
    } else if (m[4] !== undefined) {
      push({ role: 'button', label: attr(m[4], 'aria-label') ?? text(m[5] ?? '') })
    } else if (m[6] !== undefined) {
      const options = [...(m[7] ?? '').matchAll(/<option\b([^>]*)>(.*?)<\/option>/gsu)].map(
        (o) => ({
          value: attr(o[1] ?? '', 'value') ?? '',
          label: text(o[2] ?? ''),
          disabled: /\bdisabled\b/u.test(o[1] ?? ''),
          selected: /\bselected\b/u.test(o[1] ?? ''),
        }),
      )
      push({
        role: 'combobox',
        label: attr(m[6], 'aria-label') ?? '',
        value: options.find((o) => o.selected)?.label ?? '',
        options: options.map(({ selected: _s, ...o }) => o),
      })
    } else if (m[8] !== undefined) lines.push(`heading "${text(m[8])}"`)
    else if (m[9] !== undefined) lines.push(`text "${text(m[9])}"`)
    else if (m[10] !== undefined) {
      row = attr(m[10], 'data-id')
      lines.push(`listitem`)
    } else if (m[11] !== undefined) row = undefined
    else if (m[12] !== undefined) lines.push(`  text "${text(m[12])}"`)
    else if (m[13] !== undefined) lines.push(`title "${text(m[13])}"`)
  }
  return { lines, els }
}

export type BskCall = { tool: string; args: Record<string, unknown> }
export type BskResult = { ok: true; snapshot?: string } | { ok: false; blocked?: string; error?: string }

/**
 * 替身版六个 `bsk_*`。每一次调用先过真门禁那一道（读写分类 + 受保护页面「先有卡」）。
 * 只认 Google 提醒页；`log` 记下每一次调用（测「一条一条来、不并发」「只碰卡上那几条」）。
 */
export class FakeBsk {
  readonly log: (BskCall & { result: BskResult })[] = []
  private els: El[] = []
  private readonly guard

  constructor(
    readonly site: FakeGoogleAlerts,
    grants: readonly RunBrowserGrant[] | undefined,
  ) {
    this.guard = createBrowserWriteGuard(grants)
  }

  async call(tool: string, args: Record<string, unknown>): Promise<BskResult> {
    const effect = classifyBrowserSkillEffect(tool, args)
    const blocked = this.guard.check({ tool, args, effect })
    const result: BskResult =
      blocked !== undefined ? { ok: false, blocked } : this.exec(tool, args)
    this.log.push({ tool, args, result })
    return result
  }

  private exec(tool: string, args: Record<string, unknown>): BskResult {
    const action = args.action
    if (tool === 'bsk_page' && action === 'navigate') {
      if (args.url !== GOOGLE_ALERTS_PAGE_URL) return { ok: false, error: 'not_found' }
      this.site.form = blank()
      return { ok: true }
    }
    if (tool === 'bsk_inspect' && action === 'snapshot') {
      const snap = snapshotOf(this.site.html())
      this.els = snap.els
      return { ok: true, snapshot: snap.lines.join('\n') }
    }
    if (tool === 'bsk_assist' && action === 'request-help') {
      this.site.helps += 1
      if (this.site.helpResolves) {
        this.site.signedIn = true
        this.site.captcha = false
      }
      return { ok: true }
    }
    if (tool === 'bsk_interact') {
      const el = this.els.find((e) => e.ref === args.target)
      if (el === undefined) return { ok: false, error: 'stale_ref' }
      if (action === 'fill' && el.role === 'textbox') {
        this.site.form.query = String(args.value ?? '')
        return { ok: true }
      }
      if (action === 'select' && el.role === 'combobox') {
        const field = FIELD_OF_LABEL[el.label]
        const opt = el.options?.find((o) => o.label === args.value || o.value === args.value)
        if (field === undefined || opt === undefined) return { ok: false, error: 'no_such_option' }
        if (opt.disabled) return { ok: false, error: 'option_disabled' }
        ;(this.site.form as unknown as Record<string, string>)[field] = opt.value
        return { ok: true }
      }
      if (action === 'click') {
        if (el.label === 'Show options') {
          this.site.form.open = true
          return { ok: true }
        }
        if (el.label === 'Create Alert' || el.label === 'Update alert') {
          const err = this.site.submit()
          return err === undefined ? { ok: true } : { ok: false, error: err }
        }
        if (el.label === 'Edit alert' && el.row !== undefined) {
          const a = this.site.alerts.find((x) => x.id === el.row)
          if (a === undefined) return { ok: false, error: 'gone' }
          this.site.form = {
            query: a.query,
            open: true,
            editing: a.id,
            frequency: a.frequency,
            sources: a.sources,
            language: a.language,
            region: a.region,
            how_many: a.how_many,
            deliver: a.delivery,
          }
          return { ok: true }
        }
        if (el.label === 'Delete alert' && el.row !== undefined) {
          this.site.alerts = this.site.alerts.filter((x) => x.id !== el.row)
          this.site.deleted += 1
          return { ok: true }
        }
      }
      return { ok: false, error: 'nothing_happened' }
    }
    return { ok: true }
  }
}

/* ── 照技能说明做的剧本（替身模型）────────────────────────────────── */

/** 技能说明那张「页面上怎么认」表里的字（英文界面那一列）+ 出岔子那张表里括号里的字。 */
export interface AlertsCues {
  input: string
  showOptions: string
  selects: { label: string; option: string; key: string }[]
  create: string
  update: string
  list: string
  feedPath: string
  edit: string
  signIn: string[]
  captcha: string[]
}

export function cuesFromSkill(markdown = readBundledSkill('google-alerts').markdown): AlertsCues {
  const rows = new Map<string, string[]>()
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| ')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cells[0] !== undefined) rows.set(cells[0], cells)
  }
  const en = (key: string): string => rows.get(key)?.[1] ?? `<缺：${key}>`
  const pair = (key: string): { label: string; option: string } => {
    const [label, option] = en(key).split('→').map((s) => s.trim())
    return { label: label ?? '', option: option ?? '' }
  }
  const lang = pair('语言 / 地区')
  const [langLabel, regionLabel] = lang.label.split('/').map((s) => s.trim())
  const inParens = (prefix: string): string[] => {
    const k = [...rows.keys()].find((x) => x.startsWith(prefix)) ?? ''
    return (/（(.*)）/u.exec(k)?.[1] ?? '').split('/').map((s) => s.trim())
  }
  return {
    input: en('新建的输入框'),
    showOptions: en('显示选项'),
    selects: [
      { ...pair('频率'), key: 'frequency' },
      { ...pair('来源'), key: 'sources' },
      { label: langLabel ?? '', option: '', key: 'language' },
      { label: regionLabel ?? '', option: lang.option, key: 'region' },
      { ...pair('数量'), key: 'how_many' },
      { ...pair('投递'), key: 'deliver' },
    ],
    create: en('创建'),
    update: en('更新'),
    list: en('我的提醒列表'),
    feedPath: /`([^`]+)`/u.exec(rows.get('RSS 链接')?.[3] ?? '')?.[1] ?? '/alerts/feeds/',
    edit: en('编辑一条').replace(/（.*）/u, '').trim(),
    signIn: inParens('要登录'),
    captcha: inParens('验证码'),
  }
}

/** 一个 `ga_*` 行在这份替身页上的语言 / 地区该选哪一项（`any` = 不限那一项）。 */
const LANG_LABEL: Record<string, string> = { any: 'Any Language', en: 'English', de: 'German', fr: 'French' }
const REGION_LABEL: Record<string, string> = {
  any: 'Any Region',
  US: 'United States',
  DE: 'Germany',
  GB: 'United Kingdom',
}

export interface DriveTask {
  change_id?: string
  op?: 'create' | 'to_rss'
  lines?: GoogleAlertLine[]
}

/**
 * 照技能说明一步步做：打开 → 看 → 卡住请人 → 认不出就停 → 一条一条建 / 改 → 读回链接 → 交代。
 * 回的就是交给 `report_google_alerts` 的那一份。
 */
export async function driveAlerts(
  bsk: FakeBsk,
  task: DriveTask,
  cues: AlertsCues = cuesFromSkill(),
): Promise<GoogleAlertsReport> {
  const lines = task.lines ?? []
  const results: GoogleAlertReportLine[] = []
  const done = new Set<string>()
  const finish = (stop: GoogleAlertsReport['stop'], note?: string, existing?: ExistingGoogleAlert[]) => {
    for (const l of lines)
      if (!done.has(l.id)) results.push({ id: l.id, outcome: 'not_attempted' })
    return {
      ...(task.change_id === undefined ? {} : { change_id: task.change_id }),
      lines: results,
      ...(existing === undefined ? {} : { existing }),
      stop,
      ...(note === undefined ? {} : { note }),
    }
  }
  const look = async (): Promise<{ text: string; els: El[] }> => {
    const r = await bsk.call('bsk_inspect', { action: 'snapshot' })
    const text = r.ok ? (r.snapshot ?? '') : ''
    return { text, els: snapshotOf(bsk.site.html()).els }
  }
  const has = (text: string, words: string[]) => words.some((w) => w !== '' && text.includes(w))

  await bsk.call('bsk_page', { action: 'navigate', url: GOOGLE_ALERTS_PAGE_URL })
  let page = await look()
  for (const [words, stop] of [
    [cues.signIn, 'not_signed_in'],
    [cues.captcha, 'captcha'],
  ] as const) {
    if (!has(page.text, [...words])) continue
    await bsk.call('bsk_assist', { action: 'request-help', prompt: '请你在浏览器里处理一下这一步' })
    page = await look()
    if (has(page.text, [...words])) return finish(stop, '等你处理那一步，还没处理完')
  }
  if (!page.text.includes(cues.input) || !page.text.includes(cues.list))
    return finish('page_changed', `找不到「${cues.input}」或「${cues.list}」`)

  const readRows = (els: El[]): ExistingGoogleAlert[] => {
    const html = bsk.site.html()
    const out: ExistingGoogleAlert[] = []
    for (const m of html.matchAll(/<li class="alert" data-id="([^"]+)"><span class="query">(.*?)<\/span>/gsu)) {
      const id = m[1] ?? ''
      const feed = els.find((e) => e.row === id && e.href?.includes(cues.feedPath) === true)
      out.push({
        query: unesc(m[2] ?? ''),
        delivery: feed === undefined ? 'email' : 'rss',
        ...(feed?.href === undefined ? {} : { feed_url: feed.href }),
      })
    }
    return out
  }
  const rowIdOf = (query: string): string | undefined => {
    const html = bsk.site.html()
    for (const m of html.matchAll(/<li class="alert" data-id="([^"]+)"><span class="query">(.*?)<\/span>/gsu))
      if (normalizeAlertQuery(unesc(m[2] ?? '')) === normalizeAlertQuery(query)) return m[1]
    return undefined
  }
  const existing = readRows(page.els)
  if (task.change_id === undefined) return finish('done', undefined, existing)

  /** 把下拉框照技能说明设好；有一样认不出就回那一样。 */
  const setOptions = async (line: GoogleAlertLine): Promise<string | undefined> => {
    for (const sel of cues.selects) {
      const { els } = await look()
      const el = els.find((e) => e.role === 'combobox' && e.label === sel.label)
      if (el === undefined) return sel.label
      const want =
        sel.key === 'language'
          ? (LANG_LABEL[line.language] ?? line.language)
          : sel.key === 'region'
            ? (REGION_LABEL[line.region] ?? line.region)
            : sel.option
      const r = await bsk.call('bsk_interact', { action: 'select', target: el.ref, value: want })
      if (!r.ok) return r.blocked ?? `${sel.label} → ${want}`
    }
    return undefined
  }
  const clickBy = async (label: string, row?: string): Promise<BskResult | undefined> => {
    const { els } = await look()
    const el = els.find((e) => e.label === label && (row === undefined || e.row === row))
    return el === undefined
      ? undefined
      : bsk.call('bsk_interact', { action: 'click', target: el.ref })
  }
  const feedOf = async (query: string): Promise<string | undefined> => {
    const { els } = await look()
    const id = rowIdOf(query)
    return els.find((e) => e.row === id && e.href?.includes(cues.feedPath) === true)?.href
  }

  for (const line of lines) {
    if (task.op !== 'to_rss') {
      const had = existing.find((e) => normalizeAlertQuery(e.query) === normalizeAlertQuery(line.query))
      if (had !== undefined) {
        results.push(
          had.delivery === 'rss' && had.feed_url !== undefined
            ? { id: line.id, outcome: 'existing', feed_url: had.feed_url }
            : { id: line.id, outcome: 'existing_email' },
        )
        done.add(line.id)
        continue
      }
      const { els } = await look()
      const input = els.find((e) => e.role === 'textbox' && e.label === cues.input)
      if (input === undefined) return finish('page_changed', `找不到「${cues.input}」`)
      const filled = await bsk.call('bsk_interact', { action: 'fill', target: input.ref, value: line.query })
      if (!filled.ok) return finish('other', filled.blocked ?? filled.error)
      const shown = await clickBy(cues.showOptions)
      if (shown === undefined) return finish('page_changed', `找不到「${cues.showOptions}」`)
      if (!shown.ok) return finish('other', shown.blocked ?? shown.error)
      const bad = await setOptions(line)
      if (bad !== undefined) return finish('page_changed', `「${bad}」对不上`)
      const created = await clickBy(cues.create)
      if (created === undefined) return finish('page_changed', `找不到「${cues.create}」`)
      done.add(line.id)
      if (!created.ok) {
        results.push({ id: line.id, outcome: 'failed', reason: created.error ?? '没反应' })
        continue
      }
      const feed = await feedOf(line.query)
      results.push(
        feed === undefined
          ? { id: line.id, outcome: 'failed', reason: '建好了但没读到 RSS 链接' }
          : { id: line.id, outcome: 'created', feed_url: feed },
      )
      continue
    }
    // 改成 RSS
    const id = rowIdOf(line.query)
    done.add(line.id)
    if (id === undefined) {
      results.push({ id: line.id, outcome: 'failed', reason: '列表里没找到这一条' })
      continue
    }
    const opened = await clickBy(`${cues.edit} alert`, id)
    if (opened === undefined) return finish('page_changed', `找不到「${cues.edit}」`)
    if (!opened.ok) return finish('other', opened.blocked ?? opened.error)
    for (const sel of cues.selects.filter((s) => s.key === 'frequency' || s.key === 'deliver')) {
      const { els } = await look()
      const el = els.find((e) => e.role === 'combobox' && e.label === sel.label)
      if (el === undefined) return finish('page_changed', `「${sel.label}」对不上`)
      await bsk.call('bsk_interact', { action: 'select', target: el.ref, value: sel.option })
    }
    const updated = await clickBy(cues.update)
    if (updated === undefined) return finish('page_changed', `找不到「${cues.update}」`)
    const feed = await feedOf(line.query)
    results.push(
      feed === undefined
        ? { id: line.id, outcome: 'failed', reason: '改完没读到 RSS 链接' }
        : { id: line.id, outcome: 'switched', feed_url: feed },
    )
  }
  return finish('done')
}
