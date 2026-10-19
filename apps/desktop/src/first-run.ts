/**
 * 打开应用时自动把工作台端出来（WP111 首启；Luoye 10-19 起每次手动打开都端）。
 *
 * 以前只有第一次装完才开窗，之后一律蹲在托盘里——Mac 上从「应用程序」或程序坞再打开，
 * 什么都不出来，只能去菜单栏找。现在：人自己打开 = 开窗；开机自动启动那一次才安静地蹲托盘。
 *
 * 出来之后落在哪由工作台自己决定：`needs_setup` 时 `app.tsx` 会跳到 `/onboarding`
 * （WP79 的「初始化设置」四步）。壳不认识那个路由，也不该认识——它只负责开窗。
 */

export interface FirstRunInput {
  /** 这台电脑上是不是第一次跑（判据：跑首启向导之前 `config.json` 在不在）。 */
  firstRun: boolean
  /** 服务健康了没有。不健康就开一个白屏窗口，比不开更糟。 */
  healthy: boolean
  /** 这一轮已经自动开过了（只开一次——第二次就成了骚扰）。 */
  alreadyOpened: boolean
  /**
   * `remote` 档：服务在公司那台机器上，第一次打开要先登录
   * （邀请链接 / magic-link），自动开窗只会落到一个登录页。那一档不自动开。
   */
  remote: boolean
  /** 这次是开机自动启动的（登录项）——那一次不开窗，免得一开机就弹。第一次装完照样开。 */
  launchedAtLogin?: boolean
}

/** 要不要现在自动打开工作台。 */
export function shouldOpenOnFirstRun(input: FirstRunInput): boolean {
  if (input.remote || input.alreadyOpened) return false
  if (!input.firstRun && input.launchedAtLogin === true) return false
  return input.healthy
}
