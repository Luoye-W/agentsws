/**
 * WP338（决策 664 / 783，Luoye 10-15 确认）：Reddit **每天发几条的上限由用户自己设，默认不限**。
 *
 * 以前写死在职责里（公关外部发帖一天 2 条、回帖一天 20 条；社媒回复一天 30 条、群发一周 1 条），现在
 * 全部去掉，换成这一份用户设置：设了才数、到了就不再出卡并照实说一句；没设 = 不限。
 * 设置走对话内的配置卡（{@link REDDIT_LIMITS_TARGET}）：人说「给 Reddit 回复设个每天上限」，AI 调
 * `set_posting_limits` → 第三栏弹一张配置卡就地填。插件动作通道自己的节奏、被 Reddit 拦就停不在这里，照旧。
 *
 * 数法：只数**出了卡**的（批没批都算一次），按滚动窗口（一天 = 24 小时、一周 = 7 天）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SetupField } from '@agentsws/contracts'
import { SetupCardError, type SetupTarget } from '../setup-cards.js'

/** 配置卡的设置目标 id（工具回 `needs_setup` 认它）。 */
export const REDDIT_LIMITS_TARGET = 'reddit.limits'

/** 四种上限（与以前写死的那四个一一对应）。 */
export type RedditLimitKey = 'pr_posts' | 'pr_replies' | 'social_replies' | 'social_broadcasts'

export type RedditLimitValues = Partial<Record<RedditLimitKey, number>>

const SPEC: Readonly<
  Record<RedditLimitKey, { label: string; per: 'day' | 'week'; field: string }>
> = {
  pr_posts: { label: '公关：在别人的版发帖', per: 'day', field: 'pr_posts_per_day' },
  pr_replies: { label: '公关：在别人的帖子下回复', per: 'day', field: 'pr_replies_per_day' },
  social_replies: { label: '社媒：回复', per: 'day', field: 'social_replies_per_day' },
  social_broadcasts: {
    label: '社媒：群发 / 公告',
    per: 'week',
    field: 'social_broadcasts_per_week',
  },
}
const KEYS = Object.keys(SPEC) as RedditLimitKey[]
const WINDOW_MS = { day: 86_400_000, week: 7 * 86_400_000 } as const

interface StateFile {
  version: 1
  limits: RedditLimitValues
  /** 每种出过卡的时刻（毫秒；只留窗口内的）。 */
  used: Partial<Record<RedditLimitKey, number[]>>
  /** 人在对话里说要设 / 改：配置卡该出（存下之后清掉）。 */
  wanted?: boolean
}

export interface RedditLimits {
  get(): RedditLimitValues
  set(values: RedditLimitValues): RedditLimitValues
  /** 到了上限回一句人话（不再出卡）；没设 / 没到回 undefined。 */
  check(key: RedditLimitKey): string | undefined
  /** 出了一张卡：记一次。 */
  note(key: RedditLimitKey): void
  /** 人要设 / 改上限：下一次问配置卡时出卡。 */
  want(): void
  setupTarget(): SetupTarget
}

export function createRedditLimits(options: { nowMs(): number; dir?: string }): RedditLimits {
  const file = options.dir === undefined ? undefined : join(options.dir, 'limits.json')
  const state: StateFile = ((): StateFile => {
    if (file !== undefined && existsSync(file))
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as StateFile
        if (raw.version === 1) return { ...raw, limits: raw.limits ?? {}, used: raw.used ?? {} }
      } catch {
        // 坏了就当没设（默认不限）
      }
    return { version: 1, limits: {}, used: {} }
  })()
  const save = (): void => {
    if (file === undefined || options.dir === undefined) return
    mkdirSync(options.dir, { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(state))
    renameSync(`${file}.tmp`, file)
  }
  const recent = (key: RedditLimitKey): number[] => {
    const since = options.nowMs() - WINDOW_MS[SPEC[key].per]
    const kept = (state.used[key] ?? []).filter((t) => t > since)
    state.used[key] = kept
    return kept
  }

  const limits: RedditLimits = {
    get: () => ({ ...state.limits }),
    set(values) {
      const next: RedditLimitValues = {}
      for (const k of KEYS) {
        const v = values[k]
        if (v !== undefined && Number.isInteger(v) && v > 0) next[k] = v
      }
      state.limits = next
      delete state.wanted
      save()
      return { ...next }
    },
    check(key) {
      const max = state.limits[key]
      if (max === undefined) return undefined
      const used = recent(key).length
      if (used < max) return undefined
      const per = SPEC[key].per === 'day' ? '一天（24 小时内）' : '一周（7 天内）'
      return `「${SPEC[key].label}」${per}已经 ${used} 条，到了你设的上限 ${max} 条，这一条先不出卡。要改上限跟我说一声。`
    },
    note(key) {
      recent(key).push(options.nowMs())
      save()
    },
    want() {
      state.wanted = true
      save()
    },
    setupTarget: () => ({
      id: REDDIT_LIMITS_TARGET,
      name: 'Reddit 每天上限',
      why: '一天最多出几张发帖 / 回复的卡。空着 = 不限。',
      async fields(): Promise<SetupField[]> {
        return KEYS.map(
          (k): SetupField => ({
            key: SPEC[k].field,
            label: `${SPEC[k].label}（每${SPEC[k].per === 'day' ? '天' : '周'}最多）`,
            kind: 'text',
            placeholder: '不限',
            ...(state.limits[k] === undefined ? {} : { suggested: String(state.limits[k]) }),
            required: false,
          }),
        )
      },
      // 默认不限 = 不缺什么；只有人说要设 / 改时才出卡
      satisfied: async () => state.wanted !== true,
      async apply(values) {
        const next: RedditLimitValues = {}
        for (const k of KEYS) {
          const raw = (values[SPEC[k].field] ?? '').trim()
          if (raw === '' || raw === '不限') continue
          const n = Number(raw)
          if (!Number.isInteger(n) || n < 1)
            throw new SetupCardError(
              'invalid_input',
              `「${SPEC[k].label}」要填一个正整数，或空着（不限）。`,
            )
          next[k] = n
        }
        limits.set(next)
      },
    }),
  }
  return limits
}
