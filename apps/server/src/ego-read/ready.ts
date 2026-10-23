/**
 * WP493：**ego 这会儿能不能替插件读**——探得到（`egoReadPath()`）还不够，ego 没打开 / 首次引导没做完时连不上。
 * 这里记一份「真连一次」的结果（WP483 的 `probeEgoConnection`：只数一下空间个数，不开页面），一分钟内不再连；
 * `ready()` 是同步的（巡查那边每次领活前都问），过期了就在后台再连一次、先按上次的算。
 *
 * 第一次还没连过 = 不算能用（插件照旧，连上之后再切过去）。
 */
import type { EgoConnectProbe } from '../ego-write/runner.js'

export interface EgoReadiness {
  ready(): boolean
  /** 现连一次（领活前 / 面板上「再看一次」）。 */
  refresh(): Promise<boolean>
  /** 那一趟 ego 跑不起来：先当它连不上（下一次到期再连）。 */
  markDown(): void
  /** WP496（决策 1729 A）：上一次真连时 ego 说「有新版本」（当前版本写在 `current`）；没说 = `undefined`。 */
  update(): { current?: string } | undefined
}

export interface EgoReadinessOptions {
  path(): string | undefined
  probe(path: string): Promise<EgoConnectProbe>
  ttlMs?: number
  nowMs?(): number
}

export function createEgoReadiness(options: EgoReadinessOptions): EgoReadiness {
  const ttl = options.ttlMs ?? 60_000
  const now = options.nowMs ?? Date.now
  let last: { at: number; path: string; ok: boolean; update?: { current?: string } } | undefined
  let inflight: Promise<boolean> | undefined

  const refresh = (): Promise<boolean> => {
    const path = options.path()
    if (path === undefined) {
      last = undefined
      return Promise.resolve(false)
    }
    if (inflight !== undefined) return inflight
    inflight = options
      .probe(path)
      .then(
        (p): { ok: boolean; update?: { current?: string } } => ({
          ok: p.connected,
          ...(p.update_available === true
            ? { update: p.update_current === undefined ? {} : { current: p.update_current } }
            : {}),
        }),
        () => ({ ok: false }),
      )
      .then((got) => {
        last = { at: now(), path, ...got }
        inflight = undefined
        return got.ok
      })
    return inflight
  }

  return {
    ready() {
      const path = options.path()
      if (path === undefined) return false
      if (last === undefined || last.path !== path || now() - last.at >= ttl) void refresh()
      return last !== undefined && last.path === path && last.ok
    },
    refresh,
    markDown() {
      const path = options.path()
      if (path !== undefined) last = { at: now(), path, ok: false }
    },
    update() {
      const path = options.path()
      return last !== undefined && last.path === path ? last.update : undefined
    },
  }
}
