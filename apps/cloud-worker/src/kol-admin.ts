/**
 * 后台 → `KolPublicDO` 的那四条内部路由（WP116 §4 / 65）。
 *
 * 与 `wallet-admin.ts` 一模一样的形状与一模一样的理由：后台那一层握的是一个
 * {@link KolAdminPort}，Compose 形态下它直接查库，官方托管形态下它是"打那个
 * 单例对象"。**后台这一层不知道自己在哪个形态里。**
 *
 * 这几条在公网上打不到：DO 没有地址，而入口 Worker 对 `/__internal/` 开头的
 * 路径一律回 404（`worker.ts` 第一段）。
 */

import type { KolImportResult, KolLibraryStats } from '@agentsws/contracts'
import type { CreatorRow, KolAdminPort, KolRemoveInput } from '@agentsws/kol-public'
import type { CreatorSearchFilter } from '@agentsws/kol-public'

/** 路由名。请求体是 JSON，响应也是——形状与 `KolAdminPort` 的签名一一对应。 */
export const KOL_ADMIN_INTERNAL = {
  stats: '/__internal/kol/admin/stats',
  search: '/__internal/kol/admin/search',
  remove: '/__internal/kol/admin/remove',
  import: '/__internal/kol/admin/import',
} as const

/** 在 `KolPublicDO` 里处理这几条。认不出的路径回 `undefined`。 */
export async function handleKolAdmin(
  core: { admin: KolAdminPort },
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (request.method !== 'POST') return undefined
  switch (url.pathname) {
    case KOL_ADMIN_INTERNAL.stats:
      return Response.json(await core.admin.stats())
    case KOL_ADMIN_INTERNAL.search: {
      const filter = (await request.json()) as CreatorSearchFilter
      return Response.json(await core.admin.search(filter))
    }
    case KOL_ADMIN_INTERNAL.remove: {
      const input = (await request.json()) as KolRemoveInput
      return Response.json(await core.admin.remove(input))
    }
    case KOL_ADMIN_INTERNAL.import: {
      const body = (await request.json()) as { records?: unknown[] }
      return Response.json(await core.admin.import(body.records ?? []))
    }
    default:
      return undefined
  }
}

/** 单例 `KolPublicDO` 的名字。只有这一个名字，所以只有这一个对象。 */
export const KOL_PUBLIC_SINGLETON = 'kol-public'

/** 一个能敲门的 namespace（`env.KOL_PUBLIC` 那个形状）。 */
export interface KolNamespaceLike {
  idFromName(name: string): { toString(): string }
  get(id: { toString(): string }): { fetch(request: Request): Promise<Response> }
}

/**
 * 官方托管形态的 {@link KolAdminPort}：每一次调用打一次那个单例。
 *
 * 打不通时的回值是**空而不是抛**：后台那一页看到"0 个红人"配一句
 * "这个节点没接公共红人库"比整页 500 好——但 `import` 与 `remove` 例外，
 * 它们是**动作**，做没做成必须说清楚。
 */
export function remoteKolAdminPort(
  namespace: KolNamespaceLike,
  origin = 'https://do.internal',
): KolAdminPort {
  const call = async <T>(path: string, body: unknown): Promise<T | undefined> => {
    const stub = namespace.get(namespace.idFromName(KOL_PUBLIC_SINGLETON))
    const res = await stub.fetch(
      new Request(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    if (!res.ok) return undefined
    return (await res.json()) as T
  }
  return {
    async stats() {
      const out = await call<KolLibraryStats>(KOL_ADMIN_INTERNAL.stats, {})
      return (
        out ?? {
          creators: 0,
          contacts: 0,
          contents: 0,
          observations: 0,
          imported: 0,
          removed: 0,
          new_7d: 0,
          new_30d: 0,
          by_channel: [],
          at: new Date().toISOString(),
        }
      )
    },
    async search(filter) {
      const out = await call<{ rows: CreatorRow[]; total: number }>(
        KOL_ADMIN_INTERNAL.search,
        filter,
      )
      return out ?? { rows: [], total: 0 }
    },
    async remove(input) {
      const out = await call<{ removed: number }>(KOL_ADMIN_INTERNAL.remove, input)
      if (out === undefined) throw new Error('公共红人库没应答，这一次移除没做成')
      return out
    },
    async import(records) {
      const out = await call<KolImportResult>(KOL_ADMIN_INTERNAL.import, { records })
      if (out === undefined) throw new Error('公共红人库没应答，这一批没搬进去')
      return out
    },
  }
}
