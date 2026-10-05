/**
 * WP218：应用内一键更新的状态机（像 Claude / Codex 那样：左下角一个按钮，点一下就更新）。
 *
 * ```
 * idle ──查到新版──▶ available ──点「更新」──▶ downloading ──下完──▶ ready ──点「重启并更新」──▶ installing
 *                       │                         │                     │
 *                       │ notify 档（mac 未签名）   └─下载失败─▶ error(download) ─点「重试」─▶ downloading
 *                       └─点了只开下载页                                 └─冒烟没过 / 装不上─▶ error(install) ─点「重试」─▶ installing
 * ```
 *
 * 跟 WP111 那道闸（`updater.ts` 的 `createUpdateGate`）的区别：那道闸查到就下、下完就装，
 * 用户不知道；这里**每一步都等人点**，下载在后台、装之前问一句「有任务在跑，确定现在重启？」。
 * 「冒烟不过不切换」那条纪律原样保留：装之前先打一次 `GET /v1/health`，不 ok 就不装。
 *
 * 不 import electron：`UpdateBackend` 是注入的（真的那份在 `main.ts` 包 electron-updater），
 * 所以有新版 / 无新版 / 下载失败 / 安装前确认四条路都能在 vitest 里用替身更新源跑满。
 */
import type { Logger } from './logging.js'
import type { TimerHandle, TimerPort } from './ports.js'
import type { UpdateInfo, UpdateMode } from './updater.js'

/** 这一次是从哪个源查到的（主源 = 自有下载站；github = 主源连不上时退的那一次）。 */
export type UpdateSource = 'primary' | 'github'

/** 失败的人话分类。界面按它挑文案（文案在工作台 / 托盘，这里不写字）。 */
export type UpdateErrorCode =
  /** 连不上下载站（断网、DNS、超时、被墙）。 */
  | 'network'
  /** 下载站上没有这个文件（发版传了一半、渠道目录不对）。 */
  | 'not_found'
  /** 下下来的文件校验没过（sha512 对不上），已丢弃。 */
  | 'checksum'
  /** 磁盘空间不够。 */
  | 'disk'
  /** 装之前自检（`GET /v1/health`）没过：宁可不更新。 */
  | 'smoke'
  /** 安装程序没起来。 */
  | 'install'
  | 'unknown'

export type UpdateStatus =
  | { state: 'idle' }
  | {
      state: 'available'
      version: string
      /** `auto` = 点了在应用里下；`notify` = 点了开下载页（mac 未签名）。 */
      mode: 'auto' | 'notify'
      source: UpdateSource
      /** notify 档要把人送去的那一页。 */
      url?: string
    }
  | { state: 'downloading'; version: string; percent: number; source: UpdateSource }
  | { state: 'ready'; version: string; source: UpdateSource }
  | { state: 'installing'; version: string }
  | {
      state: 'error'
      stage: 'download' | 'install'
      code: UpdateErrorCode
      version: string
      /** 原始错误（只进日志与诊断包；界面上显示 `code` 对应的人话）。 */
      detail: string
    }

/** 一个更新源能做的三件事（electron-updater 包一层；notify 档只会 `check`）。 */
export interface UpdateBackend {
  check(): Promise<UpdateInfo | undefined>
  download(onProgress: (percent: number) => void): Promise<void>
  /** 退出、装、自动重开。真的那份不会返回（进程退了）。 */
  install(): void
}

export interface UpdateControllerOptions {
  mode: UpdateMode
  /** 主源（自有下载站）。 */
  primary: UpdateBackend
  /** 主源连不上时退一次的那个源（GitHub）；不给 = 开关关着。 */
  fallback?: () => UpdateBackend | Promise<UpdateBackend>
  /** 装之前的自检：`GET /v1/health` 通过才返回 true。 */
  smoke: () => Promise<boolean>
  /** 装之前问一句；没任务在跑直接回 true。false = 用户点了「再等等」。 */
  confirmRestart: () => Promise<boolean>
  /** notify 档：点了按钮打开下载页。 */
  openDownloadPage: (url: string) => void
  /** notify 档默认的下载页（源没给具体页面时）。 */
  downloadPage: string
  logger: Logger
  timers: TimerPort
  /** 启动后多久第一次查（默认 20 秒：别跟服务进程冷启动抢）。 */
  firstCheckMs?: number
  /** 之后每隔多久查一次（默认 4 小时）。 */
  intervalMs?: number
}

export type InstallOutcome = 'installing' | 'cancelled' | 'blocked' | 'not-ready'

export interface UpdateController {
  status(): UpdateStatus
  subscribe(listener: (status: UpdateStatus) => void): () => void
  /** 查一次。正在下 / 下好了 / 正在装时不查（不把用户眼前的按钮换掉）。 */
  check(): Promise<UpdateStatus>
  /** 点「更新」：auto 档后台下载；notify 档打开下载页。错误态里点 = 重试。 */
  download(): Promise<UpdateStatus>
  /** 点「重启并更新」。 */
  install(): Promise<InstallOutcome>
  start(): void
  stop(): void
}

export const DEFAULT_FIRST_CHECK_MS = 20_000
export const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000

/** 错误 → 人话分类。electron-updater 的错误只有 message / code，按特征认。 */
export function classifyUpdateError(err: unknown): UpdateErrorCode {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  const text = `${typeof code === 'string' ? code : ''} ${String(err)}`
  if (/ENOSPC|not enough space|disk full/i.test(text)) return 'disk'
  if (/sha512 checksum mismatch|checksum|ERR_CHECKSUM/i.test(text)) return 'checksum'
  if (/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|HttpError: 404|\b404\b|Not Found/i.test(text))
    return 'not_found'
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|net::ERR_|socket hang up|timeout|fetch failed|network/i.test(
      text,
    )
  )
    return 'network'
  return 'unknown'
}

/** 主源这次失败算不算「连不上」——只有连不上才退到 GitHub（404 = 源在、只是没这版，不退）。 */
function unreachable(err: unknown): boolean {
  return classifyUpdateError(err) === 'network'
}

export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const log = options.logger.child('update')
  const listeners = new Set<(status: UpdateStatus) => void>()
  let current: UpdateStatus = { state: 'idle' }
  /** 查到新版本的那个源：下载、安装都走它（electron-updater 记着上一次 check 的结果）。 */
  let active: UpdateBackend = options.primary
  let activeSource: UpdateSource = 'primary'
  let timer: TimerHandle | undefined
  let checking: Promise<UpdateStatus> | undefined
  let downloading: Promise<UpdateStatus> | undefined

  const set = (next: UpdateStatus): UpdateStatus => {
    current = next
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (err) {
        log.warn('更新状态订阅者抛错', { error: String(err) })
      }
    }
    return next
  }

  const busy = (): boolean =>
    current.state === 'downloading' || current.state === 'ready' || current.state === 'installing'

  const found = (info: UpdateInfo | undefined, source: UpdateSource): UpdateStatus => {
    if (info === undefined) return set({ state: 'idle' })
    log.info('有新版本', { version: info.version, source })
    const mode = options.mode === 'notify' ? 'notify' : 'auto'
    return set({
      state: 'available',
      version: info.version,
      mode,
      source,
      ...(info.url === undefined ? {} : { url: info.url }),
    })
  }

  const runCheck = async (): Promise<UpdateStatus> => {
    if (options.mode === 'off' || busy()) return current
    try {
      const info = await options.primary.check()
      active = options.primary
      activeSource = 'primary'
      return found(info, 'primary')
    } catch (err) {
      log.warn('主源查更新失败', { error: String(err) })
      if (options.fallback === undefined || !unreachable(err)) return current
    }
    // 主源连不上：退到 GitHub 查一次（开关在 `update-feed.ts` 的 githubFallbackEnabled）
    try {
      const backend = await options.fallback()
      const info = await backend.check()
      active = backend
      activeSource = 'github'
      return found(info, 'github')
    } catch (err) {
      log.warn('备用源（GitHub）查更新也失败', { error: String(err) })
      return current
    }
  }

  const check = (): Promise<UpdateStatus> => {
    checking ??= runCheck().finally(() => {
      checking = undefined
    })
    return checking
  }

  const runDownload = async (): Promise<UpdateStatus> => {
    const from = current
    const retry = from.state === 'error' && from.stage === 'download'
    if (from.state !== 'available' && !retry) return current
    if (from.state === 'available' && from.mode === 'notify') {
      options.openDownloadPage(from.url ?? options.downloadPage)
      return current
    }
    const version = from.version
    const source = activeSource
    set({ state: 'downloading', version, percent: 0, source })
    try {
      await active.download((percent) => {
        if (current.state !== 'downloading') return
        const clamped = Math.max(0, Math.min(100, Math.round(percent)))
        if (clamped !== current.percent) set({ ...current, percent: clamped })
      })
    } catch (err) {
      log.warn('下载更新失败', { version, error: String(err) })
      return set({
        state: 'error',
        stage: 'download',
        code: classifyUpdateError(err),
        version,
        detail: String(err),
      })
    }
    log.info('新版本下载好了，等用户点「重启并更新」', { version })
    return set({ state: 'ready', version, source })
  }

  const download = (): Promise<UpdateStatus> => {
    downloading ??= runDownload().finally(() => {
      downloading = undefined
    })
    return downloading
  }

  const install = async (): Promise<InstallOutcome> => {
    const from = current
    const retry = from.state === 'error' && from.stage === 'install'
    if (from.state !== 'ready' && !retry) return 'not-ready'
    const version = from.version
    if (!(await options.confirmRestart())) {
      log.info('用户选了再等等，先不重启', { version })
      return 'cancelled'
    }
    const fail = (code: UpdateErrorCode, detail: string): InstallOutcome => {
      set({ state: 'error', stage: 'install', code, version, detail })
      return 'blocked'
    }
    let healthy = false
    try {
      healthy = await options.smoke()
    } catch (err) {
      log.warn('更新前自检抛错，保持旧版本', { version, error: String(err) })
      return fail('smoke', String(err))
    }
    if (!healthy) {
      log.warn('更新前自检未通过，保持旧版本', { version })
      return fail('smoke', '自检未通过：GET /v1/health 不 ok')
    }
    log.info('自检通过，退出并安装新版本', { version })
    set({ state: 'installing', version })
    try {
      active.install()
    } catch (err) {
      log.warn('安装程序没起来', { version, error: String(err) })
      return fail('install', String(err))
    }
    return 'installing'
  }

  const schedule = (ms: number): void => {
    timer = options.timers.setTimeout(() => {
      void check().finally(() => {
        if (timer !== undefined) schedule(options.intervalMs ?? DEFAULT_INTERVAL_MS)
      })
    }, ms)
  }

  return {
    status: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    check,
    download,
    install,
    start() {
      if (options.mode === 'off' || timer !== undefined) return
      schedule(options.firstCheckMs ?? DEFAULT_FIRST_CHECK_MS)
    },
    stop() {
      if (timer !== undefined) options.timers.clear(timer)
      timer = undefined
    },
  }
}
