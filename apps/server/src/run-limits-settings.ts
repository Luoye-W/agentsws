/**
 * WP236：「设置 → 通用」里的运行时长线——**这台机器一份**（与浏览器设置同理：跑得多久与卖哪个品牌无关）。
 *
 * 一个 JSON 文件跟着数据目录走（没有数据目录 = 内存档）。读坏了就当缺省（它只是偏好）。
 * 职责阈值 `run_idle_timeout_seconds` / `run_max_duration_seconds` 比这里优先（`resolveRunTimeLimits`）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_RUN_TIME_LIMITS,
  RUN_IDLE_TIMEOUT_RANGE,
  RUN_MAX_DURATION_RANGE,
  type RunTimeLimits,
} from '@agentsws/contracts'

export interface RunLimitsSettings {
  get(): RunTimeLimits
  set(next: RunTimeLimits): RunTimeLimits
}

const inRange = (v: unknown, r: { min: number; max: number }): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max

/** 合法化：越界的回缺省；空闲线不长过总时长。 */
export function normalizeRunLimits(input: Partial<RunTimeLimits>): RunTimeLimits {
  const max_duration_seconds = inRange(input.max_duration_seconds, RUN_MAX_DURATION_RANGE)
    ? input.max_duration_seconds
    : DEFAULT_RUN_TIME_LIMITS.max_duration_seconds
  const idle = inRange(input.idle_timeout_seconds, RUN_IDLE_TIMEOUT_RANGE)
    ? input.idle_timeout_seconds
    : DEFAULT_RUN_TIME_LIMITS.idle_timeout_seconds
  return { idle_timeout_seconds: Math.min(idle, max_duration_seconds), max_duration_seconds }
}

export function createRunLimitsSettings(options: { dir?: string } = {}): RunLimitsSettings {
  const file = options.dir === undefined ? undefined : join(options.dir, 'run-limits.json')
  let state: RunTimeLimits = { ...DEFAULT_RUN_TIME_LIMITS }
  if (file !== undefined && existsSync(file)) {
    try {
      state = normalizeRunLimits(JSON.parse(readFileSync(file, 'utf8')) as Partial<RunTimeLimits>)
    } catch {
      // 读坏了回缺省
    }
  }
  return {
    get: () => ({ ...state }),
    set(next) {
      state = normalizeRunLimits(next)
      if (file !== undefined) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      }
      return { ...state }
    },
  }
}
