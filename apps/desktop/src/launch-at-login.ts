/**
 * WP361（决策 927）：开机自启——托盘菜单那一处和设置弹窗「这台电脑 → 桌面端」那个开关是**同一份**。
 *
 * 真源是桌面壳的配置（`config.launchAtLogin`，托盘一直就读它）；改了之后：
 * ① 写回配置；② 交给系统的登录项（Mac / Windows 各自的做法见 `loginItemSettings`）；
 * ③ 告诉托盘重画、告诉工作台窗口那个开关跟着变（`changed`）。
 *
 * 纯逻辑、不碰 electron：main.ts 把读写配置、`app.setLoginItemSettings`、刷新托盘 / 通知窗口传进来，单测直接测。
 */
import { basename, join } from 'node:path'

/** `app.setLoginItemSettings` 收的那一份（只用得着这两样）。 */
export interface LoginItemSettings {
  openAtLogin: boolean
  /** Windows 版本目录布局下指向 `current\agentsws.exe`；Mac 不给（系统按 .app 自己认）。 */
  path?: string
}

/**
 * 交给系统的那一份。WP327：Windows 版本目录布局下（`layoutCurrent` 有值）开机自启指
 * `current\<exe 名>`——版本目录会被清理，指着它下次开机就找不到了；Mac 与老布局只给开 / 关。
 */
/** 开机自动启动时带的参数（Windows）；见 {@link wasLaunchedAtLogin}。 */
export const LAUNCHED_AT_LOGIN_ARG = '--launched-at-login'

/** 这次是不是开机自动启动的：Mac 问系统，Windows 看参数。 */
export function wasLaunchedAtLogin(
  platform: NodeJS.Platform,
  argv: readonly string[],
  macOpenedAtLogin: () => boolean,
): boolean {
  if (platform === 'darwin') {
    try {
      return macOpenedAtLogin()
    } catch {
      return false
    }
  }
  return argv.includes(LAUNCHED_AT_LOGIN_ARG)
}

export function loginItemSettings(
  openAtLogin: boolean,
  layoutCurrent: string | undefined,
  execPath: string,
): LoginItemSettings {
  // Windows 带一个参数，起来后认得出「这次是开机自动启动」（Mac 看 `wasOpenedAtLogin`）
  const args = process.platform === 'win32' ? { args: [LAUNCHED_AT_LOGIN_ARG] } : {}
  return layoutCurrent === undefined
    ? { openAtLogin, ...args }
    : { openAtLogin, path: join(layoutCurrent, basename(execPath)), ...args }
}

export interface LaunchAtLoginDeps {
  /** 配置里现在是什么。 */
  read(): boolean
  /** 写回配置。 */
  save(on: boolean): void
  /** 交给系统的登录项（失败自己记一笔、不抛）。 */
  apply(on: boolean): void
  /** 改完了：托盘重画、工作台窗口里的开关跟着变。 */
  changed(on: boolean): void
}

export interface LaunchAtLogin {
  get(): boolean
  /** 设成开 / 关，回改完的值。和现在一样也照样走一遍（系统那边可能被人在系统设置里改过）。 */
  set(on: boolean): boolean
  /** 托盘那一项：翻一下。 */
  toggle(): boolean
}

export function createLaunchAtLogin(deps: LaunchAtLoginDeps): LaunchAtLogin {
  const set = (on: boolean): boolean => {
    deps.save(on)
    deps.apply(on)
    deps.changed(on)
    return on
  }
  return {
    get: () => deps.read(),
    set,
    toggle: () => set(!deps.read()),
  }
}
