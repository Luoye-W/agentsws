/**
 * WP253：建站岗位「网页模板」端到端——**一个品牌一份**的主题工坊（服务端那一半）。
 *
 * 从「用户在建站岗位里说『给我搭个首页』」到「店里出现一个未发布主题可预览」，
 * 每一跳在这里接上：
 *
 * | 这一跳 | 从哪来 |
 * |---|---|
 * | CLI 在哪 | WP245 的私有安装（`<data>/tools/shopify-cli`，用我们自己的 node 起），系统全局的也认 |
 * | 登录态 | WP245 的一键登录（按品牌记一笔时间）；我们不读 CLI 的会话文件，凭据不经我们 |
 * | 店铺地址 | 本品牌的 Shopify 连接（客户端凭据经纪人记的那家店）；没连就用人在岗位页上填的那一个 |
 * | 工作目录 | `<data>/themes/<workspace>/<store>/`（与终端沙箱、变更审阅同一个地方） |
 * | 起底 | WP301（决策 399）：在店里**复制一份 Shopify 官方的 Horizon**（线上就是 Horizon 就复制线上那一份）成未发布主题，`theme pull` 拉下来；工坊不带任何主题代码 |
 * | 目录 | 按这份 Horizon 自带的 schema 现生成 `CATALOG.index.json` / `CATALOG.json`（`horizon-catalog.ts`） |
 * | 选主题 | WP304（决策 445）：第一次起底 / 人说「换主题」→ 出一张**选主题卡**：第一项我们的**高级主题**（付费，按店买断 560 积分，买了从云上下载），其余是店里已装的、能改的**免费主题**（任何 Online Store 2.0，Horizon 仍是默认推荐）；选了服务端起底、再按原话接着做 |
 * | 发布 | **不在这里发**：只出 `publish_theme` 的审批卡；人批了执行器调 {@link SiteThemeAssembly.apply} |
 *
 * 三条纪律：
 *
 * 1. **AI 只拿得到受限的几件事**（`theme-tools.ts` 那九个工具），不是终端；写文件只限工作目录，
 *    以 Horizon 起底时只许改商店层文件：templates / section 组 / config/settings_data.json / locales 店面文案，不改主题核心代码。
 * 2. **线上只有一条路会变**：审批过的 `publish_theme` → {@link SiteThemeAssembly.apply} → `theme publish`。
 * 3. **没装 / 没登录 / 没店铺地址不是异常**，是「还差哪一步」（{@link ThemeReadiness.next}）——岗位页与工具回话同一套话。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
import type { SiteThemeStoreChoice, SiteThemeView } from '@agentsws/api'
import {
  type ApprovalBus,
  type ApprovalItem,
  type Clock,
  type EffectiveConfig,
  HORIZON_THEME_STORE_URL,
  type Mandate,
  type PlatformCliSpec,
  PREMIUM_THEME_PRICE_CREDITS,
  PREMIUM_THEME_PRICE_USD,
  type PremiumThemeStatus,
  type RunRequest,
  type StagedChange,
  type ThemeChoicePayload,
  type ThemePurchasePayload,
} from '@agentsws/contracts'
import { themeWorkspaceRoot } from '@agentsws/dsh-adapter'
import { publishReadiness, type ThemeSummaryLike, themeLanes } from '@agentsws/site-core'
import type { ThemeNeed } from '@agentsws/stand-ins'
import type { BackendResult, StageInput, StageOutcome } from '@agentsws/txn'
import {
  buildThemeCatalog,
  CATALOG_FILE,
  CATALOG_INDEX_FILE,
  catalogIndexOf,
  isHorizon,
  isLayoutJson,
  isLegacyTheme,
  isOs2Templates,
  type ThemeCatalog,
  type ThemeInfo,
  templateProblems,
  themeInfoOf,
} from './horizon-catalog.js'
import type { PlatformCliProbe } from './platform-cli.js'
import {
  extractThemePackage,
  PREMIUM_NOT_LINKED_TEXT,
  PREMIUM_OFFLINE_TEXT,
  PREMIUM_SOON_TEXT,
  type PremiumThemeClient,
  PremiumThemeError,
} from './premium-theme.js'
import { normalizeShopDomain } from './shopify-broker.js'
import {
  createRunCli,
  createShopifyTheme,
  PASSTHROUGH_ENV,
  type PushedTheme,
  type RunCli,
  type ShopifyTheme,
  ShopifyThemeError,
  scrubCliOutput,
  type ThemeCheckResult,
  type ThemeSummary,
} from './shopify-theme.js'
import {
  isThemeUpgradeCard,
  LEGACY_UPGRADE_CARD_VOID,
  legacyMovedNote,
  legacyThemeNotice,
  legacyThemeRefusal,
} from './site-theme-legacy.js'

/**
 * WP301（决策 399 = A）：起底用的是**店里那一份 Shopify 官方 Horizon**（复制成未发布主题再拉下来），工坊不带、不下载
 * 任何主题代码。Horizon 的许可（Shopify/horizon 仓库 LICENSE.md）只许用它开发与 Shopify 配合的主题，不许把它或由它
 * 衍生的主题拿去分发 / 上架；给商家在**他自己的店里**用可以——我们正是只在商家自己的店里复制、改他那一份。
 */
export const HORIZON_BASE = {
  repo: 'Shopify/horizon',
  license: 'Shopify Horizon license（只在这家店里用；不分发）',
} as const

/**
 * WP304（决策 445）：我们自己的**高级主题**（付费；按店买断，从云上私有存储下载）。工作目录里记的「底」。
 * 它的代码不在开源仓、不进安装包；只进这家店的工作目录与这家店。
 */
export const PREMIUM_BASE = {
  repo: 'agentsws-premium',
  name: '高级主题',
  license: 'Agents 工坊高级主题（按店授权，只在这家店里用；不分发）',
} as const

/** WP304：店里那一份不是 Horizon 的免费主题（任何 Online Store 2.0）时记的「底」。 */
export const STORE_THEME_BASE = {
  repo: 'shopify-theme-store',
  license: '主题商店的主题（只在这家店里用；不分发）',
} as const

/** WP304：人选的那一份是老主题（不是 Online Store 2.0）。 */
export const tooOldText = (name: string): string =>
  `「${name}」是老一代的 Shopify 主题（没有 JSON 模板，不是 Online Store 2.0），工坊改不了。建议到主题商店免费加一份 Horizon（${HORIZON_THEME_STORE_URL}），加好再选它。`

/** WP304：出了选主题卡之后，工具回话里那一句。 */
export const THEME_CHOICE_ASKED_TEXT =
  '出了一张选主题卡（高级主题排第一，也可以用店里已装的免费主题）。等人选好，工坊会起好底、接着按原话做；这次先停在这儿，照实跟人说一声。'

/** 店里一份 Horizon 都没有时说的那句话。 */
export const NO_HORIZON_TEXT =
  '店里还没有 Shopify 官方的 Horizon 主题（线上那一份和未发布的几份都不是）。请到 Shopify 后台「在线商店 → 主题」点「添加主题」，' +
  '从主题商店免费添加 Horizon（不用发布），加好跟我说一声，我在它的副本上接着做。'

/** 店里主题满了（Shopify 一家店最多存 20 份）。 */
export const THEMES_FULL_TEXT =
  '店里的主题满了（Shopify 一家店最多存 20 份），请到后台「在线商店 → 主题」删掉一两份不用的未发布主题，再让我起底。'

/** 店铺主题认的几个目录（`theme push` 只传这些；AI 也只许写这些）。 */
export const THEME_DIRS = [
  'assets',
  'blocks',
  'config',
  'layout',
  'locales',
  'sections',
  'snippets',
  'templates',
] as const

/** 写得进去的文件类型。 */
const WRITABLE_EXT = /\.(liquid|json|css|js|svg|txt)$/i
/** 单个文件读 / 写的上限。 */
export const MAX_THEME_FILE_BYTES = 512 * 1024
/**
 * WP260：**读**的上限另算——真主题 v0.9.1 的 `CATALOG.json` 已经 50 万字节，v0.10.0 是 102 万字节（WP296 实测）；
 * 读回来的东西不会整份进模型（`theme-read.ts` 按页 / 按目录切），所以读放到 4 MB。写照旧 512 KB。
 */
export const MAX_THEME_READ_BYTES = 4 * 1024 * 1024

/**
 * WP301：以 Horizon 起底时**只许改**的商店层文件——JSON 模板（`templates/**.json`）、section 组（`sections/*.json`，
 * 页头页尾）、`config/settings_data.json`、`locales/*.json` 店面文案（`.schema.json` 是编辑器标签，属于主题核心）。
 * `.liquid` / CSS / JS 都是 Horizon 的核心代码，不改；要一小段自定义代码用主题自带的 custom-liquid 分区 / 块。
 */
export function baseWritable(rel: string): boolean {
  if (/^templates\/.+\.json$/.test(rel)) return true
  if (rel === 'config/settings_data.json') return true
  if (/^sections\/[^/]+\.json$/.test(rel)) return true
  if (/^locales\/[^/]+\.json$/.test(rel)) return !rel.endsWith('.schema.json')
  return false
}

export interface ThemePushRecord {
  theme_id: string
  theme_name: string
  preview_url?: string
  at: string
  changed_files: string[]
}

/** 这家店的工作目录是从哪一份起的底（WP301 起是 Horizon；旧的自带主题那一份读进来照实认）。 */
interface StoreBase {
  repo: string
  version: string
  commit: string
  license: string
  at: string
  /** WP301：`theme_info.theme_name`（Horizon）。 */
  theme_name?: string
  /** WP301：从店里哪一份复制的（线上那一份 / 某份未发布的）。 */
  source_theme_id?: string
  /** WP301：复制出来的那一份未发布主题（预览就推到它上面）。 */
  copy_theme_id?: string
  /** WP304：从哪来——店里的免费主题 / 我们的高级主题（老记录没有这一格 = 店里的）。 */
  source?: 'store' | 'premium'
  /** WP304：是人在选主题卡上选的（选完接着做的那一次运行再叫起底，就用这一份，不再出卡、不再起）。 */
  chosen?: boolean
}

interface StoreState {
  base?: StoreBase
  /** 起底 / 拉下来那一刻每个主题文件的 sha256（算「改了哪些文件」用）。 */
  baseline?: Record<string, string>
  pushes: ThemePushRecord[]
  /** WP301：起底时在店里复制出来的那一份（第一次推预览推到它上面，改成人起的名字）。 */
  copy?: {
    theme_id: string
    name: string
    source_theme_id: string
    source_name: string
    at: string
  }
  /** WP301：旧的自带主题那几份工作目录挪去了哪（不删、不迁）。 */
  legacy?: { version?: string; moved_to: string; at: string }[]
  /** WP304：还在等人选的那张选主题卡 / 买高级主题卡（不重复出）。 */
  choice_card_id?: string
  purchase_card_id?: string
}

/** WP301：工具回话里带给模型的那一句（这份工作目录是旧的自带主题）。 */
export interface ThemeLegacyNotice {
  theme: 'agentsws-theme'
  version?: string
  message: string
}

/**
 * WP258：登录后在这个 Shopify 账号下找到的店（存在设置文件里，岗位页下拉框用；`need_login` 不给界面看原文）。
 */
export interface StoreLookupState {
  status: 'ok' | 'none' | 'failed'
  stores: SiteThemeStoreChoice[]
  checked_at: string
  message?: string
  /** 命令说的是「没登录 / 会话过期」——岗位页那一行回到「登录 Shopify」。 */
  need_login?: boolean
}

interface SettingsFile {
  version: 1
  /** 这个品牌建站用的店铺地址（没连店时用）。 */
  store?: string
  /**
   * WP258：这个地址是怎么来的。`manual` = 人手填的（**永远不被自动覆盖**；WP253 时存下的老地址没有这一格，
   * 一律当手填）；`cli` = 登录后自动取的（账号下只有一家，或与官网对上）；`picked` = 人从下拉框里选的。
   */
  store_by?: 'manual' | 'cli' | 'picked'
  /** WP258：最近一次找店的结果。 */
  lookup?: StoreLookupState
  stores: Record<string, StoreState>
}

/** 「还差哪一步」的那一份（岗位页与工具回话同一套判断；形状就是 `/v1/site/theme` 回的那一份）。 */
export type ThemeReadiness = SiteThemeView

export interface SiteThemeOptions {
  workspace_id: string
  clock: Clock
  /** 数据根目录（主题工作副本在 `<dataDir>/themes/<workspace>/<store>/`）。 */
  dataDir: string
  /** 设置文件（店铺地址、起底版本、推过哪些副本）；不给 = 只在内存里。 */
  settingsFile?: string
  /** 这个品牌的平台的 CLI 那一行（不是 Shopify 的品牌 = undefined）。 */
  cliSpec(): PlatformCliSpec | undefined
  probe(spec: PlatformCliSpec, fresh?: boolean): Promise<PlatformCliProbe>
  /** WP245 一键登录按品牌记的那一笔（登好了 = true）。 */
  loggedIn(cli_id: string): boolean
  /** WP253：这个品牌那一份 CLI 会话的环境变量（一个品牌一份会话，见 `platform-cli-session.ts`）。 */
  sessionEnv?(cli_id: string): Record<string, string> | undefined
  /** 怎么起 CLI（私有安装 → `<node> <入口>`；系统里的 → `shopify`）。 */
  invocation(spec: PlatformCliSpec): { command: string; prefix: readonly string[] }
  /** 这个品牌接管的店（连接页那一条）。 */
  connectedShops(): string[]
  /** WP258：品牌档案里官网读到的那个 `xxx.myshopify.com`（找到好几家店时拿它对一下）。 */
  siteStore?(): string | undefined
  env?: NodeJS.ProcessEnv
  /** 测试 / 演示注入假 CLI。 */
  run?: RunCli
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  effectiveConfig(assignment_id: string): EffectiveConfig
  /** 「预览好了」进事项时间线（有事项时）。 */
  notePreview?(
    matter_id: string,
    input: {
      text: string
      url: string
      label: string
      /** WP264：结果卡上的「改了几个文件」「检查 0 错 0 警」与副本 id。 */
      theme_id?: string
      changed_files?: string[]
      check?: { errors: number; warnings: number }
    },
  ): void
  appendEvent?(type: string, payload: Record<string, unknown>): void
  /** 在事项时间线上记一句（WP301：在 Horizon 上新起了一份、旧升级卡作废了）。 */
  noteMatter?(matter_id: string, text: string): void
  /** WP304：出选主题卡 / 买高级主题卡用的审批总线（不给 = 不出卡，起底照 WP301 自己挑一份）。 */
  approvals?(): ApprovalBus | undefined
  /** WP304：卡挂到事项上（事项页里看得到这张卡）。 */
  onCard?(item: ApprovalItem): void
  /** WP304：高级主题的云端那一半（不给 = 卡上「即将开放」）。 */
  premium?: PremiumThemeClient
  /** WP304：选好主题、起好底之后按这件事原来那段话接着跑一次。 */
  resume?(input: { matter_id: string; person_id: string; assignment_id: string }): Promise<void>
}

export class SiteThemeError extends Error {
  constructor(
    readonly code:
      | 'needs'
      | 'invalid_input'
      | 'outside'
      | 'integrity'
      | 'network'
      | 'cli'
      /** WP301：店里一份 Horizon 都没有。 */
      | 'no_horizon'
      /** WP304：人选的那一份是老主题（不是 Online Store 2.0）。 */
      | 'too_old'
      /** WP304：高级主题那一跳没走通（即将开放 / 没登录 / 积分不够 / 包不对）。 */
      | 'premium',
    message: string,
    readonly need?: ThemeNeed,
  ) {
    super(message)
    this.name = 'SiteThemeError'
  }
}

/** 每一步差什么时说的那句话（岗位页上有对应的一键按钮）。 */
export const NEED_TEXT: Readonly<Record<ThemeNeed, string>> = {
  install_cli: '这台电脑还没装 Shopify CLI。请到建站岗位页点「一键安装」，装好再让我接着做。',
  node: 'Shopify CLI 要的 Node 版本不够。请到建站岗位页点「一键安装」装一份工作台自己用的。',
  login: '还没登录 Shopify。请到建站岗位页点「登录 Shopify」，在浏览器里登好再让我接着做。',
  store:
    '还不知道是哪家店。请到建站岗位页填上店铺地址（xxx.myshopify.com），或者在连接页把店接上。',
}

/** WP258：找过店之后「还不知道是哪家店」的两种更具体的说法。 */
export const STORE_LOOKUP_TEXT = {
  none: '这个 Shopify 账号下没有店铺。请到建站岗位页换个账号登录，或者先去 Shopify 开店。',
  pick: '这个 Shopify 账号下有好几家店。请到建站岗位页选一家，我再接着做。',
  failed: '没能从 Shopify 找到你的店铺，可以在建站岗位页手动填一下店铺地址（xxx.myshopify.com）。',
  /** WP267（决策 164）：账号下只有一家，但不是官网那一家。 */
  mismatch: '官网那家店不在这个 Shopify 账号下。请到建站岗位页换个账号登录，或者点「就用这家」。',
} as const

export interface SiteThemeAssembly {
  readiness(opts?: { fresh?: boolean }): Promise<ThemeReadiness>
  /** `source: 'list'`（WP258）= 从登录账号下找到的店里选的（必须在清单里）；不给 = 人手填的。 */
  setStore(raw: string, opts?: { source?: 'manual' | 'list' | undefined }): Promise<ThemeReadiness>
  /**
   * WP258：现找一次这个账号下的店（`relogin` = 刚登录 / 换了账号：自动取的、选的那家不在新账号下就清掉）。
   * 不是 Shopify / 没装 / 没登录 / CLI 不会找店 → 什么都不做。
   */
  refreshStores(opts?: { relogin?: boolean }): Promise<StoreLookupState | undefined>
  /**
   * WP301：起底 = 在店里复制一份 Shopify 官方 Horizon（线上那一份是 Horizon 就复制它，不是就找店里已加的 Horizon），
   * 拉到工作目录，按它的 schema 生成目录。线上一个字节不动。旧的自带主题那份工作目录挪到一边（不删）。
   */
  initFromBase(input: {
    replace?: boolean
    /** 哪一次运行起的底（挪开了旧目录时往它的事项时间线记一句）。 */
    request?: RunRequest
    /**
     * WP304：从哪来。`store` = 店里的免费主题（给了 `theme_id` 就是那一份，不给按 Horizon 优先挑）；
     * `premium` = 我们的高级主题（这家店买过才下得下来）。不给 = `store`（WP301 的老路）。
     */
    source?: 'store' | 'premium' | undefined
    theme_id?: string | undefined
    /** WP304：选主题卡选完起底时，往哪件事的时间线记（没有运行请求）。 */
    matter_id?: string | undefined
    /** WP304：人在选主题卡上选的（记下来：接着做的那次运行再叫起底就用这一份）。 */
    chosen?: boolean | undefined
  }): Promise<{
    base: { repo: string; version: string; commit: string; license: string }
    theme: { name: string; version?: string }
    /** 从店里哪一份复制的。 */
    source: { theme_id: string; name: string; live: boolean }
    /** 复制出来的那一份未发布主题。 */
    copy: { theme_id: string; name: string; preview_url: string }
    files: number
    moved_aside: boolean
    /** 挪开的是旧的自带主题那一份。 */
    legacy_moved?: boolean
    catalog: { sections: number; blocks: number }
    /** WP304：这一份是我们的高级主题（下载下来、已推成一份未发布预览）。 */
    premium?: boolean
    /** WP304：人刚在选主题卡上选好、起好了底，这一次没再起（接着在它上面做）。 */
    reused?: boolean
  }>
  /**
   * WP304（决策 445）：要不要先出一张**选主题卡**。第一次起底（工作目录空的）或人说「换主题」（`replace`）时出：
   * 高级主题排第一，其余是店里已装的、能改的免费主题。出了 → 回这张卡；不该出（已经起过底、
   * 没接审批总线、刚选好还没推过）→ `undefined`，照老路起底。WP311（决策 480）：旧的自带主题那一份工作目录也出。
   */
  askThemeChoice?(input: { replace?: boolean; request?: RunRequest }): Promise<
    | {
        approval_item_id: string
        premium: PremiumThemeStatus
        store_themes: number
        message: string
      }
    | undefined
  >
  /** WP304：选主题卡 / 买高级主题卡被决定了 → 起底（下载 / 买）、记时间线、按原话接着做。别的卡什么都不做。 */
  onThemeCardDecided?(item: ApprovalItem): Promise<void>
  list(): Promise<ThemeSummary[]>
  /** WP418（自查 A17）：最近一次列出来的那一份（同步读，不跑 CLI；没列过 = 空）。 */
  lastListed?(): ThemeSummary[]
  pull(input: { theme_id?: string }): Promise<{ files: number }>
  check(): Promise<ThemeCheckResult>
  files(dir?: string): Promise<{ files: string[]; truncated: boolean }>
  readFile(path: string): Promise<{ path: string; content: string }>
  writeFile(
    path: string,
    content: string,
  ): Promise<{
    path: string
    bytes: number
    created: boolean
    /** WP301：模板 / section 组对着目录查出来的问题（只提醒、不拦；空就没有这一格）。 */
    problems?: string[]
  }>
  push(input: { name: string; request?: RunRequest }): Promise<ThemePushRecord>
  proposePublish(input: { theme_id: string; request: RunRequest }): Promise<{
    status: 'staged' | 'blocked'
    message: string
    change_id?: string
    approval_item_id?: string
  }>
  /** 执行器批过的 `publish_theme`（不是这个品牌的 / 不是这一类回 undefined）。 */
  apply(change: StagedChange): Promise<BackendResult | undefined>
  /**
   * WP301：这份工作目录是旧的自带主题（agentsws-theme）吗？是 → 回一句给模型照实说（工具回话每次都带）。
   * 不是 / 还不知道是哪家店 → undefined。**不迁、不删。**
   */
  legacyNotice(): Promise<ThemeLegacyNotice | undefined>
  /** WP296 出过的旧升级卡被决定了：什么都不升，只在事项时间线记一句「作废了」。别的卡什么都不做。 */
  onUpgradeDecided(item: ApprovalItem): Promise<void>
}

/** WP258：找店命令没跑成（`detail` 是抹过令牌的输出，只用来判断是哪一种失败，不给人看）。 */
class StoreLookupFailure extends Error {
  constructor(readonly detail: string) {
    super('store lookup failed')
    this.name = 'StoreLookupFailure'
  }
}

/** CLI 说的是「没登录 / 会话过期」。 */
const LOGIN_HINT =
  /not logged in|log ?in again|auth login|session (?:has )?expired|unauthori[sz]ed|\b401\b|reauthenticat/i

/** `store list --json` 的一行 → 下拉框的一行（不是 `xxx.myshopify.com` 的不要）。 */
export function storeChoiceOf(row: unknown, orgName?: string): SiteThemeStoreChoice | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const r = row as Record<string, unknown>
  if (typeof r.store !== 'string') return undefined
  let store: string
  try {
    store = normalizeShopDomain(r.store)
  } catch {
    return undefined
  }
  if (!store.endsWith('.myshopify.com')) return undefined
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 120) : undefined
  const name = text(r.name)
  const plan = text(r.plan)
  const organization = text(r.organizationName) ?? text(orgName)
  return {
    store,
    ...(name === undefined ? {} : { name }),
    ...(plan === undefined ? {} : { plan }),
    ...(organization === undefined ? {} : { organization }),
  }
}

/** `organization list --json` 的一行 → 组织 id（只认纯数字，或 `gid://shopify/Organization/<数字>`）。 */
function orgOf(row: unknown): { id: string; name?: string } | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const r = row as Record<string, unknown>
  const raw = typeof r.id === 'number' ? String(r.id) : typeof r.id === 'string' ? r.id : undefined
  const gid = typeof r.gid === 'string' ? /\/(\d+)$/.exec(r.gid)?.[1] : undefined
  const id = raw !== undefined && /^\d{1,20}$/.test(raw) ? raw : gid
  if (id === undefined) return undefined
  return { id, ...(typeof r.name === 'string' ? { name: r.name } : {}) }
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

/** 主题文件（只看主题那几个目录，跳过点开头的）。 */
function themeFiles(root: string): string[] {
  const out: string[] = []
  for (const top of THEME_DIRS) {
    const dir = join(root, top)
    if (!existsSync(dir)) continue
    const walk = (d: string): void => {
      for (const name of readdirSync(d).sort()) {
        if (name.startsWith('.')) continue
        const full = join(d, name)
        const st = lstatSync(full)
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) walk(full)
        else if (st.isFile()) out.push(relative(root, full).split(sep).join('/'))
      }
    }
    walk(dir)
  }
  return out
}

function manifestOf(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of themeFiles(root)) out[rel] = sha256(readFileSync(join(root, rel)))
  return out
}

/** 相对基线改了哪些（新增 / 改动 / 删除都算），按路径排序。 */
export function changedFiles(
  baseline: Record<string, string> | undefined,
  now: Record<string, string>,
): string[] {
  if (baseline === undefined) return Object.keys(now).sort()
  const out = new Set<string>()
  for (const [rel, hash] of Object.entries(now)) if (baseline[rel] !== hash) out.add(rel)
  for (const rel of Object.keys(baseline)) if (now[rel] === undefined) out.add(rel)
  return [...out].sort()
}

/**
 * AI 给的相对路径 → 工作目录里的绝对路径。出不去：绝对路径、`..`、盘符、点开头的目录一律拒；
 * 已有的路径再按真实路径（symlink 解开之后）判一次是不是还在根里面。
 */
export function resolveInside(root: string, raw: string): { abs: string; rel: string } {
  const clean = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (clean === '' || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.includes('\0'))
    throw new SiteThemeError('outside', `路径「${raw}」不在主题工作目录里（要给相对路径）`)
  const parts = clean.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..' || p.startsWith('.')))
    throw new SiteThemeError('outside', `路径「${raw}」出了主题工作目录，或者是隐藏目录，不许碰`)
  const rel = parts.join('/')
  const abs = normalize(join(root, ...parts))
  const realRoot = realpathSync(root)
  // 一路往上找到第一个存在的祖先，按真实路径判（防 symlink 把写操作带出去）
  let probe = abs
  while (!existsSync(probe) && probe !== root) probe = dirname(probe)
  const realProbe = realpathSync(probe)
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep))
    throw new SiteThemeError('outside', `路径「${raw}」指到了主题工作目录外面，不许碰`)
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink())
    throw new SiteThemeError('outside', `「${raw}」是一个链接，不许碰`)
  return { abs, rel }
}

export function createSiteTheme(options: SiteThemeOptions): SiteThemeAssembly {
  const ws = options.workspace_id
  const now = (): string => options.clock.now()
  const emit = (type: string, payload: Record<string, unknown>): void =>
    options.appendEvent?.(type, payload)

  // ── 设置文件 ─────────────────────────────────────────────────────────
  let settings: SettingsFile = { version: 1, stores: {} }
  if (options.settingsFile !== undefined && existsSync(options.settingsFile)) {
    try {
      const raw = JSON.parse(readFileSync(options.settingsFile, 'utf8')) as Partial<SettingsFile>
      const by = raw.store_by
      const lookup = raw.lookup
      settings = {
        version: 1,
        ...(typeof raw.store === 'string' ? { store: raw.store } : {}),
        ...(by === 'manual' || by === 'cli' || by === 'picked' ? { store_by: by } : {}),
        ...(lookup !== undefined &&
        typeof lookup === 'object' &&
        Array.isArray(lookup.stores) &&
        typeof lookup.checked_at === 'string'
          ? { lookup }
          : {}),
        stores: raw.stores !== undefined && typeof raw.stores === 'object' ? raw.stores : {},
      }
    } catch {
      // 坏文件当没有：最坏是岗位页上再填一次店铺地址
    }
  }
  const save = (): void => {
    if (options.settingsFile === undefined) return
    mkdirSync(dirname(options.settingsFile), { recursive: true })
    writeFileSync(options.settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  }
  /** WP264：每家店最近一次主题检查的结论（只在内存里；改了文件就作废）。 */
  const lastCheck = new Map<string, { errors: number; warnings: number }>()
  const stateOf = (shop: string): StoreState => {
    const found = settings.stores[shop]
    if (found !== undefined) return found
    const fresh: StoreState = { pushes: [] }
    settings.stores[shop] = fresh
    return fresh
  }

  // ── 店铺地址 ─────────────────────────────────────────────────────────
  /** WP258：存下的地址是怎么来的（WP253 存的老地址没有 `store_by`，当手填）。 */
  const storeBy = (): SettingsFile['store_by'] =>
    settings.store === undefined ? undefined : (settings.store_by ?? 'manual')

  const storeOf = (): { store: string; source: 'connection' | 'manual' | 'cli' } | undefined => {
    const shops = options.connectedShops()
    if (shops.length > 0) {
      const manual = settings.store
      const pick = manual !== undefined && shops.includes(manual) ? manual : shops[0]
      return pick === undefined ? undefined : { store: pick, source: 'connection' }
    }
    if (settings.store === undefined) return undefined
    return { store: settings.store, source: storeBy() === 'manual' ? 'manual' : 'cli' }
  }

  const rootOf = (shop: string): string => {
    const dir = themeWorkspaceRoot(options.dataDir, ws, shop)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  const cliFor = (spec: PlatformCliSpec): ShopifyTheme =>
    createShopifyTheme({
      clock: options.clock,
      workdir: options.dataDir,
      workspaceDir: rootOf,
      ...(options.env === undefined ? {} : { env: options.env }),
      // 凭据只在 CLI 自己的会话里（一键登录）；我们这一侧一个令牌都不拿
      tokenFor: () => undefined,
      sessionLogin: () => options.loggedIn(spec.id),
      sessionEnv: () => options.sessionEnv?.(spec.id),
      cli: () => options.invocation(spec),
      ...(options.run === undefined ? {} : { run: options.run }),
      appendEvent: (type, payload) => emit(type, { ...payload, workspace_id: ws }),
    })

  // ── WP258：登录后自动找店 ───────────────────────────────────────────

  /** 找店那两条命令的环境：与主题命令同一个白名单 + 本品牌那一份会话；不带店铺、不带任何令牌。 */
  const lookupEnv = (spec: PlatformCliSpec): Record<string, string> => {
    const env = options.env ?? process.env
    const out: Record<string, string> = {}
    for (const key of PASSTHROUGH_ENV) {
      const value = env[key]
      if (typeof value === 'string') out[key] = value
    }
    // 非交互：CLI 要问「选哪个组织」时直接报错，不会卡住等输入
    out.CI = '1'
    Object.assign(out, spec.telemetry_off_env)
    Object.assign(out, options.sessionEnv?.(spec.id) ?? {})
    return out
  }

  /** 跑一条找店命令；非零退出码 → 抛（带抹过的输出，只用来判断是哪一种失败）。 */
  const lookupRun = async (spec: PlatformCliSpec, args: readonly string[]): Promise<unknown> => {
    const run = options.run ?? createRunCli(() => options.invocation(spec))
    const cwd = join(options.dataDir, 'theme-work', ws)
    mkdirSync(cwd, { recursive: true })
    const result = await run(args, { cwd, env: lookupEnv(spec), timeoutMs: 90_000 })
    emit('site_theme.store_lookup_command', {
      workspace_id: ws,
      command: args.slice(0, 2).join(' '),
      exit_code: result.code,
    })
    if (result.code !== 0)
      throw new StoreLookupFailure(scrubCliOutput(`${result.stdout}\n${result.stderr}`))
    const at = result.stdout.search(/[[{]/)
    if (at < 0) throw new StoreLookupFailure('no json')
    try {
      return JSON.parse(result.stdout.slice(at)) as unknown
    } catch {
      throw new StoreLookupFailure('bad json')
    }
  }

  /**
   * 这个账号下有哪几家店：先 `store list --json`（只有一个组织时 CLI 自己选，一条命令就够）；
   * CLI 说「好几个组织、非交互要给组织 id」再 `organization list --json`，逐个组织列（组织 id 只认纯数字）。
   */
  const lookupStores = async (spec: PlatformCliSpec): Promise<StoreLookupState> => {
    const how = spec.store_lookup
    const at = now()
    if (how === undefined) return { status: 'failed', stores: [], checked_at: at }
    const found = new Map<string, SiteThemeStoreChoice>()
    let unresolved = false
    const collect = (out: unknown, orgName?: string): void => {
      const o = (typeof out === 'object' && out !== null ? out : {}) as Record<string, unknown>
      if (typeof o.notice === 'string' && /resolve a shopify account/i.test(o.notice))
        unresolved = true
      const org = o.organization as { name?: unknown } | undefined
      for (const row of Array.isArray(o.stores) ? o.stores : []) {
        const choice = storeChoiceOf(row, typeof org?.name === 'string' ? org.name : orgName)
        if (choice !== undefined && !found.has(choice.store)) found.set(choice.store, choice)
      }
    }
    try {
      try {
        collect(await lookupRun(spec, how.stores_args))
      } catch (e) {
        if (!(e instanceof StoreLookupFailure) || !/organization[ -]id/i.test(e.detail)) throw e
        // 好几个组织：先列组织，再逐个组织列店（最多 10 个组织）
        const orgsOut = (await lookupRun(spec, how.organizations_args)) as {
          organizations?: unknown
        }
        const orgs = (Array.isArray(orgsOut?.organizations) ? orgsOut.organizations : [])
          .map(orgOf)
          .filter((x): x is { id: string; name?: string } => x !== undefined)
          .slice(0, 10)
        if (orgs.length === 0) throw e
        for (const org of orgs)
          collect(
            await lookupRun(spec, [...how.stores_args, how.organization_flag, org.id]),
            org.name,
          )
      }
    } catch (e) {
      if (e instanceof ShopifyThemeError && e.code === 'cli_missing')
        return { status: 'failed', stores: [], checked_at: at, message: NEED_TEXT.install_cli }
      const detail = e instanceof StoreLookupFailure ? e.detail : ''
      if (LOGIN_HINT.test(detail))
        return {
          status: 'failed',
          stores: [],
          checked_at: at,
          message: NEED_TEXT.login,
          need_login: true,
        }
      return { status: 'failed', stores: [], checked_at: at, message: STORE_LOOKUP_TEXT.failed }
    }
    if (found.size === 0 && unresolved)
      return {
        status: 'failed',
        stores: [],
        checked_at: at,
        message: NEED_TEXT.login,
        need_login: true,
      }
    const stores = [...found.values()].sort((a, b) => a.store.localeCompare(b.store))
    return stores.length === 0
      ? { status: 'none', stores: [], checked_at: at }
      : { status: 'ok', stores, checked_at: at }
  }

  /**
   * 找完之后定店：**手填的永远不动**；自动取的 / 人选的那家不在这个账号下了（换了账号）就清掉；
   * 只有一家 → 就它（WP267 决策 164：但官网读到的店不是它 → 不自动定，岗位页问「换个账号 / 就用这家」）；
   * 好几家 → 与官网读到的那个对上就默认选它，对不上就等人在下拉框里选。
   */
  const settle = (lookup: StoreLookupState): void => {
    settings.lookup = lookup
    const by = storeBy()
    if (by === 'manual') return
    if (by !== undefined) {
      if (lookup.status === 'failed') return
      if (lookup.stores.some((s) => s.store === settings.store)) return
      delete settings.store
      delete settings.store_by
    }
    if (lookup.status !== 'ok') return
    const site = options.siteStore?.()
    const match = site === undefined ? undefined : lookup.stores.find((s) => s.store === site)
    // 只有一家：官网读到了别的店（多半登错了账号）就不替人定
    const only = lookup.stores.length === 1 ? lookup.stores[0] : undefined
    const pick =
      only !== undefined ? (site === undefined || match !== undefined ? only : undefined) : match
    if (pick === undefined) return
    settings.store = pick.store
    settings.store_by = 'cli'
    emit('site_theme.store_auto', {
      workspace_id: ws,
      stores: lookup.stores.length,
      matched_site: match !== undefined,
    })
  }

  let lookupInFlight: Promise<StoreLookupState | undefined> | undefined
  const refreshStores = (
    opts: { relogin?: boolean } = {},
  ): Promise<StoreLookupState | undefined> => {
    if (lookupInFlight !== undefined) return lookupInFlight
    const spec = options.cliSpec()
    if (spec?.store_lookup === undefined) return Promise.resolve(undefined)
    if (options.connectedShops().length > 0) return Promise.resolve(undefined)
    if (!options.loggedIn(spec.id)) return Promise.resolve(undefined)
    // 手填过的永远以手填为准（不去找，也就不会被覆盖）
    if (storeBy() === 'manual') return Promise.resolve(undefined)
    lookupInFlight = (async () => {
      const probe = await options.probe(spec)
      if (!probe.installed || !probe.node_ok) return undefined
      const lookup = await lookupStores(spec)
      settle(lookup)
      save()
      emit('site_theme.store_lookup', {
        workspace_id: ws,
        status: lookup.status,
        stores: lookup.stores.length,
        ...(lookup.need_login === true ? { need_login: true } : {}),
        ...(opts.relogin === true ? { after_login: true } : {}),
      })
      return lookup
    })().finally(() => {
      lookupInFlight = undefined
    })
    return lookupInFlight
  }

  /** 什么时候顺手找一次：没找过、`fresh`、或上次没找成且过了 5 分钟。手填过 / 连了店就不找。 */
  const shouldLookup = (fresh: boolean): boolean => {
    if (storeBy() === 'manual') return false
    const last = settings.lookup
    if (last === undefined) return true
    if (fresh) return true
    return last.status === 'failed' && Date.parse(now()) - Date.parse(last.checked_at) > 5 * 60_000
  }

  const readiness = async (opts: { fresh?: boolean } = {}): Promise<ThemeReadiness> => {
    const spec = options.cliSpec()
    const probe = spec === undefined ? undefined : await options.probe(spec, opts.fresh === true)
    const cliOk = probe?.installed === true && probe.node_ok
    // WP258：登好了、没连店、没手填 → 顺手找一次这个账号下的店（找过就用存下的那一份）
    if (
      spec?.store_lookup !== undefined &&
      cliOk &&
      options.connectedShops().length === 0 &&
      options.loggedIn(spec.id) &&
      (lookupInFlight !== undefined || shouldLookup(opts.fresh === true))
    )
      await refreshStores()
    const store = storeOf()
    const state = store === undefined ? undefined : settings.stores[store.store]
    const files =
      store === undefined || !existsSync(themeWorkspaceRoot(options.dataDir, ws, store.store))
        ? 0
        : themeFiles(themeWorkspaceRoot(options.dataDir, ws, store.store)).length
    const lookup =
      store?.source === 'connection' || store?.source === 'manual' ? undefined : settings.lookup
    const site = options.siteStore?.()
    // WP301：工作目录还是旧的自带主题那一份 → 照实标出来（岗位页 / 工具回话同一个判断）
    const legacy = store === undefined ? undefined : legacyOf(store.store)
    const base = {
      workspace: {
        files,
        ...(state?.base === undefined || legacy !== undefined
          ? {}
          : { base: (({ chosen: _chosen, ...rest }) => rest)(state.base) }),
        ...(legacy === undefined
          ? {}
          : {
              legacy: {
                theme: 'agentsws-theme',
                ...(legacy.version === undefined ? {} : { version: legacy.version }),
              },
            }),
      },
      ...(store === undefined ? {} : { store: store.store, store_source: store.source }),
      ...(state?.pushes.length ? { last_push: state.pushes[state.pushes.length - 1] } : {}),
      ...(lookup === undefined
        ? {}
        : {
            store_lookup: {
              status: lookup.status,
              stores: lookup.stores,
              checked_at: lookup.checked_at,
              ...(lookup.message === undefined ? {} : { message: lookup.message }),
            },
          }),
      ...(site === undefined ? {} : { site_store: site }),
    }
    if (spec === undefined || probe === undefined)
      return { applicable: false, cli: 'missing', ...base }
    const cli: ThemeReadiness['cli'] = !probe.installed
      ? 'missing'
      : !probe.node_ok
        ? 'node_old'
        : !options.loggedIn(spec.id)
          ? 'needs_login'
          : 'ready'
    const next: ThemeNeed | undefined =
      cli === 'missing'
        ? 'install_cli'
        : cli === 'node_old'
          ? 'node'
          : cli === 'needs_login'
            ? 'login'
            : store !== undefined
              ? undefined
              : // WP258：找店时 CLI 说会话过期 → 回到「登录 Shopify」
                lookup?.need_login === true
                ? 'login'
                : 'store'
    return {
      applicable: true,
      cli,
      ...(probe.source === undefined ? {} : { cli_source: probe.source }),
      ...base,
      ...(next === undefined ? {} : { next }),
    }
  }

  /**
   * 要动手之前先问一句还差什么。`remote` = 要碰店铺（列 / 拉 / 推 / 发布）：CLI、登录、店铺都得有；
   * `local` = 只在本机（检查要 CLI 但不要登录）；`files` = 只要知道是哪家店（目录按店分）。
   */
  const need = async (
    level: 'remote' | 'local' | 'files',
  ): Promise<{ shop: string; spec: PlatformCliSpec | undefined }> => {
    const r = await readiness()
    if (!r.applicable && level !== 'files')
      throw new SiteThemeError('needs', '这个品牌的建站平台不是 Shopify，主题工具用不了。')
    if (level !== 'files' && (r.cli === 'missing' || r.cli === 'node_old'))
      throw new SiteThemeError(
        'needs',
        NEED_TEXT[r.cli === 'missing' ? 'install_cli' : 'node'],
        r.cli === 'missing' ? 'install_cli' : 'node',
      )
    if (level === 'remote' && (r.cli === 'needs_login' || r.next === 'login'))
      throw new SiteThemeError('needs', NEED_TEXT.login, 'login')
    if (r.store === undefined) {
      // WP258：找过店的，照找到的情况说（没有店 / 好几家要选 / 没找成）
      const found = r.store_lookup
      const text =
        found?.status === 'none'
          ? STORE_LOOKUP_TEXT.none
          : found?.status === 'ok' &&
              found.stores.length === 1 &&
              r.site_store !== undefined &&
              found.stores[0]?.store !== r.site_store
            ? STORE_LOOKUP_TEXT.mismatch
            : found?.status === 'ok'
              ? STORE_LOOKUP_TEXT.pick
              : found?.status === 'failed'
                ? STORE_LOOKUP_TEXT.failed
                : NEED_TEXT.store
      throw new SiteThemeError('needs', text, 'store')
    }
    return { shop: r.store, spec: options.cliSpec() }
  }

  const theme = (spec: PlatformCliSpec | undefined): ShopifyTheme => {
    if (spec === undefined) throw new SiteThemeError('needs', NEED_TEXT.install_cli, 'install_cli')
    return cliFor(spec)
  }

  /** CLI 的错误 → 人话（原文只在 detail 里，已经抹过令牌）。 */
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ShopifyThemeError) {
        if (e.code === 'cli_missing')
          throw new SiteThemeError('needs', NEED_TEXT.install_cli, 'install_cli')
        const text = `${e.message}${e.detail === undefined ? '' : `\n${e.detail}`}`
        if (/log ?in|logged|auth|session|unauthori[sz]ed|401/i.test(e.detail ?? ''))
          throw new SiteThemeError('needs', NEED_TEXT.login, 'login')
        throw new SiteThemeError(e.code === 'invalid_input' ? 'invalid_input' : 'cli', text)
      }
      throw e
    }
  }

  /** 列主题，并把没有预览链接的副本补成 `https://<店>/?preview_theme_id=<id>`（Shopify 的预览链接就长这样）。 */
  const listWithPreview = async (shop: string, t: ShopifyTheme): Promise<ThemeSummary[]> => {
    const rows = await wrap(() => t.list(shop))
    const pushes = stateOf(shop).pushes
    const out = rows.map((row) => {
      if (row.preview_url !== undefined) return row
      const pushed = pushes.find((p) => p.theme_id === row.id)?.preview_url
      return { ...row, preview_url: pushed ?? `https://${shop}/?preview_theme_id=${row.id}` }
    })
    lastListed = out
    return out
  }
  /** WP418（自查 A17）：最近一次列出来的主题（面板「主题副本与预览」读它；没列过 = 空）。 */
  let lastListed: ThemeSummary[] = []

  /** 往这次运行的事项时间线记一句（没有事项 / 事项没了就算了，事件里照样有）。 */
  const noteRun = (request: RunRequest | undefined, text: string): void => {
    const matter = request?.work_item?.id
    if (matter === undefined) return
    try {
      options.noteMatter?.(matter, text)
    } catch {
      // 事项没了：照样在事件里
    }
  }

  // ── WP301：Horizon 起底、目录、旧的自带主题 ─────────────────────────────

  /** 工作目录里这份主题的 `theme_info`（没有 / 读不懂回 undefined）。 */
  const infoAt = (root: string): ThemeInfo | undefined => {
    const file = join(root, 'config', 'settings_schema.json')
    return existsSync(file) ? themeInfoOf(readFileSync(file, 'utf8')) : undefined
  }

  /** 按店缓存的目录（起底 / 拉了就重算）。 */
  const catalogs = new Map<string, ThemeCatalog>()
  const buildCatalog = (root: string): ThemeCatalog => {
    const all = themeFiles(root)
    return buildThemeCatalog({
      list: (dir) => all.filter((rel) => rel.startsWith(`${dir}/`)),
      read: (rel) => {
        const abs = join(root, rel)
        return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : undefined
      },
    })
  }
  /** 生成目录写进工作目录根（`theme push` 不传根目录的文件，所以不会推到店里）。 */
  const writeCatalog = (shop: string, root: string): ThemeCatalog => {
    const catalog = buildCatalog(root)
    writeFileSync(join(root, CATALOG_FILE), `${JSON.stringify(catalog)}\n`, 'utf8')
    writeFileSync(
      join(root, CATALOG_INDEX_FILE),
      `${JSON.stringify(catalogIndexOf(catalog), null, 1)}\n`,
      'utf8',
    )
    catalogs.set(shop, catalog)
    return catalog
  }
  const catalogFor = (shop: string, root: string): ThemeCatalog => {
    const cached = catalogs.get(shop)
    if (cached !== undefined) return cached
    const built = buildCatalog(root)
    catalogs.set(shop, built)
    return built
  }

  /** 这家店的工作目录是不是旧的自带主题（agentsws-theme）起的底。 */
  const legacyOf = (shop: string): { version?: string } | undefined => {
    const base = settings.stores[shop]?.base
    // WP304：高级主题（也叫 agentsws-theme）是这家店买的、下载下来的那一份，不是旧的自带主题
    if (base?.source === 'premium') return undefined
    if (base !== undefined && /agentsws-theme/.test(base.repo))
      return base.version === '' ? {} : { version: base.version }
    const root = themeWorkspaceRoot(options.dataDir, ws, shop)
    if (!existsSync(root)) return undefined
    const info = infoAt(root)
    if (!isLegacyTheme(info)) return undefined
    return info?.theme_version === undefined ? {} : { version: info.theme_version }
  }

  /**
   * 工作目录整份挪到一边（不删）：旧的自带主题那一份进 `theme-work/<品牌>/legacy/`，别的（replace=true）进 `aside/`
   * ——变更审阅只看 `themes/<品牌>/` 下的店铺目录，挪走的不会混进去。
   */
  const moveAside = (
    shop: string,
    root: string,
    legacy: { version?: string } | undefined,
  ): string => {
    const stamp = String(Date.parse(now()))
    const dest =
      legacy === undefined
        ? join(options.dataDir, 'theme-work', ws, 'aside', `${shop}-${stamp}`)
        : join(
            options.dataDir,
            'theme-work',
            ws,
            'legacy',
            `${shop}-agentsws-theme${legacy.version === undefined ? '' : `-v${legacy.version}`}-${stamp}`,
          )
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(root, dest)
    mkdirSync(root, { recursive: true })
    if (legacy !== undefined) {
      const st = stateOf(shop)
      st.legacy = [
        ...(st.legacy ?? []),
        {
          ...(legacy.version === undefined ? {} : { version: legacy.version }),
          moved_to: dest,
          at: now(),
        },
      ].slice(-10)
      emit('site_theme.legacy_moved', {
        workspace_id: ws,
        ...(legacy.version === undefined ? {} : { version: legacy.version }),
      })
    }
    return dest
  }

  /** 最多探几份主题（线上那一份先，再是名字里带 Horizon 的未发布主题）。 */
  const PROBE_MAX = 6

  /** WP304：一份主题探出来的样子（只拉了 `settings_schema.json` 与首页模板）。 */
  interface Probed {
    row: ThemeSummary
    info: ThemeInfo | undefined
    /** 有 JSON 模板（`templates/index.json`）= Online Store 2.0。 */
    os2: boolean
  }

  /**
   * 探几份主题：每一份只拉 `config/settings_schema.json` 与 `templates/index.json` 到临时目录（后台改过显示名也认得出
   * 是哪套主题；有没有 JSON 首页模板 = 是不是 Online Store 2.0）。一份都没探成 → 抛最后那个错。
   */
  const probeThemes = async (
    shop: string,
    t: ShopifyTheme,
    rows: readonly ThemeSummary[],
    /** 探到这一份就不往下探了（Horizon 找到了）。 */
    stop?: (p: Probed) => boolean,
  ): Promise<Probed[]> => {
    const probeRoot = join(options.dataDir, 'theme-work', ws, 'probe', String(Date.parse(now())))
    const out: Probed[] = []
    let lastError: unknown
    try {
      for (const row of rows) {
        const dir = join(probeRoot, row.id.replace(/[^\w-]/g, '_'))
        mkdirSync(dir, { recursive: true })
        try {
          await wrap(() =>
            t.pull({
              shop,
              theme_id: row.id,
              only: ['config/settings_schema.json', 'templates/index.json'],
              path: dir,
            }),
          )
        } catch (e) {
          if (e instanceof SiteThemeError && e.code === 'needs') throw e
          lastError = e
          continue
        }
        const probed: Probed = {
          row,
          info: infoAt(dir),
          os2: existsSync(join(dir, 'templates', 'index.json')),
        }
        out.push(probed)
        if (stop?.(probed) === true) break
      }
    } finally {
      // 只删这一次自己建的探测目录
      rmSync(probeRoot, { recursive: true, force: true })
    }
    if (out.length === 0 && lastError !== undefined) throw lastError
    return out
  }

  /** 探哪几份、什么顺序：线上那一份先，再是名字里带 Horizon 的未发布主题，最多 {@link PROBE_MAX} 份。 */
  const probeOrder = (rows: readonly ThemeSummary[]): ThemeSummary[] => {
    const isLive = (r: ThemeSummary): boolean => r.role === 'main' || r.role === 'live'
    const named = (r: ThemeSummary): number => (/horizon/i.test(r.name) ? 0 : 1)
    return [
      ...rows.filter(isLive),
      ...rows.filter((r) => r.role === 'unpublished').sort((a, b) => named(a) - named(b)),
    ].slice(0, PROBE_MAX)
  }

  /**
   * 用店里哪一份起底。给了 `pick`（人在选主题卡上选的）就是那一份——老主题照实说「太老，改不了」；
   * 没给（WP301 的老路）：Horizon 优先（线上那一份先），没有 Horizon 再用任何一份 Online Store 2.0 主题（WP304）；
   * 一份能用的都没有 → `no_horizon`（请人从主题商店免费加一份 Horizon）。
   */
  const findBase = async (
    shop: string,
    t: ShopifyTheme,
    rows: ThemeSummary[],
    pick?: string,
  ): Promise<{ row: ThemeSummary; info: ThemeInfo }> => {
    if (pick !== undefined) {
      const row = rows.find((r) => r.id === pick)
      if (row === undefined)
        throw new SiteThemeError(
          'invalid_input',
          `店里找不到这份主题（${pick}），可能已经被人删了。`,
        )
      const [probed] = await probeThemes(shop, t, [row])
      if (probed?.info === undefined || !probed.os2)
        throw new SiteThemeError('too_old', tooOldText(row.name))
      return { row, info: probed.info }
    }
    const isBase = (p: Probed): boolean => p.info !== undefined && isHorizon(p.info) && p.os2
    const probed = await probeThemes(shop, t, probeOrder(rows), isBase)
    const hit = probed.find(isBase) ?? probed.find((p) => p.info !== undefined && p.os2)
    if (hit?.info !== undefined) return { row: hit.row, info: hit.info }
    emit('site_theme.no_horizon', { workspace_id: ws, probed: probed.length })
    throw new SiteThemeError('no_horizon', NO_HORIZON_TEXT)
  }

  /** 复制出来那一份叫什么（人在后台认得出；不带工具名）。 */
  const copyNameOf = (source: string): string => {
    const d = new Date(now())
    const mmdd = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    return `${source.trim().slice(0, 30)} 草稿 ${mmdd}`
  }

  /**
   * 第一次推预览：推到起底时复制出来的那一份上（它本来就是未发布的 Horizon 副本），改成人起的名字；
   * 那一份不在了 / 成了线上那一份 / 已经推过 → 照老规矩推一份新的未发布主题。
   */
  const pushToCopy = async (shop: string, t: ShopifyTheme, name: string): Promise<PushedTheme> => {
    const copy = stateOf(shop).copy
    const used =
      copy !== undefined && stateOf(shop).pushes.some((p) => p.theme_id === copy.theme_id)
    if (copy === undefined || used) return wrap(() => t.pushUnpublished({ shop, name }))
    const rows = await wrap(() => t.list(shop))
    const still = rows.find((r) => r.id === copy.theme_id)
    if (still === undefined || still.role === 'main' || still.role === 'live')
      return wrap(() => t.pushUnpublished({ shop, name }))
    const pushed = await wrap(() => t.pushToTheme({ shop, theme_id: copy.theme_id }))
    if (still.name === name) return { ...pushed, theme_name: name }
    try {
      await wrap(() => t.rename({ shop, theme_id: copy.theme_id, name }))
      copy.name = name
      return { ...pushed, theme_name: name }
    } catch {
      // 名字没改成不影响预览：照旧叫复制时的名字
      return { ...pushed, theme_name: still.name }
    }
  }

  const legacyNotice = async (): Promise<ThemeLegacyNotice | undefined> => {
    let shop: string
    try {
      shop = (await need('files')).shop
    } catch {
      return undefined
    }
    const legacy = legacyOf(shop)
    if (legacy === undefined) return undefined
    return {
      theme: 'agentsws-theme',
      ...(legacy.version === undefined ? {} : { version: legacy.version }),
      message: legacyThemeNotice(legacy.version),
    }
  }

  /** WP296 出过的升级卡被点了：不升（工坊已改用 Horizon），只记一句作废了。 */
  const onUpgradeDecided = async (item: ApprovalItem): Promise<void> => {
    if (!isThemeUpgradeCard(item) || item.workspace_id !== ws) return
    emit('site_theme.legacy_upgrade_card_void', { workspace_id: ws, state: item.state })
    const matter = item.subject.matter_id
    if (matter === undefined) return
    try {
      options.noteMatter?.(matter, LEGACY_UPGRADE_CARD_VOID)
    } catch {
      // 事项没了：照样在事件里
    }
  }

  type InitResult = Awaited<ReturnType<SiteThemeAssembly['initFromBase']>>
  type InitInput = Parameters<SiteThemeAssembly['initFromBase']>[0]

  /** WP304：人刚在选主题卡上选好、起好了底（还没推过）——接着做的那次运行再叫起底，就用这一份。 */
  const reusedInit = (shop: string, root: string): InitResult | undefined => {
    const state = stateOf(shop)
    const base = state.base
    if (base?.chosen !== true || themeFiles(root).length === 0) return undefined
    const catalog = catalogFor(shop, root)
    const sections = catalog.entries.filter((e) => e.kind === 'section').length
    const copy = state.copy
    return {
      base: { repo: base.repo, version: base.version, commit: base.commit, license: base.license },
      theme: {
        name: base.theme_name ?? catalog.theme_name,
        ...(base.version === '' ? {} : { version: base.version }),
      },
      source: {
        theme_id: base.source_theme_id ?? '',
        name: copy?.source_name ?? base.theme_name ?? '',
        live: false,
      },
      copy: {
        theme_id: copy?.theme_id ?? base.copy_theme_id ?? '',
        name: copy?.name ?? '',
        preview_url: `https://${shop}/?preview_theme_id=${copy?.theme_id ?? base.copy_theme_id ?? ''}`,
      },
      files: Object.keys(state.baseline ?? {}).length,
      moved_aside: false,
      catalog: { sections, blocks: catalog.entries.length - sections },
      ...(base.source === 'premium' ? { premium: true } : {}),
      reused: true,
    }
  }

  /** 往这件事的时间线记一句：有运行请求按运行，没有（选主题卡那一路）按给的事项。 */
  const noteAt = (request: RunRequest | undefined, matter_id: string | undefined, text: string) => {
    if (request !== undefined) return noteRun(request, text)
    if (matter_id === undefined) return
    try {
      options.noteMatter?.(matter_id, text)
    } catch {
      // 事项没了：照样在事件里
    }
  }

  /** 高级主题那一跳的错 → 人话（`premium`）。 */
  const premiumFailure = (e: unknown): unknown =>
    e instanceof PremiumThemeError ? new SiteThemeError('premium', e.message) : e

  /**
   * WP304：**高级主题起底**——从云上下载这家店买过的那一份、核 sha256、解进暂存目录，认得出是 Online Store 2.0 主题
   * 才换上工作目录（只取主题那几个目录：包根上的 AGENTS.md / README / CATALOG.json 不要，AGENTS.md 会被 `theme push` 推进店里），
   * 按它的 schema 生成目录，再推成一份**未发布**主题出预览（线上不动）。主题文件只进这家店的工作目录与这家店。
   */
  const initPremium = async (input: {
    replace?: boolean | undefined
    request?: RunRequest | undefined
    matter_id?: string | undefined
  }): Promise<InitResult> => {
    const { shop, spec } = await need('remote')
    const client = options.premium
    if (client === undefined) throw new SiteThemeError('premium', PREMIUM_SOON_TEXT)
    const t = theme(spec)
    const root = rootOf(shop)
    const legacy = legacyOf(shop)
    const hasStuff = readdirSync(root).length > 0
    if (hasStuff && legacy === undefined && input.replace !== true)
      throw new SiteThemeError(
        'invalid_input',
        '主题工作目录里已经有东西了（起过底了），没覆盖。真要换成高级主题，带 replace=true（旧的会挪到一边，不删）。',
      )
    let pkg: { version: string; bytes: Uint8Array }
    try {
      pkg = await client.download(shop)
    } catch (e) {
      throw premiumFailure(e)
    }
    const staging = join(options.dataDir, 'theme-work', ws, 'staging', String(Date.parse(now())))
    mkdirSync(staging, { recursive: true })
    let legacyMoved = false
    let info: ThemeInfo | undefined
    try {
      let themeRoot: string
      try {
        themeRoot = extractThemePackage(pkg.bytes, join(staging, 'pkg'))
      } catch (e) {
        throw premiumFailure(e)
      }
      info = infoAt(themeRoot)
      const templates = themeFiles(themeRoot)
        .filter((rel) => rel.startsWith('templates/'))
        .map((rel) => rel.slice('templates/'.length))
      if (info === undefined || !isOs2Templates(templates))
        throw new SiteThemeError(
          'premium',
          '高级主题包里的主题读不懂（没有主题信息或 JSON 模板），没装。',
        )
      if (hasStuff) {
        moveAside(shop, root, legacy)
        legacyMoved = legacy !== undefined
      }
      for (const dir of THEME_DIRS)
        if (existsSync(join(themeRoot, dir))) renameSync(join(themeRoot, dir), join(root, dir))
    } finally {
      // 只删这一次自己建的暂存目录
      rmSync(staging, { recursive: true, force: true })
    }
    const catalog = writeCatalog(shop, root)
    const version = pkg.version !== '' ? pkg.version : (info.theme_version ?? '')
    const state = stateOf(shop)
    state.base = {
      repo: PREMIUM_BASE.repo,
      version,
      commit: '',
      license: PREMIUM_BASE.license,
      at: now(),
      theme_name: info.theme_name,
      source: 'premium',
      chosen: true,
    }
    state.baseline = manifestOf(root)
    lastCheck.delete(shop)
    save()
    // 推一份未发布预览（线上一个字节不动）；之后第一次推预览就推到它上面
    const name = `${PREMIUM_BASE.name} ${version}`.trim()
    const pushed = await wrap(() => t.pushUnpublished({ shop, name }))
    const preview = pushed.preview_url ?? `https://${shop}/?preview_theme_id=${pushed.theme_id}`
    state.copy = {
      theme_id: pushed.theme_id,
      name,
      source_theme_id: '',
      source_name: PREMIUM_BASE.name,
      at: now(),
    }
    state.base.copy_theme_id = pushed.theme_id
    save()
    emit('site_theme.premium_installed', {
      workspace_id: ws,
      version,
      legacy_moved: legacyMoved,
      theme_id: pushed.theme_id,
    })
    if (legacyMoved)
      noteAt(
        input.request,
        input.matter_id,
        legacyMovedNote(legacy?.version, name, { premium: true }),
      )
    const matter = input.request?.work_item?.id ?? input.matter_id
    if (matter !== undefined)
      options.notePreview?.(matter, {
        text: `高级主题装好了：未发布主题「${name}」（线上没动）。`,
        url: preview,
        label: name,
        theme_id: pushed.theme_id,
        changed_files: [],
      })
    const sections = catalog.entries.filter((e) => e.kind === 'section').length
    return {
      base: { repo: PREMIUM_BASE.repo, version, commit: '', license: PREMIUM_BASE.license },
      theme: { name: info.theme_name, ...(version === '' ? {} : { version }) },
      source: { theme_id: '', name: PREMIUM_BASE.name, live: false },
      copy: { theme_id: pushed.theme_id, name, preview_url: preview },
      files: Object.keys(state.baseline).length,
      moved_aside: hasStuff,
      ...(legacyMoved ? { legacy_moved: true } : {}),
      catalog: { sections, blocks: catalog.entries.length - sections },
      premium: true,
    }
  }

  /** WP304：这家店高级主题那一行是什么状态（云上还没开 / 没登录 / 没买 / 买过了）。 */
  const premiumOf = async (
    shop: string,
  ): Promise<{
    status: PremiumThemeStatus
    latest_version?: string
    preview_image_url?: string
    example_url?: string
  }> => {
    const client = options.premium
    if (client === undefined) return { status: 'soon' }
    if (!client.linked()) return { status: 'needs_account' }
    try {
      const e = await client.entitlement(shop)
      // WP305：私有桶没绑 / 还没上架也是 200，`available: false`——即将开放
      if (e.available === false) return { status: 'soon' }
      return {
        status: e.owned ? 'owned' : 'buy',
        ...(typeof e.latest_version === 'string' ? { latest_version: e.latest_version } : {}),
        ...(e.preview_image_url === undefined ? {} : { preview_image_url: e.preview_image_url }),
        ...(e.example_url === undefined ? {} : { example_url: e.example_url }),
      }
    } catch (err) {
      if (err instanceof PremiumThemeError && err.code === 'not_linked')
        return { status: 'needs_account' }
      // WP418（自查 A7）：登录了但少一项权限 / 一时连不上——各说各的，不都说成「即将开放」「去登录」
      if (err instanceof PremiumThemeError && err.code === 'missing_scope')
        return { status: 'needs_scope' }
      if (err instanceof PremiumThemeError && err.code === 'offline') return { status: 'offline' }
      return { status: 'soon' }
    }
  }

  /** 卡的公共那几格（收件人 = 这次运行 / 这张卡的那个人）。 */
  const cardBase = (input: {
    shop: string
    person_id: string
    role_id: string
    assignment_id?: string | undefined
    matter_id?: string | undefined
    run_id?: string | undefined
    seen: string[]
  }) => ({
    workspace_id: ws as never,
    schema_version: 1 as const,
    role_id: input.role_id as never,
    subject: {
      object: { type: 'site_theme', id: input.shop },
      ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id as never }),
    },
    evidence: {
      ...(input.run_id === undefined ? {} : { run_id: input.run_id as never }),
      source_events: [],
      provenance: { seen: input.seen.map((id) => ({ type: 'theme', id })) },
      precheck: {},
    },
    proposer: {
      kind: 'agent' as const,
      id: `agent_${input.role_id}`,
      ...(input.assignment_id === undefined ? {} : { assignment_id: input.assignment_id as never }),
    },
    automation: {
      level_at_creation: 'L1' as const,
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: input.person_id as never, via: 'role_holder' as const }],
      rule: 'role_holder' as const,
      escalation: {
        after_hours: 24,
        business_hours: true,
        chain: ['owner' as const],
        escalated_at: [],
      },
      separation_of_duties: false,
    },
    priority: 'queue' as const,
  })

  /** 店里那一份主题在选项上叫什么：后台名 +（线上）+ 是哪套主题（与后台名不一样时）。 */
  const storeLabel = (x: ThemeChoicePayload['store_themes'][number]): string =>
    `${x.name}${x.role === 'main' || x.role === 'live' ? '（线上）' : ''}${
      x.theme_name !== undefined && x.theme_name !== x.name ? ` · ${x.theme_name}` : ''
    }`

  const askThemeChoice: NonNullable<SiteThemeAssembly['askThemeChoice']> = async ({
    replace,
    request,
  }) => {
    const bus = options.approvals?.()
    if (bus === undefined || request === undefined) return undefined
    const { shop, spec } = await need('remote')
    const root = rootOf(shop)
    /*
     * WP311（决策 480）：旧的自带主题那一份工作目录也出卡（以前照 WP301 直接复制 Horizon）——
     * 不用说「换主题」，第一次起底就问；选了哪份都在店里新起一份未发布的，旧目录挪开留着。
     */
    const legacy = legacyOf(shop) !== undefined
    const state = stateOf(shop)
    if (!legacy && themeFiles(root).length > 0 && replace !== true) return undefined
    // 人刚选好、起好了底，还没推过：接着做，不再问
    if (state.base?.chosen === true && themeFiles(root).length > 0) return undefined
    // 还在等人选的那一张：不重复出
    if (state.choice_card_id !== undefined) {
      const prior = await bus.get(state.choice_card_id).catch(() => undefined)
      if (prior !== undefined && (prior.state === 'pending' || prior.state === 'in_review')) {
        const p = prior.payload as Partial<ThemeChoicePayload>
        return {
          approval_item_id: prior.id,
          premium: p.premium?.status ?? 'soon',
          store_themes: (p.store_themes ?? []).filter((x) => x.usable).length,
          message: THEME_CHOICE_ASKED_TEXT,
        }
      }
    }
    const t = theme(spec)
    const rows = await wrap(() => t.list(shop))
    let probed: Probed[] = []
    try {
      probed = await probeThemes(shop, t, probeOrder(rows))
    } catch (e) {
      if (e instanceof SiteThemeError && e.code === 'needs') throw e
    }
    const premium = await premiumOf(shop)
    const store_themes: ThemeChoicePayload['store_themes'] = probed.map((p) => ({
      id: p.row.id,
      name: p.row.name,
      role: p.row.role,
      ...(p.info === undefined ? {} : { theme_name: p.info.theme_name }),
      ...(p.info?.theme_version === undefined ? {} : { theme_version: p.info.theme_version }),
      usable: p.info !== undefined && p.os2,
    }))
    const premiumPick = premium.status === 'buy' || premium.status === 'owned'
    const choices = [
      ...(premiumPick
        ? [
            {
              id: 'premium',
              label:
                premium.status === 'owned'
                  ? `${PREMIUM_BASE.name}（这家店已买）`
                  : `${PREMIUM_BASE.name} · $${PREMIUM_THEME_PRICE_USD} · ${PREMIUM_THEME_PRICE_CREDITS} 积分`,
            },
          ]
        : []),
      ...store_themes
        .filter((x) => x.usable)
        .map((x) => ({ id: `store:${x.id}`, label: storeLabel(x) })),
    ]
    // 一个能选的都没有（高级主题还没开、店里也没有能改的）：照 WP301 请人从主题商店免费加一份 Horizon
    if (choices.length === 0) {
      emit('site_theme.no_horizon', { workspace_id: ws, probed: probed.length })
      throw new SiteThemeError('no_horizon', NO_HORIZON_TEXT)
    }
    const matter_id = request.work_item?.id
    const payload: ThemeChoicePayload = {
      form: 'theme_choice',
      shop,
      premium: {
        status: premium.status,
        price_credits: PREMIUM_THEME_PRICE_CREDITS,
        price_usd: PREMIUM_THEME_PRICE_USD,
        ...(premium.latest_version === undefined ? {} : { latest_version: premium.latest_version }),
        ...(premium.preview_image_url === undefined
          ? {}
          : { preview_image_url: premium.preview_image_url }),
        ...(premium.example_url === undefined ? {} : { example_url: premium.example_url }),
      },
      store_themes,
      theme_store_url: HORIZON_THEME_STORE_URL,
      options: choices,
      ...(matter_id === undefined ? {} : { matter_id }),
      assignment_id: request.actor.assignment_id,
      ...(replace === true ? { replace: true } : {}),
    }
    const item = await bus.create({
      ...cardBase({
        shop,
        person_id: request.actor.person_id,
        role_id: request.actor.role_id,
        assignment_id: request.actor.assignment_id,
        matter_id,
        run_id: request.id,
        seen: rows.map((r) => r.id),
      }),
      kind: 'theme_choice',
      dedupe_key: `theme_choice:${shop}@${request.id}:${ws}`,
      title: '用哪套主题建站？',
      summary:
        premium.status === 'soon'
          ? '高级主题即将开放；先选店里已装的免费主题。'
          : '我们的高级主题排第一，也可以用店里已装的免费主题。',
      payload,
      options: choices,
      risk_class: 'low',
    } as never)
    try {
      options.onCard?.(item)
    } catch {
      // 挂不上事项不影响卡本身
    }
    state.choice_card_id = item.id
    save()
    emit('site_theme.choice_asked', {
      workspace_id: ws,
      premium: premium.status,
      store_themes: store_themes.filter((x) => x.usable).length,
      too_old: store_themes.filter((x) => !x.usable).length,
    })
    return {
      approval_item_id: item.id,
      premium: premium.status,
      store_themes: store_themes.filter((x) => x.usable).length,
      message: THEME_CHOICE_ASKED_TEXT,
    }
  }

  /** WP304：出一张「买高级主题」的卡（「花钱」家族：560 积分，人点了才扣）。 */
  const askPurchase = async (input: {
    shop: string
    person_id: string
    role_id: string
    assignment_id?: string | undefined
    matter_id?: string | undefined
    replace?: boolean | undefined
  }): Promise<ApprovalItem | undefined> => {
    const bus = options.approvals?.()
    if (bus === undefined) return undefined
    const state = stateOf(input.shop)
    if (state.purchase_card_id !== undefined) {
      const prior = await bus.get(state.purchase_card_id).catch(() => undefined)
      if (prior !== undefined && (prior.state === 'pending' || prior.state === 'in_review'))
        return prior
    }
    const payload: ThemePurchasePayload = {
      form: 'theme_purchase',
      shop: input.shop,
      price_credits: PREMIUM_THEME_PRICE_CREDITS,
      price_usd: PREMIUM_THEME_PRICE_USD,
      ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id }),
      ...(input.assignment_id === undefined ? {} : { assignment_id: input.assignment_id }),
      ...(input.replace === true ? { replace: true } : {}),
    }
    const item = await bus.create({
      ...cardBase({ ...input, seen: [] }),
      kind: 'theme_purchase',
      dedupe_key: `theme_purchase:${input.shop}@${now()}:${ws}`,
      title: '买下高级主题？',
      summary: `${input.shop} 一次买断（$${PREMIUM_THEME_PRICE_USD}），以后升级不另收钱。点「买下」才扣积分。`,
      payload,
      risk_class: 'medium',
    } as never)
    try {
      options.onCard?.(item)
    } catch {
      // 挂不上事项不影响卡本身
    }
    state.purchase_card_id = item.id
    save()
    emit('site_theme.purchase_asked', { workspace_id: ws })
    return item
  }

  const onThemeCardDecided: NonNullable<SiteThemeAssembly['onThemeCardDecided']> = async (item) => {
    if (item.workspace_id !== ws) return
    if (item.kind !== 'theme_choice' && item.kind !== 'theme_purchase') return
    const p = (
      item.payload !== null && typeof item.payload === 'object' ? item.payload : {}
    ) as Partial<Pick<ThemePurchasePayload, 'shop' | 'matter_id' | 'assignment_id' | 'replace'>>
    const shop = typeof p.shop === 'string' ? p.shop : undefined
    if (shop === undefined) return
    const state = stateOf(shop)
    if (item.kind === 'theme_choice' && state.choice_card_id === item.id)
      delete state.choice_card_id
    if (item.kind === 'theme_purchase' && state.purchase_card_id === item.id)
      delete state.purchase_card_id
    save()
    const matter_id = p.matter_id ?? item.subject.matter_id
    const note = (text: string): void => noteAt(undefined, matter_id, text)
    const approved =
      item.state === 'approved' || item.state === 'approved_edited' || item.state === 'applied'
    if (!approved) {
      if (item.kind === 'theme_purchase' && item.state === 'rejected')
        note('没买高级主题，一个积分都没扣。想用店里的免费主题，跟我说「换主题」。')
      return
    }
    const by = item.decision?.by
    const person_id =
      by !== undefined && by !== 'mandate' ? String(by) : item.routing.recipients[0]?.person
    const assignment_id = p.assignment_id ?? item.proposer.assignment_id
    const replace = p.replace === true
    // 店换了（人在岗位页上换了一家）：这张卡是给原来那家的，不动
    const current = storeOf()?.store
    if (current !== shop) {
      note(`这张卡是给 ${shop} 的，现在建站用的是别的店，这次没起底。`)
      return
    }
    try {
      if (item.kind === 'theme_purchase') {
        const client = options.premium
        if (client === undefined) throw new SiteThemeError('premium', PREMIUM_SOON_TEXT)
        let bought: { charged_credits: number; already_owned?: boolean }
        try {
          bought = await client.purchase(shop)
        } catch (e) {
          throw premiumFailure(e)
        }
        emit('site_theme.premium_purchased', {
          workspace_id: ws,
          charged: bought.charged_credits,
          already_owned: bought.already_owned === true,
        })
        note(
          bought.already_owned === true
            ? '这家店已经买过高级主题，没再扣积分。正在下载、推一份未发布预览。'
            : `买好了，扣了 ${bought.charged_credits} 积分。正在下载、推一份未发布预览。`,
        )
        await initBase({ source: 'premium', replace, matter_id })
      } else {
        const edited = item.decision?.edited_payload as { selected_option_id?: unknown } | undefined
        const option =
          item.decision?.selected_option_id ??
          (typeof edited?.selected_option_id === 'string' ? edited.selected_option_id : '')
        if (option === 'premium') {
          const prem = await premiumOf(shop)
          if (prem.status === 'buy') {
            if (person_id !== undefined)
              await askPurchase({
                shop,
                person_id,
                role_id: item.role_id,
                assignment_id,
                matter_id,
                replace,
              })
            note(`出了一张买高级主题的卡（${PREMIUM_THEME_PRICE_CREDITS} 积分，你点了才扣）。`)
            return
          }
          if (prem.status !== 'owned') {
            note(
              prem.status === 'needs_account'
                ? PREMIUM_NOT_LINKED_TEXT
                : prem.status === 'needs_scope'
                  ? '工坊账号令牌少了「店铺」那一项权限：重新登录一次工坊账号，再选一次。'
                  : prem.status === 'offline'
                    ? PREMIUM_OFFLINE_TEXT
                    : PREMIUM_SOON_TEXT,
            )
            return
          }
          await initBase({ source: 'premium', replace, matter_id })
        } else if (option.startsWith('store:')) {
          const r = await initBase({
            source: 'store',
            theme_id: option.slice('store:'.length),
            replace,
            matter_id,
            chosen: true,
          })
          note(
            `用「${r.source.name}」起好底了（店里多了一份未发布副本「${r.copy.name}」，线上没动），接着按你说的做。`,
          )
        } else return
      }
    } catch (e) {
      emit('site_theme.choice_failed', {
        workspace_id: ws,
        kind: item.kind,
        code: e instanceof SiteThemeError ? e.code : 'error',
      })
      note(e instanceof SiteThemeError ? e.message : '起底没成，过一会儿再选一次。')
      return
    }
    if (matter_id !== undefined && person_id !== undefined && assignment_id !== undefined)
      await options.resume?.({ matter_id, person_id, assignment_id }).catch(() => undefined)
  }

  const initBase = async (input: InitInput): Promise<InitResult> => {
    const { replace, request, source: from, theme_id: pick, matter_id, chosen } = input
    const { shop, spec } = await need('remote')
    const root0 = rootOf(shop)
    // WP304：人刚选好、起好了底（选完接着做的那次运行）→ 不再起，就用这一份（话里又点了同一类也算）
    const chosenSource = stateOf(shop).base?.source ?? 'store'
    if (pick === undefined && (from === undefined || from === chosenSource)) {
      const again = reusedInit(shop, root0)
      if (again !== undefined) return again
    }
    if (from === 'premium') return initPremium({ replace, request, matter_id })
    const t = theme(spec)
    const root = root0
    const legacy = legacyOf(shop)
    const hasStuff = readdirSync(root).length > 0
    if (hasStuff && legacy === undefined && replace !== true)
      throw new SiteThemeError(
        'invalid_input',
        '主题工作目录里已经有东西了（起过底了），没覆盖，接着在它上面改就行。真要重新起底（换主题），带 replace=true（旧的会挪到一边，不删）。',
      )
    const state = stateOf(shop)
    const rows = await wrap(() => t.list(shop))
    const isLive = (r: ThemeSummary): boolean => r.role === 'main' || r.role === 'live'
    // 上一次在店里复制出来了、但没拉成（工作目录还是空的）→ 接着用那一份，不在店里再堆一份
    const earlier = state.copy
    const reuse =
      !hasStuff && earlier !== undefined && (pick === undefined || pick === earlier.source_theme_id)
        ? rows.find((r) => r.id === earlier.theme_id && !isLive(r))
        : undefined
    let source: { theme_id: string; name: string; live: boolean }
    let copy: { theme_id: string; name: string }
    if (reuse !== undefined && earlier !== undefined) {
      source = {
        theme_id: earlier.source_theme_id,
        name: earlier.source_name,
        live: rows.some((r) => r.id === earlier.source_theme_id && isLive(r)),
      }
      copy = { theme_id: reuse.id, name: reuse.name }
    } else {
      const found = await findBase(shop, t, rows, pick)
      source = { theme_id: found.row.id, name: found.row.name, live: isLive(found.row) }
      let dup: { theme_id: string; theme_name: string }
      try {
        dup = await wrap(() =>
          t.duplicate({ shop, theme_id: found.row.id, name: copyNameOf(found.row.name) }),
        )
      } catch (e) {
        if (e instanceof SiteThemeError && /maximum number of themes|theme limit/i.test(e.message))
          throw new SiteThemeError('cli', THEMES_FULL_TEXT)
        throw e
      }
      copy = { theme_id: dup.theme_id, name: dup.theme_name }
      state.copy = {
        theme_id: copy.theme_id,
        name: copy.name,
        source_theme_id: source.theme_id,
        source_name: source.name,
        at: now(),
      }
      save()
      emit('site_theme.horizon_copied', {
        workspace_id: ws,
        from_live: source.live,
        theme_id: copy.theme_id,
      })
    }
    // 先拉进暂存目录（拉不成工作目录一个字节不动），认得出是 Online Store 2.0 主题才换上来
    const staging = join(options.dataDir, 'theme-work', ws, 'staging', String(Date.parse(now())))
    mkdirSync(staging, { recursive: true })
    let legacyMoved = false
    let info: ThemeInfo | undefined
    try {
      await wrap(() => t.pull({ shop, theme_id: copy.theme_id, path: staging }))
      info = infoAt(staging)
      const pulled = themeFiles(staging)
        .filter((rel) => rel.startsWith('templates/'))
        .map((rel) => rel.slice('templates/'.length))
      if (info === undefined || !isOs2Templates(pulled))
        throw new SiteThemeError(
          'integrity',
          '复制出来的那一份读不到主题信息（config/settings_schema.json）或者没有 JSON 模板，工作目录没换。',
        )
      if (hasStuff) {
        moveAside(shop, root, legacy)
        legacyMoved = legacy !== undefined
      }
      for (const name of readdirSync(staging)) renameSync(join(staging, name), join(root, name))
    } finally {
      // 只删这一次自己建的暂存目录
      rmSync(staging, { recursive: true, force: true })
    }
    const catalog = writeCatalog(shop, root)
    // WP304：Horizon 照 WP301 记；别的免费主题记「主题商店的主题」
    const kind = isHorizon(info) ? HORIZON_BASE : STORE_THEME_BASE
    state.base = {
      repo: kind.repo,
      version: info.theme_version ?? '',
      commit: '',
      license: kind.license,
      at: now(),
      theme_name: info.theme_name,
      source_theme_id: source.theme_id,
      copy_theme_id: copy.theme_id,
      source: 'store',
      ...(chosen === true ? { chosen: true } : {}),
    }
    state.baseline = manifestOf(root)
    lastCheck.delete(shop)
    save()
    emit('site_theme.initialized', {
      workspace_id: ws,
      theme: info.theme_name,
      version: info.theme_version ?? '',
      from_live: source.live,
      legacy_moved: legacyMoved,
    })
    if (legacyMoved)
      noteAt(
        request,
        matter_id,
        legacyMovedNote(legacy?.version, copy.name, { name: info.theme_name }),
      )
    const sections = catalog.entries.filter((e) => e.kind === 'section').length
    return {
      base: {
        repo: kind.repo,
        version: info.theme_version ?? '',
        commit: '',
        license: kind.license,
      },
      theme: {
        name: info.theme_name,
        ...(info.theme_version === undefined ? {} : { version: info.theme_version }),
      },
      source,
      copy: { ...copy, preview_url: `https://${shop}/?preview_theme_id=${copy.theme_id}` },
      files: Object.keys(state.baseline).length,
      moved_aside: hasStuff,
      ...(legacyMoved ? { legacy_moved: true } : {}),
      catalog: { sections, blocks: catalog.entries.length - sections },
    }
  }

  return {
    readiness,
    legacyNotice,
    onUpgradeDecided,
    askThemeChoice,
    onThemeCardDecided,

    async setStore(raw, opts = {}) {
      let shop: string
      try {
        shop = normalizeShopDomain(raw)
      } catch (e) {
        throw new SiteThemeError('invalid_input', e instanceof Error ? e.message : '店铺地址看不懂')
      }
      const fromList = opts.source === 'list'
      // WP258：从下拉框选的必须是这个账号下找到的那几家之一
      if (fromList && settings.lookup?.stores.some((s) => s.store === shop) !== true)
        throw new SiteThemeError(
          'invalid_input',
          '这家店不在登录账号下找到的店里。换一家，或者选「都不是？手动填」。',
        )
      settings.store = shop
      settings.store_by = fromList ? 'picked' : 'manual'
      save()
      emit('site_theme.store_set', { workspace_id: ws, source: fromList ? 'list' : 'manual' })
      return readiness()
    },

    refreshStores,

    initFromBase: initBase,

    lastListed: () => lastListed,
    async list() {
      const { shop, spec } = await need('remote')
      return listWithPreview(shop, theme(spec))
    },

    async pull({ theme_id }) {
      const { shop, spec } = await need('remote')
      const root = rootOf(shop)
      // WP301：旧的自带主题那一份先挪开（不删），不和拉下来的混在一起
      const legacy = legacyOf(shop)
      if (legacy !== undefined && readdirSync(root).length > 0) moveAside(shop, root, legacy)
      await wrap(() => theme(spec).pull({ shop, ...(theme_id === undefined ? {} : { theme_id }) }))
      const state = stateOf(shop)
      const info = infoAt(root)
      if (info !== undefined && isHorizon(info)) {
        state.base = {
          repo: HORIZON_BASE.repo,
          version: info.theme_version ?? '',
          commit: '',
          license: HORIZON_BASE.license,
          at: now(),
          theme_name: info.theme_name,
          ...(theme_id === undefined ? {} : { source_theme_id: theme_id }),
          ...(theme_id !== undefined && theme_id === state.copy?.theme_id
            ? { copy_theme_id: theme_id }
            : {}),
        }
      } else {
        // 不是 Horizon（店家自己的别的主题）：照 WP253 的老规矩，不限改哪几类文件
        delete state.base
      }
      writeCatalog(shop, root)
      state.baseline = manifestOf(root)
      lastCheck.delete(shop)
      save()
      return { files: Object.keys(state.baseline).length }
    },

    async check() {
      const { shop, spec } = await need('local')
      const result = await wrap(() => theme(spec).check({ shop }))
      // WP264：记下最近一次检查（推未发布时带进「预览好了」那张结果卡）；之后再改文件就作废
      lastCheck.set(shop, { errors: result.errors, warnings: result.warnings })
      return result
    },

    async files(dir) {
      const { shop } = await need('files')
      const root = rootOf(shop)
      const prefix =
        dir === undefined || dir.trim() === '' ? '' : `${resolveInside(root, dir).rel}/`
      const all = themeFiles(root).filter((f) => f.startsWith(prefix))
      // 根目录下给 AI 看的说明文件也列上（AGENTS.md / CATALOG.json / LICENSE …）
      const top =
        prefix === ''
          ? readdirSync(root)
              .filter((n) => !n.startsWith('.') && statSync(join(root, n)).isFile())
              .sort()
          : []
      const files = [...top, ...all]
      return { files: files.slice(0, 500), truncated: files.length > 500 }
    },

    async readFile(path) {
      const { shop } = await need('files')
      const { abs, rel } = resolveInside(rootOf(shop), path)
      if (!existsSync(abs) || !statSync(abs).isFile())
        throw new SiteThemeError('invalid_input', `主题工作目录里没有「${rel}」`)
      if (statSync(abs).size > MAX_THEME_READ_BYTES)
        throw new SiteThemeError('invalid_input', `「${rel}」太大了（超过 4 MB），不读`)
      return { path: rel, content: readFileSync(abs, 'utf8') }
    },

    async writeFile(path, content) {
      const { shop } = await need('files')
      // WP301：旧的自带主题那一份不再改（先在 Horizon 上新起一份）
      const legacy = legacyOf(shop)
      if (legacy !== undefined)
        throw new SiteThemeError('invalid_input', legacyThemeRefusal(legacy.version))
      lastCheck.delete(shop)
      const root = rootOf(shop)
      const { abs, rel } = resolveInside(root, path)
      const top = rel.split('/')[0] ?? ''
      if (!(THEME_DIRS as readonly string[]).includes(top) || !rel.includes('/'))
        throw new SiteThemeError(
          'outside',
          `只许写主题那几个目录（${THEME_DIRS.join(' / ')}）里的文件，「${rel}」不在里面`,
        )
      if (!WRITABLE_EXT.test(rel))
        throw new SiteThemeError(
          'invalid_input',
          `「${rel}」不是主题文件（liquid / json / css / js / svg）`,
        )
      if (stateOf(shop).base !== undefined && !baseWritable(rel))
        throw new SiteThemeError(
          'invalid_input',
          `「${rel}」是主题的核心代码（.liquid / CSS / JS / 编辑器标签），不改。只改 templates/*.json、section 组（页头页尾）、config/settings_data.json 与 locales 店面文案；要一小段自定义代码，用主题自带的 custom-liquid 分区 / 块。`,
        )
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > MAX_THEME_FILE_BYTES)
        throw new SiteThemeError('invalid_input', `内容太大了（超过 512 KB）`)
      const created = !existsSync(abs)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, 'utf8')
      // WP301：模板 / section 组对着目录查一遍（只提醒、不拦；官方 theme check 再兜一层）
      const problems =
        stateOf(shop).base !== undefined && isLayoutJson(rel)
          ? templateProblems(rel, content, catalogFor(shop, root))
          : []
      emit('site_theme.file_written', {
        workspace_id: ws,
        path: rel,
        created,
        ...(problems.length === 0 ? {} : { problems: problems.length }),
      })
      return { path: rel, bytes, created, ...(problems.length === 0 ? {} : { problems }) }
    },

    async push({ name, request }) {
      const trimmed = name.trim()
      if (trimmed === '')
        throw new SiteThemeError('invalid_input', '副本得有个名字，人在后台要认得出它')
      const { shop, spec } = await need('remote')
      // WP301：旧的自带主题那一份不再推（先在 Horizon 上新起一份）
      const legacy = legacyOf(shop)
      if (legacy !== undefined)
        throw new SiteThemeError('invalid_input', legacyThemeRefusal(legacy.version))
      const t = theme(spec)
      const root = rootOf(shop)
      if (themeFiles(root).length === 0)
        throw new SiteThemeError(
          'invalid_input',
          '主题工作目录是空的：先起底（theme_init_from_base，在店里复制一份 Horizon）或拉一份（theme_pull）',
        )
      const state = stateOf(shop)
      // WP304：推过一次就不再是「刚选好」（之后再叫起底照老规矩：起过底了）
      if (state.base?.chosen === true) delete state.base.chosen
      // 同名再推一次：那份副本还在、而且**不是线上那一份**，就推到它上面（不在店里堆一份又一份）
      const earlier = [...state.pushes].reverse().find((p) => p.theme_name === trimmed)
      let pushed: PushedTheme
      if (earlier !== undefined) {
        const rows = await wrap(() => t.list(shop))
        const still = rows.find((r) => r.id === earlier.theme_id)
        pushed =
          still !== undefined && still.role !== 'main' && still.role !== 'live'
            ? await wrap(() => t.pushToTheme({ shop, theme_id: earlier.theme_id }))
            : await wrap(() => t.pushUnpublished({ shop, name: trimmed }))
      } else {
        pushed = await pushToCopy(shop, t, trimmed)
      }
      const record: ThemePushRecord = {
        theme_id: pushed.theme_id,
        theme_name: pushed.theme_name === pushed.theme_id ? trimmed : pushed.theme_name,
        preview_url: pushed.preview_url ?? `https://${shop}/?preview_theme_id=${pushed.theme_id}`,
        at: now(),
        changed_files: changedFiles(state.baseline, manifestOf(root)),
      }
      state.pushes = [...state.pushes.filter((p) => p.theme_id !== record.theme_id), record].slice(
        -20,
      )
      save()
      emit('site_theme.preview_ready', {
        workspace_id: ws,
        theme_id: record.theme_id,
        changed: record.changed_files.length,
      })
      const matter = request?.work_item?.id
      const checked = lastCheck.get(shop)
      if (matter !== undefined && record.preview_url !== undefined)
        options.notePreview?.(matter, {
          text: `预览好了：未发布主题「${record.theme_name}」（线上没动）。`,
          url: record.preview_url,
          label: record.theme_name,
          theme_id: record.theme_id,
          changed_files: record.changed_files.slice(0, 40),
          ...(checked === undefined ? {} : { check: checked }),
        })
      return record
    },

    async proposePublish({ theme_id, request }) {
      const { shop, spec } = await need('remote')
      // `before` 来自这一次真读（15 §1），不是模型说的
      const themes = await listWithPreview(shop, theme(spec))
      const ready = publishReadiness(themes as ThemeSummaryLike[], theme_id)
      if (!ready.ok) return { status: 'blocked', message: ready.message ?? '这一份提不了发布' }
      const target = themes.find((t) => t.id === theme_id) as ThemeSummary
      const live = themeLanes(themes as ThemeSummaryLike[]).published
      const state = stateOf(shop)
      const record = state.pushes.find((p) => p.theme_id === theme_id)
      /*
       * WP418（自查 A5）：只发**工坊推过预览**的那几份。别的未发布主题（店里本来就有的、太老改不了的）
       * 没在工坊里看过预览，直接发上线就是盲发——这是建站岗位唯一会直接改线上店面的动作。
       */
      if (record === undefined)
        return {
          status: 'blocked',
          message: `「${target.name}」不是在工坊里推的预览，没看过不能直接发上线。要用它，先让我在它上面起底、推一份预览给你看。`,
        }
      const files = record?.changed_files ?? []
      const preview = record?.preview_url ?? target.preview_url
      const assignment_id = request.actor.assignment_id
      let mandate: Mandate = { caps: {} }
      let level: 'L1' | 'L2' | 'L3' = 'L1'
      try {
        const config = options.effectiveConfig(assignment_id)
        mandate = config.actions.find((a) => a.id === 'stage_publish_theme')?.mandate ?? mandate
        level = config.automation.stage_publish_theme?.level ?? 'L1'
      } catch {
        // 查不到按最严那一档（L1）
      }
      const title = `将把主题「${target.name}」设为线上主题`
      const fileLines =
        record === undefined
          ? ['改了哪些文件：没有记录（这份副本不是在工坊里推的）']
          : files.length === 0
            ? ['相对起底 / 拉下来的那一份没改文件（原样）。']
            : [
                `改了 ${files.length} 个文件：`,
                ...files.slice(0, 12).map((f) => `· ${f}`),
                ...(files.length > 12 ? [`· 还有 ${files.length - 12} 个`] : []),
              ]
      const notes = [
        live === undefined
          ? `这家店线上还没有主题；批了之后「${target.name}」就是线上那一份。`
          : `把线上主题从「${live.name}」换成「${target.name}」——按下去顾客立刻就看得到。`,
        preview === undefined
          ? '批之前去后台点开这份副本看一眼。'
          : `批之前先点开预览看一眼：${preview}`,
        ...fileLines,
      ]
      const run_id = request.id
      const outcome = await options.ledger.stage({
        workspace_id: ws as never,
        role_id: request.actor.role_id,
        assignment_id,
        run_id,
        change_set_id: `cs_${run_id}_publish_${theme_id}`,
        kind: 'publish_theme',
        target: { type: 'theme', id: theme_id },
        field: 'live_theme',
        before:
          live === undefined
            ? { theme_id: '', theme_name: '' }
            : { theme_id: live.id, theme_name: live.name },
        after: {
          theme_id,
          theme_name: target.name,
          ...(preview === undefined ? {} : { preview_url: preview }),
          store: shop,
          files,
        },
        notes,
        created_by: { kind: 'agent', id: `agent_${request.actor.role_id}` },
        mandate,
        level,
        provenance: {
          run_id,
          seen: { theme: [theme_id, ...(live === undefined ? [] : [live.id])] },
          read_full: [`theme:${theme_id}`],
          recorded_at: now(),
        },
        approval: {
          title,
          summary: notes.join('\n'),
          recipients: [{ person: request.actor.person_id as never, via: 'owner' }],
          proposer: {
            kind: 'agent',
            id: `agent_${request.actor.role_id}`,
            assignment_id,
          },
          rule: 'owner',
          separation_of_duties: false,
          source_events: [],
        },
      } as StageInput)
      if (!outcome.ok) return { status: 'blocked', message: outcome.message }
      emit('site_theme.publish_staged', {
        workspace_id: ws,
        theme_id,
        change_id: outcome.change.id,
      })
      return {
        status: 'staged',
        message: `出了一张卡：${title}。你批了才换，批之前先点开预览看一眼。`,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    async apply(change) {
      if (change.kind !== 'publish_theme' || change.workspace_id !== ws) return undefined
      const after =
        change.after !== null && typeof change.after === 'object'
          ? (change.after as Record<string, unknown>)
          : {}
      const theme_id =
        typeof after.theme_id === 'string' && after.theme_id !== 'pending'
          ? after.theme_id
          : undefined
      const fromCommand =
        typeof after.command === 'string'
          ? /--store[= ]([^\s]+)/.exec(after.command)?.[1]
          : undefined
      const shop = typeof after.store === 'string' ? after.store : (fromCommand ?? storeOf()?.store)
      if (theme_id === undefined || shop === undefined)
        return {
          status: 'failed',
          error: { message: '卡上没写清发布哪一份主题、哪家店', retryable: false },
        }
      const r = await readiness()
      if (r.next !== undefined && r.next !== 'store')
        return { status: 'failed', error: { message: NEED_TEXT[r.next], retryable: true } }
      const spec = options.cliSpec()
      if (spec === undefined)
        return { status: 'failed', error: { message: NEED_TEXT.install_cli, retryable: true } }
      try {
        const t = cliFor(spec)
        const rows = await wrap(() => t.list(shop))
        const target = rows.find((row) => row.id === theme_id)
        if (target === undefined)
          return {
            status: 'failed',
            error: {
              message: `店里找不到这份主题（${theme_id}），可能已经被人删了`,
              retryable: false,
            },
          }
        const isLive = (row: { role?: string }): boolean =>
          row.role === 'main' || row.role === 'live'
        // WP418（自查 A5）：卡上写的「原来」与店里现在的线上主题对不上（有人在后台换过）→ 不发、照实说
        const before =
          change.before !== null && typeof change.before === 'object'
            ? (change.before as Record<string, unknown>)
            : {}
        const liveNow = rows.find(isLive)
        if (
          !isLive(target) &&
          typeof before.theme_id === 'string' &&
          before.theme_id !== '' &&
          liveNow !== undefined &&
          liveNow.id !== before.theme_id
        )
          return {
            status: 'failed',
            error: {
              message: `卡出来之后线上主题被换过（现在是「${liveNow.name}」，卡上写的是「${String(before.theme_name ?? before.theme_id)}」），这次没发。让我重新出一张卡。`,
              retryable: false,
            },
          }
        if (!isLive(target)) await wrap(() => t.publish({ shop, theme_id }))
        // 读回：再列一次，这一份真成了线上主题才算好了
        const after = await wrap(() => t.list(shop)).catch(() => undefined)
        const confirmed = after?.find((row) => row.id === theme_id)
        if (confirmed === undefined || !isLive(confirmed)) {
          emit('site_theme.publish_unverified', {
            workspace_id: ws,
            theme_id,
            change_id: change.id,
          })
          return {
            status: 'unknown',
            execution_id: `theme_publish_${change.id}`,
            outcome_ref: { type: 'theme', id: theme_id },
            error: {
              message:
                '发布命令跑完了，但读回来它还不是线上主题——去后台「在线商店 → 主题」看一眼。',
              retryable: false,
            },
          }
        }
        emit('site_theme.published', { workspace_id: ws, theme_id, change_id: change.id })
        return {
          status: 'ok',
          execution_id: `theme_publish_${change.id}`,
          outcome_ref: { type: 'theme', id: theme_id },
        }
      } catch (e) {
        return {
          status: 'failed',
          error: { message: e instanceof Error ? e.message : String(e), retryable: false },
        }
      }
    },
  }
}
