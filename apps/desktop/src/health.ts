/**
 * 服务进程健康探测：`GET /v1/health`（28 §1；急停时也必须能看，所以它是 public 路由）。
 * 托盘的"状态"、更新前的冒烟、窗口打开前的等待都用它。
 */
import type { FetchLike } from './ports.js'

export interface HealthSnapshot {
  /** HTTP 200 且 `data.status` 存在。 */
  ok: boolean
  /** `ok` / `degraded` / `halted`。 */
  status: string | undefined
  version: string | undefined
  /** 任一档位打开。 */
  halted: boolean
  at: string | undefined
  error: string | undefined
}

const UNREACHABLE = (error: string): HealthSnapshot => ({
  ok: false,
  status: undefined,
  version: undefined,
  halted: false,
  at: undefined,
  error,
})

interface HealthBody {
  status?: unknown
  version?: unknown
  at?: unknown
  halt?: unknown
}

export function parseHealthBody(text: string): HealthSnapshot {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return UNREACHABLE('响应不是合法 JSON')
  }
  const envelope = raw as { data?: unknown } | null
  const data = (envelope?.data ?? raw) as HealthBody | null
  if (typeof data !== 'object' || data === null || typeof data.status !== 'string')
    return UNREACHABLE('响应里没有 status')
  const halt = data.halt
  let halted = false
  if (typeof halt === 'object' && halt !== null)
    halted = Object.values(halt as Record<string, unknown>).some(
      (v) => typeof v === 'object' && v !== null && (v as { on?: unknown }).on === true,
    )
  return {
    ok: true,
    status: data.status,
    version: typeof data.version === 'string' ? data.version : undefined,
    halted,
    at: typeof data.at === 'string' ? data.at : undefined,
    error: undefined,
  }
}

export interface ProbeOptions {
  fetchImpl: FetchLike
  timeoutMs?: number
  /** 注入的中断源；不给就不设超时（测试里用不着真定时器）。 */
  abort?: (timeoutMs: number) => { signal: AbortSignal; done: () => void }
}

/** `baseUrl` 形如 `http://127.0.0.1:4317`。 */
export function healthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/health`
}

export async function probeHealth(baseUrl: string, options: ProbeOptions): Promise<HealthSnapshot> {
  const { fetchImpl } = options
  const guard = options.abort?.(options.timeoutMs ?? 3000)
  try {
    const res = await fetchImpl(healthUrl(baseUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(guard === undefined ? {} : { signal: guard.signal }),
    })
    const text = await res.text()
    if (!res.ok) return UNREACHABLE(`HTTP ${res.status}`)
    return parseHealthBody(text)
  } catch (err) {
    return UNREACHABLE(String(err))
  } finally {
    guard?.done()
  }
}

export interface WaitOptions extends ProbeOptions {
  attempts?: number
  delayMs?: number
  sleep: (ms: number) => Promise<void>
}

/** 轮询到健康为止；用完次数就把最后一次结果返回（调用方决定怎么报错）。 */
export async function waitForHealth(
  baseUrl: string,
  options: WaitOptions,
): Promise<HealthSnapshot> {
  const attempts = options.attempts ?? 30
  const delayMs = options.delayMs ?? 200
  let last = UNREACHABLE('未探测')
  for (let i = 0; i < attempts; i += 1) {
    last = await probeHealth(baseUrl, options)
    if (last.ok) return last
    if (i < attempts - 1) await options.sleep(delayMs)
  }
  return last
}
