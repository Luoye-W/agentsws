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
