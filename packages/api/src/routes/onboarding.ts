/**
 * 首次设置、同事发现、邀请码与申请加入（46）。
 *
 * 这一组路由回答的是用户第一次打开工具时的三个问题——**你们公司叫什么、你是谁、
 * 你做什么**——以及随之而来的两件事：要连哪些平台、同一家公司的同事怎么互相看见。
 *
 * 四条边界：
 *
 * 1. **网关里不写业务**（28 §2）。归一化怎么做、mDNS 怎么广播、邀请码怎么发，
 *    全在 `apps/server/src/{onboarding,discovery,invites}.ts`；这一层只做路由声明、
 *    权限判定与信封。
 * 2. **发现阶段只出哈希**（46 §2 I1）。`GET /v1/discovery/peers` 回的是对方自己愿意
 *    报的展示名（owner 名 + 人数）与主机端口，**没有**公司全称、没有成员名单、
 *    没有任何业务数据。归一化哈希只在局域网的 TXT 记录里出现，不在这条路由的响应里。
 * 3. **看见 ≠ 连上**（46 §2 I1）。名字一样不自动共享任何东西：连上必须一方申请、
 *    另一方 owner 批（`membership` 审批卡，14）。这组路由里没有任何一条能跳过那张卡。
 * 4. **自助豁免**：读"我这个工作区要不要走向导"、算"我勾了这些岗位要配什么"都是
 *    读自己的绑定，不要求策略层读权限；真改公司档案、发邀请码、批申请一律 owner 级。
 */
import type {
  BrandAudience,
  BrandCompetitor,
  BrandInsightField,
  BrandKeywords,
  BrandOffering,
  BrowserExtensionUse,
  MarketsSource,
  MaybePromise,
  MembershipClaimView,
  MembershipRequestVia,
  StorefrontPlatform,
  TeamSubscriptionView,
} from '@agentsws/contracts'
import { TEAM_DOOR_HEADER } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import {
  assignmentOf,
  body,
  holdsOwnerWrite,
  ok,
  param,
  principalOf,
  OWNER_WRITE as WRITE,
} from '../helpers.js'
import { peersBypass, type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 看别人的成员申请 = 策略层读权限；看自己要不要走向导走自助豁免。 */
/**
 * 改公司档案 / 发邀请码 / 批申请用 `WRITE`（= `helpers.OWNER_WRITE`），而"所有者站在
 * 随便哪一条分配上都放行"那把尺子是 `helpers.holdsOwnerWrite`——向导第 ② 步的
 * `/v1/brand-intake/*` 用的是同一把（WP121b 把它挪进 helpers，两处共用一份）。
 */
const READ = {
  domain: 'policy',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const TAG = 'onboarding'

// ── 端口类型（apps/server 实现）────────────────────────────────────────

export interface OnboardingActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

/**
 * 46 §1 ①：界面上那几个字段。`discoverable` 不给按 true（表里的默认值）。
 *
 * WP54（48 v2 L2）：加 `vertical`「你卖的是」。不给 = 不改（第一次不给就是实物）。
 */
export interface WorkspaceProfileInput {
  legal_name: string
  domain?: string | undefined
  discoverable?: boolean | undefined
  vertical?: 'goods' | 'digital' | undefined
  storefront_platform?: StorefrontPlatform | undefined
  /**
   * WP65（52 O4）：第 ① 步下半块「第一个品牌」的名字。
   *
   * 不给 = 不改（品牌名默认等于工作区名）。它与上面那三个公司级字段落在**两个地方**：
   * 公司的进组织，这一个进 `Workspace.brand`——第 ① 步问的是两件事，不是一件。
   */
  brand_name?: string | undefined
  /**
   * WP159：目标市场（ISO 国家码）。不给 = 沿用上一次。
   * WP166：HTTP 这一面也收了（设置页「公司档案」可以增删）；从这里改的出处记成「人改的」。
   */
  markets?: string[] | undefined
  /** WP166：这份市场是从哪看出来的（服务端内部用：品牌分析确认时是官网 / Amazon；HTTP 不收）。 */
  markets_source?: MarketsSource | undefined
  /**
   * WP169：按市场覆盖探测语言（国家码 → ISO 639-1，如 `{ CA: 'fr' }`）。不给 = 沿用上一次；
   * 给空对象 = 清空覆盖（全按每个市场的第一语言）。
   */
  market_languages?: Record<string, string> | undefined
  /**
   * WP176：公司实体地址（开发信页脚、报价单、单证从这里取）。不给 = 不改；给空串 = 清空。
   */
  postal_address?: string | undefined
  /** WP248（决策 83）：品牌一句话介绍。不给 = 不改；给空串 = 清空。 */
  one_liner?: string | undefined
  /** WP248（决策 83）：客服邮箱。不给 = 不改；给空串 = 清空；不像邮箱回 400。 */
  support_email?: string | undefined
  /** WP424：邮件营销用的哪一家（人说的原话）。不给 = 不改；给空串 = 清空。 */
  email_service?: string | undefined
  /** WP248（决策 83）：币种（三位字母，存大写）。不给 = 不改；给空串 = 清空（读时按 USD）。 */
  currency?: string | undefined
  /** WP335（决策 659）：品类（品牌分析时 AI 填、人可改）。不给 = 不改；给空串 = 清空。 */
  category?: string | undefined
  /** WP452：卖的是实物 / App / 别的数字产品。不给 = 不改；给空串 = 清空（= 不知道）。 */
  offering?: BrandOffering | '' | undefined
  /*
   * WP346（决策 872）：品牌档案第二版那几格。不给 = 不改；空串 / `null` / 空数组 = 清空。
   * 从 HTTP 来的值一律算人给的（拿掉「AI 建议」标）。
   */
  subcategory?: string | undefined
  positioning?: string | undefined
  price_band?: string | undefined
  audience?: BrandAudience | null | undefined
  keywords?: BrandKeywords | null | undefined
  competitors?: BrandCompetitor[] | undefined
  /** WP346：人点了「对」的那几格（值不变，只拿掉「AI 建议」标）。 */
  confirm_fields?: BrandInsightField[] | undefined
  /** WP346：服务端内部用（品牌分析确认 / 采纳）：这一次哪几格是 AI 建议的。HTTP 不收。 */
  ai_suggested?: BrandInsightField[] | undefined
  /** WP346：服务端内部用：品牌分析读的那个官网。HTTP 不收。 */
  website?: string | undefined
}

/** 公司档案的对外形状。**没有归一化哈希**——它是发现用的，不是给人看的。 */
export interface WorkspaceProfileView {
  legal_name: string
  domain?: string
  discoverable: boolean
  /** WP65（52 O1）：这个工作区的品牌名（没设过就等于工作区名）。 */
  brand_name: string
  /** 48 v2 L2：你卖的是实物商品 / 虚拟产品与服务。缺省 = `goods`。 */
  vertical: 'goods' | 'digital'
  /** WP62（51 §1 N0）：网站是用什么搭的。缺省 = `shopify`。 */
  storefront_platform: StorefrontPlatform
  /** WP166：目标市场（ISO 国家码，大写）。没写过就没有。 */
  markets?: string[]
  /** WP166：这份市场是从哪看出来的（界面问号里那一句）。 */
  markets_source?: MarketsSource
  /** WP169：按市场覆盖的探测语言（没覆盖过就没有）。 */
  market_languages?: Record<string, string>
  /** WP176：公司实体地址（没填过就没有）。 */
  postal_address?: string
  /** WP248（决策 83）：品牌一句话介绍（没写过就没有）。 */
  one_liner?: string
  /** WP248（决策 83）：客服邮箱（没写过就没有）。 */
  support_email?: string
  /** WP424：邮件营销用的哪一家（没写过就没有）。 */
  email_service?: string
  /** WP248（决策 83）：币种。服务端总会给——没写过就是 `USD`（`DEFAULT_BRAND_CURRENCY`）。 */
  currency?: string
  /** WP335（决策 659）：品类（没写过就没有）。 */
  category?: string
  /** WP452：卖的是实物 / App / 别的数字产品（没填过就没有 = 不知道）。 */
  offering?: BrandOffering
  /** WP346：第二版那几格（没写过就没有）。 */
  subcategory?: string
  positioning?: string
  price_band?: string
  audience?: BrandAudience
  keywords?: BrandKeywords
  competitors?: BrandCompetitor[]
  /** WP346：品牌分析读的那个官网（「重新分析一次」默认用它）。 */
  website?: string
  /** WP346：哪几格还是 AI 建议（人没改、没点过「对」）。 */
  ai_suggested?: BrandInsightField[]
  set_at: string
}

/** 「你卖的是」那一步的选项：中文名 + 一句人话（进 tooltip）。 */
export interface VerticalChoiceView {
  key: 'goods' | 'digital'
  label: string
  hint: string
}

/**
 * WP62（51 §1 N0）：「网站是用什么搭的」那一步的四个选项。
 *
 * `supported: false` 的**照样发下来**——界面要把它们灰显并标"待增加"，
 * 而不是藏起来：用户得看得见"下一个是谁"，也才知道自己那套现在接不上。
 * 真源是契约里的 `STOREFRONT_PLATFORMS`，界面不自己写第二份清单。
 */
export interface StorefrontPlatformChoiceView {
  key: StorefrontPlatform
  label: string
  supported: boolean
  /** 灰显那几个的 tooltip 文案（"待增加"那一句）；能选的没有它。 */
  hint?: string
}

/**
 * `GET /v1/onboarding/state`。
 *
 * `needs_setup` 的判据只有两条（46 §1 末段「向导只出现在这个工作区还没设过公司名的时候」）：
 * 公司档案没设过，**并且**除了所有者自己那条之外还没有任何分配。第二条是给
 * 「已经用起来了但当初跳过了向导」的工作区留的——它不该在第 100 天被弹一次向导。
 */
export interface OnboardingStateView {
  needs_setup: boolean
  /** 工作区名字（人话，不是 id）。 */
  workspace_name: string
  /** WP65（52 O1）：当前这个品牌叫什么（没设过就等于工作区名）。 */
  brand_name: string
  profile?: WorkspaceProfileView
  /** 当前这个人的名字与登录邮箱（向导第 ② 步直接带出来）。 */
  person: { name: string; email: string }
  /** 本工作区现在有几条有效分配（不含所有者那条）。 */
  other_assignments: number
  /** 这个人是不是所有者——不是的话向导里不出"公司档案"与"邀请码"。 */
  is_owner: boolean
  /**
   * 局域网发现这台机器上能不能用；不能用时 `reason` 是一句人话。
   * WP422：开关关着时不去试（试一下就要在网卡上绑口），所以 `available: false` 只代表「试过、起不来」。
   */
  discovery: { available: boolean; enabled: boolean; reason?: string }
  /**
   * WP54（48 v2 L2 / 46 §1）：「你卖的是」那两个选项与各自的一句人话。
   * 从客服共享包的垂直包读，界面上不再自己写一份文案。
   */
  verticals: VerticalChoiceView[]
  /**
   * WP62（51 §1 N0 / 46 §1）：「网站是用什么搭的」四个选项（含灰显的那三个）。
   * 真源是契约里的 `STOREFRONT_PLATFORMS`。
   */
  storefront_platforms: StorefrontPlatformChoiceView[]
  /**
   * WP240：这是公司**加的**品牌（不是第一个品牌），而且公司那一层已经设过——
   * 向导里公司级的（公司全称、你的称呼）不再问，从第 ② 步开始。第一个品牌没有这一位。
   */
  added_brand?: true
  /**
   * WP240：**这个品牌**现在有没有能用的 AI（跟随公司默认的算公司那一份）。
   * 加的品牌接上了就把第 ① 步显示成「已接上（跟随公司）」直接过。
   */
  model_configured?: boolean
  /**
   * WP244：这个品牌的第 ② 步「你的生意」**已经做过**（档案有人确认 / 存过，不是建品牌时自动起的那份）。
   * 向导重新打开（重新登录、刷新）时据此从第 ③ 步接着走，第 ② 步打勾——不再从第 ② 步重来。
   */
  business_done?: true
}

/** 向导第 ③ 步的候选：岗位与它包含的职责。 */
export interface OnboardingPositionView {
  id: string
  name: string
  /** WP234（Luoye 10-06）：公司改过这个类别的名字时，出厂名（界面小字附后）；没改过就没有。 */
  factory_name?: string
  /** WP213：岗位图标（工作台 `role-icons/glyphs.ts` 里的 id）。 */
  icon?: string
  roles: {
    id: string
    name: string
    default: boolean
    what_it_does: string
    /** WP171：第二批的职责（`status: planned`），向导里标「第二批」。 */
    planned?: true
  }[]
}

/** 清单里的一条"要连的平台"。 */
export interface OnboardingConnectorItem {
  /** 连接目录里的 provider id（点进去就是连接页那张卡）。 */
  service: string
  label: string
  required: boolean
  connected: boolean
  /** 哪几条职责要它（说人话，用职责名）。 */
  needed_by: string[]
}

/** 清单里的一条"要装的技能包"。 */
export interface OnboardingSkillItem {
  name: string
  installed: boolean
  needed_by: string[]
}

/** 清单里的一条"要建的岗位"。 */
export interface OnboardingPositionPlanItem {
  /** 勾的岗位 id；只勾职责时是 `custom`。 */
  position_id: string
  name: string
  role_ids: string[]
  /** 已经持有这个岗位了（重复走向导时不再建第二份）。 */
  already_held: boolean
}

export interface OnboardingPlanInput {
  position_ids: string[]
  role_ids: string[]
  /** 只勾职责时这个自定义岗位叫什么；不给就是"我的岗位"。 */
  custom_position_name?: string | undefined
  /**
   * WP234（docs/54 §6.2）：第 ③ 步的产出——**岗位清单**（名字 + 职责）。
   * 给了它，上面三格就不看了：岗位按这份建（带 `template_id` 且职责全在那个模板里就复用它），
   * 每条新分配安放在它所在的那个岗位上。不给 = 老算法，结果与以前逐字相同。
   */
  positions?: OnboardingPlannedPosition[] | undefined
}

/** WP234：第 ③ 步岗位清单里的一行。 */
export interface OnboardingPlannedPosition {
  name: string
  role_ids: string[]
  /** 从哪个类别（岗位模板）来的；职责全在那个模板里时复用它。 */
  template_id?: string | undefined
}

/** WP234（docs/70 §5）：「说说你要做什么工作」。 */
export interface OnboardingSuggestInput {
  /** 他自己写的那段话（经验、接下来要做的事都行），最多 2000 字。 */
  text: string
}

/**
 * WP234：AI 推荐的职责（每条一句理由，引用原话里的依据）+ 岗位划分建议。
 *
 * **推荐不是选中**：界面上一条都不预勾。`source: 'keyword'` = 这次没用 AI（没接上能用的模型 /
 * 模型没按格式回话），按原话对词，`note` 照实说（Luoye 10-06：演示与真环境同一套）。
 * `unavailable` = 原话是空的。`stub` 已不再产出，留着只为契约只加不删。
 */
export interface OnboardingSuggestView {
  source: 'ai' | 'keyword' | 'stub' | 'unavailable'
  note?: string
  roles: { role_id: string; reason: string; quote?: string }[]
  positions: OnboardingPlannedPosition[]
}

/**
 * 向导第 ④ 步那张清单。
 *
 * `model_first` 为真时清单第一条固定是"接模型"——一个模型都没接的话，
 * 连上再多平台也没人替你干活（36 首页那条黄条说的就是这件事）。
 */
export interface OnboardingPlanView {
  connectors: OnboardingConnectorItem[]
  skills: OnboardingSkillItem[]
  positions: OnboardingPositionPlanItem[]
  model_configured: boolean
  model_first: boolean
  /** 展开后一共几条职责（勾岗位 = 该岗位职责全勾，前后端同一套算法）。 */
  role_ids: string[]
  /**
   * WP216（Luoye 10-05）：这个品牌的平台有官方 CLI、并且勾的职责里有要用它的——向导最后问一句
   * 「建站岗位会用到 Shopify CLI，要现在装吗？」。平台不对 / 没勾那几条职责就没有这一格。
   */
  platform_cli?: OnboardingPlatformCliItem
  /**
   * WP360（决策 947）：勾的职责里有要浏览器插件的（职责定义的 `browser_extension` 推出来）——第 ④ 步把
   * 「装插件 + 配对」放在最前。没有就没有这一格。
   */
  extension?: OnboardingExtensionItem
}

/** WP360：第 ④ 步最前那一项「装插件 + 配对」。 */
export interface OnboardingExtensionItem {
  /** 拿插件做哪几样（界面按它说一句为什么）。 */
  uses: BrowserExtensionUse[]
  /** 哪几条职责要它（职责中文名，不出 id）。 */
  needed_by: string[]
  /** 这个品牌已经有一个插件配上了。 */
  paired: boolean
}

/** WP216：向导最后那一句提示要的几格（来自 `PLATFORM_KITS` 那一行，界面不写平台名）。 */
export interface OnboardingPlatformCliItem {
  /** CLI 的 id（`shopify-cli`）。 */
  id: string
  /** 卡上的名字（「Shopify CLI」）。 */
  label: string
  /** 入口：哪个岗位页上有那张卡。 */
  position_id: string
  /** 教程 slug。 */
  tutorial: string
}

/** `POST /v1/onboarding/apply` 的回执。 */
export interface OnboardingApplyView {
  /** 真建出来的分配（人 × 职责 × 范围）。 */
  created_assignments: { id: string; role_id: string; role_name: string }[]
  /** 已经持有、这次没重复建的。 */
  skipped: string[]
  /** 挂上的范围；连上 Shopify 就是那家店，没连就是空（46 I6 要在面板明说）。 */
  ranges: { kind: string; id: string; label: string }[]
  plan: OnboardingPlanView
  /** WP234：按岗位清单建（或复用）的岗位。只有给了 `positions` 时才有。 */
  positions?: { id: string; name: string; role_ids: string[] }[]
}

/** 46 §2 I3：局域网上看见的一位同伴。 */
export interface DiscoveryPeerView {
  peer_id: string
  /** 对方 `/v1/discovery/hello` 自己报的展示名（"王岚的工作区 · 3 人"）。 */
  workspace_label: string
  host: string
  port: number
  first_seen_at: string
  last_seen_at: string
}

export interface DiscoveryStateView {
  /** false = 试过、起不来（WP422：开关关着时不去试，没试过就回 true）。 */
  available: boolean
  enabled: boolean
  reason?: string
  peers: DiscoveryPeerView[]
}

/** 对方打过来问"你是谁"时我们回的那一点点东西。 */
export interface DiscoveryHelloView {
  peer_id: string
  workspace_label: string
  members: number
}

export interface InviteView {
  code: string
  expires_at: string
  uses_left: number
  created_at: string
}

export interface MembershipRequestView {
  id: string
  person: { name: string; email: string }
  via: MembershipRequestVia
  status: 'pending' | 'approved' | 'rejected' | 'superseded'
  created_at: string
  decided_at?: string
  /** WP276：谁定的（② 里任何一位同事都能定）。 */
  decided_by?: string
  superseded_reason?: string
  /** 同意后那张审批卡的 id（界面上"去队列里看"）。 */
  approval_item_id?: string
}

export interface MembershipRequestInput {
  /** 贴进来的邀请码；与 `peer_id` 二选一。 */
  code?: string | undefined
  /** 局域网上挑中的那位同伴；与 `code` 二选一。 */
  peer_id?: string | undefined
  name: string
  email: string
  /**
   * **机器之间**用的那一半：申请人的服务进程把请求转给同伴时带上自己算出的公司钥匙，
   * 收件端拿它比一比"我们是不是同一家"。它是哈希，不泄漏公司全称；
   * 人从界面上永远填不到它（界面填的是 `peer_id`）。
   */
  company_key?: string | undefined
  /** 转发方自己的 peer id（46 I3 要知道"这条申请是谁递过来的"）。 */
  from_peer?: string | undefined
  /**
   * WP427：这一条是经「团队门」从别的电脑来的（`lan` / `cloud`）。门外来的只收（码对得上 / 局域网那条
   * 带公司钥匙），**不替对方往外转**——否则门外的人能借这台电脑去敲局域网里别人的门、去问云。
   * 经云来的只认邀请码（公司钥匙是公司名的哈希，猜得出来）。人从界面上填不到它。
   */
  via_door?: 'lan' | 'cloud' | undefined
  /**
   * WP427：申请人那台机器发的「票」的哈希（`sha256(票)`）。批了之后申请人拿票本身来
   * `POST /v1/memberships/requests/:id/claim` 换一次性登录——不用再走邮箱验证码。
   * 人从界面上填不到它（只有服务进程之间转申请时带）。
   */
  ticket_hash?: string | undefined
}

/** WP427：同事怎么连进来（「和同事一起用」那一块的状态行）。 */
export interface TeamLinkView {
  /** 现在开着没有（打开了「和同事一起用」，或者这里不止一个人）。 */
  open: boolean
  /** 同一个网络里的快路。 */
  lan: { on: boolean; url?: string; reason?: string }
  /**
   * 不在同一个网络时：经工坊云的通道。`needs_account` = 这台电脑还没登录工坊账号；
   * WP444：`needs_subscription` = 跨网通道是增值服务、这个组织还没开通 / 已到期；`blocked` = 被运营停用。
   */
  cloud: {
    state:
      | 'stopped'
      | 'needs_account'
      | 'needs_subscription'
      | 'blocked'
      | 'registering'
      | 'connecting'
      | 'online'
      | 'backoff'
      | 'unavailable'
    url?: string
    reason?: string
  }
  /** 邀请链接用哪个地址开头（没有 = 只给码）。 */
  invite_base?: string
}

/**
 * WP444：团队通道这项增值服务在本机看到的样子（跨网那条路要开通；同一个网络照常免费）。
 * 没关联工坊账号：`linked: false` + 一句人话（界面上就地给登录）；云连不上：`reason`。
 */
export interface TeamSubscriptionLocalView {
  linked: boolean
  /** 云上那一份（连上了才有）。 */
  subscription?: TeamSubscriptionView
  /** 没关联 / 云连不上 / 这个节点没开通时的一句人话。 */
  reason?: string
}

/** WP427：我递出去的申请（加入别人那边）。 */
export interface TeamJoinView {
  id: string
  /** 对方自报的展示名。 */
  workspace_label: string
  /**
   * WP444：`channel_off` = 经云的那条路被关了——对方的团队通道没开通 / 已到期（同一个网络里照常能用）。
   */
  status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'superseded'
    | 'left'
    | 'unreachable'
    | 'channel_off'
  via: 'lan' | 'cloud'
  created_at: string
  /** 批了：能直接点「打开」。 */
  can_enter: boolean
}

export interface MembershipClaimRequest {
  ticket: string
  /** 要不要顺手换一张一次性登录（不给 = 只问状态）。 */
  login?: boolean | undefined
}

/** 46 I3：对方说"我这边已经定了，你那条别等了"。 */
export interface SupersedeInput {
  peer_id: string
  company_key: string
  reason?: string | undefined
}

export interface OnboardingPort {
  state(actor: OnboardingActor): MaybePromise<OnboardingStateView>
  setProfile(
    actor: OnboardingActor,
    input: WorkspaceProfileInput,
  ): MaybePromise<WorkspaceProfileView>
  /** 向导第 ③ 步的候选（岗位 → 职责 + 每条一句"它会干什么"）。 */
  positions(actor: OnboardingActor): MaybePromise<OnboardingPositionView[]>
  plan(actor: OnboardingActor, input: OnboardingPlanInput): MaybePromise<OnboardingPlanView>
  apply(actor: OnboardingActor, input: OnboardingPlanInput): MaybePromise<OnboardingApplyView>
  /** WP234：「说说你要做什么工作」→ 推荐 + 岗位划分建议。可选：没装的宿主回 501。 */
  suggest?(
    actor: OnboardingActor,
    input: OnboardingSuggestInput,
  ): MaybePromise<OnboardingSuggestView>
  /** 46 §2 I2：局域网同伴。开关关着时 `peers` 是空的，且不发一个包。 */
  peers(actor: OnboardingActor): MaybePromise<DiscoveryStateView>
  /** 同伴打过来问"你是谁"。**公开**——对方这会儿在我们这里还什么都不是。 */
  hello(): MaybePromise<DiscoveryHelloView>
  invites(actor: OnboardingActor): MaybePromise<InviteView[]>
  createInvite(
    actor: OnboardingActor,
    input: { uses?: number | undefined },
  ): MaybePromise<InviteView>
  requests(actor: OnboardingActor): MaybePromise<MembershipRequestView[]>
  /** **公开**：申请人这会儿在目标工作区里还没有任何凭据，只有一个邀请码或一个同伴地址。 */
  request(input: MembershipRequestInput): MaybePromise<MembershipRequestView>
  decideRequest(
    actor: OnboardingActor,
    id: string,
    input: { approve: boolean; reason?: string | undefined },
  ): MaybePromise<MembershipRequestView>
  /** **公开**：同伴的服务进程告诉我们"先批的那一边已经定了"。 */
  superseded(input: SupersedeInput): MaybePromise<{ voided: number }>
  /** WP427 **公开**：申请人拿票来问批了没有（批了可以换一次性登录）。没装回 501。 */
  claim?(id: string, input: MembershipClaimRequest): MaybePromise<MembershipClaimView>
  /** WP427：同事怎么连进来。 */
  teamLink?(actor: OnboardingActor): MaybePromise<TeamLinkView>
  /** WP427：我递出去的申请（顺手问一遍对方批了没有）。 */
  joins?(actor: OnboardingActor): MaybePromise<TeamJoinView[]>
  /** WP427：批了的那一条：换一个带一次性登录的地址（在浏览器里打开就进去了）。 */
  enterJoin?(actor: OnboardingActor, id: string): MaybePromise<{ url: string }>
  /** WP444：团队通道订阅现在怎样（问云；人数顺手报上去）。 */
  teamSubscription?(actor: OnboardingActor): MaybePromise<TeamSubscriptionLocalView>
  /** WP444：开通（没用过试用 = 7 天试用）/ 续费。 */
  subscribeTeam?(actor: OnboardingActor): MaybePromise<TeamSubscriptionLocalView>
  /** WP444：取消（当期 / 试用用完为止）。 */
  cancelTeam?(actor: OnboardingActor): MaybePromise<TeamSubscriptionLocalView>
}

// ── 校验 ───────────────────────────────────────────────────────────────

/** WP346：可以点「对」的那几格（与契约 `BRAND_INSIGHT_FIELDS` 同一组）。 */
const INSIGHT_FIELDS = [
  'category',
  'subcategory',
  'positioning',
  'price_band',
  'audience',
  'keywords',
  'competitors',
] as const satisfies readonly BrandInsightField[]

/** zod 的可选字段在 exactOptionalPropertyTypes 下是 `T | undefined`——去掉没给的那几个键。 */
function stripUndefined<T extends object>(v: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as never
}

const ProfileBody = z.object({
  legal_name: z.string().min(1).max(200),
  domain: z.string().max(253).optional(),
  discoverable: z.boolean().optional(),
  // WP54（48 v2 L2）：你卖的是实物商品 / 虚拟产品与服务。不给 = 不改。
  vertical: z.enum(['goods', 'digital']).optional(),
  // WP62（51 §1 N0）：网站是用什么搭的。不给 = 不改（第一次不给就是 Shopify）。
  storefront_platform: z.enum(['shopify', 'woocommerce', 'magento', 'other', 'none']).optional(),
  // WP65（52 O4）：第 ① 步下半块「第一个品牌」的名字。不给 = 不改。
  brand_name: z.string().min(1).max(64).optional(),
  // WP166：目标市场（两位国家码；服务端再按国家码清单归一化）。不给 = 不改；给空数组 = 清空。
  markets: z
    .array(z.string().regex(/^[A-Za-z]{2}$/))
    .max(60)
    .optional(),
  // WP169：按市场覆盖探测语言（国家码 → 语言码）。不给 = 不改；给空对象 = 清空。
  market_languages: z
    .record(
      z.string().regex(/^[A-Za-z]{2}$/),
      z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
    )
    .optional(),
  // WP176：公司实体地址。不给 = 不改；空串 = 清空。
  postal_address: z.string().max(500).optional(),
  // WP248（决策 83）：品牌三格。不给 = 不改；空串 = 清空（邮箱不像邮箱回 400；币种服务端存大写）
  one_liner: z.string().max(300).optional(),
  support_email: z
    .union([z.literal(''), z.string().trim().max(254).email('这不像一个邮箱')])
    .optional(),
  currency: z
    .string()
    .regex(/^([A-Za-z]{3})?$/)
    .optional(),
  // WP335（决策 659）：品类。不给 = 不改；空串 = 清空
  category: z.string().max(80).optional(),
  // WP452：卖的是实物 / App / 别的数字产品。不给 = 不改；空串 = 清空
  offering: z.enum(['physical', 'app', 'digital', '']).optional(),
  // WP424：邮件营销用的哪一家。不给 = 不改；空串 = 清空
  email_service: z.string().max(60).optional(),
  // WP346（决策 872）：第二版那几格。不给 = 不改；空串 / null / 空数组 = 清空
  subcategory: z.string().max(80).optional(),
  positioning: z.string().max(800).optional(),
  price_band: z.string().max(60).optional(),
  audience: z
    .object({
      buyers: z.string().max(400),
      payer: z.string().max(200).optional(),
      concerns: z.array(z.string().max(120)).max(6).optional(),
    })
    .nullable()
    .optional(),
  keywords: z
    .object({
      brand: z.array(z.string().max(60)).max(20),
      category: z.array(z.string().max(60)).max(20),
      scenario: z.array(z.string().max(60)).max(20),
    })
    .nullable()
    .optional(),
  competitors: z
    .array(
      z.object({
        name: z.string().max(80),
        reason: z.string().max(200),
        url: z.string().max(300).optional(),
        // WP349：联网查到的来源（设置页保存时原样带回，不然一改就丢）
        sources: z
          .array(z.object({ url: z.string().max(500), title: z.string().max(200).optional() }))
          .max(6)
          .optional(),
      }),
    )
    .max(12)
    .optional(),
  confirm_fields: z.array(z.enum(INSIGHT_FIELDS)).max(10).optional(),
})

const PlannedPositionBody = z.object({
  name: z.string().min(1).max(64),
  role_ids: z.array(z.string().min(1).max(64)).min(1).max(30),
  template_id: z.string().min(1).max(64).optional(),
})

const PlanBody = z.object({
  position_ids: z.array(z.string().min(1).max(64)).max(50).default([]),
  role_ids: z.array(z.string().min(1).max(64)).max(200).default([]),
  custom_position_name: z.string().min(1).max(64).optional(),
  // WP234：岗位清单（给了就按它建）
  positions: z.array(PlannedPositionBody).max(30).optional(),
})

const SuggestBody = z.object({ text: z.string().min(1).max(2000) })

const InviteBody = z.object({ uses: z.number().int().min(1).max(50).optional() })

const RequestBody = z
  .object({
    code: z.string().min(4).max(32).optional(),
    peer_id: z.string().min(1).max(128).optional(),
    name: z.string().min(1).max(64),
    email: z.string().min(3).max(254),
    // 机器之间转发时带的那两样（界面永远不填）
    company_key: z.string().min(16).max(128).optional(),
    from_peer: z.string().min(1).max(128).optional(),
    // WP427：申请人那台机器的票的哈希（sha256 十六进制）
    ticket_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine((v) => v.code !== undefined || v.peer_id !== undefined || v.company_key !== undefined, {
    message: '要么贴一个邀请码，要么挑一位局域网上的同伴',
  })

const ClaimBody = z.object({
  ticket: z.string().min(16).max(200),
  login: z.boolean().optional(),
})
const SupersedeBody = z.object({
  peer_id: z.string().min(1).max(128),
  company_key: z.string().min(16).max(128),
  reason: z.string().min(1).max(200).optional(),
})

const DecideBody = z.object({
  approve: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
})

// ── 装配 ───────────────────────────────────────────────────────────────

function portOf(deps: GatewayDeps): OnboardingPort {
  const p = deps.onboarding
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配首次设置面（GatewayDeps.onboarding）',
    )
  return p
}

type Ctx = Parameters<typeof principalOf>[0]

function actorOf(c: Ctx): OnboardingActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

export function onboardingRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/onboarding/state',
        operationId: 'getOnboardingState',
        summary: '要不要走首次设置向导（46 §1：公司档案没设过 + 除所有者外没有分配）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // 读"我这个工作区要不要走向导"是读自己的绑定：普通成员也该看得到，
        // 否则他登录后永远进不了那四步（31 §3.1 的自助豁免）。
        authzBypass: () => true,
        returns: 'OnboardingStateView',
      },
      async (c, deps) => ok(c, await portOf(deps).state(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/workspace/profile',
        operationId: 'setWorkspaceProfile',
        summary:
          '写第 ① 步：公司（全称 / 域名 / 发现开关 → 组织）+ 这个品牌（品牌名 / 你卖的是 / 网站平台）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        authzBypass: holdsOwnerWrite,
        body: ProfileBody,
        returns: 'WorkspaceProfileView（**不含**归一化哈希）',
      },
      async (c, deps) => {
        const input = await body(c, ProfileBody)
        return ok(
          c,
          await portOf(deps).setProfile(actorOf(c), {
            legal_name: input.legal_name,
            ...(input.domain === undefined ? {} : { domain: input.domain }),
            ...(input.discoverable === undefined ? {} : { discoverable: input.discoverable }),
            ...(input.vertical === undefined ? {} : { vertical: input.vertical }),
            ...(input.storefront_platform === undefined
              ? {}
              : { storefront_platform: input.storefront_platform }),
            ...(input.brand_name === undefined ? {} : { brand_name: input.brand_name }),
            ...(input.markets === undefined ? {} : { markets: input.markets }),
            ...(input.market_languages === undefined
              ? {}
              : { market_languages: input.market_languages }),
            // WP176：公司实体地址（不给 = 不改；空串 = 清空）
            ...(input.postal_address === undefined ? {} : { postal_address: input.postal_address }),
            // WP248（决策 83）：品牌一句话 / 客服邮箱 / 币种（不给 = 不改；空串 = 清空）
            ...(input.one_liner === undefined ? {} : { one_liner: input.one_liner }),
            ...(input.support_email === undefined ? {} : { support_email: input.support_email }),
            ...(input.currency === undefined ? {} : { currency: input.currency }),
            ...(input.category === undefined ? {} : { category: input.category }),
            ...(input.offering === undefined ? {} : { offering: input.offering }),
            ...(input.email_service === undefined ? {} : { email_service: input.email_service }),
            // WP346（决策 872）：第二版那几格 + 人点了「对」的那几格
            ...(input.subcategory === undefined ? {} : { subcategory: input.subcategory }),
            ...(input.positioning === undefined ? {} : { positioning: input.positioning }),
            ...(input.price_band === undefined ? {} : { price_band: input.price_band }),
            ...(input.audience === undefined
              ? {}
              : { audience: input.audience === null ? null : stripUndefined(input.audience) }),
            ...(input.keywords === undefined ? {} : { keywords: input.keywords }),
            ...(input.competitors === undefined
              ? {}
              : {
                  competitors: input.competitors.map(({ sources, ...c }) => ({
                    ...stripUndefined(c),
                    ...(sources === undefined
                      ? {}
                      : { sources: sources.map((x) => stripUndefined(x)) }),
                  })),
                }),
            ...(input.confirm_fields === undefined ? {} : { confirm_fields: input.confirm_fields }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/onboarding/positions',
        operationId: 'listOnboardingPositions',
        summary: '向导第 ③ 步的候选：岗位、它包含的职责、每条一句"它会干什么"（27）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        returns: 'OnboardingPositionView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).positions(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/onboarding/plan',
        operationId: 'planOnboarding',
        summary: '勾选 → 要连的平台 / 要装的技能 / 要建的岗位（46 §3 I5，只算不写）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        body: PlanBody,
        returns: 'OnboardingPlanView',
      },
      async (c, deps) => {
        const input = await body(c, PlanBody)
        return ok(c, await portOf(deps).plan(actorOf(c), planInput(input)))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/onboarding/suggest',
        operationId: 'suggestOnboarding',
        summary:
          '「说说你要做什么工作」→ AI 推荐职责（每条带理由）+ 岗位划分建议（只推荐，不选中）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        body: SuggestBody,
        returns: 'OnboardingSuggestView',
      },
      async (c, deps) => {
        const input = await body(c, SuggestBody)
        const port = portOf(deps)
        if (port.suggest === undefined)
          throw new ApiError('not_implemented', '这个服务进程不支持 AI 推荐职责')
        return ok(c, await port.suggest(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/onboarding/apply',
        operationId: 'applyOnboarding',
        summary: '真建分配（46 §3 I6：一个岗位一条 Assignment；只勾职责 → 一个自定义岗位）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        authzBypass: holdsOwnerWrite,
        body: PlanBody,
        returns: 'OnboardingApplyView',
      },
      async (c, deps) => {
        const input = await body(c, PlanBody)
        return ok(c, await portOf(deps).apply(actorOf(c), planInput(input)), 201)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/discovery/peers',
        operationId: 'listDiscoveryPeers',
        summary: '局域网上同一家公司的同伴（46 §2 I2；开关关着时永远是空的）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        returns: 'DiscoveryStateView',
      },
      async (c, deps) => ok(c, await portOf(deps).peers(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/discovery/hello',
        operationId: 'discoveryHello',
        summary: '同伴问"你是谁"：只回一个展示名与人数（46 §2：全称与名单永不出去）',
        tag: TAG,
        // 公开：对方这会儿在我们这里还没有任何凭据。回的东西也只值这么多。
        auth: 'public',
        returns: 'DiscoveryHelloView',
      },
      async (c, deps) => ok(c, await portOf(deps).hello()),
    ),
    route(
      {
        method: 'get',
        path: '/v1/invites',
        operationId: 'listInvites',
        summary: '这个工作区还没过期的邀请码（46 §2 I2）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // WP276：② 同事互联里平级同事也能用
        authzBypass: peersBypass,
        returns: 'InviteView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).invites(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/invites',
        operationId: 'createInvite',
        summary: '发一个邀请码：8 位人类可读、24h、默认 5 次（owner）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        // WP276：② 同事互联里平级同事也能用
        authzBypass: peersBypass,
        body: InviteBody,
        returns: 'InviteView（明文码只在这一次出现）',
      },
      async (c, deps) => {
        const input = await body(c, InviteBody)
        return ok(
          c,
          await portOf(deps).createInvite(actorOf(c), input.uses === undefined ? {} : input),
          201,
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/memberships/requests',
        operationId: 'listMembershipRequests',
        summary: '谁申请过加入这个工作区（46 §2 I3）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // WP276：② 同事互联里平级同事也能用
        authzBypass: peersBypass,
        returns: 'MembershipRequestView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).requests(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/memberships/requests',
        operationId: 'requestMembership',
        summary: '申请加入：贴邀请码或挑一位局域网同伴 → 对方 owner 收一张 membership 卡',
        tag: TAG,
        // 公开：申请人在目标工作区里还什么都不是，只有一个码或一个地址（与接受邀请同理）。
        auth: 'public',
        body: RequestBody,
        returns: 'MembershipRequestView（`status: pending`——批了才算数）',
      },
      async (c, deps) => {
        const input = await body(c, RequestBody)
        return ok(
          c,
          await portOf(deps).request({
            name: input.name,
            email: input.email,
            ...(input.code === undefined ? {} : { code: input.code }),
            ...(input.peer_id === undefined ? {} : { peer_id: input.peer_id }),
            ...(input.company_key === undefined ? {} : { company_key: input.company_key }),
            ...(input.from_peer === undefined ? {} : { from_peer: input.from_peer }),
            ...(input.ticket_hash === undefined ? {} : { ticket_hash: input.ticket_hash }),
            ...(() => {
              const door = c.req.header(TEAM_DOOR_HEADER)
              return door === 'lan' || door === 'cloud' ? { via_door: door } : {}
            })(),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/discovery/superseded',
        operationId: 'supersedeMembershipRequests',
        summary: '同伴说"先批的那一边已经定了"：与他之间还悬着的申请一律作废（46 I3）',
        tag: TAG,
        // 公开，但要带上同一把公司钥匙才作数；而且它只作废「还悬着的申请」，
        // 不删任何数据、不动任何成员——最坏情况是申请人再点一次。
        auth: 'public',
        body: SupersedeBody,
        returns: '{ voided }',
      },
      async (c, deps) => {
        const input = await body(c, SupersedeBody)
        return ok(
          c,
          await portOf(deps).superseded({
            peer_id: input.peer_id,
            company_key: input.company_key,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/memberships/requests/:id/claim',
        operationId: 'claimMembershipRequest',
        summary: 'WP427：申请人拿票来问批了没有；批了换一张一次性登录（不用走邮箱验证码）',
        tag: TAG,
        // 公开：申请人这会儿在这里还没有会话，只有申请时那张票。票不对一律 404（不说有没有这条）
        auth: 'public',
        params: [{ name: 'id', in: 'path', required: true, description: '申请 id（对方那边的）' }],
        body: ClaimBody,
        returns: 'MembershipClaimView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.claim === undefined)
          throw new ApiError('not_implemented', '这个服务不支持用申请票换登录')
        const input = await body(c, ClaimBody)
        return ok(
          c,
          await port.claim(param(c, 'id'), {
            ticket: input.ticket,
            ...(input.login === undefined ? {} : { login: input.login }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/team/link',
        operationId: 'getTeamLink',
        summary: 'WP427：同事怎么连进来——局域网那条路、经工坊云那条路、邀请链接用哪个地址',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        returns: 'TeamLinkView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.teamLink === undefined)
          throw new ApiError('not_implemented', '这个服务没有团队通道')
        return ok(c, await port.teamLink(actorOf(c)))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/team/joins',
        operationId: 'listTeamJoins',
        summary: 'WP427：我递出去的申请（加入别人那边），顺手问一遍对方批了没有',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        returns: 'TeamJoinView[]',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.joins === undefined) return ok(c, [])
        return ok(c, await port.joins(actorOf(c)))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/team/subscription',
        operationId: 'getTeamSubscription',
        summary:
          'WP444：团队通道（跨网那条路）这项增值服务现在怎样——没开 / 试用剩几天 / 已开 / 宽限 / 已关、当前人数档与价钱',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        returns: 'TeamSubscriptionLocalView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.teamSubscription === undefined)
          throw new ApiError('not_implemented', '这个服务没有团队通道')
        return ok(c, await port.teamSubscription(actorOf(c)))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/team/subscription',
        operationId: 'subscribeTeam',
        summary:
          'WP444：开通团队通道（没用过试用 = 7 天免费试用，试用完按人数档每月扣积分）/ 到期后续费',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        authzBypass: peersBypass,
        returns: 'TeamSubscriptionLocalView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.subscribeTeam === undefined)
          throw new ApiError('not_implemented', '这个服务没有团队通道')
        return ok(c, await port.subscribeTeam(actorOf(c)))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/team/subscription',
        operationId: 'cancelTeamSubscription',
        summary: 'WP444：取消团队通道（当期或试用用完为止；同一个网络里照常能用）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        authzBypass: peersBypass,
        returns: 'TeamSubscriptionLocalView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.cancelTeam === undefined)
          throw new ApiError('not_implemented', '这个服务没有团队通道')
        return ok(c, await port.cancelTeam(actorOf(c)))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/team/joins/:id/enter',
        operationId: 'enterTeamJoin',
        summary: 'WP427：批了的那一条——换一个带一次性登录的地址（浏览器里打开就进去了）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        authzBypass: () => true,
        params: [{ name: 'id', in: 'path', required: true, description: '我这边记的申请 id' }],
        returns: '{ url }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.enterJoin === undefined)
          throw new ApiError('not_implemented', '这个服务没有团队通道')
        return ok(c, await port.enterJoin(actorOf(c), param(c, 'id')))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/memberships/requests/:id/decide',
        operationId: 'decideMembershipRequest',
        summary: '同意 / 拒绝一条申请（owner）；同意后建成员并交给 20 §4 Join',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        // WP276：② 同事互联里平级同事也能用
        authzBypass: peersBypass,
        params: [{ name: 'id', in: 'path', required: true, description: '申请 id' }],
        body: DecideBody,
        returns: 'MembershipRequestView',
      },
      async (c, deps) => {
        const input = await body(c, DecideBody)
        return ok(
          c,
          await portOf(deps).decideRequest(actorOf(c), param(c, 'id'), {
            approve: input.approve,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          }),
        )
      },
    ),
  ]
}

function planInput(input: z.infer<typeof PlanBody>): OnboardingPlanInput {
  return {
    position_ids: input.position_ids,
    role_ids: input.role_ids,
    ...(input.custom_position_name === undefined
      ? {}
      : { custom_position_name: input.custom_position_name }),
    ...(input.positions === undefined
      ? {}
      : {
          positions: input.positions.map((p) => ({
            name: p.name,
            role_ids: p.role_ids,
            ...(p.template_id === undefined ? {} : { template_id: p.template_id }),
          })),
        }),
  }
}
