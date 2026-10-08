/**
 * 首次设置向导的装配（WP51 交付 ②③，46 §1 §3）。
 *
 * 用户第一次打开工具时只被问三件事——**你们公司叫什么、你是谁、你做什么**——
 * 这个模块负责后两件里"机器该自己想明白"的部分：勾了哪几个岗位，就该连哪些平台、
 * 装哪些技能、建哪几条分配。
 *
 * 四条纪律：
 *
 * 1. **归一化是纯函数**（`normalizeCompanyName` / `companyKey`）。它决定"两台机器算不算
 *    同一家公司"，所以必须能表驱动地测、能在两台机器上算出同一个值，不许碰时钟、
 *    不许碰随机源、不许读库。
 * 2. **公司全称不进哈希以外的任何出口**（46 §2 I1）：局域网 TXT 里只有 `companyKey`，
 *    事件日志里也只有它，全称只活在本机的档案里。
 * 3. **`plan` 只算不写**（46 §3 I5）：向导第 ④ 步那张清单是勾选的去重汇总，点进去就是
 *    连接页 / 技能页已有的那张卡，不另做一套配置界面。真建分配的是 `apply`。
 * 4. **勾岗位 = 该岗位职责全勾**（46 §1 表 ③）。前后端同一套算法：`expandRoles` 是
 *    唯一的展开口子，工作台那一侧照着同样的规则算，于是"界面上勾了什么"与
 *    "服务端建了什么"不会两张皮。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  DiscoveryHelloView,
  DiscoveryStateView,
  InviteView,
  JoinPort,
  MembershipRequestInput,
  MembershipRequestView,
  OnboardingApplyView,
  OnboardingConnectorItem,
  OnboardingPlanInput,
  OnboardingPlanView,
  OnboardingPlatformCliItem,
  OnboardingPort,
  OnboardingPositionPlanItem,
  OnboardingPositionView,
  OnboardingSkillItem,
  OnboardingStateView,
  WorkspaceProfileInput,
  WorkspaceProfileView,
} from '@agentsws/api'
import type {
  ApprovalBus,
  Clock,
  EventEnvelope,
  MarketsSource,
  PersonId,
  Position,
  RangeRef,
  RoleId,
  StorefrontPlatform,
  WorkspaceId,
  WorkspaceProfile,
  WorkspaceVertical,
} from '@agentsws/contracts'
import {
  DEFAULT_BRAND_CURRENCY,
  DEFAULT_STOREFRONT_PLATFORM,
  normalizeMarketLanguages,
  normalizeMarkets,
  platformKitOf,
  rolesOfPlan,
  STOREFRONT_PLATFORMS,
  skillOnPlatform,
  storefrontUsableService,
} from '@agentsws/contracts'
import { companyKey, normalizeDomain } from '@agentsws/core'
import { bundledPositionIcon, type RoleStore } from '@agentsws/roles'
import { normalizeVertical, verticalChoices } from '@agentsws/support-core'
import type BetterSqlite3 from 'better-sqlite3'
import { catalogEntry, ROLE_CONNECTOR_KIND } from './catalog.js'
import { createDiscovery, type Discovery, type MdnsFactory } from './discovery.js'
import {
  createInvites,
  type InvitesAssembly,
  type InvitesIdentity,
  OnboardingError,
} from './invites.js'
import { catalogRoles, type Suggester, suggestPositions } from './onboarding-suggest.js'
import { WORKSPACE_BASE_ROLES } from './position-placements.js'

export { OnboardingError } from './invites.js'

/* ------------------------------------------------------------------ */
/* 46 §2 I1：公司名归一化与 company_key                                  */
/* ------------------------------------------------------------------ */

/**
 * 真身在 `@agentsws/core`（`company.ts`）。搬过去是因为**模拟回路也要它**：
 * `packages/simulation` 演"两个人一个写全称、一个多打空格还加了有限公司"时，
 * 必须拿服务进程同一个函数算钥匙，不然那条题只是在测它自己。
 *
 * 这里照旧导出同样的三个名字——外面（测试、别的模块）的导入一个字都不用改。
 */
export { companyKey, normalizeCompanyName, normalizeDomain } from '@agentsws/core'

/* ------------------------------------------------------------------ */
/* 51 §1 N0：网站平台                                                    */
/* ------------------------------------------------------------------ */

/**
 * 职责模板里"店铺后台"那条连接器的 kind。
 *
 * `shop` 是**平台中立**的新写法（`dtc.store` 用它），按公司档案解析成
 * `shopify_admin` / `woocommerce`；`shopify` 是 WP62 之前就写在职责里的老写法，
 * 一并按同一条路解析——职责 yml 是别人库里已经有的东西，不许改着改着就读不进来了。
 */
export const SHOP_CONNECTOR_KINDS: ReadonlySet<string> = new Set(['shop', 'shopify'])

/** 非法值与缺省一律回 `undefined`（调用方按 Shopify 处理）。 */
/** 工作区的底座职责（"是这个工作区的成员"本身）。向导里不算进任何岗位（WP142）。 */
const WORKSPACE_BASE_ROLE: RoleId = 'common.member'

export function normalizeStorefrontPlatform(value: unknown): StorefrontPlatform | undefined {
  return STOREFRONT_PLATFORMS.some((p) => p.id === value)
    ? (value as StorefrontPlatform)
    : undefined
}

/** 灰显那几个的 tooltip：说清"为什么现在选不了"，不是一句冷冰冰的 disabled。 */
const PLATFORM_HINT = '待增加：现在只支持 Shopify，这个平台的店铺连接还没做'

/**
 * WP79「还没开始搭建」那一条的 tooltip。
 *
 * 它**选得动**（不灰显），所以那一句说的不是"为什么选不了"，而是"选了会怎样"。
 */
const NO_SITE_HINT = '选它就先不连店铺；网站搭好了回设置页改。'

/**
 * 首次设置第 ① 步「网站是用什么搭的」的几个选项。
 *
 * 真源是契约里的 `STOREFRONT_PLATFORMS`——界面不自己写一份清单，服务端也不写第二份。
 */
export function storefrontPlatformChoices(): {
  key: StorefrontPlatform
  label: string
  supported: boolean
  hint?: string
}[] {
  return STOREFRONT_PLATFORMS.map((p) => ({
    key: p.id,
    label: p.label,
    supported: p.supported,
    ...(p.supported
      ? // 选得动、却没有店铺连接的那一条（`none`）：说清选了会怎样
        p.connector_service === undefined
        ? { hint: NO_SITE_HINT }
        : {}
      : { hint: PLATFORM_HINT }),
  }))
}

/* ------------------------------------------------------------------ */
/* 档案存储                                                             */
/* ------------------------------------------------------------------ */

/**
 * WP65（52 O1）：档案是**按品牌**存的。
 *
 * 52 之前一个服务进程只有一个工作区，于是档案是一张单行表（`id = 1`）。
 * 品牌变成顶层之后，「你卖的是」与「网站是用什么搭的」是**每个品牌各一份**的
 * （一个公司可以既卖实物又卖虚拟、既有 Shopify 站也有自己搭的站），所以这里
 * 按 `workspace_id` 分行。公司级那三样（全称 / 域名 / 发现开关）已经上提到组织，
 * 档案里那三个位只是同步写下来的一份影子（契约只加不删）。
 */
interface ProfileBackend {
  get(workspace_id: WorkspaceId): WorkspaceProfile | undefined
  put(workspace_id: WorkspaceId, p: WorkspaceProfile): void
  /** WP138：一次性迁移跑过没有（按名字记，跑过一次就再也不跑）。 */
  migrated(key: string): boolean
  markMigrated(key: string, at: string): void
  /** WP251：这个一次性记号是什么时候记下的（没记过 = `undefined`）。 */
  migratedAt(key: string): string | undefined
  /** WP251（决策 92）：这个品牌的首次设置走完过第 ④ 步没有。 */
  completed(workspace_id: WorkspaceId): boolean
  markCompleted(workspace_id: WorkspaceId, at: string): void
  /**
   * WP251：迁移前把全部品牌档案原样抄一份（按 `key` 记在备份表里；已经抄过的不覆盖）。
   * 内存档没有可备份的东西，什么都不做。
   */
  backup(key: string, at: string): void
  close(): void
}

function createMemoryProfileBackend(): ProfileBackend {
  const profiles = new Map<WorkspaceId, WorkspaceProfile>()
  const done = new Set<string>()
  const finished = new Set<WorkspaceId>()
  const stamps = new Map<string, string>()
  return {
    get: (ws) => {
      const found = profiles.get(ws)
      return found === undefined ? undefined : { ...found }
    },
    put: (ws, p) => {
      profiles.set(ws, { ...p })
    },
    migrated: (key) => done.has(key),
    markMigrated: (key, at) => {
      done.add(key)
      stamps.set(key, at)
    },
    migratedAt: (key) => stamps.get(key),
    completed: (ws) => finished.has(ws),
    markCompleted: (ws) => {
      finished.add(ws)
    },
    backup: () => undefined,
    close: () => {
      profiles.clear()
    },
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS onboarding_profile (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS onboarding_profiles (workspace_id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS onboarding_migrations (key TEXT PRIMARY KEY NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS onboarding_completed (workspace_id TEXT PRIMARY KEY NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS onboarding_profiles_backup (key TEXT NOT NULL, workspace_id TEXT NOT NULL, json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (key, workspace_id));
`

/**
 * `defaultWorkspace` 是**迁移用的**：老库里那一行（`id = 1`）不知道自己属于谁，
 * 第一次打开时把它认到这个工作区名下。搬完老表**不删**——回滚到上一版还要读它。
 */
function createSqliteProfileBackend(dbPath: string, defaultWorkspace: WorkspaceId): ProfileBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const put = db.prepare(
    'INSERT INTO onboarding_profiles (workspace_id, json) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET json = excluded.json',
  )
  const read = (ws: WorkspaceId): WorkspaceProfile | undefined => {
    const row = db.prepare('SELECT json FROM onboarding_profiles WHERE workspace_id = ?').get(ws) as
      | { json: string }
      | undefined
    return row === undefined ? undefined : (JSON.parse(row.json) as WorkspaceProfile)
  }
  // 一次性搬家：老的单行表 → 这个工作区那一行（已经有就不覆盖）
  if (read(defaultWorkspace) === undefined) {
    const legacy = db.prepare('SELECT json FROM onboarding_profile WHERE id = 1').get() as
      | { json: string }
      | undefined
    if (legacy !== undefined) put.run(defaultWorkspace, legacy.json)
  }
  return {
    get: read,
    migrated: (key) =>
      db.prepare('SELECT 1 FROM onboarding_migrations WHERE key = ?').get(key) !== undefined,
    markMigrated: (key, at) => {
      db.prepare('INSERT OR IGNORE INTO onboarding_migrations (key, at) VALUES (?, ?)').run(key, at)
    },
    migratedAt: (key) =>
      (
        db.prepare('SELECT at FROM onboarding_migrations WHERE key = ?').get(key) as
          | { at: string }
          | undefined
      )?.at,
    completed: (ws) =>
      db.prepare('SELECT 1 FROM onboarding_completed WHERE workspace_id = ?').get(ws) !== undefined,
    markCompleted: (ws, at) => {
      db.prepare('INSERT OR IGNORE INTO onboarding_completed (workspace_id, at) VALUES (?, ?)').run(
        ws,
        at,
      )
    },
    backup: (key, at) => {
      // 老的单行表那一行记成 `legacy:1`；品牌档案按 workspace_id。已经抄过的不覆盖（幂等）
      db.transaction(() => {
        db.prepare(
          'INSERT OR IGNORE INTO onboarding_profiles_backup (key, workspace_id, json, at) SELECT ?, workspace_id, json, ? FROM onboarding_profiles',
        ).run(key, at)
        db.prepare(
          "INSERT OR IGNORE INTO onboarding_profiles_backup (key, workspace_id, json, at) SELECT ?, 'legacy:1', json, ? FROM onboarding_profile WHERE id = 1",
        ).run(key, at)
      })()
    },
    put: (ws, p) => {
      put.run(ws, JSON.stringify(p))
      // 老库回滚兜底：当前这个工作区的那一份照旧也写进单行表
      if (ws === defaultWorkspace)
        db.prepare(
          'INSERT INTO onboarding_profile (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
        ).run(JSON.stringify(p))
    },
    close: () => {
      db.close()
    },
  }
}

/* ------------------------------------------------------------------ */
/* 装配                                                                 */
/* ------------------------------------------------------------------ */

/** 岗位模板的最小面（真源在 `org.ts` 的库里，这里只读）。 */
export type PositionLike = Pick<Position, 'id' | 'name' | 'roles'>

export interface OnboardingOptions {
  clock: Clock
  random: () => number
  workspace_id: WorkspaceId
  owner: PersonId
  /**
   * 工作区名字（人话）。WP240：给了 `workspace_id` 就是**那个品牌**的（不给 = 启动品牌）——
   * 首次设置按 actor 所在的品牌回，不许拿启动品牌的名字顶。
   */
  workspaceName: (workspace_id?: WorkspaceId) => string
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  roles: RoleStore
  approvals: ApprovalBus
  identity: InvitesIdentity
  /**
   * 这个工作区现在有几个人（发现时对外只报这个数，不报名单）。
   * WP240：给了 `workspace_id` 就问那个品牌（向导第 ② 步带出本人的名字与邮箱）。
   */
  members(
    workspace_id?: WorkspaceId,
  ): Promise<{ person_id: PersonId; name: string; email: string }[]>
  /** WP240：某个品牌的负责人（建它的人）。不给就当启动品牌的 `owner`。 */
  ownerOf?(workspace_id: WorkspaceId): PersonId | undefined
  /** 岗位模板（27）——`org.ts` 的那一份。 */
  positions(): PositionLike[]
  /**
   * WP234（docs/54 §6.1）：第 ③ 步「按类别浏览」的类别目录（`org.catalog()`：出厂的那几个模板）。
   * 不给就退回岗位行（去掉「负责人」与底座职责）。
   */
  catalog?(): PositionLike[]
  /**
   * WP234（docs/54 §6.2）：岗位清单落成岗位行、新分配安放上去（`org.ensurePosition` / `org.place`）。
   * 不给就只建分配、不建岗位行（老行为）。
   */
  positionStore?: {
    ensure(input: { name: string; role_ids: RoleId[]; template_id?: string }, by: PersonId): string
    place(assignment_id: string, position_id: string): void
    /** 这条分配安放在哪（没安放 = `undefined`）。不给就当一条都没安放。 */
    placementOf?(assignment_id: string): string | undefined
  }
  /**
   * WP234：「说说你要做什么工作」用的推荐引擎。**每次现取**——第 ① 步之后模型才接上。
   * 回 `undefined` = 这会儿没有能用的（界面照实说，退回只手选）。
   *
   * WP242：带上点推荐的那个人——按**他这会儿开着的品牌**取模型（跟随公司的用公司那一份），
   * 用量记在这个品牌、这个人头上。不给 = 启动品牌的负责人（老调用方）。
   */
  suggester?(actor?: {
    workspace_id: string
    person_id: string
    assignment_id: string
    role_id: string
  }): Suggester | undefined | Promise<Suggester | undefined>
  /**
   * 现在接上了哪些职责连接器 kind（email / shopify / ga4 …）。
   * WP240：按品牌问（连接是品牌级的，52 O3）；不给 `workspace_id` = 启动品牌。
   */
  connectedKinds(workspace_id?: WorkspaceId): string[] | Promise<string[]>
  /** 装了哪些技能包。 */
  installedSkills(): string[]
  /**
   * 模型接没接（36 首页那条黄条问的就是它）。
   * WP240：按品牌问——跟随公司默认的品牌算公司那一份。
   */
  modelConfigured(workspace_id?: WorkspaceId): boolean | Promise<boolean>
  /**
   * 已连 Shopify 的店（46 I6：连上就自动挂，没连就挂空并在面板明说）。
   * WP240：按品牌问（Rollout 的分配不该挂到 INMO 的店上）。
   */
  shopifyStores(
    workspace_id?: WorkspaceId,
  ): { id: string; label: string }[] | Promise<{ id: string; label: string }[]>
  /** 给了就落盘（`onboarding.sqlite`）；不给就纯内存。 */
  dbDir?: string
  /** 服务进程监听的端口（局域网广播要报它）。 */
  port?: () => number | undefined
  /** 测试注入的假 mDNS；不给就用 `bonjour-service`。 */
  mdns?: MdnsFactory
  /**
   * 同伴的 `/v1/discovery/hello`。默认用 `fetch`；测试注入一个内存实现，
   * 于是"两台机器互相看见"这件事在单元测试里也走得通。
   */
  helloFetch?: (url: string) => Promise<DiscoveryHelloView | undefined>
  /** 往同伴那边发一条请求（申请加入 / 告知失效）；默认 `fetch`，测试注入内存实现。 */
  post?: (url: string, body: unknown) => Promise<{ ok: boolean; data?: unknown }>
  /**
   * 20 §4 的 Join 入口（WP50）：批准一条加入申请之后，给 owner 建一张 `join_mapping` 卡。
   * **懒取**——Join 装在本模块之后，要到真用的时候才拿得到。不给就走兜底（只记事件）。
   */
  join?: () => JoinPort | undefined
  /**
   * WP65（52 O1 / O3）：这个品牌挂在哪个组织下。
   *
   * 公司级那三样（全称 / 域名 / 发现开关）**读以组织为准**——档案里那三个位
   * 已经 `@deprecated`，留着只是为了契约只加不删。**懒取**：组织在本模块之后装配。
   * 不给（还没迁过的机器）就退回读档案，行为与这一版上线前一模一样。
   */
  organization?: () => OrganizationProfile | undefined
  /**
   * WP251：**某个品牌**挂的那家公司（公司级四样：全称 / 邮箱后缀 / 发现开关 / 地址）。
   * 不给 = 一律当 `organization()`（一台机器只有一家公司时两者是同一个）。
   */
  organizationOf?: (workspace_id: WorkspaceId) => OrganizationProfile | undefined
  /**
   * 写公司档案时同步写组织（52 O1「写时同步写组织」）。
   * WP251：给了 `workspace_id` 就写**那个品牌挂的那家公司**；只给改了的那几格（地址空串 = 清掉）。
   */
  updateOrganization?: (patch: OrganizationProfilePatch, workspace_id?: WorkspaceId) => void
  /**
   * WP251：和这个品牌挂在同一家公司下的全部品牌（含它自己）。档案里公司那几格的影子
   * 改公司时一起刷新。不给 = 只有它自己。
   */
  brandsOfCompany?: (workspace_id: WorkspaceId) => WorkspaceId[]
  /**
   * WP65（52 O1）：这个品牌叫什么（没设过就等于工作区名）。
   * WP240：给了 `workspace_id` 就是那个品牌的；不给 = 启动品牌（老调用方）。
   */
  brandName?: (workspace_id?: WorkspaceId) => string
  /**
   * 52 O4 第 ① 步下半块：改品牌名。
   * WP240：**改的是 `workspace_id` 那个品牌**（不给 = 启动品牌）——以前一律改启动品牌，
   * 在第二个品牌里存设置页会把第一个品牌改名。
   */
  setBrandName?: (name: string, workspace_id?: WorkspaceId) => void
}

/** 52 O1：公司级那三样的最小面（组织与档案共用同一个形状）。 */
export interface OrganizationProfile {
  legal_name: string
  domain?: string
  discoverable: boolean
  /** WP251：公司实体地址（公司级，对所有品牌生效）。 */
  postal_address?: string
}

/** WP251：改公司时只给改了的那几格（`postal_address: ''` = 清掉）。 */
export type OrganizationProfilePatch = Partial<OrganizationProfile>

export interface OnboardingAssembly {
  port: OnboardingPort
  /** 46 §2 I1：这台机器的公司钥匙（没设过档案时是 undefined）。 */
  companyKey(): string | undefined
  /**
   * 48 v2 L2：公司档案里的「你卖的是」。没设过就是 `undefined`（= 实物）。
   *
   * 运行时装配比档案早，所以它是**被读的**而不是被传的：用户在设置页改完，
   * 下一次运行就用新的那一套，不用重启。
   */
  vertical(): WorkspaceVertical | undefined
  /**
   * WP62（51 §1 N0）：公司档案里的「网站是用什么搭的」。没设过就是 `undefined`（= Shopify）。
   *
   * 与 `vertical()` 同一个道理——连接面、活数据源、事项工具都比档案先装配好，
   * 所以它是**被读的**而不是被传的：用户在设置页改完，下一次刷新就用新的那一套。
   */
  storefrontPlatform(): StorefrontPlatform | undefined
  /**
   * WP65（52 O1）：**某个品牌**的品牌级档案（「你卖的是」「网站是用什么搭的」）。
   *
   * 与上面那两个的区别只有一条：那两个问的是"当前这个品牌"，这一个能问任何一个品牌
   * ——组织页的品牌一览要一行一行地显示它们。
   */
  brandProfile(workspace_id: WorkspaceId): {
    vertical?: WorkspaceVertical
    storefront_platform?: StorefrontPlatform
    /** WP159：目标市场（品牌分析确认时写的；没写过就没有这一格）。 */
    markets?: string[]
    /** WP166：这份市场是从哪看出来的（官网 / Amazon / 店铺后台 / 人改的）。 */
    markets_source?: MarketsSource
    /** WP169：按市场覆盖的探测语言（没覆盖过就没有）。 */
    market_languages?: Record<string, string>
    /** WP176：公司实体地址（没填过就没有）。 */
    postal_address?: string
    /** WP248（决策 83）：品牌一句话介绍 / 客服邮箱 / 币种（没写过就没有；币种读的人自己按 USD 补）。 */
    one_liner?: string
    support_email?: string
    currency?: string
  }
  /**
   * WP248（决策 83）：只改某个品牌档案上的一句话介绍 / 客服邮箱 / 币种（品牌分析确认时公司名还没有、
   * 走不了 `setProfile` 的那一次用）。不给的格子不动；空串 = 清空。档案还没建过回 `false`（不替人建档案）。
   */
  setBrandFacts(workspace_id: WorkspaceId, facts: BrandFactsInput): boolean
  /**
   * WP176：只改某个品牌档案上的公司实体地址（B2B「主动开发」里原来那一格搬过来那一次用；
   * 设置页走 `setProfile`）。档案还没建过回 `false`（不替人建档案）。`undefined` / 空串 = 清空。
   */
  setPostalAddress(workspace_id: WorkspaceId, address: string | undefined): boolean
  /**
   * WP258：记下官网里读到的 Shopify 店铺地址（`xxx.myshopify.com`；品牌分析确认时用）。
   * 只是一条线索，不给人看；档案还没建过回 `false`（不替人建档案）。读不懂的地址不写。
   */
  setShopifyDomain(workspace_id: WorkspaceId, domain: string): boolean
  /** WP258：官网里读到的那个 Shopify 店铺地址（没读到 / 没档案就没有）。 */
  shopifyDomainOf(workspace_id: WorkspaceId): string | undefined
  /**
   * WP216：只改某个品牌档案上的「网站是用什么搭的」。`source` 记是人选的还是按已连的店铺推断的
   * （进事件，不进档案）。档案还没建过：公司已有名字就用它起一份最小档案；公司也没名字回 `false`。
   */
  setStorefrontPlatform(
    workspace_id: WorkspaceId,
    platform: StorefrontPlatform,
    source: 'human' | 'inferred_from_connection',
  ): boolean
  /**
   * WP166：直接改某个品牌的目标市场（店铺连上后按店里配的市场 / 配送区域校正那一次用）。
   * 人改过的（`markets_source.from === 'human'`）**不动**，回 `false`；改了回 `true`。
   */
  setMarkets(workspace_id: WorkspaceId, markets: readonly string[], source: MarketsSource): boolean
  /**
   * WP65（52 O1）：公司级那三样的当前值（读以组织为准，还没迁过就是档案里那一份）。
   *
   * 启动时的一次性迁移用它——建组织要的正是档案里的全称、域名与发现开关。
   */
  companyProfile(workspace_id?: WorkspaceId): OrganizationProfile | undefined
  /**
   * WP251：**一次性**把公司级那几格归到公司上（启动时跑，跑过一次就记下）。
   *
   * 1. 先把全部品牌档案原样备份一份（`onboarding_profiles_backup`，键 `wp251`）；
   * 2. 公司还没有地址的：从品牌档案里搬一份上去（最近存过的那个品牌的）；
   * 3. 每个品牌档案里公司那几格的影子刷成公司现在的值（以组织为准）。
   *
   * 没有组织（还没迁过）就什么都不做、也不记下（下次启动再跑）。
   */
  settleCompanyOnOrganization(): { address_moved: boolean; synced: WorkspaceId[] }
  /**
   * WP251（决策 92）：**一次性**认一遍存量加的品牌——已经有岗位（除负责人那一条外有分配）的
   * 当作走完过首次设置，免得升级后把在用的品牌拉回向导。跑过一次就记下。
   */
  settleAddedBrandCompletion(brands: WorkspaceId[]): { completed: WorkspaceId[] }
  /**
   * WP251：某件事**从什么时候起**这样做（第一次问的那一刻记下，之后一直回那一刻）。
   * 「卡住了」按结构化标记分组从这一版第一次启动起算——在那之前跑的老数据才退回认 AI 末句。
   */
  since(key: string): string
  /** WP251：改公司之后（公司页那条路）把各品牌档案里的影子刷一遍。 */
  syncCompanyShadows(workspace_id: WorkspaceId): WorkspaceId[]
  /**
   * 建一个新品牌时把品牌级那两样写下来（52 O4 第 ① 步的下半块）。
   *
   * 公司级三样从组织抄一份影子过来——档案里那三个位已经 `@deprecated`，
   * 但它们仍是 `WorkspaceProfile` 的必填位，不能空着。
   */
  setBrandProfile(
    workspace_id: WorkspaceId,
    input: { vertical?: WorkspaceVertical; storefront_platform?: StorefrontPlatform },
  ): void
  /**
   * WP138（78 §1 #1）：**一次性**给老数据补挂范围。
   *
   * 这一版之前向导没连店就把新职责挂空，红人工作台与聊天入口整块被挡住。启动时调一次：
   * 只补**店主本人名下、店主自己给自己建的、要范围却一条都没有**的职责，补的是向导今天
   * 会挂的那一份（连了店挂店，没连挂整个品牌）。跑过一次就记下来，之后再也不跑——
   * 店主后来自己清空的范围不会被它加回去。
   */
  backfillWizardRanges(): { patched: string[] }
  /**
   * WP240：这个品牌是不是公司**加的**品牌（不是启动品牌、而且公司那一层已经设过）。
   * 网址分析确认时据此决定：公司全称不跟着分析结果改、建品牌时起的品牌名不被站名顶掉。
   */
  isAddedBrand(workspace_id: WorkspaceId): boolean
  /**
   * WP240：**一次性**自检加的品牌的档案（启动时跑，跑过一次就记下来）。
   *
   * 这一版之前，建品牌那一刻就替它起了一份档案（公司全称的影子 + 平台），于是新品牌永远判成
   * "设过了"、进不了首次设置。这里把**看得出是自动起的、还没人用过**的那几份标回 `provisional`：
   * 档案里只有建品牌时写的那几格（没有市场、地址），并且这个品牌里除了负责人那一条没有别的分配。
   * 用户自己存过（有市场 / 地址）或已经分过岗位的一律不碰。
   *
   * 品牌名不在档案里（读的是品牌工作区自己的名字），所以"档案里的品牌名不对"在存储上不存在——
   * 以前回错的是**读法**（一律读启动品牌），读法改了就对了；这里只把每个品牌的名字与档案对一遍，
   * 回报给调用方（不改）。
   */
  reconcileBrandProfiles(brands: { workspace_id: WorkspaceId; name: string }[]): {
    reopened: WorkspaceId[]
    checked: number
  }
  discovery: Discovery
  invites: InvitesAssembly
  close(): void
}

/** WP138：补挂迁移的名字（记在 `onboarding_migrations` 里）。 */
export const WIZARD_RANGE_BACKFILL = 'wp138_wizard_ranges'

/** WP240：加的品牌档案自检的名字（记在 `onboarding_migrations` 里）。 */
export const ADDED_BRAND_PROFILE_CHECK = 'wp240_added_brand_profiles'

/** WP251：公司级字段归公司的迁移名（也是备份表里那一份的键）。 */
export const COMPANY_ON_ORG = 'wp251_company_on_org'

/** WP251（决策 91）：「卡住了」改看结构化标记的起点（记在 `onboarding_migrations` 里）。 */
export const RUN_BLOCK_MARKED_SINCE = 'wp251_run_block_marked_since'

/** WP251（决策 92）：存量加的品牌认「走完过」的迁移名。 */
export const ADDED_BRAND_COMPLETION = 'wp251_added_brand_completion'

export function createOnboarding(options: OnboardingOptions): OnboardingAssembly {
  const { clock, workspace_id, roles, appendEvent } = options
  const backend =
    options.dbDir === undefined
      ? createMemoryProfileBackend()
      : createSqliteProfileBackend(join(options.dbDir, 'onboarding.sqlite'), options.workspace_id)

  /** WP240：事件记在**发生的那个品牌**名下（不给 = 启动品牌）。 */
  const emit = (
    type: string,
    actor: PersonId,
    payload: Record<string, unknown>,
    ws: WorkspaceId = workspace_id,
  ): void => {
    appendEvent({
      schema_version: 1,
      workspace_id: ws,
      type,
      actor: { kind: 'person', id: actor },
      correlation: { trace_id: `tr_onboarding_${clock.now()}` },
      payload,
    })
  }

  /** 不给就是**当前这个品牌**的档案（`options.workspace_id`）。 */
  const profileOf = (ws: WorkspaceId = workspace_id): WorkspaceProfile | undefined =>
    backend.get(ws)
  /**
   * 52 O1：公司级那三样以**组织**为准，档案只是影子。
   * 还没迁过（没装配组织）就退回读档案——存量机器的行为一个字节不变。
   */
  /**
   * WP251：这个品牌挂的那家公司（真源）。没有组织（还没迁过）才退回读这个品牌档案里的影子。
   */
  const orgOf = (ws: WorkspaceId): OrganizationProfile | undefined =>
    options.organizationOf?.(ws) ?? options.organization?.()
  const companyFor = (ws: WorkspaceId = workspace_id): OrganizationProfile | undefined => {
    const org = orgOf(ws)
    if (org !== undefined) return org
    const p = profileOf(ws)
    return p === undefined
      ? undefined
      : {
          legal_name: p.legal_name,
          ...(p.domain === undefined ? {} : { domain: p.domain }),
          discoverable: p.discoverable,
          ...(p.postal_address === undefined ? {} : { postal_address: p.postal_address }),
        }
  }
  /** 启动品牌那家公司（发现、`company_key` 用它——局域网广播是这台机器的事）。 */
  const companyOf = (): OrganizationProfile | undefined => companyFor(workspace_id)
  /** 公司那几格写到组织上（没装组织就是 `false`，调用方退回写档案）。 */
  const writesCompany = (ws: WorkspaceId): boolean =>
    options.updateOrganization !== undefined && orgOf(ws) !== undefined
  /**
   * WP251：档案里公司那几格的影子刷成公司现在的值（同一家公司下的每个品牌）。
   * 影子只为回滚到旧版时读得到同一套——这一版一格都不读它。回刷了哪几个品牌。
   */
  const syncCompanyShadows = (ws: WorkspaceId): WorkspaceId[] => {
    const company = orgOf(ws)
    if (company === undefined) return []
    const synced: WorkspaceId[] = []
    for (const sib of options.brandsOfCompany?.(ws) ?? [ws]) {
      const p = profileOf(sib)
      if (p === undefined) continue
      const same =
        p.legal_name === company.legal_name &&
        p.domain === company.domain &&
        p.discoverable === company.discoverable &&
        p.postal_address === company.postal_address
      if (same) continue
      const { domain: _d, postal_address: _a, ...rest } = p
      backend.put(sib, {
        ...rest,
        legal_name: company.legal_name,
        ...(company.domain === undefined ? {} : { domain: company.domain }),
        discoverable: company.discoverable,
        ...(company.postal_address === undefined ? {} : { postal_address: company.postal_address }),
      })
      synced.push(sib)
    }
    return synced
  }
  const keyOf = (): string | undefined => {
    const c = companyOf()
    return c === undefined ? undefined : companyKey(c.legal_name, c.domain)
  }

  /** 对外的展示名："王岚的工作区 · 3 人"。owner 的名字 + 人数，没有名单。 */
  const label = async (): Promise<{ text: string; members: number }> => {
    const members = await options.members()
    const owner = members.find((m) => m.person_id === options.owner)
    const who = owner?.name ?? options.workspaceName()
    return { text: `${who}的工作区 · ${members.length} 人`, members: members.length }
  }

  const discovery = createDiscovery({
    clock,
    workspace_id,
    appendEvent,
    companyKey: keyOf,
    enabled: () => companyOf()?.discoverable === true,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.mdns === undefined ? {} : { mdns: options.mdns }),
    ...(options.helloFetch === undefined ? {} : { helloFetch: options.helloFetch }),
  })

  const invites = createInvites({
    clock,
    random: options.random,
    workspace_id,
    owner: options.owner,
    appendEvent,
    roles,
    approvals: options.approvals,
    identity: options.identity,
    members: options.members,
    companyKey: keyOf,
    peerId: () => discovery.peerId(),
    peerAddress: (id) => discovery.peer(id),
    peerIds: () => discovery.peerIds(),
    ...(options.post === undefined ? {} : { post: options.post }),
    ...(options.join === undefined ? {} : { join: options.join }),
    ...(options.dbDir === undefined ? {} : { dbDir: options.dbDir }),
  })

  /**
   * 52 O1：品牌名的唯一读法（没装配就退回工作区名）。
   * WP240：**按品牌读**——不给 = 启动品牌；首次设置一律传 actor 的那个品牌。
   */
  const brandNameOf = (ws: WorkspaceId = workspace_id): string =>
    options.brandName?.(ws) ?? options.workspaceName(ws)

  /**
   * WP240：公司那一层设过没有——启动品牌（公司的第一个品牌）走过第 ① / ② 步就算。
   * 之后加的品牌走首次设置时，公司级的（全称、你的称呼）不再问、分析结果也不改公司全称。
   */
  const companyConfigured = (): boolean => {
    const first = profileOf(workspace_id)
    return first !== undefined && first.provisional !== true
  }
  const isAddedBrand = (ws: WorkspaceId): boolean => ws !== workspace_id && companyConfigured()

  const viewOf = (p: WorkspaceProfile, ws: WorkspaceId = workspace_id): WorkspaceProfileView => {
    // WP251：公司那几格一律读**这个品牌挂的那家公司**（档案里那一份只是影子）
    const company = companyFor(ws)
    return {
      legal_name: company?.legal_name ?? p.legal_name,
      brand_name: brandNameOf(ws),
      ...(() => {
        const domain = company === undefined ? p.domain : company.domain
        return domain === undefined ? {} : { domain }
      })(),
      discoverable: company?.discoverable ?? p.discoverable,
      // 48 v2 L2：没设过就是实物——存量档案里没有这个字段，它们的行为不许变
      vertical: p.vertical ?? 'goods',
      // WP62（51 §1 N0）：没设过就是 Shopify——存量档案里没有这个字段，它们的行为不许变
      storefront_platform: p.storefront_platform ?? DEFAULT_STOREFRONT_PLATFORM,
      // WP166：目标市场与出处（设置页「公司档案」同一份可改）
      ...(p.markets === undefined ? {} : { markets: [...p.markets] }),
      ...(p.markets_source === undefined ? {} : { markets_source: p.markets_source }),
      ...(p.market_languages === undefined ? {} : { market_languages: { ...p.market_languages } }),
      // WP176：公司实体地址（开发信页脚、报价单、单证从这里取）；WP251：公司级
      ...(() => {
        const address = company === undefined ? p.postal_address : company.postal_address
        return address === undefined ? {} : { postal_address: address }
      })(),
      // WP248（决策 83）：品牌三格；币种没写过按 USD
      ...brandFactsOf(p),
      currency: p.currency ?? DEFAULT_BRAND_CURRENCY,
      set_at: p.set_at,
    }
  }

  const activeOf = (person_id: PersonId, ws: WorkspaceId = workspace_id) =>
    roles.assignments
      .listByPerson(person_id, { workspace_id: ws })
      .filter((a) => a.revoked_at === undefined)

  /**
   * 46 §3 I6 + WP138：向导给新职责挂的范围。
   *
   * 连上 Shopify 的店照旧挂店（店铺数字要按店切）；**一家都没连就挂整个品牌**
   * （`brand` = 当前工作区）——红人与在线客服本来就不按店划，挂空只会让它们整块看不见。
   * 连了店不再额外挂品牌：挂了品牌就等于盖住以后接进来的每一家店，这一步留给店主在
   * 组织页自己决定。
   */
  const wizardRanges = (stores: { id: string }[], ws: WorkspaceId = workspace_id): RangeRef[] => {
    const refs = stores.map((s) => ({ kind: 'store' as const, id: s.id }))
    return refs.length > 0 ? refs : [{ kind: 'brand', id: ws }]
  }
  const rangeLabel = (
    r: RangeRef,
    stores: { id: string; label: string }[],
    ws: WorkspaceId = workspace_id,
  ): string =>
    r.kind === 'brand'
      ? `整个品牌（${brandNameOf(ws)}）`
      : (stores.find((s) => s.id === r.id)?.label ?? r.id)

  /** 这条职责要不要范围（有一条 `range: assigned` 的 scope 就要）。 */
  const needsRanges = (role_id: string): boolean =>
    roles.roles.get(role_id)?.scopes.some((s) => s.range === 'assigned') ?? false

  /**
   * 46 §1 表 ③「勾岗位 = 它包含的职责全勾上」。
   *
   * 展开的是岗位模板里**全部**职责（不只是 `default: true` 的那些）——向导上勾的是
   * "我做这个岗位"，不是"我要这个岗位的默认包"；`applyPosition` 的默认包语义留给
   * 制度页的分配向导（05 §2）。展开结果去重，顺序稳定（岗位序 → 模板内的职责序）。
   */
  /**
   * WP142（docs/78 第 9、10 步）：**向导里的岗位不含 `common.member`**。
   *
   * 种岗位时每个岗位都带着它（`org.ts` 的 `SEED_POSITIONS`），但它是"这个人是这个工作区的
   * 成员"（04 §7：加入工作区自动获得，不属于任何岗位），不是客服或红人的一条职责。
   * 算进来的后果有两个，走查都撞到了：第 ③ 步「客服 5」而客服只有 4 条、第 ④ 步各岗位
   * 「已勾」加起来比完成屏多；更糟的是完成后左栏多出一个没勾过的「普通成员」岗位
   * （那个岗位的唯一一条职责就是它）。所以向导里摘掉——与岗位视图的 `dutyRolesOf`
   * （WP125）同一条规则。「普通成员」岗位本身只有这一条，那就不摘（摘完它就没了）。
   */
  function wizardRoles<T extends { role: RoleId }>(roles: readonly T[]): T[] {
    const kept = roles.filter((r) => r.role !== WORKSPACE_BASE_ROLE)
    return kept.length === 0 ? [...roles] : kept
  }

  /**
   * WP171（Fable 终审）：**勾岗位不带上第二批的职责**（职责定义 `status: planned`）。
   * 它们在向导里照样列出来（标「第二批」），用户单独勾了才进清单，而且归到那个岗位下，
   * 不另起一个"自定义岗位"。
   */
  function isPlannedRole(id: RoleId): boolean {
    return roles.roles.get(id)?.status === 'planned'
  }
  function tickedRoles<T extends { role: RoleId }>(
    list: readonly T[],
    explicit: readonly RoleId[],
  ): T[] {
    return wizardRoles(list).filter((r) => !isPlannedRole(r.role) || explicit.includes(r.role))
  }

  function expandRoles(input: OnboardingPlanInput, positions: PositionLike[]): RoleId[] {
    // WP234（docs/54 §6.2）：给了岗位清单就按它展开（老三格不看）；职责定义没装的不进清单
    if (input.positions !== undefined)
      return rolesOfPlan(input.positions).filter(
        (id) => roles.roles.get(id) !== undefined && !WORKSPACE_BASE_ROLES.has(id),
      )
    const out: RoleId[] = []
    const seen = new Set<RoleId>()
    const push = (id: RoleId): void => {
      if (seen.has(id)) return
      // 职责定义没加载到这台机器上的不进清单：界面上出现一条点不动的勾比没有它更糟
      if (roles.roles.get(id) === undefined) return
      seen.add(id)
      out.push(id)
    }
    for (const id of input.position_ids) {
      const position = positions.find((p) => p.id === id)
      if (position === undefined) throw new OnboardingError('not_found', `没有这个岗位：${id}`)
      for (const r of tickedRoles(position.roles, input.role_ids)) push(r.role)
    }
    for (const id of input.role_ids) push(id)
    return out
  }

  /**
   * 职责的 `connectors[]` → 连接目录的 provider（46 §3 I5 的那一步归并）。
   *
   * WP62（51 §1 N0）：`kind: shop`（与老写法 `kind: shopify`）**按公司档案解析**——
   * Shopify 的工作区解析成 `shopify_admin`，WooCommerce 的解析成 `woocommerce`，
   * 选了 Magento / 其它的解析成空（清单里干脆不出店铺卡，而不是出一张连不上的）。
   */
  function providersOf(kind: string, ws: WorkspaceId = workspace_id): string[] {
    if (SHOP_CONNECTOR_KINDS.has(kind)) {
      // `storefrontUsableService` 问的是"今天点得动的是哪一个"（`supported` 那几个）；
      // 再对着连接目录核一次——目录才是"到底有没有这张卡"的真源。
      // 点进去无处可点的条目就是噪音，等目录里真有它的那天自然会出现。
      // WP240：按**这个品牌**的平台解析
      const service = storefrontUsableService(profileOf(ws)?.storefront_platform)
      return service === undefined || catalogEntry(service) === undefined ? [] : [service]
    }
    const hits = Object.entries(ROLE_CONNECTOR_KIND)
      .filter(([, k]) => k === kind)
      .map(([service]) => service)
    // 同一个 kind 有多条接法时（邮箱 = 通用 IMAP / Gmail），只推第一条：
    // 目录里通用 IMAP 排在 Gmail 前面，31 §3 说过为什么
    return hits
  }

  /**
   * WP216：向导最后那句「要现在装 CLI 吗？」——平台那一行有 CLI、而且勾的职责里有要用它的才问。
   * 判据全在 `PLATFORM_KITS` 里，这里没有一个平台名。
   */
  function platformCliOf(
    platform: StorefrontPlatform | undefined,
    roleIds: readonly string[],
  ): OnboardingPlatformCliItem | undefined {
    const cli = platformKitOf(platform)?.cli
    if (cli === undefined || !roleIds.some((r) => cli.roles.includes(r))) return undefined
    const position_id = cli.positions[0]
    if (position_id === undefined) return undefined
    return { id: cli.id, label: cli.label, position_id, tutorial: cli.tutorial }
  }

  async function planOf(
    input: OnboardingPlanInput,
    ws: WorkspaceId = workspace_id,
    person: PersonId = options.owner,
  ): Promise<OnboardingPlanView> {
    const positions = options.positions()
    // WP216：平台专属的官方技能 / CLI 按**这个品牌**的档案判断（不是进程默认那个品牌）
    const platform = profileOf(ws)?.storefront_platform
    const roleIds = expandRoles(input, positions)
    // WP240：连接、模型、已持有的分配都按**这个品牌**算
    const connected = new Set(await options.connectedKinds(ws))
    const installed = new Set(options.installedSkills())

    const connectors = new Map<string, OnboardingConnectorItem>()
    const skills = new Map<string, OnboardingSkillItem>()
    for (const id of roleIds) {
      const def = roles.roles.get(id)
      if (def === undefined) continue
      for (const c of def.connectors) {
        // 目录里没有对应 provider 的 kind（tracking / payment_dispute）不进清单——
        // 点进去无处可点的条目就是噪音。等目录里真有它们的那天自然会出现。
        const service = providersOf(c.kind, ws)[0]
        if (service === undefined) continue
        const existing = connectors.get(service)
        if (existing === undefined) {
          connectors.set(service, {
            service,
            label: catalogEntry(service)?.label ?? service,
            required: c.required,
            // kind 是平台中立的（`shop`），连上没连上要按**解析出来的那个 provider** 算
            connected: connected.has(ROLE_CONNECTOR_KIND[service] ?? c.kind),
            needed_by: [def.name.zh],
          })
        } else {
          existing.required = existing.required || c.required
          if (!existing.needed_by.includes(def.name.zh)) existing.needed_by.push(def.name.zh)
        }
      }
      for (const s of def.skills) {
        // WP216：平台对不上的官方技能（非 Shopify 品牌上的 Shopify 技能）不进清单
        if (!skillOnPlatform(s.name, platform)) continue
        const existing = skills.get(s.name)
        if (existing === undefined)
          skills.set(s.name, {
            name: s.name,
            installed: installed.has(s.name),
            needed_by: [def.name.zh],
          })
        else if (!existing.needed_by.includes(def.name.zh)) existing.needed_by.push(def.name.zh)
      }
    }

    const held = new Set(activeOf(person, ws).map((a) => a.role_id))
    const fromList = (input.positions ?? []).flatMap((p, i): OnboardingPositionPlanItem[] => {
      const ids = p.role_ids.filter((r) => roleIds.includes(r))
      if (ids.length === 0) return []
      return [
        {
          // 复用模板的那一行就是模板 id；自建的按顺序编号（界面拿它当 key）
          position_id: p.template_id ?? `custom:${String(i)}`,
          name: p.name.trim() === '' ? '我的岗位' : p.name.trim(),
          role_ids: ids,
          already_held: ids.every((r) => held.has(r)),
        },
      ]
    })
    const legacyIds = input.positions === undefined ? input.position_ids : []
    const plannedPositions: OnboardingPositionPlanItem[] = legacyIds.map((id) => {
      const position = positions.find((p) => p.id === id)
      const ids = tickedRoles(position?.roles ?? [], input.role_ids)
        .map((r) => r.role)
        .filter((r) => roles.roles.get(r) !== undefined)
      return {
        position_id: id,
        name: position?.name.zh ?? id,
        role_ids: ids,
        already_held: ids.length > 0 && ids.every((r) => held.has(r)),
      }
    })
    plannedPositions.push(...fromList)
    // 46 §3 I6：只勾职责不勾岗位 → 一个"自定义岗位"，名字用户填，默认"我的岗位"
    const extras = (input.positions === undefined ? input.role_ids : []).filter(
      (r) => !plannedPositions.some((p) => p.role_ids.includes(r)) && roles.roles.get(r),
    )
    if (extras.length > 0) {
      plannedPositions.push({
        position_id: 'custom',
        name: input.custom_position_name ?? '我的岗位',
        role_ids: extras,
        already_held: extras.every((r) => held.has(r)),
      })
    }

    const model_configured = await options.modelConfigured(ws)
    const platform_cli = platformCliOf(platform, roleIds)
    return {
      connectors: [...connectors.values()].sort(
        (a, b) => Number(b.required) - Number(a.required) || a.service.localeCompare(b.service),
      ),
      skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
      positions: plannedPositions,
      model_configured,
      // 模型没接的话清单第一条固定是"接模型"：平台连得再全也没人替你干活
      model_first: !model_configured,
      role_ids: roleIds,
      ...(platform_cli === undefined ? {} : { platform_cli }),
    }
  }

  /**
   * WP234：类别目录（不含「负责人」与底座职责；一条职责都不剩的类别不出）。
   *
   * Luoye 10-06：**显示公司改过的名字**——公司把「客服」改名成「售后」，目录里就叫「售后」，
   * 出厂名记在 `factory` 里（界面上小字附后）。职责清单仍按出厂模板（目录不随公司的合并变形）。
   */
  const catalogOf = (): (PositionLike & { factory?: string })[] => {
    const rows = options.positions()
    return (options.catalog?.() ?? rows.filter((p) => p.id !== 'owner'))
      .map((p) => {
        const renamed = rows.find((r) => r.id === p.id)?.name
        const changed =
          renamed !== undefined && renamed.zh.trim() !== '' && renamed.zh !== p.name.zh
        return {
          ...p,
          ...(changed ? { name: { ...p.name, zh: renamed.zh }, factory: p.name.zh } : {}),
          roles: p.roles.filter((r) => !WORKSPACE_BASE_ROLES.has(r.role)),
        }
      })
      .filter((p) => p.roles.length > 0)
  }

  const port: OnboardingPort = {
    async state(actor) {
      // 52 O1：档案是按品牌存的——看的是**这个人这会儿开着的那个品牌**
      // WP240：品牌名、工作区名、人、"别人的分配"也一律按这个品牌（以前全是启动品牌的）
      const ws = actor.workspace_id
      const profile = profileOf(ws)
      const members = await options.members(ws)
      const me = members.find((m) => m.person_id === actor.person_id)
      const brandOwner = options.ownerOf?.(ws) ?? options.owner
      // 46 §1 末段：向导只出现在"还没设过公司名"的时候；已经有别人的分配了就更不该弹
      const others = roles.assignments
        .listByWorkspace(ws)
        .filter(
          (a) =>
            a.revoked_at === undefined &&
            a.person_id !== options.owner &&
            a.person_id !== brandOwner,
        ).length
      const runtime = discovery.status()
      const added = isAddedBrand(ws)
      const model_configured = await options.modelConfigured(ws)
      return {
        /*
         * 46 §1 末段的判据一个字没改：**这个品牌的档案设过没有**。
         *
         * 52 O1 之后每个工作区启动时都会挂上一个组织（迁移建的那个用工作区名占位），
         * 所以"有没有组织"**不能**当判据——真正的判据仍然是有没有人填过第 ① 步。
         */
        // WP240：建品牌时自动起的那份影子档案（`provisional`）不算"设过"
        // WP251（决策 92）：加的品牌要**走完第 ④ 步**才算设置完——第 ② 步确认了、③④ 没做就离开，
        // 回首页照样拉回它的首次设置（停在上次那一步：`business_done`）。启动品牌口径不变。
        needs_setup:
          others === 0 &&
          (added ? !backend.completed(ws) : profile === undefined || profile.provisional === true),
        workspace_name: options.workspaceName(ws),
        brand_name: brandNameOf(ws),
        ...(profile === undefined ? {} : { profile: viewOf(profile, ws) }),
        person: { name: me?.name ?? '', email: me?.email ?? '' },
        other_assignments: others,
        is_owner: actor.person_id === options.owner,
        discovery: {
          available: runtime.available,
          enabled: companyOf()?.discoverable === true,
          ...(runtime.reason === undefined ? {} : { reason: runtime.reason }),
        },
        // 46 §1 ①「你卖的是」：选项与 tooltip 都从垂直包读，界面不自己写一份文案
        verticals: verticalChoices(),
        // WP62（51 §1 N0）：四个都发下来，灰显的那三个带"待增加"的 tooltip
        storefront_platforms: storefrontPlatformChoices(),
        // WP240：加的品牌——公司级的不再问、从第 ② 步开始；AI 接上了第 ① 步直接过
        ...(added ? { added_brand: true as const } : {}),
        model_configured,
        // WP244：第 ② 步做过了（档案有人确认 / 存过）——向导重开时从第 ③ 步接着走
        ...(profile !== undefined && profile.provisional !== true
          ? { business_done: true as const }
          : {}),
      } satisfies OnboardingStateView
    },

    setProfile(actor, input: WorkspaceProfileInput) {
      const legal_name = input.legal_name.trim()
      if (legal_name === '') throw new OnboardingError('invalid_input', '公司全称不能是空的')
      // WP240：写的是**这个人这会儿开着的那个品牌**（档案、品牌名、事件一律跟着它）
      const ws = actor.workspace_id
      const previous = profileOf(ws)
      // WP251：公司级那几格是**这个品牌挂的那家公司**的（不再是启动品牌那一家、也不再按品牌各一份）
      const company = companyFor(ws)
      const domain = normalizeDomain(input.domain)
      // 48 v2 L2：不给就沿用上一次；从来没设过就是实物
      const vertical = normalizeVertical(input.vertical) ?? previous?.vertical
      // WP62（51 §1 N0）：同上——不给就沿用上一次；从来没设过就是 Shopify
      const storefront_platform =
        normalizeStorefrontPlatform(input.storefront_platform) ?? previous?.storefront_platform
      // WP159 / WP166：目标市场——不给就沿用上一次（只认国家码清单里的，统一大写、去重）；
      // 人改过的那一份，自动推断（品牌分析确认）不再覆盖它
      const { markets, markets_source } = nextMarkets(previous, input, clock.now())
      // WP169：按市场覆盖探测语言——不给就沿用上一次；给了按国家码 / 语言码归一化（空 = 清空）
      const market_languages =
        input.market_languages === undefined
          ? previous?.market_languages
          : normalizeMarketLanguages(input.market_languages)
      // WP176：公司实体地址——不给就沿用上一次；给空串 = 清空。WP251：公司级（沿用的是公司那一份）
      const postal_address =
        input.postal_address === undefined
          ? company === undefined
            ? previous?.postal_address
            : company.postal_address
          : normalizePostalAddress(input.postal_address)
      // WP248（决策 83）：品牌三格——不给就沿用上一次；空串 = 清空
      const facts = nextBrandFacts(previous, input)
      const next: WorkspaceProfile = {
        legal_name,
        ...(domain === '' ? {} : { domain }),
        ...(postal_address === undefined ? {} : { postal_address }),
        ...facts,
        ...(markets === undefined || markets.length === 0 ? {} : { markets }),
        ...(markets_source === undefined ? {} : { markets_source }),
        ...(market_languages === undefined || Object.keys(market_languages).length === 0
          ? {}
          : { market_languages }),
        discoverable: input.discoverable ?? company?.discoverable ?? previous?.discoverable ?? false,
        ...(vertical === undefined ? {} : { vertical }),
        ...(storefront_platform === undefined ? {} : { storefront_platform }),
        // WP258：官网读到的店铺地址不在设置页上，存档案时原样带着
        ...(previous?.shopify_domain === undefined
          ? {}
          : { shopify_domain: previous.shopify_domain }),
        set_at: clock.now(),
      }
      backend.put(ws, next)
      /*
       * 52 O1「写时同步写组织」：公司级那三样的真源是组织，档案里那一份只是影子。
       * 两边一起写，于是无论谁先读到的都是同一套；读的时候一律以组织为准。
       *
       * WP240：**只在公司级那三样真变了时才写组织**——设置页公司与品牌是同一张表一起存的，
       * 在某个品牌里只改了品牌那几格，不该顺手把组织也"改"一遍。
       */
      const addressChanged =
        input.postal_address !== undefined && postal_address !== company?.postal_address
      const companyChanged =
        company === undefined ||
        company.legal_name !== next.legal_name ||
        (next.domain !== undefined && next.domain !== company.domain) ||
        (input.discoverable !== undefined && input.discoverable !== company.discoverable) ||
        addressChanged
      if (companyChanged) {
        // WP251：写**这个品牌挂的那家公司**；改了公司 = 对所有品牌生效，各品牌档案里的影子一起刷
        options.updateOrganization?.(
          {
            legal_name: next.legal_name,
            ...(next.domain === undefined ? {} : { domain: next.domain }),
            discoverable: next.discoverable,
            ...(addressChanged ? { postal_address: postal_address ?? '' } : {}),
          },
          ws,
        )
        syncCompanyShadows(ws)
      }
      // 52 O4：第 ① 步下半块。品牌名与公司名落在两个地方——它们是两件事
      // WP240：改的是**这个品牌**的名字；和现在一样就不写（不留一条什么都没变的更名）
      const brand_name = input.brand_name?.trim()
      if (brand_name !== undefined && brand_name !== '' && brand_name !== brandNameOf(ws))
        options.setBrandName?.(brand_name, ws)
      // 21 §5：日志里只有归一化后的哈希与"有没有域名"，**全称不进日志**
      emit(
        'workspace.profile_set',
        actor.person_id,
        {
          company_key: companyKey(next.legal_name, next.domain),
          has_domain: next.domain !== undefined,
          discoverable: next.discoverable,
          vertical: next.vertical ?? 'goods',
          // WP62（51 §1 N0）：平台不是秘密，进日志（换平台是一次会影响所有店铺读写的变更）
          storefront_platform: next.storefront_platform ?? DEFAULT_STOREFRONT_PLATFORM,
        },
        ws,
      )
      /*
       * 开关变了就真的开 / 关：关掉 = 停广播、停监听、清掉看见过的同伴。
       *
       * 比的是**档案上一次的值**，不是组织上的——迁移建出来的那个组织带着一个
       * `discoverable: true` 的占位，拿它当"上一次"会让第一次设置不再触发开广播。
       * 从组织那一侧改开关走的是另一条路（`/v1/orgs/:id` → `onCompanyChanged`）。
       */
      const before = previous?.discoverable
      if (before !== next.discoverable || before === undefined) {
        if (next.discoverable) discovery.enable(actor.person_id)
        else discovery.disable(actor.person_id)
      } else if (next.discoverable) {
        // 名字改了 → 钥匙变了 → 重新广播（否则还在用旧钥匙找同事）
        discovery.refresh()
      }
      return viewOf(next, ws)
    },

    positions(): OnboardingPositionView[] {
      // WP234（docs/54 §6.1）：这里列的是**类别目录**——「负责人」与底座职责不在里面
      // （负责人是身份不是岗位；`common.*` 不算任何岗位的活）
      return catalogOf().map((p) => ({
        id: p.id,
        name: p.name.zh,
        // Luoye 10-06：公司改过名就显示改过的，出厂名小字附后
        ...(p.factory === undefined ? {} : { factory_name: p.factory }),
        // WP213：向导里岗位前面的图标（同 id 内置模板 yml 里的）
        ...(bundledPositionIcon(p.id) === undefined
          ? {}
          : { icon: bundledPositionIcon(p.id) as string }),
        roles: wizardRoles(p.roles).flatMap((r) => {
          const def = roles.roles.get(r.role)
          return def === undefined
            ? []
            : [
                {
                  id: def.id,
                  name: def.name.zh,
                  default: r.default,
                  // 46 §1 表 ③「每条职责旁有一句'它会干什么'」——就是 05 里的 description
                  what_it_does: def.description,
                  // WP171（Fable 终审）：第二批的职责向导里标「第二批」，仍按模板默认不勾
                  ...(def.status === 'planned' ? { planned: true as const } : {}),
                },
              ]
        }),
      }))
    },

    plan(actor, input) {
      return planOf(input, actor.workspace_id, actor.person_id)
    },

    async apply(actor, input) {
      // WP240：分配、范围、岗位安放一律建在**这个人这会儿开着的那个品牌**里
      const ws = actor.workspace_id
      const plan = await planOf(input, ws, actor.person_id)
      // 46 §3 I6：连上 Shopify 的店自动挂上；WP138：一家没连就挂整个品牌（不再挂空）
      const stores = await options.shopifyStores(ws)
      const ranges = wizardRanges(stores, ws)
      const held = new Map(activeOf(actor.person_id, ws).map((a) => [a.role_id, a]))
      const created: OnboardingApplyView['created_assignments'] = []
      const skipped: string[] = []
      for (const role_id of plan.role_ids) {
        if (held.has(role_id)) {
          skipped.push(role_id)
          continue
        }
        const assignment = roles.assignments.create({
          person_id: actor.person_id,
          workspace_id: ws,
          role_id,
          ranges,
          granted_by: actor.person_id,
        })
        created.push({
          id: assignment.id,
          role_id,
          role_name: roles.roles.get(role_id)?.name.zh ?? role_id,
        })
      }
      /*
       * WP240：加的品牌走完了向导（哪怕第 ② 步跳过了网址分析）——建品牌时起的那份影子档案
       * 从此算"设过"，不然下次打开又被拉回向导。
       */
      const shadow = profileOf(ws)
      if (shadow?.provisional === true) {
        const { provisional: _p, ...settled } = shadow
        backend.put(ws, settled)
      }
      // WP251（决策 92）：走完第 ④ 步——加的品牌从此不再被拉回首次设置
      backend.markCompleted(ws, clock.now())
      // WP138：留一条痕——以后要分「向导建的」与「手动分配的」，靠的就是它
      /*
       * WP234（docs/54 §6.2）：给了岗位清单——每一行落成一个岗位行（复用模板或新建自建岗位），
       * 这一次新建的分配安放在它那一行的岗位上。已经持有的跳过、**不挪**它原来的安放。
       */
      const builtPositions: NonNullable<OnboardingApplyView['positions']> = []
      if (input.positions !== undefined && options.positionStore !== undefined) {
        const store = options.positionStore
        const fresh = new Map(created.map((c) => [c.role_id, c.id]))
        /*
         * 已经持有、但**还没安放**的那几条（老分配）：用户在第 ③ 步明说了它归这个岗位，就按他说的
         * 安放——不然它按老规则同时算在模板岗位和这个新岗位里，左栏出两份。已经安放过的不挪。
         */
        const looseHeld = new Map(
          [...held.values()]
            .filter((a) => store.placementOf?.(a.id) === undefined)
            .map((a) => [a.role_id, a.id]),
        )
        for (const item of plan.positions) {
          const source = input.positions.find(
            (p, i) => (p.template_id ?? `custom:${String(i)}`) === item.position_id,
          )
          const id = store.ensure(
            {
              name: item.name,
              role_ids: item.role_ids,
              ...(source?.template_id === undefined ? {} : { template_id: source.template_id }),
            },
            actor.person_id,
          )
          for (const role_id of item.role_ids) {
            const aid = fresh.get(role_id) ?? looseHeld.get(role_id)
            if (aid !== undefined) store.place(aid, id)
          }
          builtPositions.push({ id, name: item.name, role_ids: item.role_ids })
        }
      }
      if (created.length > 0)
        emit(
          'onboarding.applied',
          actor.person_id,
          {
            assignment_ids: created.map((c) => c.id),
            ranges,
            // WP234：建了哪几个岗位（id 与职责；不带他那段原话）
            ...(builtPositions.length === 0
              ? {}
              : { positions: builtPositions.map((p) => ({ id: p.id, role_ids: p.role_ids })) }),
          },
          ws,
        )
      return {
        created_assignments: created,
        skipped,
        ranges: ranges.map((r) => ({ kind: r.kind, id: r.id, label: rangeLabel(r, stores, ws) })),
        plan,
        ...(builtPositions.length === 0 ? {} : { positions: builtPositions }),
      } satisfies OnboardingApplyView
    },

    async suggest(_actor, input) {
      const catalog = catalogOf().map((p) => ({
        id: p.id,
        name: p.name.zh,
        roles: p.roles.map((r) => ({ id: r.role, default: r.default })),
      }))
      const list = catalogRoles(catalog, (id) => {
        const def = roles.roles.get(id)
        // 第二批（planned）的职责不推荐：推荐了也用不上
        if (def === undefined || def.status === 'planned') return undefined
        return { name: def.name.zh, name_en: def.name.en, what_it_does: def.description }
      })
      const out = await suggestPositions({
        text: input.text,
        catalog,
        roles: list,
        suggester: await options.suggester?.(_actor),
      })
      // 原话不进日志（21 §5）：只记来源与条数
      emit(
        'onboarding.suggested',
        _actor.person_id,
        {
          source: out.source,
          roles: out.roles.length,
          positions: out.positions.length,
        },
        _actor.workspace_id,
      )
      return out
    },

    async peers(_actor): Promise<DiscoveryStateView> {
      return discovery.peers()
    },

    async hello(): Promise<DiscoveryHelloView> {
      const { text, members } = await label()
      return { peer_id: discovery.peerId(), workspace_label: text, members }
    },

    invites(_actor): InviteView[] {
      return invites.list()
    },

    createInvite(actor, input): InviteView {
      return invites.create(actor.person_id, input.uses)
    },

    requests(_actor): MembershipRequestView[] {
      return invites.requests()
    },

    request(input: MembershipRequestInput): Promise<MembershipRequestView> {
      return invites.request(input)
    },

    decideRequest(actor, id, input): Promise<MembershipRequestView> {
      return invites.decide(actor.person_id, id, input)
    },

    superseded(input) {
      return invites.supersede(input)
    },
  }

  const backfillWizardRanges = (): { patched: string[] } => {
    if (backend.migrated(WIZARD_RANGE_BACKFILL)) return { patched: [] }
    // 启动时那一下只管启动品牌（老数据只在它身上）
    const stores = options.shopifyStores()
    if (stores instanceof Promise) {
      void stores.catch(() => undefined)
      return { patched: [] }
    }
    const ranges = wizardRanges(stores)
    const patched: string[] = []
    for (const a of activeOf(options.owner)) {
      // 分不出哪条是向导建的（老版本没留痕），所以只认店主自己给自己建的那几条
      if (a.granted_by !== options.owner) continue
      if (a.ranges.length > 0 || (a.range_groups ?? []).length > 0) continue
      if (!needsRanges(a.role_id)) continue
      roles.assignments.update(a.id, { ranges })
      patched.push(a.id)
    }
    if (patched.length > 0)
      emit('assignment.range_backfilled', options.owner, { assignment_ids: patched, ranges })
    backend.markMigrated(WIZARD_RANGE_BACKFILL, clock.now())
    return { patched }
  }

  const reconcileBrandProfiles = (
    brands: { workspace_id: WorkspaceId; name: string }[],
  ): { reopened: WorkspaceId[]; checked: number } => {
    if (backend.migrated(ADDED_BRAND_PROFILE_CHECK)) return { reopened: [], checked: 0 }
    const reopened: WorkspaceId[] = []
    let checked = 0
    for (const brand of brands) {
      if (brand.workspace_id === workspace_id) continue
      const p = profileOf(brand.workspace_id)
      if (p === undefined || p.provisional === true) continue
      checked += 1
      // 用户自己动过的痕迹：市场、地址、按市场的语言——有一样就不碰
      if (
        p.markets !== undefined ||
        p.markets_source !== undefined ||
        p.market_languages !== undefined ||
        p.postal_address !== undefined ||
        p.one_liner !== undefined ||
        p.support_email !== undefined ||
        p.currency !== undefined
      )
        continue
      const used = roles.assignments
        .listByWorkspace(brand.workspace_id)
        .some((a) => a.revoked_at === undefined && a.role_id !== 'common.owner')
      if (used) continue
      backend.put(brand.workspace_id, { ...p, provisional: true })
      reopened.push(brand.workspace_id)
    }
    if (reopened.length > 0)
      emit('workspace.profile_reopened', options.owner, {
        workspace_ids: reopened,
        reason: 'wp240_added_brand_never_set_up',
      })
    backend.markMigrated(ADDED_BRAND_PROFILE_CHECK, clock.now())
    return { reopened, checked }
  }

  return {
    port,
    backfillWizardRanges,
    isAddedBrand,
    reconcileBrandProfiles,
    companyKey: keyOf,
    companyProfile: (ws) => companyFor(ws ?? workspace_id),
    syncCompanyShadows,
    since(key) {
      const at = backend.migratedAt(key)
      if (at !== undefined) return at
      const now = clock.now()
      backend.markMigrated(key, now)
      return backend.migratedAt(key) ?? now
    },
    settleCompanyOnOrganization() {
      if (backend.migrated(COMPANY_ON_ORG)) return { address_moved: false, synced: [] }
      // 没有组织（还没迁过）：什么都不做、也不记下——下次启动组织在了再跑
      if (orgOf(workspace_id) === undefined || options.updateOrganization === undefined)
        return { address_moved: false, synced: [] }
      const at = clock.now()
      backend.backup('wp251', at)
      const brands = options.brandsOfCompany?.(workspace_id) ?? [workspace_id]
      let address_moved = false
      if (orgOf(workspace_id)?.postal_address === undefined) {
        // 公司还没有地址：搬最近存过的那个品牌档案里的那一份（一个品牌都没填过就不搬）
        const latest = brands
          .map((ws) => profileOf(ws))
          .filter(
            (p): p is WorkspaceProfile =>
              p !== undefined && p.postal_address !== undefined && p.postal_address.trim() !== '',
          )
          .sort((a, b) => b.set_at.localeCompare(a.set_at))[0]
        if (latest?.postal_address !== undefined) {
          options.updateOrganization({ postal_address: latest.postal_address }, workspace_id)
          address_moved = true
        }
      }
      const synced = syncCompanyShadows(workspace_id)
      // 地址不进日志（WP176）；全称也不进（21 §5）——只记搬没搬、刷了几个品牌
      appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'workspace.company_settled',
        actor: { kind: 'system', id: 'onboarding' },
        correlation: { trace_id: `tr_onboarding_${at}` },
        payload: { address_moved, synced: synced.length, brands: brands.length },
      })
      backend.markMigrated(COMPANY_ON_ORG, at)
      return { address_moved, synced }
    },
    settleAddedBrandCompletion(brands) {
      if (backend.migrated(ADDED_BRAND_COMPLETION)) return { completed: [] }
      const completed: WorkspaceId[] = []
      const at = clock.now()
      for (const ws of brands) {
        if (ws === workspace_id || backend.completed(ws)) continue
        // 除负责人那一条外有分配 = 已经在用了（走过第 ④ 步，或者在公司页手动分过岗位）
        const used = roles.assignments
          .listByWorkspace(ws)
          .some((a) => a.revoked_at === undefined && a.role_id !== 'common.owner')
        if (!used) continue
        backend.markCompleted(ws, at)
        completed.push(ws)
      }
      backend.markMigrated(ADDED_BRAND_COMPLETION, at)
      return { completed }
    },
    vertical: () => profileOf()?.vertical,
    storefrontPlatform: () => profileOf()?.storefront_platform,
    brandProfile(ws) {
      const p = profileOf(ws)
      return {
        ...(p?.vertical === undefined ? {} : { vertical: p.vertical }),
        ...(p?.storefront_platform === undefined
          ? {}
          : { storefront_platform: p.storefront_platform }),
        ...(p?.markets === undefined ? {} : { markets: [...p.markets] }),
        ...(p?.markets_source === undefined ? {} : { markets_source: p.markets_source }),
        ...(p?.market_languages === undefined
          ? {}
          : { market_languages: { ...p.market_languages } }),
        // WP251：地址是公司级的（读这个品牌挂的那家公司；没有组织才读档案里那一份）
        ...(() => {
          const address = companyFor(ws)?.postal_address
          return address === undefined ? {} : { postal_address: address }
        })(),
        ...(p === undefined ? {} : brandFactsOf(p)),
        ...(p?.currency === undefined ? {} : { currency: p.currency }),
      }
    },
    setBrandFacts(ws, facts) {
      const previous = profileOf(ws)
      if (previous === undefined) return false
      const { one_liner: _o, support_email: _e, currency: _c, ...rest } = previous
      backend.put(ws, { ...rest, ...nextBrandFacts(previous, facts) })
      return true
    },
    setStorefrontPlatform(ws, platform, source) {
      const next = normalizeStorefrontPlatform(platform)
      if (next === undefined) return false
      const previous = profileOf(ws)
      if (previous !== undefined) {
        backend.put(ws, { ...previous, storefront_platform: next })
      } else {
        // 品牌档案还没建过（跳过了首次设置的品牌）：公司已经有名字就用它起一份最小档案，
        // 只多这一格平台；公司还没名字就不替人建（回 false，界面让人先去设置里填公司信息）。
        // 能走到这里的人已经有岗位了（`needs_setup` 本来就是 false），不会把首次设置挡掉。
        const company = companyFor(ws)
        const legal_name = company?.legal_name?.trim() ?? ''
        if (legal_name === '') return false
        backend.put(ws, {
          legal_name,
          ...(company?.domain === undefined ? {} : { domain: company.domain }),
          discoverable: company?.discoverable ?? false,
          storefront_platform: next,
          set_at: clock.now(),
        })
      }
      appendEvent({
        schema_version: 1,
        workspace_id: ws,
        type: 'workspace.storefront_platform_set',
        actor: { kind: 'system', id: 'onboarding' },
        correlation: { trace_id: `tr_onboarding_${clock.now()}` },
        payload: { storefront_platform: next, source },
      })
      return true
    },
    shopifyDomainOf: (ws) => profileOf(ws)?.shopify_domain,
    setShopifyDomain(ws, domain) {
      const value = domain.trim().toLowerCase()
      if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)) return false
      const previous = profileOf(ws)
      if (previous === undefined) return false
      if (previous.shopify_domain === value) return true
      backend.put(ws, { ...previous, shopify_domain: value })
      return true
    },
    setPostalAddress(ws, address) {
      const next = address === undefined ? undefined : normalizePostalAddress(address)
      if (writesCompany(ws)) {
        // WP251：地址是公司的——写组织（对所有品牌生效），各品牌档案里的影子一起刷
        options.updateOrganization?.({ postal_address: next ?? '' }, ws)
        syncCompanyShadows(ws)
      } else {
        const previous = profileOf(ws)
        if (previous === undefined) return false
        const { postal_address: _old, ...rest } = previous
        backend.put(ws, { ...rest, ...(next === undefined ? {} : { postal_address: next }) })
      }
      appendEvent({
        schema_version: 1,
        workspace_id: ws,
        type: 'workspace.postal_address_set',
        actor: { kind: 'system', id: 'onboarding' },
        correlation: { trace_id: `tr_onboarding_${clock.now()}` },
        // 地址不进日志，只记有没有
        payload: { has_address: next !== undefined },
      })
      return true
    },
    setMarkets(ws, list, source) {
      const previous = profileOf(ws)
      if (previous === undefined) return false
      if (previous.markets_source?.from === 'human' && source.from !== 'human') return false
      const markets = normalizeMarkets(list)
      const { markets: _old, markets_source: _src, ...rest } = previous
      backend.put(ws, {
        ...rest,
        ...(markets.length === 0 ? {} : { markets }),
        markets_source: source,
      })
      appendEvent({
        schema_version: 1,
        workspace_id: ws,
        type: 'workspace.markets_set',
        actor: { kind: 'agent', id: `markets_${source.from}` },
        correlation: { trace_id: `tr_onboarding_${clock.now()}` },
        payload: {
          markets,
          from: source.from,
          ...(source.note === undefined ? {} : { note: source.note }),
        },
      })
      return true
    },
    setBrandProfile(ws, input) {
      // WP251：新品牌挂的那家公司（影子照它抄）
      const company = companyFor(ws)
      const previous = profileOf(ws)
      backend.put(ws, {
        // WP240：建品牌那一刻起的这一份不算"设过"——新品牌照样进首次设置
        ...(previous === undefined || previous.provisional === true
          ? { provisional: true as const }
          : {}),
        legal_name: company?.legal_name ?? previous?.legal_name ?? options.workspaceName(),
        ...(company?.domain === undefined ? {} : { domain: company.domain }),
        discoverable: company?.discoverable ?? previous?.discoverable ?? false,
        ...(input.vertical === undefined ? {} : { vertical: input.vertical }),
        ...(input.storefront_platform === undefined
          ? {}
          : { storefront_platform: input.storefront_platform }),
        // WP159：目标市场不归这一步管，沿用档案里的
        ...(previous?.markets === undefined ? {} : { markets: previous.markets }),
        ...(previous?.markets_source === undefined
          ? {}
          : { markets_source: previous.markets_source }),
        ...(previous?.market_languages === undefined
          ? {}
          : { market_languages: previous.market_languages }),
        // WP176：公司实体地址也不归这一步管（WP251：影子照公司抄）
        ...((company?.postal_address ?? previous?.postal_address) === undefined
          ? {}
          : { postal_address: (company?.postal_address ?? previous?.postal_address) as string }),
        // WP248：品牌三格也不归这一步管
        ...(previous === undefined ? {} : nextBrandFacts(previous, {})),
        // WP258：官网读到的店铺地址也不归这一步管
        ...(previous?.shopify_domain === undefined
          ? {}
          : { shopify_domain: previous.shopify_domain }),
        set_at: clock.now(),
      })
    },
    discovery,
    invites,
    close() {
      discovery.close()
      invites.close()
      backend.close()
    },
  }
}

/** WP248（决策 83）：品牌三格的写入形状（不给 = 不改；空串 = 清空）。 */
export interface BrandFactsInput {
  one_liner?: string | undefined
  support_email?: string | undefined
  currency?: string | undefined
}

/** 档案上已经写着的那三格（币种没写过就不出现——读的人按 USD 补）。 */
function brandFactsOf(
  p: Pick<WorkspaceProfile, 'one_liner' | 'support_email'>,
): Pick<WorkspaceProfile, 'one_liner' | 'support_email'> {
  return {
    ...(p.one_liner === undefined ? {} : { one_liner: p.one_liner }),
    ...(p.support_email === undefined ? {} : { support_email: p.support_email }),
  }
}

/** 下一份档案上的三格：给了的按归一化结果（空 = 去掉），没给的沿用上一次。 */
export function nextBrandFacts(
  previous: Pick<WorkspaceProfile, 'one_liner' | 'support_email' | 'currency'> | undefined,
  input: BrandFactsInput,
): Pick<WorkspaceProfile, 'one_liner' | 'support_email' | 'currency'> {
  const pick = (
    given: string | undefined,
    old: string | undefined,
    norm: (v: string) => string | undefined,
  ): string | undefined => (given === undefined ? old : norm(given))
  const one_liner = pick(input.one_liner, previous?.one_liner, normalizeOneLiner)
  const support_email = pick(input.support_email, previous?.support_email, normalizeSupportEmail)
  const currency = pick(input.currency, previous?.currency, normalizeCurrency)
  return {
    ...(one_liner === undefined ? {} : { one_liner }),
    ...(support_email === undefined ? {} : { support_email }),
    ...(currency === undefined ? {} : { currency }),
  }
}

/** 一句话介绍：空白收成一个、去两端，封顶 300 字；空 = 没有。 */
export function normalizeOneLiner(value: string): string | undefined {
  const line = value.replace(/\s+/g, ' ').trim()
  return line === '' ? undefined : line.slice(0, 300)
}

/** 客服邮箱：去两端空白；空或不像邮箱 = 没有（HTTP 那一面已经先挡过一次）。 */
export function normalizeSupportEmail(value: string): string | undefined {
  const v = value.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : undefined
}

/** 币种：三位字母、存大写；别的都当没写。 */
export function normalizeCurrency(value: string): string | undefined {
  const v = value.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(v) ? v : undefined
}

/** WP176：公司实体地址归一化（多余空白收成一个，去两端；空 = 没有）。 */
export function normalizePostalAddress(value: string): string | undefined {
  const v = value
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
  return v === '' ? undefined : v.slice(0, 500)
}

/**
 * WP166：`setProfile` 那一步的目标市场与出处。
 *
 * - 没给 `markets` → 沿用上一次（连出处一起）；
 * - 给了、和上一次一样 → 沿用上一次的出处（设置页原样存一遍不该把「从官网看出来的」改成「你改的」）；
 * - 给了、不一样 → 出处用调用方给的（品牌分析确认时是 `site` / `amazon`），不给就是 `human`；
 * - 上一次是人改的、这一次是自动的 → **不动**（人说了算）。
 */
export function nextMarkets(
  previous: WorkspaceProfile | undefined,
  input: { markets?: string[] | undefined; markets_source?: MarketsSource | undefined },
  at: string,
): { markets?: string[]; markets_source?: MarketsSource } {
  const keep = {
    ...(previous?.markets === undefined ? {} : { markets: previous.markets }),
    ...(previous?.markets_source === undefined ? {} : { markets_source: previous.markets_source }),
  }
  if (input.markets === undefined) return keep
  const markets = normalizeMarkets(input.markets)
  const same =
    previous?.markets !== undefined &&
    previous.markets.length === markets.length &&
    previous.markets.every((m, i) => m === markets[i])
  if (same) return keep
  const source: MarketsSource = input.markets_source ?? { from: 'human', at }
  if (previous?.markets_source?.from === 'human' && source.from !== 'human') return keep
  return { markets, markets_source: source }
}
