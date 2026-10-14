/**
 * WP328：巡查设置（每品牌一份，存在 `reddit-watch.sqlite` 的杂项表里）+ 配置卡的设置目标 `reddit.watch`。
 *
 * 版块名、关键词、频率都由用户给；缺了就出配置卡（WP324），卡上预填 WP249 已登记的自家版 / 品牌号。
 * 这里不替用户定任何运营规矩。
 */
import { normalizeSubreddit } from '@agentsws/browser-action'
import {
  REDDIT_WATCH_DEFAULTS,
  type RedditWatchSettings,
  type SetupField,
  type WorkspaceId,
} from '@agentsws/contracts'
import { SetupCardError, type SetupTarget } from '../setup-cards.js'
import type { RedditWatchStore } from './store.js'

export const REDDIT_WATCH_TARGET = 'reddit.watch'
const KEY = 'settings'
const USER = /^[A-Za-z0-9_-]{3,20}$/u
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u

export const MAX_KEYWORDS = 30
export const MAX_SUBS = 5

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
  const user = String(raw?.brand_username ?? '')
    .trim()
    .replace(/^\/?u\//iu, '')
  const out: RedditWatchSettings = {
    own_subreddits: subs.slice(0, MAX_SUBS),
    keywords,
    every_hours: clampInt(raw?.every_hours, 1, 168, d.every_hours),
    day_start_hour: clampInt(raw?.day_start_hour, 0, 23, d.day_start_hour),
    final_weekday: clampInt(raw?.final_weekday, 0, 6, d.final_weekday),
    final_time: TIME.test(String(raw?.final_time ?? '')) ? String(raw?.final_time) : d.final_time,
    keyword_limit: clampInt(raw?.keyword_limit, 1, 50, d.keyword_limit),
    enabled: raw?.enabled ?? d.enabled,
  }
  if (USER.test(user)) out.brand_username = user
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
  s.own_subreddits.length > 0 || s.keywords.length > 0

/** 配置卡的建议值从哪来（WP249 登记的 Reddit 号 / 自家版）。 */
export interface SettingsSuggestions {
  own_subreddits?: string[]
  brand_username?: string
}

const EVERY = [
  { value: '24', label: '每天一次' },
  { value: '12', label: '每 12 小时' },
  { value: '6', label: '每 6 小时' },
]

/** 设置目标：版块、关键词、品牌号、频率。 */
export function redditWatchSetupTarget(input: {
  store: RedditWatchStore
  workspace_id: WorkspaceId
  suggestions?(): SettingsSuggestions | undefined
}): SetupTarget {
  const ws = input.workspace_id
  return {
    id: REDDIT_WATCH_TARGET,
    name: 'Reddit 巡查',
    why: '告诉我自家版块和要盯的关键词，我每天巡查一次。',
    async fields(): Promise<SetupField[]> {
      const s = readSettings(input.store, ws)
      const hint = input.suggestions?.() ?? {}
      const subs = s.own_subreddits.length > 0 ? s.own_subreddits : (hint.own_subreddits ?? [])
      const user = s.brand_username ?? hint.brand_username
      return [
        {
          key: 'own_subreddits',
          label: '自家版块',
          kind: 'text',
          placeholder: 'inmoxr',
          ...(subs.length === 0
            ? {}
            : { suggested: subs.join(', '), suggested_why: '连接里登记的自家版' }),
          required: false,
        },
        {
          key: 'keywords',
          label: '关键词',
          kind: 'text',
          placeholder: '品牌、型号、竞品，逗号分开',
          ...(s.keywords.length === 0 ? {} : { suggested: s.keywords.join(', ') }),
          required: false,
        },
        {
          key: 'brand_username',
          label: '品牌号',
          kind: 'text',
          placeholder: 'u/…',
          ...(user === undefined ? {} : { suggested: user }),
          required: false,
        },
        {
          key: 'every_hours',
          label: '多久一次',
          kind: 'select',
          options: EVERY,
          suggested: String(s.every_hours),
          required: true,
        },
      ]
    },
    async satisfied(): Promise<boolean> {
      return isConfigured(readSettings(input.store, ws))
    },
    async apply(values): Promise<void> {
      const subsRaw = splitList(values.own_subreddits ?? '')
      const subs = subsRaw.map((s) => normalizeSubreddit(s))
      if (subs.some((s) => s === undefined))
        throw new SetupCardError('invalid_input', '版块名只能是字母、数字、下划线（如 inmoxr）。')
      const keywords = splitList(values.keywords ?? '')
      if (subs.length === 0 && keywords.length === 0)
        throw new SetupCardError('invalid_input', '版块和关键词至少填一样。')
      const user = (values.brand_username ?? '').trim().replace(/^\/?u\//iu, '')
      if (user !== '' && !USER.test(user))
        throw new SetupCardError('invalid_input', '品牌号用户名不对（3–20 个字母、数字、_ 或 -）。')
      const patch: Partial<RedditWatchSettings> = {
        own_subreddits: subs as string[],
        keywords,
        ...(values.every_hours === undefined ? {} : { every_hours: Number(values.every_hours) }),
      }
      if (user !== '') patch.brand_username = user
      writeSettings(input.store, ws, patch)
    },
  }
}
