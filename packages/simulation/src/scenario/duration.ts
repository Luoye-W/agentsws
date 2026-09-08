import type { Iso8601 } from '@agentsws/contracts'
import { SimulationError } from '../errors.js'

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/

/** `65m` / `2h` / `1d` / `500ms` → 毫秒。 */
export function parseDuration(text: string): number {
  const m = DURATION_RE.exec(text.trim())
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new SimulationError('invalid_input', `不是合法的时长：${text}`, { text })
  }
  return Math.round(Number.parseFloat(m[1]) * (UNIT_MS[m[2]] ?? 1))
}

/** `2h..8h` → `{ min, max }`（毫秒）；单值也接受。 */
export function parseRange(text: string): { min: number; max: number } {
  const parts = text.split('..')
  if (parts.length === 1 && parts[0] !== undefined) {
    const v = parseDuration(parts[0])
    return { min: v, max: v }
  }
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new SimulationError('invalid_input', `不是合法的时长区间：${text}`, { text })
  }
  const min = parseDuration(parts[0])
  const max = parseDuration(parts[1])
  if (max < min) throw new SimulationError('invalid_input', `时长区间 max < min：${text}`, { text })
  return { min, max }
}

/**
 * 场景 `at`：`+65m` 相对开钟时刻；裸 ISO-8601 视为绝对时刻。
 * 事件按虚拟时间执行，时钟不可回拨（25 §6.5）。
 */
export function resolveAt(at: string, start: Iso8601): Iso8601 {
  const text = at.trim()
  if (text.startsWith('+')) {
    const ms = parseDuration(text.slice(1))
    return new Date(Date.parse(start) + ms).toISOString()
  }
  const abs = Date.parse(text)
  if (!Number.isFinite(abs)) {
    throw new SimulationError('invalid_input', `不是合法的事件时刻：${at}`, { at })
  }
  return new Date(abs).toISOString()
}
