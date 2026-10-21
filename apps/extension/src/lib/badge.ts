/**
 * WP409（内测真机 10-18 #4）：配上了没有，工具栏图标上一眼看得出——配上了右下角一个绿勾，
 * 没配上什么都不挂（标题提示「点一下去配对」）。不要任何新权限（`chrome.action` 的角标与标题）。
 */

/** `chrome.action` 里用到的那三样（测试里换成替身）。 */
export interface ActionBadgePort {
  setBadgeText(details: { text: string }): Promise<void> | void
  setBadgeBackgroundColor(details: { color: string }): Promise<void> | void
  setTitle(details: { title: string }): Promise<void> | void
}

/** 与设置页的「好」色同一个（`--ws-good`）。 */
export const PAIRED_BADGE_COLOR = '#158a4b'
export const PAIRED_BADGE_TEXT = '✓'

export const TITLE_PAIRED = 'Agents 工坊助手 · 已连上这台电脑上的工坊'
export const TITLE_UNPAIRED = 'Agents 工坊助手 · 还没配对（点一下去配对）'

export async function syncPairedBadge(action: ActionBadgePort, paired: boolean): Promise<void> {
  if (paired) {
    await action.setBadgeBackgroundColor({ color: PAIRED_BADGE_COLOR })
    await action.setBadgeText({ text: PAIRED_BADGE_TEXT })
    await action.setTitle({ title: TITLE_PAIRED })
    return
  }
  await action.setBadgeText({ text: '' })
  await action.setTitle({ title: TITLE_UNPAIRED })
}

/** WP432：「等你发」的数字用提醒色（与工坊的 `--ws-warn` 一致）。 */
export const WAITING_BADGE_COLOR = '#c2410c'

/** WP432：图标上的提示——有 N 条等你发。 */
export const titleWaiting = (n: number): string =>
  `Agents 工坊助手 · ${n} 条等你发（点一下打开侧边栏）`

/**
 * WP432（Luoye 10-20 反馈 9）：批了的 Reddit 回复 / 帖子（和交给你发的社媒帖子）等你在侧边栏里发——
 * 图标右下角出数字；没有等你发的就回到配对的绿勾。
 */
export async function syncBadge(
  action: ActionBadgePort,
  state: { paired: boolean; waiting: number },
): Promise<void> {
  if (!state.paired || state.waiting <= 0) {
    await syncPairedBadge(action, state.paired)
    return
  }
  await action.setBadgeBackgroundColor({ color: WAITING_BADGE_COLOR })
  await action.setBadgeText({ text: state.waiting > 99 ? '99+' : String(state.waiting) })
  await action.setTitle({ title: titleWaiting(state.waiting) })
}

/**
 * WP432：哪几条是新来的「等你发」（上次没见过的才弹一句系统通知；第一次看到时不一口气弹一串）。
 * 回要弹的那几条与这次要记下的全部。
 */
export function newWaiting(
  seen: readonly string[] | undefined,
  now: readonly { id: string; label: string }[],
): { fresh: { id: string; label: string }[]; remember: string[] } {
  const remember = now.map((w) => w.id)
  if (seen === undefined) return { fresh: [], remember }
  const before = new Set(seen)
  return { fresh: now.filter((w) => !before.has(w.id)), remember }
}
