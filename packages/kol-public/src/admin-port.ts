/**
 * 后台那一页与公共库之间的口（WP116 §4 / 65）。
 *
 * 与 `WalletAdminPort`（WP115）同一个形状同一个理由：后台这一层**不知道自己
 * 在哪个形态里**。Compose 形态下这个口就是直接查库（{@link localKolAdminPort}）；
 * 官方托管形态下它是"打那个单例 `KolPublicDO`"
 * （`apps/cloud-worker/src/kol-admin.ts` 的远端实现）。
 *
 * 全部方法都是 `Promise`：不是因为本地那份需要，而是因为远端那份必须。
 *
 * **移除是这个口上唯一的破坏性动作**，所以它要三样东西：理由、按的人、
 * 以及一条 opt-out 记录——删完之后搬家再推一趟也不会把人搬回来
 * （`import.ts` 每一种 kind 进门先问 `optedOut`）。
 */

import type { Iso8601, KolChannel, KolImportResult, KolLibraryStats } from '@agentsws/contracts'
import { importKolRecords } from './import.js'
import type { CreatorRow, CreatorSearchFilter, KolLibraryStore, KolStore } from './store.js'
import type { KolSecrets } from './types.js'

/** 移除一条要交代的那几样。 */
export interface KolRemoveInput {
  channel: KolChannel
  handle: string
  /** **必填**：三个月后回头看"为什么这个人不在库里了"必须有答案。 */
  reason: string
  /** 后台账号 id。 */
  removed_by: string
}

export interface KolAdminPort {
  stats(): Promise<KolLibraryStats>
  search(filter: CreatorSearchFilter): Promise<{ rows: CreatorRow[]; total: number }>
  /** 从库中移除（opt-out + 删掉这个人的全部行）。回删掉几行。 */
  remove(input: KolRemoveInput): Promise<{ removed: number }>
  /** 搬家一批（NDJSON 已经解成对象）。 */
  import(records: readonly unknown[]): Promise<KolImportResult>
}

export interface LocalKolAdminDeps {
  store: KolStore & KolLibraryStore
  secrets: KolSecrets
  now: () => Iso8601
}

/** Compose 形态：直接查库。 */
export function localKolAdminPort(deps: LocalKolAdminDeps): KolAdminPort {
  return {
    stats: () => Promise.resolve(deps.store.libraryStats(deps.now())),
    search: (filter) => Promise.resolve(deps.store.searchCreators(filter)),
    remove(input) {
      const at = deps.now()
      /*
       * 顺序要紧：**先记 opt-out 再删行**。倒过来的话，两条动作之间来一次上报，
       * 那个人就又回到库里了——而他刚刚要求过被移除。
       */
      deps.store.putOptOut({
        channel: input.channel,
        handle: input.handle,
        reason: input.reason,
        removed_by: input.removed_by,
        at,
      })
      return Promise.resolve({ removed: deps.store.purgeCreator(input.channel, input.handle) })
    },
    import: (records) => Promise.resolve(importKolRecords(deps, records)),
  }
}
