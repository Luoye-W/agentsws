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
  // WP77（59 §1）：建站那一侧新加的三类目标
  | 'email_template'
  | 'shop_app'
  | 'launch_item'

export interface ShopifyWriteAction {
  /** OpenConnector 目录里的 Action id（`shopify_admin.` 开头）。 */
  action_id: string
  /** 15 §2 的变更种类；没有就是"暂时不能 stage"，见 {@link not_stageable}。 */
  change_kind?: ChangeKind
  /**
   * WP64：同一个上游动作还施行哪几条 kind。
   *
   * 一个动作只有一条**主**语义（`change_kind`，界面上"这个动作会改什么"照它说），
   * 但反查"这条 kind 该调哪个动作"时这几条要一起认——`fulfillmentCreate` 就是例子：
   * 正常发货、补发、拆单的每一件包裹，在 Shopify 那头是同一次调用。
   */
  also_change_kinds?: ChangeKind[]
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
    change_kind: 'inventory_adjust',
    target: 'inventory_item',
    graphql: 'inventorySetQuantities（旧的 inventorySetOnHandQuantities 已弃用）',
    what: '把某个仓的可售数量直接设成一个值（盘点后对账用）。`after.mode: set`，永远人审',
  },
  {
    action_id: 'shopify_admin.adjust_inventory_quantities',
    change_kind: 'inventory_adjust',
    target: 'inventory_item',
    graphql: 'inventoryAdjustQuantities',
    what: '在现有数量上加减（收货、报损）。`after.mode: adjust`，额内（max_inventory_adjust）可自动',
  },
  // ── 集合 ─────────────────────────────────────────────────────────────
  {
    action_id: 'shopify_admin.create_collection',
    change_kind: 'collection_edit',
    target: 'collection',
    graphql: 'collectionCreate',
    what: '建一个商品集合（手动或按条件）',
  },
  {
    action_id: 'shopify_admin.update_collection',
    change_kind: 'collection_edit',
    target: 'collection',
    graphql: 'collectionUpdate',
    what: '改集合的标题、描述、排序规则',
  },
  {
    action_id: 'shopify_admin.add_products_to_collection',
    change_kind: 'collection_edit',
    target: 'collection',
    graphql:
      'collectionUpdate.sourcesToUpdate…inclusion.selectionsToAdd（旧 collectionAddProducts 已弃用）',
    what: '往手动集合里加商品',
  },
  {
    action_id: 'shopify_admin.remove_products_from_collection',
    change_kind: 'collection_edit',
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
    // WP64（51 §2.4）：正常发货有自己的 kind 了。补发（`reship`）与拆单（`split_order`）
    // 在 Shopify 那头是同一个 mutation——一次发货就是一次发货，区别在**为什么发**，
    // 而"为什么"决定的是额度与审批路由，所以三条 kind 共用这一个动作。
    change_kind: 'create_fulfillment',
    also_change_kinds: ['reship', 'split_order'],
    target: 'order',
    graphql: 'fulfillmentCreate（旧的 fulfillmentCreateV2 已弃用，注意没有 V2）',
    what: '给订单建一次发货：标记发货 + 回填单号（补发与拆单的每一件包裹也走这一条）',
  },
  {
    action_id: 'shopify_admin.update_order',
    target: 'order',
    graphql: 'orderUpdate',
    what: '改订单的备注、标签、联系邮箱这些非金额字段',
    not_stageable:
      '通用的"改订单任意字段"没有额度可套，等于给 Agent 一个绕过 protected 的口子——' +
      '要做得按字段拆成具体 kind。订单这一侧已经拆出来的是 `address_change`（改地址）、' +
      '`create_fulfillment`（标记发货 + 单号）、`split_order`（拆单）、`cancel_order`（取消），' +
      '备注 / 标签这些还没有人要，先不给。',
  },
  {
    action_id: 'shopify_admin.cancel_order',
    // WP64（51 §2.4）：`cancel_order` 这条 kind 现在有了，而且照当初写下的那句话办——
    // 不可逆，所以进 15 §2 的 `HARD_L1`，永远人审。
    change_kind: 'cancel_order',
    target: 'order',
    graphql: 'orderCancel',
    what: '取消一笔订单（含退款与恢复库存的选项）',
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
    // WP154「内容与搜索」：改标题 / 描述 / H1 / 开头、加小节、调内链——落到店里都是一次 pageUpdate
    also_change_kinds: ['page_seo_edit', 'page_section_add', 'internal_link_edit'],
    target: 'page',
    graphql: 'pageUpdate',
    what: '改页面正文或标题',
  },
  {
    action_id: 'shopify_admin.create_article',
    change_kind: 'publish_post',
    target: 'article',
    graphql: 'articleCreate',
    what: '写一篇博客文章。`after.published: false` 是草稿（L2），`true` 才是上线（永远 L1）',
  },
  {
    action_id: 'shopify_admin.update_article',
    change_kind: 'publish_post',
    // WP154：博客文章的元信息 / 小节 / 内链同样是一次 articleUpdate
    also_change_kinds: ['page_seo_edit', 'page_section_add', 'internal_link_edit'],
    target: 'article',
    graphql: 'articleUpdate',
    what: '改一篇博客文章（含把草稿翻成已发布——那一下就是 51 §2.2 里说的"发布 L1"）',
  },
  // ── 建站：店铺设置、导航、主题安装（WP77 / 59 §1 整站搭建）──────────
  //
  // 结账 / 支付 / 税的写口**故意一条都没有**（51 §1 N0 / §3 N2）：Shopify 那头
  // 要么没给，要么给了也不该给 Agent。guardrail 里还有第二道（`store_setup`
  // 碰到这几类字段直接 block）——两道都要，因为这张表管的是"有没有入口"，
  // guardrail 管的是"提案里有没有夹带"。
  {
    action_id: 'shopify_admin.update_shop_settings',
    change_kind: 'store_setup',
    target: 'store_config',
    graphql: 'shopUpdate（店铺名、联系邮箱、地址、单位）',
    what: '改店铺的基础信息（不含结账 / 支付 / 税——那三样没有入口）',
  },
  {
    action_id: 'shopify_admin.update_menu',
    change_kind: 'store_setup',
    target: 'store_config',
    graphql: 'menuUpdate',
    what: '改一条导航菜单（主菜单、页脚菜单）',
  },
  {
    action_id: 'shopify_admin.create_menu',
    change_kind: 'store_setup',
    target: 'store_config',
    graphql: 'menuCreate',
    what: '新建一条导航菜单',
  },
  {
    action_id: 'shopify_admin.update_shop_policy',
    change_kind: 'store_setup',
    target: 'store_config',
    graphql: 'shopPolicyUpdate',
    what: '改政策页正文（退换货、隐私、服务条款）——上线检查单上的必备项之一',
  },
  {
    action_id: 'shopify_admin.install_theme',
    change_kind: 'theme_install',
    target: 'theme',
    graphql: 'themeCreate（source 指向主题包；付费主题走后台购买流程）',
    what: '把一份新主题装进店里。**永远 L1**——要么花钱，要么把主题列表换了个样',
  },
  {
    action_id: 'shopify_admin.update_payment_settings',
    target: 'store_config',
    graphql: '（Admin API 未提供；后台手工）',
    what: '改支付方式与收款账户',
    not_stageable:
      '51 §1 N0 / §3 N2：**结账 / 支付 / 税不给写动作**。配错了顾客付不了钱，' +
      '而这不是"改回来"能了结的。目录里的 `payment_config` 这一版没有任何职责给得出入口——' +
      '要改请店主自己去后台点。',
  },
  {
    action_id: 'shopify_admin.update_tax_settings',
    target: 'store_config',
    graphql: '（Admin API 未提供；后台手工）',
    what: '改税率与征税规则',
    not_stageable:
      '同上一条（51 §3 N2）。少缴的税是商家自己扛，这件事不该有一条' +
      '"Agent 提、人点一下"的路径。目录里的 `tax_config` 这一版同样没有入口。',
  },
  // ── 建站：邮件模板（WP77 / 59 §1）────────────────────────────────────
  {
    action_id: 'shopify_admin.update_email_template',
    change_kind: 'email_template_edit',
    target: 'email_template',
    graphql: '（通知模板走 Admin 后台 / Theme CLI 的 notifications 目录）',
    what: '改一份通知邮件模板的 Liquid 正文。`after.enabled: false` 是草稿（L2），`true` 是启用（L1）',
  },
  // ── 建站：插件（WP77 / 59 §1）────────────────────────────────────────
  {
    action_id: 'shopify_admin.install_app',
    change_kind: 'app_install',
    target: 'shop_app',
    graphql: '（App 安装走 OAuth 授权页，不是一条 mutation）',
    what: '给店里装一个第三方 App。**永远 L1**——把店里的数据交给另一家公司，多数还按月收钱',
  },
  {
    action_id: 'shopify_admin.uninstall_app',
    change_kind: 'app_install',
    target: 'shop_app',
    graphql: 'appUninstall',
    what: '卸掉一个已装 App（`after.operation: uninstall`）。同样永远 L1——前台会当场少一块',
  },
  {
    action_id: 'shopify_admin.update_app_config',
    change_kind: 'app_config',
    target: 'shop_app',
    graphql: '（各家 App 自己的设置口；元字段的那部分走 metafieldsSet）',
    what: '改一个已装 App 的配置参数。L2——做错了改回来就是了',
  },
  // ── 评价（WP63 / 51 §2.1 评价管理）───────────────────────────────────
  //
  // 这一节**故意是空的**。Shopify 原生没有商品评价，评价住在第三方应用里
  // （Judge.me / Loox），所以 `review_reply` / `review_invite` 这两条 kind 在这张
  // Shopify 表里没有对应动作——它们等评价应用的连接器（连接目录里已登记为"待增加"）。
  //
  // 为什么 kind 先加、动作后到：kind 是**额度与门禁挂靠的地方**（回复要先读过那条
  // 评价、邀评要过合规词表）。这些规矩与哪个应用无关，先立下来，接哪家应用都照此办理。
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

/** 按变更种类反查：这条 kind 施行时该调哪个 Action（含 {@link ShopifyWriteAction.also_change_kinds}）。 */
export function actionsOfChangeKind(kind: ChangeKind): ShopifyWriteAction[] {
  return SHOPIFY_WRITE_ACTIONS.filter(
    (a) => a.change_kind === kind || (a.also_change_kinds ?? []).includes(kind),
  )
}
