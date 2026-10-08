/**
 * WP261：Run 里的**独立站运营工具**真接上（十七个名字在 `@agentsws/stand-ins` 的 `runtime/shop.ts`）。
 *
 * 这里一行业务逻辑都没有（照 `theme-tools.ts`）：
 *
 * 1. **判职责**：职责表里没有这个工具 → `blocked`；
 * 2. **改动永远不在这里改**：改动工具只出卡（`ShopOps.propose`），人批了执行器才改；
 * 3. **还差哪一步说人话**：没授权 / 过期 / 缺权限 → 一句「去岗位页点授权」+ `needs: 'authorize'`；
 * 4. 工具面（{@link ShopToolSurface.offered}）按「职责表 × 授权里的权限」给：没授权一个都不出。
 */
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import { SHOP_READ_TOOL_NAMES, SHOP_TOOL_NAMES, shopToolsFor } from '@agentsws/stand-ins'
import { AUTH_PROBLEM_CODES, ShopAdminError } from './shop-admin.js'
import type { ShopAdminAssembly } from './shop-auth.js'
import { roleHasTool, type ShopOps, ShopOpsError } from './shop-ops.js'

export interface ShopToolSurface {
  executeTool: ToolExecutor
  /** 这条职责这一次运行摆哪几个（没授权 / 过期 = 空）。 */
  offered(role_id: string): Promise<string[]>
}

export interface ShopToolsOptions {
  /** 这个品牌的店铺授权与运营（懒取：比运行时晚建出来）；不是 Shopify 品牌 = undefined。 */
  module(): Promise<{ auth: ShopAdminAssembly; ops: ShopOps } | undefined>
}

const bareOf = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name

export function createShopToolSurface(options: ShopToolsOptions): ShopToolSurface {
  return {
    async offered(role_id) {
      const m = await options.module()
      if (m === undefined) return []
      const access = await m.auth.access()
      return access === undefined ? [] : shopToolsFor(role_id, access.scopes)
    },
    executeTool: async ({ name, input, request }): Promise<ToolExecution> => {
      const bare = bareOf(name)
      if (!SHOP_TOOL_NAMES.includes(bare))
        return { status: 'error', reason: `not_a_shop_tool:${bare}` }
      if (!roleHasTool(request.actor.role_id, bare))
        return { status: 'blocked', reason: `${request.actor.role_id} 这条职责用不了「${bare}」。` }
      const m = await options.module()
      if (m === undefined) return { status: 'error', reason: '这个品牌的建站平台不能这样管店。' }
      try {
        if (SHOP_READ_TOOL_NAMES.includes(bare))
          return { status: 'ok', data: await m.ops.read(bare, input, request) }
        const r = await m.ops.propose(bare, input, request)
        return { status: 'ok', data: { ...r, kind: 'shop_change' } }
      } catch (e) {
        if (e instanceof ShopAdminError)
          return {
            status: 'error',
            reason: e.message,
            ...(AUTH_PROBLEM_CODES.has(e.code) || e.code === 'cli_missing'
              ? { data: { needs: e.code === 'cli_missing' ? 'install_cli' : 'authorize' } }
              : {}),
          }
        if (e instanceof ShopOpsError)
          return { status: e.code === 'not_allowed' ? 'blocked' : 'error', reason: e.message }
        return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
