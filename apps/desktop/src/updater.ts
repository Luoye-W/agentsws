/**
 * 自动更新骨架（13 §5「按顺序更新 sidecar，更新前跑一次冒烟；失败回滚」）。
 *
 * v1 **不接真更新源**：`electron-updater` 的 feed 没配，`createUpdateGate()` 默认
 * `enabled: false`。这里落地的是那道纪律——**冒烟不过就不切换**：下载完先打一次
 * `GET /v1/health`，不 ok 就停在原地，旧版本继续跑。
 */
import type { Logger } from './logging.js'

export interface UpdateInfo {
  version: string
}

/** `electron-updater` 的 `autoUpdater` 里我们用到的那几件事。 */
export interface UpdaterPort {
  checkForUpdates(): Promise<UpdateInfo | undefined>
  downloadUpdate(): Promise<void>
  quitAndInstall(): void
}

export type UpdateOutcomeState = 'disabled' | 'none' | 'blocked' | 'installing' | 'error'

export interface UpdateOutcome {
  state: UpdateOutcomeState
  version: string | undefined
  reason: string | undefined
}

export interface UpdateGateOptions {
  updater: UpdaterPort
  /** 更新前冒烟：`GET /v1/health` 通过才返回 true。 */
  smoke: () => Promise<boolean>
  logger: Logger
  /** v1 默认关；接了真更新源再打开。 */
  enabled?: boolean
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
  const enabled = options.enabled ?? false
  return {
    async run() {
      if (!enabled) return outcome('disabled', undefined, '未配置更新源')
      let info: UpdateInfo | undefined
      try {
        info = await options.updater.checkForUpdates()
      } catch (err) {
        log.warn('检查更新失败', { error: String(err) })
        return outcome('error', undefined, String(err))
      }
      if (info === undefined) return outcome('none')
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
