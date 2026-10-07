/**
 * WP247：钉死版本的**锁文件**（`npm ci` 吃它：318 个包每个都有确定的版本、下载地址与 sha512，
 * 任何一个对不上 npm 就整个不装）。只有服务进程的安装器用——单独一个模块，免得桌面壳主进程
 * import `./local-runtime` 时把这 150 KB 也拖进来。
 *
 * 重出：`node scripts/open-connector-lock.mjs`（要联网；改 {@link OPEN_CONNECTOR_PIN} 时一起跑）。
 */
import LOCK from './open-connector-lock.json' with { type: 'json' }

export interface OpenConnectorLockEntry {
  version?: string
  resolved?: string
  integrity?: string
  license?: string | string[]
  dependencies?: Record<string, string>
}

export interface OpenConnectorLockfile {
  name: string
  lockfileVersion: number
  packages: Record<string, OpenConnectorLockEntry & { name?: string }>
}

export const OPEN_CONNECTOR_LOCKFILE: OpenConnectorLockfile = LOCK as OpenConnectorLockfile

/** 锁文件里要下载的包有几个（进度条的分母）。 */
export function lockedPackageCount(lock: OpenConnectorLockfile = OPEN_CONNECTOR_LOCKFILE): number {
  return Object.entries(lock.packages).filter(
    ([path, e]) => path !== '' && e.resolved !== undefined,
  ).length
}
