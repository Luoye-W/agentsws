/**
 * Shopify Admin 的**写动作 → 变更种类**对照表（WP44）。
 *
 * `graphql` 一栏是 2026-09-10 对着 `@shopify/dev-mcp@1.15.0` 随包分发的官方
 * Admin schema（2026-10 版）逐条核过的，弃用的旧名一并标出来——写文档时抄错一个名字，
 * 排查起来要半天。
 *
 * 为什么要这张表：08 §2.3 定死了"读走原生 Action，写走 Backend"。Agent 想改店里的
 * 任何东西，都不能直接调一个写 Action，只能 stage 一条 {@link ChangeKind} 的变更；
 * 审批过了，执行器才拿 `role-apply` 令牌去调对应的 Action。于是每个写 Action 都必须
 * 回答一个问题：**它对应 15 §2 目录里的哪一条 kind？**
 *
 * 三条纪律：
 *
 * 1. **没有对应 kind 的写动作不可 stage。** 15 §2 明说新增 kind 要同时给风险级、默认额度、
 *    硬约束与合成 executor——在这四样齐之前，宁可让这个动作根本没有入口，也不能让它
 *    挂到一个语义不符的 kind 上偷偷溜过额度。这类动作在表里带 {@link not_stageable} 的理由。
 * 2. **`execute_graphql` / `submit_bulk_query` 永远不在这张表里。** 它们的副作用取决于
 *    运行时传进来的 GraphQL 文档，静态判不了；写类 GraphQL 走的是"先校验文档、再按文档
 *    影响到的对象 stage 一条具体 kind"这条路（见 `apps/server/src/shopify-devmcp.ts`）。
 * 3. **`action_id` 是上游 OpenConnector 目录里的名字**，不是 Shopify 官方的 mutation 名。
 *    两者的对应写在 `graphql` 字段里，方便对着 Shopify 文档核对（也方便将来上游改名时
 *    一眼看出改的是哪一个）。
 */
import type { ChangeKind } from '@agentsws/contracts'

/** 变更落在哪类对象上（`StagedChange.target.type`）。 */
export type ShopifyTargetType =
  | 'product'
  | 'variant'
  | 'collection'
  | 'order'
  | 'discount'
  | 'campaign'
  | 'theme'
  | 'inventory_item'
  | 'page'
  | 'article'
  | 'store_config'

export interface ShopifyWriteAction {
  /** OpenConnector 目录里的 Action id（`shopify_admin.` 开头）。 */
  action_id: string
  /** 15 §2 的变更种类；没有就是"暂时不能 stage"，见 {@link not_stageable}。 */
  change_kind?: ChangeKind
  target: ShopifyTargetType
  /** Shopify Admin GraphQL 里对应的 mutation（对文档用；上游怎么实现是它的事）。 */
  graphql?: string
  /** 一句话：这个动作在店铺运营里干什么。 */
  what: string
  /** 没有 `change_kind` 时必须写：为什么还不能 stage。 */
  not_stageable?: string
}

/**
 * 店铺运营真正会用到的那些写动作。
 *
 * 覆盖范围按"一个人在店铺后台一天里会点哪些东西"来定：商品与变体、库存、价格、
 * 集合、订单、折扣、主题、元字段、页面与博客。
 */
export const SHOPIFY_WRITE_ACTIONS: readonly ShopifyWriteAction[] = [
  // ── 商品与变体 ───────────────────────────────────────────────────────
  {
    action_id: 'shopify_admin.create_product',
    change_kind: 'listing_edit',
    target: 'product',
    graphql: 'productCreate',
    what: '新建一个商品（草稿态；上架是另一条 publish_product）',
  },
  {
    action_id: 'shopify_admin.update_product',
    change_kind: 'listing_edit',
    target: 'product',
    graphql: 'productUpdate',
    what: '改标题、描述、图片、标签、商品类型',
  },
  {
    action_id: 'shopify_admin.update_product_variant',
    change_kind: 'listing_edit',
    target: 'variant',
    graphql: 'productVariantsBulkUpdate（单变体的 productVariantUpdate 在 schema 里根本不存在）',
    what: '改变体的非价格字段（SKU、条码、重量、选项值）',
  },
  {
    action_id: 'shopify_admin.update_product_price',
    change_kind: 'price_change',
    target: 'variant',
    graphql: 'productVariantsBulkUpdate（price / compareAtPrice）',
    what: '改一个变体的售价或划线价',
  },
  {
    action_id: 'shopify_admin.publish_product',
    change_kind: 'publish_product',
    target: 'product',
    graphql: 'publishablePublish（旧的 productPublish 已弃用）',
    what: '把商品放到某个销售渠道上（在线商店 / POS…）',
  },
  {
    action_id: 'shopify_admin.unpublish_product',
    change_kind: 'unpublish_product',
    target: 'product',
    graphql: 'publishableUnpublish（旧的 productUnpublish 已弃用）',
    what: '把商品从销售渠道上撤下来',
  },
  {
    action_id: 'shopify_admin.delete_product',
    target: 'product',
    graphql: 'productDelete',
    what: '删掉一个商品',
    not_stageable:
      '删除不可逆，15 §2 目录里没有对应 kind。要做得先定 `delete_product` 的风险级' +
      '（多半是 L1 永远）与硬约束——在那之前不给入口。',
  },
  // ── 库存 ─────────────────────────────────────────────────────────────
  {
    action_id: 'shopify_admin.set_inventory_quantities',
    target: 'inventory_item',
    graphql: 'inventorySetQuantities（旧的 inventorySetOnHandQuantities 已弃用）',
    what: '把某个仓的可售数量直接设成一个值（盘点后对账用）',
    not_stageable:
      '15 §2 里没有库存类 kind。它既不是 listing_edit（不改商品信息）也不是 price_change，' +
      '而且改错会直接超卖 —— 需要一条自己的 `inventory_change`（含"单次调整上限"这类额度）。',
  },
  {
    action_id: 'shopify_admin.adjust_inventory_quantities',
    target: 'inventory_item',
    graphql: 'inventoryAdjustQuantities',
    what: '在现有数量上加减（收货、报损）',
    not_stageable: '同上，缺 `inventory_change` kind。',
  },
  // ── 集合 ─────────────────────────────────────────────────────────────
  {
    action_id: 'shopify_admin.create_collection',
    change_kind: 'listing_edit',
    target: 'collection',
    graphql: 'collectionCreate',
    what: '建一个商品集合（手动或按条件）',
  },
  {
    action_id: 'shopify_admin.update_collection',
    change_kind: 'listing_edit',
    target: 'collection',
    graphql: 'collectionUpdate',
    what: '改集合的标题、描述、排序规则',
  },
  {
    action_id: 'shopify_admin.add_products_to_collection',
    change_kind: 'listing_edit',
    target: 'collection',
    graphql:
      'collectionUpdate.sourcesToUpdate…inclusion.selectionsToAdd（旧 collectionAddProducts 已弃用）',
    what: '往手动集合里加商品',
  },
  {
    action_id: 'shopify_admin.remove_products_from_collection',
    change_kind: 'listing_edit',
    target: 'collection',
    graphql: 'collectionUpdate…inclusion.selectionsToRemove（旧 collectionRemoveProducts 已弃用）',
    what: '把商品从手动集合里拿掉',
  },
  // ── 订单 ─────────────────────────────────────────────────────────────
  {
    action_id: 'shopify_admin.create_refund',
    change_kind: 'refund',
    target: 'order',
    graphql: 'refundCreate',
    what: '给一笔订单退款',
  },
  {
    action_id: 'shopify_admin.update_order_shipping_address',
    change_kind: 'address_change',
    target: 'order',
    graphql: 'orderUpdate（shippingAddress）',
    what: '改一笔未发货订单的收货地址',
  },
  {
    action_id: 'shopify_admin.create_fulfillment',
    change_kind: 'reship',
    target: 'order',
    graphql: 'fulfillmentCreate（旧的 fulfillmentCreateV2 已弃用，注意没有 V2）',
    what: '给订单建一次发货（补发也走这一条）',
  },
  {
    action_id: 'shopify_admin.update_order',
    target: 'order',
    graphql: 'orderUpdate',
    what: '改订单的备注、标签、联系邮箱这些非金额字段',
    not_stageable:
      '15 §2 里只有 `address_change` 这一条订单写 kind（而且带 `unfulfilled_only` 与受保护字段）。' +
      '通用的"改订单任意字段"没有额度可套，等于给 Agent 一个绕过 protected 的口子——' +
      '要做得按字段拆成具体 kind。',
  },
  {
    action_id: 'shopify_admin.cancel_order',
    target: 'order',
    graphql: 'orderCancel',
    what: '取消一笔订单（含退款与恢复库存的选项）',
    not_stageable:
      '取消订单会连带退款与库存回补，影响面比 refund 大，15 §2 里没有对应 kind。' +
      '要做得先定 `cancel_order`（不可逆、多半 L1 永远）。',
  },
  // ── 折扣与促销 ───────────────────────────────────────────────────────
  {
    action_id: 'shopify_admin.create_discount_code',
    change_kind: 'discount_code',
    target: 'discount',
    graphql: 'discountCodeBasicCreate',
    what: '建一个优惠码（客服安抚、售前促单都用它）',
  },
  {
    action_id: 'shopify_admin.update_discount_code',
    change_kind: 'discount_code',
    target: 'discount',
    graphql: 'discountCodeBasicUpdate',
    what: '改优惠码的额度、期限、适用范围',
  },
  {
    action_id: 'shopify_admin.delete_discount_code',
    target: 'discount',
    graphql: 'discountCodeDelete',
    what: '删掉一个优惠码',
    not_stageable:
      '删掉一个可能正在被人用的码是不可逆的（已经拿到码的客户会当场结算失败）。' +
      '15 §2 里没有对应 kind；要停一个码请改它的到期时间（`update_discount_code`）。',
  },
  {
    action_id: 'shopify_admin.create_automatic_discount',
    change_kind: 'promotion',
    target: 'campaign',
    graphql: 'discountAutomaticBasicCreate',
    what: '建一个自动折扣（全店活动，不用输码）',
  },
  {
    action_id: 'shopify_admin.update_automatic_discount',
    change_kind: 'promotion',
    target: 'campaign',
    graphql: 'discountAutomaticBasicUpdate',
    what: '改自动折扣的力度或期限',
  },
  // ── 主题（建站岗位；发布永远 L1）─────────────────────────────────────
  {
    action_id: 'shopify_admin.create_theme',
    target: 'theme',
    graphql: 'themeCreate',
    what: '建一份**未发布**的主题副本',
    not_stageable:
      '未发布副本对线上没有任何影响，它是主题工作的"草稿纸"而不是变更——' +
      '所以不进账本，走 Shopify CLI 的 `theme push --unpublished`' +
      '（`apps/server/src/shopify-theme.ts`）。真正要 stage 的是把它发布出去那一下。',
  },
  {
    action_id: 'shopify_admin.publish_theme',
    change_kind: 'publish_theme',
    target: 'theme',
    graphql: 'themePublish（2024-10 起有；**要 write_themes + Shopify 豁免**）',
    what:
      '把一份未发布的主题副本设成线上主题。' +
      '实际走的是 Shopify CLI（`theme publish`）——GraphQL 那条要向官方申请豁免',
  },
  {
    action_id: 'shopify_admin.update_theme_asset',
    change_kind: 'publish_theme',
    target: 'theme',
    graphql: 'themeFilesUpsert',
    what: '往主题里写文件。**只允许写未发布的副本**，写线上主题等于绕过发布门禁',
  },
  {
    action_id: 'shopify_admin.delete_theme',
    target: 'theme',
    graphql: 'themeDelete',
    what: '删掉一份主题',
    not_stageable: '删除不可逆且 15 §2 里没有对应 kind；清理旧主题请人在后台自己点。',
  },
  // ── 元字段 ───────────────────────────────────────────────────────────
  {
    action_id: 'shopify_admin.set_metafields',
    change_kind: 'listing_edit',
    target: 'product',
    graphql: 'metafieldsSet',
    what: '写商品 / 集合的自定义字段（成分、尺码表、结构化卖点）',
  },
  {
    action_id: 'shopify_admin.delete_metafield',
    change_kind: 'listing_edit',
    target: 'product',
    graphql: 'metafieldsDelete（复数；单数的 metafieldSet / metafieldDelete 不存在）',
    what: '删掉一个自定义字段',
  },
  // ── 页面与博客 ───────────────────────────────────────────────────────
  {
    action_id: 'shopify_admin.create_page',
    change_kind: 'listing_edit',
    target: 'page',
    graphql: 'pageCreate',
    what: '建一个独立页面（关于我们、尺码表、政策页）',
  },
  {
    action_id: 'shopify_admin.update_page',
    change_kind: 'listing_edit',
    target: 'page',
    graphql: 'pageUpdate',
    what: '改页面正文或标题',
  },
  {
    action_id: 'shopify_admin.create_article',
    change_kind: 'listing_edit',
    target: 'article',
    graphql: 'articleCreate',
    what: '发一篇博客文章',
  },
  {
    action_id: 'shopify_admin.update_article',
    change_kind: 'listing_edit',
    target: 'article',
    graphql: 'articleUpdate',
    what: '改一篇博客文章',
  },
]

const BY_ACTION = new Map(SHOPIFY_WRITE_ACTIONS.map((a) => [a.action_id, a]))

/** 这个写动作对应哪条变更种类；不可 stage 的回 undefined。 */
export function changeKindOfAction(action_id: string): ChangeKind | undefined {
  return BY_ACTION.get(action_id)?.change_kind
}

/** 查一条动作的完整说明（界面上"这个动作会改什么"就靠它）。 */
export function shopifyWriteAction(action_id: string): ShopifyWriteAction | undefined {
  return BY_ACTION.get(action_id)
}

/**
 * 这个动作现在能不能被 stage。回 `{ ok: false, reason }` 时 `reason` 是给人看的中文——
 * 运行内直接说给模型听（"这件事现在做不了，因为…"），比一句 `not_allowed` 有用得多。
 */
export function canStageAction(action_id: string): { ok: true } | { ok: false; reason: string } {
  const entry = BY_ACTION.get(action_id)
  if (entry === undefined) {
    return {
      ok: false,
      reason: `${action_id} 不在 Shopify 写动作对照表里：没有对应的变更种类，就没有施行它的路径`,
    }
  }
  if (entry.change_kind === undefined) {
    return { ok: false, reason: entry.not_stageable ?? '这个动作暂时没有对应的变更种类' }
  }
  return { ok: true }
}

/** 按变更种类反查：这条 kind 施行时该调哪个 Action。 */
export function actionsOfChangeKind(kind: ChangeKind): ShopifyWriteAction[] {
  return SHOPIFY_WRITE_ACTIONS.filter((a) => a.change_kind === kind)
}
