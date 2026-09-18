/**
 * 自动更新（13 §5「按顺序更新 sidecar，更新前跑一次冒烟；失败回滚」）。
 *
 * WP111 起接了真更新源：**GitHub Releases，渠道 `beta`**（`electron-builder.yml` 的
 * `publish: github`）。但两个平台走的不是同一条路，而这个差别是**签名**定的，
 * 不是我们挑的：
 *
 * | 平台 | 走哪条 | 为什么 |
 * |---|---|---|
 * | Windows（NSIS） | **应用内自动更新** | 未签名的 NSIS 照样能自更新。第一位内测用户用 Windows，这是主路径 |
 * | macOS | **只提示，打开下载页** | Squirrel.Mac 强制校验代码签名，未签名连 `checkForUpdates()` 都过不去。硬接只会得到一个每次都报错的更新器 |
 * | Linux（AppImage） | 只提示 | 顺带发的一档，自动更新没在真机上验过。没验过的东西不该默认开着 |
 *
 * 将来 mac 签名 / 公证做了，切自动只要一个开关：`AGENTSWS_MAC_AUTOUPDATE=1`
 * （默认关，见 {@link updatePolicy}）。
 *
 * **不变的那条纪律**：自动那条路上，下载完先打一次 `GET /v1/health`，不 ok 就停在原地，
 * 旧版本继续跑——宁可不更新，也不要把用户换到一个起不来的版本上。
 */
import type { Logger } from './logging.js'
import type { FetchLike } from './ports.js'

export interface UpdateInfo {
  version: string
  /** 这一版的下载页（notify 档要把用户送过去）。 */
  url?: string
}

/** `electron-updater` 的 `autoUpdater` 里我们用到的那几件事。 */
export interface UpdaterPort {
  checkForUpdates(): Promise<UpdateInfo | undefined>
  downloadUpdate(): Promise<void>
  quitAndInstall(): void
}

export type UpdateOutcomeState =
  | 'disabled'
  | 'none'
  | 'blocked'
  | 'installing'
  /** WP111：有新版本，但这个平台只提示（mac / linux）。 */
  | 'notified'
  | 'error'

export interface UpdateOutcome {
  state: UpdateOutcomeState
  version: string | undefined
  reason: string | undefined
}

/** 这台机器上更新怎么走。 */
export type UpdateMode =
  /** 应用内下载 + 冒烟 + 切换。 */
  | 'auto'
  /** 只告诉用户有新版本，把他送到下载页。 */
  | 'notify'
  /** 不查（开发期、或者用户明确关掉）。 */
  | 'off'

export interface UpdatePolicy {
  mode: UpdateMode
  /** 为什么是这一档（进日志与诊断包——"为什么我的 mac 不自动更新"要答得上来）。 */
  reason: string
}

/** 开关：`0` 关掉一切检查；`1` 在开发期也查（调试用）。 */
export const UPDATES_ENV = 'AGENTSWS_DESKTOP_UPDATES'
/** 将来 mac 签名 / 公证做了，把它设成 `1` 就切自动。默认关。 */
export const MAC_AUTOUPDATE_ENV = 'AGENTSWS_MAC_AUTOUPDATE'

export function updatePolicy(input: {
  platform: string
  env: Readonly<Record<string, string | undefined>>
  /** `app.isPackaged`。开发期的 `dist/` 没有版本可比。 */
  packaged: boolean
}): UpdatePolicy {
  const flag = input.env[UPDATES_ENV]
  if (flag === '0') return { mode: 'off', reason: `${UPDATES_ENV}=0，用户关掉了更新检查` }
  if (!input.packaged && flag !== '1') return { mode: 'off', reason: '开发期不查更新' }
  if (input.platform === 'win32') return { mode: 'auto', reason: 'Windows：未签名也能应用内更新' }
  if (input.platform === 'darwin') {
    return input.env[MAC_AUTOUPDATE_ENV] === '1'
      ? { mode: 'auto', reason: `${MAC_AUTOUPDATE_ENV}=1，已签名，走自动更新` }
      : {
          mode: 'notify',
          reason: 'macOS 未签名：Squirrel 过不了签名校验，只提示 + 打开下载页',
        }
  }
  return { mode: 'notify', reason: `${input.platform}：自动更新没在真机上验过，只提示` }
}

// ── 版本比较（只为了回答"那边那个是不是比我新"）────────────────────────

/**
 * `0.1.0-beta.2` 这一类的比较。
 *
 * 不引 semver：这里只需要"数字段逐个比，带 `-beta.N` 的小于同号正式版，
 * 两个预发布按点分段比"。一个 30 行的函数换一个依赖，不值。
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string[] } => {
    const clean = v.trim().replace(/^v/, '')
    const [core = '', ...rest] = clean.split('-')
    const pre = rest.join('-')
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: pre === '' ? [] : pre.split('.'),
    }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  // 有预发布段的小于没有的（0.1.0-beta.1 < 0.1.0）
  if (x.pre.length === 0 && y.pre.length > 0) return 1
  if (x.pre.length > 0 && y.pre.length === 0) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const l = x.pre[i]
    const r = y.pre[i]
    if (l === r) continue
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = Number.parseInt(l, 10)
    const rn = Number.parseInt(r, 10)
    if (Number.isNaN(ln) || Number.isNaN(rn)) return l < r ? -1 : 1
    return ln < rn ? -1 : 1
  }
  return 0
}

export function isNewer(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0
}

// ── notify 档的"查一下有没有新版本" ─────────────────────────────────────

/** 发布源。与 `electron-builder.yml` 的 `publish` 是同一个仓库（两处改要一起改）。 */
export const RELEASE_REPO = 'Luoye-W/agentsws'
export const RELEASES_PAGE = `https://github.com/${RELEASE_REPO}/releases`

interface GithubRelease {
  tag_name?: unknown
  draft?: unknown
  prerelease?: unknown
  html_url?: unknown
}

/**
 * GitHub 的 releases 列表里挑最新的那一个 beta。
 *
 * 为什么不用 `electron-updater` 查：mac 上它连查都过不去（要校验运行中应用的签名）。
 * 这里只是一次匿名 GET + 一次版本比较，**没有任何凭据，也不下载任何东西**。
 */
export function pickLatestBeta(body: unknown, current: string): UpdateInfo | undefined {
  if (!Array.isArray(body)) return undefined
  let best: UpdateInfo | undefined
  for (const raw of body as GithubRelease[]) {
    if (raw?.draft === true) continue
    const tag = typeof raw?.tag_name === 'string' ? raw.tag_name : undefined
    if (tag === undefined || !tag.includes('-beta.')) continue
    const version = tag.replace(/^v/, '')
    if (!isNewer(current, version)) continue
    if (best !== undefined && !isNewer(best.version, version)) continue
    best = {
      version,
      url: typeof raw?.html_url === 'string' ? raw.html_url : RELEASES_PAGE,
    }
  }
  return best
}

export interface ReleaseCheckerOptions {
  fetchImpl: FetchLike
  currentVersion: string
  repo?: string
  timeoutMs?: number
  abort?: (timeoutMs: number) => { signal: AbortSignal; done: () => void }
}

/** 一个只会"查"的 `UpdaterPort`：下载与安装都明确不做（notify 档用）。 */
export function createReleaseChecker(options: ReleaseCheckerOptions): UpdaterPort {
  const repo = options.repo ?? RELEASE_REPO
  return {
    async checkForUpdates() {
      const guard = options.abort?.(options.timeoutMs ?? 8000)
      try {
        const res = await options.fetchImpl(`https://api.github.com/repos/${repo}/releases`, {
          method: 'GET',
          headers: { accept: 'application/vnd.github+json' },
          ...(guard === undefined ? {} : { signal: guard.signal }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return pickLatestBeta(JSON.parse(await res.text()), options.currentVersion)
      } finally {
        guard?.done()
      }
    },
    downloadUpdate: () => Promise.reject(new Error('这个平台不做应用内下载')),
    quitAndInstall: () => undefined,
  }
}

// ── 闸 ─────────────────────────────────────────────────────────────────

export interface UpdateGateOptions {
  updater: UpdaterPort
  /** 更新前冒烟：`GET /v1/health` 通过才返回 true。 */
  smoke: () => Promise<boolean>
  logger: Logger
  /**
   * 旧开关（WP16 起就有）。`mode` 没给时仍然按它走：`true` = auto、`false` = off。
   * 给了 `mode` 就以 `mode` 为准。
   */
  enabled?: boolean
  /** WP111：这台机器上更新怎么走（`updatePolicy()` 算出来的那一档）。 */
  mode?: UpdateMode
  /** `notify` 档：告诉用户有新版本（托盘上挂一项 + 弹一条通知）。 */
  notify?: (info: UpdateInfo) => void
}

export interface UpdateGate {
  run(): Promise<UpdateOutcome>
}

const outcome = (state: UpdateOutcomeState, version?: string, reason?: string): UpdateOutcome => ({
  state,
  version,
  reason,
})

export function createUpdateGate(options: UpdateGateOptions): UpdateGate {
  const log = options.logger.child('updater')
  const mode: UpdateMode = options.mode ?? (options.enabled === true ? 'auto' : 'off')
  return {
    async run() {
      if (mode === 'off') return outcome('disabled', undefined, '未配置更新源')
      let info: UpdateInfo | undefined
      try {
        info = await options.updater.checkForUpdates()
      } catch (err) {
        log.warn('检查更新失败', { error: String(err) })
        return outcome('error', undefined, String(err))
      }
      if (info === undefined) return outcome('none')

      // notify 档到此为止：不下载、不切换，把人送到下载页。
      if (mode === 'notify') {
        log.info('有新版本（本平台只提示）', { version: info.version })
        options.notify?.(info)
        return outcome('notified', info.version, info.url ?? RELEASES_PAGE)
      }

      try {
        await options.updater.downloadUpdate()
      } catch (err) {
        log.warn('下载更新失败', { version: info.version, error: String(err) })
        return outcome('error', info.version, String(err))
      }
      let healthy = false
      try {
        healthy = await options.smoke()
      } catch (err) {
        log.warn('更新前冒烟抛错', { version: info.version, error: String(err) })
        return outcome('blocked', info.version, String(err))
      }
      if (!healthy) {
        log.warn('更新前冒烟未通过，保持旧版本', { version: info.version })
        return outcome('blocked', info.version, '冒烟未通过：GET /v1/health 不 ok')
      }
      log.info('冒烟通过，准备切换到新版本', { version: info.version })
      options.updater.quitAndInstall()
      return outcome('installing', info.version)
    },
  }
}
