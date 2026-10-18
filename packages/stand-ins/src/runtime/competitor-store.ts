/**
 * WP393（docs/104 一期 A，C1）：网站运营 · 店铺管理「竞品动向」那两个工具——给模型看的名字、描述、参数。
 * 真正干活在服务端（`apps/server/src/competitor-watch/store-tools.ts`）。只给店铺管理（`dtc.store`）。
 *
 * | 工具 | 干什么 |
 * |---|---|
 * | `find_competitor_store` | 探平台：给一家竞品（或它的官网），读一下店里公开的那两个地址，认出是 Shopify / WooCommerce / 都不是，记进竞品清单 |
 * | `read_competitor_stores` | 现在读一次竞品独立站（和上一次比出上新 / 改价 / 打折 / 断货）；还没配好就回「先出方案卡」 |
 *
 * 查变化表用 WP392 的 `list_competitor_changes`；配「盯哪几家、什么算要紧」用 `request_setup`（设置目标 `store.competitor_watch`）。
 * 两个工具都只读外部公开页面、不碰用户的外部账号，所以不出审批卡（docs/104 §5 第 4 条）。
 */
import type { ToolDef } from '@agentsws/contracts'

export const FIND_COMPETITOR_STORE_TOOL = 'find_competitor_store'
export const READ_COMPETITOR_STORES_TOOL = 'read_competitor_stores'

/** 两个工具（排好序：`tools.allow` 要字节稳定）。 */
export const COMPETITOR_STORE_TOOL_NAMES: readonly string[] = [
  FIND_COMPETITOR_STORE_TOOL,
  READ_COMPETITOR_STORES_TOOL,
].sort()

/** 只给这几条职责（C1：放在网站运营 · 店铺管理，不新开职责）。 */
export const COMPETITOR_STORE_ROLES: readonly string[] = ['dtc.store']

export const COMPETITOR_STORE_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: FIND_COMPETITOR_STORE_TOOL,
    description:
      '探一家竞品的独立站是什么平台：读一下他店里公开的商品数据地址，认出是 Shopify / WooCommerce / 都不是，' +
      '按跳转后的地址记进竞品清单（GEO、信息监控、竞品监控共用的那一份）。被挡了会改用工坊内置浏览器读，还不行就照实说。' +
      '只读外部公开页面；回平台、地址和「走哪条路」的一句人话。',
    input_schema: {
      type: 'object',
      properties: {
        competitor: { type: 'string', description: '竞品名或 id（竞品清单里的那一家）' },
        url: { type: 'string', description: '官网地址（不给 = 用清单里记着的）' },
      },
    },
  },
  {
    name: READ_COMPETITOR_STORES_TOOL,
    description:
      '现在读一次竞品独立站的公开商品数据，和上一次比出上新 / 下架 / 改价 / 打折 / 断货（第一次只建底子、不报上新），' +
      '回这一次比出的变化（带「比你的 X 便宜 $N」）和哪家没读到。还没配好要盯哪几家时回 needs_setup（运行时会出方案卡）。只读外部公开页面。',
    input_schema: {
      type: 'object',
      properties: {
        competitor: { type: 'string', description: '只读这一家（竞品名或 id；不给 = 全部）' },
      },
    },
  },
]

export const COMPETITOR_STORE_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  COMPETITOR_STORE_TOOL_DEFS.map((d) => [d.name, d]),
)
