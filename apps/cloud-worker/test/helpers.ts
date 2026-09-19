/**
 * 一套**假的 Durable Object 运行时**（WP114 的测试地基）。
 *
 * 为什么不是 workerd / miniflare：那要下几十兆的运行时二进制，而本仓库的
 * `pnpm-workspace.yaml` 把 `workerd` 的构建脚本写死成 false（CI 只跑
 * `wrangler deploy --dry-run`，用不到它）。所以这里把 DO 那一点点面
 * （`storage.sql.exec` 回一个游标、`transactionSync`、`setAlarm`）用
 * better-sqlite3 假出来。
 *
 * **这份假的诚实到什么程度**：`doSyncDb` 那一层跑的是同一份
 * `SYNC_DB_CONTRACT`（`do-sql.test.ts`），所以"两份 driver 同一套契约都过"
 * 是真的；而"DO 真实运行时上 `rowsWritten` 对 DELETE 的口径"这类只有
 * 真跑一次才知道的事，只有类型与契约层保证——见 WP114 报告第 5 节。
 */

import type { CloudMail, MailSender } from '@agentsws/cloud/workers-kit'
import type { Clock } from '@agentsws/contracts'
import { signupBonus } from '@agentsws/metering'
import Database from 'better-sqlite3'
import { AccountsCore } from '../src/accounts-do.js'
import type { DoSqlCursor, DoStorageLike } from '../src/do-sql.js'
import type { DoNamespaceLike, WorkerEnv } from '../src/env.js'
import { LedgerCore } from '../src/ledger-do.js'
import { WalletCore, type WalletDoOptions } from '../src/wallet-do.js'

/** 一个 DO 的存储：一张内存 sqlite + 一个闹钟。 */
export class FakeDoStorage implements DoStorageLike {
  readonly db = new Database(':memory:')
  alarmAt: number | null = null
  #depth = 0

  readonly sql = {
    exec: <R>(query: string, ...bindings: unknown[]): DoSqlCursor<R> => {
      const stmt = this.db.prepare(query)
      if (stmt.reader) {
        const rows = stmt.all(...bindings) as R[]
        return { toArray: () => rows, rowsWritten: 0 }
      }
      const info = stmt.run(...bindings)
      return { toArray: () => [], rowsWritten: info.changes }
    },
  }

  transactionSync<T>(closure: () => T): T {
    // DO 的 transactionSync 能嵌套（内层开 savepoint）；better-sqlite3 不行，
    // 所以这里照它的语义补一层"已经在事务里就直接跑"
    if (this.#depth > 0 || this.db.inTransaction) return closure()
    this.#depth += 1
    try {
      return this.db.transaction(closure)() as T
    } finally {
      this.#depth -= 1
    }
  }

  setAlarm(when: number): void {
    this.alarmAt = when
  }

  getAlarm(): number | null {
    return this.alarmAt
  }

  deleteAlarm(): void {
    this.alarmAt = null
  }
}

export interface FakeCloudOptions {
  env?: Partial<WorkerEnv>
  clock?: Clock
  /** 假上游（`/v1/ai/*` 打的那一个）。不给就不联网也不给回应。 */
  fetch?: WalletDoOptions['fetch']
  randomBytes?: (n: number) => Buffer
}

export interface FakeCloud {
  env: WorkerEnv
  /** 发出去的信（magic link 的链接在 `text` 里）。 */
  mails: CloudMail[]
  accounts(): AccountsCore
  wallet(org_id: string): WalletCore
  /** 单例的计量副本（WP115）。 */
  ledger(): LedgerCore
  /** 某个组织的钱包存储（测试里预充值、看闹钟用）。 */
  walletStorage(org_id: string): FakeDoStorage
  accountsStorage(): FakeDoStorage
  /**
   * 把 `ctx.waitUntil` 里排着的那些抄写跑完。
   *
   * 真实运行时里它们在响应之后自己跑；测试里要有一个显式的"等一下"，
   * 否则断言会跑在抄写之前——那不是 bug，那是 `waitUntil` 的语义。
   */
  settle(): Promise<void>
}

/**
 * 把两个 DO 与一个 env 装起来。
 *
 * 对象是**按名字缓存**的——同一个名字拿到同一个实例、同一张库，
 * 这正是 `idFromName` 在真实运行时的语义。
 */
export function fakeCloud(options: FakeCloudOptions = {}): FakeCloud {
  const mails: CloudMail[] = []
  const mail: MailSender = async (m) => {
    mails.push(m)
  }
  const storages = new Map<string, FakeDoStorage>()
  const accountsCores = new Map<string, AccountsCore>()
  const walletCores = new Map<string, WalletCore>()

  const storageOf = (key: string): FakeDoStorage => {
    const found = storages.get(key)
    if (found !== undefined) return found
    const made = new FakeDoStorage()
    storages.set(key, made)
    return made
  }

  const env = {
    AGENTSWS_CLOUD_BASE_URL: 'https://cloud.example.test',
    AGENTSWS_CLOUD_MAIL_FROM: 'Agents 工坊 <login@agentsws.com>',
    AGENTSWS_VERSION: '0.0.0-test',
    ...options.env,
  } as WorkerEnv

  const accountsCore = (name: string): AccountsCore => {
    const found = accountsCores.get(name)
    if (found !== undefined) return found
    const made = new AccountsCore({ storage: storageOf(`acc:${name}`) }, env, {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
      mail,
    })
    accountsCores.set(name, made)
    return made
  }

  const ledgerCores = new Map<string, LedgerCore>()
  const ledgerCore = (name: string): LedgerCore => {
    const found = ledgerCores.get(name)
    if (found !== undefined) return found
    const made = new LedgerCore(
      { storage: storageOf(`led:${name}`) },
      options.clock === undefined ? {} : { now: () => options.clock?.now() ?? '' },
    )
    ledgerCores.set(name, made)
    return made
  }

  /** `ctx.waitUntil` 排着的那些（测试里显式 settle）。 */
  const pending: Promise<unknown>[] = []

  const walletCore = (name: string): WalletCore => {
    const found = walletCores.get(name)
    if (found !== undefined) return found
    const made = new WalletCore({ storage: storageOf(`wal:${name}`) }, env, {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      waitUntil: (p) => {
        pending.push(p.catch(() => undefined))
      },
    })
    walletCores.set(name, made)
    return made
  }

  const namespace = (pick: (name: string) => { fetch(r: Request): Promise<Response> }) => {
    const ns: DoNamespaceLike = {
      idFromName: (name) => ({ toString: () => name }),
      get: (id) => pick(id.toString()),
    }
    return ns
  }

  env.ACCOUNTS = namespace(accountsCore)
  env.WALLET = namespace(walletCore)
  env.LEDGER = namespace(ledgerCore)
  // 假的 `[assets]`：只回一句"这是后台的壳"，够验"有会话才拿得到"
  env.ASSETS = {
    fetch: async (request: Request) =>
      new Response(
        `<!doctype html><title>Agents 工坊 · 运营后台</title><!-- ${new URL(request.url).pathname} -->`,
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      ),
  }

  return {
    env,
    mails,
    accounts: () => accountsCore('accounts'),
    wallet: (org_id) => walletCore(org_id),
    ledger: () => ledgerCore('ledger'),
    walletStorage: (org_id) => storageOf(`wal:${org_id}`),
    accountsStorage: () => storageOf('acc:accounts'),
    async settle() {
      // 排队的过程中可能又排进新的（抄写会触发下一批），所以循环到空为止
      for (let i = 0; i < 10 && pending.length > 0; i++) {
        const batch = pending.splice(0, pending.length)
        await Promise.all(batch)
      }
    },
  }
}

/** 一个走完整条路的请求（与真实部署一样从入口 Worker 进）。 */
export function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://cloud.example.test${path}`, init)
}

/** magic link 邮件正文里那条链接上的一次性 token。 */
export function tokenFromMail(mail: CloudMail): string {
  const found = /token=([A-Za-z0-9_-]+)/.exec(mail.text)
  if (found?.[1] === undefined) throw new Error(`信里没有 token：${mail.text}`)
  return found[1]
}

/**
 * WP121（70 §2）：**每个点开过登录信的账号都会多出这一笔注册赠送**。
 *
 * 所以 WP114 / WP115 那些算钱的用例里，余额不再是它们自己充的那个数。这里不写
 * 死 10：金额在 `bonuses.json` 里，改成 20 的那天这些用例不该跟着红一遍。
 */
export const SIGNUP_BONUS = signupBonus()?.credits ?? 0

/**
 * 把一个组织的钱清成 0（连注册赠送一起撤掉）。
 *
 * 给「这个人一分钱都没有」那一类用例用——WP121 之后「刚注册」不再等于「没钱」，
 * 想要没钱得自己说出来。
 */
export function zeroOut(cloud: FakeCloud, org: string): void {
  // 与 `revokeRemaining` 同一下动作（`remaining` 清零），只是这里够不着那个
  // `SyncDb`——假运行时手里只有底下那张 sqlite。
  cloud
    .walletStorage(org)
    .db.prepare('UPDATE wallet_lots SET remaining = 0 WHERE org_id = ?')
    .run(org)
}
