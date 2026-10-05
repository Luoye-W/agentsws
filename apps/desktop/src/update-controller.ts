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
import type { DesktopUpdateStatus } from './bridge-types.js'
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

/** 交给页面的那一份：原始错误文本（可能带路径、网址）只进日志，不进渲染进程。 */
export function publicStatus(status: UpdateStatus): DesktopUpdateStatus {
  if (status.state !== 'error') return status
  const { detail: _detail, ...rest } = status
  return rest
}

/** 主源这次失败算不算「连不上」——只有连不上才退到 GitHub（404 = 源在、只是没这版，不退）。 */
function unreachable(err: unknown): boolean {
  return classifyUpdateError(err) === 'network'
}

/** 「这个源还不存在」的几种样子（进日志的短标签）。 */
export type SourceMissingReason = 'dns' | 'refused' | 'http-404' | 'no-releases'

/** 错误连同它的 `cause` 链摊平：code / statusCode / 文本。Node fetch 的「fetch failed」真正原因在 cause 里。 */
function errorFacts(err: unknown): { codes: string[]; statuses: number[]; text: string } {
  const codes: string[] = []
  const statuses: number[] = []
  const texts: string[] = []
  let cur: unknown = err
  for (let depth = 0; depth < 4 && cur !== undefined && cur !== null; depth += 1) {
    texts.push(String(cur))
    if (typeof cur !== 'object') break
    const e = cur as { code?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown }
    if (typeof e.code === 'string') codes.push(e.code)
    if (typeof e.statusCode === 'number') statuses.push(e.statusCode)
    if (typeof e.message === 'string') texts.push(e.message)
    cur = e.cause
  }
  return { codes, statuses, text: texts.join(' ') }
}

/**
 * WP235：这次查更新失败，是不是因为**这个源还不存在**（还没开张），而不是坏了。
 * 自有下载站 `dl.agentsws.com` 还没绑定、GitHub 上还一个发布都没有的这段日子，每次查都会失败——
 * 那不是错误，不该在日志里打 ERROR 堆栈、也不该让按钮显示出错。
 *
 * 口径（只认这几种，其余一律按真错误照原级别记）：
 * - `dns`：域名解析不到——Node 的 `ENOTFOUND`、Electron 的 `net::ERR_NAME_NOT_RESOLVED`（域名还没绑）
 * - `refused`：连接被拒——`ECONNREFUSED`、`net::ERR_CONNECTION_REFUSED`（域名在、上面没服务）
 * - `http-404`：版本信息文件不存在——electron-updater 的 `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`、
 *   `HttpError` 的 statusCode 404、我们自己抛的 `HTTP 404`（GitHub 仓库 / releases 列表 404 也是它）
 * - `no-releases`：GitHub 上一个发布都没有——`ERR_UPDATER_NO_PUBLISHED_VERSIONS`、
 *   atom 里没有 entry 时的「No published versions on GitHub」
 *
 * **不算**的（照旧 warn / error）：超时、连接被重置、断网（`net::ERR_INTERNET_DISCONNECTED`）、
 * 5xx、证书错、源回了内容但解析坏了（`ERR_UPDATER_INVALID_RELEASE_FEED`，哪怕里面夹着 404 字样）。
 *
 * 状态机怎么用它：**这一轮查过的源全都「不存在」**才算「暂无更新源」——主源连不上会退到 GitHub
 * （见 `unreachable`），那就要两个源都是这样；主源 404 按原规则不退 GitHub、或者 GitHub 开关关着，
 * 那这一轮只查了主源，主源不存在就算。
 */
export function sourceMissing(err: unknown): SourceMissingReason | undefined {
  const { codes, statuses, text } = errorFacts(err)
  if (codes.includes('ERR_UPDATER_INVALID_RELEASE_FEED')) return undefined
  if (/\bENOTFOUND\b|net::ERR_NAME_NOT_RESOLVED\b/.test(text)) return 'dns'
  if (/\bECONNREFUSED\b|net::ERR_CONNECTION_REFUSED\b/.test(text)) return 'refused'
  if (codes.includes('ERR_UPDATER_NO_PUBLISHED_VERSIONS') || /No published versions/i.test(text))
    return 'no-releases'
  if (
    codes.includes('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') ||
    statuses.includes(404) ||
    /\bHttp(?:Error:)?\s*404\b/i.test(text)
  )
    return 'http-404'
  return undefined
}

/** electron-updater 的 `autoUpdater.logger` 要的形状。 */
export interface ElectronUpdaterLogger {
  info(message?: unknown): void
  warn(message?: unknown): void
  error(message?: unknown): void
  debug(message: string): void
}

/**
 * WP235：交给 electron-updater 的 logger。
 *
 * 根因：`AppUpdater` 构造时自己挂了 `on('error', e => logger.error('Error: ' + e.stack))`，
 * `checkForUpdates()` 失败时先 `emit('error')` 再把错抛出来——所以源还不存在时，
 * 日志里先来一段 ERROR 级的堆栈，然后状态机才拿到错。
 *
 * 这里：**正在查**（`checking()` 为真）且是「源还不存在」那一类的 error，不写（查的结论由状态机统一记一行 info）；
 * 其余照旧 error——下载失败、差分下载回退、安装出错都不在「查」里，一个不漏。debug 不写。
 */
export function electronUpdaterLogger(
  logger: Logger,
  checking: () => boolean,
): ElectronUpdaterLogger {
  return {
    info: (m) => {
      logger.info(String(m))
    },
    warn: (m) => {
      logger.warn(String(m))
    },
    error: (m) => {
      if (checking() && sourceMissing(m) !== undefined) return
      logger.error(String(m))
    },
    debug: () => undefined,
  }
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

  /**
   * WP235：这一轮查过的源都还不存在（口径见 `sourceMissing`）——不是出错，就是「暂无新版本」。
   * 只记一行 info（不带堆栈），按钮回到 idle（= 已是最新，左下角那颗按钮不出现）。
   * 已经是 idle 就不再广播（省得订阅方每 4 小时再记一行「更新状态 idle」）。
   */
  const nothingYet = (message: string, fields: Readonly<Record<string, unknown>>): UpdateStatus => {
    log.info(message, fields)
    return busy() || current.state === 'idle' ? current : set({ state: 'idle' })
  }

  const runCheck = async (): Promise<UpdateStatus> => {
    if (options.mode === 'off' || busy()) return current
    /** 主源「还不存在」的样子；是真错误时为 undefined（那就已经 warn 过了）。 */
    let primaryMissing: SourceMissingReason | undefined
    try {
      const info = await options.primary.check()
      active = options.primary
      activeSource = 'primary'
      return found(info, 'primary')
    } catch (err) {
      primaryMissing = sourceMissing(err)
      if (primaryMissing === undefined) log.warn('主源查更新失败', { error: String(err) })
      if (options.fallback === undefined || !unreachable(err)) {
        // 这一轮只查了主源（GitHub 开关关着，或主源 404 按规则不退）
        return primaryMissing === undefined
          ? current
          : nothingYet('还没有可用的更新源，暂无新版本', { primary: primaryMissing })
      }
    }
    // 主源连不上：退到 GitHub 查一次（开关在 `update-feed.ts` 的 githubFallbackEnabled）
    try {
      const backend = await options.fallback()
      const info = await backend.check()
      active = backend
      activeSource = 'github'
      if (info === undefined && primaryMissing !== undefined)
        return nothingYet('暂无新版本', { primary: primaryMissing, github: 'no-newer' })
      return found(info, 'github')
    } catch (err) {
      const githubMissing = sourceMissing(err)
      if (primaryMissing !== undefined && githubMissing !== undefined)
        return nothingYet('还没有可用的更新源，暂无新版本', {
          primary: primaryMissing,
          github: githubMissing,
        })
      if (githubMissing === undefined)
        log.warn('备用源（GitHub）查更新也失败', {
          error: String(err),
          ...(primaryMissing === undefined ? {} : { primary: primaryMissing }),
        })
      // 主源是真错误（上面已 warn），GitHub 只是还没发布：这一半不是错
      else log.info('备用源（GitHub）上还没有发布', { github: githubMissing })
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

/**
 * WP225（WP218 决定 ③）：「重启并更新」前要不要问一句「有任务在跑，确定现在重启？」——
 * 官方场景在跑、AI 正在操作电脑、岗位 AI 正在干活（`GET /v1/activity`），有一样就问；都没有就直接装。
 * 岗位 AI 那一项问不到（服务没起来、旧服务进程）按「没有」算：不能因为问不到就永远装不上。
 */
export function busyBeforeRestart(input: {
  officialScenes: boolean
  computerUse: boolean
  aiRuns: number | undefined
}): boolean {
  return input.officialScenes || input.computerUse || (input.aiRuns ?? 0) > 0
}
