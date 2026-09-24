/**
 * 电脑操控（docs/80，WP144）在服务进程这一侧：**三层开关、授权与「正在操作」**。
 *
 * 工具面在 `dsh-adapter`（官方 `dsh-computer-use` + Cua Driver MCP 提供方）；
 * 这里只管三件运行时自己不该知道的事：
 *
 * | 事 | 这里怎么做 |
 * |---|---|
 * | ① 总开关 + ② 哪几条职责可以 | `computer-use.json`（一台机器一份，与浏览器设置同一条理由）。默认关、一条都不勾 |
 * | ③ 每次运行先授权 | Agent 调 `request_computer_use` → 运行时出一张 `computer_use` 卡 → 批了在这里记一次授权（这件事、N 分钟、只给下一次运行用一回），然后**带着授权重跑这件事**——批了这次运行才挂提供方 |
 * | 看得见、停得住 | 正在用授权的那次运行登记在这里；托盘与第三栏读 `active()`，点「停止」= 撤销授权 + 中断那次运行（dispose 那棵树，驱动随之断开） |
 *
 * **只在本机档**：`runtimeMode() === 'local'`（服务就在用户自己的电脑上）。Docker /
 * 托管 / 公司服务器上这一整块不给：设置存不进去、`forRun()` 永远回 `undefined`。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ApprovalItem,
  Clock,
  ComputerUseActive,
  ComputerUseGrantPayload,
  ComputerUseSelfCheck,
  ComputerUseSettings,
  ComputerUseSettingsView,
  DecideInput,
  RunComputerUse,
} from '@agentsws/contracts'
import {
  COMPUTER_USE_DEFAULT_MINUTES,
  COMPUTER_USE_MAX_MINUTES,
  COMPUTER_USE_MIN_MINUTES,
} from '@agentsws/contracts'
import {
  type ComputerUseLock,
  driverArgs,
  driverPathIn,
  installCuaDriver,
  MAC_SETTINGS_URL,
  platformKey,
  readLock,
  runSelfCheck,
  type SelfCheckOutcome,
} from './computer-use-install.js'

export class ComputerUseError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'forbidden' | 'not_implemented' | 'provider_error',
    message: string,
  ) {
    super(message)
    this.name = 'ComputerUseError'
  }
}

const DEFAULT: ComputerUseSettings = {
  enabled: false,
  roles: [],
  minutes: COMPUTER_USE_DEFAULT_MINUTES,
}

interface StateFile {
  version: 1
  settings: ComputerUseSettings
}

/** 批过、还没被哪次运行用掉的一次授权。 */
interface Grant {
  grant_id: string
  matter_id: string
  until_ms: number
}

/** 发出去、还没决定的一张卡：批了要重跑哪件事。 */
interface PendingCard {
  matter_id: string
  minutes: number
  rerun: () => Promise<unknown>
}

interface ActiveRun extends ComputerUseActive {
  abort: () => void
}

export interface ComputerUseOptions {
  /** 设置落盘目录；不给就全内存。 */
  dir?: string
  /** 数据目录（驱动装在它下面）；不给 = 装不了驱动。 */
  dataDir?: string
  runtimeMode(): 'local' | 'docker' | 'hosted'
  clock: Clock
  /** 墙钟（毫秒）：授权是「接下来 N 分钟」。缺省 `Date.now`；测试注入。 */
  wallClockMs?: () => number
  platform?: NodeJS.Platform
  lock?: ComputerUseLock
  fetchImpl?: typeof fetch
  /** 驱动文件在不在（测试注入；缺省 `existsSync`）。 */
  driverExists?: (path: string) => boolean
  /** 自检（测试注入；缺省起一次真驱动调 `check_permissions {prompt:false}`）。 */
  selfCheck?: (driverPath: string, args: string[]) => Promise<SelfCheckOutcome>
  /** 打开系统设置的某一页（测试注入；缺省 macOS `open <url>`）。 */
  openUrl?: (url: string) => Promise<void>
}

export interface ComputerUseAssembly {
  get(): ComputerUseSettingsView
  set(input: Partial<ComputerUseSettings>): ComputerUseSettingsView
  install(): Promise<ComputerUseSettingsView>
  check(): Promise<ComputerUseSelfCheck>
  openSettings(
    pane: 'accessibility' | 'screen_recording',
  ): Promise<{ opened: boolean; url: string }>
  /**
   * 组 `RunRequest.computer_use`：三层开关里前两层都过、驱动装好了才给；
   * 这件事有一次批过没用掉的授权，就带上 `granted_until`（并当场用掉）。
   */
  forRun(input: { role_id: string; matter_id: string }): RunComputerUse | undefined
  /** 运行时出了一张 `computer_use` 卡：记下批了之后要重跑哪件事。 */
  remember(approval_item_id: string, card: PendingCard): void
  /** 审批总线的包装：`computer_use` 卡批了 → 记授权 → 重跑这件事。 */
  wrap<B extends { decide(id: string, by: never, input: DecideInput): Promise<ApprovalItem> }>(
    bus: B,
  ): B
  /** 一次带着授权的运行开始了（托盘与第三栏据此显示「正在操作」）。 */
  activate(run: ComputerUseActive, abort: () => void): void
  deactivate(run_id: string): void
  active(): ComputerUseActive | undefined
  /** 停止 = 撤销所有授权 + 中断正在用授权的运行。 */
  stop(): { stopped: number }
}

export function clampMinutes(n: unknown): number {
  const v =
    typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : COMPUTER_USE_DEFAULT_MINUTES
  return Math.min(COMPUTER_USE_MAX_MINUTES, Math.max(COMPUTER_USE_MIN_MINUTES, v))
}

function platformOf(p: NodeJS.Platform): ComputerUseSettingsView['platform'] {
  return p === 'darwin' || p === 'win32' || p === 'linux' ? p : 'other'
}

/** macOS 上打开系统设置某一页（只打开给人看，不替人点）。 */
async function openOnMac(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/open', [url], (err) => (err === null ? resolve() : reject(err)))
  })
}

export function createComputerUse(options: ComputerUseOptions): ComputerUseAssembly {
  const file = options.dir === undefined ? undefined : join(options.dir, 'computer-use.json')
  const platform = options.platform ?? process.platform
  const wallNow = options.wallClockMs ?? Date.now
  const driverExists = options.driverExists ?? ((p: string) => existsSync(p))
  let settings: ComputerUseSettings = load()
  const grants = new Map<string, Grant>()
  const pending = new Map<string, PendingCard>()
  const running = new Map<string, ActiveRun>()

  function load(): ComputerUseSettings {
    if (file === undefined) return { ...DEFAULT }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as StateFile
      if (parsed.version !== 1) return { ...DEFAULT }
      return {
        enabled: parsed.settings.enabled === true,
        roles: Array.isArray(parsed.settings.roles)
          ? parsed.settings.roles.filter((r): r is string => typeof r === 'string')
          : [],
        minutes: clampMinutes(parsed.settings.minutes),
      }
    } catch {
      // 没有文件、或者坏了：回到"谁都碰不到这台电脑"。这是安全的那一侧。
      return { ...DEFAULT }
    }
  }

  function persist(): void {
    if (file === undefined) return
    mkdirSync(dirname(file), { recursive: true })
    const state: StateFile = { version: 1, settings }
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  const allowed = (): boolean => options.runtimeMode() === 'local'
  const lockOf = (): ComputerUseLock | undefined => {
    try {
      return options.lock ?? readLock()
    } catch {
      return undefined
    }
  }
  const driverPath = (): string | undefined => {
    const lock = lockOf()
    if (options.dataDir === undefined || lock === undefined) return undefined
    return driverPathIn(options.dataDir, lock, platformKeyOf())
  }
  const platformKeyOf = (): string | undefined =>
    platform === process.platform ? platformKey() : platformKey(platform)
  const installed = (): boolean => {
    const p = driverPath()
    return p !== undefined && driverExists(p)
  }

  const view = (): ComputerUseSettingsView => {
    const lock = lockOf()
    const path = driverPath()
    const key = platformKeyOf()
    const supported = key !== undefined && lock?.driver.assets[key] !== undefined
    const act = active()
    return {
      ...settings,
      roles: [...settings.roles],
      allowed: allowed(),
      ...(allowed()
        ? {}
        : {
            blocked_reason:
              '这台服务不在你自己的电脑上（Docker / 托管 / 公司服务器）：电脑操控只在装在你自己电脑上的 Agents 工坊里能开。',
          }),
      platform: platformOf(platform),
      driver: {
        installed: installed(),
        ...(path === undefined ? {} : { path }),
        ...(lock === undefined ? {} : { pinned_version: lock.driver.version }),
        ...(key === undefined ? {} : { platform_key: key }),
        ...(options.dataDir === undefined
          ? { detail: '这台服务没有数据目录（全内存档），装不了驱动' }
          : supported
            ? {}
            : { detail: `这个系统没有官方驱动（${platform}）` }),
      },
      ...(act === undefined ? {} : { active: act }),
    }
  }

  function active(): ComputerUseActive | undefined {
    const now = wallNow()
    for (const run of running.values()) {
      if (Date.parse(run.until) > now) {
        const { abort: _abort, ...rest } = run
        return rest
      }
    }
    return undefined
  }

  const requireAllowed = (): void => {
    if (!allowed()) {
      throw new ComputerUseError(
        'forbidden',
        '电脑操控只在装在你自己电脑上的 Agents 工坊里能开（docs/80：Docker / 托管 / 公司服务器一律不给）',
      )
    }
  }

  return {
    get: view,
    set(input) {
      const next: ComputerUseSettings = {
        enabled: input.enabled ?? settings.enabled,
        roles:
          input.roles === undefined
            ? settings.roles
            : [...new Set(input.roles.map((r) => r.trim()).filter((r) => r !== ''))].sort(),
        minutes: input.minutes === undefined ? settings.minutes : clampMinutes(input.minutes),
      }
      // 只有「打开」要问档位；关掉、少勾几条永远可以（往安全的那一侧走不设门槛）
      if (next.enabled && !settings.enabled) requireAllowed()
      if (next.roles.some((r) => !settings.roles.includes(r))) requireAllowed()
      settings = next
      // 总开关一关，没用掉的授权一起作废，正在操作的那次也停下
      if (!settings.enabled) stopAll()
      persist()
      return view()
    },
    async install() {
      requireAllowed()
      if (options.dataDir === undefined) {
        throw new ComputerUseError(
          'not_implemented',
          '这台服务没有数据目录（全内存档），装不了驱动',
        )
      }
      const lock = lockOf()
      if (lock === undefined) {
        throw new ComputerUseError('not_implemented', '这个发行版里没有 computer-use.lock.json')
      }
      const key = platformKeyOf()
      await installCuaDriver({
        dataDir: options.dataDir,
        lock,
        ...(key === undefined ? {} : { platformKey: key }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })
      return view()
    },
    async check() {
      if (!allowed())
        return { ran: false, ok: false, checks: [], detail: view().blocked_reason ?? '' }
      const path = driverPath()
      if (path === undefined || !driverExists(path)) {
        return { ran: false, ok: false, checks: [], detail: '还没装驱动（第 ① 步）' }
      }
      const run =
        options.selfCheck ??
        ((p: string, args: string[]) => runSelfCheck({ driverPath: p, args, platform }))
      const out = await run(path, driverArgs(platform))
      return {
        ran: true,
        ok: out.ok,
        checks: out.checks,
        ...(out.raw === '' ? {} : { raw: out.raw }),
        ...(out.detail === undefined ? {} : { detail: out.detail }),
      }
    },
    async openSettings(pane) {
      requireAllowed()
      const url = MAC_SETTINGS_URL[pane]
      if (platform !== 'darwin') return { opened: false, url }
      await (options.openUrl ?? openOnMac)(url)
      return { opened: true, url }
    },
    forRun({ role_id, matter_id }) {
      if (!allowed() || !settings.enabled || !settings.roles.includes(role_id)) return undefined
      const path = driverPath()
      // 装好了才给（给一个指不到文件的路径，运行时那一层会让整次运行失败）
      if (path === undefined || !driverExists(path)) return undefined
      const base: RunComputerUse = {
        command: path,
        args: driverArgs(platform),
        minutes: settings.minutes,
      }
      const grant = grants.get(matter_id)
      if (grant === undefined) return base
      // 一次授权只给**一次**运行用：这一跳就用掉（「每次运行先授权」）
      grants.delete(matter_id)
      if (grant.until_ms <= wallNow()) return base
      return {
        ...base,
        granted_until: new Date(grant.until_ms).toISOString(),
        grant_id: grant.grant_id,
      }
    },
    remember(approval_item_id, card) {
      pending.set(approval_item_id, card)
    },
    wrap(bus) {
      return new Proxy(bus, {
        get(target, prop, receiver) {
          if (prop !== 'decide') {
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return async (id: string, by: never, input: DecideInput): Promise<ApprovalItem> => {
            const out = await target.decide(id, by, input)
            if (out.kind !== 'computer_use') return out
            const card = pending.get(id)
            pending.delete(id)
            const approved = out.state === 'approved' || out.state === 'approved_edited'
            if (!approved || card === undefined) return out
            // 档位 / 开关在卡发出去之后变了：批了也不给
            if (!allowed() || !settings.enabled) return out
            const minutes = clampMinutes(
              (out.payload as Partial<ComputerUseGrantPayload> | undefined)?.minutes ??
                card.minutes,
            )
            grants.set(card.matter_id, {
              grant_id: out.id,
              matter_id: card.matter_id,
              until_ms: wallNow() + minutes * 60_000,
            })
            // 带着授权重跑这件事（不等它跑完：批卡这一下不该卡住）
            void card.rerun().catch(() => undefined)
            return out
          }
        },
      })
    },
    activate(run, abort) {
      running.set(run.run_id, { ...run, abort })
    },
    deactivate(run_id) {
      running.delete(run_id)
    },
    active,
    stop: () => stopAll(),
  }

  function stopAll(): { stopped: number } {
    grants.clear()
    let stopped = 0
    for (const run of running.values()) {
      run.abort()
      stopped += 1
    }
    running.clear()
    return { stopped }
  }
}
