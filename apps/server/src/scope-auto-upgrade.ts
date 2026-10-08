/**
 * WP272（Luoye 10-08 真机）：Agents 工坊账号令牌缺动作集时**后台自动补签**，用户无感。
 *
 * 以前（WP267）是卡上写「账号授权要更新一下」+ 一个按钮；Luoye 以为要登录 Shopify，填了 Shopify 的
 * 邮箱密码被拒。现在：
 *
 * - **启动时**扫一遍本公司各品牌，本机记的动作集比默认集少的就补一次（`sweep`）；
 * - **任何一跳**撞上 403 `details.required_scope`（`cloud.ts` 的 `scopeUpgrade` 钩子）就补一次，
 *   成了原样再打——调用方根本看不到那个 403。
 *
 * 只有补签接口确实不可用 / 失败（老云没这一条、令牌被撤）时才让界面说「工坊账号需要重新登录」。
 *
 * 两条节流：同一个品牌同时只补一次（并发的几跳等同一个结果）；没成（不是断网）记一段冷却，
 * 冷却里直接回 `false`，不每一跳都去敲云。断网不记冷却：下一跳网通了照样补。
 */
import type { WorkspaceId } from '@agentsws/contracts'

export interface ScopeAutoUpgradeOptions {
  /** `cloud-account.upgradeScopes`：成了回云上那一份动作集；没成抛（带 `details.reason`）。 */
  upgrade: (ws: WorkspaceId) => Promise<{ scopes: string[]; added: string[] }>
  /** 这个品牌本机记的令牌比默认集少了哪几项（只读本机，不打云）。 */
  missingOf: (ws: WorkspaceId) => readonly string[]
  /** 本公司的品牌（启动扫一遍用）。 */
  brands: () => readonly WorkspaceId[]
  nowMs: () => number
  /** 没成之后多久不再自动试（默认 5 分钟）。 */
  cooldownMs?: number
  /** 补成 / 补不成（事件、日志用；不给就不报）。 */
  onResult?: (ws: WorkspaceId, result: { ok: boolean; added?: string[]; reason?: string }) => void
}

export interface ScopeAutoUpgrade {
  /** 补一次（并发去重、失败冷却）。`true` = 补成了，可以把原来那一跳再打一次。 */
  ensure(ws: WorkspaceId): Promise<boolean>
  /** 启动时：本机记着缺动作集的品牌都补一次（同公司补一次常常就全补上了）。 */
  sweep(): Promise<void>
  /** 重新登录 / 关联之后：清掉冷却（新签的令牌，没成的那段记录不算数了）。 */
  reset(): void
}

function reasonOf(err: unknown): string | undefined {
  const details = (err as { details?: unknown } | null)?.details
  if (details === null || typeof details !== 'object') return undefined
  const reason = (details as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : undefined
}

export function createScopeAutoUpgrade(options: ScopeAutoUpgradeOptions): ScopeAutoUpgrade {
  const cooldown = options.cooldownMs ?? 5 * 60_000
  const inflight = new Map<string, Promise<boolean>>()
  const failedAt = new Map<string, number>()

  const run = async (ws: WorkspaceId): Promise<boolean> => {
    try {
      const out = await options.upgrade(ws)
      failedAt.delete(ws)
      options.onResult?.(ws, { ok: true, added: out.added })
      return true
    } catch (err) {
      const reason = reasonOf(err)
      // 断网不记冷却（下一跳网通了照样补）；没关联也不记（登录之后令牌是新签的，用不着补）
      if (reason !== 'offline' && reason !== 'not_linked') failedAt.set(ws, options.nowMs())
      options.onResult?.(ws, { ok: false, ...(reason === undefined ? {} : { reason }) })
      return false
    }
  }

  const ensure = (ws: WorkspaceId): Promise<boolean> => {
    const hit = inflight.get(ws)
    if (hit !== undefined) return hit
    const at = failedAt.get(ws)
    if (at !== undefined && options.nowMs() - at < cooldown) return Promise.resolve(false)
    const p = run(ws).finally(() => {
      inflight.delete(ws)
    })
    inflight.set(ws, p)
    return p
  }

  return {
    ensure,
    reset() {
      failedAt.clear()
    },
    async sweep() {
      for (const ws of options.brands()) {
        // 前一个品牌补的时候常常顺手把同公司的都补上了，每次现看
        let missing: readonly string[] = []
        try {
          missing = options.missingOf(ws)
        } catch {
          missing = []
        }
        if (missing.length === 0) continue
        await ensure(ws)
      }
    },
  }
}
