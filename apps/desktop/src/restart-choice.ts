/**
 * WP337：点「重启并更新」（Mac 上是更新前退出）时还有任务在做——原生那一版三选一。
 *
 * 工作台左下角那颗按钮有自己的弹窗（能展开清单）；托盘点的、旧页面点的走这里：
 * 一句「还有 N 件在做」+ 清单（列几行，列不下说还有几件）+ 一句「暂停的会自动接着做」+ 三个按钮。
 *
 * 纯函数，不 import electron（框由 `main.ts` 交给 `dialog.showMessageBox`）。
 */
import type { DesktopRestartReadiness } from './bridge-types.js'
import type { Strings } from './i18n.js'
import type { QuitBoxOptions } from './quit-confirmation.js'
import type { RestartChoice } from './update-controller.js'

/** 原生框里最多列几行（多了框太高）。 */
export const RESTART_BOX_LINES = 6

export const EMPTY_READINESS: DesktopRestartReadiness = {
  total: 0,
  idle: true,
  counts: { output: 0, background: 0, scheduled: 0 },
  items: [],
}

/**
 * 服务端那一份 + 壳自己知道的：官方场景在跑（问不到里面在不在做事，照官方规矩当「可能有」，
 * 重启会关掉它、暂停不了）；服务端问不到时退回 `/v1/activity` 的运行次数（没有事项名）。
 */
export function mergeReadiness(input: {
  server: DesktopRestartReadiness | undefined
  officialScene: boolean
  officialLabel: string
  /** 服务端问不到时：正在跑的运行几次（问不到 undefined）。 */
  fallbackRuns?: number | undefined
}): DesktopRestartReadiness {
  let r = input.server
  if (r === undefined) {
    const runs = input.fallbackRuns ?? 0
    r = {
      ...EMPTY_READINESS,
      total: runs,
      idle: runs === 0,
      counts: { output: runs, background: 0, scheduled: 0 },
    }
  }
  if (!input.officialScene) return r
  return {
    ...r,
    total: r.total + 1,
    items: [...r.items, { kind: 'output', title: input.officialLabel }],
  }
}

/** 三选一的原生框。`verb = quit`：Mac 上更新前退出（「现在退出 / 空闲时退出 / 稍后」）。 */
export function restartBox(
  r: DesktopRestartReadiness,
  t: Strings,
  options: { platform: string; verb: 'restart' | 'quit' },
): QuitBoxOptions {
  const lines = r.items.slice(0, RESTART_BOX_LINES).map((i) => `• ${i.title}`)
  const more = r.total - lines.length
  if (more > 0) lines.push(t.updateBusyMore.replace('{n}', String(more)))
  const quit = options.verb === 'quit'
  return {
    type: options.platform === 'win32' ? 'none' : 'warning',
    title: t.quitTitle,
    message: t.updateBusyMessage.replace('{n}', String(r.total)),
    detail: [...lines, '', quit ? t.updateQuitHint : t.updateBusyHint].join('\n'),
    buttons: quit
      ? [t.updateQuitNow, t.updateQuitIdle, t.updateLater]
      : [t.updateRestartNow, t.updateRestartIdle, t.updateLater],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }
}

/** 框回的按钮序号 → 选了哪个（关掉框 = 稍后）。 */
export function choiceOf(response: number): RestartChoice {
  return response === 0 ? 'now' : response === 1 ? 'idle' : 'later'
}
