/**
 * WP115 后台测试的共用装配。
 *
 * **全内存、不联网**：账号库 `:memory:`，钱包库也是 `:memory:` 的 sqlite
 * （不是 `MemoryWalletStore`——后台的聚合全在 SQL 里做，内存 store 没有 `db`）。
 */

import { syncDbFromBetterSqlite } from '@agentsws/core/sql/sync-db'
import {
  type KolAdminPort,
  localKolAdminPort,
  nodeKolSecrets,
  SqliteKolStore,
} from '@agentsws/kol-public'
import {
  createSqliteWalletStore,
  type SqliteWalletStore,
  sqlUsageLedger,
  sqlWalletAdminPort,
  type UsageLedger,
  Wallet,
  type WalletAdminPort,
} from '@agentsws/metering'
import Database from 'better-sqlite3'
import {
  type AdminStore,
  adminConsoleRoutes,
  createAdminStore,
  mountAdminPages,
} from '../src/index.js'
import { type Harness, harness, type TestClock, testClock } from './helpers.js'

export const BOOTSTRAP_TOKEN = 'test-admin-token-0123456789abcdef0123456789abcdef'
export const BASE_URL = 'https://cloud.example.test'

export interface AdminHarness {
  h: Harness
  clock: TestClock
  admin: AdminStore
  wallet: Wallet
  store: SqliteWalletStore
  /** 读账那一层（Compose 形态下钱包库就是账本）。 */
  ledger: UsageLedger
  port: WalletAdminPort
  /** 直接打库的那一份（测试里要断言行数）。 */
  meter: {
    prepare<R = Record<string, unknown>>(
      sql: string,
    ): { get(...p: unknown[]): R | undefined; all(...p: unknown[]): R[] }
  }
  /** 带 cookie 的调用（后台的凭据是 cookie，不是 Bearer）。 */
  call(
    path: string,
    init?: {
      method?: string
      body?: unknown
      session?: string
      csrf?: string
      headers?: Record<string, string>
    },
  ): Promise<{ status: number; body: { data?: unknown; code?: string; message?: string } }>
  raw(
    path: string,
    init?: {
      method?: string
      body?: unknown
      session?: string
      csrf?: string
      headers?: Record<string, string>
    },
  ): Promise<{ status: number; text: string; headers: Headers }>
  /** 公共红人库那一侧（WP116 §4）。`kol: false` 时是 `undefined`，那几条回 503。 */
  kol: KolAdminPort | undefined
  close(): Promise<void>
}

export function adminHarness(
  options: {
    clock?: TestClock
    /** 接不接公共红人库（WP116 §4）。默认**不接**——那几条路由回 503。 */
    kol?: boolean
    /** 邮箱密钥；不给就用一把测试用的假钥匙（32 字节 hex）。 */
    kolEmailKey?: string | undefined
  } = {},
): AdminHarness {
  const clock = options.clock ?? testClock()
  let adminStore: AdminStore | undefined
  const store = createSqliteWalletStore({ dbPath: ':memory:', now: () => clock.now() })
  let seq = 0
  const wallet = new Wallet({
    store,
    now: () => clock.now(),
    newId: (prefix) => `${prefix}_${String(++seq).padStart(6, '0')}`,
    onEvent: () => {},
  })
  const sync = syncDbFromBetterSqlite(store.db)
  const book = sqlUsageLedger(sync)
  const port = sqlWalletAdminPort({
    db: sync,
    wallet,
    appendEvent: (e) => {
      store.appendEvent(e)
    },
  })
  /*
   * 公共红人库（WP116 §4）。**落盘那份实现的内存档**：后台那一页要的统计 /
   * 搜索 / 搬家全在 SQL 里，`MemoryKolStore` 没有那几张表（`isLibraryStore`
   * 就是判这个）。所以这里开一张 `:memory:` 的真 sqlite。
   */
  const kolStore = options.kol === true ? new SqliteKolStore(new Database(':memory:')) : undefined
  const kolPort =
    kolStore === undefined
      ? undefined
      : localKolAdminPort({
          store: kolStore,
          secrets: nodeKolSecrets({
            env: { AGENTSWS_KOL_EMAIL_KEY: options.kolEmailKey ?? 'a'.repeat(64) },
          }),
          now: () => clock.now(),
        })
  let current: Harness | undefined
  const routes = adminConsoleRoutes({
    clock,
    accounts: () => {
      if (current === undefined) throw new Error('还没建服务器')
      return current.server.store
    },
    admin: () => {
      if (adminStore === undefined) throw new Error('还没建后台库')
      return adminStore
    },
    wallet: () => ({ wallet, port }),
    ledger: () => book,
    kol: () => kolPort,
    baseUrl: BASE_URL,
    // 信推进 harness 那个数组里：后台的登录信与云账号的登录信共用同一个投递口
    mail: async (mail) => {
      current?.mails.push(mail)
    },
    bootstrapToken: BOOTSTRAP_TOKEN,
    health: () => ({ modules: { entry: true, mail: true } }),
    warn: () => {},
  })
  const h = harness({ clock, modules: [routes] })
  current = h
  adminStore = createAdminStore(h.server, clock)
  mountAdminPages(h.server, { admin: () => adminStore as AdminStore, clock, baseUrl: BASE_URL })

  const fetchOnce = async (
    path: string,
    init: {
      method?: string
      body?: unknown
      session?: string
      csrf?: string
      headers?: Record<string, string>
    } = {},
  ): Promise<{ status: number; text: string; headers: Headers }> => {
    const headers = new Headers(init.headers ?? {})
    /*
     * 正文是**字符串**时原样发（搬家那条路由收的是 NDJSON，一行一条）——
     * 再 `JSON.stringify` 一次会把整块变成一个带引号的串，那时路由读到的
     * 是一行而不是四行。其余一律当 JSON。
     */
    const raw = typeof init.body === 'string' ? init.body : undefined
    if (init.body !== undefined && headers.get('content-type') === null)
      headers.set('content-type', raw === undefined ? 'application/json' : 'application/x-ndjson')
    const cookies: string[] = []
    if (init.session !== undefined) cookies.push(`__Host-agentsws_admin=${init.session}`)
    if (init.csrf !== undefined) {
      cookies.push(`agentsws_admin_csrf=${init.csrf}`)
      headers.set('X-Agentsws-Csrf', init.csrf)
    }
    if (cookies.length > 0) headers.set('Cookie', cookies.join('; '))
    const res = await h.server.fetch(
      new Request(`${BASE_URL}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: raw ?? JSON.stringify(init.body) }),
      }),
    )
    return { status: res.status, text: await res.text(), headers: res.headers }
  }

  return {
    h,
    clock,
    admin: adminStore,
    wallet,
    store,
    ledger: book,
    port,
    meter: sync,
    kol: kolPort,
    async call(path, init = {}) {
      const res = await fetchOnce(path, init)
      return {
        status: res.status,
        body: res.text === '' ? {} : (JSON.parse(res.text) as { data?: unknown }),
      }
    },
    raw: fetchOnce,
    async close() {
      store.close()
      kolStore?.close?.()
      await h.close()
    },
  }
}

/** 走一遍后台登录：提角色 → 发信 → 点链接 → 拿两张 cookie。 */
export async function staffLogin(
  ah: AdminHarness,
  email: string,
  role: 'admin' | 'support',
): Promise<{ account_id: string; session: string; csrf: string }> {
  const { account } = ah.h.server.store.ensureAccount(email)
  ah.admin.setRole(account.id, role)
  const issued = ah.h.server.store.issueLogin(account.id)
  const res = await ah.raw(`/admin/callback?token=${encodeURIComponent(issued.token)}`)
  if (res.status !== 302) throw new Error(`登录没成：${String(res.status)} ${res.text}`)
  const cookies = res.headers.getSetCookie()
  const pick = (name: string): string => {
    const line = cookies.find((c) => c.startsWith(`${name}=`))
    if (line === undefined) throw new Error(`没有 ${name} 这张 cookie`)
    return decodeURIComponent(line.slice(name.length + 1).split(';')[0] ?? '')
  }
  return {
    account_id: account.id,
    session: pick('__Host-agentsws_admin'),
    csrf: pick('agentsws_admin_csrf'),
  }
}

/** 往计量库里塞一条事件（造数据用；直接走 store，不经入口）。 */
export function seedEvent(
  ah: AdminHarness,
  e: {
    at: string
    org_id: string
    capability?: string
    provider?: string
    model?: string
    credits?: number
    cost_micros?: number
    input_tokens?: number
    output_tokens?: number
    charge_status?: string
    workspace_id?: string
  },
): void {
  ah.store.appendEvent({
    capability: e.capability ?? 'ai.chat',
    unit: '1k_tokens',
    quantity: 1,
    credits: e.credits ?? 1,
    at: e.at,
    org_id: e.org_id,
    workspace_id: e.workspace_id ?? 'ws_1',
    request_id: `req_${e.at}_${e.org_id}`,
    ...(e.provider === undefined ? {} : { provider: e.provider }),
    ...(e.model === undefined ? {} : { model: e.model }),
    ...(e.input_tokens === undefined ? {} : { input_tokens: e.input_tokens }),
    ...(e.output_tokens === undefined ? {} : { output_tokens: e.output_tokens }),
    ...(e.cost_micros === undefined ? {} : { cost_micros: e.cost_micros }),
    ...(e.cost_micros === undefined ? {} : { cost_currency: 'CNY' }),
    ...(e.charge_status === undefined ? {} : { charge_status: e.charge_status }),
  })
}
