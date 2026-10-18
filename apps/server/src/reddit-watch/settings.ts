/**
 * WP328：巡查设置（每品牌一份，存在 `reddit-watch.sqlite` 的杂项表里）+ 配置卡的设置目标 `reddit.watch`。
 *
 * 版块名、关键词、频率都由用户给；缺了就出配置卡（WP324），卡上预填 WP249 已登记的自家版 / 品牌号。
 * 这里不替用户定任何运营规矩。
 *
 * WP340：加重点版块、按版块分频率（卡上写在版块名后面：`Xreal（每周）`、`SmartGlasses（每周3次）`）、
 * 告警词、标签词；第一次出卡时预填 AI 按品牌档案给的建议（每格一句理由），没模型就留空。老设置原样读（新格子为空）。
 */
import { normalizeSubreddit } from '@agentsws/browser-action'
import {
  REDDIT_WATCH_DEFAULTS,
  type RedditWatchSettings,
  type SetupField,
  type WorkspaceId,
} from '@agentsws/contracts'
import { SetupCardError, type SetupTarget } from '../setup-cards.js'
import type { SetupPlan, SetupResearchKit } from '../setup-research.js'
import type { RedditWatchStore } from './store.js'

export const REDDIT_WATCH_TARGET = 'reddit.watch'
const KEY = 'settings'
const USER = /^[A-Za-z0-9_-]{3,20}$/u

export const MAX_KEYWORDS = 30
export const MAX_SUBS = 5
/** WP340：重点版块最多几个、告警词 / 标签词最多几个、每个多长。 */
export const MAX_WATCH_SUBS = 10
export const MAX_ALERT_WORDS = 30
export const MAX_TAG_WORDS = 50
const TERM_LEN = 40

/** 用户给的一串（逗号 / 顿号 / 换行分开）→ 去重的几项。 */
export function splitList(raw: string): string[] {
  const out: string[] = []
  for (const s of raw.split(/[,，、;；\n]/u)) {
    const t = s.trim()
    if (t !== '' && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
}

/** 收进合法范围（认不出的格用默认值）。版块名不合法直接丢。 */
export function normalizeSettings(
  raw: Partial<RedditWatchSettings> | undefined,
): RedditWatchSettings {
  const d = REDDIT_WATCH_DEFAULTS
  const subs: string[] = []
  for (const s of raw?.own_subreddits ?? []) {
    const n = normalizeSubreddit(String(s))
    if (n !== undefined && !subs.some((x) => x.toLowerCase() === n.toLowerCase())) subs.push(n)
  }
  const keywords = splitList((raw?.keywords ?? []).map(String).join('\n'))
    .map((k) => k.slice(0, 60))
    .slice(0, MAX_KEYWORDS)
  const own = subs.slice(0, MAX_SUBS)
  const watch: string[] = []
  for (const s of raw?.watch_subreddits ?? []) {
    const n = normalizeSubreddit(String(s))
    if (n === undefined) continue
    const k = n.toLowerCase()
    if (own.some((x) => x.toLowerCase() === k) || watch.some((x) => x.toLowerCase() === k)) continue
    watch.push(n)
  }
  const known = new Set([...own, ...watch].map((x) => x.toLowerCase()))
  const perWeek: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw?.sub_per_week ?? {})) {
    const key = normalizeSubreddit(k)?.toLowerCase()
    const n = Number(v)
    if (key !== undefined && known.has(key) && Number.isFinite(n))
      perWeek[key] = Math.max(1, Math.min(7, Math.round(n)))
  }
  const terms = (list: unknown[] | undefined, max: number): string[] =>
    splitList((list ?? []).map(String).join('\n'))
      .map((k) => k.slice(0, TERM_LEN))
      .slice(0, max)
  const user = String(raw?.brand_username ?? '')
    .trim()
    .replace(/^\/?u\//iu, '')
  const out: RedditWatchSettings = {
    own_subreddits: own,
    keywords,
    every_hours: clampInt(raw?.every_hours, 1, 168, d.every_hours),
    day_start_hour: clampInt(raw?.day_start_hour, 0, 23, d.day_start_hour),
    keyword_limit: clampInt(raw?.keyword_limit, 1, 50, d.keyword_limit),
    enabled: raw?.enabled ?? d.enabled,
    watch_subreddits: watch.slice(0, MAX_WATCH_SUBS),
    sub_per_week: perWeek,
    alert_words: terms(raw?.alert_words, MAX_ALERT_WORDS),
    tag_words: terms(raw?.tag_words, MAX_TAG_WORDS),
  }
  if (USER.test(user)) out.brand_username = user
  // WP411：第一次外部巡查往回补几天（1–31；不给 = 默认 7 天）
  if (raw?.external_backfill_days !== undefined)
    out.external_backfill_days = clampInt(raw.external_backfill_days, 1, 31, 7)
  return out
}

export function readSettings(store: RedditWatchStore, ws: WorkspaceId): RedditWatchSettings {
  return normalizeSettings(store.kv<Partial<RedditWatchSettings>>(ws, KEY))
}

export function writeSettings(
  store: RedditWatchStore,
  ws: WorkspaceId,
  patch: Partial<RedditWatchSettings>,
): RedditWatchSettings {
  const next = normalizeSettings({ ...readSettings(store, ws), ...patch })
  store.setKv(ws, KEY, next)
  return next
}

export const isConfigured = (s: RedditWatchSettings): boolean =>
  s.own_subreddits.length > 0 || s.keywords.length > 0 || (s.watch_subreddits ?? []).length > 0

/* ── WP340：版块后面写频率（`Xreal（每周）`）───────────────────────── */

/** 一周几次 → 卡上那几个字（7 每天、1 每周、其余「每周 n 次」）。 */
export function perWeekLabel(n: number): string {
  return n >= 7 ? '每天' : n <= 1 ? '每周' : `每周${n}次`
}

const FREQ_TAIL =
  /^(.+?)\s*(?:[:：]|[(（])?\s*(每天|天天|daily|每周\s*([1-7])\s*次|([1-7])\s*次\s*\/?\s*周|([1-7])\s*(?:x|times)?\s*\/\s*week|每周|每星期|weekly)\s*[)）]?$/iu

/**
 * 「ivraxr, SmartGlasses（每周3次）, Xreal 每周」→ 版块 + 各自一周几次（没写的不在表里 = 跟总频率，默认每天）。
 * 版块名不合法、频率认不出 → `bad` 里回那一项原样。
 */
export function parseSubList(raw: string): {
  subs: string[]
  per_week: Record<string, number>
  bad: string[]
} {
  const subs: string[] = []
  const per_week: Record<string, number> = {}
  const bad: string[] = []
  for (const item of splitList(raw)) {
    const m = FREQ_TAIL.exec(item)
    const name = normalizeSubreddit(m?.[1] ?? item)
    if (name === undefined) {
      bad.push(item)
      continue
    }
    const key = name.toLowerCase()
    if (subs.some((x) => x.toLowerCase() === key)) continue
    subs.push(name)
    if (m === null) continue
    const word = (m[2] ?? '').toLowerCase()
    const n = Number(m[3] ?? m[4] ?? m[5] ?? Number.NaN)
    per_week[key] = Number.isFinite(n)
      ? n
      : word === '每天' || word === '天天' || word === 'daily'
        ? 7
        : 1
  }
  return { subs, per_week, bad }
}

/** 版块 + 频率 → 卡上那一串（没单独设的只写名字）。 */
export function formatSubList(subs: readonly string[], perWeek: Record<string, number>): string {
  return subs
    .map((s) => {
      const n = perWeek[s.toLowerCase()]
      return n === undefined ? s : `${s}（${perWeekLabel(n)}）`
    })
    .join(', ')
}

/** 配置卡的建议值从哪来（WP249 登记的 Reddit 号 / 自家版）。 */
export interface SettingsSuggestions {
  own_subreddits?: string[]
  brand_username?: string
}

const textField = (
  key: string,
  label: string,
  placeholder: string,
  suggested: string,
  why: string | undefined,
): SetupField => ({
  key,
  label,
  kind: 'text',
  placeholder,
  ...(suggested === ''
    ? {}
    : { suggested, ...(why === undefined || why === '' ? {} : { suggested_why: why }) }),
  required: false,
})

const EVERY = [
  { value: '24', label: '每天一次' },
  { value: '12', label: '每 12 小时' },
  { value: '6', label: '每 6 小时' },
]

/**
 * 设置目标：版块（带频率）、关键词、告警词、标签词、品牌号、收件箱 / 关键词的频率。
 *
 * WP348（决策 887）：`fields()` 只给已存的与已知的事实（连接里登记的自家版）；AI 的方案由 `research`
 * 在出卡前查好（档案、插件里登着的号、联网搜索、问一次模型，见 `plan.ts`），卡面是「我打算这样设」。
 * 品牌号不让 AI 猜（`noGuess`）：只认插件里登着的 / 连接里登记的。
 */
export function redditWatchSetupTarget(input: {
  store: RedditWatchStore
  workspace_id: WorkspaceId
  suggestions?(): SettingsSuggestions | undefined
  /** WP348：出卡前怎么查（不给 = 只用已存的与已知的事实）。 */
  research?(kit: SetupResearchKit): Promise<SetupPlan>
}): SetupTarget {
  const ws = input.workspace_id
  return {
    id: REDDIT_WATCH_TARGET,
    name: 'Reddit 巡查',
    why: '要巡查哪些版块、盯哪些词，我先查了一遍，按这个方案巡查。',
    noGuess: ['brand_username'],
    ...(input.research === undefined ? {} : { research: input.research }),
    async fields(): Promise<SetupField[]> {
      const s = readSettings(input.store, ws)
      const hint = input.suggestions?.() ?? {}
      const per = s.sub_per_week ?? {}
      // 自家版块：已存的 → 连接里登记的（事实）；AI 的方案由 research 给
      let own = formatSubList(s.own_subreddits, per)
      let ownWhy: string | undefined
      if (own === '' && (hint.own_subreddits ?? []).length > 0) {
        own = (hint.own_subreddits ?? []).join(', ')
        ownWhy = '连接里登记的自家版'
      }
      return [
        textField('own_subreddits', '自家版块', 'ivraxr', own, ownWhy),
        textField(
          'watch_subreddits',
          '重点版块',
          'SmartGlasses, Xreal（每周）',
          formatSubList(s.watch_subreddits ?? [], per),
          undefined,
        ),
        textField('keywords', '关键词', '品牌、品类词，逗号分开', s.keywords.join(', '), undefined),
        textField(
          'alert_words',
          '告警词',
          'recall, refund',
          (s.alert_words ?? []).join(', '),
          undefined,
        ),
        textField(
          'tag_words',
          '标签词',
          '型号写法，如 Air3',
          (s.tag_words ?? []).join(', '),
          undefined,
        ),
        textField('brand_username', '品牌号', 'u/…', s.brand_username ?? '', undefined),
        {
          key: 'every_hours',
          label: '收件箱和关键词',
          kind: 'select',
          options: EVERY,
          suggested: String(s.every_hours),
          ...(isConfigured(s) ? {} : { suggested_why: '默认每天一次' }),
          required: true,
        },
      ]
    },
    async satisfied(): Promise<boolean> {
      return isConfigured(readSettings(input.store, ws))
    },
    async apply(values): Promise<void> {
      const own = parseSubList(values.own_subreddits ?? '')
      const watch = parseSubList(values.watch_subreddits ?? '')
      const bad = [...own.bad, ...watch.bad]
      if (bad.length > 0)
        throw new SetupCardError(
          'invalid_input',
          `认不出：${bad.slice(0, 3).join('、')}。版块名只能是字母、数字、下划线，频率写在后面（如 Xreal（每周））。`,
        )
      const keywords = splitList(values.keywords ?? '')
      if (own.subs.length === 0 && keywords.length === 0 && watch.subs.length === 0)
        throw new SetupCardError('invalid_input', '版块和关键词至少填一样。')
      const user = (values.brand_username ?? '').trim().replace(/^\/?u\//iu, '')
      if (user !== '' && !USER.test(user))
        throw new SetupCardError('invalid_input', '品牌号用户名不对（3–20 个字母、数字、_ 或 -）。')
      const patch: Partial<RedditWatchSettings> = {
        own_subreddits: own.subs,
        watch_subreddits: watch.subs,
        // 卡上写着的就是全部：没写频率的版块回到默认（跟总频率，默认每天）
        sub_per_week: { ...watch.per_week, ...own.per_week },
        keywords,
        alert_words: splitList(values.alert_words ?? ''),
        tag_words: splitList(values.tag_words ?? ''),
        ...(values.every_hours === undefined ? {} : { every_hours: Number(values.every_hours) }),
      }
      if (user !== '') patch.brand_username = user
      writeSettings(input.store, ws, patch)
    },
  }
}
