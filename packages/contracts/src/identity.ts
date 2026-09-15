import type { Iso8601, MaybePromise, PersonId, RangeRef, WorkspaceId } from './common.js'
import type { WorkspacePolicy } from './roles.js'

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
export type StorefrontPlatform = 'shopify' | 'woocommerce' | 'magento' | 'other'

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
 * 36 §3 / 51 §2 末条：这个平台现在根本接不上时，面板与工具该说的那一句人话。
 *
 * 支持的平台回 `undefined`（该说的是"去连接"，不是"还没接"——两回事：
 * 前者是"你还没连"，后者是"我们还没做"）。
 */
export function storefrontUnsupportedNote(id: StorefrontPlatform | undefined): string | undefined {
  const spec = storefrontPlatformSpec(id ?? DEFAULT_STOREFRONT_PLATFORM)
  if (spec === undefined || spec.supported) return undefined
  return spec.connector_service === undefined
    ? `这个平台还没接：你们选的是「${spec.label}」，没有店铺后台可以连。`
    : `这个平台还没接：你们的网站是用 ${spec.label} 搭的，它的店铺后台我们还没做。`
}

export interface WorkspaceProfile {
  legal_name: string
  domain?: string
  /** 默认 true（46 §1 表）。关了 = 独立使用，不广播、不监听、不登记。 */
  discoverable: boolean
  /** 48 v2 L2：你卖的是实物商品 / 虚拟产品与服务。缺省 = `goods`。 */
  vertical?: WorkspaceVertical
  /** 51 §1 N0：网站是用什么搭的。缺省 = `shopify`。 */
  storefront_platform?: StorefrontPlatform
  set_at: Iso8601
}

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
  /** 批准后建出来的成员（没批就没有）。 */
  person_id?: PersonId
  /** 46 I3：两边互相申请时后批的那一条为什么自动失效。 */
  superseded_reason?: string
}
