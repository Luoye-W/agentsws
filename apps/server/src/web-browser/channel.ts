/**
 * WP353：服务进程 → 桌面壳「应用内搜索浏览器」的本机通道（客户端这一半；壳那一半在
 * `apps/desktop/src/search-browser.ts`）。地址与口令由壳经环境变量给（与会话密钥同一条路），
 * 只连 127.0.0.1。没有桌面壳（CI、云端值守、纯服务进程）= 没有这两个变量 = 没有这条通道。
 */

export const SEARCH_BROWSER_URL_ENV = 'AGENTSWS_SEARCH_BROWSER_URL'
export const SEARCH_BROWSER_TOKEN_ENV = 'AGENTSWS_SEARCH_BROWSER_TOKEN'

export interface PageSignals {
  title: string
  text: string
  captcha: boolean
  passwordInputs: number
}

export type OpenResult =
  | {
      ok: true
      status: number
      final_url: string
      serp?: { signals: PageSignals; items: { url: string; title: string; snippet?: string }[] }
      page?: { signals: PageSignals; text: string; truncated: boolean }
    }
  | { ok: false; reason: 'timeout' | 'failed' | 'revealed' | 'unreachable'; message: string }

export interface SearchBrowserChannel {
  open(input: {
    workspace_id: string
    url: string
    /** WP393：`data` = 读数据地址的原文（竞品店公开商品数据被直接请求挡了时）。 */
    kind: 'google' | 'bing' | 'page' | 'data'
    timeout_ms: number
    settle_ms?: number
    max_chars?: number
  }): Promise<OpenResult>
  reveal(input: {
    workspace_id: string
    url: string
    reason: 'captcha' | 'login'
    message: string
  }): Promise<boolean>
  status(workspace_id: string): Promise<{ revealed: boolean; verified_at?: number } | undefined>
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** 从环境变量接上通道；两样缺一样、或者地址不是本机回环 = 没有。 */
export function searchBrowserChannelFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: Fetch = fetch,
): SearchBrowserChannel | undefined {
  const base = env[SEARCH_BROWSER_URL_ENV]
  const token = env[SEARCH_BROWSER_TOKEN_ENV]
  if (base === undefined || base === '' || token === undefined || token === '') return undefined
  let u: URL
  try {
    u = new URL(base)
  } catch {
    return undefined
  }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') return undefined
  const root = base.replace(/\/$/, '')
  const call = async (path: string, init: RequestInit, timeoutMs: number): Promise<unknown> => {
    const res = await fetchImpl(`${root}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`桌面壳回了 ${res.status}`)
    return res.json()
  }
  return {
    async open(input) {
      try {
        return (await call(
          '/open',
          { method: 'POST', body: JSON.stringify(input) },
          input.timeout_ms + 30_000,
        )) as OpenResult
      } catch (err) {
        return {
          ok: false,
          reason: 'unreachable',
          message: `连不上工坊的内置浏览器：${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
    async reveal(input) {
      try {
        const got = (await call(
          '/reveal',
          { method: 'POST', body: JSON.stringify(input) },
          10_000,
        )) as {
          shown?: boolean
        }
        return got.shown === true
      } catch {
        return false
      }
    },
    async status(workspace_id) {
      try {
        return (await call(
          `/status?workspace_id=${encodeURIComponent(workspace_id)}`,
          { method: 'GET' },
          5_000,
        )) as { revealed: boolean; verified_at?: number }
      } catch {
        return undefined
      }
    },
  }
}
