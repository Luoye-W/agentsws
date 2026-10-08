import type { CloudOrgId } from './cloud.js'
import type { Iso8601, MaybePromise, PersonId, RangeRef, WorkspaceId } from './common.js'
import type { MarketsSource } from './markets.js'
import type { WorkspacePolicy } from './roles.js'

/** 52 O1：一个组织（公司）的 id。 */
export type OrganizationId = string

/**
 * 52 O1 / O3：组织里的一个人。
 *
 * 三档角色：`owner` 付钱、决定谁进哪些品牌；`admin` 能邀请人、能建品牌；
 * `member` 只是"公司里的一个人"，进不进某个品牌由 owner / admin 勾。
 *
 * 离职**不删行**（40 §1 / E2）：写 `left_at`，于是"谁在什么时候走的"留得住。
 */
export interface OrganizationMember {
  person_id: PersonId
  role: 'owner' | 'admin' | 'member'
  joined_at: Iso8601
  left_at?: Iso8601
}

/**
 * 52 O1：**公司 = 组织**，工作区**上面**的那一层。
 *
 * 组织级只放三样（52 O3）：
 *
 * - **人**：`members`——邀请进的是组织，进哪些品牌是组织里再勾的一件事。
 * - **钱**：`cloud_org_id`——49 M1 的云侧组织（余额与订阅挂在它上面）。
 * - **发现**：`legal_name` / `domain` / `discoverable`——46 §2 的 `company_key`
 *   从这里算，同事申请加入的是**组织**，不是某个品牌。
 *
 * 其余一律品牌级（连接、知识、职责分配、模型设置、通知偏好），
 * 因为它们本来就按 `workspace_id` 切（20），不用再造一层。
 *
 * 个人用户（46 I4 / 45 H1）：组织 = 一个人、一个品牌工作区——界面上不显示
 * "组织"这个词，直到加第二个品牌或第二个人。
 */
export interface Organization {
  id: OrganizationId
  /** 营业执照上的全称（46 §1 ①，从工作区档案上提到这里）。 */
  legal_name: string
  /** 公司邮箱域名（可选，从登录邮箱带出）。 */
  domain?: string
  /** "让用同一个工具的同事找到我"（46 §1 表，默认 true）。 */
  discoverable: boolean
  /**
   * WP251（Luoye 10-07）：公司实体地址（开发信页脚、报价单、单证都从这里取）。
   * 以前按品牌各存一份（{@link WorkspaceProfile.postal_address}），现在公司只有一份、对所有品牌生效；
   * 启动时一次性从品牌档案搬上来。没填过就没有。
   */
  postal_address?: string
  owner_id: PersonId
  members: OrganizationMember[]
  /** 49 M1 / 52 O3「钱」：云侧那个计费主体。关联账号时写上。 */
  cloud_org_id?: CloudOrgId
  created_at: Iso8601
  /**
   * WP271（docs/95，决策 222）：这个组织的**用法**——① 个人 / ② 同事互联 / ③ 公司集体。
   *
   * 存下来的是「开没开公司模式」这个意图：`company` 只能有人主动开；`solo` 与 `peers`
   * 由人数自动走（第二个人进来就是 ②，只剩一个人就回 ①），所以读的时候一律过
   * {@link organizationModeOf}，不要直接读这一格。
   *
   * 可选：这一格出现之前建的组织没有它，启动时按决策 232 一次性推出来写上。
   */
  mode?: OrganizationMode
  /** WP271：模式最后一次改的时刻（启动时推出来的也记）。 */
  mode_changed_at?: Iso8601
  /** WP271：谁改的；启动时推出来的没有这一格。 */
  mode_changed_by?: PersonId
  /**
   * WP277（决策 240）：降回同事互联之后首页那一行通知，谁已经点掉了。模式一变就清空（再改一次，
   * 大家再看到一次）。只有 person id。
   */
  mode_seen_by?: PersonId[]
}

/** WP271（docs/95 §1）：① 个人（默认）/ ② 同事互联 / ③ 公司集体。 */
export type OrganizationMode = 'solo' | 'peers' | 'company'

/**
 * WP271：这个组织**现在**是哪种用法——工作台与服务端都只问这一个函数。
 *
 * `others` = 除所有者之外还在的人数（组织成员与各品牌成员去重后）。
 *
 * - 存了 `company` → ③（只有人主动开，人再少也不自己掉下来，docs/95 §3.6）。
 * - 存了 `solo` / `peers` → 看人数：有别人就是 ②，只剩自己就是 ①（§3.3 / §3.6）。
 * - 没存（老数据，决策 232）→ 有别人就是 ③（行为与以前一样），只有自己（不管几个品牌）就是 ①。
 */
export function organizationModeOf(
  org: Pick<Organization, 'mode'>,
  others: number,
): OrganizationMode {
  if (org.mode === 'company') return 'company'
  if (org.mode === undefined) return others > 0 ? 'company' : 'solo'
  return others > 0 ? 'peers' : 'solo'
}

/**
 * 52 O1：**品牌 = 工作区**，工作区身上"品牌"那一面。
 *
 * `name` 默认等于工作区名（迁移时回填），之后可以单独改——品牌名是给人看的，
 * 工作区 id 是给机器用的，两件事。
 */
export interface Brand {
  name: string
  /** 品牌 logo（data URL 或本机路径）；没有就用首字母。 */
  logo?: string
}

/** 20 身份与工作区（v1：local provider、单工作区；Join 只定类型） */
export interface Person {
  id: PersonId
  email: string
  name: string
  identities: {
    provider: 'local' | 'feishu' | 'wecom' | 'dingtalk'
    external_id: string
    verified_at?: Iso8601
  }[]
  created_at: Iso8601
}
export interface Workspace {
  id: WorkspaceId
  schema_version: 1
  kind: 'personal' | 'shared'
  name: string
  /**
   * 52 O1：这个**品牌工作区**挂在哪个组织（公司）下。
   *
   * 可选，因为存量工作区是在"组织"这个对象出现之前建的——启动时的一次性迁移
   * 会给每个没有它的工作区建一个组织并写上（见 20 §7）。没有它 = 还没迁过，
   * 行为与这一版上线前一模一样。
   */
  org_id?: OrganizationId
  /**
   * 52 O1：品牌（名字 + logo）。`brand.name` 默认等于 `name`，迁移时回填。
   *
   * 顶栏的品牌切换器显示的就是它。
   */
  brand?: Brand
  /** 46 §1 ①：公司档案（全称 / 域名 / 发现开关）。没设过 = 还没走过首次设置向导。 */
  profile?: WorkspaceProfile
  tz: string
  base_currency: string
  parent_id?: WorkspaceId
  runtime: { mode: 'local' | 'docker' | 'hosted'; endpoint: string }
  owner_id: PersonId
  policy: WorkspacePolicy
  registries: string[]
  status: 'active' | 'joined' | 'archived'
}
/**
 * 品牌名的唯一读法：设过就用 `brand.name`，没设过（存量、还没迁）就用工作区名。
 *
 * 顶栏切换器、组织页品牌一览、⌘K 搜品牌全走它——不许谁再写一遍 `?? name`。
 */
export function brandNameOf(workspace: Pick<Workspace, 'name' | 'brand'>): string {
  const name = workspace.brand?.name?.trim()
  return name === undefined || name === '' ? workspace.name : name
}

/**
 * 45 H2（52 O1 改写）：**同一个品牌**的唯一键 = 品牌名归一化 + 店铺域名。
 *
 * 两个人各自建了同一个品牌（键一样）才走 45 的对照合并；否则一律是
 * "把这个品牌工作区整个挂到组织下"（`attachWorkspaceToOrg`）——不合并进别人的品牌。
 *
 * 归一化与公司名那一套（`@agentsws/core` 的 `normalizeCompanyName`）**不是**同一个函数：
 * 品牌名没有"有限公司"这类后缀要剥，只做大小写、空白与全半角的归一。
 */
export function brandKey(brand_name: string, store_domain?: string): string {
  const name = brand_name.normalize('NFKC').toLowerCase().replace(/\s+/g, '').trim()
  const domain = (store_domain ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/^www\./, '')
  return domain === '' ? name : `${name}@${domain}`
}

export interface Membership {
  workspace_id: WorkspaceId
  person_id: PersonId
  role: 'owner' | 'manager' | 'member'
  ranges: RangeRef[]
  joined_at: Iso8601
  left_at?: Iso8601
}

/**
 * 20 §3：一张 token 的状态。`GET /v1/auth/session` 要报「还剩多久」，
 * 靠的就是它——签发时给了 `expires_at`，之后没人能再问一遍，是 20 的一个洞。
 */
export interface TokenInfo {
  kind: 'session' | 'api_key' | 'runtime' | 'internal'
  person_id: PersonId
  workspace_id: WorkspaceId
  expires_at?: Iso8601
  revoked: boolean
}

export interface IdentityService {
  createPerson(input: { email: string; name: string }): Promise<Person>
  getPerson(id: PersonId): Promise<Person | undefined>
  /**
   * 09-18 Luoye 真机：向导第 ② 步的名字改不了、设置页也没有改名的地方。名字是**本人的**
   * 展示名（不是登录邮箱），本人可改；只改 `name`，其余字段一个不碰。空名或超长由路由层拒。
   */
  renamePerson(id: PersonId, name: string): Promise<Person>
  /**
   * WP233：改一个人的登录邮箱（目前只有一处用：本机负责人从占位邮箱改成云账号邮箱）。
   *
   * **可选**：只实现最小面的身份服务没有它，调用方探测不到就不改。
   * 人的 id 不变，所以成员、分配、会话、审计（都按 `person_id` 记）一条都不断；
   * `keep_old_as_alias` 为真时旧地址仍能找到这个人（`personByEmail` / 登录），
   * 于是还在用旧地址的地方（启动时按邮箱认 owner、桌面壳换会话）照常工作。
   * 新邮箱已经是**别人**的 → `conflict`；不合法 → `invalid_input`。
   */
  changePersonEmail?(
    id: PersonId,
    email: string,
    options?: { keep_old_as_alias?: boolean },
  ): Promise<Person>
  createWorkspace(input: {
    name: string
    owner_id: PersonId
    kind: Workspace['kind']
    tz?: string
    base_currency?: string
  }): Promise<Workspace>
  getWorkspace(id: WorkspaceId): Promise<Workspace | undefined>
  addMember(m: Omit<Membership, 'joined_at'>): Promise<Membership>
  members(workspace_id: WorkspaceId): Promise<Membership[]>
  /** magic link：签发一次性登录 token；验证后返回会话 */
  issueLogin(email: string): Promise<{ token: string; expires_at: Iso8601 }>
  verifyLogin(token: string): Promise<{ person: Person; session_token: string } | undefined>
  /** 20 §3：签发 API key / 运行时短期 token / 内部凭据；全部绑 workspace，可撤销 */
  issue(
    kind: 'session' | 'api_key' | 'runtime' | 'internal',
    person_id: PersonId,
    workspace_id: WorkspaceId,
    ttl_ms?: number,
  ): MaybePromise<{ token: string; expires_at?: Iso8601 }>
  revoke(token: string): MaybePromise<void>
  personByEmail(email: string): MaybePromise<Person | undefined>
  workspacesOf(person_id: PersonId): MaybePromise<Workspace[]>
  /**
   * 查一张 token 的状态（20 §3）。**可选**：不属于「身份」的最小面，
   * 换一个只实现必需方法的身份服务时 `GET /v1/auth/session` 少一个 `expires_at`，其余照常。
   */
  tokenInfo?(token: string): MaybePromise<TokenInfo | undefined>
  /** 所有 token 绑 workspace；入参为 Bearer 后的 token 本身 */
  authenticate(bearer: string): Promise<
    | {
        person_id: PersonId
        workspace_id: WorkspaceId
        kind: 'session' | 'api_key' | 'runtime' | 'internal'
      }
    | undefined
  >
}

/** 20 §1 补（WP28）：邀请同事。token 只存 sha256，一次性、24h；接受后成为 member 并可被分配。 */
export interface Invitation {
  id: string
  workspace_id: WorkspaceId
  email: string
  invited_by: PersonId
  position_id?: string
  token_sha256: string
  expires_at: Iso8601
  used_at?: Iso8601
  created_at: Iso8601
}

/**
 * 46 §1 ①：这个工作区背后是哪家公司。
 *
 * 三个字段都是**人填的身份信息**，不是凭据：`legal_name` 是营业执照上的全称，
 * `domain` 是公司邮箱域名（可选，从登录邮箱带出），`discoverable` 是"让用同一个
 * 工具的同事找到我"那个开关。
 *
 * 46 §2 I1 的底线：发现阶段**只出哈希**（`companyKey` 算出来的那一串），
 * 全称与域名从不离开本机；名字一样也不等于同一家——连上必须有人申请、有人批准。
 */
/**
 * 48 v2 L2 / 46 §1：**你卖的是**实物商品还是虚拟产品与服务。
 *
 * 它不是两套代码，是**一个档案字段**：客服共享包按它取垂直包（人设、词表、意图、
 * 业务边界、追问措辞）。非法值与缺省一律按实物处理——存量工作区与老的导出包里
 * 没有这个字段，它们的行为必须与这一版上线前一模一样。
 */
export type WorkspaceVertical = 'goods' | 'digital'

/**
 * 51 §1 N0 / 46 §1 ①：**网站是用什么搭的**。
 *
 * 它与 `vertical` 同一个性质——**一个档案字段**，不是两套代码：连接目录挑哪张店铺卡、
 * 职责模板里 `kind: shop` 的连接器解析成哪个 provider、岗位面板的"店铺后台"跟谁要数、
 * 登记表里对象的真源标注，全从这一个字段推出来。
 *
 * 非法值与缺省一律按 `shopify` 处理——存量工作区与老的导出包里没有这个字段，
 * 它们的行为必须与这一版上线前一模一样。
 */
export type StorefrontPlatform = 'shopify' | 'woocommerce' | 'magento' | 'other' | 'none'

/** 没设过 `storefront_platform` 的工作区按它算（51 §1：现在只开 Shopify）。 */
export const DEFAULT_STOREFRONT_PLATFORM: StorefrontPlatform = 'shopify'

/**
 * 51 §1 N0 的那张表：四个平台各自的中文名、现在支不支持、店铺连接走哪个 provider。
 *
 * **这是平台这件事的唯一真源**：首次设置的四个单选、连接页显示哪张店铺卡、
 * `kind: shop` 的职责连接器解析、活数据源与事项工具的"活跃店铺连接"判定、
 * 登记表生成器给对象真源打的平台标注，全读它，谁都不许再写第二份。
 *
 * `supported: false` = 界面上灰显并标"待增加"，不是藏起来——用户要看得见"下一个是谁"。
 * Magento 没有 `connector_service`：OpenConnector 容器里根本没有这个 provider
 * （09-15 `ls /app/src/providers` 核过），先写 provider 才谈得上接。
 *
 * WP79：`none`（还没开始搭建）是**选得动**的（`supported: true`）而且**没有**
 * `connector_service`——"我还没有网站"不是"我们还没做这个平台"。两件事在界面上
 * 说的是两句话：前者"你还没搭网站"，后者"这个平台我们还没接"。
 */
export interface StorefrontPlatformSpec {
  id: StorefrontPlatform
  /** 中文名（界面上显示的那一个）。 */
  label: string
  /** 现在能不能选。false = 灰显 + "待增加"。 */
  supported: boolean
  /** 店铺连接走连接目录里的哪个 provider；没有 = 连接器还没有这个平台。 */
  connector_service?: string
}

export const STOREFRONT_PLATFORMS: readonly StorefrontPlatformSpec[] = [
  { id: 'shopify', label: 'Shopify', supported: true, connector_service: 'shopify_admin' },
  // WP79：还没有网站的人也得能往下走。选得动（不灰显、不带"待增加"），
  // 只是没有店铺连接——清单里不出店铺卡，面板上那一块说的是"还没搭网站"。
  { id: 'none', label: '还没开始搭建', supported: true },
  // OpenConnector 容器里已经有 `woocommerce` provider，缺的是动作对照表（51 §1「下一个平台」）
  { id: 'woocommerce', label: 'WooCommerce', supported: false, connector_service: 'woocommerce' },
  { id: 'magento', label: 'Magento', supported: false },
  // "其它 / 自己写的" = 没有店铺连接：网站运营岗位只剩不依赖平台的那部分
  { id: 'other', label: '其它 / 自己搭的', supported: false },
]

/** 平台 id → 那一行；不认识的 id 回 `undefined`（调用方自己决定按缺省还是报错）。 */
export function storefrontPlatformSpec(
  id: StorefrontPlatform | undefined,
): StorefrontPlatformSpec | undefined {
  return STOREFRONT_PLATFORMS.find((p) => p.id === id)
}

/**
 * 这个平台的店铺连接走哪个 provider。
 *
 * 缺省（没设过档案）按 Shopify——存量工作区的行为一个字节不变。
 * `other` / Magento 回 `undefined` = 这个工作区**没有店铺连接**，
 * 面板与工具照 36 §3 明说"这个平台还没接"，不是默默给空数据。
 */
export function storefrontConnectorService(id: StorefrontPlatform | undefined): string | undefined {
  return storefrontPlatformSpec(id ?? DEFAULT_STOREFRONT_PLATFORM)?.connector_service
}

/**
 * 现在**真有一张卡可点**的那个店铺 provider（首次设置第 ④ 步的清单、连接页）。
 *
 * 与 `storefrontConnectorService` 的区别只有一条：那一个回的是"这个平台将来走哪个
 * provider"（WooCommerce 已经有 `woocommerce` 这个名字了），这一个回的是"今天点得动
 * 的是哪一个"。`supported: false` 的平台一律 `undefined`——清单里出一张点进去
 * 无处可点的卡，比没有它更糟。
 */
export function storefrontUsableService(id: StorefrontPlatform | undefined): string | undefined {
  const spec = storefrontPlatformSpec(id ?? DEFAULT_STOREFRONT_PLATFORM)
  return spec?.supported === true ? spec.connector_service : undefined
}

/**
 * WP79：这个工作区**自己说还没搭网站**（第 ① 步选了「还没开始搭建」）。
 *
 * 判据就是表里那一行——选得动（`supported`）却没有 `connector_service`。
 * 与"我们还没接这个平台"分开报：前者是用户的状态（他自己会去搭），
 * 后者是我们的缺口（他等我们）。原因码、面板那一句、清单出不出店铺卡都靠它分档。
 */
export function storefrontNotBuilt(id: StorefrontPlatform | undefined): boolean {
  const spec = storefrontPlatformSpec(id ?? DEFAULT_STOREFRONT_PLATFORM)
  return spec?.supported === true && spec.connector_service === undefined
}

/** 连接目录里的这个 provider 是不是"某个平台的店铺卡"（是的话它要按档案过滤）。 */
export function isStorefrontService(service: string): boolean {
  return STOREFRONT_PLATFORMS.some((p) => p.connector_service === service)
}

/**
 * 同一个 provider 的别名：真实连接上报的 service 名不一定等于目录里的 id。
 *
 * Shopify 那条历史上有两种写法（真适配器报 `shopify_admin`，替身报 `shopify`），
 * 两边都得认得——不然换个替身跑，店铺连接就"消失"了。只可加行，不许删。
 */
const STOREFRONT_SERVICE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  shopify_admin: ['shopify_admin', 'shopify'],
}

/** 一条真实连接的 service 名算不算"这个平台的店铺后台"。 */
export function storefrontServiceMatches(want: string, service: string): boolean {
  if (service === want) return true
  return STOREFRONT_SERVICE_ALIASES[want]?.includes(service) ?? false
}

/**
 * 36 §3 / 51 §2 末条：这个工作区**没有店铺后台可连**时，面板与工具该说的那一句人话。
 *
 * 三档，说的是三件不同的事：
 *
 * - 平台支持、有连接器（Shopify）→ `undefined`。该说的是"去连接"（你还没连），
 *   不是"还没接"（我们还没做）。
 * - 平台支持、没有连接器（WP79 的 `none`「还没开始搭建」）→ **你还没搭网站**。
 *   这不是我们的缺口，是用户自己的状态，所以不许说成"这个平台还没接"。
 * - 平台不支持（WooCommerce / Magento / 其它）→ **这个平台还没接**。
 */
export function storefrontUnsupportedNote(id: StorefrontPlatform | undefined): string | undefined {
  const spec = storefrontPlatformSpec(id ?? DEFAULT_STOREFRONT_PLATFORM)
  if (spec === undefined) return undefined
  if (spec.supported) {
    return spec.connector_service === undefined
      ? '还没搭网站：你们选的是「还没开始搭建」，所以没有店铺后台可以连。'
      : undefined
  }
  return spec.connector_service === undefined
    ? `这个平台还没接：你们选的是「${spec.label}」，没有店铺后台可以连。`
    : `这个平台还没接：你们的网站是用 ${spec.label} 搭的，它的店铺后台我们还没做。`
}

/**
 * 46 §1 ①：这个工作区背后是哪家公司。
 *
 * 52 O1 之后这里只剩**品牌级**的三样：`vertical`（你卖的是）、
 * `storefront_platform`（网站平台）、以及工作区自己的时区与币种（在 `Workspace` 上）。
 * 公司级的三样（`legal_name` / `domain` / `discoverable`）已上提到 {@link Organization}
 * ——位还留着（契约只加不删），但标了 `@deprecated`：读以组织为准，写时同步。
 */
export interface WorkspaceProfile {
  /**
   * @deprecated 52 O1：公司级字段已上提到 {@link Organization.legal_name}。
   * 读**一律以组织为准**，写的时候两边一起写（契约只加不删，所以这个位还留着）。
   */
  legal_name: string
  /**
   * @deprecated 52 O1：见 {@link Organization.domain}。
   */
  domain?: string
  /**
   * 默认 true（46 §1 表）。关了 = 独立使用，不广播、不监听、不登记。
   *
   * @deprecated 52 O1：见 {@link Organization.discoverable}。发现是**组织级**的一件事
   * ——同事申请加入的是公司，不是某个品牌。
   */
  discoverable: boolean
  /** 48 v2 L2：你卖的是实物商品 / 虚拟产品与服务。缺省 = `goods`。 */
  vertical?: WorkspaceVertical
  /** 51 §1 N0：网站是用什么搭的。缺省 = `shopify`。 */
  storefront_platform?: StorefrontPlatform
  /**
   * WP159：目标市场（ISO 国家码，大写）。品牌分析确认时从档案卡写进来；违规宣称规则按它启用
   * 对应市场组。没写过 = 不知道（不猜）。
   */
  markets?: string[]
  /**
   * WP166：这份市场是从哪看出来的（官网 / Amazon / 店铺后台 / 人自己改的）。人改过的（`human`）
   * 之后自动推断与店铺校正都不再覆盖。没有 = 老档案（WP159 写的），按"不知道从哪来"处理。
   */
  markets_source?: MarketsSource
  /**
   * WP169：按市场覆盖探测用的语言（国家码 → ISO 639-1，如 `{ CA: 'fr' }`）。没写的市场按
   * `MARKET_PRIMARY_LANGUAGE` 的第一语言；表里也没有就按品牌语言。
   */
  market_languages?: Record<string, string>
  /**
   * WP176：公司实体地址（开发信页脚、报价单、单证都从这里取；CAN-SPAM 要求开发信带它）。
   * 没填 = 开发信不能发。以前住在 B2B「主动开发」的设置里，已有值启动时搬过来。
   *
   * @deprecated WP251：公司级，真源是 {@link Organization.postal_address}。档案里这一格只是
   * 与公司同步的影子（回滚到旧版时读得到同一份），程序一律从公司读。
   */
  postal_address?: string
  /**
   * WP248（决策 83，Luoye 10-07）：品牌的一句话介绍。以前只活在那一轮网址分析里（进程内存，重启就没了）；
   * 现在第 ② 步确认分析 / 手填时写进档案，设置页「这个品牌」能改，AI 运行取品牌上下文时带上。没写过就没有。
   */
  one_liner?: string
  /** WP248（决策 83）：客服邮箱（给客人写信、话术里留的那一个）。没写过就没有。 */
  support_email?: string
  /**
   * WP258：官网里读到的 Shopify 店铺地址（`xxx.myshopify.com`，品牌分析确认时顺手存下）。
   * 建站岗位找店时拿它和登录账号下的店对一下；没读到就没有。
   */
  shopify_domain?: string
  /**
   * WP248（决策 83）：这个品牌卖货用的币种（ISO 4217，大写三位）。没写过按
   * {@link DEFAULT_BRAND_CURRENCY}（读的时候补，不往老档案里回写）。
   */
  currency?: string
  /**
   * WP240：建品牌那一刻自动起的那一份（公司级三样的影子 + 建品牌时选的平台），**还没人走过首次设置**。
   * 有它 = 这个品牌仍该进首次设置；走过第 ② 步 / 设置页存过一次就没有了。
   */
  provisional?: true
  set_at: Iso8601
}

/** WP248（决策 83）：品牌档案没写过币种时按它（Luoye 10-07：默认 USD）。 */
export const DEFAULT_BRAND_CURRENCY = 'USD'

/**
 * 46 §2 I2 第一条渠道：邀请码。
 *
 * 8 位人类可读码（去掉了形近字），24h 过期，默认能用 5 次——它只是一张"你可以来敲门"
 * 的条子，敲完仍要目标工作区的 owner 批（`MembershipRequest`），所以多次可用不等于多人直通。
 */
export interface Invite {
  code: string
  workspace_id: WorkspaceId
  created_by: PersonId
  expires_at: Iso8601
  uses_left: number
}

/** 46 §2 I3：怎么看见对方的。 */
export type MembershipRequestVia = 'invite' | 'lan' | 'directory'

export type MembershipRequestStatus = 'pending' | 'approved' | 'rejected' | 'superseded'

/**
 * 46 §2 I3：一次"申请加入你们工作区"。
 *
 * `person` 只有名字与邮箱——申请阶段不交换任何业务数据（46 §4）。批准后才走
 * 20 §4 的 Join（导入 + 映射确认），凭据仍要本人自己交出。
 */
export interface MembershipRequest {
  id: string
  workspace_id: WorkspaceId
  person: { name: string; email: string }
  via: MembershipRequestVia
  status: MembershipRequestStatus
  created_at: Iso8601
  decided_at?: Iso8601
  /** WP276（决策 237）：谁点的同意 / 拒绝（② 里任何一位同事都能定，团队页上写名字）。 */
  decided_by?: PersonId
  /** 批准后建出来的成员（没批就没有）。 */
  person_id?: PersonId
  /** 46 I3：两边互相申请时后批的那一条为什么自动失效。 */
  superseded_reason?: string
}

// ── WP233：本机负责人的占位邮箱、与云账号对齐、公司邮箱后缀 ─────────────────

/**
 * 本机模式没给 `AGENTSWS_OWNER_EMAIL` 时，服务进程给负责人（owner）起的**占位**登录邮箱。
 *
 * 它只是一个内部键，不是谁的真邮箱——界面上一律不出现（WP233，Luoye 10-05 真机：
 * 第 ② 步看见「登录邮箱：owner@localhost」，以为第 ① 步填的没生效）。
 * 关联了云账号之后，本机负责人的邮箱改成那个云账号邮箱（见 {@link PersonEmailChangedPayload}）。
 */
export const PLACEHOLDER_OWNER_EMAIL = 'owner@localhost'

/** 这是不是那个占位邮箱（大小写、首尾空白不敏感）。 */
export function isPlaceholderOwnerEmail(email: string | undefined): boolean {
  return email !== undefined && email.trim().toLowerCase() === PLACEHOLDER_OWNER_EMAIL
}

/**
 * WP233：本机负责人的登录邮箱改了（目前只有一种：占位邮箱 → 刚关联上的云账号邮箱）。
 *
 * 与 `cloud.account_linked` 同一条纪律：**只记域名**，邮箱本地部分一个字节都不进日志（21 §1）。
 * `reason`：`cloud_account_linked` = 第 ① 步刚关联上；`cloud_account_backfill` = 老工作区
 * 启动时补的那一次（早就关联了，但邮箱还是占位）。
 */
export interface PersonEmailChangedPayload {
  person_id: PersonId
  from_domain: string
  to_domain: string
  reason: 'cloud_account_linked' | 'cloud_account_backfill'
}

/**
 * 公共邮箱的后缀：用这些邮箱的人不等于"一家公司"，所以「公司邮箱后缀」**不从它们带出**。
 * 只是一张常见表，不求全——漏掉的那几个用户自己清空那一格就是。
 */
export const PUBLIC_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.de',
  'web.de',
  'mail.ru',
  'yandex.ru',
  'qq.com',
  'foxmail.com',
  '163.com',
  '126.com',
  'yeah.net',
  'sina.com',
  'sina.cn',
  'sohu.com',
  'aliyun.com',
  '139.com',
  '189.cn',
]

/**
 * 「公司邮箱后缀」那一格**只收域名**：用户误填整个邮箱时截 `@` 后面那段，
 * 顺手去掉首尾空白、开头的 `@`、`http(s)://`、`www.` 与路径，统一小写。
 * 与服务端归一化（`normalizeDomain`）同一套规矩，这一份是给界面用的（不依赖 Node）。
 */
export function companyEmailSuffix(raw: string): string {
  let s = raw.trim().toLowerCase()
  s = s.replace(/^[a-z]+:\/\//, '')
  s = s.replace(/^.*@/, '')
  s = s.replace(/^www\./, '')
  s = s.replace(/[/?#].*$/, '')
  return s.trim()
}

/** 这个后缀能不能当「公司」的后缀带出来：不是公共邮箱、不是占位、像一个真域名。 */
export function isCompanyEmailSuffix(domain: string): boolean {
  const d = companyEmailSuffix(domain)
  if (d === '' || !d.includes('.') || d.endsWith('.')) return false
  if (d === 'localhost' || d.endsWith('.localhost') || d.endsWith('.local')) return false
  return !PUBLIC_EMAIL_DOMAINS.includes(d)
}

/**
 * 从几个邮箱里挑第一个能当公司后缀的（WP233：云账号邮箱在前，品牌客服邮箱在后）。
 * 全是公共邮箱 / 占位 / 空的时候返回 `undefined`——那一格就空着，不瞎带。
 */
export function suggestCompanyEmailSuffix(
  emails: readonly (string | undefined)[],
): string | undefined {
  for (const email of emails) {
    if (email === undefined || !email.includes('@')) continue
    const d = companyEmailSuffix(email)
    if (isCompanyEmailSuffix(d)) return d
  }
  return undefined
}
