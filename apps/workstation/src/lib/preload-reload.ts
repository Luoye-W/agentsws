/**
 * WP298：升级之后旧页面加载新版分块失败（`vite:preloadError`）→ 自动整页重载一次。
 *
 * 桌面壳升级时服务进程换了一份构建产物，开着的旧页面再去懒加载某个分块（右栏面板），
 * 旧文件名已经不在了。Vite 在这时派发 `vite:preloadError`；默认是把错误抛给调用方，
 * 那一块就空着。这里接住它：
 * - 第一次：记下时刻，整页重载（重载后拿到的是新版 index.html 与新分块名）；
 * - 重载后 30 秒内又来一次：**不再重载**（新版自己也坏了，或者服务真的不在）——
 *   让错误照常抛给错误边界，显示「这一块没加载出来」，并记一条日志。不死循环。
 */
import { reportClientError } from './client-errors.js'

export const PRELOAD_RELOAD_KEY = 'agentsws.preload-reload-at'
export const PRELOAD_RELOAD_WINDOW_MS = 30_000

interface Deps {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined
  reload: () => void
  now: () => number
}

/** 处理一次 `vite:preloadError`；返回这次是不是重载了。 */
export function handlePreloadError(event: Event, deps: Deps): boolean {
  const { storage, reload, now } = deps
  let last = Number.NaN
  try {
    last = Number(storage?.getItem(PRELOAD_RELOAD_KEY) ?? Number.NaN)
  } catch {
    // 存储读不了：当没重载过
  }
  const payload = (event as Event & { payload?: unknown }).payload
  if (Number.isFinite(last) && now() - last < PRELOAD_RELOAD_WINDOW_MS) {
    reportClientError('preload', payload ?? 'vite:preloadError', { scope: 'after-reload' })
    return false
  }
  reportClientError('preload', payload ?? 'vite:preloadError', { scope: 'reload' })
  try {
    storage?.setItem(PRELOAD_RELOAD_KEY, String(now()))
  } catch {
    // 记不下来就不冒险重载：重载后无从知道刚重载过，可能转圈
    return false
  }
  if (storage === undefined) return false
  event.preventDefault()
  reload()
  return true
}

function sessionStore(): Storage | undefined {
  try {
    return globalThis.sessionStorage ?? undefined
  } catch {
    return undefined
  }
}

/** 挂到 window 上。返回拆掉的函数。 */
export function installPreloadReload(target: Window = window): () => void {
  const onPreloadError = (event: Event): void => {
    handlePreloadError(event, {
      storage: sessionStore(),
      reload: () => {
        target.location.reload()
      },
      now: () => Date.now(),
    })
  }
  target.addEventListener('vite:preloadError', onPreloadError)
  return () => {
    target.removeEventListener('vite:preloadError', onPreloadError)
  }
}
