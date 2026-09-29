/**
 * 「界面动效：跟随系统 / 开 / 关」这一个偏好（WP195）。
 *
 * - **跟随系统**（默认）：系统开了「少一点动效」就一律静态，没开就动——WP112 起的老规矩；
 * - **开**：人在这里明说了要动，就算系统那边开着「少一点动效」也照动；
 * - **关**：一律静态。
 *
 * 管的是**品牌标记**的动效（待机、集结、呼吸、一变一队）。按钮里的加载转圈不归它管：
 * 那是"页面在忙"的状态提示，关掉了人就不知道点没点上。
 *
 * 存在本机 `localStorage`，并把选择写到 `<html data-ws-motion>` 上——`index.css` 里那层
 * CSS 兜底（系统「少一点动效」时停）按它判断要不要让路。标记组件不一定在 `AppProvider`
 * 里渲染（测试、冷启动首屏），所以这是一个独立的小仓库，不塞进 app context。
 */
import { useSyncExternalStore } from 'react'

export type MotionPref = 'system' | 'on' | 'off'

export const MOTION_PREFS: readonly MotionPref[] = ['system', 'on', 'off']

const KEY = 'agentsws.motion'
const listeners = new Set<() => void>()
let cached: MotionPref | undefined

function parse(raw: string | null | undefined): MotionPref {
  return raw === 'on' || raw === 'off' ? raw : 'system'
}

export function readMotionPref(): MotionPref {
  if (cached !== undefined) return cached
  let raw: string | null = null
  try {
    raw = globalThis.localStorage?.getItem(KEY) ?? null
  } catch {
    raw = null
  }
  cached = parse(raw)
  return cached
}

/** 把选择挂到 `<html data-ws-motion>` 上（CSS 兜底层看它）。 */
export function applyMotionPref(pref: MotionPref = readMotionPref()): void {
  const root = globalThis.document?.documentElement
  if (root === undefined) return
  root.dataset.wsMotion = pref
}

export function setMotionPref(pref: MotionPref): void {
  cached = pref
  try {
    globalThis.localStorage?.setItem(KEY, pref)
  } catch {
    // 存不下也照常生效，只是刷新后回「跟随系统」
  }
  applyMotionPref(pref)
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useMotionPref(): MotionPref {
  return useSyncExternalStore(subscribe, readMotionPref, () => 'system')
}

/** 测试用：丢掉缓存，下次从本机存储重读。 */
export function resetMotionPrefForTest(): void {
  cached = undefined
}
