/**
 * WP356：设置弹窗挂在地址上——打开 = 去一个设置地址，关 = 回到打开前那一页。
 *
 * - 地址是设置地址时（`route.ts` 说了算），主区的路由**照旧按打开前那一页**画（背景），
 *   所以背后那一页不卸、不重取、滚动位置都在；关掉就是回到它。
 * - 直接从外面进一个设置地址（插件深链、托盘、刷新）时背后没有页，就用首页垫着。
 * - 关：能退就退（打开之后换节都是替换，不多压历史）；退不了（测试里的内存路由、直接进来的）就替换回背景那一页。
 * - ⌘, / Ctrl+, 在哪儿都能打开（学 Claude / 系统偏好设置）。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { type Location, useLocation, useNavigate } from 'react-router-dom'
import {
  type SettingsSectionId,
  type SettingsTarget,
  settingsHref,
  settingsTargetOf,
} from './route'

const HOME: Location = { pathname: '/', search: '', hash: '', state: null, key: 'settings-home' }

/** BrowserRouter 在 `history.state.idx` 里记着这是第几条（内存路由没有）。 */
function historyIdx(): number | undefined {
  const state = globalThis.history?.state as { idx?: unknown } | null | undefined
  return typeof state?.idx === 'number' ? state.idx : undefined
}

export function useSettingsRoute(): {
  target: SettingsTarget | null
  background: Location
  go: (section: SettingsSectionId, item?: string) => void
  close: () => void
} {
  const location = useLocation()
  const navigate = useNavigate()
  const target = useMemo(() => settingsTargetOf(location), [location])
  const from = useRef<{ loc: Location; idx: number | undefined } | null>(null)
  // 不在设置里时随时记下「背景」——打开那一刻它就是打开前那一页
  if (target === null) from.current = { loc: location, idx: historyIdx() }
  const background = target === null ? location : (from.current?.loc ?? HOME)

  const open = target !== null
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ',' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      e.preventDefault()
      if (!open) navigate('/settings')
    }
    globalThis.document?.addEventListener('keydown', onKey)
    return () => {
      globalThis.document?.removeEventListener('keydown', onKey)
    }
  }, [open, navigate])

  const go = useCallback(
    (section: SettingsSectionId, item?: string) => {
      navigate(settingsHref(section, item), { replace: true })
    },
    [navigate],
  )

  const close = useCallback(() => {
    const back = from.current
    const idx = historyIdx()
    if (back?.idx !== undefined && idx !== undefined && idx > back.idx) {
      navigate(back.idx - idx)
      return
    }
    const loc = back?.loc ?? HOME
    navigate(`${loc.pathname}${loc.search}${loc.hash}`, { replace: true })
  }, [navigate])

  return { target, background, go, close }
}
