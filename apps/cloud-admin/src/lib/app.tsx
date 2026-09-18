/**
 * 全局那三样：我是谁、说哪种语言、明还是暗。
 *
 * 不上状态库：后台只有三个全局值，而且两个是偏好（存 localStorage），
 * 一个是会话（从 `/v1/admin/me` 拿一次）。一个 context 就够了。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { type Key, type Lang, translate } from './i18n'

export interface Me {
  account: { id: string; email: string }
  role: 'admin' | 'support'
  expires_at: string
  cost_table: { as_of: string; last_verified_at: string | null; needs_review: boolean }
}

export type Theme = 'light' | 'dark'

interface AppValue {
  me: Me | undefined
  lang: Lang
  theme: Theme
  setLang(next: Lang): void
  setTheme(next: Theme): void
  t(key: Key, vars?: Record<string, string | number>): string
  /** `support` 是只读的——每个写按钮都问它一次。 */
  canWrite: boolean
}

const AppContext = createContext<AppValue | undefined>(undefined)

const LANG_KEY = 'agentsws.admin.lang'
const THEME_KEY = 'agentsws.admin.theme'

function readPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return allowed.includes(raw as T) ? (raw as T) : fallback
  } catch {
    // 隐私窗口 / 禁了站点数据：用默认值，别让整个后台打不开
    return fallback
  }
}

export function AppProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const [me, setMe] = useState<Me | undefined>(undefined)
  const [lang, setLangState] = useState<Lang>(() => readPreference(LANG_KEY, ['zh', 'en'], 'zh'))
  const [theme, setThemeState] = useState<Theme>(() =>
    readPreference(THEME_KEY, ['light', 'dark'], 'light'),
  )

  useEffect(() => {
    let alive = true
    void api.get<Me>('/v1/admin/me').then((value) => {
      if (alive) setMe(value)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [theme, lang])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      window.localStorage.setItem(LANG_KEY, next)
    } catch {
      /* 存不下就只在这一次会话里生效 */
    }
  }, [])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      window.localStorage.setItem(THEME_KEY, next)
    } catch {
      /* 同上 */
    }
  }, [])

  const value = useMemo<AppValue>(
    () => ({
      me,
      lang,
      theme,
      setLang,
      setTheme,
      t: (key, vars) => translate(lang, key, vars),
      canWrite: me?.role === 'admin',
    }),
    [me, lang, theme, setLang, setTheme],
  )
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppValue {
  const value = useContext(AppContext)
  if (value === undefined) throw new Error('useApp 要在 AppProvider 里用')
  return value
}

/**
 * 一次 GET 的三态（读取中 / 出错 / 有数据）。
 *
 * 不上 react-query：后台每一页都是"进来读一次、动作之后重读一次"，
 * 缓存与失效那一套在这里只会多一层要解释的东西。`reload` 是显式的。
 */
export function useQuery<T>(path: string | undefined): {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  reload(): void
} {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [loading, setLoading] = useState(path !== undefined)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (path === undefined) return
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    api
      .get<T>(path, controller.signal)
      .then((value) => {
        setData(value)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setLoading(false)
      })
    return () => {
      controller.abort()
    }
    // `tick` 在依赖里是有意的：它就是"重读一次"那个信号，effect 体里用不到它的值
  }, [path, tick])

  return {
    data,
    error,
    loading,
    reload: useCallback(() => {
      setTick((n) => n + 1)
    }, []),
  }
}
