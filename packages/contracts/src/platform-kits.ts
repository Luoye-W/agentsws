/**
 * WP216（Luoye 10-05）：**建站平台 → 官方技能 / 官方工具 / 官方 CLI** 的映射。
 *
 * Luoye 原话：「这个是属于 Shopify 的，如果用户用的是其他建站方案，那又不一样……
 * 不要搞成不管什么建站的，都默认安装那个 skill 以及 Shopify CLI。」
 *
 * 所以这一张表是**平台专属那一套东西的唯一真源**，判据只有品牌档案里的
 * `storefront_platform`（51 §1 N0，见 `identity.ts` 的 `STOREFRONT_PLATFORMS`）：
 *
 * - 技能：名字出现在某一行 `skills` 里的，就是「平台专属技能」——只有品牌的平台**正是**那一行，
 *   职责运行时才加载它、技能页才列它；别的品牌一律当它不存在（不加载、不列、不下载）。
 * - 官方 MCP 工具：同一条——平台对得上，才进工具面。
 * - 官方 CLI：平台对得上，连接页 / 岗位页才出那张卡、服务端才去检测本机装没装。
 *
 * **加一个平台 = 往 {@link PLATFORM_KITS} 里加一行**（WooCommerce / Shopline / Shoplazza …），
 * 职责逻辑、运行时、技能页、卡片组件一行都不用改——它们只读这张表，没有一处写死 `'shopify'`。
 * 平台专属的话（卡上叫什么、教程是哪篇、命令是什么）都在这一行里。
 *
 * **平台没设 = 一样都不启用**；连了某个平台的店铺就按它推断（服务端做，写回档案、界面上可改）。
 *
 * 品牌改了平台：所有读法都是**每次现取**档案（运行时、技能页、卡片都不缓存），
 * 下一次运行 / 下一次刷新就跟着变；从 Shopify 改走时卡隐藏、技能停用，
 * **用户本机装好的 CLI 我们不碰**（不卸、不删它的登录状态）。
 */
import type { StorefrontPlatform } from './identity.js'

/** 官方技能从哪来（写进技能页与报告；`bundled` = 许可证允许原样随包分发）。 */
export interface PlatformSkillSource {
  /** 发布方（必须是平台官方）。 */
  publisher: string
  /** 上游仓库 `owner/name`。 */
  repo: string
  /** 上游许可证（SPDX）。 */
  license: string
  /** `bundled` = 原样随包；`download` = 首次使用时从官方源下载到本机（许可证不许分发时）。 */
  install: 'bundled' | 'download'
}

/** 官方 MCP 工具源（只读工具；出网清单写在卡上）。 */
export interface PlatformMcpSpec {
  id: string
  /** 卡上 / 报告里叫它什么。 */
  label: string
  /** npm 包名与锁定版本（升级走 docs/42）。 */
  npm: string
  version: string
  license: string
  /** 它会连哪些地址（卡上照实列）。 */
  egress: readonly string[]
  /** 遥测怎么关（我们起子进程时一律关掉）。 */
  telemetry_off_env: Readonly<Record<string, string>>
}

/** 官方命令行工具（不进安装包，用户按需装；登录永远是用户本人在浏览器里完成）。 */
export interface PlatformCliSpec {
  id: string
  /** 卡标题（「Shopify CLI」）。 */
  label: string
  /** 可执行文件名。 */
  bin: string
  /** 报版本的参数（`shopify version`）。 */
  version_args: readonly string[]
  /** npm 包名（教程与报告里写）。 */
  npm: string
  license: string
  /** 要求的最低 Node 主版本号（官方 `engines.node`）。 */
  min_node_major: number
  /** 官方推荐的安装命令（卡上可复制；第一条是默认）。 */
  install: readonly { method: 'npm' | 'homebrew'; command: string }[]
  /** 用户自己在终端里跑、会在浏览器里打开登录页的那条命令。 */
  login_command: string
  /** 教程（`docs/help/<slug>.md`）。 */
  tutorial: string
  /** 卡出现在哪几个岗位页上。 */
  positions: readonly string[]
  /** 哪几条职责会用到它（CLI 不在 / 没登录时这几条降级）。 */
  roles: readonly string[]
  /** 子进程环境里关掉遥测的变量。 */
  telemetry_off_env: Readonly<Record<string, string>>
}

export interface PlatformKit {
  platform: StorefrontPlatform
  /** 官方技能（`packages/skills/bundled/<name>/` 的目录名）。 */
  skills: readonly string[]
  skill_source?: PlatformSkillSource
  mcp?: PlatformMcpSpec
  cli?: PlatformCliSpec
}

/** 这一单只填 Shopify 一行。 */
export const PLATFORM_KITS: readonly PlatformKit[] = [
  {
    platform: 'shopify',
    /*
     * 官方 Shopify-AI-Toolkit 2.0（2026-09-25）起把 22 本分题技能合成了**一本 `shopify`**，
     * `shopify-liquid` 等旧名已退役（官方 CHANGELOG 标 Breaking）。所以我们装的是这一本，
     * 原样放在 `packages/skills/bundled/shopify/`（MIT，允许原样分发），只带与建站相关的三份参考。
     */
    skills: ['shopify'],
    skill_source: {
      publisher: 'Shopify',
      repo: 'Shopify/Shopify-AI-Toolkit',
      license: 'MIT',
      install: 'bundled',
    },
    mcp: {
      id: 'shopify-dev-mcp',
      label: 'Shopify Dev MCP',
      npm: '@shopify/dev-mcp',
      // 与 `apps/server/src/shopify-devmcp.ts` 的 DEV_MCP_ARGS 同一个版本（测试钉住两边一致）
      version: '1.15.0',
      license: 'ISC',
      egress: ['shopify.dev', 'raw.githubusercontent.com', 'registry.npmjs.org'],
      telemetry_off_env: { OPT_OUT_INSTRUMENTATION: 'true', DO_NOT_TRACK: '1' },
    },
    cli: {
      id: 'shopify-cli',
      label: 'Shopify CLI',
      bin: 'shopify',
      version_args: ['version'],
      npm: '@shopify/cli',
      license: 'MIT',
      // `@shopify/cli` 4.x 的 engines.node 是 >=22.12.0；这里只比主版本，22.0–22.11 由 CLI 自己报
      min_node_major: 22,
      install: [
        { method: 'npm', command: 'npm install -g @shopify/cli@latest' },
        { method: 'homebrew', command: 'brew tap shopify/shopify && brew install shopify-cli' },
      ],
      login_command: 'shopify auth login',
      tutorial: 'shopify-cli',
      positions: ['site'],
      // 主题工作流（拉主题 / 推未发布副本 / theme check）只在网页模板这一条上；邮件模板在店铺后台改，不经 CLI
      roles: ['site.shopify-theme'],
      telemetry_off_env: { SHOPIFY_CLI_NO_ANALYTICS: '1', OPT_OUT_INSTRUMENTATION: 'true' },
    },
  },
]

/** 所有平台 CLI 的关遥测变量并在一起（终端沙箱里跑 CLI 时一律带上）。 */
export function platformCliTelemetryOffEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const kit of PLATFORM_KITS) Object.assign(out, kit.cli?.telemetry_off_env ?? {})
  return out
}

/**
 * 这个平台那一行；没有 = 这个平台没有专属的官方技能 / 工具 / CLI。
 *
 * **平台没设（`undefined`）就是没有**——不按 Shopify 兜底（Fable 10-05：「不要不管什么建站都默认装」）。
 * 这与店铺连接那张表（`storefrontConnectorService`）缺省按 Shopify 不是一个口径：那一张管的是
 * "存量工作区的店铺读写不许变"，这一张管的是"装不装平台专属的东西"，后者宁缺。
 * 没设平台的品牌由服务端按已连的店铺推断（连了 Shopify 店 → Shopify，并写回档案）。
 */
export function platformKitOf(platform: StorefrontPlatform | undefined): PlatformKit | undefined {
  if (platform === undefined) return undefined
  return PLATFORM_KITS.find((k) => k.platform === platform)
}

/** 平台专属 CLI 会出现在哪些岗位页上（所有平台那一行的并集；没设平台时用它判断要不要提示「先选平台」）。 */
export function platformPositions(): string[] {
  return [...new Set(PLATFORM_KITS.flatMap((k) => k.cli?.positions ?? []))]
}

/** 名字出现在任何一行里的技能 = 平台专属技能。 */
export function isPlatformSkill(name: string): boolean {
  return PLATFORM_KITS.some((k) => k.skills.includes(name))
}

/**
 * 这本技能在这个平台的品牌上能不能用。
 *
 * 不是平台专属的（品牌话术、内容与搜索…）永远能用；平台专属的只在平台对得上时能用。
 */
export function skillOnPlatform(name: string, platform: StorefrontPlatform | undefined): boolean {
  if (!isPlatformSkill(name)) return true
  return platformKitOf(platform)?.skills.includes(name) === true
}
