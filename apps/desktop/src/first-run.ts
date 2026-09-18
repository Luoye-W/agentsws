/**
 * 第一次打开时自动把工作台端出来（WP111）。
 *
 * 平时这是个**托盘壳**：起来之后不开窗，图标蹲在托盘里等你点（13 §5「无主窗口启动」）。
 * 那对一个用过它的人是对的，对一个刚双击完安装包的人不是——她看到的是"我装完了，
 * 然后什么都没发生"。装完第一次，得有东西自己出来。
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
}

/** 要不要现在自动打开工作台。 */
export function shouldOpenOnFirstRun(input: FirstRunInput): boolean {
  if (!input.firstRun || input.remote) return false
  if (input.alreadyOpened) return false
  return input.healthy
}
