/**
 * WP261（决策 175 第 1 步）：**独立站运营工具**——一组固定的查询与改动（不给任意 GraphQL）。
 *
 * 每个名字都落在服务端 `apps/server/src/shop-tools.ts` → `shop-ops.ts`，底下是 `ShopifyAdmin`（这一单是 CLI
 * `store execute` 版）。**改动一律只出审批卡**：人批了，执行器才带 `--allow-mutations` 去改，并读回确认。
 * 删除类不做：要「下架 / 归档」用 `shop_set_product_status`。
 *
 * | 工具 | 干什么 | 动店铺吗 |
 * |---|---|---|
 * | `shop_list_products` / `shop_get_product` | 商品列表 / 详情（变体、价格、库存、图片、合集） | 只读 |
 * | `shop_list_collections` / `shop_get_collection` | 合集列表 / 合集里的商品 | 只读 |
 * | `shop_list_pages` / `shop_get_page` | 页面列表 / 正文 | 只读 |
 * | `shop_list_menus` | 菜单（导航）与菜单项 | 只读 |
 * | `shop_list_discounts` | 折扣 | 只读 |
 * | `shop_recent_orders` | 最近订单（只有单号、金额、状态，没有顾客信息） | 只读 |
 * | `shop_save_product` | 建商品（一律先存草稿）/ 改标题、描述、类型、品牌、标签 | 出卡 |
 * | `shop_set_price` | 改一个变体的价格 | 出卡 |
 * | `shop_set_product_status` | 上架 / 下架（草稿）/ 归档 | 出卡（永远人审） |
 * | `shop_add_product_images` | 给商品加图（网址或本机图片文件） | 出卡 |
 * | `shop_save_collection` | 建合集 / 改合集、加减商品 | 出卡 |
 * | `shop_save_page` | 建 / 改页面 | 出卡 |
 * | `shop_save_menu` | 建 / 改菜单（整份菜单项） | 出卡 |
 * | `shop_create_discount` | 建折扣码 | 出卡 |
 *
 * 工具面按两件事出现：这条职责登记了哪几个（{@link SHOP_TOOLS_BY_ROLE}）× 店铺授权里有没有那一项权限
 * （{@link SHOP_TOOL_SCOPE}）。没授权 / 过期 = 一个都不出（岗位页引导去授权）。
 */
import type { RunRequest, ToolDef } from '@agentsws/contracts'

export const SHOP_LIST_PRODUCTS_TOOL = 'shop_list_products'
export const SHOP_GET_PRODUCT_TOOL = 'shop_get_product'
export const SHOP_LIST_COLLECTIONS_TOOL = 'shop_list_collections'
export const SHOP_GET_COLLECTION_TOOL = 'shop_get_collection'
export const SHOP_LIST_PAGES_TOOL = 'shop_list_pages'
export const SHOP_GET_PAGE_TOOL = 'shop_get_page'
export const SHOP_LIST_MENUS_TOOL = 'shop_list_menus'
export const SHOP_LIST_DISCOUNTS_TOOL = 'shop_list_discounts'
export const SHOP_RECENT_ORDERS_TOOL = 'shop_recent_orders'
export const SHOP_SAVE_PRODUCT_TOOL = 'shop_save_product'
export const SHOP_SET_PRICE_TOOL = 'shop_set_price'
export const SHOP_SET_STATUS_TOOL = 'shop_set_product_status'
export const SHOP_ADD_IMAGES_TOOL = 'shop_add_product_images'
export const SHOP_SAVE_COLLECTION_TOOL = 'shop_save_collection'
export const SHOP_SAVE_PAGE_TOOL = 'shop_save_page'
export const SHOP_SAVE_MENU_TOOL = 'shop_save_menu'
export const SHOP_CREATE_DISCOUNT_TOOL = 'shop_create_discount'

export const SHOP_READ_TOOL_NAMES: readonly string[] = [
  SHOP_GET_COLLECTION_TOOL,
  SHOP_GET_PAGE_TOOL,
  SHOP_GET_PRODUCT_TOOL,
  SHOP_LIST_COLLECTIONS_TOOL,
  SHOP_LIST_DISCOUNTS_TOOL,
  SHOP_LIST_MENUS_TOOL,
  SHOP_LIST_PAGES_TOOL,
  SHOP_LIST_PRODUCTS_TOOL,
  SHOP_RECENT_ORDERS_TOOL,
].sort()

export const SHOP_WRITE_TOOL_NAMES: readonly string[] = [
  SHOP_ADD_IMAGES_TOOL,
  SHOP_CREATE_DISCOUNT_TOOL,
  SHOP_SAVE_COLLECTION_TOOL,
  SHOP_SAVE_MENU_TOOL,
  SHOP_SAVE_PAGE_TOOL,
  SHOP_SAVE_PRODUCT_TOOL,
  SHOP_SET_PRICE_TOOL,
  SHOP_SET_STATUS_TOOL,
].sort()

/** 全部运营工具（排好序：`tools.allow` 要字节稳定）。 */
export const SHOP_TOOL_NAMES: readonly string[] = [
  ...SHOP_READ_TOOL_NAMES,
  ...SHOP_WRITE_TOOL_NAMES,
].sort()

export const isShopTool = (name: string): boolean =>
  SHOP_TOOL_NAMES.includes(name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name)

/** 每个工具要店铺授权里的哪一项（`write_x` 隐含 `read_x`）。 */
export const SHOP_TOOL_SCOPE: Readonly<Record<string, string>> = {
  [SHOP_LIST_PRODUCTS_TOOL]: 'read_products',
  [SHOP_GET_PRODUCT_TOOL]: 'read_products',
  [SHOP_LIST_COLLECTIONS_TOOL]: 'read_products',
  [SHOP_GET_COLLECTION_TOOL]: 'read_products',
  [SHOP_LIST_PAGES_TOOL]: 'read_content',
  [SHOP_GET_PAGE_TOOL]: 'read_content',
  [SHOP_LIST_MENUS_TOOL]: 'read_online_store_navigation',
  [SHOP_LIST_DISCOUNTS_TOOL]: 'read_discounts',
  [SHOP_RECENT_ORDERS_TOOL]: 'read_orders',
  [SHOP_SAVE_PRODUCT_TOOL]: 'write_products',
  [SHOP_SET_PRICE_TOOL]: 'write_products',
  [SHOP_SET_STATUS_TOOL]: 'write_products',
  [SHOP_ADD_IMAGES_TOOL]: 'write_products',
  [SHOP_SAVE_COLLECTION_TOOL]: 'write_products',
  [SHOP_SAVE_PAGE_TOOL]: 'write_content',
  [SHOP_SAVE_MENU_TOOL]: 'write_online_store_navigation',
  [SHOP_CREATE_DISCOUNT_TOOL]: 'write_discounts',
}

/**
 * 每条职责登记了哪几个（与 `PlatformStoreAdminSpec.scopes_by_role` 对得上：要的权限够用这几个）。
 * 店铺管理全有；整站搭建管结构（页面、菜单）、只读商品与合集；网页模板只读商品与合集（选合集 / 挂商品）。
 */
export const SHOP_TOOLS_BY_ROLE: Readonly<Record<string, readonly string[]>> = {
  'dtc.store': SHOP_TOOL_NAMES,
  'site.shopify-build': [
    SHOP_GET_COLLECTION_TOOL,
    SHOP_GET_PAGE_TOOL,
    SHOP_GET_PRODUCT_TOOL,
    SHOP_LIST_COLLECTIONS_TOOL,
    SHOP_LIST_MENUS_TOOL,
    SHOP_LIST_PAGES_TOOL,
    SHOP_LIST_PRODUCTS_TOOL,
    SHOP_SAVE_MENU_TOOL,
    SHOP_SAVE_PAGE_TOOL,
  ].sort(),
  'site.shopify-theme': [
    SHOP_GET_COLLECTION_TOOL,
    SHOP_GET_PRODUCT_TOOL,
    SHOP_LIST_COLLECTIONS_TOOL,
    SHOP_LIST_PRODUCTS_TOOL,
  ].sort(),
}

/** `write_x` 隐含 `read_x`。 */
function covers(granted: readonly string[], need: string): boolean {
  if (granted.includes(need)) return true
  const m = /^read_(.+)$/.exec(need)
  return m !== null && granted.includes(`write_${m[1]}`)
}

/** 这条职责、在这份授权下，工具面里摆哪几个（排好序）。 */
export function shopToolsFor(role_id: string, granted: readonly string[]): string[] {
  return (SHOP_TOOLS_BY_ROLE[role_id] ?? [])
    .filter((n) => {
      const need = SHOP_TOOL_SCOPE[n]
      return need !== undefined && covers(granted, need)
    })
    .sort()
}

const STR = (description: string) => ({ type: 'string', description })
const FIRST = { type: 'integer', description: '要几条（默认 20，最多 50）' }
const QUERY = STR(
  '筛选（Shopify 搜索写法，如 title:*杯* 或 tag:新品；不给 = 全部，最近更新的在前）',
)
const AFTER = STR('翻页：上一次回的 next_cursor')
const MENU_ITEM = {
  type: 'object',
  properties: {
    title: STR('显示的文字'),
    url: STR('链接（站内写 /pages/about 这种；外链写完整网址）'),
    resource_id: STR('指向店里的某样东西时给它的 id（商品 / 合集 / 页面），不用再给 url'),
    items: {
      type: 'array',
      description: '下一级菜单项（同样的写法，最多两级）',
      items: { type: 'object' },
    },
  },
  required: ['title'],
}

/** 给模型看的定义（描述写人话：它是在挑工具的那一刻读描述的）。 */
export const SHOP_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: SHOP_LIST_PRODUCTS_TOOL,
    description: '列店里的商品（标题、状态、价格区间、库存、主图、几个变体）。只读。',
    input_schema: { type: 'object', properties: { query: QUERY, first: FIRST, after: AFTER } },
  },
  {
    name: SHOP_GET_PRODUCT_TOOL,
    description:
      '看一件商品的全部（描述原文、变体与价格、库存、图片、标签、在哪些合集）。改商品之前必须先用它读一遍。只读。',
    input_schema: {
      type: 'object',
      properties: {
        id: STR('商品 id（gid://shopify/Product/…）'),
        handle: STR('或者给商品的 handle'),
      },
    },
  },
  {
    name: SHOP_LIST_COLLECTIONS_TOOL,
    description: '列店里的合集（标题、几件商品、是手动挑的还是按条件自动的）。只读。',
    input_schema: { type: 'object', properties: { query: QUERY, first: FIRST } },
  },
  {
    name: SHOP_GET_COLLECTION_TOOL,
    description: '看一个合集的描述与里面的商品（前 50 件）。改合集之前必须先用它读一遍。只读。',
    input_schema: {
      type: 'object',
      properties: { id: STR('合集 id（gid://shopify/Collection/…）') },
      required: ['id'],
    },
  },
  {
    name: SHOP_LIST_PAGES_TOOL,
    description: '列店里的页面（关于我们、政策页、自定义页面），带摘要。只读。',
    input_schema: { type: 'object', properties: { query: QUERY, first: FIRST } },
  },
  {
    name: SHOP_GET_PAGE_TOOL,
    description: '看一个页面的正文原文（HTML）。改页面之前必须先用它读一遍。只读。',
    input_schema: {
      type: 'object',
      properties: { id: STR('页面 id（gid://shopify/Page/…）') },
      required: ['id'],
    },
  },
  {
    name: SHOP_LIST_MENUS_TOOL,
    description:
      '列店里的菜单（主菜单、页脚菜单…）和每一项指向哪里。改菜单之前必须先用它读一遍。只读。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: SHOP_LIST_DISCOUNTS_TOOL,
    description: '列店里的折扣（码、力度、起止时间、用了多少次）。只读。',
    input_schema: { type: 'object', properties: { query: QUERY, first: FIRST } },
  },
  {
    name: SHOP_RECENT_ORDERS_TOOL,
    description: '最近的订单（单号、时间、金额、付款 / 发货状态）。只读，没有顾客个人信息。',
    input_schema: { type: 'object', properties: { first: FIRST } },
  },
  {
    name: SHOP_SAVE_PRODUCT_TOOL,
    description:
      '**不会直接改店。** 出一张审批卡：不给 id = 建一件新商品（一律先存草稿，上架另用 shop_set_product_status）；' +
      '给 id = 改这件商品的标题 / 描述 / 类型 / 品牌 / 标签（改之前先 shop_get_product 读过）。改价用 shop_set_price。人批了才改。',
    input_schema: {
      type: 'object',
      properties: {
        id: STR('要改的商品 id；建新商品时不给'),
        title: STR('标题'),
        description_html: STR('描述（HTML，可以有 <p> <ul> <strong>）'),
        product_type: STR('商品类型'),
        vendor: STR('品牌 / 供应商'),
        tags: { type: 'array', items: { type: 'string' }, description: '标签（整份替换）' },
        price: { type: 'number', description: '只建新商品时：价格（店铺币种）' },
        compare_at_price: { type: 'number', description: '只建新商品时：划线原价' },
        sku: STR('只建新商品时：SKU'),
        options: {
          type: 'array',
          description:
            '只建新商品时：规格（如 [{"name":"颜色","values":["黑","白"]}]），每个组合一个变体、价格都是 price',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  {
    name: SHOP_SET_PRICE_TOOL,
    description:
      '**不会直接改价。** 出一张改价卡（原价 → 新价、幅度）。商品只有一个变体时可以不给 variant_id。改之前先 shop_get_product 读过。人批了才改。',
    input_schema: {
      type: 'object',
      properties: {
        product_id: STR('商品 id'),
        variant_id: STR('变体 id（商品有好几个变体时必须给）'),
        price: { type: 'number', description: '新价格（店铺币种）' },
        compare_at_price: { type: 'number', description: '划线原价；给 0 = 去掉划线价' },
      },
      required: ['product_id', 'price'],
    },
  },
  {
    name: SHOP_SET_STATUS_TOOL,
    description:
      '**不会直接上下架。** 出一张卡：active = 上架（顾客能买到，并挂到网店）、draft = 下架存草稿、archived = 归档（不删）。永远要人批。',
    input_schema: {
      type: 'object',
      properties: {
        product_id: STR('商品 id'),
        status: {
          type: 'string',
          enum: ['active', 'draft', 'archived'],
          description: '改成哪个状态',
        },
      },
      required: ['product_id', 'status'],
    },
  },
  {
    name: SHOP_ADD_IMAGES_TOOL,
    description:
      '**不会直接传图。** 出一张卡：给商品加图（最多 10 张），每张给网址（https）或本机图片文件路径（jpg / png / webp / gif，只限本品牌的文件夹），可带替代文字。人批了才传。',
    input_schema: {
      type: 'object',
      properties: {
        product_id: STR('商品 id'),
        images: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: STR('图片网址（https）'),
              file: STR('或本机图片文件路径'),
              alt: STR('替代文字'),
            },
          },
        },
      },
      required: ['product_id', 'images'],
    },
  },
  {
    name: SHOP_SAVE_COLLECTION_TOOL,
    description:
      '**不会直接改。** 出一张卡：不给 id = 建一个手动合集；给 id = 改标题 / 描述、加减商品（只能是手动挑的合集；改之前先 shop_get_collection 读过）。人批了才改。',
    input_schema: {
      type: 'object',
      properties: {
        id: STR('合集 id；建新合集时不给'),
        title: STR('标题'),
        description_html: STR('描述（HTML）'),
        add_product_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要加进来的商品 id',
        },
        remove_product_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要拿掉的商品 id',
        },
      },
    },
  },
  {
    name: SHOP_SAVE_PAGE_TOOL,
    description:
      '**不会直接改。** 出一张卡：不给 id = 建一个页面；给 id = 改标题 / 正文 / 是否显示（改之前先 shop_get_page 读过）。人批了才改。',
    input_schema: {
      type: 'object',
      properties: {
        id: STR('页面 id；建新页面时不给'),
        title: STR('标题'),
        body_html: STR('正文（HTML）'),
        handle: STR('只建新页面时：网址里的那一段（如 about-us）'),
        published: { type: 'boolean', description: '顾客看不看得到（新页面默认先不显示）' },
      },
    },
  },
  {
    name: SHOP_SAVE_MENU_TOOL,
    description:
      '**不会直接改。** 出一张卡：给 id = 用这份菜单项**整份替换**那个菜单（先 shop_list_menus 读过，保留要留的项）；不给 id = 建一个新菜单（要 title 与 handle）。人批了才改。',
    input_schema: {
      type: 'object',
      properties: {
        id: STR('菜单 id；建新菜单时不给'),
        title: STR('菜单名'),
        handle: STR('只建新菜单时：如 footer-help'),
        items: { type: 'array', items: MENU_ITEM, description: '整份菜单项（按顺序）' },
      },
      required: ['items'],
    },
  },
  {
    name: SHOP_CREATE_DISCOUNT_TOOL,
    description:
      '**不会直接建。** 出一张卡：建一个折扣码（打几折或减多少钱、起止时间、最多用几次、每人限一次、满多少可用）。人批了才建。',
    input_schema: {
      type: 'object',
      properties: {
        title: STR('折扣名（后台看的）'),
        code: STR('顾客输入的码（字母数字，如 WELCOME10）'),
        percent: { type: 'number', description: '打几折：减百分之几（如 10 = 减 10%）' },
        amount_off: { type: 'number', description: '或者：每单减多少钱（店铺币种）' },
        starts_at: STR('开始时间（ISO，如 2026-10-10T00:00:00Z；不给 = 马上）'),
        ends_at: STR('结束时间（不给 = 不结束）'),
        usage_limit: { type: 'integer', description: '一共最多用几次（不给 = 不限，会转人审）' },
        once_per_customer: { type: 'boolean', description: '每位顾客只能用一次' },
        minimum_subtotal: { type: 'number', description: '满多少钱才能用' },
      },
      required: ['title', 'code'],
    },
  },
]

export const SHOP_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  SHOP_TOOL_DEFS.map((d) => [d.name, d]),
)

/** 改动工具回的那一份（服务端 `shop-tools.ts` 拼）。 */
export interface ShopStagedData {
  status: 'staged' | 'blocked'
  message: string
  change_id?: string
  approval_item_id?: string
  kind: 'shop_change'
}

const obj = (data: unknown): Record<string, unknown> =>
  data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}

export function shopStagedOf(data: unknown): ShopStagedData | undefined {
  const o = obj(data)
  return o.kind === 'shop_change' && typeof o.message === 'string'
    ? (o as unknown as ShopStagedData)
    : undefined
}

// ── stub 剧本（没接模型时演示用：只演「读一件 → 改标题出卡」） ─────────────

const EDIT = /改|换|优化|新版|标题|上架|edit|rename|title/i
const PRODUCT = /商品|产品|product/i

export interface ShopStep {
  tool: string
  input: Record<string, unknown>
}

/** stub 的岔口：工具面里有改商品的工具、而且说的是改商品，才走这一边；否则照旧。 */
export function shopBranch(req: RunRequest, text: string): ShopStep[] | undefined {
  const has = (n: string): boolean => req.tools.allow.includes(n)
  if (!has(SHOP_SAVE_PRODUCT_TOOL) || !has(SHOP_LIST_PRODUCTS_TOOL)) return undefined
  if (!PRODUCT.test(text) || !EDIT.test(text)) return undefined
  return [{ tool: SHOP_LIST_PRODUCTS_TOOL, input: { first: 5 } }]
}

/** 列商品回的数据里挑第一件（stub 剧本下一步读它）。 */
export function firstProductOf(data: unknown): { id: string; title: string } | undefined {
  const rows = Array.isArray(obj(data).products) ? (obj(data).products as unknown[]) : []
  const p = obj(rows[0])
  return typeof p.id === 'string' && typeof p.title === 'string'
    ? { id: p.id, title: p.title }
    : undefined
}
