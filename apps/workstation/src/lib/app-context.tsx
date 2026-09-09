/** 主题（深浅色）、语言、当前岗位——三个跨页面的小状态，一个 context 装完。 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import { setAssignment } from './api.js'
import { type Lang, translate } from './i18n.js'

export type Theme = 'light' | 'dark'

const THEME_KEY = 'agentsws.theme'
const LANG_KEY = 'agentsws.lang'

interface AppState {
  theme: Theme
  lang: Lang
  position: string | null
  setTheme(theme: Theme): void
  toggleTheme(): void
  setLang(lang: Lang): void
  selectPosition(id: string): void
  t(key: string, vars?: Record<string, string | number>): string
}

const AppContext = createContext<AppState | null>(null)

function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // 存不下也照常工作，只是刷新后回默认
  }
}

function applyTheme(theme: Theme): void {
  const root = globalThis.document?.documentElement
  if (root === undefined) return
  root.classList.toggle('dark', theme === 'dark')
}

export function AppProvider({
  children,
  initialTheme,
  initialLang,
  initialPosition,
}: {
  children: ReactNode
  initialTheme?: Theme
  initialLang?: Lang
  initialPosition?: string
}): ReactNode {
  const [theme, setThemeState] = useState<Theme>(
    () => initialTheme ?? (readStored(THEME_KEY) === 'dark' ? 'dark' : 'light'),
  )
  const [lang, setLangState] = useState<Lang>(
    () => initialLang ?? (readStored(LANG_KEY) === 'en' ? 'en' : 'zh'),
  )
  const [position, setPosition] = useState<string | null>(initialPosition ?? null)

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    write(THEME_KEY, next)
    applyTheme(next)
  }, [])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    write(LANG_KEY, next)
  }, [])

  const selectPosition = useCallback((id: string) => {
    setPosition(id)
    setAssignment(id)
  }, [])

  const value = useMemo<AppState>(
    () => ({
      theme,
      lang,
      position,
      setTheme,
      toggleTheme: () => {
        setTheme(theme === 'dark' ? 'light' : 'dark')
      },
      setLang,
      selectPosition,
      t: (key, vars) => translate(lang, key, vars),
    }),
    [theme, lang, position, setTheme, setLang, selectPosition],
  )

  // 首次渲染就把 class 挂上（SSR 没有，这里是纯客户端）
  applyTheme(theme)

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppState {
  const ctx = useContext(AppContext)
  if (ctx === null) throw new Error('useApp 必须在 AppProvider 里用')
  return ctx
}
