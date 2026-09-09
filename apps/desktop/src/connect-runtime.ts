/**
 * OpenConnector 本地 runtime 的**检测 + 加固检查**（08 §5 安装器策略）。
 *
 * v1 只回答"它在不在、加固过没有"，**不负责拉起**——docker 还是 npm 是发行形态的
 * 选择，得等打包与升级策略一起定（13 §5 三档部署）。`ConnectLauncher` 是给
 * 那一步留的口子：`notImplementedLauncher()` 会明确抛 `not_implemented`，
 * 而不是悄悄假装成功。
 */
import type { Clock } from './ports.js'

export const DEFAULT_CONNECT_URL = 'http://127.0.0.1:3000'

export type ConnectRuntimeState =
  /** 探不到 —— 还没装 / 没起。 */
  | 'absent'
  /** 起着，但鉴权或加密没开：08 §5 要求此时**不得**接入。 */
  | 'unhardened'
  | 'ready'

export interface ConnectHardeningCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ConnectRuntimeStatus {
  state: ConnectRuntimeState
  baseUrl: string
  reasons: readonly string[]
  checks: readonly ConnectHardeningCheck[]
  checkedAt: string
}

/** `assertRuntimeHardened()` 的结构化形状；桌面壳不直接 import connect-adapter 的实现。 */
export interface HardeningReportLike {
  ok: boolean
  reasons: readonly string[]
  checks: readonly ConnectHardeningCheck[]
}

export type HardeningProbe = (baseUrl: string) => Promise<HardeningReportLike>

export type ConnectLaunchMode = 'docker' | 'npm'

/** 预留：v1 不实现，只保证接口形状定下来。 */
export interface ConnectLauncher {
  readonly mode: ConnectLaunchMode
  start(): Promise<void>
  stop(): Promise<void>
}

export class NotImplementedError extends Error {
  readonly code = 'not_implemented'
  constructor(what: string) {
    super(`${what} 在 v1 未实现`)
    this.name = 'NotImplementedError'
  }
}

export function notImplementedLauncher(mode: ConnectLaunchMode): ConnectLauncher {
  return {
    mode,
    start: () =>
      Promise.reject(new NotImplementedError(`以 ${mode} 方式拉起 OpenConnector runtime`)),
    stop: () =>
      Promise.reject(new NotImplementedError(`以 ${mode} 方式停止 OpenConnector runtime`)),
  }
}

export interface ConnectRuntimeOptions {
  baseUrl?: string
  probe: HardeningProbe
  clock: Clock
  launcher?: ConnectLauncher
}

export interface ConnectRuntime {
  check(): Promise<ConnectRuntimeStatus>
  last(): ConnectRuntimeStatus | undefined
  readonly launcher: ConnectLauncher | undefined
}

/** `runtime_unreachable` 是"没装"，其余不 ok 的理由都算"装了但没加固"。 */
export function classify(report: HardeningReportLike): ConnectRuntimeState {
  if (report.ok) return 'ready'
  return report.reasons.includes('runtime_unreachable') ? 'absent' : 'unhardened'
}

export function createConnectRuntime(options: ConnectRuntimeOptions): ConnectRuntime {
  const baseUrl = options.baseUrl ?? DEFAULT_CONNECT_URL
  let cached: ConnectRuntimeStatus | undefined
  return {
    get launcher() {
      return options.launcher
    },
    last: () => cached,
    async check() {
      let report: HardeningReportLike
      try {
        report = await options.probe(baseUrl)
      } catch (err) {
        report = {
          ok: false,
          reasons: ['runtime_unreachable'],
          checks: [{ name: 'probe', ok: false, detail: String(err) }],
        }
      }
      cached = {
        state: classify(report),
        baseUrl,
        reasons: [...report.reasons],
        checks: report.checks.map((c) => ({ ...c })),
        checkedAt: options.clock.now(),
      }
      return cached
    },
  }
}
