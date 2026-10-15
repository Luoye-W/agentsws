/**
 * WP345：**「现在能不能重载」的那道闸**。
 *
 * 工坊换了新版插件文件后，插件要 `chrome.runtime.reload()`——但不能在动作做到一半时重载：
 * 广告 / Reddit 的活是**领走那一刻**就在本机记成「在做」的，重载等于把它扔在半路（本机过一阵记「插件那边断了」）。
 *
 * 所以重载前先 {@link holdActions}：两个领活的轮询不再发起新的领活（正在做的那一件照常做完、正在挂着的长轮询
 * 照常等它回来），等 {@link actionsBusy} 变 false 再重载。领活的轮询各自登记自己忙不忙。
 * 闸只在内存里：service worker 被回收 = 什么都没在做，下次醒来直接重载。
 */

let held = false
const busy = new Map<string, () => boolean>()

/** 关闸 / 开闸（关闸后轮询不再领新活）。 */
export function holdActions(on: boolean): void {
  held = on
}

export function actionsHeld(): boolean {
  return held
}

/** 领活的轮询登记「我现在忙不忙」（广告、Reddit 各一个）。 */
export function registerBusy(name: string, isBusy: () => boolean): void {
  busy.set(name, isBusy)
}

/** 有没有哪个轮询正在领活 / 做活。 */
export function actionsBusy(): boolean {
  for (const isBusy of busy.values()) if (isBusy()) return true
  return false
}
