/**
 * WP252（决策 125）：整台机一份的连接归属表——服务进程启动时开一次，所有品牌的连接面共用。
 *
 * 一台机一个 OpenConnector（WP247 本机连接器 / Docker 档都是），品牌靠「连接名带品牌段 + 这张表」隔开：
 * 每个品牌只列 / 只用 / 只签自己的连接，老的 `default` 归**启动品牌**（`server.ts` 的 bootstrap 工作区）。
 *
 * 落盘：`<dbDir>/connect-owners.json`（启动品牌的目录，与 `connect-adapter.json` 并排；没有任何凭据）。
 * 启动时先跑一遍迁移：把启动品牌与 `brands/<ws>/` 下每个品牌的 `connect-adapter.json` 里记过的归属补记进来
 * ——**幂等**，已经有主的不动；不改上游任何连接名。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BrandStateSource,
  ConnectionOwners,
  type ConnectionOwnersMigration,
  migrateConnectionOwners,
} from '@agentsws/connect-adapter'
import type { Iso8601, WorkspaceId } from '@agentsws/contracts'
import { BRAND_DIR } from './brand-modules.js'

/** 归属表的文件名（在启动品牌的数据目录里）。 */
export const CONNECT_OWNERS_FILE = 'connect-owners.json'
/** 每个品牌适配器自己的状态文件名（WP20 起；`connections.ts` 写它）。 */
export const ADAPTER_STATE_FILE = 'connect-adapter.json'

export interface OpenedConnectOwners {
  owners: ConnectionOwners
  /** 这一次启动迁移补记了什么（全 0 = 早就迁过 / 没有老数据）。 */
  migration: ConnectionOwnersMigration
}

/**
 * 开归属表并跑迁移。没有数据目录（测试、一次性任务）就是一份只在内存里的表——
 * 同一个进程里的各品牌照样共用它。
 */
export function openConnectOwners(input: {
  dbDir: string | undefined
  startup: WorkspaceId
  now: Iso8601
}): OpenedConnectOwners {
  if (input.dbDir === undefined) {
    return { owners: new ConnectionOwners(), migration: { claimed: 0, conflicts: 0, skipped: 0 } }
  }
  // 每次启动从文件重读一份（不走 `open()` 的进程内缓存：同一进程里关了再起的服务要看到磁盘上的真状态）；
  // 共用靠服务进程把这一个实例传给每个品牌的连接面
  const owners = new ConnectionOwners(join(input.dbDir, CONNECT_OWNERS_FILE))
  const migration = migrateConnectionOwners(owners, {
    startup: input.startup,
    brands: brandStateSources(input.dbDir, input.startup),
    now: input.now,
  })
  return { owners, migration }
}

/** 启动品牌那一份 + `brands/<ws>/` 下每个品牌的那一份（文件不在也列上：迁移把它当「什么都没记过」）。 */
export function brandStateSources(dbDir: string, startup: WorkspaceId): BrandStateSource[] {
  const out: BrandStateSource[] = [
    { workspace_id: startup, stateFile: join(dbDir, ADAPTER_STATE_FILE) },
  ]
  const root = join(dbDir, BRAND_DIR)
  if (!existsSync(root)) return out
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === startup) continue
    out.push({ workspace_id: entry.name, stateFile: join(root, entry.name, ADAPTER_STATE_FILE) })
  }
  return out
}
