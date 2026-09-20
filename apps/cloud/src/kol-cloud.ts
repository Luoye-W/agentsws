/**
 * 67 §3 WP118：把**红人营销增值服务**（`packages/kol-cloud`）挂进这个进程。
 *
 * 写法照着 `kol-public.ts`。与那一份的差别只有一条，但它是全部：
 *
 * > **公共红人库是一份（跨租户共享的事实），云端红人库是一租户一份（私有数据）。**
 *
 * Workers 形态里这条差别落成"一个单例对象 vs 每个 org 一个对象"；Compose 形态
 * 里落成**一个库文件、每张表一列 `org_id`**？——不，落成的是同一张库上的
 * **按组织分片的 store**：`packages/kol-cloud` 的 `KolCloudStore` 本身是
 * 单租户的（表里没有 org 列），这里按 org 开一个库文件
 * （`kol-cloud/<org>.sqlite`）。这样两个形态的隔离边界一模一样，而不是一边
 * 靠对象、一边靠"别忘了加 where"。
 *
 * 自建形态一台机器通常只服务几个组织（docs/61），所以"一个组织一个库文件"在
 * 这里是划算的；真到了几千个组织那一天，那台机器早就该用 Workers 形态了。
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Clock, CloudTokenVerifier } from '@agentsws/contracts'
import {
  type KolCloudEnv,
  KolCloudService,
  KolCloudStore,
  localSubscriptionWallet,
  mountKolCloudRoutes,
  type SubscriptionWallet,
} from '@agentsws/kol-cloud'
import type { Wallet } from '@agentsws/metering'
import type { Database } from 'better-sqlite3'
import type { Hono } from 'hono'
import type { CloudServer } from './server.js'

/** 租户库放哪个子目录（一个组织一个文件）。 */
export const KOL_CLOUD_DIR = 'kol-cloud'

export interface MountKolCloudOptions {
  clock?: Clock
  wallet: Wallet
  /** 云侧数据目录；不给就内存档（测试）。 */
  dataDir?: string
  /** 验令牌用哪一个。不给就是 WP58 的账号库那个。 */
  verifier?: CloudTokenVerifier
  /** 测试注入：假的钱包那一跳。 */
  subscriptionWallet?: SubscriptionWallet
}

export interface MountedKolCloud {
  /** 按组织拿服务（每个组织一个库、一个 service）。 */
  serviceOf(org_id: string): KolCloudService
  /** 这台机器上已经建过库的那些组织（后台的订阅列表遍历它）。 */
  orgs(): string[]
  close(): void
}

/** better-sqlite3 只在这一处出现（`packages/kol-cloud` 自己不依赖它）。 */
function openDb(path: string): Database {
  const require = createRequire(import.meta.url)
  const Ctor = require('better-sqlite3') as new (p: string) => Database
  const db = new Ctor(path)
  db.pragma('journal_mode = WAL')
  return db
}

/**
 * 库文件名里的组织号要**先洗一遍**。
 *
 * org_id 是我们自己生成的（`org_<hex>`），照理进不了奇怪的字符；但这一行是
 * 拼文件路径，而拼文件路径的地方一旦有一天收到别处传来的字符串，`../` 就
 * 出去了。洗一遍的代价是零。
 */
function safeName(org_id: string): string {
  return org_id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)
}

/** 把红人营销增值服务挂到 `server.app` 上。 */
export function mountKolCloud(server: CloudServer, options: MountKolCloudOptions): MountedKolCloud {
  const now = (): string => (options.clock ?? { now: () => new Date().toISOString() }).now()
  const dir =
    options.dataDir === undefined || options.dataDir.trim() === ''
      ? undefined
      : join(options.dataDir, KOL_CLOUD_DIR)
  if (dir !== undefined) mkdirSync(dir, { recursive: true })

  const wallet = options.subscriptionWallet ?? localSubscriptionWallet(options.wallet)
  const services = new Map<string, KolCloudService>()
  const dbs: Database[] = []

  const serviceOf = (org_id: string): KolCloudService => {
    const found = services.get(org_id)
    if (found !== undefined) return found
    /*
     * 没有 dataDir 就是内存档（测试）：`:memory:` 也一个组织一个，隔离行为
     * 与落盘那一档一模一样——不然测试里测不出"A 看不到 B"。
     */
    const db = openDb(dir === undefined ? ':memory:' : join(dir, `${safeName(org_id)}.sqlite`))
    dbs.push(db)
    const made = new KolCloudService({ store: new KolCloudStore(db), wallet, now })
    services.set(org_id, made)
    return made
  }

  /*
   * 路由那一层拿到的是**按 principal 现取**的那一份：同一组路由服务所有组织，
   * 但每一次请求只碰自己那个库。这与 Workers 形态里"入口按 org 选对象"是同一
   * 件事，只是选的东西从 DO 变成了库文件——而路由包两边都不认识多租户。
   */
  mountKolCloudRoutes(server.app as unknown as Hono<KolCloudEnv>, {
    verifier: options.verifier ?? server.verifyToken,
    serviceOf: (principal) => serviceOf(principal.org_id),
  })

  return {
    serviceOf,
    orgs: () => [...services.keys()],
    close() {
      for (const db of dbs) db.close()
      services.clear()
    },
  }
}
