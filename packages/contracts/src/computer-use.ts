/**
 * WP144（docs/80）：电脑操控的设置、驱动状态、自检与「正在操作」的形状。
 *
 * 三层开关（docs/80 §3）：
 * 1. 设置页总开关（{@link ComputerUseSettings.enabled}，默认关）；
 * 2. 哪几条职责可以操作电脑（{@link ComputerUseSettings.roles}，默认一条都不勾）；
 * 3. 每次运行第一次要动电脑时的授权卡（`ApprovalKind` `computer_use`，批了才挂提供方）。
 *
 * 一台机器一份，不按品牌分——与浏览器设置同一条理由（操作的是这台电脑本身）。
 */
import type { Iso8601 } from './common.js'

/** 授权卡上默认问的分钟数。 */
export const COMPUTER_USE_DEFAULT_MINUTES = 10
/** 授权分钟数的上下限（设置页里可改，超出范围按边界算）。 */
export const COMPUTER_USE_MIN_MINUTES = 1
export const COMPUTER_USE_MAX_MINUTES = 60

/** `GET` / `PUT /v1/settings/computer-use` 存下来的那一份。 */
export interface ComputerUseSettings {
  /** 总开关。默认 `false`：谁都碰不到这台电脑。 */
  enabled: boolean
  /** 可以操作电脑的职责（`role_id`）。默认空：一条都不勾。 */
  roles: string[]
  /** 授权卡上问「接下来 N 分钟」的 N。 */
  minutes: number
}

/** 驱动（`cua-driver`）装没装、装的是哪一版。 */
export interface ComputerUseDriverStatus {
  installed: boolean
  /** 装在哪（数据目录里；不进 PATH）。 */
  path?: string
  /** 我们钉的版本（`computer-use.lock.json`）。 */
  pinned_version?: string
  /** 这个平台有没有官方产物（`darwin-arm64` / `windows-x64` …）。 */
  platform_key?: string
  /** 这个平台装不了时说给人听的那一句。 */
  detail?: string
}

/**
 * 自检的一条（驱动 `check_permissions`，`prompt: false`——只读状态，不弹系统框）。
 * `raw` 是驱动原样回的那一段（设置页照原样列出来）。
 */
export interface ComputerUsePermissionCheck {
  /** `accessibility` / `screen_recording` / 驱动自己的名字。 */
  name: string
  ok: boolean
  /** 驱动原话。 */
  detail: string
  /** 没过时「怎么修」那一句（我们补的，指向系统设置里的哪一页）。 */
  fix?: string
}

export interface ComputerUseSelfCheck {
  /** 这次真的跑了驱动（没装 / 不允许时是 false）。 */
  ran: boolean
  ok: boolean
  checks: ComputerUsePermissionCheck[]
  /** 驱动原样回的文本（设置页折叠显示）。 */
  raw?: string
  detail?: string
}

/** 正在操作电脑的那一次运行（托盘与第三栏那一行读它）。 */
export interface ComputerUseActive {
  run_id: string
  role_id: string
  matter_id?: string
  /** 授权到什么时候为止。 */
  until: Iso8601
  grant_id?: string
}

/** 设置页读到的那一份：设置本身 + 这一档允不允许 + 驱动 + 正在操作。 */
export interface ComputerUseSettingsView extends ComputerUseSettings {
  /** 只有本机档（服务就在用户自己的电脑上）允许。 */
  allowed: boolean
  blocked_reason?: string
  /** 这台电脑是什么系统（决定权限引导那一步怎么说）。 */
  platform: 'darwin' | 'win32' | 'linux' | 'other'
  driver: ComputerUseDriverStatus
  active?: ComputerUseActive
}

/**
 * 授权卡（`ApprovalKind` `computer_use`）的 payload。
 *
 * - `authorize`：Agent 第一次要动电脑——「让它在接下来 N 分钟操作这台电脑？」
 * - `handoff`：Agent 遇到登录 / 密码 / 支付 / 验证码停下来了——「请你来做这一步」，
 *   做完点「好了，接着做」= 再授权一次 N 分钟并接着跑。
 */
export interface ComputerUseGrantPayload {
  stage: 'authorize' | 'handoff'
  run_id: string
  matter_id?: string
  role_id: string
  minutes: number
  /** Agent 说的为什么要动电脑 / 卡在哪一步（人话，模型写的）。 */
  reason: string
}
