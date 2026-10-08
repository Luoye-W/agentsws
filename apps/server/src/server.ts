/**
 * 协同服务进程（28 §1「一进程含内核与全部模块」）。
 *
 * 装配顺序：kernel → data → roles → knowledge → skills → model-gateway → txn → identity → api。
 * 只监听 127.0.0.1；一个进程一个端口（`AGENTSWS_PORT`，默认 4317）。
 */
import { promises as dnsPromises } from 'node:dns'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import {
  adDesignPrompt,
  breakEvenView,
  resolveGrossMargin,
  summarizeLineCompare,
} from '@agentsws/ads-core'
import type {
  AskPort,
  ChatPort,
  ConnectionDirectoryPort,
  FreeChatPort,
  PositionEntryPort,
  SiteThemeView,
  WorkPort,
  WorkstationPort,
} from '@agentsws/api'
import {
  ApiError,
  canAdministerOrganization,
  createAsyncTraceScope,
  createGateway,
  createMemoryExtensionStore,
  createMemoryIdentity,
  createSqliteIdentity,
  type DiscoveryHelloView,
  type EventLogPort,
  type Gateway,
  type GatewayDeps,
  type GuardrailPort,
  type KnowledgePort,
  type LocalIdentityService,
  type ModelsActor,
  type PersonaPort,
  parseSubprotocols,
  type RolesPort,
  readCookie,
  SESSION_COOKIE,
  type SeoPort,
  type SkillsPort,
  SqliteExtensionStore,
  SqliteIdempotencyStore,
  SqliteIdentityService,
  type TraceScope,
  WS_SUBPROTOCOL,
  WsSession,
} from '@agentsws/api'
import { guessIndustry } from '@agentsws/b2b-core'
import { blobKey, blobUri, openBlobStore } from '@agentsws/blob'
import { designRoleFamily } from '@agentsws/brand-design'
import type { PageFetch as BrandIntakeFetch } from '@agentsws/brand-intake'
import type { ResolveMx } from '@agentsws/channels'
import { routeOfPosition } from '@agentsws/channels'
import { LOCAL_RUNTIME_ENV } from '@agentsws/connect-adapter'
import type {
  AdsCaps,
  ApprovalBus,
  ApprovalItem,
  Assignment,
  Clock,
  ContentPublicKey,
  DataSourceLevel,
  EventEnvelope,
  Halt,
  ImageProvider,
  KolChannel,
  Person,
  PersonId,
  PlatformCliSpec,
  PromptSection,
  SearchDataPort,
  SkillTier,
  StartRun,
  StorefrontPlatform,
  Workspace,
  WorkspaceId,
  WorkspaceVertical,
} from '@agentsws/contracts'
import {
  ADS_DEFAULT_CAPS,
  ADS_PLATFORMS,
  AI_IMAGE_EDIT_CAPABILITY,
  B2B_FACT_SUBJECT_TYPE,
  B2B_SENDER_CHOICE_KIND,
  brandNameOf,
  CONTENT_CHECK_INTERVAL_MS,
  CONTENT_SIGNING_PUBLIC_KEYS,
  contentChannelOf,
  KOL_AUDIT_CAPABILITY,
  KOL_CHANNEL_IDS,
  KOL_FOLDER,
  PLACEHOLDER_OWNER_EMAIL,
  PR_ROLE_IDS,
  platformKitOf,
  REDDIT_READ_HOSTS,
  resolveDataCreditBudget,
  SOCIAL_ROLE_IDS,
  skillOnPlatform,
  socialChannelSpec,
} from '@agentsws/contracts'
import {
  EXTERNAL_FENCE,
  evaluateGuardrail,
  extractFigures,
  resolveTimeZone,
  uncitedFigures,
} from '@agentsws/core'
import { createDataStore, type SqliteDataStore } from '@agentsws/data'
import { withOwnSources, withReadVia } from '@agentsws/deck'
import { resolveBrandSystem } from '@agentsws/design-core'
import type { WebCredential } from '@agentsws/dsh-adapter'
import {
  type OfficialPluginBackend,
  OfficialPluginError,
} from '@agentsws/dsh-adapter/official-plugins'
import {
  OFFICIAL_SCHEDULE_BUNDLE,
  type OfficialSelector,
} from '@agentsws/dsh-adapter/official-schedule'
import { createKernel, type Kernel, seededRandom } from '@agentsws/kernel'
import {
  cardsToPack,
  createKnowledge,
  type Knowledge,
  type RecheckStatus,
  zipFiles,
} from '@agentsws/knowledge'
import {
  type AccountFetch,
  createModelGateway,
  type FetchLike,
  GatewayError,
  type ModelGatewayApi,
  type PageFetch,
  stubImageProvider,
  stubProvider,
} from '@agentsws/model-gateway'
import {
  changeKindOf,
  createRoleStore,
  loadBundledRole,
  personaTextIn,
  type RangeExpanded,
  type RoleStore,
  rangeTargetOfProduct,
  renderBrandContext,
  SUPERSEDED_POSITION_IDS,
  type SupervisedPosition,
} from '@agentsws/roles'
import { createBrandRouter, type ScheduleTask } from '@agentsws/schedule'
import type { SearchFetch } from '@agentsws/search-providers'
import {
  disconnectedSearchConsole,
  pendingSearchConsole,
  ruleFromFact,
  type SearchConsolePort,
} from '@agentsws/seo-core'
import { siteDesignPrompt, themeDesignVariables } from '@agentsws/site-core'
import { CONTENT_REJECT_TEXT, createSkills, readBundledSkill, type Skills } from '@agentsws/skills'
// WP74（37 §2.5）：统一日历里社媒那一层的撞车说明，判据只有 social-core 这一份
import { scheduleConflicts, scheduleRulesFor } from '@agentsws/social-core'
import { detectAnsweredBoundaries, SUPPORT_BOUNDARIES } from '@agentsws/support-core'
import { createTxn, SqliteTxnStore, type Txn } from '@agentsws/txn'
import { createWork, SqliteWorkStore, type Work } from '@agentsws/work'
import { type HttpBindings, type ServerType, serve } from '@hono/node-server'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import { WebSocketServer } from 'ws'
import {
  adsAttribution,
  adsDeckData,
  createAdsStore,
  seedDemoAds,
  snapshotLineCompare,
} from './ads.js'
import { createAdsService } from './ads-service.js'
import { compositeApprovals } from './approvals-composite.js'
import { createAskPort } from './ask.js'
import { type AutomationAssembly, createAutomation, sqliteFireCounter } from './automation.js'
import { demoB2bDeckData, withDemoB2b } from './b2b.js'
import { createB2bMail } from './b2b-mail.js'
import { type B2bOutboundAssembly, createB2bOutbound } from './b2b-outbound.js'
import { createB2bOutboundToolExecutor } from './b2b-outbound-tools.js'
import { type B2bSalesAssembly, b2bLetterheadOf, createB2bSales } from './b2b-sales.js'
import { type B2bServiceAssembly, createB2bService } from './b2b-service.js'
import { type B2bStore, createB2bStore } from './b2b-store.js'
import { MemoryBackend } from './backend.js'
import { type BackupRunResult, backupDirOf, backupKeepOf, runBackup } from './backup.js'
import { attachBootBrandToCompany } from './boot-brand-org.js'
import {
  BrandAssetError,
  type BrandAssets,
  brandAssetRow,
  createBrandAssets,
} from './brand-assets.js'
// WP121b（70 §3.5）：确认档案卡那一刻建的首批知识条目（政策要点 + 商品卡，一律 proposed）
// WP215：每个品牌一套后台（品牌急停、全进程并发上限、切换器那一格）
import { type BrandBackground, createBrandBackground } from './brand-background.js'
import {
  type BrandDesignAssembly,
  createBrandDesign,
  designPageKindOf,
  shopifyThemeSettings,
} from './brand-design.js'
import { createBrandIntake } from './brand-intake.js'
import { brandKnowledgeCards } from './brand-knowledge.js'
// WP66（52 O1）：一个进程装多套品牌模块——落盘目录、凭据前缀与容器都在这里
import {
  type BrandModuleSet,
  type BrandModules,
  brandDirOf,
  createBrandModules,
  secretsPrefixOf,
} from './brand-modules.js'
// WP66：按 `actor.workspace_id` 取模块的**那一处**适配层（不散落到每条路由）
import {
  brandAdsPort,
  brandAskPort,
  brandB2bOutboundPort,
  brandB2bPort,
  brandB2bSalesPort,
  brandCloudPort,
  brandConnectionDirectoryPort,
  brandConnectionsPort,
  brandDesignPort,
  brandFreeChatPort,
  brandKolPort,
  brandMessagesPort,
  brandModelsPort,
  brandPositionPort,
  brandPrPort,
  brandSecretaryPort,
  brandSitePort,
  brandSocialPort,
  brandWorkArchivePort,
  brandWorkPort,
  brandWorkstationPort,
} from './brand-ports.js'
import { BrowserSettingsError, createBrowserSettings } from './browser-settings.js'
import {
  BrowserSkillInstallError,
  browserSkillDoctor,
  bskPathIn,
  installBrowserSkillCli,
  readLock,
} from './browserskill-install.js'
import { createCatalogIndex } from './catalog-index.js'
// WP95（36 §11）：第三栏「变更审阅」逐文件 diff / 「运行中的浏览器」汇总，两条只读投影
import { changeFiles } from './change-files.js'
import {
  type ChannelsAssembly,
  type ChannelsOptions,
  createChannels,
  type DirectMailInput,
  type DirectMailResult,
  deadLetterToRequeue,
} from './channels.js'
// WP57（48 §4 L3 #11）：在线聊天的实时车道（会话 / 轮次 / 计划 / 求助超时）
import {
  CHAT_ASSIST_TASK_ID,
  CHAT_ASSIST_TIMEOUT_HANDLER,
  type ChatLane,
  chatAssistTask,
  chatTurnView,
  chatView,
  createChatLane,
} from './chat.js'
import { ChatRelayClient, type OfflineMessageContent } from './chat-relay-client.js'
import { createChatWidget, DEFAULT_ACCENT } from './chat-widget.js'
import { type CloudFetch as CloudEntryFetch, cloudBaseUrl, createCloud } from './cloud.js'
import {
  CLOUD_TOKEN_SECRET_ID,
  type CloudAccountAssembly,
  type CloudFetch,
  createCloudAccount,
} from './cloud-account.js'
import { withCloudAttribution } from './cloud-attribution.js'
import { createRosterSync, isRosterEvent, type RosterSync } from './cloud-roster.js'
import { ComputerUseError, createComputerUse } from './computer-use.js'
import { ComputerUseInstallError } from './computer-use-install.js'
import { openConnectOwners } from './connect-owners.js'
import { connectBaseUrl } from './connect-url.js'
// WP83（54 §4）：连接目录 + 岗位连接清单 + 自定义 MCP 服务器（保存 / 校验 / 探测）
import type { ConnectionDirectoryAssembly } from './connection-directory.js'
import { createConnectionDirectory } from './connection-directory.js'
import {
  type ConnectionsAssembly,
  type ConnectLike,
  createConnections,
  createMailProbe,
} from './connections.js'
// WP219（docs/90）：已审的第三方内容更新（按品牌出卡 / 自动更新、原子换基础层、退回、三方合并）
import {
  CONTENT_UPDATES_ENV,
  type ContentFeedSource,
  type ContentFetch,
  type ContentUpdates,
  contentFeedSources,
  createContentUpdates,
} from './content-updates.js'
import { createDataService, dataServiceApiPort } from './data-service.js'
import {
  createDeepSeekAccount,
  DEEPSEEK_ACCOUNT_PROVIDER_ID,
  type DeepSeekAccountOptions,
} from './deepseek-account.js'
import { createDesignService, createDesignStore, designDeckData, seedDemoDesign } from './design.js'
import type { MdnsFactory } from './discovery.js'
import {
  createDshScenes,
  DSH_APP_DATA_ENV,
  type DshScenesManager,
  dshHomeOf,
  unavailableScenes,
  workspaceRootOf,
} from './dsh-scenes.js'
import { createEconomicsService } from './economics.js'
import { createPrivacyErase, type PrivacyErase } from './erase.js'
// WP119（68）：浏览器插件的本地一面（配对表按机器、写库按品牌、转发由本机做）
import { createExtensionContributor } from './extension-contribute.js'
import { brandExtensionPort } from './extension-port.js'
import { REVEAL_PRICE_CAPABILITY } from './extension-service.js'
import { chatCredits, createFreeChatPort } from './free-chat.js'
import { createFreeChatStore, type FreeChatStore } from './free-chat-store.js'
import { createGoogleReads, type GoogleReads } from './google-reads.js'
import {
  createHostedOwnerClient,
  ensureCloudModelDefault,
  hostedModeOf,
  hostedTargetOf,
  type OwnerFetch,
  seedHostedSecrets,
} from './hosted-mode.js'
import { createApprovalDirectory } from './housekeeping.js'
import { createImChannels, type ImChannelsAssembly, mountBrandImRoutes } from './im-channels.js'
import { feishuSdkTransportFactory, fetchHttp, wsSocketFactory } from './im-sdk.js'
import { createTeamBotManagerCheck } from './im-team-bots.js'
import { createImagePlacer } from './image-place.js'
import { createImageService, type ImageService } from './image-tools.js'
import { createJoin, type JoinAssembly } from './join.js'
// WP56（48 §4 #9）：知识包导入的落库那一步
import { knowledgeSourceFile } from './knowledge-file.js'
import { importKnowledgePack } from './knowledge-pack.js'
import { checkUpload, UploadRejected, uploadBlobKey, uploadSubjectRef } from './knowledge-upload.js'
import { createKolStore, kolDeckData, seedDemoKol } from './kol.js'
import { createByoSourceStore } from './kol-byo.js'
// WP67（48 §5.2）：红人库（按品牌各一套，进 `BrandModuleSet`）
import { createKolChannels, type KolFetch } from './kol-channels.js'
import { createKolPublicClient } from './kol-public-client.js'
import {
  createKolSandbox,
  kolOutreachApply,
  kolQuoteApply,
  kolSandboxIntercept,
} from './kol-sandbox.js'
import { CONTACT_SECRET_FIELD, contactSecretId, createKolService } from './kol-service.js'
import { createKolToolExecutor } from './kol-tools.js'
import {
  canEditMemory,
  canReadMemory,
  createLearningAssembly,
  type LearningAssembly,
  parseMemoryRef,
  seedDefaultSkill,
} from './learning.js'
import { createLiveDataSource, type LiveDataSource } from './live-data.js'
// WP77（59 §1 / §2）：建站库（三张表）+ `/v1/site/*` 的实现
import {
  createStoreMarketsNotices,
  createStoreMarketsSync,
  MARKETS_SETTINGS_PATH,
  marketsFromIntake,
} from './markets.js'
import { createMatterTitler } from './matter-title.js'
import { createMeetings, type MeetingsAssembly, seedDemoMeetings } from './meetings.js'
// WP113（63）：消息——统一收件处（消息库 / 全量同步 / 分拣 / 回写）
import { createMessages, type MessagesAssembly, type MessagesOptions } from './messages.js'
import {
  createModels,
  humanizeGatewayError,
  type ModelsAssembly,
  STUB_REF,
  templatesFor,
} from './models.js'
import { createNpmRegistryPreference, NPM_REGISTRY_URLS } from './npm-registry.js'
import { createOffboard, type Offboard } from './offboard.js'
import { createOfficialPlugins, officialPluginsDirIn } from './official-plugins.js'
import {
  createOnboarding,
  type OnboardingAssembly,
  RUN_BLOCK_MARKED_SINCE,
  storefrontPlatformChoices,
} from './onboarding.js'
import {
  modelSuggester,
  SUGGEST_MAX_OUTPUT_TOKENS,
  sha256 as suggestSha,
} from './onboarding-suggest.js'
import {
  createOpenConnectorInstaller,
  type OpenConnectorInstallerOptions,
} from './open-connector-installer.js'
import { createOrg, type OrgAssembly } from './org.js'
import { createOrgDuplicateScan, type OrgDuplicateScan } from './org-duplicates.js'
import {
  createOrganizations as createOrganizationsAssembly,
  type OrganizationsAssembly,
} from './organizations.js'
import { isOwnSubApproval } from './own-sub-queue.js'
import { alignOwnerEmail } from './owner-email.js'
import { createOwnerToolExecutor } from './owner-tools.js'
import { createPageBodyReader } from './page-body.js'
import {
  createFilePersonaBackend,
  createPersonas,
  PersonaError,
  type PersonasAssembly,
  personaFileIn,
} from './personas.js'
import {
  createPlatformCliProber,
  PlatformCliLoginStore,
  type PlatformCliProbe,
  type ProbeExec,
} from './platform-cli.js'
import {
  type CliJobView,
  CliRunnerError,
  createPlatformCliRunner,
  type PlatformCliRunnerOptions,
  type SpawnTool,
} from './platform-cli-runner.js'
import {
  type CliSession,
  cliSessionAlias,
  cliSessionEnv,
  cliSessionHome,
} from './platform-cli-session.js'
import { createPlatformKitPort, resolveBrandPlatform } from './platform-kit.js'
import {
  createPositions,
  isRouteChoice,
  type PositionsAssembly,
  retargetPositionMatters,
} from './positions.js'
import { createPrStore, prDeckData, seedDemoPr } from './pr.js'
import { createPrService } from './pr-service.js'
import { createPricingCatalog, type PricingCatalogSource } from './pricing-catalog.js'
import { readRouteLevelOf, readViaSources } from './read-route.js'
import {
  chainResearchTools,
  createReadRoutes,
  createReadRoutesStore,
  type ReadNetOptions,
  type ReadRoutesAssembly,
} from './read-routes/index.js'
import {
  createRedditReadAccount,
  type LoginWindowLauncher,
  type RedditReadAccount,
} from './readonly-browser/account.js'
import { createReadonlyBrowser, type ReadonlyBrowserOptions } from './readonly-browser/index.js'
import { redditReadBrowserOf, redditReadLimiterOf } from './readonly-browser/reddit.js'
import {
  createReconcileGuard,
  type ReconcileGuard,
  type ReconcileGuardOptions,
} from './reconcile.js'
import { createConnectRecordSource } from './records.js'
import {
  createRedditOfficialBrowser,
  type RedditOfficialBrowserOptions,
} from './reddit-official-browser/index.js'
import { createResearchToolExecutor, redditReadPrice } from './research-tools.js'
import { readRunBrowser } from './run-browser.js'
import { createRunLimitsSettings } from './run-limits-settings.js'
import { createRuntime, type MatterRecordSource, type RuntimeAssembly } from './runtime.js'
import {
  createScheduleAssembly,
  createSchedulePort,
  DEFAULT_RAW_RETENTION_DAYS,
  ensureSystemTasks,
  ensureTask,
  offsetToTz,
  parkPendingApprovals,
  registerAmazonSla,
  registerApprovalHousekeeping,
  registerB2bSequence,
  registerBackup,
  registerDailyPlan,
  registerEconomics,
  registerIdempotencySweep,
  registerKolSequence,
  registerLearning,
  registerMailPoll,
  registerMeetingPoll,
  registerOrgDuplicateScan,
  registerPlanRelay,
  registerPricingRefresh,
  registerPrMonitor,
  registerRawPrune,
  registerReconcileDeliveries,
  registerReview,
  registerSeo,
  registerSkillsWeekly,
  registerSocialBroadcast,
  registerSocialPublish,
  registerTokenRefresh,
  HANDLERS as SCHEDULE_HANDLERS,
  type ScheduleAssembly,
  type SchedulePosition,
} from './schedule.js'
import { createScopeAutoUpgrade, type ScopeAutoUpgrade } from './scope-auto-upgrade.js'
import {
  createOfficialSearchClient,
  createSearchDataService,
  createSearchDataStore,
  searchDataApiPort,
} from './search-data.js'
import {
  createSecretStore,
  namespaceSecrets,
  type SecretStore,
  SecretStoreError,
} from './secret-store.js'
import { createSecretaryAssembly, type SecretaryAssembly } from './secretary.js'
import { claimRuleCard, createSeoService, pickRoleHolder } from './seo-service.js'
import { ShopAdminError } from './shop-admin.js'
import {
  createShopAdmin,
  createStoreAuthRunner,
  type ShopAdminAssembly,
  STORE_SESSION_CLI_ID,
} from './shop-auth.js'
import { cloudShopReader, preferCloudShopAdmin } from './shop-cloud-admin.js'
import type { ShopOps } from './shop-ops.js'
import { createShopOps } from './shop-service.js'
import { createShopToolSurface } from './shop-tools.js'
import type { BrokerFetch } from './shopify-broker.js'
import { createCloudShopLinks, createShopifyConnect } from './shopify-connect.js'
import { createShopifyDevMcp } from './shopify-devmcp.js'
import { createRunCli, type RunCli } from './shopify-theme.js'
import { createConnectSiteFacts, createSiteService, createSiteStore, seedDemoSite } from './site.js'
import {
  createSiteTheme,
  type SiteThemeAssembly,
  SiteThemeError,
  type ThemeBasePin,
  type ThemeFetch,
} from './site-theme.js'
import { enrichSkillSummaries } from './skill-catalog.js'
import {
  createSocialStore,
  migrateSupersededChannels,
  seedDemoSocial,
  socialDeckData,
} from './social.js'
// WP73（56 §6）：九条渠道真打出去的那一跳 + 社媒库的 /v1 面
import { createSocialChannels, type SocialFetch } from './social-channels.js'
import { isSocialExecutableApproval } from './social-executor.js'
import { modelReplyDrafter } from './social-reply-draft.js'
import { createSocialService } from './social-service.js'
import { modelTagReviewer } from './social-tags.js'
import { createStandby } from './standby.js'
import { mountStatic } from './static.js'
import { createStorage } from './storage.js'
import { createSubscription, type SubscriptionOptions } from './subscription.js'
import { createScopeManagerRouter } from './supervisor.js'
import {
  createSupportJudgment,
  SUPPORT_SLA_HANDLER,
  SUPPORT_SLA_TASK_ID,
  type SupportJudgment,
  supportSlaTask,
} from './support-judgment.js'
import { createThemeToolExecutor } from './theme-tools.js'
import { createWeeklyReviewService } from './weekly-review.js'
// WP60（48 §4 L3 #11 的云端一半）：聊天窗的嵌入脚本与 CORS 预检
import { CHAT_WIDGET_JS, mountChatWidget } from './widget.js'
import { createWorkPort, periodQueryRunner } from './work.js'
import {
  createArchiveStateStore,
  createWorkArchive,
  type WorkArchiveAssembly,
} from './work-archive.js'
import {
  createWorkstationPort,
  emptyDataSource,
  type WorkstationDataSource,
} from './workstation.js'

/** 战报要数「今天处理掉的」，所以取队列时状态放全（等待类计数在 work 端自己过滤）。 */
/** WP212：「交给 X ▾」里常驻的五个岗位（与消息相关；别的岗位开着才列）。 */
const MESSAGE_POSITIONS: readonly string[] = [
  'customer-care',
  'kol-marketing',
  'b2b',
  'pr',
  'social-media',
]
/** 排序用：常驻五个按上面的顺序，其余排在后面。 */
const rank = (i: number): number => (i < 0 ? MESSAGE_POSITIONS.length : i)

const QUEUE_STATES = [
  'pending',
  'in_review',
  'approved',
  'approved_edited',
  'auto_approved',
  'rejected',
  'deferred',
  'applying',
  'applied',
  'apply_failed',
  'blocked',
  'expired',
  'withdrawn',
] as const

/** 队列上还等着人的状态（战报与计划里的「还有几张等你定」都用它）。 */
const WAITING_QUEUE_STATES = new Set(['pending', 'in_review'])

export const DEFAULT_PORT = 4317
/**
 * 默认只监听回环（13 §5：桌面壳的 sidecar，别人连不上）。
 *
 * WP40 加了一个开关 `AGENTSWS_BIND_HOST`，**唯一的用途是容器里**：
 * 在容器里 `127.0.0.1` 的意思是「连自己都只有容器里能连」，
 * 端口映射出去也是空的。容器档下真正的暴露控制在两处，都比这一行更靠外：
 * compose 的端口绑定（默认 `127.0.0.1:4317`，见 docker-compose.yml）与 NAS 的防火墙。
 *
 * 换句话说：**不在容器里就别设它**。默认值一个字没变。
 */
export const HOST = '127.0.0.1'
export const BIND_HOST_ENV = 'AGENTSWS_BIND_HOST'

/** 只接受回环与「全部网卡」两种——写别的地址多半是配错了，不如报出来。 */
/** 从字节认图型（视觉消息的 `mime` 那一格，WP122b 交付 ⑤）。认不出按 jpeg——provider 会拒，别在这一层猜第二遍。 */
/** WP144：电脑操控的两种错误翻成网关错误（人话原样带出去）。 */
/** WP180：官方插件被拒翻成网关错误——清单外 / 版本没审过是 forbidden，动作说不通（已装 / 没装）是 conflict。 */
async function officialPluginCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof OfficialPluginError) {
      const conflict = ['already_installed', 'not_installed', 'up_to_date'].includes(err.code)
      throw new ApiError(conflict ? 'conflict' : 'forbidden', err.message, {
        details: { reason: err.code },
      })
    }
    throw err
  }
}

async function computerUseCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ComputerUseError || err instanceof ComputerUseInstallError) {
      throw new ApiError(err.code, err.message)
    }
    throw err
  }
}

function imageMimeOf(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp'
  return 'image/jpeg'
}

export function bindHost(env: Record<string, string | undefined>): string {
  const raw = env[BIND_HOST_ENV]?.trim()
  if (raw === undefined || raw === '') return HOST
  if (raw === '0.0.0.0' || raw === '::' || raw === '127.0.0.1' || raw === '::1') return raw
  throw new Error(
    `${BIND_HOST_ENV} 只接受 127.0.0.1 / ::1 / 0.0.0.0 / ::（拿到的是 ${raw}）。` +
      '要限制谁能连，用 compose 的端口绑定或 NAS 防火墙，不要在这里写内网地址。',
  )
}
/**
 * WP76（58 §2 / 24）：品牌系统那张**公司层技能**叫什么。
 *
 * 写在这里而不是散在调用点：职责 yml 的 `skills` 里写的是同一个名字
 * （`roles/design/*.yml` 的 `- { name: brand-system, … }`），
 * 两处对不上的后果是设计岗读不到品牌系统，然后**每张图一个风格**——
 * 而界面上会说"这个品牌还没设过品牌系统"，看起来像用户没写。
 */
export const BRAND_SYSTEM_SKILL_NAME = 'brand-system'

/** v1 自带的职责定义（roles 包 bundled）。 */
export const BUNDLED_ROLES = [
  'common.owner',
  'common.member',
  // WP54（48 v2 L1）：客服岗位的三条职责
  'dtc.support',
  'dtc.live-chat',
  'amz.support',
  // WP62（51 §2.1）：网站运营岗位的第一条职责——店铺管理（旧 `dtc.ops`）
  'dtc.store',
  // WP64（51 §2.3 / §2.4）：网站运营岗位的邮件营销与订单履约
  'dtc.email-marketing',
  'dtc.fulfillment',
  // WP63（51 §2.2）：第二条——内容与博客
  'dtc.content',
  // WP67（48 §5.1）：红人营销岗位的五条渠道职责。
  // 种岗位那一步会把解析不到的职责筛掉，所以五条都得在这张表里——
  // 少一条，首次设置向导里的"红人营销"就少一个勾。
  'kol.youtube',
  'kol.instagram',
  'kol.tiktok',
  'kol.facebook',
  'kol.x',
  // WP72（56 §2）：社媒运营岗位的九条渠道职责 + 客服岗位新加的第四条。
  // 与红人那五条同一条理由：种岗位那一步会把解析不到的职责筛掉，
  // 少一条，首次设置向导里的"社媒运营"就少一个勾。
  // WP191（docs/86 §6）：`social.meta` 留着——老工作区的分配启动时才迁走，迁之前得读得进来
  'social.meta',
  'social.tiktok',
  'social.x',
  'social.youtube',
  // WP191（docs/86 §5）：Meta 拆成 FB 主页 + IG，另加 Threads 与 LinkedIn
  'social.facebook',
  'social.instagram',
  'social.threads',
  'social.linkedin',
  'social.facebook-group',
  'social.reddit',
  'social.discord',
  'social.telegram-group',
  'social.whatsapp',
  // WP72（56 §4）：客服岗位的社群管理
  'dtc.community-support',
  // WP76（58 §1）：设计岗位的五条职责。与红人 / 社媒那两批同一条理由：
  // 种岗位那一步会把解析不到的职责筛掉，少一条，首次设置向导里的"设计"
  // 就少一个勾——而这个岗位默认全勾，少一个勾就是少一条本来该有的职责。
  'design.dtc',
  'design.amazon',
  'design.social',
  'design.ads',
  'design.exhibition',
  // WP77（59 §1）：建站岗位的四条职责。第二条（`site.shopify-theme`）就是
  // WP44 的 `site.builder` 改了个名字，内容一个字没动。
  // 与红人 / 社媒同一条理由：种岗位那一步会把解析不到的职责筛掉，
  // 少一条，首次设置向导里的"建站"就少一个勾。
  'site.shopify-build',
  'site.shopify-theme',
  'site.shopify-email',
  'site.shopify-apps',
  // WP75（57 §1）：投放岗位的四条平台职责。与红人 / 社媒那两组同一条理由：
  // 种岗位那一步会把解析不到的职责筛掉，少一条，首次设置向导里的"投放"就少一个勾。
  'ads.meta',
  'ads.google',
  'ads.x',
  'ads.tiktok',
  // WP78（60 §1）：公共关系岗位的四条职责。与红人 / 社媒那两组同一条理由：
  // 种岗位那一步会把解析不到的职责筛掉，少一条，首次设置向导里的
  // "公共关系"就少一个勾。
  'pr.press',
  'pr.reddit',
  'pr.forums',
  'pr.monitoring',
  // WP171（docs/84 §11.5）：B2B 岗位的五条职责（第五条平台运营是第二批，YAML 先建、默认不勾）。
  // 与红人 / 社媒同一条理由：种岗位那一步会把解析不到的职责筛掉，少一条向导里就少一个勾。
  'b2b.sales',
  'b2b.outbound',
  'b2b.exhibition',
  'b2b.fulfillment',
  'b2b.marketplace',
] as const

/**
 * 36 §5.7 的 demo：把一个已经跑过场景的模拟世界接进同一个进程。
 *
 * 接进来的是**世界的**职责库与审批总线——工作台上看到的卡片就是场景真产生的那几条，
 * 不是照着抄一份。身份的 person_id / workspace_id 也跟着世界走，否则网关一律 404。
 */
export interface MountedWorld {
  workspace_id: WorkspaceId
  workspace_name?: string
  owner: { id: PersonId; email: string; name: string }
  roles: RoleStore
  approvals: ApprovalBus
  data: WorkstationDataSource
  /**
   * 世界自己的事件日志。接进来之后 `/v1/events` 与今日战报读的是**合一**的那一条：
   * 服务进程的日志 + 世界的日志按 id 归并。不给的话首页四格全是零——
   * 世界里的 `approval.created` / `run.completed` 根本不在服务进程的日志里（WP21 遗留）。
   */
  eventLog?: EventLogPort
  /**
   * WP140：这个世界里的人（id + 名字）。demo 的样例会议用它把与会人换成公司里的真人，
   * 待办负责人才叫得出名字。不给就用样本自带的那几位。
   */
  people?: { id: PersonId; name: string }[]
}

export interface ServerOptions {
  /**
   * SQLite 目录；不给则全部内存档（测试与一次性任务）。
   * 进程入口按 `AGENTSWS_DATA_DIR`（旧名 `AGENTSWS_DB_DIR` 仍认）取值。
   * 各包各自一个 `.sqlite` 文件，不共享表（35 §2）。
   */
  dbDir?: string
  env?: Record<string, string | undefined>
  port?: number
  /** 时间注入点；不给用系统时钟。 */
  clock?: Clock
  /** 随机注入点（seed 化）；不给用 seed = 当前毫秒。 */
  random?: () => number
  /** 启动时不往 stdout 打字（测试用）。 */
  quiet?: boolean
  /** 工作台构建产物目录；给了就在 `/` 托管（SPA fallback）。 */
  staticDir?: string
  /** demo：把模拟世界接进来（同一进程）。 */
  mount?: MountedWorld
  /**
   * 37 委托与「在事项里说话」都要起 Run。缺省由 `./runtime.ts` 自己装一个运行时适配器
   * （有模型 provider 配置就走 direct-llm，否则 stub）；调用方也可以自己塞一个进来。
   * 显式给 `false` 就是「这个进程不跑运行时」——那两条路回 not_implemented，其余照常。
   */
  startRun?: StartRun | false
  /** 事项现场的记录来源（订单 / 客户 / 联系人 / 工具执行器）；demo 由合成世界提供。 */
  records?: MatterRecordSource
  /**
   * WP66（52 O1）：给**某个品牌**接一份现成的数据源（demo 与测试用）。
   *
   * 与 `mount.data` 是同一个口子，只是按品牌问一次：`mount` 只接得了一个世界，
   * 而这一版一个进程装得下多套品牌模块。回 `undefined` 就是这个品牌走活数据源
   * （真实连接器）——生产路径从不传它，一个字节不变。
   */
  brandData?: (workspace_id: WorkspaceId) => WorkstationDataSource | undefined
  /**
   * WP154「内容与搜索」：给某个品牌接一个 Search Console 口（demo 与测试用替身）。
   *
   * 不给 = 按连接状态：没连就是「没连」，连了就是「已连上、读数那一步还没接」
   * （连接目录里那张卡能授权，查询词与页面的读口是下一版——本单不接真 GSC）。
   */
  searchConsoleFor?: (workspace_id: WorkspaceId) => SearchConsolePort | undefined
  /**
   * WP158：换掉某个品牌的 Search Console / GA4 读数层（demo 用替身连接器，不连真 Google）。
   * 不给 = 按这个品牌的真连接经 OpenConnector 读。生产路径从不传它。
   */
  googleReadsFor?: (workspace_id: WorkspaceId) => GoogleReads | undefined
  /**
   * WP154：换掉搜索数据接口（测试与 demo 用替身）。不给 = 这个品牌自己那一份 WP155
   * 路由口（官方 / 自带 key / 不接）；没接时 SERP 检查与 GEO 探测跳过，其余照跑。
   */
  searchDataFor?: (workspace_id: WorkspaceId) => SearchDataPort | undefined
  /**
   * WP25 的三个测试注入点。生产路径一个都不传，各自走真实现：Shopify 换令牌用
   * `globalThis.fetch`、MX 用 `node:dns/promises`、模型试跑用网关自己的 fetch。
   *
   * 之所以从这里穿下去而不是让测试自己拼一套：**端到端要跑的就是这条真装配线**
   * （路由 → 端口 → 加密库 → 网关），只把最外面那一跳换成回放，别处一行不动。
   */
  shopifyFetch?: BrokerFetch
  /** WP25：邮箱识别用的 MX 查询（测试注入）。 */
  resolveMx?: ResolveMx
  /** WP25：模型试跑用的 fetch（测试注入 →「测试」按钮全程不联网）。 */
  modelFetch?: FetchLike
  /**
   * WP188：随便聊「联网搜索」的替身（测试与 demo 不连 DeepSeek）。给了就不走官方搜索，
   * 也不要求登录 DeepSeek 账号 / 填 key（设置里把搜索关了仍然不搜）。
   */
  freeChatWebSearch?: (
    query: string,
  ) => Promise<{ sources: readonly { url: string; title?: string; snippet?: string }[] }>
  /** WP42：抓各家价目页用的 fetch（测试回放固定页面 → 价目刷新全程不联网）。 */
  pricingFetch?: PageFetch
  /**
   * WP90（55 §9 Q8）：起订阅登录那棵 dsh 树的工厂（测试注入替身 → 全程不联网、
   * 也不真的装一棵 Cordis 树）。生产不传：第一次有人点"用订阅登录"时才
   * `await import('@agentsws/dsh-adapter')`。
   */
  subscriptionLogin?: SubscriptionOptions['createLogin']
  /**
   * WP180：官方插件的注入点（测试用：换清单 / 锁定 patch 的路径、换插件层后端）。生产不传——
   * 清单与锁定 patch 用仓库里那两份，插件层用官方模块建在数据目录下。
   */
  officialPlugins?: {
    allowlistPath?: string
    profilePatchPath?: string
    backend?: OfficialPluginBackend
  }
  /**
   * WP219：内容更新的注入点（测试 / demo 用：本地替身更新源、现生成的钥匙、临时存放处）。
   * 生产不传：开关看 `AGENTSWS_CONTENT_UPDATES=on`（桌面安装包启动服务时给），钥匙用内置公钥
   * `CONTENT_SIGNING_PUBLIC_KEYS`（空 = 通道关着），存放处在数据目录下 `content-updates/`。
   */
  contentUpdates?: {
    enabled?: boolean
    root?: string
    keys?: readonly ContentPublicKey[]
    sources?: readonly ContentFeedSource[]
    fetch?: ContentFetch
    appVersion?: string
    /** 起来就查、之后每 6 小时查（缺省：开着就查；测试关掉自己调 `check()`）。 */
    schedule?: boolean
  }
  /**
   * WP216：检测本机平台 CLI 用的子进程（测试 / demo 换成替身，不跑真的 `shopify`）。
   * 生产不传：照 PATH 真跑 `<cli> version` 与 `node --version`。
   */
  platformCliExec?: ProbeExec
  /**
   * WP245：「一键安装 / 一键登录」替用户跑命令的注入点（测试 / demo 换成假 npm / 假 CLI，不联网）。
   * 生产不传：用服务进程自己的 node（捆绑的那份）+ 钉死的 npm，装进 `<数据目录>/tools`。
   */
  platformCliRunner?: Partial<Omit<PlatformCliRunnerOptions, 'now'>>
  /**
   * WP253：建站岗位主题工坊的注入点（测试 / demo 换成假 `shopify` 与本地假主题包，不联网、不碰真店）。
   * 生产不传：用 WP245 装好的 CLI 真跑，起底包从 codeload.github.com 下钉死的那一版。
   */
  siteTheme?: { run?: RunCli; fetch?: ThemeFetch; base?: ThemeBasePin }
  /**
   * WP261：店铺授权（`store auth`）与后台接口（`store execute`）的注入点（测试 / demo 换成进程内假 CLI + 假店，
   * 不联网、不碰真店）。生产不传：用 WP245 装好的 CLI 真跑，令牌在本品牌那一份会话目录里。
   */
  shopAdmin?: { run?: RunCli; spawn?: SpawnTool; fetch?: typeof fetch }
  /**
   * WP268：生图那一路的注入点（测试 / demo）：只回网址的上游与店里商品图怎么取字节（不给用全局 fetch）、
   * 等店铺文件处理好时怎么睡（测试给 0 秒）。生产不传。
   */
  images?: {
    fetch?: (
      url: string,
    ) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>
    sleep?: (ms: number) => Promise<void>
    /** 另外认哪些图片主机（demo 假店的 `cdn.shopify.test`）。 */
    extraImageHosts?: RegExp
    /** 没在设置页配生图时挂的那一条（测试接假云端、demo 接占位图）。生产不传 = 「生图还没配」那句人话。 */
    provider?: ImageProvider
  }
  /**
   * WP247：本机连接器下载器的注入点（测试换成假 npm，不联网）。生产不传：只有桌面壳设了
   * `AGENTSWS_CONNECT_LOCAL_RUNTIME=1`（它来起停本机连接器）且有数据目录时才装配。
   */
  localConnector?: Partial<Omit<OpenConnectorInstallerOptions, 'now' | 'dataDir'>>
  /**
   * WP134：「用我的 DeepSeek 账号登录」的注入点（测试 / demo 用替身 → 全程不联网）。
   * 生产不传：第一次有人点"用 DeepSeek 账号登录"时才 `import()` 官方模块。
   */
  deepseekAccount?: {
    /** 起官方那一侧宿主的工厂（替身：`@agentsws/dsh-adapter/deepseek-account-stand-in`）。 */
    createHost?: DeepSeekAccountOptions['createHost']
    /** 账号那一路推理口（Messages）的替身 fetch。 */
    fetch?: AccountFetch
    /** 登出后多久摘掉官方模块（测试调成 0）。 */
    signOutGraceMs?: number
  }
  /**
   * WP58（49 M1）/ WP59（49 M3）：往 agentsws 云发请求用的 fetch——关联账号那条
   * 与余额 / 价目那条共用同一个注入点。生产不传（走 `globalThis.fetch`）；
   * 测试传一个指向内存版 `createCloudServer()` 的替身 → 全程不联网。
   * 两边各自只用到 Response 的一小面（`text()` / `json()`），所以这里收一个交集。
   */
  cloudFetch?: CloudFetch & CloudEntryFetch
  /**
   * WP228：本机只读浏览器（Reddit「浏览器只读」那一路）。**给了才装**：生产入口（`index.ts`）给 `{}`，
   * 每个品牌各一份、要用时才起无头浏览器；测试塞替身会话 / 假的「文件在不在」。
   * 不给（或 `false`）= 不装，这一路照实「没配」——测试、模拟、演示里 stub 运行时命中 Reddit 的
   * grounding 也不会去起真浏览器、开真 reddit.com。
   */
  readonlyBrowser?:
    | (Partial<Pick<ReadonlyBrowserOptions, 'launch' | 'exists' | 'platform' | 'env' | 'nowMs'>> & {
        /** WP246：「登录读号」的窗口（测试 / 演示塞替身；默认真起有头浏览器）。 */
        loginWindow?: LoginWindowLauncher
        /** WP246：登录页与体检页的地址（测试指向本地假站点；默认真 Reddit）。 */
        loginUrl?: string
        whoamiUrl?: string
        /** WP246：只读白名单（测试放行本地假站点；默认 Reddit）。 */
        allowedHosts?: readonly string[]
      })
    | false
  /**
   * WP249（决策 89）：Reddit 官方号浏览器通道（每品牌一个独立配置目录，与只读读号分开）。
   * **给了才装**：生产入口给 `{}`；测试塞替身页面 / 本地假站点地址。不给 = 不装，Reddit 出口照旧
   * 只有 OAuth 接口那一条，「自家版待处理」读不了（照实说怎么接上）。
   */
  redditOfficialBrowser?:
    | Partial<
        Pick<
          RedditOfficialBrowserOptions,
          | 'launch'
          | 'openPage'
          | 'exists'
          | 'platform'
          | 'env'
          | 'nowMs'
          | 'origin'
          | 'allowedHosts'
          | 'limits'
          | 'sleep'
          | 'idleMs'
          | 'loginHeadless'
        >
      >
    | false
  /**
   * WP246：取数路线里要出网的那几级（YouTube 字幕、网页转文字、体检探测）。**给了才出网**：
   * 生产入口给 `{}`（用 `globalThis.fetch`）；测试塞指向本地假站点的 fetch。
   * 不给（或 `false`）= 不出网，两个工具照实说「没装」——测试、模拟、演示不会去敲真网站。
   */
  readNet?: ReadNetOptions | false
  /**
   * WP68（48 §5.4）：五条渠道适配器打出去用的 fetch。
   *
   * 生产不传（走 `globalThis.fetch`）；测试传一个假的，对着**真 URL 形状**断言——
   * 这五家的接口没有可以随便调的沙箱，所以"形状对不对"只能这么验。
   */
  kolFetch?: KolFetch
  /**
   * WP155：自带搜索数据 key 那一档直连服务商用的 fetch。生产不传（走 `globalThis.fetch`）；
   * 测试传录好的替身响应——服务商一个都不真打。
   */
  searchFetch?: SearchFetch
  /**
   * WP121b（70 §3）：品牌接入面（贴一个网址自动分析）抓页面用的 fetch。
   *
   * 生产不传（走 `globalThis.fetch`）；`agentsws demo` 传一个 replay——
   * demo 是**离线**的，它不该因为演示而去敲别人的服务器，也不该因为没网
   * 就演不出第 ② 步那张档案卡。
   */
  brandIntakeFetch?: BrandIntakeFetch
  /**
   * WP173：开发信那几跳的**替身**（测试与 demo 用；生产路径一个都不传）。
   *
   * - `dns`：发信邮箱体检查 SPF / DMARC（不做真 DNS 查询）；不传走 `node:dns` 的 `resolveTxt`；
   * - `mailboxes`：demo 没有真邮箱连接，「发信域名」那张卡的选项从这里来；不传读连接页；
   * - `sendMail`：替身 SMTP（测试信与开发信都进它，不真发）；不传走消息层的 `sendMail`。
   */
  b2bStandIns?: {
    dns?: { txt(name: string): Promise<readonly string[]> }
    mailboxes?: readonly string[]
    sendMail?: (input: DirectMailInput) => Promise<DirectMailResult>
    /** WP182：WhatsApp 发一条（测试替身；生产里这台机器还没接 WhatsApp 发信）。 */
    sendWhatsApp?: (input: {
      to: string
      text: string
      last_inbound_at?: string
      template_id?: string
    }) => Promise<{ ok: boolean; external_id?: string; message?: string }>
  }
  /**
   * WP73：社媒那九条渠道打出去的那一跳（测试塞一个假的对着真 URL 断言）。
   * 生产路径不传它，走全局 fetch。
   */
  socialFetch?: SocialFetch
  /**
   * WP46：OpenConnector 那一面的注入点（测试用替身 + 计数壳；生产不传，
   * 由 `connections.ts` 按 `AGENTSWS_CONNECT_URL` 自己选真适配器或替身）。
   */
  connect?: ConnectLike
  /**
   * WP51：局域网发现的三个注入点（生产一个都不传，走 `bonjour-service` 与 `fetch`）。
   *
   * 之所以从这里穿下去：**测试要跑的就是这条真装配线**（路由 → 端口 → discovery →
   * invites → 审批总线），只把最底下那一跳多播换成内存总线。
   */
  mdns?: MdnsFactory
  /** WP51：往同伴那边发请求（申请加入 / 告知失效）。 */
  discoveryPost?: (url: string, body: unknown) => Promise<{ ok: boolean; data?: unknown }>
  /** WP51：问同伴"你是谁"。 */
  discoveryHello?: (url: string) => Promise<DiscoveryHelloView | undefined>
  /**
   * WP46：活数据源的刷新间隔（毫秒）。不传按 `AGENTSWS_LIVE_DATA_REFRESH_SECONDS`
   * / 默认 5 分钟；传 `0` = 不起后台定时器（测试与一次性任务）。
   */
  liveDataIntervalMs?: number
  /**
   * WP25：Shopify 令牌到期巡检的间隔（毫秒）。
   *
   * **WP27 起缺省 0**：巡检改由调度器那条 `connect.shopify_refresh` 任务驱动
   * （到期前一小时换新，不再是 15 分钟一遍的 `setInterval`）。显式传一个正数
   * 仍会起旧的 `setInterval`——只给不想装调度器的嵌入式用法留个后门。
   */
  tokenRefreshIntervalMs?: number
  /**
   * 25 §4 调度循环的巡检间隔（毫秒）；缺省 30 秒。传 `0` = 不起后台定时器
   * （测试与模拟回路自己调 `scheduler.runDue`）。
   */
  scheduleIntervalMs?: number
  /**
   * WP34 渠道的测试注入：收信端与发信端。
   * 生产路径一个都不传，各自走真实现（imapflow / nodemailer）。
   */
  mailSource?: ChannelsOptions['makeSource']
  mailer?: ChannelsOptions['makeMailer']
  /**
   * WP113（63）消息面的测试注入：按「邮箱 × 文件夹」开收信端、按邮箱开回写端。
   * 生产路径一个都不传，各自走真 IMAP。
   */
  messageSource?: MessagesOptions['makeSource']
  messageWriter?: MessagesOptions['makeWriter']
  /**
   * WP204：「显示图片」的本机代取替身（demo 与测试不出网）。生产路径不传，走真代取
   * （只取公网 http(s)、只收图片、限大小）。
   */
  messageImages?: MessagesOptions['loadRemoteImage']
  /**
   * 15 §5.8 对账时的「这条到底写进去没有」回查。
   *
   * 缺省问后端自己（`MemoryBackend.verify`）。真接了平台之后这里换成按
   * `execution_id` / 平台对象的查询。答不上来回 `undefined`——**不许猜**。
   */
  verifyChange?: ReconcileGuardOptions['verify']
}

export interface Bootstrap {
  person: Person
  workspace: Workspace
  ownerAssignment: Assignment
  /** 开发期内部凭据；只在首次启动打印一次。 */
  internalToken: string
}

export interface Server {
  gateway: Gateway
  /** OpenConnector 本地 runtime 的地址（`AGENTSWS_CONNECT_URL`；全仓唯一真源）。 */
  connectUrl: string
  kernel: Kernel
  data: SqliteDataStore
  roles: RoleStore
  knowledge: Knowledge
  skills: Skills
  /** WP29 学习回路（lesson 池 / 次日提案 / 采纳落 overlay）。 */
  learning: LearningAssembly
  models: ModelGatewayApi
  txn: Txn
  /** 37 工作模型：事项 / 目标 / 待办 / 计划 / 复盘 */
  work: Work
  /** 37 §4 会议内核（存储 / 受控原始材料区 / 处理管线 / 端口）。 */
  meetings: MeetingsAssembly
  /** WP20 连接面（连接向导 / 本机加密秘密库 / 连接状态回灌工作台）。 */
  connections: ConnectionsAssembly
  /**
   * WP46 活数据源（真实店铺数据喂岗位面板）。接了模拟世界（`mount.data`）时没有它。
   */
  liveData?: LiveDataSource
  /** WP34 渠道面（IMAP 轮询 / 入站管线 / 受控原始材料区 / 出站发信）。 */
  channels: ChannelsAssembly
  /** WP113（63）消息面（消息库 / 全量同步 / 分拣 / IMAP 回写）——bootstrap 品牌那一份。 */
  messages: MessagesAssembly
  /** WP172（docs/84）：B2B 库（九类对象 + 询盘 / 抑制名单）——bootstrap 品牌那一份。 */
  b2b: B2bStore
  /** WP173（docs/84 §2）：开发信序列——bootstrap 品牌那一份（demo 的替身测试信要调它的 `observe`）。 */
  b2bOutbound: B2bOutboundAssembly
  /** WP182（docs/84 §3）：业务——bootstrap 品牌那一份（demo 种询盘首回、报价、样品、交接要调它）。 */
  b2bSales: B2bSalesAssembly
  /** WP182：B2B 库的草稿 → 卡那一口（demo 种报价用）。 */
  b2bService: B2bServiceAssembly
  /** WP57 在线聊天的实时车道（会话 / 轮次聚合 / 五种动作 / 求助超时）。 */
  chat: ChatLane
  /** WP25 模型面（provider 配置 / 热更新 / 按 purpose 记账）。 */
  modelSettings: ModelsAssembly
  /** WP28 制度面（职责 / 岗位 / 分配 / 策略层 / 成员与邀请）。 */
  org: OrgAssembly
  /**
   * WP120（69 §4）：角色定位面（看 / 公司层改写 / 还原 / 装 persona 那几段）。
   *
   * **一份，不按品牌分**：persona 是公司对外的口径，岗位模板与职责定义本来就是
   * 制度层的东西（与 `org.positions` 同一条理由）。
   *
   * 端出来的理由是晚绑定要可查：运行时装提示时调的是 `personas.sections()`，
   * 公司在右栏改写完，下一次运行就该拿到新的那一份——这一条得能被测试看见。
   */
  personas: PersonasAssembly
  /** WP51 首次设置与同事发现（公司档案 / 岗位清单 / 局域网发现 / 邀请码 / 申请加入）。 */
  onboarding: OnboardingAssembly
  /** WP65 组织与品牌（52 O1：公司 = 组织，品牌 = 工作区；品牌一览 / 加品牌 / 切品牌）。 */
  organizations: OrganizationsAssembly
  /**
   * WP66（52 O1）：这个进程里的**多套品牌模块**。
   *
   * 上面那几个按名字端出来的（`connections` / `channels` / `chat` / `modelSettings` /
   * `liveData` / `runtime` / `work` / `models`）都是 **bootstrap 品牌**那一份；
   * 要别的品牌那一套，走 `brands.forWorkspace(workspace_id)`。
   */
  brands: BrandModules
  /**
   * WP215（52 §4 收口）：每个品牌一套后台——哪些品牌在跑、品牌急停、全进程并发上限、
   * 切换器那一格的状态。调度循环共用 `schedule`，任务按自己的 `workspace_id` 用自己品牌的东西。
   */
  background: BrandBackground
  /**
   * WP117b（66 复测 #19）：把服务进程这本账上「批准了、等取消窗口」的卡施行掉。
   * 返回**还在等**的张数（取消窗口 / 父子顺序没到的也算）。demo 的 drain 每两秒
   * 调一次（与模拟世界那一本同一个节奏），见 `apps/cli/src/demo.ts` 的注释。
   */
  drainApprovals(): Promise<number>
  /** WP50 Join 向导（个人工作区并进公司：对照 / 合并 / 别名 / 退出）。 */
  join: JoinAssembly
  /** WP50 夜间扫描（45 H4：同唯一键 / 相似的组织对象出卡合并）。 */
  orgDuplicates: OrgDuplicateScan
  /** 41 §1 秘书 Agent（profile / 代答 / 日程 / 路由）。 */
  secretary: SecretaryAssembly
  /** WP36 离职编排（撤权限 → 真交接 → 个人层归档 / 销毁 → 个人记忆迁移 / 擦除 → 报告）。 */
  offboard: Offboard
  /** 本机加密秘密库：邮箱口令、Shopify 应用密钥、模型 key 都在这一个库里（前缀分开）。 */
  secrets: SecretStore
  /** WP58（49 M1）：云账号关联（令牌在上面那个加密库里，key 名 `cloud.workspace_token`）。 */
  cloudAccount: CloudAccountAssembly
  /**
   * WP165：本机手上的价目（云上公开的 `/v1/pricing` + 本机缓存）。生产入口 listen 之后
   * 调一次 `refresh()`；demo 也可以。测试不调就一个字节都不出机器。
   */
  pricingCatalog: PricingCatalogSource
  /**
   * WP219（docs/90）：已审的内容更新。没有存放处（不落盘的进程、又没注入）时不装配——
   * 设置里那一行不出，卡也不会出。
   */
  contentUpdates?: ContentUpdates
  /** 25 定时与流程：调度器 + 流程引擎 + 各个消费者的登记。 */
  schedule: ScheduleAssembly
  /** WP181：官方「自动化任务」包的那一层（四个工具的执行器、到点的处理器、`scheduled_task` 卡）。 */
  automation: AutomationAssembly
  /**
   * 15 §5.8「备份恢复后先跑对账再放开出站」。
   *
   * `createServer` 里只 `engage()`（该挂档就挂上，不做 IO）；真正跑对账在
   * `listen()` 里，或者由调用方自己 `await server.reconcile.run()`。
   */
  reconcile: ReconcileGuard
  /** 17 §4 运行时适配器 + `startRun`；`startRun: false` 时没有。 */
  runtime?: RuntimeAssembly
  identity: LocalIdentityService
  backend: MemoryBackend
  /** 请求外的后台动作（调度、执行器）可以借它把自己挂进同一条 trace。 */
  traceScope: TraceScope
  bootstrap: Bootstrap
  /** 已监听时的 URL（listen 之后才有）。 */
  url?: string
  listen(port?: number): Promise<{ url: string; port: number }>
  close(): Promise<void>
}

const priceTable = {
  'stub/stub-v1': { in: 0, out: 0, cached: 0 },
  'deepseek/deepseek-chat': { in: 0.27, out: 1.1, cached: 0.07 },
}

/**
 * 21 §1「所有模块的事件都进同一条日志」。demo 里世界与服务进程各有一份内核，
 * 所以读的时候按 id 归并成一条：`/v1/events` 的 `since` 续传与今日战报都靠它。
 *
 * 归并是**读侧**的：两边各自 append-only，谁也不改谁；id 是 ulid，按字典序即时间序。
 */
export function mergeEventLogs(base: EventLogPort, extra?: EventLogPort): EventLogPort {
  if (extra === undefined) return base
  return {
    async *read(filter) {
      const all: EventEnvelope[] = []
      for await (const e of base.read(filter)) all.push(e)
      for await (const e of extra.read(filter)) all.push(e)
      all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const since = filter.since
      const limit = filter.limit
      let n = 0
      for (const e of all) {
        if (since !== undefined && e.id <= since) continue
        if (limit !== undefined && n >= limit) return
        n += 1
        yield e
      }
    },
  }
}

/** `/v1/ws` 的路径（网关那边的路由声明与这里必须是同一个字面量）。 */
const WS_PATH = '/v1/ws'

/**
 * WP117b：一台**一只邮箱都没连**的机器上，演练回信落在哪只"邮箱"下。
 *
 * 只在消息库里一个账号都没有的时候才用得上（连了邮箱就跟着真那只走）。
 * 域名是 RFC 2606 的保留域，永远不可能对应一个真地址。
 */
const SANDBOX_MAILBOX = 'sandbox@agentsws.example'

/** 一封红人回信在「消息」列表上那一句话（≤ 40 字，说的是"它要你干什么"）。 */
const KOL_REPLY_SUMMARY: Readonly<Record<string, string>> = {
  interested: '红人说有兴趣，等你接话',
  wants_quote: '红人要报价——议价这一步永远人点头',
  declined: '红人谢绝了',
  already_working: '红人说已经在跟你们谈了，先查库别撞车',
  cold_inbound: '陌生红人主动来信，先打个分',
  spam: '像是群发推广',
  unknown: '看不出他什么意思，这封得你读一遍',
}

/**
 * 28 §2 WebSocket 事件流的**传输层**：在 `@hono/node-server` 返回的 `http.Server` 的
 * `upgrade` 事件上握手，成了就把这条连接交给 `WsSession`（协议逻辑全在 `@agentsws/api`）。
 *
 * 为什么不走 `hono/ws`：网关的中间件链（急停 → 鉴权限流 → 出站急停 → 绑 Assignment → 幂等）
 * 全部以 `Response` 为结果，拿不到底层 socket；而 Node 档下 `@hono/node-ws` 本来也是
 * `ws` 的一层包装。这样分：协议逻辑可单测、换宿主只换这一个函数。
 *
 * 鉴权与 REST 完全同一套（`IdentityService.authenticate`）：
 * - 浏览器同源：HttpOnly 会话 cookie，握手请求自带；
 * - 其他调用方：`Sec-WebSocket-Protocol: agentsws.v1, agentsws.bearer.<token>`。
 *   **token 一次都不进 URL**（20 §3 / 21 §5：URL 会进历史、进代理日志、进 Referer）。
 */
function mountEventStream(input: {
  httpServer: ServerType
  deps: GatewayDeps
  cookieName: string
}): () => Promise<void> {
  const { deps, cookieName } = input
  const wss = new WebSocketServer({
    noServer: true,
    // 浏览器要求服务端回一个**它提过的**子协议，否则连接直接失败
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  })
  const timers = new Set<NodeJS.Timeout>()

  const deny = (socket: Duplex, status: number, text: string): void => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // `req.url` 只用来认路径；凭据不从这里读
    const path = (req.url ?? '').split('?')[0]
    if (path !== WS_PATH) return
    void (async () => {
      const { token } = parseSubprotocols(req.headers['sec-websocket-protocol'])
      const cookie = readCookie(
        Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie,
        cookieName,
      )
      const credential = token ?? cookie
      if (credential === undefined) return deny(socket, 401, 'Unauthorized')
      const principal = await deps.identity.authenticate(credential)
      if (!principal) return deny(socket, 401, 'Unauthorized')
      wss.handleUpgrade(req, socket, head, (ws) => {
        const session = new WsSession(deps, principal, {
          send: (text) => {
            if (ws.readyState === ws.OPEN) ws.send(text)
          },
          close: (code, reason) => {
            ws.close(code, reason)
          },
        })
        // 巡检：事件日志没有推送口，这里按固定间隔读增量（间隔进 CONTROL/ready，客户端知道）
        const timer = setInterval(() => {
          void session.pump()
        }, session.pollIntervalMs)
        timer.unref?.()
        timers.add(timer)
        ws.on('message', (raw: unknown) => {
          void session.handle(String(raw))
        })
        const stop = (): void => {
          clearInterval(timer)
          timers.delete(timer)
        }
        ws.on('close', stop)
        ws.on('error', stop)
      })
    })().catch(() => {
      deny(socket, 500, 'Internal Server Error')
    })
  }

  input.httpServer.on('upgrade', onUpgrade)
  return async () => {
    input.httpServer.off('upgrade', onUpgrade)
    for (const t of timers) clearInterval(t)
    timers.clear()
    for (const client of wss.clients) client.terminate()
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve()
      })
    })
  }
}

export async function createServer(options: ServerOptions = {}): Promise<Server> {
  const env = options.env ?? process.env
  // WP128：是不是托管实例（Cloudflare Container 里那一份）；开了开关缺配置就在这里抛
  const hostedBoot = hostedModeOf(env)
  const clock: Clock = options.clock ?? { now: () => new Date().toISOString() }
  const random = options.random ?? seededRandom(Date.parse(clock.now()) % 2147483647)
  const dbDir = options.dbDir
  if (dbDir !== undefined) mkdirSync(dbDir, { recursive: true })
  const file = (name: string): string => (dbDir === undefined ? ':memory:' : join(dbDir, name))

  // 08 / 18：OpenConnector 的地址只在这一处解析（桌面壳读同名环境变量）
  const connectUrl = connectBaseUrl(env)

  /*
   * WP165（docs/83 §2）：价目只放云上。一台机器一份（不分品牌）：云上公开的 `/v1/pricing`
   * + 数据目录里一份缓存。同步读的那几处（生图 / 看邮箱 / 体检的积分价）只读手上这一份，
   * 从不因为同步读打网；生产入口 listen 之后顺手刷一次（`index.ts`），界面看价目时按需刷。
   */
  const pricingCatalog = createPricingCatalog({
    clock,
    baseUrl: cloudBaseUrl(env),
    ...(options.cloudFetch === undefined ? {} : { fetch: options.cloudFetch }),
    ...(dbDir === undefined ? {} : { dir: dbDir }),
  })

  const kernel = await createKernel({ dbPath: file('events.db'), clock, random, env })
  const traceScope = createAsyncTraceScope()

  // 21 §1：所有模块的事件都进同一条日志；请求内的 trace_id 覆盖模块自造的那个。
  const appendEvent = (e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void => {
    const { at: _at, ...rest } = e
    kernel.eventLog.appendSync({
      ...rest,
      schema_version: 1,
      correlation: {
        ...rest.correlation,
        trace_id: traceScope.current() ?? rest.correlation.trace_id,
      },
    })
    // WP206：名册变了（加人 / 删人 / 岗位 / 分配 / 刚关联上）→ 各品牌攒一下再把名册推上云
    if (isRosterEvent(e.type))
      for (const sync of rosterSyncs.values()) sync.poke(e.type === 'cloud.account_linked')
    // WP233：刚关联上云账号 → 本机负责人的占位邮箱改成云账号邮箱（不管是哪条关联路走过来的）
    if (e.type === 'cloud.account_linked') {
      cloudLinkedSink?.()
      // WP272：新签的令牌——补签没成的冷却作废
      scopeAutoUpgrade?.reset()
    }
  }
  /** WP233：晚绑定——云账号那一套装好之后才挂上（见 `alignOwnerEmail`）。 */
  let cloudLinkedSink: (() => void) | undefined
  /**
   * WP272：令牌缺动作集时后台自动补签（`scope-auto-upgrade.ts`）。晚绑定：各品牌的云面先建，
   * 账号面后装；没装好之前撞上缺动作集就照实回 403。
   */
  let scopeAutoUpgrade: ScopeAutoUpgrade | undefined
  /** WP206：每个品牌一份名册同步（品牌装好时建，`rosterReady` 之后才开始推）。 */
  const rosterSyncs = new Map<WorkspaceId, RosterSync>()
  let rosterReady = false

  const data = createDataStore({ dbPath: file('data.db'), clock, collections: [] })

  /**
   * 44 G5：品牌成员一变，挂它的岗位范围跟着变——记事件 + 给 owner 发卡的那一段
   * 住在 `createOrg`（它才有审批总线），而职责层比它先建起来，所以这里留一个晚绑定的钩子。
   */
  let rangeExpandedSink: ((e: RangeExpanded) => void) | undefined
  const roles =
    options.mount?.roles ??
    createRoleStore({
      clock,
      ...(dbDir === undefined ? {} : { dbPath: join(dbDir, 'roles.db') }),
      roles: BUNDLED_ROLES.map((id) => loadBundledRole(id)),
      /*
       * 连接表在下面才建；用一个晚绑定的读法，岗位 ready 从真实连接算。
       *
       * WP66：**按品牌问**——一条分配属于哪个品牌，就看那个品牌连了什么。
       * 少了这一层，品牌 B 的客服岗位会因为品牌 A 连了邮箱而显示"已就绪"。
       * 那个品牌的模块还没建出来时回空（岗位显示"缺连接器"）：
       * 任何一条走这个品牌的请求都会先把它建出来，下一次读就是真的。
       */
      connectedOf: (ws) => brands?.peek(ws)?.connections.connectedKinds() ?? [],
      onRangeExpanded: (e) => rangeExpandedSink?.(e),
    })

  // WP54（48 v2 L1）：职责改名 / 合并之后，库里已有的分配在**启动时迁一次**。
  //
  // 只在这里做，不在职责包里做：`packages/roles` 不认事件日志，而改名是一次变更，
  // 15 §1 的底线是"变更必须留痕"。迁移本身幂等（没有旧 id 的库跑一遍什么也不发生），
  // 所以每次起进程都跑得起，不需要一张"迁过没有"的标记表。
  // WP191（docs/86 §6）：**一拆几**的旧职责（`social.meta` → FB 主页 + IG）先迁，再迁一对一改名的。
  // 原分配就地改成第一条（id 不变：待办、卡、队列、定时任务、交接都跟着它），其余各复制一条；
  // 复制那条的事件多一格 `split_from`。幂等，与下面那一段同一条理由每次起进程都跑得起。
  const migrations = [...roles.assignments.splitRoleIds(), ...roles.assignments.migrateRoleIds()]
  for (const migrated of migrations) {
    appendEvent({
      schema_version: 1,
      workspace_id: migrated.workspace_id,
      type: 'assignment.role_migrated',
      actor: { kind: 'system', id: 'server' },
      correlation: { trace_id: `tr_role_migrate_${migrated.assignment_id}` },
      payload: {
        assignment_id: migrated.assignment_id,
        person_id: migrated.person_id,
        from: migrated.from,
        to: migrated.to,
        role_version: migrated.role_version,
        ...(migrated.split_from === undefined ? {} : { split_from: migrated.split_from }),
      },
    })
  }

  // WP40 / 41 §2：大文件（会议录音、邮件附件）住对象存储——本地目录（默认，NAS 就是
  // 把它指到共享目录）或 S3 兼容（阿里 OSS / 腾讯 COS / R2 / MinIO）。
  // 加密接同一个主体密钥环：销毁一个主体的密钥，他的每一个对象当场读不出来（21 §4）。
  //
  // **内存档（没有 dbDir）不开对象存储**：那一档的意思就是「什么都不落盘」，
  // 开了它会在当前工作目录里长出一个 `blobs/`——测试跑一遍就在仓库根上留一堆文件。
  // 这一档下附件与录音仍在内存 store 里，与 WP40 之前一模一样。
  const blobs =
    dbDir === undefined
      ? undefined
      : await openBlobStore({
          clock,
          cipher: data.keyring,
          env,
          defaultRoot: join(dbDir, 'blobs'),
        })

  /*
   * WP99：知识那一侧的事件接到**同一条**事件日志上。
   *
   * 以前 `createKnowledge` 没接 `emit`，于是 19 §6 里那几条 `knowledge.*`
   * （缺口开了 / 答了、复核开了 / 答了）发出来之后没人接，落不进日志。
   * 上传要"进溯源链"（谁传的、何时、sha256），而溯源链的落点就是这条日志——
   * 所以这一根线现在接上，那几条老事件跟着一起落。
   *
   * 载荷里**没有正文**：本包发出来的几条只带 id、subject_key、文件名与 hash
   * （21 §2 / 13 §4：内容不进日志）。
   */
  const knowledge = createKnowledge({
    dbPath: file('knowledge.db'),
    clock,
    emit: (e) => {
      appendEvent({
        schema_version: 1,
        workspace_id: e.workspace_id,
        type: e.type,
        at: e.at,
        actor: { kind: 'system', id: 'knowledge' },
        correlation: { trace_id: `tr_knowledge_${Date.parse(e.at).toString(36)}` },
        payload: e.payload,
      })
    },
  })
  const skills = createSkills({ clock, random })

  // WP25：本机加密秘密库建**一次**，连接面（邮箱口令 / Shopify 应用密钥）与
  // 模型面（API key）共用同一个库，靠 key 前缀分开。谁建的谁关——这里建，这里关。
  const secrets = createSecretStore({ dbPath: file('secrets.sqlite'), clock, env })

  /*
   * WP82（55 §3 末段）：浏览器设置——**一台机器一份**，不按品牌分。
   *
   * 与连接、模型那些"按品牌各一份"的东西不同：attach 接的是用户自己电脑上那个
   * Chrome，它与卖哪个品牌无关；同一台机器上的所有品牌用同一个浏览器。
   *
   * `runtimeMode` 决定允不允许 attach（只有个人档允许）。今天工作区的
   * `runtime.mode` 一律是 `local`（`identity` 建的时候就写死了），所以这里另给
   * `AGENTSWS_RUNTIME_MODE` 一个口子：Docker / 托管档的部署把它设成 `docker` /
   * `hosted`，attach 那一项在设置页上就会灰掉、`PUT` 也会拒。
   */
  const runtimeMode = (): 'local' | 'docker' | 'hosted' => {
    const declared = env.AGENTSWS_RUNTIME_MODE?.trim()
    return declared === 'docker' || declared === 'hosted' || declared === 'local'
      ? declared
      : 'local'
  }
  /*
   * WP136（docs/79）：dsh 场景切换。只有本机档（dsh 起在用户那台电脑上）、且有落盘目录时装配；
   * 别的档 `GET /v1/dsh-scenes` 回 `available: false` 与一句人话，其余几条回 not_implemented。
   * `DSH_HOME` 在数据目录旁边（桌面壳给的是 `<userData>/dsh`），永远不是 `~/.dsh`。
   */
  const dshScenesSetup = ((): { manager?: DshScenesManager; reason: string } => {
    if (runtimeMode() !== 'local') return { reason: '只有装在你自己电脑上的 Agents 工坊能切换场景' }
    const home = dshHomeOf(env, dbDir)
    if (home === undefined) return { reason: '这台服务没有数据目录（全内存档），没有地方放场景' }
    const appData = env[DSH_APP_DATA_ENV]?.trim()
    try {
      return {
        reason: '',
        manager: createDshScenes({
          dshHome: home,
          workspaceRoot: workspaceRootOf(env),
          protectedDirs: [
            ...(dbDir === undefined ? [] : [dbDir]),
            ...(appData === undefined || appData === '' ? [] : [appData]),
            home,
          ],
          baseEnv: env,
          log: (line) => {
            if (options.quiet !== true) process.stdout.write(`${line}\n`)
          },
        }),
      }
    } catch (err) {
      return { reason: err instanceof Error ? err.message : String(err) }
    }
  })()
  const dshScenes = (): DshScenesManager => {
    if (dshScenesSetup.manager === undefined)
      throw new ApiError('not_implemented', dshScenesSetup.reason)
    return dshScenesSetup.manager
  }
  /** WP236：运行时长线（这台机器一份，`run-limits.json`）。 */
  const runLimitsSettings = createRunLimitsSettings(dbDir === undefined ? {} : { dir: dbDir })
  const browserSettings = createBrowserSettings({
    ...(dbDir === undefined ? {} : { dir: dbDir }),
    runtimeMode,
    /*
     * WP92（55 §10）：`bsk` 装在数据目录下的 `bin/bsk`——**不进 PATH**。
     * PATH 上有 `bsk` 的话，有 shell 的职责就能直接 `bsk evaluate` 在页面里跑脚本；
     * 那条路归 shell 的命令 allowlist 管（WP89），这里先不给它这个方便。
     * 没有数据目录（全内存档）= 装不了，那一项就一直是"还没装"。
     */
    defaultBskPath: () => (dbDir === undefined ? undefined : bskPathIn(dbDir)),
  })
  /*
   * WP144（docs/80）：电脑操控——**一台机器一份**，理由与浏览器设置逐字相同（操作的是
   * 这台电脑本身，与卖哪个品牌无关）。驱动装在数据目录下（不进 PATH）；只有本机档给。
   */
  const computerUse = createComputerUse({
    ...(dbDir === undefined ? {} : { dir: dbDir, dataDir: dbDir }),
    runtimeMode,
    clock,
  })
  /*
   * WP180：官方插件——同样**一台机器一份**（插件跟着这台电脑上的 dsh 走）。装 / 升级 / 卸载出卡、
   * 只从审过的清单装、做完锁定 patch 逐字节比一遍；插件层在数据目录下 `official-plugins/`。
   */
  const officialPlugins = createOfficialPlugins({
    ...(dbDir === undefined ? {} : { dir: officialPluginsDirIn(dbDir) }),
    ...(options.officialPlugins?.allowlistPath === undefined
      ? {}
      : { allowlistPath: options.officialPlugins.allowlistPath }),
    ...(options.officialPlugins?.profilePatchPath === undefined
      ? {}
      : { profilePatchPath: options.officialPlugins.profilePatchPath }),
    ...(options.officialPlugins?.backend === undefined
      ? {}
      : { backend: options.officialPlugins.backend }),
    appendEvent,
    clock,
  })
  /*
   * WP181：官方「自动化任务」在我们运行里真用起来（`automation.ts`）。**一个进程一份**、跨品牌
   * （调度器本来就是一个进程一个，任务上带着各自的品牌）。开关就是上面那一行插件装没装——设置 →
   * 官方插件装上（出卡批过）之后，下一次运行就挂四个工具；卸了就停（任务留着）。
   * 调度器、审批总线、品牌模块都比这里晚建，所以全是惰性取值。
   */
  // 每天到点自动跑的次数落盘（Fable 终审：重启不清零）；全内存档就记在内存
  const automationFires =
    dbDir === undefined ? undefined : sqliteFireCounter(join(dbDir, 'automation.sqlite'))
  const automation = createAutomation({
    ...(automationFires === undefined ? {} : { fires: automationFires }),
    scheduler: () => schedule.scheduler,
    clock,
    appendEvent,
    approvals: () => approvals,
    enabled: async () =>
      (await officialPlugins.view()).plugins.some(
        (p) => p.name === OFFICIAL_SCHEDULE_BUNDLE && p.state === 'installed',
      ),
    companyZone: async (ws) => resolveTimeZone((await identity.getWorkspace(ws))?.tz).zone,
    runner: async (ws) => {
      const brand = await brands?.forWorkspace(ws)
      return brand === undefined
        ? undefined
        : {
            work: brand.work,
            ...(brand.startRun === undefined ? {} : { startRun: brand.startRun }),
          }
    },
  })

  /*
   * WP90（55 §9 Q8）：用 ChatGPT / Claude 的**订阅**登录——也是"一台机器一份"，
   * 而且**按人分开**（账号是人的，不是工作区的，也不是品牌的）。
   *
   * 所以它用的是**没按品牌命名空间**的那个秘密库：换个品牌不该要求你重登一次
   * ChatGPT。只有个人档才开（`runtimeMode`），公司档 / 托管档上整块不可用。
   */
  const subscription = createSubscription({
    clock,
    secrets,
    runtimeMode,
    ...(dbDir === undefined ? {} : { dbDir }),
    ...(options.subscriptionLogin === undefined ? {} : { createLogin: options.subscriptionLogin }),
  })
  /*
   * WP134：第三种模型来源「用我的 DeepSeek 账号登录」。也是"一台机器一份"（账号在 dsh 本机凭据库里，
   * 不按品牌分）；默认关，选了才挂官方模块。登上 / 登出时每个已装配的品牌都重装一次网关。
   */
  const deepseekDshHome = dshHomeOf(env, dbDir)
  /**
   * WP150：各品牌里**正在用 DeepSeek 账号跑**的运行——开跑时绑的模型来源（`purpose: 'run'` 那一条）
   * 就是账号那一条。只看已经建出来的品牌：没建过的品牌不会有在跑的运行。
   */
  const deepseekAccountRuns = () => {
    const loaded = brands?.loaded() ?? []
    return loaded.flatMap((brand) =>
      (brand.runtime?.activeRuns() ?? [])
        .filter((run) => run.model.provider === DEEPSEEK_ACCOUNT_PROVIDER_ID)
        .map((run) => ({ brand, run, multi: loaded.length > 1 })),
    )
  }
  /** WP150：把各品牌里「用我的 DeepSeek 账号登录」那一条摘掉——手动登出与登录失效**同一条路**。 */
  const dropDeepSeekAccountProviders = async (reason: 'signed_out' | 'expired'): Promise<void> => {
    for (const brand of await brandModules.all()) brand.ownModels.dropAccountProvider(reason)
  }
  const deepseekAccount = createDeepSeekAccount({
    runtimeMode,
    ...(dbDir === undefined ? {} : { dbDir }),
    // 与 WP136 的场景切换同一个 DSH_HOME：凭据库所有 dsh 场景共用一份
    ...(deepseekDshHome === undefined ? {} : { dshHome: deepseekDshHome }),
    callbackOrigin: () => (boundPort === undefined ? undefined : `http://${HOST}:${boundPort}`),
    onChange: () => {
      for (const brand of brands?.loaded() ?? []) brand.ownModels.accountChanged()
    },
    // WP150：登出前确认框里列的、确认后先停掉的那几件事
    tasks: {
      list: () =>
        deepseekAccountRuns().map(({ brand, run, multi }) => ({
          run_id: run.run_id,
          matter_id: run.matter_id,
          title: run.title,
          ...(multi ? { brand: brandNameOfWorkspace(brand.workspace_id) } : {}),
        })),
      stop: async (reason: string) => {
        await Promise.all(
          deepseekAccountRuns().map(({ brand, run }) => brand.runtime?.stopRun(run.run_id, reason)),
        )
      },
    },
    // WP150：登录失效 → 摘掉各品牌里那一条（和手动登出同一条路）
    onExpired: () => dropDeepSeekAccountProviders('expired'),
    now: () => clock.now(),
    ...(options.deepseekAccount?.createHost === undefined
      ? {}
      : { createHost: options.deepseekAccount.createHost }),
    ...(options.deepseekAccount?.signOutGraceMs === undefined
      ? {}
      : { signOutGraceMs: options.deepseekAccount.signOutGraceMs }),
  })
  /** WP92：我们钉的那一版 `bsk`（仓库根的 `browserskill.lock.json`）；发行版里没带就没有。 */
  const lockVersion = (): string | undefined => {
    try {
      return readLock().cli.version
    } catch {
      return undefined
    }
  }

  /**
   * WP66（52 O1）：模型网关**按品牌各一个**（装配在 `assembleBrand` 里）。
   *
   * 网关先按 stub 起来，`createModels` 装好之后立刻 `reconfigure` 成真配置；
   * 之所以不在这里判断有没有 key：**有没有模型这件事由模型面说了算**
   * （加密库里的配置 + 环境变量兜底），不是"看一个环境变量在不在"。
   *
   * 一个品牌一个网关、而不是一个进程一个：`reconfigure` 换的是**整份** provider
   * 清单，两个品牌各填各的 key 就会互相把对方顶掉。账（预算、并发预留、usage）
   * 随网关走，于是 52 O3「每个品牌的积分消耗分开记」也就是自然的。
   */
  const makeGateway = (halt: Halt = kernel.halt): ModelGatewayApi =>
    createModelGateway({
      providers: [stubProvider({ seed: 7 })],
      /*
       * WP76（22 图片槽 / 58 §1）：**只有 demo 才挂 stub 出图**。
       *
       * 生产上不挂是故意的：不挂的时候网关自己兜一条
       * `unavailableImageProvider`，它 `available: false` 并带一句人话
       * （"DeepSeek 不出图，去设置页填一个 OpenAI 兼容口的 key"）——
       * 那正是 58 §1 要的"没有就明说"。挂一个出色块的替身上去，
       * 用户会以为自己有图片模型，然后拿一张纯色块去上架。
       *
       * demo 里反过来：不挂的话"待挑"那一块永远是空的，58 §3 的变体挑选卡
       * 在演示里一次都出不来。
       */
      // WP268：测试 / demo 可以注入一条生图（假云端的 OpenAI 形态口）；生产不传
      ...(options.images?.provider !== undefined
        ? { images: options.images.provider }
        : options.mount === undefined
          ? {}
          : { images: stubImageProvider({ seed: 7 }) }),
      policy: { default: STUB_REF, data_residency: 'cn', prices: priceTable },
      clock,
      env,
      // WP215：品牌那一份急停视图（全局急停 + 这个品牌自己的急停）
      halt,
      trace: kernel.trace,
      eventSink: (e) => {
        appendEvent(e)
      },
    })

  // 14 §7 升级链要问的两件事（范围管理者是谁 / owner 是谁）。取值函数，不是值——
  // 审批总线排在身份之前，owner 与工作区要等下面那一段装完才知道。
  let bootstrapOwner: PersonId | undefined
  let bootstrapWorkspace: WorkspaceId | undefined
  /**
   * WP65（52 O1）：当前这个品牌挂在哪个组织下。
   *
   * 空的那一段时间只有一处——启动时的一次性迁移之前；那会儿公司级三样从档案读，
   * 与这一版上线前一模一样（`createOnboarding` 的 `organization` 钩子就是这么写的）。
   */
  let bootstrapOrg: string | undefined
  /** 兜底的品牌名：身份服务里还查不到那一行时用它（装配途中的一小段）。 */
  let bootstrapWorkspaceName: string | undefined

  /**
   * 52 O1：某个工作区的品牌名（没设过就是工作区名）。
   *
   * 走 `workspacesOf` 是因为本地档只有它是**同步**的——首次设置那一面要在
   * 组装视图的时候就拿到名字，不该为一个名字把整条路由改成异步。
   */
  /** WP224：一页纸那条定时的 id（第一个品牌不带后缀，别的品牌 `__<ws>`，同 `ensureBrandTasks`）。 */
  const weeklyReviewTaskId = (ws: string): string =>
    ws === workspace.id ? 'sched_weekly_review' : `sched_weekly_review__${ws}`
  /** WP224：一页纸那条定时 → 设置里那一行（每周几、几点）。 */
  const weeklyReviewScheduleView = (task: ScheduleTask | undefined) => {
    if (task === undefined)
      return { weekday: 1, time: '08:00', paused: false, missing: true as const }
    const parts = task.trigger.kind === 'cron' ? task.trigger.expr.split(/\s+/) : []
    const pad = (n: string | undefined) => String(Number(n ?? 0)).padStart(2, '0')
    return {
      weekday: Number(parts[4] ?? 1) % 7,
      time: `${pad(parts[1])}:${pad(parts[0])}`,
      paused: task.state === 'paused',
    }
  }
  /** WP224：读写毛利率事实卡用的身份（这条分配自己的授权，05：不做跨分配并集）。 */
  const economicsReader = (actor: {
    workspace_id: string
    person_id: string
    assignment_id: string
    role_id: string
  }) => {
    const config = roles.effectiveConfig(actor.assignment_id as Assignment['id'])
    return {
      person_id: actor.person_id as PersonId,
      workspace_id: actor.workspace_id as WorkspaceId,
      assignment_id: actor.assignment_id,
      role_id: actor.role_id,
      grants: [...config.scopes],
      ranges: [...config.ranges],
    }
  }
  /**
   * 同步取一个品牌工作区（先看启动负责人名下的，再看各公司的品牌一览）。
   * WP240：别人建的品牌（负责人不是启动负责人）以前取不到，名字就退回成了启动品牌的名字。
   */
  const workspaceSync = (id: WorkspaceId) => {
    const owner = bootstrapOwner
    return (
      (owner === undefined ? undefined : identity.workspacesOf(owner).find((w) => w.id === id)) ??
      identity
        .listOrganizations()
        .flatMap((o) => identity.brandsOf(o.id))
        .find((w) => w.id === id)
    )
  }
  const brandNameOfWorkspace = (id: WorkspaceId): string => {
    const found = workspaceSync(id)
    return found === undefined ? (bootstrapWorkspaceName ?? id) : brandNameOf(found)
  }

  /** 组织上的公司级三样（首次设置那一面读它，不直接拿整个 `Organization`）。 */
  const organizationProfileOf = (
    id: string,
  ):
    | { legal_name: string; domain?: string; discoverable: boolean; postal_address?: string }
    | undefined => {
    const org = identity.getOrganization(id)
    if (org === undefined) return undefined
    return {
      legal_name: org.legal_name,
      ...(org.domain === undefined ? {} : { domain: org.domain }),
      discoverable: org.discoverable,
      // WP251：公司实体地址也是公司的
      ...(org.postal_address === undefined ? {} : { postal_address: org.postal_address }),
    }
  }
  const approvalDirectory = createApprovalDirectory({
    roles,
    owner: () => bootstrapOwner,
    workspace_id: () => bootstrapWorkspace,
  })

  /*
   * 渠道与聊天车道排在 txn 之后装（它们要 work / connections / startRun），而执行器的
   * 出站回调现在就要指向它们——所以先留一个空壳引用，品牌容器建好之后再填。
   *
   * WP66（52 O1）：这两样现在**按品牌各一套**，所以回调收的是一个按
   * `item.workspace_id` 取模块的函数，而不是一个装配期就定死的对象。
   */
  let brands: BrandModules | undefined
  /** WP215：调度器比品牌后台晚建，后台状态那一格惰性取它。 */
  let scheduleRef: ScheduleAssembly | undefined

  const backend = new MemoryBackend()
  // WP18：给了数据目录就整套落盘（审批项 / 账本 / 预占 / unknown 与对账游标）
  const idempotencyStore =
    dbDir === undefined
      ? undefined
      : new SqliteIdempotencyStore({ dbPath: join(dbDir, 'idempotency.sqlite'), clock })
  const txnStore =
    dbDir === undefined
      ? undefined
      : new SqliteTxnStore({ dbPath: join(dbDir, 'txn.sqlite'), clock })
  const txn = createTxn({
    clock,
    random,
    directory: approvalDirectory,
    ...(txnStore === undefined ? {} : { store: txnStore }),
    eventSink: (e) => {
      appendEvent(e)
    },
    readRecord: (target) => backend.read(target),
    /*
     * WP154 发布前质检：`publish_post` 要发出去时，按卡片所属品牌的知识库跑一遍
     * （事实对得上、数字有出处、没有违规宣称）；没过就改回草稿、拉回 L1、卡上逐句说明。
     * 别的变更一个字节不动。改写后的入参照常过 guardrail——这一跳只能收紧。
     */
    beforeStage: async (input) => {
      if (input.kind !== 'publish_post') return input
      const brand = await brands?.forWorkspace(input.workspace_id)
      return brand === undefined ? input : brand.seoService.gatePublish(input)
    },
    // 44 G2 前置检查：改价 / 改 Listing 的目标商品必须落在这个岗位的范围里
    targetInRange: ({ assignment_id, target, before }) => {
      const scoped = rangeTargetOfProduct(target, before)
      return scoped === undefined ? undefined : roles.targetInRange(assignment_id, scoped)
    },
    /*
     * WP117b（66 复测 #19）：**开发信批了之后真的要投出去。**
     *
     * 红人的开发信走的是变更账本（`kind: 'kol_outreach'`），批了之后执行器调的
     * 是这一句——而这一句以前只有内存桩：它什么都不做就回 ok。于是演练世界
     * 一封信都没收到（状态带上永远"已发 0"），合成红人当然也不会回信，
     * 「发信 → 回信 → 议价」这条链在界面上一次都没走通过。
     *
     * `kolOutreachApply` 只认两种情况：不是开发信 → `undefined`；
     * 收件人不是演练红人 → `undefined`。两种都掉回原来那条路，一个字节不变。
     */
    backendApply: async (change, opts) => {
      const brand = await brands?.forWorkspace(change.workspace_id)
      const sandboxed = kolOutreachApply(brand, change) ?? kolQuoteApply(brand, change)
      if (sandboxed !== undefined) return sandboxed
      // WP249：自家版版务卡批了 → 经 Reddit 出口（接口优先、官方号浏览器兜底）执行卡上那一个动作
      const ownSubApplied = await brand?.socialService.ownSub?.apply(change)
      if (ownSubApplied !== undefined) return ownSubApplied
      // WP254（决策 117）：别的社群的版务卡批了 → 经这条渠道适配器的 moderate 执行卡上那一个动作
      const moderationApplied = await brand?.socialService.executor.applyModeration(change)
      if (moderationApplied !== undefined) return moderationApplied
      // WP172：B2B 库的卡批了才落库（不是 B2B 库的卡回 undefined，掉回原来那条路）
      const b2bApplied = brand?.b2bService.apply(change)
      if (b2bApplied !== undefined) {
        // WP182：样品标「已寄」生效了 → 寄样通知再出一张卡（出不成不影响这一张已落库）
        if (b2bApplied.status === 'ok')
          await brand?.b2bSales.afterApplied(change).catch(() => undefined)
        return b2bApplied
      }
      // WP182：询盘首回 / 报价单 / 寄样通知批了就发；离职交接批了就改归属
      const salesApplied = await brand?.b2bSales.apply(change)
      if (salesApplied !== undefined) return salesApplied
      // WP173：开发信那一批卡批了才发（不是 b2b_outreach 回 undefined）
      const outreachSent = await brand?.b2bOutbound.apply(change)
      if (outreachSent !== undefined) return outreachSent
      // WP253：换线上主题那张卡批了 → 由服务端跑 `theme publish`（这是整条路上唯一换线上主题的地方）
      if (change.kind === 'publish_theme') {
        const themed = await (await siteThemeOf(change.workspace_id))?.apply(change)
        if (themed !== undefined) return themed
      }
      // WP261：独立站运营的卡批了 → 由服务端带 `--allow-mutations` 去改、读回确认（整条路上唯一改店铺数据的地方）
      const shopped = await (await shopOf(change.workspace_id))?.ops.apply(change)
      if (shopped !== undefined) return shopped
      return backend.apply(change, opts)
    },
    // 18 §3：批准了的对外草稿真发出去。渠道接不住的（不是邮件 / 没装邮箱）
    // 才回落到内存桩——demo 与没连邮箱的机器照样跑得完整条链路。
    deliverOutbound: async (item, opts) => {
      // WP66：卡片自己写着属于哪个品牌，就从那个品牌的渠道发——**不是**进程装配的那一套
      const brand = await brands?.forWorkspace(item.workspace_id)
      /*
       * WP117 交付 4：**演练的硬闸**。
       *
       * 这是服务进程里唯一一条"真把东西发出去"的路，所以闸就设在这里——
       * 在问聊天车道与邮件渠道**之前**。界面上的开关、接口上的参数、
       * 卡片上的标记都可以被绕过；这一句绕不过去：收件人属于演练红人，
       * 这封信就投进内存邮箱，下面三行一行都不执行。
       */
      const sandboxed = kolSandboxIntercept(brand, item)
      if (sandboxed !== undefined) return sandboxed
      // WP254（决策 117）：社媒回帖卡批了就发——经这条渠道的出口（Reddit：接口优先、官方号浏览器兜底）
      const socialReply = await brand?.socialService.executor.deliverReply(item)
      if (socialReply !== undefined) return socialReply
      // WP57：聊天草稿（`payload.channel === 'chat'`）先问聊天车道，它接不住才轮到邮件
      return (
        (await brand?.chat.deliver(item, opts)) ??
        (await brand?.channels.deliver(item, opts)) ??
        backend.deliver(item, opts)
      )
    },
  })

  const identity: LocalIdentityService =
    dbDir === undefined
      ? createMemoryIdentity({ clock, random })
      : createSqliteIdentity({ dbPath: join(dbDir, 'identity.sqlite'), clock, random })

  /*
   * WP174（docs/84 §11.1 第 3 条）：`scope_manager` 的审批落到谁——岗位上级 → 老板。
   * 各品牌的服务（公关、建站、社媒、SEO、投放、B2B）装得比公司页早，所以岗位表是
   * 晚绑定的：公司页装好之后填 `supervisorPositions`，之前（还没有任何卡）当没有岗位。
   */
  let supervisorPositions: (() => readonly SupervisedPosition[]) | undefined
  const routeScopeManager = createScopeManagerRouter({
    positions: () => supervisorPositions?.() ?? [],
    assignments: (person_id, ws) =>
      roles.assignments
        .listByPerson(person_id, {})
        .filter((a) => a.workspace_id === ws && a.revoked_at === undefined),
    activeMembers: async (ws) =>
      (await identity.members(ws)).filter((m) => m.left_at === undefined).map((m) => m.person_id),
    owner: async (ws) => (await identity.getWorkspace(ws))?.owner_id,
    personName: async (id) => (await identity.getPerson(id))?.name,
  })

  // 37 工作模型：给了数据目录就落盘（事项 / 时间线 / 目标 / 待办 / 计划 / 复盘）
  const workStore =
    dbDir === undefined
      ? undefined
      : new SqliteWorkStore({ dbPath: join(dbDir, 'work.sqlite'), clock })

  // ── 首次启动：owner + 默认工作区 + 内部凭据（28 §3「内部服务凭据」）
  const mount = options.mount
  const ownerEmail =
    mount?.owner.email ?? (env.AGENTSWS_OWNER_EMAIL?.trim() || PLACEHOLDER_OWNER_EMAIL)
  const person = await identity.createPerson({
    email: ownerEmail,
    name: mount?.owner.name ?? ownerEmail.split('@')[0] ?? 'owner',
    ...(mount === undefined ? {} : { id: mount.owner.id }),
  })
  // 落盘档会重启：owner 的工作区与 Assignment 只在第一次建，之后接着用同一份；
  // 接进来的世界（mount）用它给的 id，且它已有自己的策略层与分配，不覆盖
  const workspace =
    (await identity.workspacesOf(person.id))[0] ??
    (await identity.createWorkspace({
      name: mount?.workspace_name ?? (env.AGENTSWS_WORKSPACE_NAME?.trim() || 'default'),
      owner_id: person.id,
      kind: 'personal',
      ...(mount === undefined ? {} : { id: mount.workspace_id }),
    }))
  if (mount === undefined) roles.policies.set(workspace.policy)
  const ownerAssignment =
    roles.assignments
      .listByPerson(person.id, { workspace_id: workspace.id, role_id: 'common.owner' })
      .find((a) => a.revoked_at === undefined) ??
    roles.assignments.create({
      person_id: person.id,
      workspace_id: workspace.id,
      role_id: 'common.owner',
      granted_by: person.id,
      ranges: [],
    })
  const internalToken = identity.issue('internal', person.id, workspace.id).token
  // 空壳填上：从这一刻起升级链知道该找谁（39 待办 A）
  bootstrapOwner = person.id
  bootstrapWorkspace = workspace.id
  bootstrapWorkspaceName = workspace.name

  // WP117b（66 复测 #19）：挂了模拟世界（demo）时有两本审批账——世界的演示卡
  // 与服务进程 stage 的卡（红人开发信 / 议价）。读合成一本、决定各回各家；
  // 生产没挂世界，服务进程那一本就是唯一的一本。见 `approvals-composite.ts`。
  const rawApprovals =
    mount === undefined ? txn.approvals : compositeApprovals(mount.approvals, txn.approvals)
  // WP29 学习回路：技能库空着的话先铺一份自带技能（学到的东西得有段落可落），
  // 再把审批总线包一层——每张卡被决定之后抽 lesson，技能 / 知识类卡批了就施行。
  await seedDefaultSkill(skills, workspace.id)
  /**
   * WP215：一个品牌里替它收卡、挂系统任务的那个人与那条分配。
   *
   * 第一个品牌就是装配时的那一对（与之前逐字相同）；别的品牌依次找：本机这个人在那里的
   * owner 分配 → 那个品牌任意一位 owner → 本机这个人在那里的任意一条分配。都没有就是
   * `undefined`——那个品牌的学习卡、系统任务先不出，**绝不挂到别的品牌的人头上**。
   * 用函数声明（会提升）：学习回路比这里早建，回调里要用它。
   */
  function brandAnchor(ws: WorkspaceId): { owner: PersonId; assignment: Assignment } | undefined {
    if (ws === workspace.id) return { owner: person.id, assignment: ownerAssignment }
    const live = (a: Assignment): boolean => a.revoked_at === undefined
    const mine = roles.assignments
      .listByPerson(person.id, { workspace_id: ws, role_id: 'common.owner' })
      .find(live)
    if (mine !== undefined) return { owner: person.id, assignment: mine }
    const anyOwner = roles.assignments.listByRole('common.owner', { workspace_id: ws }).find(live)
    if (anyOwner !== undefined) return { owner: anyOwner.person_id, assignment: anyOwner }
    const first = roles.assignments.listByPerson(person.id, { workspace_id: ws }).find(live)
    return first === undefined ? undefined : { owner: person.id, assignment: first }
  }
  const learning = createLearningAssembly({
    workspace_id: workspace.id,
    clock,
    random,
    skills,
    knowledge,
    roles,
    approvals: rawApprovals,
    owner: person.id,
    ownerAssignment,
    // WP215：别的品牌的学习卡发给那个品牌的负责人、挂在他那条分配上
    ownerOf: (ws) => {
      const anchor = brandAnchor(ws)
      return anchor === undefined
        ? undefined
        : { owner: anchor.owner, ownerAssignment: anchor.assignment }
    },
    appendEvent,
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  /**
   * 40 §2 工具箱：把定时任务、流程、技能投影成同一张卡片，供"建之前先查"与工具箱页用。
   *
   * 装在审批总线**之前**——它要包一层总线（晋升卡批准了才真的升层）。调度器与流程引擎
   * 要到后面才起来，所以那两个来源是惰性的：真正取值发生在请求到来时。
   */
  const catalog = createCatalogIndex({
    workspace_id: workspace.id,
    clock,
    ...(dbDir === undefined ? {} : { dbDir }),
    scheduler: () => schedule.scheduler,
    workflows: () => schedule.workflows,
    // 整个工作区的岗位（不是本人那几个）：算"哪些岗位在用"要全的。WP215：问哪个品牌就数哪个品牌的
    positions: (ws) =>
      roles.roles
        .list()
        .flatMap((r) => roles.assignments.listByRole(r.id, { workspace_id: ws }))
        .filter((a) => a.revoked_at === undefined)
        .map((a) => ({
          id: a.id,
          person_id: a.person_id,
          role_id: a.role_id,
          skills: (roles.roles.get(a.role_id)?.skills ?? []).map((sk) => sk.name),
        })),
    skillNames: () => skills.registry.listSkillNames(),
    // 有人写过个人层 overlay 的技能算"个人副本"，其余算公司在用的
    skillOwner: (name) => {
      const personal = skills.registry
        .listOverlays(name)
        .find((o) => o.tier === 'personal' && o.ops.length > 0)
      return personal === undefined
        ? { owner: 'package' as PersonId, layer: 'company' as const }
        : { owner: String(personal.owner) as PersonId, layer: 'personal' as const }
    },
  })

  // 两层包装：学习回路先落 overlay / 知识卡，目录再看是不是一张晋升卡
  // WP144：最外一层——`computer_use` 授权卡批了就记一次授权、带着它重跑这件事
  // WP154：选题卡批了 → 按卡片所属品牌开事项（钩子在品牌模块建好之后才挂上）
  const seoDecidedHook: SeoDecidedHook = {}

  /*
   * WP219（docs/90 §6）：已审的第三方内容更新。只在**开着**（桌面安装包给 `AGENTSWS_CONTENT_UPDATES=on`，
   * 或测试 / demo 注入）且**有存放处**时装配；内置公钥是空的就照样装配、但通道关着（设置里照实说）。
   * 出卡走同一条审批总线：内容更新卡批了 / 冲突卡选了，在 `contentUpdates.wrap` 里接住。
   */
  const contentOpts = options.contentUpdates
  const contentRoot =
    contentOpts?.root ?? (dbDir === undefined ? undefined : join(dbDir, 'content-updates'))
  const contentEnabled = contentOpts?.enabled ?? env[CONTENT_UPDATES_ENV] === 'on'
  const contentKeys = contentOpts?.keys ?? CONTENT_SIGNING_PUBLIC_KEYS
  const contentAppVersion = contentOpts?.appVersion ?? env.AGENTSWS_VERSION ?? '0.0.0-dev'
  const contentChannel = contentChannelOf(contentAppVersion)
  const contentOff = !contentEnabled
    ? '这台没开内容更新（装好的桌面版才开）。'
    : contentKeys.length === 0
      ? CONTENT_REJECT_TEXT.no_keys
      : undefined
  const contentBrands = async (): Promise<{ id: WorkspaceId; owner_id?: PersonId }[]> => {
    const ids = new Set<WorkspaceId>([workspace.id])
    for (const org of identity.listOrganizations())
      for (const w of identity.brandsOf(org.id)) ids.add(w.id)
    const out: { id: WorkspaceId; owner_id?: PersonId }[] = []
    for (const id of ids) {
      const owner = (await identity.getWorkspace(id))?.owner_id
      out.push(owner === undefined ? { id } : { id, owner_id: owner })
    }
    return out
  }
  let approvalsForContent: ApprovalBus | undefined
  const contentUpdates: ContentUpdates | undefined =
    contentRoot === undefined
      ? undefined
      : createContentUpdates({
          root: contentRoot,
          appVersion: contentAppVersion,
          channel: contentChannel,
          keys: contentKeys,
          sources: contentOpts?.sources ?? contentFeedSources(contentChannel),
          fetch: contentOpts?.fetch ?? ((url, init) => fetch(url, init)),
          clock,
          registry: skills.registry,
          brands: contentBrands,
          platformOf: (ws) => brandProfileOf(ws).storefront_platform,
          approvals: () => approvalsForContent,
          appendEvent,
          ...(contentOff === undefined ? {} : { off: contentOff }),
        })
  // 启动：各品牌更新过的基础层装回技能库（软件自带版追上了就丢掉覆盖）
  await contentUpdates?.restore()
  const contentWrap = <B extends ApprovalBus>(bus: B): B =>
    contentUpdates === undefined ? bus : contentUpdates.wrap(bus)

  const approvals = seoDecided(
    // WP181：最外一层——`scheduled_task` 卡批了就让那条自动化任务开始、拒了就取消
    automation.wrap(
      officialPlugins.wrap(
        contentWrap(computerUse.wrap(catalog.wrap(learning.wrap(rawApprovals)))),
      ),
    ),
    seoDecidedHook,
  )
  approvalsForContent = approvals
  // 每 6 小时查一次（起来 30 秒后先查一次，不拖慢启动）；关着就不起定时器
  const contentTimers: ReturnType<typeof setTimeout>[] = []
  if (contentUpdates !== undefined && contentOff === undefined && contentOpts?.schedule !== false) {
    const run = (): void => {
      void contentUpdates.check().catch(() => undefined)
    }
    const first = setTimeout(run, 30_000)
    const every = setInterval(run, CONTENT_CHECK_INTERVAL_MS)
    first.unref?.()
    every.unref?.()
    contentTimers.push(first, every)
  }
  // ── WP66（52 O1「每个品牌的所有东西都单独设置」）：一个进程装多套品牌模块 ──
  //
  // 从这里开始，连接、活数据源、记录源、工作模型、运行时、渠道、聊天车道与聊天窗、
  // 模型面、能力开关**一律按品牌各一套**，由 `brand-modules.ts` 的容器按
  // `workspace_id` 懒建并缓存。装配期闭包里只剩真正全进程共享的东西
  // （内核与事件日志、身份与组织、加密库主密钥、职责库、审批总线、调度器本体）。
  //
  // 落盘与凭据怎么分见 `brand-modules.ts` 的头注释：**bootstrap 品牌的目录与 key 名
  // 一个字节不变**，所以存量单品牌用户零感知，一次文件搬家都不用做。

  /** 首次设置那一面（品牌级档案）比这里晚装配，所以档案是**被读的**（WP62 / WP65）。 */
  let onboardingRef: OnboardingAssembly | undefined
  /**
   * 那份 `DESIGN.md`（WP122，71 §5）同样比品牌模块晚装配：它要读 `brandIntake`
   * 手上抓回来的页面，而 `brandIntake` 又要读首次设置那一面。四个岗位出活时经
   * 这个变量取；取不到就是"这个品牌还没有规范"，出活照常（只是不注入令牌）。
   */
  let brandDesignRef: BrandDesignAssembly | undefined

  /**
   * WP122b：一次运行的品牌规范注入段（71 §9 第 7 条）。
   *
   * 建站族额外附上 `themeDesignVariables()` 那张表——WP89 主题沙箱里的职责
   * 副本在沙箱根目录干活，它写 `--color-*` / `--radius-*` 时该用的名字与值
   * 就在这一段里；设计族不注（出图那一路在 `design.ts` 已逐图注入，再注
   * 一遍是双份烧钱）；其它族回 `undefined`（整段不出，不注空节）。
   */
  const brandDesignSectionOf = (ws: WorkspaceId, role_id: string): PromptSection | undefined => {
    const family = designRoleFamily(role_id)
    if (family === undefined || family === 'design') return undefined
    const design = brandDesignRef?.context(ws, family)
    if (design === undefined || design.present !== true) return undefined
    const text =
      family === 'site'
        ? [
            siteDesignPrompt(design),
            '主题里写颜色 / 字体 / 圆角 / 间距时，用这些变量名与值：',
            ...Object.entries(themeDesignVariables(design.tokens)).map(
              ([name, value]) => `${name}: ${value}`,
            ),
          ].join('\n')
        : family === 'ads'
          ? adDesignPrompt(design)
          : design.prompt
    return { id: 'brand-design', name: '品牌设计规范', order: 25, text }
  }

  const brandProfileOf = (
    ws: WorkspaceId,
  ): { vertical?: WorkspaceVertical; storefront_platform?: StorefrontPlatform } =>
    onboardingRef?.brandProfile(ws) ?? {}

  /**
   * WP216（Fable 10-05）：这个品牌的建站平台，**给平台专属那一套用**（官方技能 / Dev MCP / CLI 卡）。
   * 档案有就用档案；没设而连了某个平台的店铺就按它推断并写回档案；都没有 = undefined（一样都不启用）。
   * 店铺连接那张表（缺省按 Shopify）不走这里。
   */
  const brandPlatformOf = (ws: WorkspaceId): StorefrontPlatform | undefined =>
    resolveBrandPlatform(
      {
        profile: (w) => brandProfileOf(w).storefront_platform,
        connectedServices: (w) => brands?.peek(w)?.connections.connectedServices() ?? [],
        writeBack: (w, p) =>
          onboardingRef?.setStorefrontPlatform(w, p, 'inferred_from_connection') ?? false,
      },
      ws,
    )

  /**
   * 52 O3「跟随公司默认」读的是哪个品牌那一份。
   *
   * 这个进程 bootstrap 出来的品牌只要还在这家公司里，它就是公司默认——存量机器上
   * "公司默认"必须还是原来那一份，否则老用户的模型设置会凭空换成另一个品牌的。
   */
  const orgDefaultBrandOf = (ws: WorkspaceId): WorkspaceId => {
    const org = identity
      .listOrganizations()
      .find((o) => identity.brandsOf(o.id).some((w) => w.id === ws))
    if (org === undefined) return workspace.id
    // `brandsOf` 按建的先后回（身份层的插入序）：第一条就是这家公司的第一个品牌
    const siblings = identity.brandsOf(org.id)
    if (siblings.some((w) => w.id === workspace.id)) return workspace.id
    return siblings[0]?.id ?? ws
  }

  /** 这个人在这个品牌里的第一条岗位（入站事项挂谁名下、知识检索用谁的授权）。 */
  const firstPositionOf = (
    ws: WorkspaceId,
  ): { person_id: PersonId; assignment_id: string; role_id: string } | undefined => {
    const first = roles.assignments
      .listByPerson(person.id, { workspace_id: ws })
      .find((a) => a.revoked_at === undefined)
    return first === undefined
      ? undefined
      : { person_id: first.person_id, assignment_id: first.id, role_id: first.role_id }
  }

  // WP44：Shopify 官方 Dev MCP 作为**只读**工具源（查文档 / 看 schema / 校验 GraphQL）。
  //
  // WP216（Fable 10-05「官方功能优先」）：**默认开**，`AGENTSWS_SHOPIFY_DEVMCP=0` 关。
  // 但**首次使用才下载**：启动时不起它；平台是 Shopify 的品牌第一次跑一条职责（运行时来问
  // `toolNames()`）时才在后台 `npx` 拉官方包——非 Shopify 的品牌永远不触发（运行时那道平台闸先挡）。
  // 下载完成之前工具面是空的（模型不该看见调不动的工具），下一次运行就有了。
  // 测试进程里（vitest）缺省不开，要开显式写 `=1`——单测不该去网上拉包。
  //
  // 它是**全进程一个**：一个只读的文档 / schema 工具源，与是哪个品牌无关。
  const devMcpSwitch = env.AGENTSWS_SHOPIFY_DEVMCP
  const devMcpOn =
    devMcpSwitch === '0' ? false : devMcpSwitch === '1' || process.env.VITEST === undefined
  const devMcp = devMcpOn
    ? createShopifyDevMcp({
        env,
        appendEvent: (type, payload) => {
          appendEvent({
            schema_version: 1,
            workspace_id: workspace.id,
            type,
            actor: { kind: 'system', id: 'shopify.devmcp' },
            correlation: { trace_id: `trc_devmcp_${Date.parse(clock.now()).toString(36)}` },
            payload,
          })
        },
      })
    : undefined
  /** 运行时问「现在能调哪几个」：没起过就借这一问在后台起（首次使用才下载），这一次先回空。 */
  const devMcpToolNames = (): string[] => {
    if (devMcp === undefined) return []
    const st = devMcp.status()
    if (!st.available) void devMcp.start()
    return Object.keys(st.mapped)
  }

  /**
   * 装一个品牌的那一套。**这个函数里没有一个 `workspace.id`**——全部走参数 `ws`；
   * 有一个漏掉的就是一条串味的路（品牌 A 的数据出现在 B 的界面上）。
   */
  /**
   * WP69（54）岗位面：一个品牌一份。声明提到这里是为了**晚绑定**——
   * 运行时（`createRuntime`）比它先建起来，而岗位层技能与岗位层上下文要问它；
   * 下面 `runtime.bindPositions` 递进去的两个函数每次调用时才查这张表
   * （与 `runtime.bind(work)` 打断 `Work ↔ startRun` 那个环是同一个套路）。
   */
  const positionAssemblies = new Map<WorkspaceId, PositionsAssembly>()
  /**
   * WP194：一条分配（或一条职责）归哪个岗位——打云时带 `X-Agentsws-Position`。
   * 岗位面按品牌晚装，所以每次现查；查不到就不带（只受个人上限与公司余额限制）。
   */
  const cloudPositionOf = (
    workspace_id: WorkspaceId,
    role_id: string,
    assignment_id?: string,
  ): string | undefined =>
    positionAssemblies.get(workspace_id)?.positionOf(role_id, assignment_id).position_id
  /** WP194：一次调用算在谁头上（本机公司成员 + 岗位）。 */
  const cloudAttributionOf = (assignment_id: string, fallback_role?: string) => {
    const a = roles.assignments.get(assignment_id)
    if (a === undefined) return {}
    const position = cloudPositionOf(a.workspace_id, a.role_id ?? fallback_role, a.id)
    return { member_id: a.person_id, ...(position === undefined ? {} : { position_id: position }) }
  }
  /**
   * WP194：这个人能不能管公司的积分，是什么身份——
   * owner：本工作区所有者职责的持有人、工作区成员表里的 owner、公司成员表里的 owner；
   * admin：工作区成员表里的 manager、公司成员表里的 admin（离开了的都不算）。
   * admin 只开公司页的「积分」那一页（Fable 09-29 定），公司页其它 tab 照旧只给所有者。
   */
  const creditsRoleOf = async (
    person_id: string,
    workspace_id: string,
  ): Promise<'owner' | 'admin' | undefined> => {
    const holdsOwner = roles.assignments
      .listByPerson(person_id, { workspace_id, role_id: 'common.owner' })
      .some((a) => a.revoked_at === undefined)
    if (holdsOwner) return 'owner'
    let admin = false
    try {
      const m = (await identity.members(workspace_id)).find(
        (x) => x.person_id === person_id && x.left_at === undefined,
      )
      if (m?.role === 'owner') return 'owner'
      if (m?.role === 'manager') admin = true
      for (const o of await identity.organizationsOf(person_id)) {
        const om = o.members.find((x) => x.person_id === person_id && x.left_at === undefined)
        if (om?.role === 'owner') return 'owner'
        if (om?.role === 'admin') admin = true
      }
    } catch {
      // 查不到当没有：最保守
    }
    return admin ? 'admin' : undefined
  }
  /** WP194：岗位 id → 名字（公司页装好之后才有；之前是空表）。 */
  let creditsPositionNames: () => Record<string, string> = () => ({})
  /**
   * WP194：本机公司的名册——成员与岗位的名字（「积分」页与 100% 提醒信用），
   * 与提醒信发给谁（公司的 owner / admin 的邮箱）。
   */
  const creditsDirectory = async (workspace_id: string) => {
    const members: Record<string, string> = {}
    const notify = new Set<string>()
    for (const m of await identity.members(workspace_id)) {
      const person = await identity.getPerson(m.person_id)
      if (person === undefined) continue
      members[person.id] = person.name
      if (m.left_at !== undefined) continue
      if (
        (await creditsRoleOf(person.id, workspace_id)) !== undefined &&
        person.email.includes('@')
      )
        notify.add(person.email.trim().toLowerCase())
    }
    return { members, positions: creditsPositionNames(), notify_emails: [...notify] }
  }

  /**
   * WP206：这个品牌的名册（推上云给网页「成员额度」页列人）：成员 `person_id` + 名字 + 他持有的岗位、
   * 岗位 id + 名字。**只有名字，不带业务内容。** 岗位 id 与打云时 `X-Agentsws-Position` 带的是同一套
   * （`cloudPositionOf`）。公司页与岗位面没装好之前抛错（这一轮不推）——半份名册推上去，
   * 云上会把没列进来的岗位当成删了、自动收回。
   */
  const cloudRoster = async (workspace_id: WorkspaceId) => {
    if (!rosterReady || !positionAssemblies.has(workspace_id)) throw new Error('名册还没装好')
    const names = creditsPositionNames()
    const members: { id: string; name: string; positions: string[] }[] = []
    for (const m of await identity.members(workspace_id)) {
      if (m.left_at !== undefined) continue
      const person = await identity.getPerson(m.person_id)
      if (person === undefined) continue
      const held = new Set<string>()
      for (const a of roles.assignments.listByPerson(person.id, { workspace_id }))
        if (a.revoked_at === undefined) {
          const position = cloudPositionOf(workspace_id, a.role_id, a.id)
          if (position !== undefined) held.add(position)
        }
      members.push({ id: person.id, name: person.name, positions: [...held].sort() })
    }
    return {
      members,
      positions: Object.entries(names).map(([id, name]) => ({ id, name })),
    }
  }

  /*
   * ── WP120（69）：**角色定位** ───────────────────────────────────────────
   *
   * **一份，不按品牌分**。69 §4 定的是「公司层覆盖」——persona 是公司对外的口径，
   * 而岗位模板与职责定义本来就是制度层的东西（跨品牌共用一份，同 `org.positions`）。
   * 按品牌各存一份的后果是同一条职责在两个品牌里说两套话，而没有人记得去同步第二份。
   *
   * 声明提到这里是为了晚绑定：`org` 与 `onboarding` 都比它晚建，所以 `positions`
   * 与 `brand` 都写成现查的闭包（与上面 `positionAssemblies` 同一个套路）。
   */
  /**
   * WP248（决策 83）：品牌档案里给 AI 当上下文的三格（一句话介绍、客服邮箱、币种）。
   * 写过才带——币种没写过不替人补 USD（69 §5「别编」：默认值是界面上的缺省，不是这个品牌说过的话）。
   */
  const brandFactsContextOf = (
    ws: WorkspaceId,
  ): { one_liner?: string; support_email?: string; currency?: string } => {
    const p = onboardingRef?.brandProfile(ws)
    return {
      ...(p?.one_liner === undefined ? {} : { one_liner: p.one_liner }),
      ...(p?.support_email === undefined ? {} : { support_email: p.support_email }),
      ...(p?.currency === undefined ? {} : { currency: p.currency }),
    }
  }

  const personas = createPersonas({
    workspace_id: workspace.id,
    clock,
    roles,
    positions: () => org.positions(),
    ...(dbDir === undefined ? {} : { backend: createFilePersonaBackend(personaFileIn(dbDir)) }),
    isOwner: (person_id) =>
      roles.assignments
        .listByPerson(person_id, { workspace_id: workspace.id, role_id: 'common.owner' })
        .some((a) => a.revoked_at === undefined),
    /*
     * WP121（70 §3）：品牌上下文的四个槽位。**取不到就不写那一句**——
     * 品牌名从工作区档案里来（那是确认品牌分析之后写下的那一份）。
     * 市场、口吻样例这里还不取，于是 persona 里就没有那几行——这正是 69 §5 要的行为：**别编**。
     * WP122 的「视觉气质」走同一个槽位（`visual_tone`），填上就多一行。
     * WP248（决策 83）：一句话定位、客服邮箱、币种进了品牌档案，按这次运行所在的品牌带上（写过才有）。
     */
    /*
     * WP251（决策 119）：「品牌：」按**这次运行所在的品牌**取品牌名（品牌档案里的品牌名 = 工作区的
     * `brand.name`），公司全称另起一行「公司：」（这个品牌挂的那家公司）。以前这一行一直是公司全称、
     * 每个品牌都一样——Rollout 跑 AI 看到的是「品牌：INMO 的公司全称」。
     */
    brand: (ws) => {
      const target = (ws ?? workspace.id) as WorkspaceId
      const name = brandNameOfWorkspace(target).trim()
      const company = onboardingRef?.companyProfile(target)?.legal_name?.trim()
      const facts = brandFactsContextOf(target)
      const ctx = {
        ...(name === '' ? {} : { brand_name: name }),
        ...(company === undefined || company === '' ? {} : { company_name: company }),
        ...facts,
      }
      return Object.keys(ctx).length === 0 ? undefined : ctx
    },
    appendEvent,
  })

  /**
   * WP247：本机连接器（按需下载、桌面壳起停）——**整台机器一份**，各品牌共用。只有桌面壳说了「我来起它」
   * （`AGENTSWS_CONNECT_LOCAL_RUNTIME=1`，同时一定给了 `AGENTSWS_CONNECT_URL`）且有数据目录时才有；
   * 指外部 runtime / Docker 档 / 替身档都没有它（runtime 地址仍然只认那两种来源）。
   */
  /**
   * WP254（决策 100 / 123）：下载源（官方源 / 国内源）——**每台机一份**，记在 `<data>/tools/npm-registry.json`。
   * 一键安装平台 CLI 与下载连接器每次开始时问它这一次用哪个源。
   */
  const npmRegistry = createNpmRegistryPreference({
    toolsDir: dbDir === undefined ? undefined : join(dbDir, 'tools'),
    now: () => clock.now(),
    env,
  })
  const localConnector =
    dbDir !== undefined &&
    env[LOCAL_RUNTIME_ENV] === '1' &&
    (env.AGENTSWS_CONNECT_URL ?? '').trim() !== ''
      ? createOpenConnectorInstaller({
          dataDir: dbDir,
          now: () => clock.now(),
          env,
          registry: () => npmRegistry.choose(),
          ...options.localConnector,
        })
      : undefined
  // WP247：工作台升级带来了新钉的连接器版本 → 后台下好（桌面壳看到就切过去，旧版留一份可回退）。
  //     上游的安全修复只发在最新版（08 §5），所以默认跟；`AGENTSWS_CONNECT_AUTO_UPDATE=0` 关掉。
  if (localConnector !== undefined && env.AGENTSWS_CONNECT_AUTO_UPDATE !== '0')
    localConnector.autoUpdate()

  /*
   * WP253：建站岗位的主题工坊——**一个品牌一份**（懒建）。CLI 的检测 / 起法 / 登录那一笔
   * 在后面（平台工具包那一段）才建出来，这里经 `siteThemeCli` 晚绑定；没绑上之前当没装。
   */
  const siteThemes = new Map<WorkspaceId, SiteThemeAssembly>()
  const siteThemeCli: {
    probe?: (spec: PlatformCliSpec, fresh: boolean) => Promise<PlatformCliProbe>
    invocation?: (spec: PlatformCliSpec) => { command: string; prefix: readonly string[] }
    loggedIn?: (ws: WorkspaceId, cli_id: string) => boolean
    sessionEnv?: (ws: WorkspaceId, cli_id: string) => Record<string, string> | undefined
  } = {}
  let themeScratchDir: string | undefined
  const siteThemeOf = async (ws: WorkspaceId): Promise<SiteThemeAssembly | undefined> => {
    const cached = siteThemes.get(ws)
    if (cached !== undefined) return cached
    const brand = await brands?.forWorkspace(ws)
    if (brand === undefined) return undefined
    // 内存档没有数据目录：主题工作副本放进一个临时目录（只在真用到时建一次）
    themeScratchDir ??=
      dbDir === undefined ? mkdtempSync(join(tmpdir(), 'agentsws-themes-')) : undefined
    const dataDir = dbDir ?? (themeScratchDir as string)
    const assembly = createSiteTheme({
      workspace_id: ws,
      clock,
      dataDir,
      ...(brand.dir === undefined ? {} : { settingsFile: join(brand.dir, 'site-theme.json') }),
      cliSpec: () => platformKitOf(brandPlatformOf(ws))?.cli,
      probe: (spec, fresh) =>
        siteThemeCli.probe === undefined
          ? Promise.resolve({
              installed: false,
              node_ok: false,
              min_node_major: spec.min_node_major,
              checked_at: clock.now(),
            })
          : siteThemeCli.probe(spec, fresh === true),
      loggedIn: (cli_id) => siteThemeCli.loggedIn?.(ws, cli_id) ?? false,
      sessionEnv: (cli_id) => siteThemeCli.sessionEnv?.(ws, cli_id),
      invocation: (spec) => siteThemeCli.invocation?.(spec) ?? { command: spec.bin, prefix: [] },
      connectedShops: () =>
        brand.connections.shopify
          .list()
          .map((r) => r.shop)
          .sort(),
      // WP258：品牌分析时从官网读到的 `xxx.myshopify.com`（找到好几家店时拿它对一下）
      siteStore: () => onboardingRef?.shopifyDomainOf(ws),
      env,
      ...(options.siteTheme?.run === undefined ? {} : { run: options.siteTheme.run }),
      ...(options.siteTheme?.fetch === undefined ? {} : { fetch: options.siteTheme.fetch }),
      ...(options.siteTheme?.base === undefined ? {} : { base: options.siteTheme.base }),
      // Luoye 决定 140：随安装包带的那份起底包（GitHub 下不动时的兜底；打包那一半见 WP253 报告）
      ...(env.AGENTSWS_THEME_BASE_DIR === undefined || env.AGENTSWS_THEME_BASE_DIR === ''
        ? {}
        : { localBaseDir: env.AGENTSWS_THEME_BASE_DIR }),
      ledger: txn.ledger,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      notePreview: (matter_id, input) => {
        try {
          brand.work.appendEvent(matter_id as never, {
            kind: 'status',
            text: input.text,
            actor: { kind: 'agent', id: 'site.shopify-theme' },
            preview: {
              url: input.url,
              label: input.label,
              ...(input.theme_id === undefined ? {} : { theme_id: input.theme_id }),
              ...(input.changed_files === undefined ? {} : { changed_files: input.changed_files }),
              ...(input.check === undefined ? {} : { check: input.check }),
            },
          })
        } catch {
          // 事项已经没了（被删 / 换了品牌）：预览照样在工具结果里，时间线少一条而已
        }
      },
      appendEvent: (type, payload) =>
        appendEvent({
          schema_version: 1,
          workspace_id: ws,
          type,
          actor: { kind: 'system', id: 'site.theme' },
          correlation: { trace_id: `trc_theme_${Date.parse(clock.now()).toString(36)}` },
          payload,
        }),
    })
    siteThemes.set(ws, assembly)
    return assembly
  }
  /*
   * WP261（决策 175 第 1 步）：店铺授权 + 独立站运营——**一个品牌一份**（懒建）。CLI 的检测 / 起法 / 一键安装
   * 在后面（平台工具包那一段）才建出来，经 `shopCli` 晚绑定；授权的回调端口整机一个，所以授权跑法是进程级的一份。
   */
  const shopCli: {
    probe?: (spec: PlatformCliSpec, fresh: boolean) => Promise<PlatformCliProbe>
    invocation?: (spec: PlatformCliSpec) => { command: string; prefix: readonly string[] }
    install?: (spec: PlatformCliSpec) => void
    installJob?: (spec: PlatformCliSpec) => CliJobView | undefined
  } = {}
  const storeAuthRunner = createStoreAuthRunner({
    now: () => clock.now(),
    ...(options.shopAdmin?.spawn === undefined ? {} : { spawn: options.shopAdmin.spawn }),
  })
  const shops = new Map<WorkspaceId, { auth: ShopAdminAssembly; ops: ShopOps }>()
  /** WP268：每个品牌一份素材库与生图服务（装品牌时登记；决定钩子与 `/v1/brand-assets` 按品牌取）。 */
  const brandAssetsByWs = new Map<WorkspaceId, BrandAssets>()
  const imageServices = new Map<WorkspaceId, ImageService>()
  const brandAssetsOf = async (ws: WorkspaceId): Promise<BrandAssets> => {
    await brands?.forWorkspace(ws)
    const lib = brandAssetsByWs.get(ws)
    if (lib === undefined) throw new ApiError('not_implemented', '这个品牌没有素材库')
    return lib
  }
  const shopOf = async (
    ws: WorkspaceId,
  ): Promise<{ auth: ShopAdminAssembly; ops: ShopOps } | undefined> => {
    const cached = shops.get(ws)
    if (cached !== undefined) return cached
    const brand = await brands?.forWorkspace(ws)
    if (brand === undefined) return undefined
    // 与 WP245 的私有安装同一个工具目录（不等晚绑定：早一步建也不会落到整台电脑那一份会话上）
    const toolsDir =
      options.platformCliRunner !== undefined && 'toolsDir' in options.platformCliRunner
        ? options.platformCliRunner.toolsDir
        : dbDir === undefined
          ? undefined
          : join(dbDir, 'tools')
    const cliSpec = (): PlatformCliSpec | undefined => platformKitOf(brandPlatformOf(ws))?.cli
    const cliAuth = createShopAdmin({
      workspace_id: ws,
      clock,
      ...(brand.dir === undefined ? {} : { settingsFile: join(brand.dir, 'shop-admin.json') }),
      cliSpec,
      probe: (spec, fresh) =>
        shopCli.probe === undefined
          ? Promise.resolve({
              installed: false,
              node_ok: false,
              min_node_major: spec.min_node_major,
              checked_at: clock.now(),
            })
          : shopCli.probe(spec, fresh === true),
      invocation: (spec) => shopCli.invocation?.(spec) ?? { command: spec.bin, prefix: [] },
      ...(toolsDir === undefined
        ? {}
        : { sessionHome: cliSessionHome(toolsDir, STORE_SESSION_CLI_ID, ws) }),
      // 与网页模板同一份：连接 → 登录后自动找到的 / 手填的；都没有就用官网读到的 `xxx.myshopify.com`
      store: async () =>
        (await (await siteThemeOf(ws))?.readiness().catch(() => undefined))?.store ??
        onboardingRef?.shopifyDomainOf(ws),
      setStore: async (raw) => {
        const theme = await siteThemeOf(ws)
        if (theme === undefined) throw new ApiError('not_implemented', '这个品牌没装主题工坊')
        try {
          await theme.setStore(raw)
        } catch (e) {
          if (e instanceof SiteThemeError) throw new ApiError('invalid_input', e.message)
          throw e
        }
      },
      install: (spec) => shopCli.install?.(spec),
      installJob: (spec) => shopCli.installJob?.(spec),
      auth: storeAuthRunner,
      run:
        options.shopAdmin?.run ??
        createRunCli(() => {
          const spec = cliSpec()
          return spec === undefined
            ? { command: 'shopify', prefix: [] }
            : (shopCli.invocation?.(spec) ?? { command: spec.bin, prefix: [] })
        }),
      env,
      appendEvent: (type, payload) =>
        appendEvent({
          schema_version: 1,
          workspace_id: ws,
          type,
          actor: { kind: 'system', id: 'shop.admin' },
          correlation: { trace_id: `trc_shop_${Date.parse(clock.now()).toString(36)}` },
          payload,
        }),
    })
    /*
     * WP265（Fable 追加）：这个品牌在连接页一键授权连着店 → **优先走云端代发**（查询不带、批过的卡带
     * `allow_mutations`），岗位页那一行、工具面、出卡都按云端那一条；没有才回退上面的 CLI 授权。
     */
    const auth = preferCloudShopAdmin(cliAuth, {
      link: () => cloudShopLinks.link(ws),
      call: async () => {
        const cloud = await brandModules.cloud(ws)
        return cloud.linked() ? cloud.call : undefined
      },
      onAuthProblem: () => cloudShopLinks.invalidate(ws),
    })
    const ops = createShopOps({
      workspace_id: ws,
      clock,
      auth,
      ledger: txn.ledger,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      recipient: async ({ route_to, role_id, person_id }) => {
        if (route_to === 'role_holder') return { person: person_id, via: 'role_holder' }
        if (route_to === 'scope_manager') {
          const r = await routeScopeManager({ workspace_id: ws, role_id, proposer: person_id })
          return { person: r.person, via: r.via === 'owner' ? 'owner' : 'scope_manager' }
        }
        const owner = (await identity.getWorkspace(ws))?.owner_id ?? person_id
        return { person: owner, via: 'owner' }
      },
      /*
       * 本机图片只许从本品牌的文件夹里拿；WP267（决策 198）再加设计岗素材库那一段对象存储
       * （`<对象存储>/design/<品牌>/`，素材是明文、带图片扩展名）——只在对象存储在本机时。
       */
      fileRoots: () => {
        const roots = brand.dir === undefined ? [] : [brand.dir]
        const store = blobs?.describe()
        if (store?.kind === 'local') roots.push(join(store.display, 'design', ws))
        return roots
      },
      assetFile: (asset_id) => {
        const asset = brand.design.asset(asset_id)
        const store = blobs?.describe()
        if (
          asset === undefined ||
          asset.workspace_id !== ws ||
          asset.status === 'rejected' ||
          asset.blob_uri === undefined ||
          store?.kind !== 'local'
        )
          return undefined
        return join(store.display, blobKey(asset.blob_uri))
      },
      ...(brand.dir === undefined ? {} : { stateFile: join(brand.dir, 'shop-ops.json') }),
      ...(options.shopAdmin?.fetch === undefined ? {} : { fetch: options.shopAdmin.fetch }),
      appendEvent: (type, payload) =>
        appendEvent({
          schema_version: 1,
          workspace_id: ws,
          type,
          actor: { kind: 'system', id: 'shop.ops' },
          correlation: { trace_id: `trc_shop_${Date.parse(clock.now()).toString(36)}` },
          payload,
        }),
    })
    const entry = { auth, ops }
    shops.set(ws, entry)
    return entry
  }
  // WP252（决策 125）：一台机一个连接器、多个品牌共用——整台机一份连接归属表，各品牌的连接面共用同一个实例；
  // 启动时先把各品牌老状态文件里记过的归属补记进来（幂等），必须在任何品牌列连接之前。
  const connectOwners = openConnectOwners({ dbDir, startup: workspace.id, now: clock.now() })

  /*
   * WP265（Fable 追加）：每个品牌「云端一键授权连着哪家店」的缓存。岗位就绪（`shopify` / `shop` 两个 kind）
   * 与运营工具（优先云端、没有才回退 CLI 授权）按它认；连接页卡上每看一次、连上 / 断开都顺手更新。
   * 云客户端是品牌模块里的那一份——晚绑定（`brandModules` 在下面才建好）。
   */
  const cloudShopLinks = createCloudShopLinks({
    cloudOf: (ws) => brandModules.cloud(ws),
    startupBrand: workspace.id,
    clock,
    // 只记店与权限名（没有令牌）：重启之后不打云也知道上次连着哪家
    ...(dbDir === undefined ? {} : { file: join(dbDir, 'shopify-cloud-links.json') }),
  })
  const assembleBrand = async (ws: WorkspaceId): Promise<BrandModuleSet> => {
    const isBootstrap = ws === workspace.id
    const dir = brandDirOf(dbDir, ws, workspace.id)
    // 新品牌的目录第一次用的时候才建（`better-sqlite3` 不会替我们 mkdir）
    if (dir !== undefined) mkdirSync(dir, { recursive: true })
    // 同一个加密库、同一把密钥，key 名按品牌加前缀（bootstrap 前缀为空）
    const brandSecrets = namespaceSecrets(secrets, secretsPrefixOf(ws, workspace.id))
    // WP128：托管实例——接托管的那个品牌种上托管令牌与转发器配对、默认模型换成云
    // （两件事都在 createModels / 转发器客户端读之前做完，它们一行不用改）
    if (
      hostedBoot !== undefined &&
      ws === hostedTargetOf(hostedBoot, workspace.id, brandsOfThisOrg())
    ) {
      seedHostedSecrets(brandSecrets, hostedBoot)
      const cloudTemplate = templatesFor(env).find((t) => t.kind === 'agentsws_cloud')
      if (dir !== undefined && cloudTemplate !== undefined)
        ensureCloudModelDefault(dir, hostedBoot, {
          label: cloudTemplate.label,
          model: cloudTemplate.default_model,
          region: cloudTemplate.region,
        })
    }

    // WP20 连接面：`/v1/connections/*` 与工作台数据源共用同一份连接状态
    const connections = await createConnections({
      clock,
      workspace_id: ws,
      env,
      random,
      appendEvent,
      mailProbe: createMailProbe(),
      secrets: brandSecrets,
      // WP27：巡检交给调度器（`connect.shopify_refresh`，到期前一小时换新）；
      // 这里默认不起 setInterval，除非调用方显式要旧行为
      refreshIntervalMs: options.tokenRefreshIntervalMs ?? 0,
      storefrontPlatform: () => brandProfileOf(ws).storefront_platform,
      ...(options.shopifyFetch === undefined ? {} : { shopifyFetch: options.shopifyFetch }),
      ...(options.resolveMx === undefined ? {} : { resolveMx: options.resolveMx }),
      ...(options.connect === undefined ? {} : { connect: options.connect }),
      ...(dir === undefined ? {} : { dbDir: dir }),
      ...(localConnector === undefined ? {} : { localRuntime: localConnector }),
      // WP252：连接按品牌隔开；只有启动品牌认领没人记过的老 `default` 连接
      owners: connectOwners.owners,
      startupBrand: isBootstrap,
      // WP265：云端一键授权连着店也算店铺后台已连（岗位顶上「还缺必需的连接：店铺后台」不再挂着）
      extraKinds: () => (cloudShopLinks.peek(ws) === undefined ? [] : ['shopify', 'shop']),
    })

    /**
     * WP46：岗位面板吃**真实**店铺数据（定时经连接器跑 `list_orders` / `get_shop`，
     * 结果只进内存缓存）。接了模拟世界（`mount.data`）的 demo 路径一行不变——
     * 那一档只有 bootstrap 一个品牌。
     */
    // demo / 测试可以给某个品牌接一份现成的数据（`mount.data` 是 bootstrap 那一份）
    const injected = (isBootstrap ? mount?.data : undefined) ?? options.brandData?.(ws)
    let liveData: LiveDataSource | undefined
    if (injected === undefined) {
      liveData = createLiveDataSource({
        connections,
        connect: connections.connect,
        // WP62（51 §1 N0 ③）：跟哪个店铺后台要数按**这个品牌**的档案算，不写死 Shopify
        storefrontPlatform: () => brandProfileOf(ws).storefront_platform,
        clock,
        workspace_id: ws,
        appendEvent,
        env,
        // 44 G2：产品线切分要认制度那边的范围与判据（一条产品线都没有时整条路短路）
        scope: {
          rangesOf: (assignment_id) => roles.assignments.get(assignment_id)?.ranges ?? [],
          productLine: (id) => roles.productLines.get(id),
          productLines: () => roles.productLines.list(ws),
          activeRanges: () => roles.assignments.listByWorkspace(ws).map((a) => a.ranges),
        },
        ...(options.liveDataIntervalMs === undefined
          ? {}
          : { refreshIntervalMs: options.liveDataIntervalMs }),
      })
    }
    const baseWorkData: WorkstationDataSource =
      liveData ?? connections.wrapDataSource(injected ?? emptyDataSource())
    /**
     * WP67（48 §5.1）：红人面板那五块**永远**从这个品牌自己的红人库来。
     *
     * 包在最外层而不是塞进 `liveData` / `emptyDataSource` 各写一份：红人库不是
     * 一个"连接"（它就在这台机器上），所以它与上游连没连、demo 挂没挂合成世界
     * 都无关——哪一条路装配出来的数据源，红人那一块都是同一个来源。
     */
    /**
     * WP158（docs/82）：这个品牌的 Search Console 与 GA4 真读数。
     *
     * 经连接器的只读 Action 读、按天缓存在内存里；Google 的令牌只在 OpenConnector 里。
     * 没连这两家时它什么都不做（面板那几块照旧「去连接」）。
     */
    const googleReads =
      options.googleReadsFor?.(ws) ??
      createGoogleReads({
        workspace_id: ws,
        clock,
        connections: () => connections.liveConnections(),
        connect: connections.connect,
        appendEvent,
        ...(dir === undefined ? {} : { dir }),
      })
    connections.onConnectionChange(() => {
      googleReads.invalidate()
    })
    /*
     * WP169：店铺校正改了目标市场 → 给工作区所有者的那条通知（首页告警区一行，点开到设置页
     * 公司档案）。照 36 §2.2b「`system_alert` → 通知 + 告警块」那条现成的路走，不是卡。
     */
    const storeMarketsNotices = createStoreMarketsNotices({
      now: () => clock.now(),
      ...(dir === undefined ? {} : { dir }),
    })
    /*
     * WP224（docs/91 §2.2 #3）：毛利率事实卡（知识库里的事实卡，公司页填）+ 盈亏线。
     * 投放面板读缓存（同步），读之前 `ensureFresh` 刷一遍。
     */
    const fixedStopLossCaps = (): Partial<AdsCaps> => {
      const a = roles.assignments
        .listByWorkspace(ws)
        .find((x) => x.revoked_at === undefined && x.role_id.startsWith('ads.'))
      if (a === undefined) return {}
      try {
        const caps = roles.effectiveConfig(a.id).actions.find((x) => x.id === 'pause_ads')
          ?.mandate.caps
        const out: Partial<AdsCaps> = {}
        for (const k of ['stop_loss_roas_below', 'stop_loss_spend_pct'] as const) {
          const v = caps?.[k]
          if (typeof v === 'number') out[k] = v
        }
        return out
      } catch {
        return {}
      }
    }
    const economics = createEconomicsService({
      workspace_id: ws,
      clock,
      knowledge: knowledge.store as never,
      systemReader: async () => {
        const owner = (await identity.getWorkspace(ws))?.owner_id
        if (owner === undefined) return undefined
        const a = roles.assignments
          .listByWorkspace(ws)
          .find((x) => x.revoked_at === undefined && x.role_id === 'common.owner')
        return {
          person_id: owner,
          workspace_id: ws,
          assignment_id: a?.id ?? '',
          role_id: a?.role_id ?? 'common.owner',
          grants: [
            { domain: 'knowledge', ops: ['read'], range: 'workspace', max_sensitivity: 'internal' },
          ],
        }
      },
    })
    /** 品牌那一格毛利率算的盈亏线 + 现在那条固定止损线（只显示，不改止损）。 */
    const breakEvenNow = () => ({
      ...breakEvenView(resolveGrossMargin(economics.margins())?.margin_pct),
      fixed_line: fixedStopLossCaps().stop_loss_roas_below ?? ADS_DEFAULT_CAPS.stop_loss_roas_below,
    })
    /** WP238：取数路由走得通哪一级（云客户端在下面才建好，这里先占位、建好后填上）。 */
    const readLevelHolder: { of?: (route: string) => DataSourceLevel | undefined } = {}
    const workData: WorkstationDataSource = {
      ...baseWorkData,
      systemCards: (actor) => ({
        alerts: storeMarketsNotices.alerts(
          actor.person_id,
          onboardingRef?.brandProfile(ws).markets_source,
        ),
      }),
      // WP158：读之前先把 GSC / GA4 拉新（当天有缓存就是空操作；永不抛）
      ensureFresh: async () => {
        await baseWorkData.ensureFresh?.()
        await googleReads.ensureFresh()
        // WP224：毛利率缓存（盈亏线那一格读它）
        await economics.refresh()
      },
      search: () => googleReads.deckData(),
      kol: () => kolDeckData(kol, { now: clock.now() }),
      // WP72（56 §2）：社媒那几块同理——内容日历上的行是**我们自己排的**，
      // 一个平台都没连也照样在那儿摆着。渠道那八个源才是"连没连"的事。
      social: () => socialDeckData(social, { now: clock.now() }),
      // WP76（58 §3）：设计那五块同理——需求单、brief、待挑、素材库、本周产出
      // 都在这台机器上，出图走模型网关的图片槽（那不是一条连接）。
      design: () =>
        designDeckData(design, {
          now: clock.now(),
          // 36 §2：面板上不摆裸 id——"谁下的"那一格显示职责的中文名
          roleName: (id) => roles.roles.get(id)?.name.zh,
        }),
      // WP77（59 §3）：建站那五块同理——上线检查单上那几行是**我们自己跑出来的结论**，
      // 店没连上的时候它照实说"这几项没读到"，那与"去连接"不是一回事。
      site: () => siteService.deckData(),
      /*
       * WP75（57 §3）：投放那几块同理——campaign 表与止损记录是**我们自己库里**的行，
       * 一个平台都没连也照样在那儿摆着。四个平台那四个源才是"连没连"的事。
       */
      // WP224：ROAS 旁边并排盈亏线 + 两条止损线的对照表（只显示，不改止损）
      ads: () => {
        const now = clock.now()
        // WP224：日报那张表（归因两列）原来没递，真环境里永远是空表——补上，盈亏线才有处并排
        const attribution = adsAttribution(ads, {
          orders: baseWorkData.orders(),
          now,
          tz_offset_minutes: baseWorkData.tz_offset_minutes,
        })
        return adsDeckData(ads, {
          now,
          attribution: attribution.rows,
          unmatched_orders: attribution.unmatched_orders,
          break_even: breakEvenNow(),
          line_compare: summarizeLineCompare(ads.lineCompareRows()),
        })
      },
      // WP78（60 §3）：公关那五块同理——待发的稿子、自己攒的媒体名单是
      // **我们自己写的**，与连没连 Google Alerts 无关。外面那一侧（提及流 /
      // 负面预警）走 `google_alerts` 那个源，没连就照 36 §3 明说。
      pr: () => prDeckData(pr),
      // WP171 / WP172（docs/84）：B2B 那十九块从这个品牌自己的 B2B 库来（邮件分拣落成的询盘、
      // 批了的客户 / 报价 / 样品 …）。demo 里库里的排前面、后面垫一份演示投影
      // WP173：主动开发那三块（今天待发 · 序列漏斗 · 回复待分）从开发序列来
      b2b: () => {
        const own = b2bSales.deckPatch(clock.now(), {
          ...b2bService.deckData(clock.now()),
          ...b2bOutbound.deckData(clock.now()),
        })
        return isBootstrap && mount !== undefined
          ? withDemoB2b(own, demoB2bDeckData(clock.now()))
          : own
      },
      // 红人库与社媒库都不是"连接"，所以它们不在那两份写死的数据源表里（见 `withOwnSources`）
      // WP238：没连 Reddit API、但读 Reddit 已能经接口中台 / 只读浏览器取到——面板不再催「去连接」
      sources: () =>
        withReadVia(
          withOwnSources(baseWorkData.sources()),
          readLevelHolder.of === undefined ? {} : readViaSources(readLevelHolder.of),
        ),
    }
    // 连接清单变了（连上 / 断开 / 换令牌）：下一次读之前重拉一轮，不用等定时器
    connections.onConnectionChange(() => {
      liveData?.invalidate()
    })

    /**
     * WP53：真环境的事项记录源（订单 / 商品经连接器的只读 Action，政策经知识层，
     * 联系人进线程台账）。demo 与测试传了 `records` 就原样用那一份，一行不变。
     */
    // WP67（48 §5.2）：这个品牌的红人库（六类对象，落在这个品牌自己的目录下）。
    // 建在记录源之前：记录源要拿它读红人与合作（`kol: () => kol`）。
    const kol = createKolStore({ workspace_id: ws, ...(dir === undefined ? {} : { dbDir: dir }) })
    /**
     * WP72（56 §2 数据面）：这个品牌的社媒库（四类对象，落在这个品牌自己的目录下）。
     * 与红人库并排建，理由一样：记录源要拿它读账号与线程（`social: () => social`）。
     */
    const social = createSocialStore({
      workspace_id: ws,
      ...(dir === undefined ? {} : { dbDir: dir }),
    })
    // WP191（docs/86 §6）：老库里 `channel: 'meta'` 的账号 / 帖子 / 线程迁到 FB 主页或 IG（按 URL 判）。
    // 幂等，每次建这个品牌的模块都跑得起；与分配那一段迁移是同一次拆分的两个面。
    migrateSupersededChannels(social)
    /**
     * WP78（60 §5 数据面）：这个品牌的公关库（四类对象，落在这个品牌自己的目录下）。
     * 与红人库、社媒库并排建，理由一样：品牌 A 的媒体名单、稿子与提及，
     * 在 B 的任何路由里都读不到——媒体名单是这家公司攒了很多年的东西。
     */
    const pr = createPrStore({
      workspace_id: ws,
      ...(dir === undefined ? {} : { dbDir: dir }),
    })
    /**
     * WP172（docs/84）：这个品牌的 B2B 库（九类对象 + 询盘 / 草稿 / 抑制名单，`b2b.sqlite`）。
     * 与公关库并排建，理由一样：客户名单与报价是一家外贸公司攒了很多年的东西。
     */
    const b2b = createB2bStore({
      workspace_id: ws,
      now: () => clock.now(),
      ...(dir === undefined ? {} : { dbDir: dir }),
    })
    /**
     * WP75（57 §5 数据面）：这个品牌的广告库（五类对象）。
     *
     * 与红人库、社媒库并排建，理由一样：记录源要拿它读账户与 campaign
     * （`ads: () => ads`），面板那一层要拿它算总闸。
     */
    const ads = createAdsStore({
      workspace_id: ws,
      ...(dir === undefined ? {} : { dbDir: dir }),
    })
    /**
     * WP77（59 §2 数据面）：这个品牌的建站库（三类对象）。
     * 与红人库 / 社媒库并排建，理由一样：记录源要拿它读邮件模板与已装 App
     * （`site: () => siteService`——15 §1 改前必读，改一份模板之前要先读回来）。
     */
    const site = createSiteStore({
      workspace_id: ws,
      ...(dir === undefined ? {} : { dbDir: dir }),
    })
    /**
     * WP76（58 §5 数据面）：这个品牌的设计库（三类对象，落在这个品牌自己的目录下）。
     * 与社媒库并排建，理由一样：面板那五块要从它读。
     */
    const design = createDesignStore({
      workspace_id: ws,
      ...(dir === undefined ? {} : { dbDir: dir }),
    })

    /**
     * WP68（48 §5.4）：红人库的 `/v1` 面。建在记录源之前没有讲究，
     * 建在 `kol` 之后是必须的——它要那张库。
     */
    /**
     * WP68：五条渠道适配器真打出去的那一跳（凭据按连接从这个品牌那一段加密库取）。
     * 生产路径不传 `kolFetch`，走全局 fetch；测试塞一个假的对着真 URL 断言。
     */
    const kolChannels = createKolChannels({
      workspace_id: ws,
      clock,
      connections: () => connections.liveConnections(),
      secrets: brandSecrets,
      ...(options.kolFetch === undefined ? {} : { fetch: options.kolFetch }),
    })
    /**
     * WP68（49 M2）：云端公共红人库的客户端。
     *
     * 与模型那一项同一条路：地址由 `AGENTSWS_CLOUD_BASE_URL` 决定，
     * 令牌是**这个品牌那一把** `cloud.workspace_token`（WP66 每品牌一把）。
     * 用不用它由连接页那五个开关说了算（`kol.<channel>`）。
     */
    const kolPublic = createKolPublicClient({
      workspace_id: ws,
      clock,
      secrets: brandSecrets,
      env,
      newContactId: () => `ctc_${Math.floor(random() * 0xffffffff).toString(36)}`,
      ...(options.cloudFetch === undefined ? {} : { fetch: options.cloudFetch }),
    })
    // WP126：自带数据接口的配置仓（每渠道一个；密钥只进本机加密库）
    const byoStore = createByoSourceStore({
      secrets: brandSecrets,
      ...(dbDir === undefined ? {} : { dbDir }),
      now: () => clock.now(),
    })
    /**
     * WP155（docs/81）：这个品牌的搜索数据接口（`SearchDataPort`）。三档：官方（打云端，
     * 令牌是这个品牌那一把）/ 自带 key（本机直连，key 在这个品牌那一段加密库）/ 不接。
     * 设置文件落在这个品牌自己的目录下。WP154「内容与搜索」经 `brand.searchData` 消费。
     */
    const searchData = createSearchDataService({
      store: createSearchDataStore({
        secrets: brandSecrets,
        ...(dir === undefined ? {} : { dir }),
        now: () => clock.now(),
      }),
      official: createOfficialSearchClient({
        secrets: brandSecrets,
        baseUrl: cloudBaseUrl(env),
        tokenSecretId: CLOUD_TOKEN_SECRET_ID,
        ...(options.cloudFetch === undefined
          ? {}
          : { fetch: options.cloudFetch as unknown as SearchFetch }),
      }),
      now: () => clock.now(),
      ...(options.searchFetch === undefined ? {} : { fetch: options.searchFetch }),
    })
    // WP176：开发信装配（`b2bOutbound`）比运行时晚建；运行时里的开发信工具经这个盒子懒取
    const b2bOutboundLate: { current?: B2bOutboundAssembly } = {}
    const kolService = createKolService({
      workspace_id: ws,
      store: kol,
      channels: kolChannels,
      publicLibrary: kolPublic,
      /*
       * 49 M2 的开关：`kol.<channel>` 拨到 agentsws 就查公共库，默认用我的。
       *
       * 递的是取值函数而不是 `ownCloud` 本身——它在下面几十行才建出来
       * （同 `work: () => workRef` 那一处：打断装配期的环，取值时才查）。
       */
      capabilitySource: (capability) => ownCloud.sourceOf(capability),
      // WP126 数据接口路由：顺序 / 开关从设置来（没配过的渠道回默认顺序）
      dataSourceRoute: (channel) => ownCloud.routeOf(channel),
      // WP126 自带数据接口：配置仓 + 路由第②级用的那份配置
      byo: byoStore,
      byoDataSource: (channel) => byoStore.get(channel),
      byoSecrets: (ref) => byoStore.reader(ref),
      // 价目从云上那一份来（49 M4），本地一个数字都不自己算
      priceOf: (capability) => ownCloud.priceOf(capability),
      // 联系方式的明文落在**这个品牌**那一段加密库里（key 名已按品牌加过前缀）
      secrets: brandSecrets,
      clock,
      approvals: txn.approvals,
      ledger: txn.ledger,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      // 05 §4：campaign 那一条按渠道挑**本人自己**那条职责，不做并集
      assignmentsOf: (person_id) => roles.assignments.listByPerson(person_id),
      // 序列跟进那条定时用持有人那条分配去提（定时任务没有"当前用户"）
      holdersOf: (role_id) =>
        roles.assignments
          .listByRole(role_id)
          .filter((a) => a.workspace_id === ws && a.revoked_at === undefined),
      // 52 O1 那一份真源：品牌名与工作区名是同一件事，不在这里拼第二次
      brandName: () => brandNameOfWorkspace(ws),
      personName: async (person_id) => (await identity.getPerson(person_id))?.name ?? person_id,
      appendEvent,
      random,
    })

    /**
     * WP73（56 §6）：九条渠道的适配器与 transport。
     *
     * 与红人那一份并排建，凭据取法逐字相同：按连接 id 从**这个品牌那一段**
     * 加密库取，取出来直接交给适配器放进请求头。Facebook 群组没有连接卡——
     * 它的"连上了"看的是第三栏那个受控浏览器（55 §3），这里先不装，
     * 装配在浏览器设置那一侧（`browser-settings.ts`）落地之后再接。
     */
    /*
     * WP249（决策 89）：Reddit 官方号浏览器通道（每品牌一份，目录 `<品牌目录>/reddit-official-browser/`，
     * 与只读读号那份分开）。托管实例不装（云上没有浏览器、也不该有谁的登录态）。
     */
    const robOptions = options.redditOfficialBrowser
    const redditOfficial =
      robOptions === undefined || robOptions === false || hostedBoot !== undefined
        ? undefined
        : createRedditOfficialBrowser({
            ...(dir === undefined ? {} : { dir: join(dir, 'reddit-official-browser') }),
            nowMs: () => Date.parse(clock.now()),
            executable: () => browserSettings.get().executable_path,
            ...robOptions,
          })
    const socialChannels = createSocialChannels({
      workspace_id: ws,
      clock,
      connections: () => connections.liveConnections(),
      secrets: brandSecrets,
      ...(options.socialFetch === undefined ? {} : { fetch: options.socialFetch }),
      ...(redditOfficial === undefined ? {} : { redditBrowser: redditOfficial.port }),
    })
    /**
     * WP73：社媒库的 `/v1` 面。
     *
     * `triage.ts` 与 `moderation.ts` 的调用方就在它里面——56 那条
     * "群里的客户问题不归社媒运营"的边界，从这一跳起是真会发生的事。
     */
    let replyDrafts = 0
    const nextReplyDraft = (): string => `${Date.parse(clock.now()).toString(36)}_${++replyDrafts}`
    const socialService = createSocialService({
      workspace_id: ws,
      routeScopeManager,
      store: social,
      // WP73：到点真发出去那一跳走这九条适配器
      channels: socialChannels,
      // WP249：自家版待处理（批了的版务卡过了取消窗口由执行器施行，结果进变更账本）
      ownSub: {
        ...(redditOfficial === undefined ? {} : { officialBrowser: redditOfficial }),
        apiConnected: () => socialChannels.transport.connected('reddit'),
        applyApproval: (id) => txn.executor.applyApproval(id),
        cancelWindowMs: txn.runtime.policy.cancel_window_sec * 1000,
      },
      // WP254（决策 117）：别的社群的版务卡与回帖卡批了，过了取消窗口由执行器施行（定时发布那一轮补扫）
      executor: {
        applyApproval: (id) => txn.executor.applyApproval(id),
        cancelWindowMs: txn.runtime.policy.cancel_window_sec * 1000,
        approvedItems: () =>
          txn.runtime.store.listApprovals({
            workspace_id: ws,
            kind: 'outbound_draft',
            state: ['approved', 'approved_edited'],
          }),
      },
      /*
       * WP255（决策 144）：「回复」框的 AI 起草。按这个品牌（跟随公司时用公司那份）的默认模型、经品牌急停那一层网关；
       * 用量记在点起草的那个人头上（`extraction` 档）。只有 stub（演示 / 没接模型）→ 不给，起草退回一句模板并照实说。
       * 网关在下面才建出来：这里只在请求那一刻取（闭包晚绑定），装配期不碰它。
       */
      replyDrafter: (actor) => {
        const models = effectiveModels()
        const ref = models.configured() ? models.defaultRef() : undefined
        if (ref === undefined || ref.provider === 'stub') return undefined
        return modelReplyDrafter(async (prompt) => {
          const completion = await gatewayProxy.complete({
            messages: [{ role: 'user', content: prompt }],
            meta: {
              workspace_id: ws,
              assignment_id: actor.assignment_id as never,
              role_id: actor.role_id as never,
              run_id: `social_reply_draft_${nextReplyDraft()}` as never,
              purpose: 'extraction',
            },
            model: ref,
            max_output_tokens: 300,
            thinking: 'off',
          })
          return completion.text
        })
      },
      /*
       * WP257（决策 152）：自动进帖判类打标签。品牌名进规则（正文里提到算「冲着我们来的」）；模型复核默认关，
       * 打开了才调：按这个品牌的默认模型、经品牌急停那一层网关，用量记在持有那条社媒职责的人头上
       * （`extraction` 档，最多 8 个输出 token）。只有 stub / 没人持有那条职责 → 不给，只按规则判。
       */
      brandName: () => brandNameOfWorkspace(ws),
      modelReady: () => {
        const models = effectiveModels()
        return models.configured() && models.defaultRef().provider !== 'stub'
      },
      tagReviewer: (channel) => {
        const models = effectiveModels()
        const ref = models.configured() ? models.defaultRef() : undefined
        if (ref === undefined || ref.provider === 'stub') return undefined
        const spec = socialChannelSpec(channel)
        const holder =
          spec === undefined
            ? undefined
            : roles.assignments
                .listByRole(spec.role_id)
                .find((a) => a.workspace_id === ws && a.revoked_at === undefined)
        if (holder === undefined) return undefined
        return modelTagReviewer(async (prompt) => {
          const completion = await gatewayProxy.complete({
            messages: [{ role: 'user', content: prompt }],
            meta: {
              workspace_id: ws,
              assignment_id: holder.id as never,
              role_id: holder.role_id as never,
              run_id: `social_tag_review_${nextReplyDraft()}` as never,
              purpose: 'extraction',
            },
            model: ref,
            max_output_tokens: 8,
            thinking: 'off',
          })
          return completion.text
        })
      },
      // 日界线按**这个品牌的数据源**报的时区（与定时任务那一份同一个真源，
      // 不去读本机时区——那在测试与服务器上都不是用户所在的那个时区）
      tzOffsetMinutes: workData.tz_offset_minutes,
      clock,
      approvals: txn.approvals,
      ledger: txn.ledger,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      // 转客服卡要落到**真持有社群管理的那个人**头上；没人持有就落到 owner
      holdersOf: (role_id) =>
        roles.assignments
          .listByRole(role_id)
          .filter((a) => a.workspace_id === ws && a.revoked_at === undefined)
          .map((a) => ({ person_id: a.person_id })),
      owner: async () => (await identity.getWorkspace(ws))?.owner_id,
      appendEvent,
      random,
      /*
       * WP191（docs/86 §4）：LinkedIn 那条到点发不出去（没连 / 没批 / 带素材还不能代发）时，
       * 开一条「复制文案去 LinkedIn 发」的待办，落在**持有这条职责的人**头上。
       * `workRef` 晚绑定（它在下面才建出来，同 `work: () => workRef` 那一处）；定时发布那一跳
       * 远在装配完成之后，那时它一定在了。没人持有这条职责就不开（照旧只记一句"没发"）。
       */
      manualPublishTask: ({ post, channel_label, reason }) => {
        const spec = socialChannelSpec(post.channel)
        const holder =
          spec === undefined
            ? undefined
            : roles.assignments
                .listByRole(spec.role_id)
                .find((a) => a.workspace_id === ws && a.revoked_at === undefined)
        if (workRef === undefined || holder === undefined) return undefined
        const todo = workRef.createTodo({
          title: `复制文案去 ${channel_label} 发`,
          owner: holder.person_id,
          note: `${post.body}\n\n——\n原定时间：${post.scheduled_at ?? '批了就发'}。没自动发出去的原因：${reason}`,
          horizon: 'today',
          source: 'card',
          position_id: holder.id,
        })
        return { todo_id: todo.id }
      },
    })

    /**
     * WP78（60 §5）：公关库的 `/v1` 面。
     *
     * `triageMention` 与 `checkSubredditRules` 的调用方就在它里面——60 那条
     * "监控发现的客户投诉转客服"的分界，以及"在别人的地盘上版主说了算"这件事，
     * 从这一跳起是真会发生的事。
     *
     * `pullMentions` 暂时不给：进料那两条（Google Alerts 的 RSS、Reddit 全站搜）
     * 要这个品牌连接页上那两张卡真连上才有东西可拉。没配的时候
     * `monitorSweep()` 照实说"还没配监控源"，**不是**"今天没人提我们"。
     */
    /**
     * WP172（docs/84）：B2B 库的 `/v1/b2b/*`。写都经卡（草稿 → 改动卡 → 批了执行器才落库，
     * 见 `backendApply`）；报价谁批由授权四个数算。服务进程里还没有"部门负责人"，超授权落老板。
     */
    const b2bService = createB2bService({
      workspace_id: ws,
      routeScopeManager,
      store: b2b,
      clock,
      random,
      approvals: txn.approvals,
      ledger: txn.ledger,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      appendEvent,
      // 邮箱 / 电话明文只进本机加密库（同红人库的联系方式）
      secrets: {
        put: (id, fields) => {
          if (!brandSecrets.available)
            throw new ApiError('invalid_input', '本机加密库没开，存不了邮箱 / 电话。')
          return brandSecrets.put(id, fields)
        },
      },
      owner: async () => (await identity.getWorkspace(ws))?.owner_id,
    })
    const prService = createPrService({
      workspace_id: ws,
      routeScopeManager,
      store: pr,
      clock,
      approvals: txn.approvals,
      ledger: txn.ledger,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      // 转客服卡要落到**真持有客服**的那个人头上；没人持有就落到 owner
      holdersOf: (role_id) =>
        roles.assignments
          .listByRole(role_id)
          .filter((a) => a.workspace_id === ws && a.revoked_at === undefined)
          .map((a) => ({ person_id: a.person_id })),
      owner: async () => (await identity.getWorkspace(ws))?.owner_id,
      // 定时那一轮用**真持有品牌监控**的那个人的分配去提（定时任务没有"当前用户"）
      monitorActor: () => {
        const holder = roles.assignments
          .listByRole('pr.monitoring')
          .find((a) => a.workspace_id === ws && a.revoked_at === undefined)
        return holder === undefined
          ? undefined
          : {
              workspace_id: ws,
              person_id: holder.person_id,
              assignment_id: holder.id,
              role_id: holder.role_id,
            }
      },
      appendEvent,
      random,
    })
    /**
     * WP75（57 §5）：广告库的 `/v1` 面。
     *
     * 04 §5 那条额度纪律（止损 L3、额度内 L2、开花钱口子永远 L1）在服务进程里的
     * 落点就是它：五个写口子全部经变更账本，一条都不直接改库、不直接打平台。
     */
    const adsService = createAdsService({
      workspace_id: ws,
      routeScopeManager,
      // WP224：止损卡上判据旁边并排一格盈亏线（只显示）
      breakEven: breakEvenNow,
      store: ads,
      clock,
      ledger: txn.ledger,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      appendEvent,
      random,
    })
    /**
     * WP224（docs/91 §2.2 #1）：本周经营一页纸。面板上下文用的就是工作台那一份端口
     * （同 `workstationPortFor` 的装法，这里直接建一份，免得引用一个还没走到的定义）。
     */
    const weeklyReview = createWeeklyReviewService({
      workspace_id: ws,
      clock,
      assignments: () => roles.assignments.listByWorkspace(ws),
      approvals,
      port: async () => createWorkstationPort({ clock, roles, approvals, data: workData }),
      brandName: () => brandNameOfWorkspace(ws),
    })
    /** WP224：今天记一行两条止损线的对照（每天夜里那条定时调；只记账，不改止损）。 */
    const lineCompareSnapshot = async () => {
      await economics.refresh()
      const now = clock.now()
      const tz = workData.tz_offset_minutes
      const date = new Date(Date.parse(now) + tz * 60_000).toISOString().slice(0, 10)
      const rows = snapshotLineCompare(ads, {
        date,
        now,
        caps: fixedStopLossCaps(),
        marginFor: () => resolveGrossMargin(economics.margins())?.margin_pct,
      })
      return { rows: rows.length, date }
    }

    /**
     * WP77（59 §2）：建站库的 `/v1` 面。
     *
     * 事实经**只读** Action 读回来（`createConnectSiteFacts`），判断在
     * `@agentsws/site-core` 的纯函数里，出卡走变更账本——三段各在各的地方。
     * 一条 Action 读不到就那一格留空，检查单照 `unknown` 记：一次令牌过期，
     * 不该在卡面上写成"这家店没有收款方式"。
     */
    const siteService = createSiteService({
      workspace_id: ws,
      routeScopeManager,
      store: site,
      clock,
      approvals: txn.approvals,
      ledger: txn.ledger,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      facts: createConnectSiteFacts({
        connect: connections.connect as never,
        // 店铺那条连接（没有 = 整次巡检全是"没读到"，而不是"全缺"）
        connection: () =>
          connections
            .liveConnections()
            .find((c) => c.service.startsWith('shopify') && c.status === 'active'),
      }),
      // 装上了却还没连上 API 的那几条要指得出来（59 §2 那条接缝）
      connectedKinds: () => connections.connectedKinds(),
      appendEvent,
      random,
    })

    /**
     * WP76（58 §5）：设计库的 `/v1` 面。
     *
     * 图片槽从**这个品牌的**网关取（52 O3：一个品牌一个网关）；没有就只出
     * brief 与规格并明说（58 §1）。素材字节进 blob store，库里只留 `blob://…`。
     * 品牌系统从公司层技能取（24），取不到就出「先设品牌系统」卡。
     */
    const designService = createDesignService({
      workspace_id: ws,
      store: design,
      clock,
      approvals: txn.approvals,
      ledger: txn.ledger,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      appendEvent,
      random,
      images: () => ownGateway.images,
      ...(blobs === undefined ? {} : { blobs }),
      roleName: (id) => roles.roles.get(id)?.name.zh,
      // WP122（71 §5）：这个品牌的那份 `DESIGN.md` 注进出图的提示词，
      // 并给规范自检当尺子。**每次出活现取**——用户在设计规范页上改一格，
      // 下一批图就得照着改后的来
      brandDesign: () => brandDesignRef?.context(ws, 'design'),
      brandDesignProfile: () => brandDesignRef?.profileOf(ws),
      brandCards: () => {
        const sections = skills.registry.listSections(BRAND_SYSTEM_SKILL_NAME)
        if (sections.length === 0) return []
        return [
          {
            name: BRAND_SYSTEM_SKILL_NAME,
            scope: 'org' as const,
            body: sections.map((sec) => `## ${sec.heading}\n${sec.body}`).join('\n'),
          },
        ]
      },
    })

    /*
     * WP268（决策 213）：品牌素材库（设计库那张素材表 + 对象存储）与生图 / 改图工具。
     * 生图那一档、单价每次现取（设置页改了立刻生效）；挑中带 `place` 的交给 `createImagePlacer`
     * （传店铺文件 → 写模板 → 推未发布预览）。工作模型比这里晚建（`workRef` 晚绑定）。
     */
    const brandAssets = createBrandAssets({
      workspace_id: ws,
      store: design,
      ...(blobs === undefined ? {} : { blobs }),
      clock,
      random,
      ...(options.images?.extraImageHosts === undefined
        ? {}
        : { extraImageHosts: options.images.extraImageHosts }),
    })
    brandAssetsByWs.set(ws, brandAssets)
    const imageService = createImageService({
      workspace_id: ws,
      clock,
      assets: brandAssets,
      images: () => ownGateway.images,
      pricing: () => {
        const view = ownModels.imageView()
        const per_edit = pricingCatalog.creditsFor(AI_IMAGE_EDIT_CAPABILITY, 1)
        return {
          // 设置页没配、却有一条生图挂着（demo 的占位图 / 测试的假云端）：按官方接口的价算，宁可多报不少报
          official: view.official || !view.configured,
          ...(view.model === undefined ? {} : { model: view.model }),
          ...(view.credits_per_image === undefined ? {} : { per_image: view.credits_per_image }),
          ...(per_edit === undefined ? {} : { per_edit }),
        }
      },
      approvals: () => approvals,
      work: () => workRef,
      designContext: () => brandDesignRef?.context(ws, 'design'),
      forbidden: () =>
        skills.registry.listSections(BRAND_SYSTEM_SKILL_NAME).length === 0
          ? []
          : (resolveBrandSystem(
              [
                {
                  name: BRAND_SYSTEM_SKILL_NAME,
                  scope: 'org' as const,
                  body: skills.registry
                    .listSections(BRAND_SYSTEM_SKILL_NAME)
                    .map((sec) => `## ${sec.heading}\n${sec.body}`)
                    .join('\n'),
                },
              ],
              'dtc',
            ).system?.forbidden ?? []),
      shopReader: async () => {
        const m = await shopOf(ws)
        if (m === undefined || (await m.auth.access().catch(() => undefined)) === undefined)
          return undefined
        return m.auth.reader()
      },
      place: createImagePlacer({
        workspace_id: ws,
        assets: brandAssets,
        clock,
        shop: async () => {
          const m = await shopOf(ws)
          return m === undefined
            ? undefined
            : {
                scopes: async () => (await m.auth.access().catch(() => undefined))?.scopes,
                admin: () => m.auth.admin(),
              }
        },
        theme: () => siteThemeOf(ws),
        ...(options.shopAdmin?.fetch === undefined
          ? {}
          : { uploadFetch: options.shopAdmin.fetch as never }),
        ...(options.images?.sleep === undefined ? {} : { sleep: options.images.sleep }),
      }),
      ...(options.images?.fetch === undefined ? {} : { fetch: options.images.fetch }),
      appendEvent: (type, payload) =>
        appendEvent({
          schema_version: 1,
          workspace_id: ws,
          type,
          actor: { kind: 'system', id: 'images' },
          correlation: { trace_id: `trc_img_${Date.parse(clock.now()).toString(36)}` },
          payload,
        }),
    })
    imageServices.set(ws, imageService)

    let workRef: Work | undefined
    /**
     * WP125：客服判断层（晚绑定，同 `workRef` 那一条理由）。
     *
     * 运行时比判断层先装配好，而运行时的 `judgeDraft` 要调它——靠这个变量打断环。
     */
    let supportJudgmentRef: SupportJudgment | undefined
    const records: MatterRecordSource =
      (isBootstrap ? options.records : undefined) ??
      createConnectRecordSource({
        connections,
        connect: connections.connect,
        clock,
        workspace_id: ws,
        knowledge: knowledge.retrieval,
        roles,
        // 运行时装在工作模型之前（两者互相需要），所以这里收的是取值函数
        work: () => workRef,
        appendEvent,
        storefrontPlatform: () => brandProfileOf(ws).storefront_platform,
        /*
         * WP267（决策 209）：这个品牌在连接页云端一键授权连着店（授了 read_orders）→ 客服回信 / 订单查询的
         * 订单与商品改走云端代发（只读）；没连再回退连接器那条 Shopify 连接。改动照旧出卡。
         */
        cloudShop: () =>
          cloudShopReader(
            {
              link: () => cloudShopLinks.link(ws),
              call: async () => {
                const cloud = await brandModules.cloud(ws)
                return cloud.linked() ? cloud.call : undefined
              },
              onAuthProblem: () => cloudShopLinks.invalidate(ws),
            },
            ['read_orders'],
          ),
        // WP67：红人与合作的只读记录（联系方式一格都不给，见 `RecordKolPort`）
        kol: () => kol,
        // WP72：社媒账号与社群线程的**只读**记录（见 `RecordSocialPort`）
        social: () => social,
        /*
         * WP77：邮件模板与已装 App 的**只读**记录（见 `RecordSitePort`）。
         *
         * 15 §1 改前必读：改一份模板之前要先把它读回来——`before` 就是那段正文。
         * 巡检结论不给：它已经原样在那张检查单卡上了（见 `RecordSitePort` 的注释）。
         */
        site: () => ({
          template: (id) => {
            const row = site.template(id)
            return row === undefined
              ? undefined
              : {
                  id: row.id,
                  notification_type: row.notification_type,
                  name: row.name.zh,
                  subject: row.subject,
                  body: row.body,
                  enabled: row.enabled,
                  missing_variables: row.missing_variables,
                  updated_at: row.updated_at,
                }
          },
          app: (id) => {
            const row = site.app(id)
            return row === undefined
              ? undefined
              : {
                  id: row.id,
                  name: row.name,
                  installed: row.installed,
                  known: row.known,
                  ...(row.scopes === undefined ? {} : { scopes: row.scopes }),
                  ...(row.directory_kind === undefined
                    ? {}
                    : { directory_kind: row.directory_kind }),
                  ...(row.installed_at === undefined ? {} : { installed_at: row.installed_at }),
                }
          },
        }),
        // WP75：广告账户与 campaign 的**只读**记录（见 `RecordAdsPort`）
        ads: () => ads,
        /*
         * WP78：稿子、提及与外部露出的**只读**记录（见 `RecordPrPort`）。
         *
         * 稿子那两个数在这里当场算，用的是 guardrail 那一份代码
         * （`extractFigures` / `uncitedFigures`）——模型看到的"还有几个数没出处"
         * 与门拦下来时说的必须是同一个数。
         */
        pr: () => ({
          release: (id) => {
            const r = pr.release(id)
            if (r === undefined) return undefined
            const figures = extractFigures(r.body)
            const uncited = uncitedFigures(
              r.body,
              r.facts_cited.map((c) => c.figure),
            )
            return {
              id: r.id,
              status: r.status,
              headline: r.headline,
              dek: r.dek,
              body: r.body,
              figures: figures.length,
              cited: figures.length - uncited.length,
              ...(r.embargo_until === undefined ? {} : { embargo_until: r.embargo_until }),
            }
          },
          mention: (id) => {
            const m = pr.mention(id)
            if (m === undefined) return undefined
            return {
              id: m.id,
              source: m.source,
              origin: m.origin,
              url: m.url,
              ...(m.title === undefined ? {} : { title: m.title }),
              text: m.text,
              ...(m.author === undefined ? {} : { author: m.author }),
              published_at: m.published_at,
              ...(m.sentiment === undefined ? {} : { sentiment: m.sentiment }),
              ...(m.triage === undefined ? {} : { triage: m.triage }),
              status: m.status,
              seen_count: m.seen_count,
            }
          },
          externalPost: (id) => {
            const p = pr.post(id)
            if (p === undefined) return undefined
            return {
              id: p.id,
              platform: p.platform,
              venue: p.venue,
              kind: p.kind,
              status: p.status,
              body: p.body,
              rules_ok: p.rules_checked.ok,
              rules_reasons: [...p.rules_checked.reasons],
              ...(p.url === undefined ? {} : { url: p.url }),
              ...(p.published_at === undefined ? {} : { published_at: p.published_at }),
            }
          },
        }),
        ...(liveData === undefined ? {} : { liveData }),
      })

    // ── 模型面：一个品牌一个网关、一份 provider 配置、一份能力开关（52 O3）
    // WP215：这个品牌的急停视图——品牌急停只停这个品牌的模型调用与对外发送，全局急停照旧压过一切
    const brandHalt = background.haltOf(ws)
    const ownGateway = makeGateway(brandHalt)
    /*
     * WP228：本机只读浏览器（每品牌一份：用户数据目录、限速账本在 `<品牌目录>/readonly-browser/`）。
     * 只开 Reddit 的页面、只读、限速从这个品牌的设置来；要用时才起无头浏览器，闲了自己关。
     */
    const rbOptions = options.readonlyBrowser
    // WP228（Luoye 10-05）：托管实例（云上那份）不装——没有浏览器，这一路停用、连接页那一行不显示
    const hostedInstance = hostedBoot !== undefined
    // WP246：取数路线的小账（设置 + 每级最近一次结果），每品牌一份
    const readStore = createReadRoutesStore(dir)
    const {
      loginWindow: rbLoginWindow,
      loginUrl: rbLoginUrl,
      whoamiUrl: rbWhoamiUrl,
      allowedHosts: rbHosts,
      ...rbLaunch
    } = rbOptions === undefined || rbOptions === false ? {} : rbOptions
    const readonlyBrowser =
      rbOptions === undefined || rbOptions === false || hostedInstance
        ? undefined
        : createReadonlyBrowser({
            ...(dir === undefined ? {} : { dir: join(dir, 'readonly-browser') }),
            allowedHosts: () => rbHosts ?? REDDIT_READ_HOSTS,
            limits: () => ownCloud.redditBrowserReadLimits(),
            nowMs: () => Date.parse(clock.now()),
            executable: () => browserSettings.get().executable_path,
            // WP246：用读号的登录态读；有头最小化 / 无头按设置
            useProfile: () => true,
            windowMode: () => readStore.settings().reddit_browser_window,
            ...rbLaunch,
          })
    /*
     * WP246（决策 88）：Reddit 读号——用户自己在网页上登录的普通号；品牌登记的 Reddit 号（官方 / 版主）一律拦。
     */
    const readAccount: RedditReadAccount | undefined =
      readonlyBrowser === undefined
        ? undefined
        : createRedditReadAccount({
            browser: readonlyBrowser,
            ...(dir === undefined ? {} : { dir: join(dir, 'readonly-browser') }),
            // 决策 108：登记过的 Reddit 号 + 在「官方号浏览器」里登录过的官方号（WP249），都不能当读号
            brandHandles: () => [
              ...social.accounts({ channel: 'reddit' }).map((a) => a.handle),
              ...(redditOfficial?.officialUsernames() ?? []),
            ],
            nowMs: () => Date.parse(clock.now()),
            ...(rbLaunch.platform === undefined ? {} : { platform: rbLaunch.platform }),
            ...(rbLaunch.env === undefined ? {} : { env: rbLaunch.env }),
            ...(rbLoginWindow === undefined ? {} : { openWindow: rbLoginWindow }),
            ...(rbLoginUrl === undefined ? {} : { loginUrl: rbLoginUrl }),
            ...(rbWhoamiUrl === undefined ? {} : { whoamiUrl: rbWhoamiUrl }),
          })
    const ownCloud = createCloud({
      ...(readonlyBrowser !== undefined
        ? { readonlyBrowserStatus: () => readonlyBrowser.status() }
        : hostedInstance
          ? {
              hosted: true,
              readonlyBrowserStatus: () => ({
                state: 'no_browser' as const,
                hosted: true,
                message: '云上托管实例没有浏览器，Reddit 只走接口中台。',
                pages_last_day: 0,
                max_pages_per_day: ownCloud.redditBrowserReadLimits().max_pages_per_day,
              }),
            }
          : {}),
      clock,
      secrets: brandSecrets,
      env,
      // WP118 / 67 §3：云端红人库要同步的就是这个品牌自己那本红人库
      kol: () => kol,
      ...(dir === undefined ? {} : { dbDir: dir }),
      ...(options.cloudFetch === undefined ? {} : { fetch: options.cloudFetch }),
      pricingCatalog,
      // WP194：打云时带「谁 / 哪个岗位」；公司「积分」页只给 owner / admin；改额度顺手推公司时区
      positionOf: (role_id) => cloudPositionOf(ws, role_id),
      canManage: (actor) => creditsRoleOf(actor.person_id, ws),
      directory: () => creditsDirectory(ws),
      timeZone: async () => (await identity.getWorkspace(ws))?.tz,
      // WP272：撞上缺动作集 → 后台补签 → 原样再打一次（用户无感）
      scopeUpgrade: () => scopeAutoUpgrade?.ensure(ws) ?? Promise.resolve(false),
    })
    readLevelHolder.of = readRouteLevelOf(ownCloud, readonlyBrowser, readAccount)
    // WP246：取数路线（体检、设置、读号、两个零配置工具）
    const readRoutes: ReadRoutesAssembly = createReadRoutes({
      store: readStore,
      nowMs: () => Date.parse(clock.now()),
      cloud: ownCloud,
      hosted: hostedInstance,
      ...(readonlyBrowser === undefined ? {} : { browser: readonlyBrowser }),
      ...(readAccount === undefined ? {} : { account: readAccount }),
      ...(options.readNet === undefined || options.readNet === false
        ? {}
        : { net: options.readNet }),
    })
    // WP206：名册推上云（网页「成员额度」页列人）。公司页装好之后（`rosterReady`）才开始推
    const rosterSync = createRosterSync({
      build: () => cloudRoster(ws),
      push: (roster) => ownCloud.syncRoster(roster),
      linked: () => ownCloud.linked(),
    })
    rosterSyncs.get(ws)?.close()
    rosterSyncs.set(ws, rosterSync)
    if (rosterReady) rosterSync.start()
    const ownModels = createModels({
      clock,
      pricing: pricingCatalog,
      gateway: ownGateway,
      secrets: brandSecrets,
      env,
      // WP42：价目刷新是一次普通出站 HTTP GET，照 28 §1 的 outbound 档管
      halt: brandHalt,
      appendEvent: (e) => {
        appendEvent(e)
      },
      workspace_id: () => ws,
      // WP194：官方接口那一条带上「谁 / 哪个岗位」（云上按人按岗位的每月上限）
      cloudAttribution: (meta) => cloudAttributionOf(meta.assignment_id, meta.role_id),
      ...(dir === undefined ? {} : { dbDir: dir }),
      ...(options.modelFetch === undefined ? {} : { fetch: options.modelFetch }),
      ...(options.pricingFetch === undefined ? {} : { pageFetch: options.pricingFetch }),
      // WP134：账号登录那一路（只有"登录了没有"与官方 resolveToken 两样）
      deepseekAccount: {
        signedIn: () => deepseekAccount.signedIn(),
        resolveToken: (url: string) => deepseekAccount.resolveToken(url),
        rejectToken: (token: string) => deepseekAccount.rejectToken(token),
        // WP151：余额不足那一行按机器一份（账号只有一个），各品牌的模型卡读同一份
        reportBalance: (insufficient: boolean) => deepseekAccount.reportBalance(insufficient),
        quota: () => deepseekAccount.quota(),
        ...(options.deepseekAccount?.fetch === undefined
          ? {}
          : { fetch: options.deepseekAccount.fetch }),
      },
    })

    /**
     * 跟随公司默认（52 O3）时，运行时与聊天车道要用的是**公司那一份**网关。
     *
     * 转发而不是复制：复制一份配置就会有两份漂移，而"跟随"的意思正是没有第二份。
     * 公司默认品牌本身永远不跟随任何人（`inheritsOrg` 恒 false），不会绕成环。
     */
    const effectiveGateway = (): ModelGatewayApi =>
      brands?.inheritsOrg(ws) === true
        ? (brands.peek(orgDefaultBrandOf(ws))?.ownGateway ?? ownGateway)
        : ownGateway
    const effectiveModels = (): ModelsAssembly =>
      brands?.inheritsOrg(ws) === true
        ? (brands.peek(orgDefaultBrandOf(ws))?.ownModels ?? ownModels)
        : ownModels
    /*
     * WP215：跟随公司默认时借的是公司默认那一个网关（它挂的是那个品牌的急停）——
     * 这里先按**这个品牌**的急停判一次：B 按了急停，B 的运行与聊天就打不出模型，A 照常。
     */
    const assertModelOpen = (): void => {
      if (brandHalt.isHalted('model'))
        throw new GatewayError('halted', 'model calls halted', { by: 'halt', scope: 'model' })
    }
    const gatewayProxy: ModelGatewayApi = {
      complete: async (req) => {
        assertModelOpen()
        return effectiveGateway().complete(req)
      },
      transcribe: async (req, meta, model) => {
        assertModelOpen()
        return effectiveGateway().transcribe(req, meta, model)
      },
      usage: (filter) => effectiveGateway().usage(filter),
      records: () => effectiveGateway().records(),
      // WP179：官方网页搜索不经网关，补记那一笔也记在跟随的那一份账上
      recordExternal: (input) => effectiveGateway().recordExternal?.(input),
      reconfigure: (next) => {
        effectiveGateway().reconfigure(next)
      },
      providers: () => effectiveGateway().providers(),
      budget: (filter) => effectiveGateway().budget(filter),
      embed: async (req, meta) => {
        assertModelOpen()
        return effectiveGateway().embed(req, meta)
      },
    }

    // 17 §4：换运行时只换这一处。`startRun: false` = 这个进程不跑运行时（老行为）。
    const runtime: RuntimeAssembly | undefined =
      options.startRun === false || typeof options.startRun === 'function'
        ? undefined
        : createRuntime({
            workspace_id: ws,
            // WP236：「设置 → 通用」的运行时长线（每次运行现读；职责阈值优先）
            runLimits: () => runLimitsSettings.get(),
            /*
             * WP251（决策 91）：工具回「没连上 / 缺凭据」时说清缺哪个——这条职责还没连上的连接
             * （必需的在前；必需的都连上了才列可选的）。连接目录按品牌装好之后才有，没有就不说。
             */
            missingConnections: (role_id) => {
              const gaps = (directoryAssemblies.get(ws)?.roleGaps([role_id]) ?? []).filter(
                (g) => !g.connected,
              )
              const required = gaps.filter((g) => g.required)
              return (required.length > 0 ? required : gaps).map((g) => g.name.zh)
            },
            // WP194：运行里打云的数据接口带上「谁 / 哪个岗位」
            aroundRun: (actor, fn) =>
              withCloudAttribution(cloudAttributionOf(actor.assignment_id, actor.role_id), fn),
            clock,
            random,
            env,
            models: gatewayProxy,
            approvals,
            // WP232：边界选择题已经有一张在等人答就指给它（不 bump、不改挂到别的事项上）
            activeApproval: (dedupe_key, kind) =>
              txn.runtime.store
                .listApprovals({
                  workspace_id: ws,
                  kind,
                  dedupe_key,
                  state: ['pending', 'in_review', 'deferred'],
                })
                .at(-1),
            roles,
            appendEvent,
            // WP25：有没有模型问模型面（加密库里的配置 + 环境变量兜底）
            hasModel: () => effectiveModels().configured(),
            modelRef: () => effectiveModels().defaultRef(),
            // WP150：这次运行的模型请求会落到哪条来源（登出 DeepSeek 账号前据此认出在用账号跑的事）
            runModelRef: () => effectiveModels().purposeRef('run'),
            // WP147：默认模型验证过能看图，浏览器 / 电脑操控的截图才进模型
            modelVision: () => effectiveModels().visionStatus(),
            // WP29：解析后的技能正文进 prompt——采纳过的 overlay 下一次运行就生效
            skills: skills.registry,
            ...(devMcp === undefined
              ? {}
              : {
                  devTools: {
                    toolNames: devMcpToolNames,
                    call: (name: string, input: Record<string, unknown>) =>
                      devMcp.call(name, input),
                  },
                }),
            source: records,
            /*
             * WP117（66 断点 #1）：红人那十一个工具。
             *
             * `kolService` 在这几百行之前就建好了（记录源要读它），所以这里直接取；
             * 取值函数留着是为了「装配顺序换了也不崩」——它只在真调工具那一刻查。
             */
            kolTools: createKolToolExecutor({
              workspace_id: ws,
              port: () => kolService.port,
              now: () => clock.now(),
            }),
            /*
             * WP220（Luoye 10-05）：只读 Reddit。两路：接口中台（这个品牌的数据能力口）→ 浏览器只读。
             * 顺序、停用、限速每次取数现读这个品牌的设置。浏览器只读那一路 WP228 接上本机只读浏览器
             * （单独的只读会话）；没装（测试 / 模拟 / 演示）就照实「没配」，不拿 Agent 的浏览器凑。
             */
            researchTools: chainResearchTools(
              createResearchToolExecutor({
                route: () => ownCloud.redditReadRoute(),
                limits: () => ownCloud.redditBrowserReadLimits(),
                callData: (capability, input) =>
                  createDataService(ownCloud).call(capability, { input }),
                // WP228：浏览器只读那一路接上本机只读浏览器（单独的只读会话）；限速与它同一本账
                ...(readonlyBrowser === undefined
                  ? {}
                  : {
                      // WP246：只有读号登录好、而且不是品牌登记的号时才读
                      browser: () => redditReadBrowserOf(readonlyBrowser, readAccount),
                      limiter: redditReadLimiterOf(readonlyBrowser),
                    }),
                nowMs: () => Date.parse(clock.now()),
                /*
                 * WP236 ⑨：每次运行的取数积分预算（职责阈值 `data_credits_per_run`，缺省 3）；
                 * 按价目表把条数收进剩下的预算（取不到价就不收，只按实花的记账）。
                 */
                creditBudget: (req) =>
                  resolveDataCreditBudget(roles.roles.get(req.actor.role_id)?.thresholds),
                priceOf: async (capability) => (await ownCloud.priceOf(capability))?.credits,
              }),
              // WP246：YouTube 字幕、网页转文字（零配置那一级；体检小账一起记）
              readRoutes.tools,
            ),
            // WP237（#67）：read_reddit 的描述里写现价（价目表现查；三项单价不一样或取不到就不写数）
            toolPrice: (tool) => redditReadPrice(tool, (c) => ownCloud.priceOf(c)),
            /*
             * WP153（09-26 真账号冒烟 §3）：店主的「列岗位 / 列连接」两个只读工具。
             *
             * 数据来自现成的两份装配：岗位读制度面（`org.port.positions`，与「岗位」页同一份），
             * 连接读这个品牌的连接目录（`directoryPortFor` 懒建，与连接页同一份）。
             * 两样都比运行时晚建——取值函数只在真调工具那一刻才碰它们。
             */
            ownerTools: createOwnerToolExecutor({
              positions: async (actor) =>
                org.port.positions({
                  workspace_id: workspace.id,
                  person_id: actor.person_id,
                  assignment_id: actor.assignment_id,
                  role_id: actor.role_id,
                }),
              directory: async () => {
                await directoryPortFor(ws)
                return directoryAssemblies.get(ws)?.directory()
              },
              gaps: async (role_ids) => {
                await directoryPortFor(ws)
                return directoryAssemblies.get(ws)?.roleGaps(role_ids)
              },
              activeRoleIds: () =>
                roles.roles
                  .list()
                  .map((r) => r.id)
                  .filter((id) =>
                    roles.assignments
                      .listByRole(id, { workspace_id: ws })
                      .some((a) => a.revoked_at === undefined),
                  ),
            }),
            /*
             * WP176：主动开发的三个开发信工具（列序列 / 开一轮 / 分回信），落到与「主动开发」界面
             * 同一份装配上。开发信装配比运行时晚建——取值函数只在真调工具那一刻才碰它。
             */
            b2bOutboundTools: createB2bOutboundToolExecutor({
              workspace_id: ws,
              port: () => b2bOutboundLate.current?.port,
            }),
            /*
             * WP253：网页模板的九个受限主题工具（起底 / 列 / 拉 / 检查 / 看改文件 / 推未发布 / 发布出卡）。
             * 主题工坊按品牌懒建——取值函数只在真调工具那一刻才碰它。
             */
            themeTools: createThemeToolExecutor({ module: () => siteThemeOf(ws) }),
            /*
             * WP261：独立站运营工具（查询 / 出卡）。工具面按「职责表 × 店铺授权里的权限」每次运行现问；
             * 店铺授权与运营按品牌懒建——取值函数只在真用到那一刻才碰它。
             */
            shopTools: createShopToolSurface({ module: () => shopOf(ws) }),
            // WP268：生图 / 改图 / 素材库（设计岗五条 + 网页模板；生图配了才摆）
            imageTools: imageService,
            vertical: () => brandProfileOf(ws).vertical,
            // WP216：平台专属的官方技能 / Dev MCP 工具只给平台对得上的品牌（每次现取档案）
            storefrontPlatform: () => brandPlatformOf(ws),
            // WP180：公司时区（工作区档案的 tz，每次现取）——每次运行的上下文里写一次「现在时间 + 公司时区」
            timeZone: async () => (await identity.getWorkspace(ws))?.tz,
            // WP181：官方「自动化任务」的四个工具（装了那个官方插件才挂；执行器是进程那一份）
            automation,
            // WP82：这台机器配了浏览器才有；配没配由设置页说了算，改了不用重启
            browser: () => browserSettings.forRun(),
            // WP144：电脑操控（三层开关的前两层 + 批过的授权；设置页改了下一次运行就生效）
            computerUse,
            /*
             * WP179（Luoye 09-29「官方功能优先」）：官方网页搜索与抓网页。
             *
             * 搜索凭据照官方：**DeepSeek 账号登录优先**（`deepseekAccount.resolveToken`，只对官方推理源给值），
             * 其次**用户自己的 DeepSeek 官方 key**（模型设置里那张卡，现取）。数据接口路由里 `web.search`
             * 那一级（「用你的 DeepSeek 账号搜索」）被用户关了就不给搜索；抓网页不要凭据，职责挂了就给。
             * 三样都每次现问：登录 / 登出、改设置，下一次运行就生效。
             */
            web: {
              searchEnabled: () => !ownCloud.webSearchRoute().disabled.includes('deepseek_native'),
              credentialKind: () =>
                deepseekAccount.signedIn()
                  ? 'deepseek_account'
                  : effectiveModels().hasDeepseekSearchKey()
                    ? 'deepseek_api_key'
                    : undefined,
              credential: async (endpoint: string) => {
                if (deepseekAccount.signedIn()) {
                  const token = await deepseekAccount.resolveToken(endpoint)
                  if (token !== undefined && token !== '') return { kind: 'account', token }
                }
                const key = effectiveModels().deepseekSearchKey()
                return key === undefined ? undefined : { kind: 'api_key', key }
              },
            },
            /*
             * WP86（55 §4 第三层）：这条职责登记了哪几台 MCP 服务器。
             *
             * 目录装配是按品牌懒建的（`directoryPortFor`），而这里要的是**同步**回答
             * ——`buildRequest` 那一跳不等 IO。所以只读已经建好的那一份：这个品牌的
             * 连接页开过一次（或跑过一次目录接口）之后就有；没有就是空数组，
             * 与"这条职责一台 MCP 服务器都没登记"同一个结果。
             */
            connections: (role_id) => directoryAssemblies.get(ws)?.roleConnections(role_id) ?? [],
            /*
             * WP125（72 §P0-1 / §P0-2）：每一份出站草稿在建卡之前过判断层——
             * 先泄漏守卫（商家教 AI 的那句中文有没有被逐字抄进客户会看到的正文），
             * 再三道自主门。判断层还没装好（装配期）就是 `undefined`：老行为。
             */
            judgeDraft: (input) =>
              supportJudgmentRef?.judgeDraft({
                channel: input.channel,
                thread_id: input.thread_external_id ?? input.matter.id,
                inbound_text: input.inbound_text,
                reply_text: input.body,
                generated_by: 'ai',
              }),
            /*
             * WP120（69 §3）：**角色定位的那几段**（品牌 → 岗位 → 职责）。
             *
             * 三个运行时共用这一个口：排序、空段不出、语言、公司层覆盖全在里面。
             * 公司在右栏改写了某条 persona，下一次运行就是新的那一份——
             * `personas` 每次现查覆盖表，不用重启（同 `vertical` / `browser`）。
             */
            // WP248：带上这个品牌（品牌上下文按品牌取）
            personaSections: (input) => personas.sections({ ...input, workspace_id: ws }),
            /*
             * WP122b（71 §9 第 7 条）：三个注入口通电——建站 / 社媒 / 投放出活时
             * 提示词里真带上品牌令牌。照 `design.ts` 的样板：取值口 + 现取
             * （每次运行都重新问 `brandDesignRef`，用户改一格下一次运行就生效）。
             * 出图那条路已在 `design.ts` 逐图注入（WP122），这里只补另外三条。
             */
            brandDesign: (role_id) => brandDesignSectionOf(ws, role_id),
          })
    const baseStartRun =
      typeof options.startRun === 'function' ? options.startRun : runtime?.startRun
    /*
     * WP264（决策 177）：事项**短标题**——这件事第一次开跑时，便宜模型（`extraction` 档）单独起一个
     * 中文 16 字左右的标题；没接真模型 / 起不出就退回原话前 20 字。与运行并行、不阻塞；人改过的不覆盖。
     * 用量记在这次运行那条分配上。工作模型下面才建出来：晚绑定。
     */
    const titler = createMatterTitler({
      work: () => workRef,
      complete: () => {
        const models = effectiveModels()
        if (!models.configured()) return undefined
        const ref = models.purposeRef('extraction')
        if (ref.provider === 'stub') return undefined
        return async (prompt, actor) => {
          let role_id = 'common.member'
          try {
            role_id = roles.effectiveConfig(actor.assignment_id).role_id
          } catch {
            // 分配撤了：用量照记在这条分配上，职责记成普通成员
          }
          const completion = await gatewayProxy.complete({
            messages: [{ role: 'user', content: prompt }],
            meta: {
              workspace_id: ws,
              assignment_id: actor.assignment_id as never,
              role_id: role_id as never,
              run_id: `matter_title_${Date.parse(clock.now()).toString(36)}` as never,
              purpose: 'extraction',
            },
            model: ref,
            max_output_tokens: 60,
            thinking: 'off',
          })
          return completion.text
        }
      },
    })
    const startRun: StartRun | undefined =
      baseStartRun === undefined
        ? undefined
        : (input) => {
            void titler.kick({ matter: input.matter, brief: input.brief, actor: input.actor })
            return baseStartRun(input)
          }

    /**
     * 37 工作模型。**一个品牌一个** `Work`，但共用同一个 SQLite 库——
     * `Work` 把自己那个 `workspace_id` 钉在每一次查询上（`listMatters` 等），
     * 所以两个品牌的事项、待办、目标、计划、复盘从一开始就不在同一批行里。
     */
    const work = createWork({
      workspace_id: ws,
      clock,
      random,
      tz_offset_minutes: workData.tz_offset_minutes,
      ...(workStore === undefined ? {} : { store: workStore }),
      ...(startRun === undefined ? {} : { startRun }),
      // WP35：待办 / 事项变化发一条摘要进同一条事件日志
      emit: appendEvent,
    })
    runtime?.bind(work)
    /**
     * WP154「内容与搜索」：这个品牌的 SEO / GEO 那一层。
     *
     * 两个口都是注入的：Search Console（demo / 测试给替身；不给就按连接状态说"没连"或
     * "读数还没接"）与搜索数据接口（WP155；不给就是"还没接"，SERP 与 GEO 跳过）。
     * 定时那一轮用真持有「内容与搜索」的那条分配去提，没人持有就不跑。
     */
    // WP159（Fable 追加）：好几个人持有同一条职责时非店主优先、再按最早分到的（规则见 pickRoleHolder）
    const holderOf = (role_id: string) => {
      const a = pickRoleHolder(roles.assignments.listByRole(role_id), ws, (person_id) =>
        roles.assignments
          .listByPerson(person_id, { workspace_id: ws, role_id: 'common.owner' })
          .some((x) => x.revoked_at === undefined),
      )
      return a === undefined
        ? undefined
        : { workspace_id: ws, person_id: a.person_id, assignment_id: a.id, role_id: a.role_id }
    }
    /*
     * WP166：店铺（Shopify）连上以后，按店里配的市场 / 配送区域把目标市场校正一次（人改过的不动），
     * 改了什么写进档案的出处里（界面上可见）。每条店铺连接只校正一次；读不到下次连接变化再试。
     */
    const storeMarkets = createStoreMarketsSync({
      connect: connections.connect as never,
      connection: () =>
        connections
          .liveConnections()
          .find((c) => c.service.startsWith('shopify') && c.status === 'active'),
      current: () => onboardingRef?.brandProfile(ws) ?? {},
      apply: (markets, source) => onboardingRef?.setMarkets(ws, markets, source) ?? false,
      now: () => clock.now(),
      ...(dir === undefined ? {} : { dir }),
      // WP169：真改了才推（没改不推）；只推给工作区所有者
      onChanged: async ({ markets, source }) => {
        if (source.note === undefined) return
        const owner = (await identity.getWorkspace(ws))?.owner_id
        if (owner === undefined) return
        const position = roles.assignments
          .listByPerson(owner, { workspace_id: ws, role_id: 'common.owner' })
          .find((a) => a.revoked_at === undefined)
        storeMarketsNotices.push({
          id: `mkt_notice_${source.at.replace(/[^0-9]/g, '')}`,
          note: source.note,
          markets,
          at: source.at,
          owner,
          position_id: position?.id ?? '',
        })
        appendEvent({
          schema_version: 1,
          workspace_id: ws,
          type: 'notification.sent',
          actor: { kind: 'agent', id: 'markets_store' },
          correlation: { trace_id: `tr_markets_${source.at}` },
          payload: {
            reason: 'markets_store_sync',
            recipient: owner,
            note: source.note,
            open_path: MARKETS_SETTINGS_PATH,
          },
        })
      },
    })
    connections.onConnectionChange(() => {
      void storeMarkets.check()
    })
    /*
     * WP159 / WP169：内容与搜索用的模型口（写初稿、翻买家问题）——这个品牌的模型网关，用量照常记账。
     * **每次现取**：模型设置改完下一轮就生效；只有 stub（没接模型）→ undefined。
     */
    const seoModel = (
      actor: { assignment_id: string; role_id: string },
      run_id: string,
    ): ((input: { prompt: string }) => Promise<{ text: string }>) | undefined => {
      if (!effectiveModels().configured()) return undefined
      const ref = effectiveModels().purposeRef('run')
      if (ref.provider === 'stub') return undefined
      return async ({ prompt }) => {
        const completion = await gatewayProxy.complete({
          messages: [{ role: 'user', content: prompt }],
          meta: {
            workspace_id: ws,
            assignment_id: actor.assignment_id as never,
            role_id: actor.role_id as never,
            run_id: run_id as never,
            purpose: 'run',
          },
          model: ref,
        })
        return { text: completion.text }
      }
    }
    const seoService = createSeoService({
      workspace_id: ws,
      routeScopeManager,
      clock,
      random,
      approvals,
      ledger: txn.ledger,
      actionOf: (assignment_id, action) => {
        try {
          const config = roles.effectiveConfig(assignment_id)
          return {
            mandate: config.actions.find((a) => a.id === action)?.mandate ?? { caps: {} },
            level: config.automation[action]?.level ?? 'L1',
          }
        } catch {
          return { mandate: { caps: {} }, level: 'L1' }
        }
      },
      holderOf,
      thresholds: () => roles.roles.get('dtc.content')?.thresholds ?? {},
      work: {
        createMatter: (input) => work.createMatter(input),
      },
      // WP158：连上了就是真读数（`google-reads.ts`）；注入的模拟世界里「连着」却没有真连接的，
      // 照旧说"读数那一步还没接"
      searchConsole: (): SearchConsolePort => {
        const injectedPort = options.searchConsoleFor?.(ws)
        if (injectedPort !== undefined) return injectedPort
        const real = googleReads.searchConsole()
        if (real.connected()) return real
        return workData.sources().some((s) => s.id === 'gsc' && s.connected)
          ? pendingSearchConsole()
          : disconnectedSearchConsole()
      },
      ga4: () => googleReads.ga4Conversions(),
      ga4Note: () => googleReads.ga4Note(),
      // WP155：这个品牌的搜索数据接口（官方 / 自带 key / 不接）；测试与 demo 可以换替身
      searchData: () => options.searchDataFor?.(ws) ?? searchData,
      orders: () => {
        const since = Date.parse(clock.now()) - 7 * 86_400_000
        return workData
          .orders()
          .filter((o) => Date.parse(o.created_at) >= since)
          .map((o) => ({
            id: o.id,
            ...(o.landing_site === undefined ? {} : { landing_site: o.landing_site }),
            total: o.full_total_price ?? o.total_price,
            currency: o.currency,
          }))
      },
      brand: async () => {
        const w = await identity.getWorkspace(ws)
        const domain = w?.profile?.domain?.trim()
        return {
          name: w?.brand?.name ?? w?.name ?? ws,
          language: 'en' as const,
          domains: domain === undefined || domain === '' ? [] : [domain],
          shop_host: domain === undefined || domain === '' ? 'shop.invalid' : domain,
          currency: w?.base_currency ?? workData.base_currency,
          country: 'us',
          // WP159：品牌分析确认时写进档案的目标市场（违规宣称规则按它开市场组）
          ...(() => {
            const markets = onboardingRef?.brandProfile(ws).markets
            return markets === undefined ? {} : { markets }
          })(),
          // WP169：档案里按市场覆盖的探测语言（没覆盖过就按每个市场的第一语言）
          ...(() => {
            const market_languages = onboardingRef?.brandProfile(ws).market_languages
            return market_languages === undefined ? {} : { market_languages }
          })(),
        }
      },
      knowledge: async (actor) => {
        const config = roles.effectiveConfig(actor.assignment_id)
        const cards = await knowledge.store.list(
          { workspace_id: ws, status: 'active' },
          {
            person_id: actor.person_id,
            workspace_id: ws,
            assignment_id: actor.assignment_id,
            role_id: actor.role_id,
            grants: config.scopes,
            ranges: config.ranges,
          },
        )
        const rules = cards.flatMap((c) => {
          const r = ruleFromFact(c)
          return r === undefined ? [] : [r]
        })
        // WP159：规则卡原样交给 seo-service，按市场分组合成（同 key 后改的赢）
        const rule_cards = cards
          .filter((c) => c.subject.type === 'content_rule')
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
          .map((c) => ({
            id: c.id,
            subject: c.subject,
            statement: c.statement,
            ...(c.structured === undefined ? {} : { structured: c.structured }),
          }))
        const facts = cards
          .filter((c) => c.subject.type !== 'content_rule')
          .map((c) => {
            const extra = c.structured?.terms
            return {
              id: c.id,
              statement: c.statement,
              terms: [
                ...c.subject.key.split(/[._\-\s]+/).filter((t) => t.length > 3),
                ...(Array.isArray(extra)
                  ? extra.filter((t): t is string => typeof t === 'string')
                  : []),
              ],
            }
          })
        return { facts, rules, rule_cards }
      },
      /*
       * WP159：在知识库里改 / 关 / 加一条违规宣称规则——人自己在知识库页上动的，直接生效
       * （提一张卡 → 由这个人激活），同 key 的旧卡退役（留痕，不删）。
       */
      saveClaimRule: async (actor, input) => {
        const config = roles.effectiveConfig(actor.assignment_id)
        const retrieval = {
          person_id: actor.person_id,
          workspace_id: ws,
          assignment_id: actor.assignment_id,
          role_id: actor.role_id,
          grants: config.scopes,
          ranges: config.ranges,
        }
        const old = (
          await knowledge.store.list({ workspace_id: ws, status: 'active' }, retrieval)
        ).filter((c) => c.subject.type === 'content_rule' && c.subject.key === input.key)
        const card = await knowledge.store.propose(
          claimRuleCard({ workspace_id: ws, owner: actor.person_id, at: clock.now(), ...input }),
        )
        await knowledge.store.activate(card.id, actor.person_id)
        for (const c of old) await knowledge.store.retire(c.id, actor.person_id)
      },
      /*
       * WP159：改动卡初稿由模型写（这个品牌的模型网关，用量照常记账；每天上限在 seo-service）。
       * **每次现取**：模型设置改完下一轮就生效；只有 stub（没接模型）→ undefined，用规则版。
       */
      drafter: ({ actor, run_id }) => seoModel(actor, run_id),
      /*
       * WP169：把买家问题翻成市场语言（同一个模型口；翻过的在 seo-service 里缓存，每个问题每种
       * 语言只翻一次）。没配模型 → undefined，按原语言问、面板注明。
       */
      translator: ({ actor, run_id }) => seoModel(actor, run_id),
      /*
       * WP166：模型写初稿前读这一页正文——店铺连接的只读口优先，读不到再抓公开网址（品牌分析那一口
       * 抓取，只抓自家域名）。
       */
      pageBody: createPageBodyReader({
        connect: connections.connect as never,
        connection: () =>
          connections
            .liveConnections()
            .find((c) => c.service.startsWith('shopify') && c.status === 'active'),
        fetch: options.brandIntakeFetch ?? (globalThis.fetch as never),
      }),
      // WP159：品牌口吻——品牌档案那一段 + 品牌设计规范（WP122）里的「气质」一句，取不到就不写
      brandVoice: async (language) => {
        const w = await identity.getWorkspace(ws)
        const name = w?.brand?.name ?? w?.name
        const markets = onboardingRef?.brandProfile(ws).markets
        const context = renderBrandContext(
          {
            ...(name === undefined ? {} : { brand_name: name }),
            ...(markets === undefined ? {} : { markets }),
            // WP248（决策 83）：品牌档案三格
            ...brandFactsContextOf(ws),
          },
          language,
        )
        const voice = brandDesignRef?.profileOf(ws)?.voice?.value
        return {
          ...(context === '' ? {} : { context }),
          ...(voice === undefined || voice.trim() === '' ? {} : { voice }),
        }
      },
      appendEvent,
      ...(dir === undefined ? {} : { dir }),
    })
    /*
     * WP69（54 §1 / §3）岗位面：与这个品牌的 `Work` 绑在一起建（事项与 Run 都落在它里面）。
     *
     * 岗位模板、职责定义、分配表是**制度层**的，跨品牌共用一份——所以 `positions` 与
     * `memorySummary` 都写成现查的闭包：制度层（`org`）与学习回路（`learning`）比
     * 品牌容器晚一步装好，第一次真被调用时它们早就在了。
     */
    const positionsAssembly = createPositions({
      workspace_id: ws,
      clock,
      roles,
      work,
      approvals,
      positions: () => org.positions(),
      cards: (person_id) =>
        approvals.queue({
          workspace_id: ws,
          person_id,
          lane: 'mine',
          state: [...QUEUE_STATES],
        }) as Promise<ApprovalItem[]>,
      // 54 §3：岗位层记忆一句话（这一层攒下几段、其中几段是学来的）
      memorySummary: (position_id) =>
        learning.memorySummary({ tier: 'position', scope_id: position_id }),
      // WP234（docs/54 §6.1）：一条分配安放在哪个岗位（制度层那张表，跨品牌共用一份）
      placementOf: (assignment_id) => org.placementOf(assignment_id),
      appendEvent,
      // WP237：「换成 X」重跑之前先停掉这件事上还在跑的那次（取消原因 user，原因进时间线）
      stopRuns: async (matter_id, reason) => {
        let stopped = 0
        for (const r of runtime?.activeRuns() ?? [])
          if (r.matter_id === matter_id && (await runtime?.stopRun(r.run_id, reason, 5_000)))
            stopped += 1
        return stopped
      },
      // WP241（docs/54 §7）：岗位页「工作」里的定时与排期（这个品牌自己那一份）
      // 系统例行（每日计划、复盘、巡检…处理器是工作台自己的那几个）不算岗位在做的事，不进工作
      schedules: async (person_id) =>
        (await schedule.scheduler.list({ workspace_id: ws, owner: person_id })).filter(
          (t) =>
            t.handler === undefined ||
            !(Object.values(SCHEDULE_HANDLERS) as string[]).includes(t.handler),
        ),
      socialPosts: () => social.posts(),
      // WP244：工作里开着的事项按最近那一轮运行分组（在跑 / 答完了 / 卡住了）
      runningMatters: () => new Set((runtime?.activeRuns() ?? []).map((r) => r.matter_id)),
      // WP244：卡住了说缺什么——这条职责还缺的必需连接（连接目录按品牌装好之后才有）
      missingConnections: (role_id) =>
        (directoryAssemblies.get(ws)?.roleGaps([role_id]) ?? [])
          .filter((g) => g.required && !g.connected)
          .map((g) => g.name.zh),
      // WP251（决策 91）：结构化标记从这一版第一次启动起算（之前的老数据才认 AI 末句）
      runBlockMarkedSince: () => onboardingRef?.since(RUN_BLOCK_MARKED_SINCE),
    })
    positionAssemblies.set(ws, positionsAssembly)
    // 六层技能里的 `position` 那一层、以及岗位层上下文那三样，都从这里来
    runtime?.bindPositions({
      positionOf: (role_id, assignment_id) => positionsAssembly.positionOf(role_id, assignment_id),
      layerContext: (position_id, person_id) =>
        positionsAssembly.layerContext(position_id, person_id) as Promise<
          Record<string, unknown> | undefined
        >,
    })
    // 记录源要从工作模型里认线程（`record({ type: 'thread' })`）；到这一步才有得认
    workRef = work

    /*
     * ── WP125（72 §1.I / §P0-1）：**客服判断层** ────────────────────────
     *
     * 72 的头号发现是：`support-core` 的 `draftReply` / `computeSla` /
     * `shouldEscalate` / `evaluateAutonomyGates` / `findUnansweredBoundary` /
     * `knowledgeCandidate` 在这个进程里的生产引用数是 **0**——真邮件走的是
     * 通用 Agent + 一份提示词技能，**没有门**。这一段把它们接上真路径。
     *
     * 位置在 `work` 之后、`channels` 之前：入站那一半要挂到渠道的 `judgeInbound` 上，
     * 出站那一半要挂到运行时的 `judgeDraft` 上（运行时上面已经建好，靠这个变量晚绑定）。
     */
    const supportJudgment = createSupportJudgment({
      workspace_id: ws,
      clock,
      appendEvent,
      approvals,
      position: () => firstPositionOf(ws),
      vertical: () => brandProfileOf(ws).vertical,
      // 落款：品牌名（模板草稿要它；没有就用一个中性的）
      signature: () => '客服团队',
      /*
       * 已答边界的真源在知识库里（**答案不另存一张表**，同下面 `boundaries` 那一段）。
       * 每次现查：商家刚在卡上答过一条，下一封信就该按新口径走，不该等重启。
       */
      policies: async () => {
        const position = firstPositionOf(ws)
        if (position === undefined) return []
        const config = roles.effectiveConfig(position.assignment_id)
        const cards = await knowledge.store.list(
          { workspace_id: ws, status: 'active' },
          {
            person_id: position.person_id,
            workspace_id: ws,
            assignment_id: position.assignment_id,
            role_id: position.role_id,
            grants: config.scopes,
            ranges: config.ranges,
          },
        )
        return detectAnsweredBoundaries({
          texts: cards.map((c) => c.statement),
          structured: cards.flatMap((c) => (c.structured === undefined ? [] : [c.structured])),
          at: clock.now(),
        })
      },
      /*
       * 泄漏守卫要商家教过的那几句。**只读不存**：从事项时间线上取人自己写的那几条
       * （`actor.kind === 'person'`），判断层不会把它们写进任何卡片、事件或日志。
       */
      instructions: (thread_id) => {
        const matter = work
          .listMatters({ kind: 'conversation' })
          .find((m) => m.context.pinned.some((p) => p.type === 'thread' && p.id === thread_id))
        if (matter === undefined) return []
        return work
          .matterView(matter.id, { limit: 50 })
          .timeline.filter((e) => e.actor.kind === 'person' && e.text.trim() !== '')
          .map((e) => e.text)
      },
      // 72 §P0-3：答不上来 → 落缺口 + 记一个等待者（按线程去重，零新表）
      gaps: {
        openGap: (input) => {
          const position = firstPositionOf(ws)
          if (position === undefined) return undefined
          return knowledge.intake.openGap({
            workspace_id: ws,
            question: input.question,
            subject: { type: 'policy', key: input.subject_key },
            asked_by: { kind: 'agent', id: position.assignment_id },
            ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
          }).id
        },
        addWaiter: (gap_id, waiter) => {
          knowledge.intake.addGapWaiter(gap_id, waiter)
        },
        getGap: (gap_id) => knowledge.intake.getGap(gap_id),
        answerGap: (gap_id, input) => {
          knowledge.intake.answerGap(gap_id, { answer: input.answer, by: input.by })
        },
      },
    })
    supportJudgmentRef = supportJudgment

    // ── 18 渠道：IMAP 轮询 + 入站管线 + 出站发信（39 待办 C）────────────
    // 位置有讲究：要在 connections（拿邮箱参数与口令来源）、work（入站落成事项）、
    // runtime（起 Run）之后。轮询由调度器驱动，而调度器是**共享**的——
    // 它每一拍把这个进程认识的每个品牌各跑一轮（见 `registerMailPoll` 那一段）。
    const channels = createChannels({
      clock,
      workspace_id: ws,
      appendEvent,
      halt: brandHalt,
      // 18 §2.1 第一条纪律：受控原始材料区加密。与会议档共用同一个密钥环，
      // **但不共用它的表**（35 §2）。漏了这一行，邮件原文就是明文落盘。
      cipher: data.keyring,
      // WP40：附件字节落对象存储；邮件原文是文本，照旧留库加密
      ...(blobs === undefined ? {} : { blobs }),
      accounts: () => connections.mailAccounts(),
      credentials: connections.credentialSource(),
      work,
      // WP163（docs/63 §D「挪信归谁」）：同一只邮箱下面的消息同步也在扫，而且它有分拣——
      // 挪信 / 标已读只归它。这一路只收信、落事项，一下都不动邮箱。
      mailbox_moves: 'message_sync',
      // WP167（docs/63 §D「收信一个入口」）：INBOX 也只由消息同步收——它先分拣，只有判成客服的信
      // 才经 `channels.intakeSupportMail` 递进这一路（开事项、判断层、起 Run）。
      inbox_intake: 'message_sync',
      // WP53 / 31 §3.3：发件人解析成线程台账里的那条联系人，并钉在事项上
      ...(records.contactOf === undefined
        ? {}
        : { resolveActor: (email: string) => records.contactOf?.(email) }),
      // 入站事项挂谁名下：本人在**这个品牌**里现在持有的第一条岗位。
      // 每次取一次，不缓存——岗位撤销 / 新增之后下一封信就落到对的地方。
      position: () => firstPositionOf(ws),
      // WP125（72 §P0-1）：落成事项之后、起 Run 之前，客服判断层先说话
      judgeInbound: async (input) => supportJudgmentRef?.judgeInbound(input),
      /**
       * WP55 / 48 §4 L3 #4：出站对账退避耗尽 → 一张人工卡。
       *
       * 复用 `policy_change` 而不是新造一个 kind：14 §1 的规矩是「新增 kind 必须能
       * 回答通过后施行什么」，而这张卡通过之后要施行的是**人的判断**（去客户那边
       * 确认收没收到、然后决定重发还是作罢），不是一个执行器。payload 里只有
       * outbox id 与次数，没有正文。
       */
      escalateUnresolvedDelivery: async (input) => {
        await approvals.create({
          workspace_id: ws,
          schema_version: 1,
          kind: 'policy_change',
          role_id: 'dtc.aftersales',
          proposer: { kind: 'agent', id: 'channel:outbox' },
          automation: { level_at_creation: 'L1' },
          priority: 'queue',
          routing: {
            recipients: [{ person: person.id, via: 'owner' }],
            rule: 'owner',
            escalation: {
              after_hours: 24,
              business_hours: true,
              chain: ['owner'],
              escalated_at: [],
            },
            separation_of_duties: false,
          },
          subject: { object: { type: 'outbox', id: input.outbox_id } },
          dedupe_key: `${ws}:outbox_unresolved:${input.outbox_id}`,
          title: '这封回信到底发出去没有，需要人确认一次',
          summary: `对账找了 ${input.attempts} 轮，已发送与归档文件夹里都没搜到它。系统**不会**自动重发（重发一封可能已经发出去的信，客户会收到两封）。请去客户那边确认一次，再决定重发还是作罢。`,
          payload: {
            form: 'outbox_unresolved',
            outbox_id: input.outbox_id,
            thread_ref: input.thread_ref,
            reconcile_attempts: input.attempts,
            ...(input.approval_item_id === undefined
              ? {}
              : { approval_item_id: input.approval_item_id }),
            ...(input.last_error === undefined ? {} : { last_error: input.last_error }),
          },
          evidence: {
            source_events: [],
            provenance: { seen: [] },
            precheck: {},
          },
        })
      },
      /*
       * WP210（Luoye 09-30）：失败的信系统自己按退避重投；**客户来信**投满几轮还不行，
       * 才给人一张卡（系统 / 营销通知只进日志）。Fable 09-30 定：卡上两个按钮——
       * 「再投一次」（批准 → `seoDecided` 那层把死信重投回队列，主按钮）与
       * 「去邮箱回复」（驳回 → 人自己回，工作台跳消息页）。
       */
      escalateDeadLetter: async (input) => {
        await approvals.create({
          workspace_id: ws,
          schema_version: 1,
          kind: 'inbound_dead_letter',
          role_id: 'dtc.support',
          proposer: { kind: 'agent', id: 'channel:inbound' },
          automation: { level_at_creation: 'L1' },
          priority: 'queue',
          routing: {
            recipients: [{ person: person.id, via: 'owner' }],
            rule: 'owner',
            escalation: {
              after_hours: 24,
              business_hours: true,
              chain: ['owner'],
              escalated_at: [],
            },
            separation_of_duties: false,
          },
          subject: { object: { type: 'message', id: input.dead_letter_id } },
          dedupe_key: `${ws}:inbound_dead_letter:${input.dead_letter_id}`,
          title: '有一封客户来信没能处理，请看一眼',
          summary: `${input.from === undefined ? '一位客户' : input.from} 的来信，系统自动重试了 ${input.rounds} 轮还是没处理成。可以再投一次；不想等就直接去邮箱回复这位客户。`,
          payload: {
            form: 'inbound_dead_letter',
            dead_letter_id: input.dead_letter_id,
            channel: input.channel,
            reason: input.reason,
            rounds: input.rounds,
            ...(input.from === undefined ? {} : { from: input.from }),
            ...(input.last_error === undefined ? {} : { last_error: input.last_error }),
          },
          evidence: {
            source_events: [],
            provenance: { seen: [] },
            precheck: {},
          },
        })
      },
      release: env.AGENTSWS_VERSION ?? '0.1.0',
      ...(dir === undefined ? {} : { dbDir: dir }),
      ...(startRun === undefined ? {} : { startRun }),
      ...(options.mailSource === undefined ? {} : { makeSource: options.mailSource }),
      ...(options.mailer === undefined ? {} : { makeMailer: options.mailer }),
    })
    // 连接页新增 / 断开邮箱 → 下一轮轮询就换成新的那一份，不必重启
    connections.onMailChange(() => {
      channels.refresh()
      // 邮箱连接变了，客服那几个数字块的前提也变了：让活数据源重新算一次连接状态
      liveData?.invalidate()
    })

    /*
     * WP57（48 §4 L3 #11 的本地部分）：在线聊天的实时车道。
     *
     * 位置有讲究：**必须在 channels 之后**——它共用那一个受控原始材料区、那一张队列、
     * 那一张去重表。两套区意味着 21 §4「删这个人」会漏掉一半，两张去重表意味着
     * 同一条消息从两处进来会产出两条事件。
     */
    // WP124：求助等待时长存在聊天窗设置里（chatWidget 在 chat 之后建，经这个盒子回读）
    const lateWidget: { current?: ReturnType<typeof createChatWidget> } = {}
    const chat = createChatLane({
      clock,
      workspace_id: ws,
      assistWaitSeconds: () => lateWidget.current?.config().assist_wait_seconds,
      appendEvent,
      halt: brandHalt,
      raw: channels.raw,
      work,
      approvals,
      models: gatewayProxy,
      // 同一套知识与订单只读：记录源就是运行时那一个
      source: records,
      searchKnowledge: async (text, limit) => {
        const position = firstPositionOf(ws)
        if (position === undefined) return []
        const config = roles.effectiveConfig(position.assignment_id)
        const { hits } = await knowledge.retrieval.search({
          text,
          k: limit,
          actor: {
            person_id: position.person_id,
            workspace_id: ws,
            assignment_id: position.assignment_id,
            role_id: position.role_id,
            grants: config.scopes,
            ranges: config.ranges,
          },
        })
        return hits.map((h) => ({ fact_card_id: h.fact_card_id, statement: h.statement_redacted }))
      },
      position: () => firstPositionOf(ws),
      ...(dir === undefined ? {} : { dbDir: dir }),
    })

    /*
     * WP113（63）：**消息**——把整只邮箱接进来。
     *
     * 位置有讲究：**必须在 channels 之后**——它要 `channels.raw`（与渠道共用同一个
     * 受控原始材料区：21 §4「删这个人」不许漏掉一半）与 `channels.sendMail`
     * （人自己按下发送的那一封走 outbox 七态 + 对账）。凭据仍然只从
     * `connections` 来，**这一层不新增任何凭据入口**。
     */
    /**
     * WP172（docs/84 §5）：邮件分拣之后 B2B 这一路——落成询盘 / 往来记录，B2B 岗位开着才开事项、
     * 起 Run（落在持「业务」那条职责的人名下）；退订与退信进抑制名单。挪信仍只归消息同步。
     */
    /**
     * WP173（docs/84 §2）：开发信序列——首封批量一张卡、跟进收尾按自动化级别；发信域名建议而不强制
     * （第一次开出一张选择卡），SPF / DKIM 没过不发；按发信邮箱、按自然日算配额（预热 20 → 50）；
     * 发出去的每一封记 `noteOutbound`（回信按它对线程、停序列）。
     */
    const lateMessages: { current?: MessagesAssembly } = {}
    const b2bOutbound = createB2bOutbound({
      workspace_id: ws,
      store: b2b,
      clock,
      random,
      timeZone: () => offsetToTz(workData.tz_offset_minutes),
      ledger: txn.ledger,
      approvals: txn.approvals,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      appendEvent,
      secrets: { get: (id) => (brandSecrets.available ? brandSecrets.get(id) : undefined) },
      mailboxes: () =>
        options.b2bStandIns?.mailboxes === undefined
          ? connections.mailAccounts().map((a) => a.address)
          : [...options.b2bStandIns.mailboxes],
      // 主域名：公司档案的域名；没填就把第一只接上的邮箱当主域名（宁可少认一只"单独域名"）
      primaryDomains: () => {
        const org = onboardingRef?.companyProfile(ws)?.domain?.trim()
        if (org !== undefined && org !== '') return [org]
        const first = options.b2bStandIns?.mailboxes?.[0] ?? connections.mailAccounts()[0]?.address
        return first === undefined ? [] : [first.slice(first.lastIndexOf('@') + 1)]
      },
      companyName: () => onboardingRef?.companyProfile(ws)?.legal_name ?? brandNameOfWorkspace(ws),
      sendMail: options.b2bStandIns?.sendMail ?? ((input) => channels.sendMail(input)),
      dns: options.b2bStandIns?.dns ?? {
        txt: async (name) => (await dnsPromises.resolveTxt(name)).map((chunks) => chunks.join('')),
      },
      outboundHolder: () => {
        const a = roles.assignments
          .listByWorkspace(ws)
          .find((x) => x.revoked_at === undefined && x.role_id === 'b2b.outbound')
        return a === undefined
          ? undefined
          : { person_id: a.person_id, assignment_id: a.id, role_id: a.role_id }
      },
      drafter: ({ assignment_id, role_id, run_id }) => seoModel({ assignment_id, role_id }, run_id),
      coldEmailSkill: () => {
        try {
          return readBundledSkill('cold-email').markdown
        } catch {
          return undefined
        }
      },
      // WP176：「不感兴趣」冷却天数（职责阈值，默认 90）
      declinedCooldownDays: () =>
        roles.roles.get('b2b.outbound')?.thresholds?.b2b_declined_cooldown_days,
      // WP176：公司实体地址的真源是公司档案（开发信页脚、报价单、单证同一份）
      companyAddress: () => onboardingRef?.brandProfile(ws).postal_address,
      saveCompanyAddress: (address) => onboardingRef?.setPostalAddress(ws, address) ?? false,
      // WP176：Run 里「把一封回信分类」按消息库 id 取正文（消息层在下面才建，懒取）
      message: async (id) => {
        const m = await lateMessages.current?.store.get(id)
        return m === undefined
          ? undefined
          : { subject: m.subject, text: m.text, headers: m.headers }
      },
    })
    b2bOutboundLate.current = b2bOutbound
    /**
     * WP182（docs/84 §3）：业务——询盘分级与首回卡（只引生效的 B2B 事实卡）、六类事实卡预填、
     * 报价单 PDF 与发给客户（也出卡）、样品往前走与超期提醒、离职交接卡。
     */
    const b2bFactActor = async () => {
      const a = roles.assignments
        .listByWorkspace(ws)
        .find((x) => x.revoked_at === undefined && x.role_id.startsWith('b2b.'))
      const person = a?.person_id ?? (await identity.getWorkspace(ws))?.owner_id
      if (person === undefined) return undefined
      const config = a === undefined ? undefined : roles.effectiveConfig(a.id)
      return {
        person_id: person,
        workspace_id: ws,
        assignment_id: a?.id ?? '',
        role_id: a?.role_id ?? '',
        grants: config?.scopes ?? [
          {
            domain: 'knowledge' as const,
            ops: ['read' as const],
            range: 'workspace' as const,
            max_sensitivity: 'internal' as const,
          },
        ],
        ranges: config?.ranges ?? [],
      }
    }
    const b2bSales = createB2bSales({
      workspace_id: ws,
      store: b2b,
      clock,
      random,
      ledger: txn.ledger,
      approvals: txn.approvals,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      appendEvent,
      service: b2bService,
      holders: () =>
        roles.assignments
          .listByWorkspace(ws)
          .filter((a) => a.revoked_at === undefined && a.role_id.startsWith('b2b.'))
          .map((a) => ({ person_id: a.person_id, assignment_id: a.id, role_id: a.role_id })),
      owner: async () => (await identity.getWorkspace(ws))?.owner_id,
      personName: async (id) => (await identity.getPerson(id))?.name,
      secrets: {
        get: (id) => (brandSecrets.available ? brandSecrets.get(id) : undefined),
        put: (id, fields) => {
          if (!brandSecrets.available)
            throw new ApiError('invalid_input', '本机加密库没开，存不了联系方式。')
          return brandSecrets.put(id, fields)
        },
      },
      // 询盘回信：发的那一刻按消息库那封信取发件人与 Message-ID（消息层在下面才建，懒取）
      messageOf: async (id) => {
        const m = await lateMessages.current?.store.get(id)
        return m === undefined
          ? undefined
          : {
              from: m.from.email,
              ...(m.message_id === undefined ? {} : { rfc_message_id: m.message_id }),
              references: m.references,
              account: m.account,
            }
      },
      factCards: async () => {
        const actor = await b2bFactActor()
        if (actor === undefined) return []
        const cards = await knowledge.store.list({ workspace_id: ws }, actor as never)
        return cards
          .filter((c) => c.subject.type === B2B_FACT_SUBJECT_TYPE)
          .map((c) => ({
            id: c.id,
            status: c.status,
            key: c.subject.key,
            statement: c.statement,
            ...(c.structured === undefined ? {} : { structured: c.structured }),
            ...(c.provenance[0]?.locator === undefined ? {} : { locator: c.provenance[0].locator }),
          }))
      },
      proposeFact: async (t, source_url) => {
        const owner = (await identity.getWorkspace(ws))?.owner_id
        if (owner === undefined)
          throw new ApiError('conflict', '这个工作区没有所有者，建不了事实卡。')
        const at = clock.now()
        const card = await knowledge.store.propose({
          schema_version: 1,
          workspace_id: ws,
          layer: 'fact',
          domain: 'company',
          scope: [],
          sensitivity: 'internal',
          subject: { type: B2B_FACT_SUBJECT_TYPE, id: t.category, key: t.key },
          statement: t.statement,
          structured: t.structured as unknown as Record<string, unknown>,
          provenance: [
            {
              source: source_url === undefined ? 'human' : 'web',
              ref: source_url ?? `b2b-fact-template:${t.category}`,
              locator: t.locator,
              quote: t.statement.slice(0, 200),
              at,
            },
          ],
          confidence: { value: 0.3, state: 'unverified' },
          valid: { from: at },
          owner,
          created_by: { kind: 'agent', id: 'b2b-facts-setup' },
        })
        return card.id
      },
      // 按官网判断行业：公司档案（名称、域名）+ 品牌分析建的商品卡
      industry: async () => {
        const org = onboardingRef?.companyProfile(ws)
        const actor = await b2bFactActor()
        const products =
          actor === undefined
            ? []
            : (await knowledge.store.list({ workspace_id: ws }, actor as never))
                .filter((c) => c.subject.type === 'product')
                .map((c) => c.statement)
        const corpus = [org?.legal_name, org?.domain, brandNameOfWorkspace(ws), ...products]
          .filter((x): x is string => typeof x === 'string' && x !== '')
          .join(' ')
        if (corpus.trim() === '') return undefined
        const guess = guessIndustry(corpus)
        const domain = org?.domain?.trim()
        return {
          ...guess,
          ...(domain === undefined || domain === '' ? {} : { website: `https://${domain}` }),
        }
      },
      inquirySkill: () => {
        try {
          return readBundledSkill('b2b-inquiry').markdown
        } catch {
          return undefined
        }
      },
      drafter: ({ assignment_id, role_id, run_id }) => seoModel({ assignment_id, role_id }, run_id),
      companyName: () => onboardingRef?.companyProfile(ws)?.legal_name ?? brandNameOfWorkspace(ws),
      companyAddress: () => onboardingRef?.brandProfile(ws).postal_address,
      companyWebsite: () => onboardingRef?.companyProfile(ws)?.domain,
      letterhead: () => b2bLetterheadOf(brandDesignRef?.profileOf(ws)),
      sendMail: options.b2bStandIns?.sendMail ?? ((input) => channels.sendMail(input)),
      ...(options.b2bStandIns?.sendWhatsApp === undefined
        ? {}
        : { sendWhatsApp: options.b2bStandIns.sendWhatsApp }),
      work,
    })
    const b2bMail = createB2bMail({
      workspace_id: ws,
      store: b2b,
      outbound: b2bOutbound,
      sales: b2bSales,
      clock,
      appendEvent,
      holders: () =>
        roles.assignments
          .listByWorkspace(ws)
          .filter((a) => a.revoked_at === undefined && a.role_id.startsWith('b2b.'))
          .map((a) => ({ person_id: a.person_id, assignment_id: a.id, role_id: a.role_id })),
      owner: async () => (await identity.getWorkspace(ws))?.owner_id,
      approvals: txn.approvals,
      work,
      ...(startRun === undefined ? {} : { startRun }),
    })
    const messages = createMessages({
      clock,
      workspace_id: ws,
      b2b: b2bMail,
      appendEvent,
      halt: brandHalt,
      accounts: () => connections.mailAccounts(),
      credentials: connections.credentialSource(),
      work,
      position: () => firstPositionOf(ws),
      // 岗位开没开每次现查：昨天开了今天关了，信就不该再往 KefuAgents 里挪
      activeRoles: () =>
        roles.assignments
          .listByWorkspace(ws)
          .filter((a) => a.revoked_at === undefined)
          .map((a) => a.role_id),
      models: gatewayProxy,
      rawStore: channels.raw,
      sendMail: (input) => channels.sendMail(input),
      searchKnowledge: async (text, limit) => {
        const position = firstPositionOf(ws)
        if (position === undefined) return []
        const config = roles.effectiveConfig(position.assignment_id)
        const { hits } = await knowledge.retrieval.search({
          text,
          k: limit,
          actor: {
            person_id: position.person_id,
            workspace_id: ws,
            assignment_id: position.assignment_id,
            role_id: position.role_id,
            grants: config.scopes,
            ranges: config.ranges,
          },
        })
        return hits.map((h) => ({
          source_id: h.fact_card_id,
          title: h.statement_redacted.slice(0, 40),
          text: h.statement_redacted,
        }))
      },
      // WP167（docs/63 §D「收信一个入口」）：分拣判成 `support` 的来信递进渠道的入站管线——
      // Amazon 子渠道判定、线程台账、去重、落事项、客服判断层（WP125）、起 Run 都在那一条里
      intakeSupport: (input) => channels.intakeSupportMail(input),
      // WP167 终审追加：升级那一拍把老版本已经处理过的信预写进台账（只做一次）
      seedSupportIntake: (marker, keys) => channels.seedSupportIntake(marker, keys),
      ...(dir === undefined ? {} : { dbDir: dir }),
      ...(options.messageSource === undefined ? {} : { makeSource: options.messageSource }),
      ...(options.messageWriter === undefined ? {} : { makeWriter: options.messageWriter }),
      ...(options.messageImages === undefined ? {} : { loadRemoteImage: options.messageImages }),
      /*
       * WP212（docs/88 §3.2）：「交给 X ▾」那一列——这个品牌里的岗位（与消息相关的五个常驻，
       * 别的岗位开着才列）；开没开按现查的分配算。客服 / 红人 / B2B 三个走 63 的老路。
       */
      positions: () => {
        const active = new Set(
          roles.assignments
            .listByWorkspace(ws)
            .filter((a) => a.revoked_at === undefined)
            .map((a) => a.role_id),
        )
        return (
          org
            .positions()
            .map((t) => {
              const route = routeOfPosition(t.id)
              return {
                id: t.id,
                name_zh: t.name.zh,
                name_en: t.name.en,
                open: t.roles.some((r) => active.has(r.role)),
                ...(route === undefined ? {} : { route }),
              }
            })
            // 负责人 / 普通成员这类通用岗位不接具体的事；与消息相关的五个排前面
            .filter(
              (p) =>
                (p.open || MESSAGE_POSITIONS.includes(p.id)) &&
                !org
                  .positions()
                  .find((t) => t.id === p.id)
                  ?.roles.every((r) => r.role.startsWith('common.')),
            )
            .sort(
              (a, b) =>
                rank(MESSAGE_POSITIONS.indexOf(a.id)) - rank(MESSAGE_POSITIONS.indexOf(b.id)),
            )
        )
      },
      // 其余岗位走 54 的「交给这个岗位一件事」：开事项（钉着这条会话）、岗位内路由、起 Run
      openAtPosition: async (input) => {
        const out = await positionsAssembly.open({
          position_id: input.position_id,
          person_id: input.person_id,
          title: input.title,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          pinned: [{ type: 'thread', id: input.thread_id }],
        })
        return { matter_id: out.matter.id }
      },
      // 「X 在办 · 有 N 张卡等你 →」：本人队列里的卡指着哪条会话 / 哪件事项（只报数）
      openCards: async () => {
        const who = firstPositionOf(ws)?.person_id ?? person.id
        const items = (await approvals.queue({
          workspace_id: ws,
          person_id: who,
          lane: 'mine',
          state: [...QUEUE_STATES],
        })) as ApprovalItem[]
        return items.map((item) => {
          const object = item.subject.object
          const thread =
            object.type === 'thread'
              ? object.id
              : item.evidence.provenance?.seen?.find((r) => r.type === 'thread')?.id
          const matter = item.subject.matter_id ?? item.subject.work_item_id
          return {
            ...(thread === undefined ? {} : { thread_id: thread }),
            ...(matter === undefined ? {} : { matter_id: matter }),
          }
        })
      },
      // 没勾「以后都这样」的改判进学习回路（24 §3 的 lesson 池；技能 `message-triage` 还没有可改的段落，
      // 所以只攒不提——「你教过它」里看得见）
      onCorrection: (c) => {
        const asg = firstPositionOf(ws)
        learning.learning.pool.pool({
          workspace_id: ws,
          assignment_id: asg?.assignment_id ?? 'asg_unknown',
          run_id: 'run_message_triage',
          applies_to: { skill: 'message-triage' },
          kind: 'rule',
          signal: 'redirect',
          strength: 'weak',
          text: `来自 ${c.sender_domain} 的这类信：${c.field === 'kind' ? '类型' : '岗位'}是「${c.to}」`,
          confidence: 0.3,
          evidence: [{ quote: `${c.from ?? '—'} → ${c.to}`, at: c.at }],
          semantic_key: `message_${c.field}:${c.sender_domain}:${c.to}`,
        })
      },
    })
    lateMessages.current = messages

    /*
     * WP124：转发器设置进本机加密库（与邮箱口令、模型 key 同一个库）；
     * 离线留言落「消息」页的 `source: 'chat'`——63 的扩展位只加这一格。
     */
    const RELAY_SECRET_ID = 'chat.relay'
    const relaySecret = (field: string): string | undefined => {
      if (!brandSecrets.available) return undefined
      try {
        const value = brandSecrets.get(RELAY_SECRET_ID)?.[field]
        return value === undefined || value === '' ? undefined : value
      } catch {
        return undefined
      }
    }
    const storeOfflineMessage = (message: OfflineMessageContent): void => {
      const account = 'chat'
      messages.store.put({
        id: `msg_chat_${message.left_at}_${Math.random().toString(36).slice(2, 8)}`,
        workspace_id: ws,
        source: 'chat',
        account,
        folder: 'INBOX',
        folder_kind: 'inbox',
        thread_id: `chat:${message.email}`,
        references: [],
        headers: {},
        from: { email: message.email },
        to: [{ email: account }],
        cc: [],
        bcc: [],
        subject: message.text.replace(/\s+/g, ' ').slice(0, 60),
        snippet: message.text.replace(/\s+/g, ' ').slice(0, 120),
        text: message.text,
        has_remote_images: false,
        attachments: [],
        date: message.left_at,
        received_at: message.left_at,
        flags: { read: false, starred: false, answered: false, draft: false },
        labels: [],
        route: 'inbox',
      })
      appendEvent({
        schema_version: 1,
        workspace_id: ws,
        type: 'inbound.recorded',
        actor: { kind: 'system', id: 'chat_relay_client' },
        correlation: { trace_id: `tr_relay_${clock.now()}` },
        payload: { source: 'chat', thread: `chat:${message.email}` },
      })
    }

    // WP60（48 §4 L3 #11 的云端一半）：聊天窗的公开访客面（白名单 + 限流 + 访客令牌）
    const chatWidget = createChatWidget({
      workspace_id: ws,
      clock,
      chat,
      secrets: brandSecrets,
      ...(dir === undefined ? {} : { dbDir: dir }),
    })
    lateWidget.current = chatWidget

    /*
     * WP124：本机 ↔ 转发器的那条外连。设置（转发器地址 / 配对密钥 / 留言密钥）
     * 进本机加密库（id `chat.relay`），没配就安静地不连——设置页会显示「未连接」。
     * 离线留言拉走后落「消息」页（source = 'chat'，63 的扩展位只加这一格）。
     */
    const relayClient = new ChatRelayClient({
      clock,
      workspace_id: ws,
      lane: chat,
      widget: chatWidget,
      endpoint: () => relaySecret('endpoint'),
      pairingToken: () => relaySecret('pairing_token'),
      messageKey: () => relaySecret('message_key'),
      // WP128：托管实例以 `hosted` 的身份外连（转发器优先转给它）
      ...(hostedBoot === undefined ? {} : { peer: 'hosted' as const }),
      onOfflineMessage: (message) => {
        storeOfflineMessage(message)
      },
      onEvent: (event) => {
        appendEvent({
          schema_version: 1,
          workspace_id: ws,
          type: 'channel.connected',
          actor: { kind: 'system', id: 'chat_relay_client' },
          correlation: { trace_id: `tr_relay_${clock.now()}` },
          payload: {
            relay: event.type,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
          },
        })
      },
    })
    relayClient.start()

    /*
     * WP117 交付 4：演练场。建在 `kolService` 与 `messages` 之后——它往同一个库里
     * 铺数据、把演练的出站截下来（硬闸在 `deliverOutbound` / `backendApply`），
     * 收到的回信还要归并进消息库（WP117b，63 那条链）。
     */
    const kolSandbox = createKolSandbox({
      store: kol,
      secrets: brandSecrets,
      clock,
      emit: (type, payload) => {
        appendEvent({
          schema_version: 1,
          workspace_id: ws,
          type,
          actor: { kind: 'system', id: 'kol_sandbox' },
          correlation: { trace_id: `tr_kolsbx_${clock.now()}` },
          payload,
        })
      },
      /*
       * WP117b（66 复测 #19 的留尾 2 / 断点 #9 的剩余）：**回信归并进「消息」。**
       *
       * 63 §4 那条链说的是：红人来信 → `route: 'kol'` → 挪进 `KOLAgents` 文件夹 →
       * 归并到合作线程。演练的回信以前只做了最后半步（落在合作上），
       * 「消息」页里一封都看不见，于是那个文件夹与合作永远互不相干。
       *
       * 这里补的就是前半步：同一封信也写进消息库，`route` / `folder` /
       * `folder_kind` 与真邮箱来的红人信**逐字相同**，`linked` 指回合作，
       * 界面上分不出它是演练来的——除了那一格 `sandbox` 标记。
       */
      onReply: ({ exchange, from, display_name }) => {
        // 内存档与 SQLite 档的 `accounts()` 都是同步的；真回了 Promise 就退到
        // 那只保留域的假邮箱（宁可归错文件夹，也不在这里 await 卡住时钟）
        const known = messages.store.accounts()
        const account = (Array.isArray(known) ? known[0] : undefined) ?? SANDBOX_MAILBOX
        const message_id = `<sbx-${exchange.id}@sandbox.example>`
        const summary = KOL_REPLY_SUMMARY[exchange.reply_class ?? 'unknown'] ?? '红人来信'
        messages.store.put({
          id: `msg_${exchange.id}`,
          workspace_id: ws,
          source: 'email',
          account,
          // WP161：与老产品同名的规范名（真邮箱上已有的大小写变体在消息页里按语义并在一起）
          folder: KOL_FOLDER,
          folder_kind: 'kol',
          thread_id: `<sbx-thread-${exchange.creator_id}@sandbox.example>`,
          message_id,
          references: [],
          headers: {},
          from: { email: from, name: display_name },
          to: [{ email: account }],
          cc: [],
          bcc: [],
          subject: exchange.subject,
          snippet: exchange.body.replace(/\s+/g, ' ').slice(0, 120),
          text: exchange.body,
          has_remote_images: false,
          attachments: [],
          date: exchange.at,
          received_at: exchange.at,
          flags: { read: false, starred: false, answered: false, draft: false },
          labels: ['partnership'],
          route: 'kol',
          ...(exchange.collaboration_id === undefined
            ? {}
            : { linked: { type: 'collaboration', id: exchange.collaboration_id } }),
          triage: {
            route: 'kol',
            labels: ['partnership'],
            // 退信不用回，别的都要人看一眼
            needs_reply: exchange.bounce_reason === undefined,
            priority: 'normal',
            summary,
            confidence: 0.95,
            by: 'rule',
            reasons: ['演练回信：合作线程上已有这条往来'],
            at: exchange.at,
          },
        })
        // 往来记录上记一句"它在消息库里是哪一条"，两边点得通
        kol.saveExchange({ ...exchange, message_id })
      },
    })

    return {
      workspace_id: ws,
      ...(dir === undefined ? {} : { dir }),
      secrets: brandSecrets,
      relay: {
        client: relayClient,
        secret: relaySecret,
        setSecrets: (fields) => {
          if (fields === null) {
            brandSecrets.remove(RELAY_SECRET_ID)
            return
          }
          if (brandSecrets.available) brandSecrets.put(RELAY_SECRET_ID, fields)
        },
        storeOffline: storeOfflineMessage,
        cloudStatus: () => ownCloud.relayCloudStatus(),
      },
      connections,
      ...(liveData === undefined ? {} : { liveData }),
      workData,
      records,
      kol,
      kolService,
      kolSandbox,
      kolPublic,
      searchData,
      pr,
      prService,
      b2b,
      b2bService,
      b2bOutbound,
      b2bSales,
      seoService,
      googleReads,
      social,
      socialService,
      socialChannels,
      design,
      designService,
      site,
      siteService,
      ads,
      adsService,
      // WP224：毛利率事实卡、本周经营一页纸、两条止损线对照
      economics,
      weeklyReview,
      lineCompareSnapshot,
      work,
      ...(runtime === undefined ? {} : { runtime }),
      ...(startRun === undefined ? {} : { startRun }),
      channels,
      messages,
      chat,
      chatWidget,
      supportJudgment,
      ownModels,
      ownGateway,
      ownCloud,
      ...(readonlyBrowser === undefined ? {} : { readonlyBrowser }),
      readRoutes,
      async dispose() {
        await chat.close()
        messages.close()
        await channels.close()
        liveData?.close()
        connections.close()
        kol.close()
        b2b.close()
        // 云端红人库的同步账本也握着一个句柄（WP118）：跟着这个品牌一起关
        ownCloud.kolSync?.close()
        // WP228：只读浏览器开着就关掉（按进程树结束，不留孤儿）
        await readonlyBrowser?.close()
        // WP249：官方号浏览器（登录窗口 / 无头那一个）一并关掉；登录态留在目录里
        socialService.ownSub?.close()
        socialService.executor.close()
        await redditOfficial?.close()
        // WP246：「登录读号」的窗口开着就体面地关掉
        await readRoutes.close()
        rosterSync.close()
        if (rosterSyncs.get(ws) === rosterSync) rosterSyncs.delete(ws)
        site.close()
        ads.close()
        pr.close()
      },
    }
  }

  /** 这个进程 bootstrap 出来的品牌所在那家公司下的全部品牌（没挂组织时就它自己）。 */
  const brandsOfThisOrg = (): WorkspaceId[] => {
    const org = identity
      .listOrganizations()
      .find((o) => identity.brandsOf(o.id).some((w) => w.id === workspace.id))
    return org === undefined ? [workspace.id] : identity.brandsOf(org.id).map((w) => w.id)
  }

  // WP154：选题卡批了 → 按卡片所属品牌开事项（品牌模块到这里才建得出来）
  seoDecidedHook.current = async (item) => {
    // WP268：挑图卡 / 超额卡被决定 → 记选中 / 传店铺挂主题 / 再来一版 / 照卡出图
    if (item.kind === 'image_pick' || item.kind === 'image_budget') {
      await brands?.forWorkspace(item.workspace_id)
      await imageServices.get(item.workspace_id)?.onDecided(item)
      return
    }
    // WP237：选择卡选了（或者老卡点了「认领」）→ 事项钉到那条职责、按原话起一次运行
    if (isRouteChoice(item)) return (await positionsFor(item.workspace_id)).onChoiceDecided(item)
    const brand = await brands?.forWorkspace(item.workspace_id)
    // WP173：「发信域名」那张选择卡选了 → 记下发信邮箱、体检、排着的首封往前推
    if (item.kind === B2B_SENDER_CHOICE_KIND) return brand?.b2bOutbound.onSenderChosen(item)
    // WP210：客户来信投不进的那张卡批了（「再投一次」）→ 把那条死信重投回队列；
    // 驳回（「去邮箱回复」）什么都不做——人自己回，死信留在「设置 → 诊断」里
    // WP249：自家版版务卡批了 → 过了取消窗口施行（读队列时也会补扫一遍）
    if (isOwnSubApproval(item)) return brand?.socialService.ownSub?.onDecided(item)
    // WP254：别的社群的版务卡 / 回帖卡批了 → 过了取消窗口施行（定时发布那一轮也会补扫）
    if (isSocialExecutableApproval(item)) return brand?.socialService.executor.onDecided(item)
    if (item.kind === 'inbound_dead_letter') {
      const id = deadLetterToRequeue(item)
      if (id !== undefined) await brand?.channels.requeueDeadLetter(id)
      return
    }
    await brand?.seoService.onDecided(item)
  }
  /*
   * WP215（52 §4 收口）：每个品牌一套后台。装在品牌容器**之前**——每个品牌装配时就要拿到
   * 自己那一份急停视图（模型网关、渠道、聊天、消息同步都按它判）。调度器比这里晚建，所以惰性取。
   */
  const background = createBrandBackground({
    clock,
    bootstrap: workspace.id,
    globalHalt: kernel.halt,
    brands: () => {
      const org = identity
        .listOrganizations()
        .find((o) => identity.brandsOf(o.id).some((w) => w.id === workspace.id))
      return org === undefined ? [] : identity.brandsOf(org.id)
    },
    scheduler: () => scheduleRef?.scheduler,
    appendEvent,
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  brands = createBrandModules({
    bootstrap: workspace.id,
    create: (ws) => assembleBrand(ws),
    orgDefault: (ws) => orgDefaultBrandOf(ws),
    brands: () => brandsOfThisOrg(),
    // WP215：跟随公司默认的品牌借的是公司默认那个网关——外面再按它自己的急停判一次
    haltOf: (ws) => background.haltOf(ws),
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  const brandModules: BrandModules = brands
  /*
   * WP134：上次选过「用我的 DeepSeek 账号登录」就把官方模块挂回来（只读本机凭据库，不出网）。
   * WP150：挪到建品牌**之前**——运行时在建品牌那一刻问一次"有没有模型"定走 direct 还是 stub，
   * 挂回来之前问，只接了 DeepSeek 账号的机器重启后就一直是 stub（账号任务根本跑不到模型上）。
   */
  await deepseekAccount.resume()
  /*
   * WP251：启动品牌没挂在公司下、而它的负责人已经有一家公司（Fable 10-07 真机：INMO 没有 org_id，
   * 加的品牌 Rollout 挂在公司下）——挂进去，kind 与加的品牌一致。放在建任何一个品牌那一套之前之后都行，
   * 但必须在品牌后台起来之前（它们按「这家公司有哪些品牌」起），也必须在 DeepSeek 账号挂回来之后
   * （判"原来的公司默认品牌自己接没接模型"要建它那一套）。幂等：挂过就只剩 kind 的核对。
   */
  {
    const settled = await attachBootBrandToCompany({
      identity,
      workspace_id: workspace.id,
      ownModelsConfigured: async (ws) =>
        (await brandModules.forWorkspace(ws)).ownModels.configured(),
      keepOwnModels: (ws) => brandModules.setInheritOrg(ws, false, { even_if_default: true }),
      record: (type, ws, payload) => {
        appendEvent({
          schema_version: 1,
          workspace_id: ws,
          type,
          actor: { kind: 'system', id: 'organizations' },
          correlation: { trace_id: `tr_org_${clock.now()}` },
          payload,
        })
      },
    })
    if (settled.attached !== undefined && options.quiet !== true)
      process.stderr.write('[organizations] 启动品牌挂到了公司下（WP251）\n')
  }
  /** bootstrap 品牌那一套：进程自己要用的那几处（会议 ASR、秘书、问 AI）取它。 */
  const boot = await brandModules.forWorkspace(workspace.id)
  // WP128：托管的是这家公司的另一个品牌时，品牌那一套是懒装配的——现在就装上，
  // 转发器客户端才会起来外连（不然要等第一条请求进来，而托管实例上不会有请求）
  if (hostedBoot !== undefined) {
    const target = hostedTargetOf(hostedBoot, workspace.id, brandsOfThisOrg())
    if (target !== workspace.id) await brandModules.forWorkspace(target)
  }
  const models = boot.ownGateway

  // 37 §4：会议内核。ASR 走同一个模型网关（没装 ASR provider 时管线出系统卡，不炸）；
  // 产出的认领卡进同一条审批队列（14 §1），挂在本人的岗位下。
  //
  // 会议是**全进程一份**（35 §2 一个库）：它按 `workspace_id` 存，两个品牌的会议
  // 从一开始就不在同一批行里，但录音管线与 ASR 只装一套。
  const meetings = createMeetings({
    ...(dbDir === undefined ? {} : { dbDir }),
    clock,
    random,
    models,
    appendEvent,
    approvals: options.mount?.approvals ?? txn.approvals,
    role_id: ownerAssignment.role_id,
    // 18 §2.1 受控原始材料区的第一条纪律：加密。密钥环是数据层的（21 §4，
    // 每主体一把独立随机密钥，销毁即不可读），录音库只拿这个端口——两个库不共享表（35 §2）。
    cipher: data.keyring,
    // WP40：录音与视频落对象存储，受控区里只留一句 `blob://…`（18 §2.1）
    ...(blobs === undefined ? {} : { blobs }),
  })
  // 37 §2.2b：会议处理完开一个 `meeting` 类事项，产出挂它的时间线上（要先有工作模型）
  meetings.bind(boot.work)
  // WP215：会议属于哪个品牌，事项与待认领池就开在哪个品牌的工作模型里
  meetings.bindBrands((ws) => brandModules.peek(ws as WorkspaceId)?.work)

  /*
   * WP67（48 §5.1）：demo 里给红人库放几行。
   *
   * 红人库是我们自己的库，合成 pack 里没有它的行——不放的话红人营销岗位的五块
   * 面板在演示与截图里全是空的，"这个岗位长什么样"就无从谈起。
   * 只在挂了合成世界时放（真环境的库该是用户自己导进去的）。
   */
  if (mount !== undefined) {
    seedDemoKol(boot.kol, clock.now())
    /*
     * WP117（66 断点 #9）：**demo 的红人数据别自相矛盾。**
     *
     * 之前 demo 里 Gadget Jonas 处在「拍摄制作中 · US$400」，名下却一条联系方式
     * 都没有——一条谁也联系不上的合作怎么谈到交付的？亲测的人到这里就卡住了，
     * 因为"起开发信"必须先有联系方式，而他明明已经在交付中。
     *
     * 补的是**已经在合作中的那两个人**的联系方式（还没建联的那几个照旧空着——
     * 那才是真实的样子）。地址是 example 域，走的是与真实逐字相同的那条路：
     * 明文进加密库，库里只留 key 名。`seedDemoKol` 拿不到加密库，所以这一步
     * 在这里做而不是在它里面。
     */
    for (const collab of boot.kol.collaborations()) {
      if (boot.kol.contacts(collab.creator_id).length > 0) continue
      const creator = boot.kol.creator(collab.creator_id)
      if (creator === undefined) continue
      const id = `ctc_demo_${collab.creator_id}`
      const value_ref = contactSecretId(id)
      const handle =
        boot.kol.accounts({ creator_id: creator.id })[0]?.handle ?? creator.id.replace(/\W/g, '')
      boot.secrets.put(value_ref, { [CONTACT_SECRET_FIELD]: `${handle}@example.com` })
      boot.kol.saveContact({
        id,
        creator_id: creator.id,
        kind: 'email',
        value_ref,
        source: 'channel_about',
        verified_at: clock.now(),
      })
    }
  }

  /**
   * WP72（56 §2）：demo 里给社媒库放几行，理由与上面那一条逐字相同。
   *
   * 里面有一条**客户的问题**（Discord 里问"我的单什么时候到"）——56 那条边界
   * 在演示里的落点：社媒运营不答它，它变成一张转客服卡。演示里看不见这一条，
   * 这个岗位最要紧的那句话就说不出来。
   */
  if (mount !== undefined) seedDemoSocial(boot.social, clock.now())

  /**
   * WP78（60 §3）：demo 里给公关库放几行，理由与上面那两条逐字相同。
   *
   * 里面有三条演示里少不了的东西：一条**客户的问题**出现在论坛上
   * （60 分界行的落点——公关不答它，它变成一张转客服卡）、一篇**少一个数字
   * 出处**的稿子（那道门长什么样）、一条**被版规拦下**的外部发帖
   * （我们在别人的地盘上这件事长什么样）。
   */
  if (mount !== undefined) seedDemoPr(boot.pr, clock.now())

  /**
   * WP75（57 §3）：demo 里给广告库放几行，理由与上面两条逐字相同。
   *
   * 里面有一条 **ROAS 0.6 且已经花掉日预算 40%** 的 campaign——那正是止损该
   * 触发的那一条；还有一条 ROAS 4.2 的爆款，止损不该碰它。演示里看不见这两条
   * 摆在一起，"两条判据是且不是或"这句话就说不出来。
   */
  if (mount !== undefined) seedDemoAds(boot.ads, clock.now())

  /**
   * WP77（59 §3）：demo 里给建站库放几行，理由与上面那两条逐字相同。
   *
   * 那一份故意是**一家刚开起来、还差几项**的店（运费一条没配、政策页缺两张、
   * 页脚菜单是空的）——检查单在这样的店上才有话可说，全绿的清单演示不出
   * "缺项高亮"是什么意思。支付与税配好了：那两项建站岗位改不了（51 §3 N2）。
   */
  if (mount !== undefined) seedDemoSite(boot.site, clock.now())

  /**
   * WP76（58 §3）：demo 里给设计库放几行，理由与上面那两条逐字相同。
   *
   * 三张需求单分别停在三个状态上——一张在队列里、一张出了 brief、一张有几版
   * 变体在等人挑。都塞在"待挑"里的面板看起来很满，却回答不了"球在谁那儿"。
   */
  if (mount !== undefined) seedDemoDesign(boot.design, clock.now())

  // demo：把三份合成会议跑完整管线，工作台上的会议页才有真产出可看
  if (mount !== undefined) {
    await seedDemoMeetings(meetings, {
      workspace_id: workspace.id,
      owner: person.id,
      position_id: ownerAssignment.id,
      clock,
      ...(mount.people === undefined ? {} : { people: mount.people }),
    })
  }

  /*
   * WP60（49 §6 / 48 L6）：在线值守的**本地**那一面——切档向导与"接回本机"。
   *
   * 52 O5：一个值守子进程 = 一个品牌工作区，所以这一面仍然只管**当前这个进程**
   * bootstrap 出来的那个品牌；别的品牌的值守由它们自己那个子进程管。
   */
  const standby = createStandby({
    workspace_id: workspace.id,
    clock,
    secrets,
    env,
    ...(dbDir === undefined ? {} : { dbDir }),
    remoteUrl: () => env.AGENTSWS_SERVER_URL,
  })
  /**
   * 21 §4「删这个人」的跨库编排（39 待办 I）：数据层 + 邮件原始区 + 会议原始区。
   *
   * WP66：邮件原始区按品牌各一个，所以编排也按品牌取一次——这个对象本身不开库、
   * 不起定时器，现取现用比缓存一张表干净。
   */
  const privacyFor = async (ws: WorkspaceId): Promise<PrivacyErase> =>
    createPrivacyErase({
      workspace_id: ws,
      clock,
      appendEvent,
      data,
      channels: (await brandModules.forWorkspace(ws)).channels,
      meetings,
    })

  // WP40 / 41 §2.4：数据后端面。凭据进本机加密库（与连接面、模型面同一个库，
  // 靠 key 前缀分开）；`GET /v1/storage` 端出去的永远是脱敏后的描述。
  const storage = createStorage({
    clock,
    ...(dbDir === undefined ? {} : { dbDir }),
    ...(blobs === undefined ? {} : { blobs }),
    secrets,
    env,
  })

  // ── 25 定时与流程：调度器 + 各个消费者 ───────────────────────────────
  // 装配的位置有讲究：要在 work / meetings / connections / skills 都起来之后，
  // 因为七个消费者就是它们；但在网关之前，因为 `/v1/schedules` 要用它。
  const schedule = createScheduleAssembly({
    workspace_id: workspace.id,
    clock,
    random,
    appendEvent,
    ...(dbDir === undefined ? {} : { dbDir }),
    ...(options.scheduleIntervalMs === undefined ? {} : { intervalMs: options.scheduleIntervalMs }),
    // WP215：停用 / 急停的品牌到点不跑；品牌之间并行、同品牌串行，全进程最多 N 件（设置里改）
    hold: (task) => background.hold(task),
    concurrency: () => background.maxConcurrent(),
  })
  scheduleRef = schedule
  // 下面几处（秘书、首次设置……）仍按第一个品牌那一套取（52 O5：值守子进程一个品牌一个）
  const workData = boot.workData
  const work = boot.work
  // WP181：官方「自动化任务」到点接着原来那件事跑一次（开关与上限在 `automation.ts`）。
  // 它本来就按任务上的 `workspace_id` 取那个品牌的事项与运行入口，所以是进程级登记。
  automation.register()
  // WP181（Fable 终审）：老库里等批却建成 `pending`（到点照跑）的那几条，改成停着、批了再开始
  await parkPendingApprovals(schedule.scheduler)

  /*
   * ── WP215（52 §4 收口）：**每个品牌一套后台，共用一个调度循环** ─────────────
   *
   * 之前这一段的消费者只按第一个品牌装配（计划 / 复盘 / 会议轮询 / 学习夜扫 / 周合并 / 查重），
   * 收信那几条虽然"按品牌各跑一轮"，却挂在第一个品牌的一条任务上——第二个品牌没有自己的
   * 任务、没有自己的状态、也停不了它一个。现在：
   *
   * - 每个品牌各一套系统任务（任务上带着它的 `workspace_id`；第一个品牌的老任务 id 一条不动，
   *   别的品牌 id 带 `__<ws>` 后缀）；
   * - 处理器经品牌路由登记：到点按**任务自己的** `workspace_id` 找那个品牌的那一份——用的是
   *   那个品牌的工作模型、连接、模型、凭据、岗位、卡片队列；找不到就失败，绝不借别的品牌；
   * - 进程级的家务（审批过期、幂等清理、原始区保留期、备份、价目）照旧挂在第一个品牌名下。
   */
  const brandRouter = createBrandRouter(schedule.scheduler, {
    // 品牌模块可能被换掉重建过（关掉「跟随公司默认」会重建）：分发前确保它在
    prepare: async (ws) => {
      if (background.isBrand(ws)) await brandModules.forWorkspace(ws)
    },
  })
  /**
   * 一个品牌那一套里的某个对象，**每次用时现取**（品牌模块重建之后拿到的是新的那一份）。
   * 分发前品牌路由已经 `prepare` 过，所以这里 `peek` 一定拿得到。
   */
  const liveBrand = <T extends object>(ws: WorkspaceId, pick: (b: BrandModuleSet) => T): T =>
    new Proxy({} as T, {
      get(_target, prop) {
        const set = brandModules.peek(ws)
        if (set === undefined) throw new Error(`品牌 ${ws} 的模块还没装好`)
        const target = pick(set) as unknown as Record<string | symbol, unknown>
        const value = target[prop]
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value
      },
    })
  /** 这个品牌里**本机这个人**持有的岗位：每日计划与复盘按它一条一条来。 */
  const positionsIn = (ws: WorkspaceId): SchedulePosition[] =>
    roles.assignments
      .listByPerson(person.id, { workspace_id: ws })
      .filter((a) => a.revoked_at === undefined)
      .map((a) => ({ assignment_id: a.id, person_id: a.person_id, role_id: a.role_id }))
  /** 这个品牌里有没有人**还**担着这条职责（撤了的不算）。 */
  const roleHeldIn = (ws: WorkspaceId, role_id: string): boolean =>
    roles.assignments
      .listByRole(role_id, { workspace_id: ws })
      .some((a) => a.revoked_at === undefined)
  /** 一个品牌一轮收信（邮箱轮询 + 整只邮箱同步），一个账号坏了不拖垮别的。 */
  const pollMailOf = async (
    brand: BrandModuleSet,
  ): Promise<{ accounts: number; messages: number; retried: number; failed: string[] }> => {
    const one = await brand.channels.poll()
    const out = {
      accounts: one.accounts,
      messages: one.messages,
      retried: one.retried,
      failed: one.failed.map((f) => `${brand.workspace_id}:${f}`),
    }
    /*
     * WP113（63 §3）：同一拍里把**整只邮箱**也拉一轮（六个文件夹各一个游标）。
     * WP167 起收信只有这一个入口——落消息库、分拣，判成客服的信再经 `channels.intakeSupportMail`
     * 递回渠道那条管线开事项、起 Run。消息同步炸了不该拖垮收信，所以单独 catch。
     */
    try {
      const mail = await brand.messages.poll()
      out.failed.push(...mail.failed.map((f) => `${brand.workspace_id}:messages:${f}`))
    } catch (e) {
      out.failed.push(
        `${brand.workspace_id}:messages: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    return out
  }

  // WP50 45 H4：夜里扫一遍重复的品牌 / 产品线 / 店铺范围。WP215：**每个品牌各一份**
  // （第一个品牌的那一份还在原来的目录，别的品牌落各自的品牌目录）。
  const orgDuplicates = createOrgDuplicateScan({
    workspace_id: workspace.id,
    clock,
    roles,
    approvals,
    appendEvent,
    owner: async () => (await identity.getWorkspace(workspace.id))?.owner_id,
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  const orgDuplicatesByBrand = new Map<WorkspaceId, OrgDuplicateScan>([
    [workspace.id, orgDuplicates],
  ])
  const orgDuplicatesOf = (ws: WorkspaceId): OrgDuplicateScan => {
    const known = orgDuplicatesByBrand.get(ws)
    if (known !== undefined) return known
    const dir = brandDirOf(dbDir, ws, workspace.id)
    if (dir !== undefined) mkdirSync(dir, { recursive: true })
    const scan = createOrgDuplicateScan({
      workspace_id: ws,
      clock,
      roles,
      approvals,
      appendEvent,
      owner: async () => (await identity.getWorkspace(ws))?.owner_id,
      ...(dir === undefined ? {} : { dbDir: dir }),
    })
    orgDuplicatesByBrand.set(ws, scan)
    return scan
  }

  /** 给一个品牌登记它那一套处理器（只登记一次；品牌模块重建后经 `liveBrand` 自然换新）。 */
  const wiredBrands = new Set<WorkspaceId>()
  const wireBrand = async (ws: WorkspaceId): Promise<void> => {
    if (wiredBrands.has(ws)) return
    const brand = await brandModules.forWorkspace(ws)
    wiredBrands.add(ws)
    const s = brandRouter.for(ws)
    const of = (): Promise<BrandModuleSet> => brandModules.forWorkspace(ws)
    const tz = offsetToTz(brand.workData.tz_offset_minutes)
    const brandWork = liveBrand(ws, (b) => b.work)
    const brandData = liveBrand(ws, (b) => b.workData)
    const cardsOf = async (p: SchedulePosition): Promise<ApprovalItem[]> =>
      (await approvals.queue({
        workspace_id: ws,
        person_id: p.person_id,
        lane: 'mine',
        state: [...QUEUE_STATES],
      })) as ApprovalItem[]
    const planDeps = {
      workspace_id: ws,
      work: brandWork,
      approvals,
      positions: () => positionsIn(ws),
      tz,
      goals: async (p: SchedulePosition) =>
        brandWork.progress(
          periodQueryRunner(
            () => brandData.orders({ assignment_id: p.assignment_id }),
            () => [],
            'USD',
          ),
          { position_id: p.assignment_id, status: ['active'] },
        ),
      cardsWaiting: async (p: SchedulePosition) =>
        (await cardsOf(p)).filter((i) => WAITING_QUEUE_STATES.has(i.state)).length,
    }
    // ① 每日计划、② 复盘（day / week / month）、⑦ 复盘 → 次日计划草案的接力
    registerDailyPlan(s, planDeps)
    const relay = registerPlanRelay({ workspace_id: ws, scheduler: s, work: brandWork, tz })
    registerReview(s, {
      ...planDeps,
      cards: cardsOf,
      lessons: () =>
        skills.lessons
          .list({ workspace_id: ws, status: 'pooled' })
          .map((l) => ({ id: l.id, text: l.text })),
      relay: (review) => relay(review),
      // 40 §2.2：周复盘报"疑似重复"，并把过了 Wilson 门槛的好东西往上浮——都只看这个品牌
      catalog: {
        duplicates: (limit) => catalog.duplicatesFor(ws, limit),
        proposePromotions: (deps, named) => catalog.proposePromotionsFor(ws, deps, named),
      },
    })
    // ③ 会议记录源轮询（拉到的会议记在这个品牌名下）
    registerMeetingPoll(s, {
      workspace_id: ws,
      clock,
      meetings,
      actor: brandAnchor(ws)?.owner ?? person.id,
    })
    // ⑤ Shopify 令牌刷新：这个品牌自己那套客户端凭据
    registerTokenRefresh({
      clock,
      scheduler: s,
      refreshTokens: async () => (await of()).connections.refreshTokens(),
      expiries: () =>
        brandModules
          .peek(ws)
          ?.connections.shopify.list()
          .map((r) => r.expires_at) ?? [],
    })
    // ⑥ 技能周合并、⑧ 学习回路夜扫：只看这个品牌的池，卡只出在这个品牌
    registerSkillsWeekly(s, {
      workspace_id: ws,
      clock,
      weeklyConsolidate: (w, now) => learning.weeklyConsolidate(w, now),
    })
    registerLearning(s, { clock, proposeDaily: (now) => learning.proposeDailyFor(ws, now) })
    // ⑭ 重复的组织对象
    registerOrgDuplicateScan(s, { scan: () => orgDuplicatesOf(ws).run() })
    // ⑨ 收信：这个品牌的信只从这个品牌的邮箱进这个品牌的队列
    registerMailPoll(s, { poll: async () => pollMailOf(await of()) })
    // WP55：Amazon 24h 响应线、出站对账
    registerAmazonSla(s, { sweep: async () => (await of()).channels.amazonSlaSweep() })
    registerReconcileDeliveries(s, {
      reconcile: async () => (await of()).channels.reconcileDeliveries(),
    })
    // WP173 / WP182：B2B 开发信序列 + 样品提醒（发信邮箱与配额是品牌自己的）
    registerB2bSequence(s, {
      sweep: async () => {
        const b = await of()
        const one = await b.b2bOutbound.sweep()
        await b.b2bSales.sweep().catch(() => undefined)
        return one
      },
    })
    // WP68：红人开发信序列跟进（这个品牌的红人库与额度）
    registerKolSequence(s, {
      sweep: async () => {
        const one = await (await of()).kolService.sweepSequences()
        return { ...one, skipped: one.skipped.map((x) => ({ ...x, workspace_id: ws })) }
      },
    })
    // WP154：内容与搜索（这个品牌的 Search Console、订单与问题清单）
    registerSeo(s, {
      daily: async () => {
        const one = await (await of()).seoService.daily()
        return {
          brands: 1,
          picks: one.picks,
          skipped: one.skipped === undefined ? [] : [{ workspace_id: ws, reason: one.skipped }],
        }
      },
      weekly: async () => {
        const b = await of()
        const revenue = await b.seoService.weeklyRevenue()
        const geo = await b.seoService.weeklyGeo()
        const skipped: unknown[] = []
        for (const reason of [revenue.skipped, geo.skipped])
          if (reason !== undefined) skipped.push({ workspace_id: ws, reason })
        return { brands: 1, skipped }
      },
    })
    // WP224：本周经营一页纸（秘书每周一推给这个品牌的老板）、两条止损线对照（每天夜里记一行）
    registerEconomics(s, {
      weeklyReview: async () => (await of()).weeklyReview.run(),
      lineCompare: async () => (await of()).lineCompareSnapshot(),
    })
    // WP78：品牌监控（这个品牌的提及只进这个品牌的库）
    registerPrMonitor(s, { sweep: async () => (await of()).prService.monitorSweep() })
    // WP73：社媒定时发布与群发（这个品牌的号发这个品牌的内容）
    registerSocialPublish(s, {
      sweep: async () => {
        const social = (await of()).socialService
        const one = await social.publishDue()
        /*
         * WP256（决策 147）：「群里的帖子」自动进帖挂在这一拍上（不另起定时）：Discord 到点的频道读一轮
         * （默认 15 分钟一次），Reddit 自家版一小时内没人读过才补读一页新帖。读失败照实记在进帖状态里，
         * 不影响发布这一轮的结果。
         */
        const ingested = await social.ingest.sweep().catch(() => undefined)
        return {
          ...one,
          skipped: one.skipped.map((x) => ({ ...x, workspace_id: ws })),
          ...(ingested === undefined ? {} : { ingested: ingested.ingested }),
        }
      },
    })
    registerSocialBroadcast(s, {
      sweep: async () => {
        const one = await (await of()).socialService.broadcastDue()
        return { ...one, skipped: one.skipped.map((x) => ({ ...x, workspace_id: ws })) }
      },
    })
    // WP57：聊天求助超时；WP125：首响 SLA
    s.register(CHAT_ASSIST_TIMEOUT_HANDLER, async () => (await of()).chat.sweepAssistTimeouts())
    s.register(SUPPORT_SLA_HANDLER, async () => (await of()).supportJudgment.sweepSla())
  }

  /**
   * 给一个品牌建齐它那一套系统任务（已经有的不动——用户改过时间、停过的都还在）。
   *
   * 进程级的家务只挂在第一个品牌名下；按职责才建的那几条（红人 / 社媒 / 公关 / B2B / 内容）
   * 看的是**这个品牌里**有没有人持有那条职责。
   */
  const ensureBrandTasks = async (ws: WorkspaceId): Promise<void> => {
    const anchor = brandAnchor(ws)
    // 这个品牌里一条能挂的岗位都没有：没有人可以替它收卡，先不建（有了岗位再建）
    if (anchor === undefined) return
    const isBoot = ws === workspace.id
    const suffix = isBoot ? '' : `__${ws}`
    const brand = await brandModules.forWorkspace(ws)
    const base = {
      workspace_id: ws,
      owner: anchor.owner,
      role_id: anchor.assignment.role_id,
      assignment_id: anchor.assignment.id,
    }
    const held = (role_id: string): boolean => roleHeldIn(ws, role_id)
    await ensureTask(schedule.scheduler, `${CHAT_ASSIST_TASK_ID}${suffix}`, chatAssistTask(base))
    await ensureTask(schedule.scheduler, `${SUPPORT_SLA_TASK_ID}${suffix}`, supportSlaTask(base))
    await ensureSystemTasks(schedule.scheduler, {
      ...base,
      tz: offsetToTz(brand.workData.tz_offset_minutes),
      positions: positionsIn(ws),
      ...(isBoot ? {} : { idSuffix: suffix }),
      has: {
        work: true,
        meetings: true,
        shopify: true,
        skills: true,
        learning: true,
        mail: true,
        orgDuplicates: true,
        // 进程级的家务：只在第一个品牌名下建一份
        idempotency: isBoot && idempotencyStore !== undefined,
        approvals: isBoot,
        raw: isBoot,
        backup: isBoot && dbDir !== undefined,
        pricing: isBoot,
        /*
         * WP68：有人持有红人那几条渠道职责时才建这一条。
         *
         * 没人做红人营销的品牌上建一条每天都跑一遍空库的任务，只是给 25 §3 的
         * "机器在替你定时做哪几件事"那张清单添一行看不懂的东西。
         */
        kol: KOL_CHANNEL_IDS.some((channel) => held(`kol.${channel}`)),
        // WP73：有人持有社媒那九条渠道职责之一时才建那条巡检
        social: SOCIAL_ROLE_IDS.some((role_id) => held(role_id)),
        // WP78（60 §5）：有人持有公关那四条职责之一才建品牌监控那条定时
        pr: PR_ROLE_IDS.some((role_id) => held(role_id)),
        // WP173：有人持有「主动开发」才建开发信序列那条定时
        b2b: held('b2b.outbound'),
        // WP154：有人持有「内容与搜索」才建每日读 Search Console 与每周小结那两条
        seo: held('dtc.content'),
        // WP224：有老板岗位才推一页纸；有人担投放才记两条止损线的对照
        weeklyReview: held('common.owner'),
        adsLineCompare: ADS_PLATFORMS.some((p) => held(`ads.${p.id}`)),
      },
    })
  }

  /**
   * 一个品牌的后台常驻起来：登记处理器 + 建齐任务。启动时对每个在跑的品牌做一次，
   * 新建品牌时（`onBrandCreated`）立刻再做一次——不用等重启。
   */
  const startBrandBackground = async (ws: WorkspaceId): Promise<void> => {
    if (!background.isBrand(ws) || background.stopped(ws)) return
    await wireBrand(ws)
    await ensureBrandTasks(ws)
    await applyRoleGates(ws)
  }

  /*
   * WP215（Fable 10-05）：**"有人担这条职责才建"的定时跟着分配即时建 / 停**——先建品牌、再分配
   * 职责的流程不用重启。建：`ensureBrandTasks` 补上缺的；停：没人担了就暂停并打个记号
   * （`params.auto_stopped`），又有人担了只放开**带记号**的那几条——人自己按的暂停不碰。
   * 岗位那几条（每日计划 / 复盘）同理：分配撤了就停，那条分配回来就放开。
   */
  const AUTO_STOPPED = 'role_released'
  const ROLE_GATED: { ids: string[]; held: (ws: WorkspaceId) => boolean }[] = [
    {
      ids: ['sched_kol_sequence'],
      held: (ws) => KOL_CHANNEL_IDS.some((c) => roleHeldIn(ws, `kol.${c}`)),
    },
    {
      ids: ['sched_social_publish', 'sched_social_broadcast'],
      held: (ws) => SOCIAL_ROLE_IDS.some((r) => roleHeldIn(ws, r)),
    },
    { ids: ['sched_pr_monitor'], held: (ws) => PR_ROLE_IDS.some((r) => roleHeldIn(ws, r)) },
    { ids: ['sched_b2b_sequence'], held: (ws) => roleHeldIn(ws, 'b2b.outbound') },
    { ids: ['sched_seo_daily', 'sched_seo_weekly'], held: (ws) => roleHeldIn(ws, 'dtc.content') },
    // WP224
    { ids: ['sched_weekly_review'], held: (ws) => roleHeldIn(ws, 'common.owner') },
    {
      ids: ['sched_ads_line_compare'],
      held: (ws) => ADS_PLATFORMS.some((p) => roleHeldIn(ws, `ads.${p.id}`)),
    },
  ]
  const POSITION_TASK = /^sched_(daily_plan|review_day|review_week|review_month)_/
  const gate = async (id: string, on: boolean): Promise<void> => {
    const task = schedule.scheduler.get(id)
    if (task === undefined) return
    const marked = task.params?.auto_stopped === AUTO_STOPPED
    if (!on && (task.state === 'active' || task.state === 'pending')) {
      await schedule.scheduler.update(id, {
        params: { ...(task.params ?? {}), auto_stopped: AUTO_STOPPED },
      })
      await schedule.scheduler.pause(id)
    } else if (on && marked && task.state === 'paused') {
      const { auto_stopped: _drop, ...rest } = task.params ?? {}
      await schedule.scheduler.update(id, { params: rest })
      await schedule.scheduler.resume(id)
    }
  }
  async function applyRoleGates(ws: WorkspaceId): Promise<void> {
    const suffix = ws === workspace.id ? '' : `__${ws}`
    for (const g of ROLE_GATED) {
      const on = g.held(ws)
      for (const id of g.ids) await gate(`${id}${suffix}`, on)
    }
    for (const task of schedule.scheduler.list({ workspace_id: ws })) {
      if (!POSITION_TASK.test(task.id)) continue
      const live = roles.assignments.get(task.assignment_id)?.revoked_at === undefined
      await gate(task.id, live)
    }
  }
  /** 分配一变：这个品牌的定时即时对一遍（同一品牌排队、合并成一次，不并发）。 */
  const syncing = new Set<WorkspaceId>()
  const dirty = new Set<WorkspaceId>()
  const requestBrandSync = (ws: WorkspaceId): void => {
    if (!background.isBrand(ws) || background.stopped(ws)) return
    if (syncing.has(ws)) {
      dirty.add(ws)
      return
    }
    syncing.add(ws)
    const run = async (): Promise<void> => {
      try {
        do {
          dirty.delete(ws)
          await startBrandBackground(ws)
        } while (dirty.has(ws))
      } finally {
        syncing.delete(ws)
      }
    }
    background.track(run())
  }

  // 第一个品牌先来（它那几条老任务的建法与之前逐字相同），再是这家公司的其余品牌
  await startBrandBackground(workspace.id)
  for (const ws of background.activeBrands())
    if (ws !== workspace.id) await startBrandBackground(ws)
  roles.onAssignmentChanged?.((a) => {
    requestBrandSync(a.workspace_id)
  })

  // ── 进程级的家务：不属于哪个品牌，挂在第一个品牌名下（品牌急停不停它们）────────
  // ⑧ 审批过期与升级（39 待办 A）：模拟回路每 tick 调一次，真机器每分钟调一次。
  //    预占的「过期释放」也挂在这条上——15 §3.2 (d) 的释放是跟着审批项过期走的。
  registerApprovalHousekeeping(schedule.scheduler, { approvals })
  // ④ 幂等表清理（内存档的那份归网关自己管，这里只扫落盘那份）
  if (idempotencyStore !== undefined) {
    registerIdempotencySweep(schedule.scheduler, { clock, store: idempotencyStore })
  }
  // ⑩ 受控原始材料区的保留期（39 待办 H）：两个库各清各的，表不共享（35 §2）
  registerRawPrune(schedule.scheduler, {
    clock,
    // 保留天数进策略层：显式的 `raw_retention_days`（WP35 进契约），
    // 回落 WP34 用过的 `global_caps.raw_retention_days`，最后才是默认的 90 天
    retentionDays: () => {
      const policy = roles.policies.get(workspace.id)
      return (
        policy?.raw_retention_days ??
        policy?.global_caps?.raw_retention_days ??
        DEFAULT_RAW_RETENTION_DAYS
      )
    },
    channels: async (retentionMs) => {
      let pruned = 0
      for (const brand of await brandModules.all())
        pruned += await brand.channels.prune(retentionMs, clock.now())
      return pruned
    },
    meetings: (retentionMs, now) => meetings.raw.prune(retentionMs, now),
  })
  // ⑫ WP36 40 §1.3：每天一份备份。**只有落盘档有**——内存档没有可导的库文件。
  const runWorkspaceBackup = (): BackupRunResult => {
    if (dbDir === undefined) throw new Error('这个服务进程没有数据目录，没有可导的东西')
    return runBackup({
      dataDir: dbDir,
      workspace_id: workspace.id,
      outDir: backupDirOf(env, dbDir),
      clock,
      keep: backupKeepOf(env),
      release: env.AGENTSWS_VERSION ?? '0.1.0',
    })
  }
  if (dbDir !== undefined) registerBackup(schedule.scheduler, { run: runWorkspaceBackup })

  // WP42：每周一 05:00 去各家官网看一眼模型价（抓不到就保留内置价，不算失败）
  registerPricingRefresh(schedule.scheduler, {
    run: async () => {
      const result = await boot.ownModels.port.refreshPricing({
        workspace_id: workspace.id,
        person_id: person.id,
        assignment_id: ownerAssignment.id,
        role_id: ownerAssignment.role_id,
      })
      return { vendors: result.vendors, updated_providers: result.updated_providers }
    },
  })

  // ── 15 §5.8：备份恢复后先对账再放开出站（39 待办 B）─────────────────
  // 这一步要**排在网关之前**：`/v1/health` 要端出 reconcile 那一格；
  // 而 `engage()` 里挂的 outbound 档要在进程开始接活之前就生效。
  const reconcile = createReconcileGuard({
    clock,
    halt: kernel.halt,
    txn,
    workspace_id: workspace.id,
    appendEvent,
    verify: options.verifyChange ?? ((change) => backend.verify(change)),
  })
  reconcile.engage()

  const rolesPort: RolesPort = {
    can: (id, domain, op, request) => roles.can(id, domain, op, request),
    effectiveConfig: (id) => roles.effectiveConfig(id),
    getAssignment: (id) => roles.assignments.get(id),
    listAssignments: (person_id, filter) => roles.assignments.listByPerson(person_id, filter ?? {}),
  }

  // WP28 制度面：职责 / 岗位 / 分配 / 策略层 / 成员与邀请（业务全在 ./org.ts，这里只装配）
  const org = createOrg({
    clock,
    identity,
    roles,
    approvals,
    workspace_id: workspace.id,
    appendEvent,
    ...(dbDir === undefined ? {} : { dbDir }),
    brandName: () => brandNameOfWorkspace(workspace.id),
    // WP174：上级离职时，各品牌里他手上的卡都要改派（审批总线是同一条）
    workspaceIds: () => [
      ...new Set([workspace.id, ...(brands?.loaded().map((b) => b.workspace_id) ?? [])]),
    ],
    // WP182：B2B 业务员离开 → 各品牌里他名下的客户 / 商机 / 没回的询盘各出一张交接卡给老板
    afterMemberLeft: async (person_id, by) => {
      for (const brand of await brandModules.all()) await brand.b2bSales.onMemberLeft(person_id, by)
      /*
       * WP194：删人时把他在云上的额度行清掉（历史用量留着，账对得上）。钱在公司那一个云组织上，
       * 任一个关联了的品牌清一次就够；尽力而为——没关联 / 连不上不拦删人。
       */
      for (const brand of await brandModules.all()) {
        if (!brand.ownCloud.linked()) continue
        if (await brand.ownCloud.forgetMember(person_id, by).catch(() => false)) break
      }
    },
    /*
     * WP234（docs/54 §6.4）：岗位合并 / 移动之后，事项（各品牌的工作模型里）与岗位层记忆
     * （学习回路里）跟着走。制度层够不着它们，所以在这里接上。
     */
    reshape: {
      retargetMatters: async (input) => {
        const to_name = org.positions().find((p) => p.id === input.to)?.name.zh
        let moved = 0
        for (const brand of await brandModules.all())
          moved += retargetPositionMatters(
            brand.work,
            { ...input, ...(to_name === undefined ? {} : { to_name }) },
            clock.now(),
          )
        return moved
      },
      mergeMemory: (input) => learning.mergePositionMemory(input),
      copyMemory: (input) => learning.copyPositionMemory(input),
    },
  })
  rangeExpandedSink = org.onRangeExpanded
  supervisorPositions = () => org.positions()
  creditsPositionNames = () => Object.fromEntries(org.positions().map((p) => [p.id, p.name.zh]))
  // WP206：公司页与岗位名装好了：已装好的品牌现在推第一份名册（之后装的品牌自己推）
  rosterReady = true
  for (const sync of rosterSyncs.values()) sync.start()

  /**
   * WP51 首次设置与同事发现（46）。
   *
   * 装在 org 之后：岗位模板的真源在那边（`org.port.positions` 背后的那张表），
   * 向导第 ③ 步要读它。装在网关之前：`/v1/onboarding/*` 那几条路由要用它。
   *
   * 三个取值函数是故意的——连接、技能、模型都是会在运行期变的，向导第 ④ 步那张
   * 清单必须现算，不能在装配那一刻定死（否则"去连"回来之后清单还说没连）。
   */
  const onboarding = createOnboarding({
    clock,
    random,
    workspace_id: workspace.id,
    owner: person.id,
    // WP240：首次设置按 actor 的品牌问（不给 = 启动品牌）
    workspaceName: (ws) =>
      ws === undefined || ws === workspace.id
        ? workspace.name
        : (workspaceSync(ws)?.name ?? brandNameOfWorkspace(ws)),
    ownerOf: (ws) => workspaceSync(ws)?.owner_id,
    appendEvent,
    roles,
    approvals,
    identity: {
      personByEmail: (email) => identity.personByEmail(email),
      createPerson: (input) => identity.createPerson(input),
      addMember: (m) => identity.addMember(m),
    },
    members: async (ws) => {
      const rows = await identity.members(ws ?? workspace.id)
      const people = await Promise.all(
        rows
          .filter((m) => m.left_at === undefined)
          .map(async (m) => {
            const who = await identity.getPerson(m.person_id)
            return {
              person_id: m.person_id,
              name: who?.name ?? '',
              email: who?.email ?? '',
            }
          }),
      )
      return people
    },
    positions: () => org.positions(),
    // WP234（docs/54 §6.1 / §6.2）：类别目录、岗位清单落库、「说说你要做什么」的推荐引擎
    catalog: () => org.catalog(),
    positionStore: {
      ensure: (input, by) => org.ensurePosition(input, by),
      place: (assignment_id, position_id) => {
        org.place(assignment_id, position_id)
      },
      placementOf: (assignment_id) => org.placementOf(assignment_id),
    },
    suggester: async (actor) => {
      /*
       * WP242：按**点推荐的那个人这会儿开着的品牌**取模型面与网关（跟随公司的，`brandModules`
       * 解析成公司那一份——令牌也是公司那一把），用量记在这个品牌、这个人头上（`extraction` 档）。
       * 以前一律用启动品牌的网关、记在启动品牌负责人头上：第二个品牌点推荐，账记到了第一个品牌。
       */
      const ws = (actor?.workspace_id ?? workspace.id) as WorkspaceId
      const own = ws === workspace.id
      const models = own ? boot.ownModels : await brandModules.models(ws)
      const ref = models.configured() ? models.defaultRef() : undefined
      if (ref !== undefined && ref.provider !== 'stub') {
        const gateway = own ? boot.ownGateway : await brandModules.gateway(ws)
        const who =
          actor === undefined
            ? { assignment_id: ownerAssignment.id, role_id: ownerAssignment.role_id as string }
            : { assignment_id: actor.assignment_id, role_id: actor.role_id }
        return modelSuggester(async (prompt) => {
          const completion = await gateway.complete({
            messages: [{ role: 'user', content: prompt }],
            meta: {
              workspace_id: ws,
              assignment_id: who.assignment_id as never,
              role_id: who.role_id as never,
              run_id: `onb_suggest_${suggestSha(prompt).slice(0, 16)}` as never,
              purpose: 'extraction',
            },
            model: ref,
            /*
             * WP243：一次性抽取——不要思考、封住输出上限。10-06 真机那一次出了 8859 个 token、
             * 等了 38 秒；答案本身只是一小段紧凑 JSON。
             */
            max_output_tokens: SUGGEST_MAX_OUTPUT_TOKENS,
            thinking: 'off',
          })
          return completion.text
        })
      }
      // 没接上真模型（只有 stub / 演示）：回 undefined，推荐那一层退回按原话对词并明说（Luoye 10-06）
      return undefined
    },
    /*
     * WP240：首次设置按**这个人这会儿开着的那个品牌**问连接、模型与店铺（52 O3：它们都是品牌级的）。
     * 不给品牌 = 启动品牌（启动时那一次补挂范围用）。以前一律问启动品牌——第二个品牌的分配
     * 会挂到第一个品牌的店上、清单说的"已连"也是第一个品牌的。
     */
    connectedKinds: async (ws) =>
      ws === undefined || ws === workspace.id
        ? boot.connections.connectedKinds()
        : (await brandModules.forWorkspace(ws)).connections.connectedKinds(),
    installedSkills: () => skills.registry.listSkillNames(),
    modelConfigured: async (ws) =>
      ws === undefined || ws === workspace.id
        ? boot.ownModels.configured()
        : (await brandModules.models(ws)).configured(),
    // 46 I6：连上 Shopify 的店自动挂上岗位的范围；一家没连就挂整个品牌
    shopifyStores: (ws) => {
      const list = (c: typeof boot.connections) =>
        c.shopify.list().map((r) => ({ id: r.shop, label: r.alias }))
      return ws === undefined || ws === workspace.id
        ? list(boot.connections)
        : brandModules.forWorkspace(ws).then((b) => list(b.connections))
    },
    port: () => boundPort,
    ...(dbDir === undefined ? {} : { dbDir }),
    ...(options.mdns === undefined ? {} : { mdns: options.mdns }),
    ...(options.discoveryPost === undefined ? {} : { post: options.discoveryPost }),
    ...(options.discoveryHello === undefined ? {} : { helloFetch: options.discoveryHello }),
    // WP52：批准一条加入申请之后，直接交给 20 §4 的 Join（owner 当场收一张 join_mapping 卡）。
    // 懒取：`joinAssembly` 在下面几行才建出来。
    join: () => joinAssembly.port,
    /*
     * WP65（52 O1）：公司级那三样的真源是**组织**。
     *
     * 懒取的理由与 `join` 一样——组织在下面几行才装配好，而且第一次启动时
     * 还要先靠档案把组织建出来（`organizations.migrate`），是个鸡生蛋：
     * 迁移那一刻 `bootstrapOrg` 还是 `undefined`，`companyOf()` 正好退回读档案。
     */
    organization: () =>
      bootstrapOrg === undefined ? undefined : organizationProfileOf(bootstrapOrg),
    // WP251：某个品牌挂的那家公司（公司全称、后缀、发现、地址都读它）
    organizationOf: (ws) => {
      const org_id = workspaceSync(ws)?.org_id
      return org_id === undefined ? undefined : organizationProfileOf(org_id)
    },
    // WP251：同一家公司下的全部品牌（改公司时各品牌档案里的影子一起刷）
    brandsOfCompany: (ws) => {
      const org_id = workspaceSync(ws)?.org_id ?? bootstrapOrg
      return org_id === undefined ? [ws] : identity.brandsOf(org_id).map((w) => w.id)
    },
    // 52 O1：品牌名（顶栏切换器显示的那一个）。没迁过的就是工作区名
    // WP240：按品牌读写（不给 = 启动品牌）——以前一律读写启动品牌
    brandName: (ws) => brandNameOfWorkspace(ws ?? workspace.id),
    setBrandName: (name, ws) => {
      void identity.setBrand(ws ?? workspace.id, { name }).catch(() => undefined)
    },
    updateOrganization: (patch, ws) => {
      // WP251：写**这个品牌挂的那家公司**（不给品牌 / 它没挂公司 = 启动品牌那一家）
      const target = (ws === undefined ? undefined : workspaceSync(ws)?.org_id) ?? bootstrapOrg
      if (target === undefined) return
      // 两档身份服务这一步都是同步落库的（Promise 只是签名）；唯一可能的失败是
      // 空的公司全称，而那一条 `setProfile` 在更早的地方就挡掉了
      void identity.updateOrganization(target, patch).catch(() => undefined)
    },
  })
  /*
   * WP138（78 §1 #1）：老版本的向导没连店就把新职责挂空。启动时一次性补上
   * （只补店主自己给自己建的、要范围却一条都没有的；跑过一次就不再跑）。
   */
  onboarding.backfillWizardRanges()

  /**
   * WP121（70 §3）：贴一个网址，自动分析出品牌档案。
   *
   * 装在 onboarding 之后：确认那一下写的是**同一份工作区档案**（`onboarding.port
   * .setProfile`），走同一条归一化与同一条事件，不另开一条写入路径——两条写法
   * 迟早会在"平台缺省值"这种地方分叉。
   *
   * `fetch` 是真的 `globalThis.fetch`：这一步要去敲用户自己给的那个网址。
   * 纪律在包里（只 GET、不带凭据、遵 robots、超时 10 秒、页面数封顶）。
   */
  const brandIntake = createBrandIntake({
    clock,
    workspace_id: workspace.id,
    fetch: options.brandIntakeFetch ?? (globalThis.fetch as never),
    // WP240：Shopify 店铺访问密码那一下（POST /password）。离线替身（测试 / demo）不给——不出网
    ...(options.brandIntakeFetch === undefined ? { passwordPost: globalThis.fetch as never } : {}),
    newId: (prefix) => `${prefix}_${Math.floor(random() * 1e12).toString(36)}`,
    sinks: {
      /*
       * WP240：写的是**确认的那个人这会儿开着的那个品牌**（`actor.workspace_id`）。
       * 以前一律写启动品牌：在第二个品牌里确认分析，会把第一个品牌的档案、品牌名与公司全称
       * 一起改成第二个品牌网站上的样子（测试 `wp240-two-brand-onboarding` 钉住）。
       *
       * 公司加的品牌（公司那一层已经设过）：公司全称不跟着分析结果改；品牌名是建品牌时
       * 起的那个，只有用户在档案卡上亲手改了品牌名才改。
       */
      applyProfile: async (profile, actor) => {
        const added = onboarding.isAddedBrand(actor.workspace_id as WorkspaceId)
        // WP251：这个品牌挂的那家公司
        const company = onboarding.companyProfile(actor.workspace_id as WorkspaceId)?.legal_name
        const legal =
          added && company !== undefined && company.trim() !== ''
            ? company
            : (profile.legal_name?.value ?? profile.brand_name?.value)
        // WP248（决策 83）：一句话介绍 / 客服邮箱 / 币种进品牌档案（以前只活在这一轮分析里）。
        // 读到了才写；没读到的格子不动（不拿「没读到」去清人以前填的）
        const text = (f: { value: unknown } | undefined): string | undefined =>
          typeof f?.value === 'string' && f.value.trim() !== '' ? f.value : undefined
        const one_liner = text(profile.one_liner)
        const support_email = text(profile.support_email)
        const currency = text(profile.currency)
        const facts = {
          ...(one_liner === undefined ? {} : { one_liner }),
          ...(support_email === undefined ? {} : { support_email }),
          ...(currency === undefined ? {} : { currency }),
        }
        // WP258：官网里漏出来的 `xxx.myshopify.com` 存进档案（建站岗位登录后找店时拿它对一下）
        const shopDomain = text(profile.shopify_domain)
        const rememberShopDomain = (): void => {
          if (shopDomain !== undefined)
            onboarding.setShopifyDomain(actor.workspace_id as WorkspaceId, shopDomain)
        }
        if (typeof legal !== 'string' || legal.trim() === '') {
          // 公司名、品牌名都还没有：档案已经在就只补这三格，没有档案不替人建
          onboarding.setBrandFacts(actor.workspace_id as WorkspaceId, facts)
          rememberShopDomain()
          return
        }
        const brandName =
          typeof profile.brand_name?.value === 'string' &&
          (!added || profile.brand_name.edited === true)
            ? profile.brand_name.value
            : undefined
        await onboarding.port.setProfile(
          {
            workspace_id: actor.workspace_id,
            person_id: actor.person_id,
            assignment_id: actor.assignment_id,
            role_id: actor.role_id,
          },
          {
            legal_name: legal,
            ...(brandName === undefined ? {} : { brand_name: brandName }),
            ...(profile.storefront_platform === undefined
              ? {}
              : { storefront_platform: profile.storefront_platform.value }),
            // WP159：目标市场进档案（违规宣称规则按它开市场组）
            // WP166：连出处一起写；人在档案卡上改过（`edited`）的记成「人改的」，清空也算数
            ...marketsFromIntake(profile.markets, clock.now()),
            ...facts,
          },
        )
        rememberShopDomain()
      },
      /**
       * WP121b（70 §3.5）：首批知识条目——政策要点与商品卡。
       *
       * **一律 `proposed`**（`propose` 自己把状态钉死）：这是机器从别人网页上
       * 读来的话，人点头之前它不该被任何 Agent 当成"我们的口径"。翻译那一步
       * 是纯函数（`brand-knowledge.ts`），这里只负责一条条提上去。
       *
       * 一条失败不连累其余：一个品牌的退款政策没建成，不该让商品卡也一起没了。
       */
      // WP240：首批知识进**确认的那个品牌**的知识库（以前一律进启动品牌）
      seedKnowledge: async (profile, actor) => {
        for (const card of brandKnowledgeCards(profile, {
          workspace_id: actor.workspace_id as WorkspaceId,
          at: clock.now(),
          owner: actor.person_id as PersonId,
        })) {
          try {
            await knowledge.store.propose(card)
          } catch (err) {
            process.stderr.write(`[brand-intake] 这条知识没建成：${String(err)}\n`)
          }
        }
      },
    },
  })

  /**
   * WP122（71）：这个品牌的那一份 `DESIGN.md`。
   *
   * 装在 `brandIntake` **之后**，因为它的页面是从那一轮手上拿的
   * （`latestDocuments`）——71 §2 第一条的"同一次抓取"在这里是一行代码：
   * 拿得到就用，拿不到（进程重启过、或者用户是从设置页直接点的）那一格就是空的，
   * `extract` 会如实说"还没有抓回来的页面"，而不是偷偷把用户的站再抓一遍。
   *
   * `fetch` 仍然是真的 `globalThis.fetch`：外链样式表拿不到别的办法。纪律在包里
   * （只同源与站自己的 CDN、遵 robots、封顶 6 份）。
   */
  const brandDesign = createBrandDesign({
    clock,
    workspace_id: workspace.id,
    ...(dbDir === undefined ? {} : { dbDir }),
    fetch: globalThis.fetch as never,
    newId: (prefix) => `${prefix}_${Math.floor(random() * 1e12).toString(36)}`,
    // WP122b 交付 ④：成文接模型（便宜档）。**配了才递**：没配模型时退回按令牌
    // 直述的那一版并在版本历史里如实标注（`composeDesignProse` 的 fallback）。
    // 计量与封顶在 `composeDesignProse` 里：与 WP121 同一套预估、封顶 1 积分。
    ...(boot.ownModels.configured()
      ? {
          modelFor: ({ actor, run_id }) => {
            const ref = boot.ownModels.defaultRef()
            // 一条真 provider 都没有（只有 stub）：stub 回的是确定性假话，
            // 当成"没配模型"处理，不拿假话当正文。
            if (ref.provider === 'stub') return undefined
            return async ({ prompt }) => {
              const completion = await boot.ownGateway.complete({
                messages: [{ role: 'user', content: prompt }],
                meta: {
                  workspace_id: workspace.id,
                  assignment_id: actor.assignment_id,
                  role_id: actor.role_id,
                  run_id: run_id as never,
                  purpose: 'extraction',
                },
                model: ref,
              })
              return { text: completion.text }
            }
          },
        }
      : {}),
    // WP122b 交付 ⑤ → WP127：看图走用户配置的那一个模型（同一条默认 ref）——文字模型
    // 就是多模态，不再有单独的视觉档。配了就必走；模型看不了图时网关按能力声明拦下，
    // 成文把「当前模型看不了图」写进版本历史。只有 stub（没接模型）回 undefined。
    // 看图的消息经 ChatMessage 的图片部件进网关（交付 ⑤ 的契约改动）。
    imageFetch: globalThis.fetch as never,
    ...(boot.ownModels.configured()
      ? {
          visionFor: ({ actor, run_id }) => {
            const ref = boot.ownModels.defaultRef()
            if (ref.provider === 'stub') return undefined
            return async ({ image, prompt }) => {
              const completion = await boot.ownGateway.complete({
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: prompt },
                      {
                        type: 'image',
                        mime: imageMimeOf(image),
                        data: Buffer.from(image).toString('base64'),
                      },
                    ],
                  },
                ],
                meta: {
                  workspace_id: workspace.id,
                  assignment_id: actor.assignment_id,
                  role_id: actor.role_id,
                  run_id: run_id as never,
                  purpose: 'extraction',
                },
                model: ref,
              })
              return { text: completion.text }
            }
          },
        }
      : {}),
    pages: () =>
      brandIntake
        .latestDocuments(workspace.id)
        .filter((d) => d.kind === 'home' || d.kind === 'product' || d.kind === 'collection')
        .map((d) => ({ url: d.url, kind: designPageKindOf(d.url), html: d.html })),
    // WP122b 交付 ⑥：已连接 Shopify 时读主题设置（配色与字体进 `theme` 档）。
    // 没连接 / 那两条只读 Action 不在 / 读不到 → undefined，整档跳过。
    themeSettings: async () => {
      const connection = boot.connections
        .liveConnections()
        .find((c) => c.service.startsWith('shopify') && c.status === 'active')
      if (connection === undefined) return undefined
      return shopifyThemeSettings(boot.connections.connect, connection)
    },
    readUpload: async (upload_id) => {
      const source = knowledge.intake.getSource(upload_id)
      if (source === undefined || source.workspace_id !== workspace.id) return undefined
      if (source.deleted_at !== undefined) return undefined
      const file = await knowledgeSourceFile(source, {
        ...(dbDir === undefined ? {} : { dataDir: dbDir }),
        ...(blobs === undefined ? {} : { blobs }),
      })
      if (file === undefined) return undefined
      return { filename: file.filename, bytes: file.bytes }
    },
  })
  // 四个岗位出活时经 `brandDesignRef` 取这一份（见它声明处那条注释）
  brandDesignRef = brandDesign

  /**
   * WP65（52 O1）：组织（公司）与它下面的品牌工作区。
   *
   * 装在首次设置**之后**——启动时的一次性迁移要读公司档案里的三个字段
   * （全称 / 域名 / 发现开关）才建得出第一个组织。之后这三样的真源就是组织，
   * 档案里那三个位只是同步写下来的影子。
   */
  /**
   * 品牌一览里的"今日销售"。
   *
   * 取的是**那个品牌首页面板同一个数据源**——不是另起一条查询，也不是另一份缓存。
   * 日界线按那个品牌的时区偏移切（与 `@agentsws/deck` 的窗口算法同一条规矩）。
   *
   * WP66：按 `workspace_id` 取模块，所以**每个品牌都算得出来**；WP65 那句
   * "切过去才看得到"到此为止。一张订单都没有就回 `undefined`——没有就明说没有，
   * 不画一个 0（36 §3）。
   */
  const salesTodayOf = async (
    ws: WorkspaceId,
  ): Promise<{ amount: number; currency: string } | undefined> => {
    const source = (await brandModules.forWorkspace(ws)).workData
    const orders = source.orders()
    if (orders.length === 0) return undefined
    const offset = source.tz_offset_minutes * 60 * 1000
    const dayOf = (ms: number): number => Math.floor((ms + offset) / 86_400_000)
    const today = dayOf(Date.parse(clock.now()))
    const amount = orders
      .filter((o) => dayOf(Date.parse(o.created_at)) === today)
      .reduce((sum, o) => sum + o.total_price, 0)
    return { amount, currency: source.base_currency }
  }

  const organizations = createOrganizationsAssembly({
    clock,
    identity,
    roles,
    approvals,
    appendEvent,
    currentWorkspace: () => workspace.id,
    brandProfile: (ws) => onboarding.brandProfile(ws),
    setBrandProfile: (ws, profile) => {
      onboarding.setBrandProfile(ws, profile)
    },
    // 品牌一览那一格的"今日销售"：与**那个品牌**首页面板同一个数据源
    salesToday: (ws) => salesTodayOf(ws),
    // 52 O4：从某个品牌复制设置——现在连模型设置也复制得了（key 不复制）
    copyModelSettings: async (from, to) => {
      const source = await brandModules.models(from)
      const target = await brandModules.forWorkspace(to)
      return target.ownModels.importSettings(source.exportSettings())
    },
    setInheritOrg: (ws, inherit) => brandModules.setInheritOrg(ws, inherit),
    inheritsOrg: (ws) => brandModules.inheritsOrg(ws),
    // WP66：新品牌建完补签一把云令牌（这家公司关联过账号才有得签）
    onBrandCreated: async (ws) => {
      // WP215：新品牌的后台**立刻**常驻起来（处理器 + 系统任务），不用等重启；
      // 放在补签云令牌之前——云连不上不该拖住它收信、巡检
      await startBrandBackground(ws)
      await cloudAccount.ensureBrandToken(ws)
    },
    // WP215：品牌一览 / 切换器每一行那一格
    backgroundOf: (ws) => background.status(ws),
    // 发现开关的真源在组织上，但"开 / 关"这个动作在首次设置那一面——两边改都得生效
    onCompanyChanged: ({ by, discoverable, key_changed }) => {
      // WP251：公司页改了公司——各品牌档案里公司那几格的影子跟着刷（读一律读公司）
      onboardingRef?.syncCompanyShadows(workspace.id)
      if (!discoverable) {
        onboarding.discovery.disable(by)
        return
      }
      onboarding.discovery.enable(by)
      // 名字 / 域名变了 → 钥匙变了 → 用新钥匙重新广播，否则还在拿旧钥匙找同事
      if (key_changed) onboarding.discovery.refresh()
    },
  })
  const company = onboarding.companyProfile()
  bootstrapOrg = (
    await organizations.migrate({
      workspace_id: workspace.id,
      ...(company?.legal_name === undefined ? {} : { legal_name: company.legal_name }),
      ...(company?.domain === undefined ? {} : { domain: company.domain }),
      ...(company?.discoverable === undefined ? {} : { discoverable: company.discoverable }),
    })
  ).id
  // 档案建出来了，把品牌级档案那个晚绑定的读法接上（48 v2 L2、51 §1 N0、WP66）
  onboardingRef = onboarding
  /*
   * WP251：公司级那几格（全称 / 邮箱后缀 / 发现 / 地址）归到公司上——先备份全部品牌档案，
   * 公司没有地址就从品牌档案搬一份，各品牌档案里的影子刷成公司的值。一次性、幂等。
   * 再认一遍存量加的品牌：已经分过岗位的当作走完过首次设置（决策 92 的新口径不把它们拉回向导）。
   */
  onboarding.settleCompanyOnOrganization()
  // WP251（决策 91）：「卡住了」改看结构化标记——起点记在这一刻（第一次启动这一版时）
  onboarding.since(RUN_BLOCK_MARKED_SINCE)
  onboarding.settleAddedBrandCompletion(identity.brandsOf(bootstrapOrg).map((w) => w.id))
  /*
   * WP240：一次性自检加的品牌的档案——建品牌那一刻自动起、还没人用过的那几份标回「待设置」，
   * 这些品牌切过去就会进首次设置（以前永远判成"设过了"）。跑过一次就记下，不再跑。
   */
  {
    const checked = onboarding.reconcileBrandProfiles(
      identity.brandsOf(bootstrapOrg).map((w) => ({ workspace_id: w.id, name: brandNameOf(w) })),
    )
    if (checked.reopened.length > 0 && options.quiet !== true)
      process.stderr.write(
        `[onboarding] ${String(checked.reopened.length)} 个加的品牌还没走过首次设置，切过去会进向导\n`,
      )
  }

  // WP50 Join 向导（20 §4–§5、45）：个人工作区并进公司。装在 org 之后——
  // 它要读同一份职责层（品牌 / 产品线 / 分配），并往同一条审批总线上建 `join_mapping`。
  const joinAssembly = createJoin({
    clock,
    workspace_id: workspace.id,
    roles,
    approvals,
    appendEvent,
    // Join 向导只在 bootstrap 品牌那一档跑（20 §4：个人工作区并进公司）
    connect: boot.connections.connect,
    ...(dbDir === undefined ? {} : { dbDir }),
  })

  // WP36 离职编排（40 §1.2）：装在 org 之后——它要撤分配、真转事项、动个人层与个人记忆。
  const offboard = createOffboard({
    workspace_id: workspace.id,
    clock,
    appendEvent,
    identity,
    roles,
    approvals,
    work,
    skills: skills.registry,
    lessons: learning.learning.pool,
    memory: knowledge.memory,
    schedule: schedule.store,
    ...(dbDir === undefined ? {} : { dbDir }),
    // WP174：离职的人若是岗位上级 → 清空、提醒老板、改派他手上的卡
    onLeft: (person_id, by) => org.onMemberLeft(person_id, by),
  })

  const knowledgePort: KnowledgePort = {
    search: (q) => knowledge.retrieval.search(q),
    cards: (filter, actor) => knowledge.store.list(filter, actor),
    card: (id, actor) => knowledge.store.get(id, actor),
    health: (workspace_id) => knowledge.store.health(workspace_id),
    // WP33 / 19 §3：引用计数
    cite: (_actor, fact_card_id, run_id) => knowledge.retrieval.cite(fact_card_id, run_id),
    // WP35：19 §1.3 导入源与 §4 缺口队列有表了（`knowledge.intake`），四条路由不再 501
    sources: (actor) => knowledge.intake.sources(actor.workspace_id),
    addSource: (actor, input) =>
      knowledge.intake.addSource({ ...input, workspace_id: actor.workspace_id }),
    // WP97（36 §11 #13）：按 source_id 取原件字节。**只读、不转换**——
    // 官方那一侧在服务端起 LibreOffice 转 PDF，我们把渲染整个留给浏览器（纯 JS）。
    // 不是本工作区的源当成不存在：让它 404 而不是 403，省得把"这个 id 存在"说出去。
    sourceFile: async (actor, id) => {
      const source = knowledge.intake.getSource(id)
      if (source === undefined || source.workspace_id !== actor.workspace_id) return undefined
      // 软删过的（WP99 的墓碑）当不存在：字节已经不在了，读它只会拿到 undefined，
      // 但把这一步写明比靠 blob 读不到兜底清楚
      if (source.deleted_at !== undefined) return undefined
      return knowledgeSourceFile(source, {
        ...(dbDir === undefined ? {} : { dataDir: dbDir }),
        ...(blobs === undefined ? {} : { blobs }),
      })
    },
    /*
     * WP99（19 §1.3「上传」）：**收一份文件**。顺序是死的，一步都不能换：
     *
     * 1. 过六道闸（`knowledge-upload.ts`，纯函数：大小 / 扩展名白名单 / 文件名洗净 /
     *    magic bytes 与扩展名对得上 / 不信客户端 MIME / 纯文本档反着判）；
     * 2. 进对象存储（`blob://<key>`，key 是 `<工作区>/<sha256>.<扩展名>`；
     *    `subject_ref` = 工作区 → 走信封加密，销毁这个主体的密钥 = 它的每一份
     *    原件当场读不出来，21 §4）；
     * 3. 登记成一条 `kind: 'upload'` 的源，带上"谁传的、何时、sha256、多大"，
     *    并发一条 `knowledge.source.added` 进事件日志（溯源链）。
     *
     * 闸在**存之前**：把字节先落盘再判，等于在数据目录里留下一份判不合格的东西。
     */
    uploadSource: async (actor, input) => {
      const checked = checkUpload(input)
      if (blobs === undefined) {
        throw new UploadRejected(
          '这个服务进程没有开对象存储（内存档），存不下上传的文件。',
          'not_implemented',
        )
      }
      const key = uploadBlobKey(actor.workspace_id, checked.sha256, checked.extension)
      await blobs.put(key, input.bytes, {
        filename: checked.filename,
        content_type: checked.content_type,
        subject_ref: uploadSubjectRef(actor.workspace_id),
        workspace_id: actor.workspace_id,
      })
      return knowledge.intake.addSource({
        workspace_id: actor.workspace_id,
        kind: 'upload',
        ref: blobUri(key),
        // 19 §1.3：文档档一律 anydoc（真正的解析在下游，这条路上不解）
        parser: 'anydoc',
        acl_inherit: false,
        upload: {
          filename: checked.filename,
          uploaded_by: actor.person_id,
          uploaded_at: clock.now(),
          content_sha256: checked.sha256,
          size: checked.size,
        },
      })
    },
    /*
     * WP99：删一个导入源。**先删字节，再立墓碑**——反过来的话，中间崩一次
     * 就留下一条"看着已经删了、字节还在盘上"的记录，而那是最坏的一种状态。
     *
     * 同一份内容被两条源共用是可能的（key 是内容 hash）。所以删字节之前先看
     * 还有没有别的活着的源指着同一个 `ref`：有就只立墓碑、不删字节。
     */
    deleteSource: async (actor, id) => {
      const source = knowledge.intake.getSource(id)
      if (source === undefined || source.workspace_id !== actor.workspace_id) return false
      if (source.deleted_at !== undefined) return false
      const shared = knowledge.intake
        .sources(actor.workspace_id)
        .some((s) => s.id !== id && s.ref === source.ref)
      if (!shared && blobs !== undefined && source.ref.startsWith('blob://')) {
        await blobs.delete(blobKey(source.ref))
      }
      return knowledge.intake.deleteSource(id) !== undefined
    },
    gaps: (actor, filter) => knowledge.intake.gaps(actor.workspace_id, filter),
    openGap: (actor, input) =>
      knowledge.intake.openGap({
        ...input,
        workspace_id: actor.workspace_id,
        asked_by: { kind: 'person', id: actor.person_id },
      }),
    // 19 §4：答案**不直接进知识库**，先变一张 knowledge_update 卡（批了才由 learning 施行）
    answerGap: async (actor, id, input) => {
      const gap = knowledge.intake.requireGap(id)
      const card = await approvals.create({
        workspace_id: actor.workspace_id,
        schema_version: 1,
        kind: 'knowledge_update',
        role_id: actor.role_id,
        subject: { object: { type: 'knowledge_gap', id: gap.id } },
        dedupe_key: `${actor.workspace_id}:knowledge_update:gap:${gap.id}`,
        title: `补一条知识：${gap.question.slice(0, 40)}`,
        summary: '有人答了缺口队列里的一条。批准后写进知识库并激活（19 §4）。',
        payload: {
          layer: input.layer ?? 'fact',
          statement: input.answer,
          candidate_key: gap.subject.key,
          gap_id: gap.id,
        },
        evidence: {
          source_events: [],
          provenance: { seen: [{ type: 'knowledge_gap', id: gap.id }] },
          diff: { before: null, after: input.answer, summary: '知识库新增一条' },
          precheck: {},
        },
        proposer: { kind: 'person', id: actor.person_id, assignment_id: actor.assignment_id },
        automation: { level_at_creation: 'L1' },
        routing: {
          recipients: [{ person: actor.person_id, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: {
            after_hours: 72,
            business_hours: true,
            chain: ['owner'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        priority: 'queue',
      })
      return knowledge.intake.answerGap(id, {
        answer: input.answer,
        by: actor.person_id,
        ...(card.state === 'blocked' ? {} : { approval_item_id: card.id }),
      })
    },
    // WP56（48 §4 #6）：源页复核队列
    rechecks: (actor, filter) =>
      knowledge.recheck.list(actor.workspace_id, {
        ...(filter.status === undefined ? {} : { status: filter.status as RecheckStatus }),
      }),
    resolveRecheck: (actor, id, input) =>
      knowledge.recheck.resolve(id, { resolution: input.resolution, by: actor.person_id }),
    /**
     * WP56（36 §2.2）：15 条业务边界里哪几条答过。
     *
     * **答案不另存一张表**——它就在知识库里。这一条把注册表与知识库对一遍：
     * 剩下的那几条就是「Agent 下次撞到时会问你」的清单。
     */
    boundaries: async (actor) => {
      const cards = await knowledge.store.list(
        { workspace_id: actor.workspace_id, status: 'active' },
        actor,
      )
      const answered = detectAnsweredBoundaries({
        texts: cards.map((c) => c.statement),
        structured: cards.flatMap((c) => (c.structured === undefined ? [] : [c.structured])),
        at: clock.now(),
      })
      return SUPPORT_BOUNDARIES.map((b) => ({
        id: b.id,
        label: b.label,
        question: b.question,
        answered: answered.some((p) => p.boundary_id === b.id),
        options: b.options.map((o) => ({ id: o.id, label: o.label })),
      }))
    },
    // WP56（48 §4 #9）：知识包导入 / 导出。zip 在这一层解与打，网关只转字节
    importPack: (actor, input) => importKnowledgePack(knowledge, actor, input, { clock }),
    exportPack: async (actor) => {
      const cards = await knowledge.store.list({ workspace_id: actor.workspace_id }, actor)
      const files = cardsToPack(cards, {
        name: actor.workspace_id,
        version: '1',
        generated_at: clock.now(),
      })
      return {
        filename: `knowledge-pack-${actor.workspace_id}.zip`,
        zip: new Uint8Array(zipFiles(files)),
      }
    },
  }

  /**
   * WP71（36 §10）/ WP71b：**记忆的那两道门**——看得见（read）与改得动（write）。
   *
   * 判据在 `learning.ts` 的 `canReadMemory` / `canEditMemory`（纯函数、单测钉住）；
   * 这里只把它们要的三样现查出来：本人名下没撤销的那几条职责、岗位模板、是不是 owner。
   * 两道门共用同一份事实，所以界面上的 `can_edit` 与网关上的 403 永远说的是同一件事。
   */
  const memoryFacts = (actor: {
    person_id: PersonId
    workspace_id: WorkspaceId
  }): { held_roles: string[]; positions: ReturnType<typeof org.positions>; is_owner: boolean } => {
    const held = roles.assignments
      .listByPerson(actor.person_id, { workspace_id: actor.workspace_id })
      .filter((a) => a.revoked_at === undefined)
    return {
      held_roles: held.map((a) => a.role_id),
      positions: org.positions(),
      is_owner: held.some((a) => a.role_id === 'common.owner'),
    }
  }

  const memoryGate = (
    actor: { person_id: PersonId; workspace_id: WorkspaceId },
    target: { tier: SkillTier; scope_id?: string },
  ): { ok: boolean; reason?: string } =>
    canEditMemory({
      tier: target.tier,
      ...(target.scope_id === undefined ? {} : { scope_id: target.scope_id }),
      ...memoryFacts(actor),
    })

  const memoryReadGate = (
    actor: { person_id: PersonId; workspace_id: WorkspaceId },
    target: { tier: SkillTier; scope_id?: string },
  ): { ok: boolean; reason?: string } =>
    canReadMemory({
      tier: target.tier,
      ...(target.scope_id === undefined ? {} : { scope_id: target.scope_id }),
      ...memoryFacts(actor),
    })

  const assertMemory = (
    actor: { person_id: PersonId; workspace_id: WorkspaceId },
    target: { tier: SkillTier; scope_id?: string },
  ): void => {
    const verdict = memoryGate(actor, target)
    if (!verdict.ok) throw new ApiError('forbidden', verdict.reason ?? '改不了这一层的记忆')
  }

  /** 条目 id → 它落在哪一层（`m:role:dtc.store:…`）。认不出就是 400。 */
  const refOf = (id: string): { tier: SkillTier; scope_id?: string } => {
    const ref = parseMemoryRef(id)
    if (ref === undefined) throw new ApiError('invalid_input', `认不出这条记忆：${id}`)
    return { tier: ref.tier, ...(ref.tier === 'company' ? {} : { scope_id: ref.owner }) }
  }

  const skillsPort: SkillsPort = {
    resolve: (name, actor) => skills.registry.resolve(name, actor),
    setOverlay: (overlay) => skills.registry.setOverlay(overlay),
    // WP29：池的真源是学习回路那一份（`skills.lessons` 是 WP6 的内存池，只留给周合并的老接口）
    lessons: (filter) => learning.lessons(filter),
    // WP29 技能页与学习回路
    // WP209：按岗位分组那几格（显示名 / 一句话 / 哪几条职责在用 / 归哪个岗位）只往上加
    // WP216：平台专属的官方技能（Shopify 那几本）只在这个品牌的平台对得上时列出来
    list: async (actor) =>
      enrichSkillSummaries(
        (await learning.summaries(actor)).filter((s) =>
          skillOnPlatform(s.name, brandPlatformOf(actor.workspace_id)),
        ),
        {
          positions: org.positions(),
          roles: roles.roles.list(),
          held_roles: memoryFacts(actor).held_roles,
          frontmatterOf: (name) => skills.registry.frontmatterOf(name),
          sectionBody: (name, id) => skills.registry.sectionBody(name, id),
          superseded: SUPERSEDED_POSITION_IDS,
        },
      ),
    exclude: (name, person_id, excluded) => skills.registry.exclude(name, person_id, excluded),
    proposals: () => learning.proposalSummaries(),
    promote: (input) =>
      learning.promote({
        skill: input.skill,
        section_ids: input.section_ids,
        to_tier: input.to_tier,
        ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
        by: input.actor.person_id,
      }),
    // WP69（54 §3）：第三栏「记忆」面板按层读；WP71 多回一格"能不能改"
    memory: async (input) => ({
      summary: learning.memorySummary({
        tier: input.tier,
        ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
      }),
      entries: learning.memoryAt({
        tier: input.tier,
        ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
      }),
      can_edit: memoryGate(input.actor, {
        tier: input.tier,
        ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
      }).ok,
    }),
    // WP71（36 §10）：手动加 / 改 / 删本层的一条。越层一律 403
    addMemory: async (input) => {
      assertMemory(input.actor, {
        tier: input.tier,
        ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
      })
      return learning.addMemory({
        tier: input.tier,
        ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
        text: input.text,
        ...(input.heading === undefined ? {} : { heading: input.heading }),
        ...(input.skill === undefined ? {} : { skill: input.skill }),
        by: input.actor.person_id,
      })
    },
    updateMemory: async (input) => {
      assertMemory(input.actor, refOf(input.id))
      return learning.updateMemory(input.id, {
        text: input.text,
        ...(input.heading === undefined ? {} : { heading: input.heading }),
      })
    },
    deleteMemory: async (input) => {
      assertMemory(input.actor, refOf(input.id))
      await learning.removeMemory(input.id)
    },
    // WP71b：网关问"这一层看不看得见 / 改不改得动"，判据仍是服务端这一份
    memoryAccess: async (input) => {
      const target = {
        tier: input.tier,
        ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
      }
      const read = memoryReadGate(input.actor, target)
      return {
        read: read.ok,
        write: memoryGate(input.actor, target).ok,
        ...(read.reason === undefined ? {} : { reason: read.reason }),
      }
    },
  }

  /**
   * 15 §7 `POST /guardrails/evaluate`：只评估不 stage。
   * 额度取该 Assignment 上匹配 change_kind 的动作；累计类事实（窗口计数 / 累计幅度）
   * 属于账本内部状态，预览不读它们——预览是「下限」，真正的判定仍在 stage / apply 两次评估。
   */
  const guardrails: GuardrailPort = {
    evaluate: async (input) => {
      const config = roles.effectiveConfig(input.assignment_id)
      const action = config.actions.find((a) => changeKindOf(a.id) === input.change.kind)
      return evaluateGuardrail(
        input.change,
        action?.mandate ?? { caps: {} },
        { now: input.at, changeSet: [], windowCount: 0 },
        input.phase,
      )
    },
  }

  // 21 §1：读是合一的那一条（服务进程 + 接进来的世界）；写只写自己的
  const merged = mergeEventLogs(kernel.eventLog, mount?.eventLog)
  const eventLogPort: EventLogPort = {
    read: (filter) => merged.read(filter),
    append: appendEvent,
  }

  // 13 §5 浏览器会话：桌面壳生成、经环境变量交给服务进程；不设就没有 cookie 那条路
  const sessionKey = env.AGENTSWS_SESSION_KEY?.trim() === '' ? undefined : env.AGENTSWS_SESSION_KEY
  let boundPort: number | undefined

  /**
   * WP58（49 M1）：关联 agentsws 云账号。装在这儿是因为它要 `boundPort`
   * ——回调地址是本机的回环口，端口要等 listen 之后才知道，所以传的是取值函数。
   * 令牌进的是上面那个**同一个**加密库（前缀 `cloud.`）。
   */
  const cloudAccount: CloudAccountAssembly = createCloudAccount({
    secrets,
    clock,
    env,
    appendEvent,
    workspace_id: () => workspace.id,
    // WP66（52 O1）：账号在组织级，令牌按工作区签 —— 关联一次给每个品牌各签一把
    brands: () => brandsOfThisOrg(),
    secretsFor: (ws) => namespaceSecrets(secrets, secretsPrefixOf(ws, workspace.id)),
    localBaseUrl: () => (boundPort === undefined ? undefined : `http://127.0.0.1:${boundPort}`),
    ...(options.cloudFetch === undefined ? {} : { fetch: options.cloudFetch }),
  })

  scopeAutoUpgrade = createScopeAutoUpgrade({
    upgrade: (ws) => cloudAccount.upgradeScopes(ws),
    missingOf: (ws) => cloudAccount.missingScopesOf(ws),
    brands: () => brandsOfThisOrg(),
    nowMs: () => Date.parse(clock.now()),
  })
  // WP272：启动时后台补一次（不等它、不挡启动；断网就等下一跳撞上再补）
  void scopeAutoUpgrade.sweep().catch(() => undefined)

  /*
   * WP233：本机负责人的登录邮箱跟云账号对齐（只改占位 `owner@localhost`，可重复跑）。
   * 两个时机：刚关联上（事件钩子），以及**启动时补一次**——老工作区早就关联了云账号，
   * 邮箱却还是占位。改不成（云不在、邮箱被别人占了）不影响启动与关联本身。
   */
  const ownerEmailAlign = {
    identity,
    owner_id: person.id,
    workspace_id: workspace.id,
    cloudEmail: async () => {
      const view = await cloudAccount.port.status(workspace.id)
      return view.linked ? view.email : undefined
    },
    appendEvent,
  }
  let ownerEmailQueue: Promise<unknown> = Promise.resolve()
  cloudLinkedSink = () => {
    ownerEmailQueue = ownerEmailQueue
      .then(() => alignOwnerEmail(ownerEmailAlign, 'cloud_account_linked'))
      .catch(() => undefined)
  }
  try {
    await alignOwnerEmail(ownerEmailAlign, 'cloud_account_backfill')
  } catch {
    // 补不上就下次启动再补；不挡启动
  }

  /**
   * 41 §1 秘书 Agent。装在最后：它要用到工作模型、会议、工具箱、审批总线与调度器，
   * 自己不被任何人依赖——秘书是**加分项**，拆掉它工作台照常能用。
   */
  /*
   * WP215：**每个品牌各一份**（工作区、工作模型、定时任务、出的卡都是那个品牌的）。第一个品牌
   * 那一份就是原来那个（落盘还在原来的目录）；别的品牌第一次被问到时建，落各自的品牌目录。
   */
  const secretaryFor = (ws: WorkspaceId, brandWork: Work, tz_offset_minutes: number) =>
    createSecretaryAssembly({
      workspace_id: ws,
      // WP234：人员页岗位徽章按安放归堆（制度层那张表；org 晚一步装好，这里现查）
      positionOfAssignment: (a) => org.positionLabelOf(a),
      clock,
      random,
      appendEvent,
      tz_offset_minutes,
      // WP181：代答也带「现在时间 + 公司时区」（与运行时同一条 ContextItem）
      timeZone: async () => (await identity.getWorkspace(ws))?.tz,
      ...(brandDirOf(dbDir, ws, workspace.id) === undefined
        ? {}
        : { dbDir: brandDirOf(dbDir, ws, workspace.id) as string }),
      identity: {
        members: (ws) => identity.members(ws),
        getPerson: (id) => identity.getPerson(id),
      },
      roles,
      work: brandWork,
      approvals,
      meetings: {
        list: (filter) => meetings.store.listMeetings(filter),
        get: (id) => meetings.store.getMeeting(id),
        create: (input) => meetings.store.createMeeting(input),
      },
      catalog: catalog.port,
      // 25：本人的定时任务也占日程（37 §2 表第四行）
      scheduledTasks: (person_id) =>
        schedule.scheduler
          .list({ workspace_id: ws, owner: person_id })
          // 还没算出下一次触发时刻的（暂停 / 一次性已跑完）不占日程
          .flatMap((t) =>
            t.next_fire_at === undefined
              ? []
              : [
                  {
                    id: t.id,
                    state: t.state,
                    next_fire_at: t.next_fire_at,
                    ...(t.title === undefined ? {} : { title: t.title }),
                    assignment_id: t.assignment_id,
                  },
                ],
          ),
    })
  const secretary = secretaryFor(workspace.id, work, workData.tz_offset_minutes)
  const secretaries = new Map<WorkspaceId, SecretaryAssembly>([[workspace.id, secretary]])
  const secretaryOf = async (ws: WorkspaceId): Promise<SecretaryAssembly> => {
    const known = secretaries.get(ws)
    if (known !== undefined) return known
    if (!background.isBrand(ws)) return secretary
    const brand = await brandModules.forWorkspace(ws)
    const made =
      secretaries.get(ws) ??
      secretaryFor(
        ws,
        liveBrand(ws, (b) => b.work),
        brand.workData.tz_offset_minutes,
      )
    secretaries.set(ws, made)
    return made
  }

  /*
   * WP57：在线客服面。`ChatPort` 只做投影——判定、卡片、模型都在 `./chat.ts` 里，
   * 网关这一层不写业务（28 §2）。
   *
   * 端出去的会话**不带 `visitor_id`**：那是受控原始材料区的加密主体键
   * （21 §4 随主体删除按它走），没有任何界面需要它。
   *
   * WP66：一个品牌一份投影。鉴权过的那几条路由经 `scoped()` 取自己品牌那一份；
   * 公开访客那几条（widget.js / widget-config / public/*）没有主体可分发，
   * 走 bootstrap 那一份——52 O5「一个值守子进程一个品牌工作区」，公开聊天窗
   * 本来就是那一档。
   */
  /** WP128：聊天窗设置页「转发方式」第三项那几条（订阅 / 状态 / 取回 / 覆盖）。 */
  const hostedOwnerPortOf = (
    brand: BrandModuleSet,
  ): Pick<
    ChatPort,
    | 'relayHosted'
    | 'relayHostedSubscribe'
    | 'relayHostedCancel'
    | 'relayHostedBringHome'
    | 'relayHostedSeed'
  > => {
    const client = createHostedOwnerClient({
      cloud_base_url: cloudBaseUrl(env),
      token: () => {
        if (!brand.secrets.available) return undefined
        try {
          const token = brand.secrets.get(CLOUD_TOKEN_SECRET_ID)?.token
          return token === undefined || token === '' ? undefined : token
        } catch {
          return undefined
        }
      },
      workspace_id: brand.workspace_id,
      clock,
      ...(brand.dir === undefined
        ? {}
        : { dataDir: brand.dir, backupDir: backupDirOf(env, brand.dir) }),
      ...(options.cloudFetch === undefined
        ? {}
        : { fetch: options.cloudFetch as unknown as OwnerFetch }),
    })
    return {
      relayHosted: () => client.status(),
      relayHostedSubscribe: () => client.subscribe(),
      relayHostedCancel: () => client.cancel(),
      relayHostedBringHome: () => client.bringHome(),
      relayHostedSeed: () => client.seed(),
    }
  }

  const chatPortOf = (brand: BrandModuleSet): ChatPort => {
    const lane = brand.chat
    const widget = brand.chatWidget
    return {
      openSandbox: async (person_id) => chatView(await lane.openSandbox(person_id)),
      sessions: async (filter) => (await lane.sessions(filter)).map((s) => chatView(s)),
      session: async (id) => {
        const found = await lane.session(id)
        return found === undefined ? undefined : chatView(found)
      },
      messages: async (session_id, limit) =>
        (await lane.messages(session_id, limit)).map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          at: m.at,
          ...(m.plan_action === undefined ? {} : { plan_action: m.plan_action }),
        })),
      send: async (input) => chatTurnView(await lane.receive(input)),
      // `force`：这条路由就是"这一轮我说完了，现在就判"（沙盒页那颗「发」按钮）。
      // 只跳过 2 秒静默窗口，别的一个不跳。真访客那一路由车道自己的定时器驱动。
      advance: async (session_id) =>
        chatTurnView(await lane.advanceTurn(session_id, { force: true })),
      setTakeover: async (id, on) => chatView(await lane.setTakeover(id, on)),
      teach: async (input) => {
        const out = await lane.teach({ ...input, taught_by: input.taught_by })
        return {
          outcome: out.outcome,
          sediment: out.sediment,
          ...(out.reply === undefined ? {} : { reply: out.reply }),
        }
      },
      touch: async (session_id) => {
        await lane.touch(session_id)
      },
      subscribe: (session_id, listener) => {
        const sub = lane.stream.subscribe(session_id, (frame) =>
          listener(frame as unknown as Record<string, unknown> & { type: string }),
        )
        return () => sub.stop()
      },
      // WP60：公开访客那一面。四道门（白名单 / 限流 / 访客令牌 / 凭据不进 URL）
      // 全在 `chat-widget.ts` 里，网关这一层只做投影
      widgetConfig: () => widget.config(),
      setWidgetConfig: (input) => widget.setConfig(input),
      allowedOrigin: (origin) => widget.allowedOrigin(origin),
      publicWidgetConfig: (origin) =>
        widget.publicConfig(origin) ?? { enabled: false, accent: DEFAULT_ACCENT, greeting: '' },
      openPublic: (input) => widget.open(input),
      verifyVisitor: (session_id, token) => widget.verify(session_id, token),
      widgetScript: () => CHAT_WIDGET_JS,

      // ── WP124 转发器（三种部署同一套设置与状态；密钥只在 brand.relay 里） ──
      relaySettings: () => {
        const endpoint = brand.relay.secret('endpoint')
        return {
          ...(endpoint === undefined ? {} : { endpoint }),
          has_pairing_token: brand.relay.secret('pairing_token') !== undefined,
          has_message_key: brand.relay.secret('message_key') !== undefined,
          configured: endpoint !== undefined && brand.relay.secret('pairing_token') !== undefined,
        }
      },
      setRelaySettings: async (input) => {
        if (input.endpoint === null) {
          brand.relay.setSecrets(null)
        } else {
          const fields: Record<string, string> = {}
          const endpoint = input.endpoint ?? brand.relay.secret('endpoint')
          if (endpoint !== undefined) fields.endpoint = endpoint
          const pairing = input.pairing_token ?? brand.relay.secret('pairing_token')
          if (pairing !== undefined) fields.pairing_token = pairing
          const messageKey = input.message_key ?? brand.relay.secret('message_key')
          if (messageKey !== undefined) fields.message_key = messageKey
          if (Object.keys(fields).length > 0) brand.relay.setSecrets(fields)
        }
        // 设置变了：重建连接（停掉旧的那条，按新设置重连）
        brand.relay.client.stop()
        brand.relay.client.start()
        const endpoint = brand.relay.secret('endpoint')
        return {
          ...(endpoint === undefined ? {} : { endpoint }),
          has_pairing_token: brand.relay.secret('pairing_token') !== undefined,
          has_message_key: brand.relay.secret('message_key') !== undefined,
          configured: endpoint !== undefined && brand.relay.secret('pairing_token') !== undefined,
        }
      },
      relayTestConnection: async () => {
        const client = brand.relay.client
        const endpoint = brand.relay.secret('endpoint')
        if (endpoint === undefined)
          return {
            ok: false,
            detail: '还没填转发器地址。三种方式任选：官方托管（免费）/ 自建 / 客服增值服务。',
            client_state: client.state(),
          }
        if (brand.relay.secret('pairing_token') === undefined)
          return {
            ok: false,
            detail: '转发器地址填了，但配对密钥还没存。去设置里粘贴那把只显示一次的密钥。',
            client_state: client.state(),
          }
        // 转发器活着吗：连它的 /connect，不带 WebSocket 升级 → 426 都算"活着"
        try {
          const probe = await fetch(`${endpoint.replace(/\/$/, '')}/connect`, {
            headers: { upgrade: 'websocket' },
          })
          if (probe.status === 404)
            return {
              ok: false,
              detail: '这个地址上没有转发器。核对地址（要含 /relay/<工作区>）。',
              client_state: client.state(),
            }
        } catch {
          return {
            ok: false,
            detail: '连不上这个地址。核对网络与转发器是否在跑。',
            client_state: client.state(),
          }
        }
        if (client.state() === 'online')
          return {
            ok: true,
            detail: '转发器通，本机在线。可以贴嵌入代码了。',
            client_state: client.state(),
          }
        return {
          ok: true,
          detail: '转发器通。本机正在连（密钥不对的话会停在「未连接」）。',
          client_state: client.state(),
        }
      },
      relayStatus: async () => {
        const client = brand.relay.client
        const endpoint = brand.relay.secret('endpoint')
        const base: {
          state: string
          online: boolean
          endpoint?: string
          conversations_this_month?: number
          limit?: number
          unlimited?: boolean
          subscribed?: boolean
          offline_messages?: number
          hosted?: {
            state: 'running' | 'starting' | 'sleeping' | 'stopped'
            last_heartbeat_at?: string
          }
        } = {
          state: client.state(),
          online: client.state() === 'online',
          ...(endpoint === undefined ? {} : { endpoint }),
        }
        // 官方托管：本月数字在云侧的转发器对象里（取不到就说取不到，不编一个数）
        const status = await brand.relay.cloudStatus()
        if (status !== undefined) {
          if (status.conversations_this_month !== undefined)
            base.conversations_this_month = status.conversations_this_month
          if (status.limit !== undefined) base.limit = status.limit
          if (status.subscribed === true) {
            base.unlimited = true
            base.subscribed = true
          }
          if (status.offline_messages !== undefined) base.offline_messages = status.offline_messages
          // WP128：托管实例在不在跑（转发器那边的状态接口带着这一格）
          if (status.hosted !== undefined)
            base.hosted = {
              state: status.hosted.state,
              ...(status.hosted.last_heartbeat_at === undefined
                ? {}
                : { last_heartbeat_at: status.hosted.last_heartbeat_at }),
            }
        } else if (endpoint !== undefined) {
          base.unlimited = true
        }
        return base
      },
      // ── WP128 客服增值服务（「转发方式」第三项）：打云端的 /v1/support/*，令牌现取 ──
      ...hostedOwnerPortOf(brand),
      scoped: async (ws) => chatPortOf(await brandModules.forWorkspace(ws)),
    }
  }

  /**
   * WP66：三个"按品牌现取"的端口。
   *
   * 每个品牌的这三样都很轻（一个投影对象，不开库、不起定时器），所以按品牌建一次
   * 之后缓存在这张表里；真正的重活（连接、活数据源、渠道）在 `BrandModules` 里，
   * 这里只是把它们接到网关上。
   */
  const workPorts = new Map<WorkspaceId, WorkPort>()
  const workstationPorts = new Map<WorkspaceId, WorkstationPort>()
  const askPorts = new Map<WorkspaceId, AskPort>()

  const workPortFor = async (ws: WorkspaceId): Promise<WorkPort> => {
    const cached = workPorts.get(ws)
    if (cached !== undefined) return cached
    const brand = await brandModules.forWorkspace(ws)
    const port = createWorkPort({
      clock,
      work: brand.work,
      // WP264：事项页「正在做…」+ 实时步骤，输入卡上的「停」
      liveRun: (matter_id) => brand.runtime?.liveRun?.(matter_id),
      stopRuns: async (matter_id, reason) => {
        let stopped = 0
        for (const r of brand.runtime?.activeRuns() ?? [])
          if (r.matter_id === matter_id && (await brand.runtime?.stopRun(r.run_id, reason, 5_000)))
            stopped += 1
        return stopped
      },
      // WP237：从岗位开的事项里说话，用那条职责的分配接着做（还没定就先定，不落到负责人那条上）
      sayAt: async (actor, matter_id, text) =>
        (await positionsFor(ws)).sayAt({ matter_id, person_id: actor.person_id, text }),
      // 37 §2 表第三行：会议一定有时间，一定上日历
      meetings: (actor, range) => meetings.calendarItems(range, actor.workspace_id),
      /**
       * 只给本人这条队列里的卡（14 §7：别人的 token 与内容不出现在这里）。
       *
       * 状态要全的——`queue` 默认只回 pending / in_review，而今日战报数的正是
       * 「今天**已经**处理掉的」（37 §1 第 9 行）。等待类的计数在 work 端自己过滤，
       * 所以这里放全不会把「还有几张等你定」算多。
       */
      approvals: (actor) =>
        approvals.queue({
          workspace_id: actor.workspace_id,
          person_id: actor.person_id,
          lane: 'mine',
          state: [...QUEUE_STATES],
        }) as Promise<ApprovalItem[]>,
      orders: () => brand.workData.orders(),
      label: (ref) => brand.workData.label(ref),
      /*
       * WP74（37 §2.5）：统一日历的三条新图层。
       *
       * 品牌隔离就落在这三行上——`brand` 是 `forWorkspace(ws)` 取出来的那一套，
       * 所以社媒帖子与红人交付物永远只是**这个品牌**自己那一份（56 §2：九条渠道是
       * 九个真账号，串了品牌等于发错号）。
       */
      socialPosts: () =>
        brand.social.posts().map((p) => ({
          id: p.id,
          account_id: p.account_id,
          channel: p.channel,
          status: p.status,
          body: p.body,
          ...(p.scheduled_at === undefined ? {} : { scheduled_at: p.scheduled_at }),
          // 撞车是服务端算的（WP73 纪律 1）：格子上那个 ⚠ 与卡面上那句话同一份判据
          ...(p.scheduled_at === undefined
            ? {}
            : {
                conflicts: scheduleConflicts(
                  {
                    id: p.id,
                    account_id: p.account_id,
                    scheduled_at: p.scheduled_at,
                    body: p.body,
                  },
                  brand.social.posts(),
                  {
                    now: clock.now(),
                    tz_offset_minutes: workData.tz_offset_minutes,
                    // WP191：每日上限按渠道取（与卡面那一份同一个判据）
                    rules: scheduleRulesFor(p.channel),
                  },
                ).map((h) => h.message),
              }),
        })),
      kolDeliverables: () =>
        brand.kol.deliverables().map((d) => ({
          id: d.id,
          collaboration_id: d.collaboration_id,
          kind: d.kind,
          due_at: d.due_at,
          ...(d.submitted_at === undefined ? {} : { submitted_at: d.submitted_at }),
        })),
      // 52 O5：值守是**这个进程 bootstrap 出来的那个品牌**的事，别的品牌各有各的子进程
      standbyRenewals: (actor) => {
        const row = standby.renewal()
        return row === undefined || row.workspace_id !== actor.workspace_id ? [] : [row]
      },
      // WP69（54 §2）：职责入口的事项记下它走的是哪条职责（`X-Assignment` 反查）
      roleOf: (assignment_id) => roles.assignments.get(assignment_id)?.role_id,
      // 40 §2.2：周 / 月复盘里那一段"疑似重复"
      duplicates: async () =>
        (await catalog.duplicates(5)).map((d) => ({
          a: { id: d.a.id, title: d.a.title, owner: d.a.owner, kind: d.a.kind },
          b: { id: d.b.id, title: d.b.title, owner: d.b.owner, kind: d.b.kind },
          similarity: d.similarity,
          both_in_use: d.both_in_use,
          reasons: d.reasons,
        })),
    })
    workPorts.set(ws, port)
    return port
  }
  const workstationPortFor = async (ws: WorkspaceId): Promise<WorkstationPort> => {
    const cached = workstationPorts.get(ws)
    if (cached !== undefined) return cached
    const brand = await brandModules.forWorkspace(ws)
    const port = createWorkstationPort({ clock, roles, approvals, data: brand.workData })
    workstationPorts.set(ws, port)
    return port
  }
  const askPortFor = async (ws: WorkspaceId): Promise<AskPort> => {
    const cached = askPorts.get(ws)
    if (cached !== undefined) return cached
    const brand = await brandModules.forWorkspace(ws)
    const port = createAskPort({
      models: brand.ownGateway,
      work: brand.work,
      roles,
      appendEvent,
      label: (ref) => brand.workData.label(ref),
      card: async (actor, id) => {
        const items = (await approvals.queue({
          workspace_id: actor.workspace_id,
          person_id: actor.person_id,
          lane: 'mine',
        })) as ApprovalItem[]
        return items.find((i) => i.id === id)
      },
    })
    askPorts.set(ws, port)
    return port
  }
  /**
   * WP188「随便聊」：一个品牌一份（会话存这个品牌目录下的 `free-chat.sqlite`）。
   *
   * 模型与网关用**解析之后**的那一份（跟随公司默认时是公司默认品牌的）；联网搜索照 WP179 的规矩——
   * 数据接口路由里「用你的 DeepSeek 账号搜索」开着、而且登录了 DeepSeek 账号或填了 DeepSeek 官方 key
   * 才搜得了；每搜一次照 `model.usage{purpose: web_search}` 记一笔、`web.searched` 审计一条（只有查询串）。
   */
  const freeChatPorts = new Map<WorkspaceId, FreeChatPort>()
  const freeChatStores: FreeChatStore[] = []
  const freeChatPortFor = async (ws: WorkspaceId): Promise<FreeChatPort> => {
    const cached = freeChatPorts.get(ws)
    if (cached !== undefined) return cached
    const brand = await brandModules.forWorkspace(ws)
    const dir = brandDirOf(dbDir, ws, workspace.id)
    if (dir !== undefined) mkdirSync(dir, { recursive: true })
    const store = createFreeChatStore(dir === undefined ? undefined : join(dir, 'free-chat.sqlite'))
    freeChatStores.push(store)
    const searchCredential = async (endpoint: string): Promise<WebCredential | undefined> => {
      if (deepseekAccount.signedIn()) {
        const token = await deepseekAccount.resolveToken(endpoint)
        if (token !== undefined && token !== '') return { kind: 'account', token }
      }
      const key = (await brandModules.models(ws)).deepseekSearchKey()
      return key === undefined ? undefined : { kind: 'api_key', key }
    }
    const port = createFreeChatPort({
      clock,
      store,
      gateway: () => brandModules.gateway(ws),
      models: () => brandModules.models(ws),
      roleOf: (id) => roles.assignments.get(id)?.role_id,
      humanize: humanizeGatewayError,
      newId: (prefix) =>
        `${prefix}_${Date.parse(clock.now()).toString(36)}${random().toString(36).slice(2, 10)}`,
      credits: (model, usage) => chatCredits(pricingCatalog.current()?.pricing, model, usage),
      web: {
        status: async () => {
          if (brand.ownCloud.webSearchRoute().disabled.includes('deepseek_native'))
            return {
              available: false,
              reason: '「用你的 DeepSeek 账号搜索」在设置里关着，这一次先不联网回答。',
            }
          if (options.freeChatWebSearch !== undefined) return { available: true }
          const has =
            deepseekAccount.signedIn() || (await brandModules.models(ws)).hasDeepseekSearchKey()
          return has
            ? { available: true }
            : {
                available: false,
                reason:
                  '联网搜索要先登录 DeepSeek 账号，或者在「设置 → 模型」里填 DeepSeek 官方 key。',
              }
        },
        search: async (query, ctx, signal) => {
          const gateway = await brandModules.gateway(ws)
          const meta = {
            workspace_id: ws,
            assignment_id: ctx.actor.assignment_id,
            role_id: ctx.role_id,
            run_id: ctx.run_id,
            purpose: 'web_search' as const,
          }
          const audit = (results: number, ok: boolean, error?: string): void => {
            appendEvent({
              schema_version: 1,
              workspace_id: ws,
              type: 'web.searched',
              actor: { kind: 'person', id: ctx.actor.person_id },
              correlation: { trace_id: `trc_${ctx.run_id}`, run_id: ctx.run_id },
              payload: {
                run_id: ctx.run_id,
                role_id: ctx.role_id,
                queries: [query],
                results,
                ok,
                entry: 'free_chat',
                ...(error === undefined ? {} : { error }),
              },
            })
          }
          try {
            let found: { sources: readonly { url: string; title?: string; snippet?: string }[] }
            if (options.freeChatWebSearch !== undefined) {
              found = await options.freeChatWebSearch(query)
              gateway.recordExternal?.({
                meta,
                model: { provider: 'stand-in', model: 'web-search' },
              })
            } else {
              const { officialWebSearch } = await import('@agentsws/dsh-adapter')
              const provider = officialWebSearch({
                credential: searchCredential,
                onUse: (use) => {
                  if (use.kind !== 'search_usage') return
                  gateway.recordExternal?.({
                    meta,
                    model: {
                      provider:
                        use.credential === 'deepseek_api_key' ? 'deepseek' : 'deepseek-account',
                      model: use.model,
                    },
                  })
                },
              })
              found = await provider.search({ query, maxResults: 8 }, signal)
            }
            audit(found.sources.length, true)
            return found
          } catch (e) {
            audit(0, false, (e as { code?: string }).code ?? 'error')
            throw e
          }
        },
      },
      // WP207：找回归档的对话 / 任务（只读；候选以卡片出现，人点了才恢复）
      archive: {
        has: async (actor) => (await workArchiveFor(ws)).hasArchived(actor),
        recall: async (actor, input) => (await workArchiveFor(ws)).recall(actor, input),
      },
      knowledge: async (actor, text) => {
        const config = roles.effectiveConfig(actor.assignment_id)
        const { hits } = await knowledge.retrieval.search({
          text,
          k: 8,
          actor: {
            person_id: actor.person_id,
            workspace_id: actor.workspace_id,
            assignment_id: actor.assignment_id,
            role_id: config.role_id,
            grants: config.scopes,
            ranges: config.ranges,
          },
        })
        return hits.map((h) => ({
          fact_card_id: h.fact_card_id,
          text: h.statement_redacted,
          ...(h.provenance_summary === '' ? {} : { source: h.provenance_summary }),
        }))
      },
    })
    freeChatPorts.set(ws, port)
    return port
  }
  /**
   * WP69（54）岗位面：一个品牌一份（事项与 Run 落在这个品牌的 `Work` 里）。
   *
   * 岗位模板、职责定义、分配表是**制度层**的东西，跨品牌共用一份——所以这里递的是
   * 同一个 `org.positions` 与同一个 `roles`；按品牌分开的只有 `work`。
   */
  const positionPorts = new Map<WorkspaceId, PositionEntryPort>()
  const positionsFor = async (ws: WorkspaceId): Promise<PositionsAssembly> => {
    // 建品牌容器时就把岗位面一起建好了（见 `assembleBrand` 里 `bindPositions` 那一段）
    await brandModules.forWorkspace(ws)
    const made = positionAssemblies.get(ws)
    if (made === undefined) throw new ApiError('not_implemented', '这个品牌还没有装配岗位面')
    return made
  }
  const positionPortFor = async (ws: WorkspaceId): Promise<PositionEntryPort> => {
    const cached = positionPorts.get(ws)
    if (cached !== undefined) return cached
    const assembly = await positionsFor(ws)
    /** `:id` 两种都收：岗位模板 id，或者本人持有的一条分配 id（换算成它所属的岗位）。 */
    const resolveId = (actor: { person_id: string }, id: string): string => {
      if (org.positions().some((p) => p.id === id)) return id
      const assignment = roles.assignments.get(id)
      if (assignment === undefined || assignment.person_id !== actor.person_id)
        throw new ApiError('not_found', `没有这个岗位：${id}`)
      const found = assembly.positionOf(assignment.role_id, assignment.id)
      if (found.position_id === undefined)
        throw new ApiError('not_found', found.note ?? `没有这个岗位：${id}`)
      return found.position_id
    }
    const port: PositionEntryPort = {
      instance: (actor, id) => assembly.instance(resolveId(actor, id), actor.person_id),
      // WP241（docs/54 §7）：岗位页「工作」
      work: (actor, id) => assembly.work(resolveId(actor, id), actor.person_id),
      mine: (actor) => assembly.mine(actor.person_id),
      open: async (actor, id, input) => {
        const out = await assembly.open({
          position_id: resolveId(actor, id),
          person_id: actor.person_id,
          title: input.title,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
          // WP84：快捷提示点进来时带着职责；端口里再判一次"是不是他自己名下的那一条"
          ...(input.role_id === undefined ? {} : { role_id: input.role_id }),
        })
        return {
          matter: {
            id: out.matter.id,
            title: out.matter.title,
            ...(out.matter.entry === undefined ? {} : { entry: out.matter.entry }),
            ...(out.matter.role_id === undefined ? {} : { role_id: out.matter.role_id }),
          },
          ...(out.picked === undefined ? {} : { picked: out.picked }),
          candidates: out.candidates.map((c) => ({ ...c, why: [...c.why] })),
          ambiguous: out.ambiguous,
          reason: out.reason,
          ...(out.approval_item_id === undefined ? {} : { approval_item_id: out.approval_item_id }),
          ...(out.run_id === undefined ? {} : { run_id: out.run_id }),
        }
      },
      reroute: async (actor, matter_id, role_id, opts) => {
        const out = await assembly.reroute({
          matter_id,
          role_id,
          person_id: actor.person_id,
          ...(opts?.run === true ? { run: true } : {}),
        })
        return {
          matter: {
            id: out.matter.id,
            ...(out.matter.role_id === undefined ? {} : { role_id: out.matter.role_id }),
          },
          assignment_id: out.assignment_id,
          ...(out.run_id === undefined ? {} : { run_id: out.run_id }),
        }
      },
    }
    positionPorts.set(ws, port)
    return port
  }
  const positionPortOf = brandPositionPort(brandModules, positionPortFor)

  /**
   * WP207：左栏职责下的对话 / 任务、自动归档与找回。一个品牌一份（事项落在这个品牌的 `Work` 里）；
   * 天数与「看过了」存在品牌目录下的 `work-archive.json`（没有数据目录就是内存档）。
   */
  const workArchives = new Map<WorkspaceId, WorkArchiveAssembly>()
  const workArchiveFor = async (ws: WorkspaceId): Promise<WorkArchiveAssembly> => {
    const cached = workArchives.get(ws)
    if (cached !== undefined) return cached
    const brand = await brandModules.forWorkspace(ws)
    const assembly = await positionsFor(ws)
    const dir = brandDirOf(dbDir, ws, workspace.id)
    const made = createWorkArchive({
      clock,
      work: brand.work,
      state: createArchiveStateStore(
        dir === undefined ? undefined : join(dir, 'work-archive.json'),
      ),
      positions: (person_id) => assembly.mine(person_id),
      assignmentsOf: (person_id) =>
        roles.assignments
          .listByPerson(person_id, { workspace_id: ws })
          .filter((a) => a.revoked_at === undefined)
          .map((a) => a.id),
      runningMatters: () => new Set((brand.runtime?.activeRuns() ?? []).map((r) => r.matter_id)),
      pendingCards: async (person_id) => {
        const items = (await approvals.queue({
          workspace_id: ws,
          person_id,
          lane: 'mine',
          state: ['pending', 'in_review'],
        })) as ApprovalItem[]
        const out = new Map<string, number>()
        for (const i of items) {
          const id = i.subject.matter_id ?? i.subject.work_item_id
          if (id !== undefined) out.set(id, (out.get(id) ?? 0) + 1)
        }
        return out
      },
      personNames: async () => {
        const out = new Map<string, string>()
        for (const m of await identity.members(ws)) {
          const p = await identity.getPerson(m.person_id)
          if (p !== undefined && p.name !== '') out.set(p.id, p.name)
        }
        return out
      },
      roleName: (id) => roles.roles.get(id)?.name.zh,
      positionName: (id) => org.positions().find((p) => p.id === id)?.name.zh,
      rerank: (actor, query, pool) => rerankArchived(ws, actor, query, pool),
    })
    workArchives.set(ws, made)
    return made
  }
  /**
   * WP207：⌘K「让 AI 找回」的模型重排——用这个品牌的默认模型，只排序、不恢复。
   * 没接模型（只有 stub）就回 `undefined`，按关键词的顺序给。
   */
  const rerankArchived = async (
    ws: WorkspaceId,
    actor: { assignment_id: string },
    query: string,
    pool: { id: string; title: string; summary: string; last_activity: string }[],
  ): Promise<string[] | undefined> => {
    const models = await brandModules.models(ws)
    if (!models.configured()) return undefined
    const ref = models.defaultRef()
    if (ref.provider === 'stub') return undefined
    const gateway = await brandModules.gateway(ws)
    const lines = pool.map(
      (c) =>
        `${c.id} | ${c.last_activity.slice(0, 10)} | ${c.title.replace(/\s+/g, ' ')} | ${c.summary.replace(/\s+/g, ' ').slice(0, 160)}`,
    )
    const out = await gateway.complete({
      model: ref,
      messages: [
        {
          role: 'system',
          content:
            '你在帮用户从已归档的对话 / 任务里找回一件。下面每行一件：id | 最后活动日期 | 标题 | 摘要。' +
            '按和用户描述像的程度从高到低排，只回一个 JSON 数组，元素是 id；完全不像的不要放。不要回别的字。',
        },
        {
          role: 'user',
          content: `用户的描述：${query}\n今天：${clock.now().slice(0, 10)}\n\n${EXTERNAL_FENCE.open}\n${EXTERNAL_FENCE.sanitizeText(lines.join('\n'), 8000)}\n${EXTERNAL_FENCE.close}`,
        },
      ],
      meta: {
        workspace_id: ws,
        assignment_id: actor.assignment_id,
        role_id: roles.assignments.get(actor.assignment_id)?.role_id ?? 'common.member',
        run_id: `recall_${Math.floor(random() * 1e12).toString(36)}` as never,
        purpose: 'judge',
      },
    })
    const match = /\[[\s\S]*\]/.exec(out.text)
    if (match === null) return undefined
    const parsed = JSON.parse(match[0]) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : undefined
  }
  const workArchivePortOf = brandWorkArchivePort(brandModules, workArchiveFor)

  /**
   * WP120（69 §4）：角色定位端口。
   *
   * **不按品牌分**（见 `personas` 那一段）：岗位模板与职责定义是制度层的，
   * 覆盖也是公司层的。所以这里不像别的端口那样按 `ws` 建一份。
   *
   * 错误翻译在这一层做：端口里抛的是 `PersonaError`（服务层的词），
   * 网关认的是 `ApiError`（HTTP 的词）。不翻的话 403 会变成 500。
   */
  const toApiError = (error: unknown): never => {
    if (error instanceof PersonaError) throw new ApiError(error.code, error.message)
    throw error
  }
  const personaPort: PersonaPort = {
    view: (_actor, subject) => {
      try {
        return personas.view(subject)
      } catch (error) {
        return toApiError(error)
      }
    },
    set: (actor, subject, text) => {
      try {
        /*
         * WP226（69 §4.1）：**公司只改中文**。英文那一格不再"从现在生效的那一份补齐"——
         * 补进去的是包里按旧中文翻的英文，与公司刚写的中文说的不是同一件事。
         * 没给英文就存空串：`applyPersonaOverride` 据此判断——中文没变就照用包里的英文，
         * 变了就是「未翻译」（英文界面显示中文 + 标记）。中文没给（老客户端只改英文）
         * 才从现在生效的那一份补中文。
         */
        const current = personas.view(subject).effective
        return personas.set({
          subject,
          text: { zh: text.zh ?? personaTextIn(current, 'zh'), en: text.en ?? '' },
          by: actor.person_id,
        })
      } catch (error) {
        return toApiError(error)
      }
    },
    revert: (actor, subject) => {
      try {
        return personas.revert({ subject, by: actor.person_id })
      } catch (error) {
        return toApiError(error)
      }
    },
  }

  const kolPortOf = brandKolPort(brandModules, async (ws) => {
    const brand = await brandModules.forWorkspace(ws)
    /*
     * WP117 交付 4：演练场挂在红人端口的 `sandbox` 那一格上。
     *
     * 挂在这里而不是让 `kolService` 自己带：演练是**库之上的一层**
     * （它往库里铺合成数据、在出站那一跳截信），`kolService` 不该认识它——
     * 起草开发信那一跳对「这个人是不是演练的」应该一无所知，那正是
     * 「演练走的是与真实逐字相同的那条路」的意思。
     */
    const sandbox = brand.kolSandbox
    return {
      ...brand.kolService.port,
      sandboxStatus: () => sandbox.status(),
      sandboxStart: (_actor: unknown, input: { channel: KolChannel }) => sandbox.start(input),
      sandboxAdvance: (_actor: unknown, input: { days: number }) => sandbox.advance(input),
      sandboxClear: () => sandbox.clear(),
    }
  })
  /**
   * WP119（68）：浏览器插件的本地一面 `/v1/extension/*`。
   *
   * 配对表**整台机器一张**（一把令牌自己带着 `workspace_id`）；写红人库与
   * 加密库那一半按品牌走，与 `kolPortOf` 同一条（52 O1）。
   *
   * WP119b（docs/76）：配对表落 SQLite——WP119 留尾的那一条：内存档重启要重配，
   * 用户的令牌与配对得跨重启还在。有数据目录用 SQLite 档；内存档只给测试与
   * 一次性进程。
   *
   * 云端转发口（登录了就默认共享到公共红人库，Luoye 09-19）挂在这里而不是
   * 插件里：**插件不该持有云令牌**——装在浏览器里的东西，拿到这台电脑的人就读得到。
   */
  const extensionStore =
    dbDir === undefined
      ? createMemoryExtensionStore({ clock, random })
      : new SqliteExtensionStore({ dbPath: join(dbDir, 'extension-pairing.sqlite'), clock, random })
  const extensionPortOf = brandExtensionPort({
    store: extensionStore,
    serviceOf: async (ws) => {
      const brand = await brandModules.forWorkspace(ws)
      return {
        workspaceName: () => brandNameOfWorkspace(ws),
        kol: brand.kol,
        secrets: brand.secrets,
        clock,
        random,
        publicLibrary: createExtensionContributor({ secrets: brand.secrets, env }),
        serverVersion: env.AGENTSWS_VERSION ?? '0.1.0',
        // WP201：每一轮公共库转发记一行（几条 2xx、几条待重试、几条云端不收）——
        // 「插件采到的到底上没上公共库」在本机日志里有据可查。不带任何令牌与明文。
        log: (line: string) => {
          if (options.quiet !== true) process.stdout.write(`${line}\n`)
        },
        // WP119c：深链的基底（hello 的 workbench_url）；没绑端口就不出这一格。
        workbenchUrl: () => (boundPort === undefined ? undefined : `http://127.0.0.1:${boundPort}`),
        // WP119c：看一次邮箱的积分价——价目是数据不是代码。WP165 起价目只在云上：
        // 读本机手上那一份（云上取过才有）；手上没有就是 0（插件那头显示「以云上为准」）。
        // WP201：取云端取邮箱真扣的那一条（data.kol.reveal），不是搜索的 lookup
        revealPriceCredits: () => pricingCatalog.creditsFor(REVEAL_PRICE_CAPABILITY) ?? 0,
        // WP131：「采集后自动评分」的体检那一半——这个品牌连公共库的客户端 + 体检的价
        auditor: brand.kolPublic,
        auditPriceCredits: () => pricingCatalog.creditsFor(KOL_AUDIT_CAPABILITY) ?? 0,
        // WP202：这个品牌有没有人持有红人职责（没有 = 插件收进来的人在工作台看不到）
        kolRoleHeld: () =>
          KOL_CHANNEL_IDS.some((channel) =>
            roles.assignments
              .listByRole(`kol.${channel}`, { workspace_id: ws })
              .some((a) => a.revoked_at === undefined),
          ),
      }
    },
  })
  /** WP73（56 §6）：社媒库 `/v1/social/*`（一个品牌一张库、一段加密库）。 */
  const socialPortOf = brandSocialPort(
    brandModules,
    async (ws) => (await brandModules.forWorkspace(ws)).socialService.port,
  )
  /** WP172（docs/84）：B2B 库 `/v1/b2b/*`（同上；一个品牌一张库）。 */
  const b2bPortOf = brandB2bPort(
    brandModules,
    async (ws) => (await brandModules.forWorkspace(ws)).b2bService.port,
  )
  /** WP173（docs/84 §2）：开发信序列 `/v1/b2b/outbound/*`（同上；一个品牌一份）。 */
  const b2bOutboundPortOf = brandB2bOutboundPort(
    brandModules,
    async (ws) => (await brandModules.forWorkspace(ws)).b2bOutbound.port,
  )
  const b2bSalesPortOf = brandB2bSalesPort(
    brandModules,
    async (ws) => (await brandModules.forWorkspace(ws)).b2bSales.port,
  )
  /** WP78（60 §5）：公关库 `/v1/pr/*`（同上；媒体名单是一家公司攒了很多年的东西）。 */
  const prPortOf = brandPrPort(
    brandModules,
    async (ws) => (await brandModules.forWorkspace(ws)).prService.port,
  )
  /**
   * WP154「内容与搜索」`/v1/seo/*`：问题清单落在请求人所在品牌的目录下；"现在跑一轮"
   * 跑的也是那个品牌（与定时任务同一条路，只是不用等到早上 8 点）。
   */
  const seoPort: SeoPort = {
    geoQuestions: async (actor) =>
      (await brandModules.forWorkspace(actor.workspace_id)).seoService.geoView(),
    setGeoQuestions: async (actor, input) => {
      const svc = (await brandModules.forWorkspace(actor.workspace_id)).seoService
      if (input.questions !== undefined)
        svc.setGeoQuestions(
          input.questions.map((q, i) => ({
            id: q.id ?? `gq_h${i}_${Date.parse(clock.now()).toString(36)}`,
            text: q.text,
            origin: 'human' as const,
            enabled: q.enabled,
          })),
        )
      if (input.settings !== undefined) svc.setGeoSettings(input.settings)
      return svc.geoView()
    },
    // WP159：知识库里那张「违规宣称规则」表（按请求人所在品牌的目标市场开组）
    claimRules: async (actor) =>
      (await brandModules.forWorkspace(actor.workspace_id)).seoService.claimRules(actor),
    setClaimRules: async (actor, input) => {
      const svc = (await brandModules.forWorkspace(actor.workspace_id)).seoService
      try {
        return await svc.setClaimRules(actor, input)
      } catch (err) {
        throw new ApiError('invalid_input', err instanceof Error ? err.message : String(err))
      }
    },
    // WP158：Search Console 选哪个站点、GA4 选哪个媒体资源
    googleSources: async (actor) =>
      (await brandModules.forWorkspace(actor.workspace_id)).googleReads.sources(),
    setGoogleSources: async (actor, input) => {
      const brand = await brandModules.forWorkspace(actor.workspace_id)
      let out: Awaited<ReturnType<typeof brand.googleReads.select>>
      try {
        out = await brand.googleReads.select(input)
      } catch (err) {
        const code = (err as { code?: unknown }).code
        if (code === 'invalid_input')
          throw new ApiError('invalid_input', err instanceof Error ? err.message : String(err))
        throw err
      }
      // 选了立刻刷新：换了站点就重出今天的 5 件事（换 GA4 只影响周收入表，下一次周小结带上）
      if (out.gsc_changed) await brand.seoService.daily()
      return out.view
    },
    run: async (actor, what) => {
      const svc = (await brandModules.forWorkspace(actor.workspace_id)).seoService
      if (what === 'daily') {
        const out = await svc.daily()
        return {
          what,
          approval_item_ids: out.approval_item_id === undefined ? [] : [out.approval_item_id],
          picks: out.picks,
          ...(out.skipped === undefined ? {} : { skipped: out.skipped }),
        }
      }
      const revenue = await svc.weeklyRevenue()
      const geo = await svc.weeklyGeo()
      return {
        what,
        approval_item_ids: [revenue.approval_item_id, geo.approval_item_id].filter(
          (x): x is string => x !== undefined,
        ),
        ...(revenue.skipped === undefined ? {} : { skipped: revenue.skipped }),
      }
    },
  }
  /** WP75（57 §5）：广告库 `/v1/ads/*`（一个品牌一张库——广告账户是花钱的，串不得）。 */
  const adsPortOf = brandAdsPort(
    brandModules,
    async (ws) => (await brandModules.forWorkspace(ws)).adsService.port,
  )
  /** WP77（59 §2）：建站数据面 `/v1/site/*`（一个品牌一张库）。 */
  const sitePortOf = brandSitePort(brandModules, async (ws) => {
    const base = (await brandModules.forWorkspace(ws)).siteService.port
    // WP253：网页模板「AI 改主题还差哪一步」与店铺地址（主题工坊按品牌懒建）
    const themeView = async (fresh: boolean): Promise<SiteThemeView> => {
      const theme = await siteThemeOf(ws)
      if (theme === undefined) throw new ApiError('not_implemented', '这个品牌没装主题工坊')
      return theme.readiness({ fresh })
    }
    return {
      ...base,
      themeStatus: (_actor, input) => themeView(input.fresh === true),
      setThemeStore: async (_actor, input) => {
        const theme = await siteThemeOf(ws)
        if (theme === undefined) throw new ApiError('not_implemented', '这个品牌没装主题工坊')
        try {
          return await theme.setStore(input.store, { source: input.source })
        } catch (e) {
          if (e instanceof SiteThemeError) throw new ApiError('invalid_input', e.message)
          throw e
        }
      },
    }
  })
  /** WP76（58 §5）：设计库 `/v1/design/*`（一个品牌一张库、一段 blob 前缀）。 */
  const designPortOf = brandDesignPort(
    brandModules,
    async (ws) => (await brandModules.forWorkspace(ws)).designService.port,
  )
  /**
   * WP83（54（将改号 55）§4 前两层）：连接目录与岗位连接清单——**一个品牌一份**。
   *
   * 与连接面同一条理由（52 O1）：目录上的"已连 / 未连"是这个品牌的连接算出来的，
   * 岗位清单也一样。制度层那三样（岗位模板、职责定义、分配表）跨品牌共用，
   * 所以 `positions` 与 `roles` 都是现查的同一份。
   *
   * MCP 那张表跟着品牌走：登记文件落在这个品牌的目录下，请求头进这个品牌那一段
   * 加密库——品牌 A 登记的那台服务器与它的 token，在 B 的任何路由里都读不到。
   */
  const directoryPorts = new Map<WorkspaceId, ConnectionDirectoryPort>()
  /** WP86：装配本体也留一份（运行时要同步问"这条职责挂哪几台 MCP 服务器"）。 */
  const directoryAssemblies = new Map<WorkspaceId, ConnectionDirectoryAssembly>()
  const directoryPortFor = async (ws: WorkspaceId): Promise<ConnectionDirectoryPort> => {
    const cached = directoryPorts.get(ws)
    if (cached !== undefined) return cached
    const brand = await brandModules.forWorkspace(ws)
    const assembly = createConnectionDirectory({
      clock,
      workspace_id: ws,
      ...(brand.dir === undefined ? {} : { dir: brand.dir }),
      secrets: brand.secrets,
      roles,
      positions: () => org.positions(),
      connectedKinds: () => brand.connections.connectedKinds(),
      connections: () => brand.connections.liveConnections(),
      storefrontPlatform: () => brandProfileOf(ws).storefront_platform,
      // WP238：读 Reddit 已经能经接口中台 / 本机只读浏览器取到，就不算缺 Reddit API
      readRouteLevel: readRouteLevelOf(
        brand.ownCloud,
        brand.readonlyBrowser,
        brand.readRoutes?.account,
      ),
    })
    directoryAssemblies.set(ws, assembly)
    const port: ConnectionDirectoryPort = {
      directory: () => assembly.directory(),
      positionConnections: (actor, id) => assembly.positionConnections(actor.person_id, id),
      listMcpServers: () => assembly.listMcp(),
      // 请求头的值只在这一次调用里往下传，网关与这一层都不读、不记、不回显
      saveMcpServer: (_actor, input) => assembly.saveMcp(input),
      probeMcpServer: (_actor, name) => assembly.probeMcp(name),
      removeMcpServer: (_actor, name) => assembly.removeMcp(name),
    }
    directoryPorts.set(ws, port)
    return port
  }
  const connectionDirectoryOf = brandConnectionDirectoryPort(brandModules, directoryPortFor)
  // WP246：取数路线按品牌取（装配里总有一份；托管实例没有读号那一格）
  const readRoutesOf = async (ws: WorkspaceId): Promise<ReadRoutesAssembly> => {
    const r = (await brandModules.forWorkspace(ws)).readRoutes
    if (r === undefined) throw new ApiError('not_implemented', '这个品牌没装取数路线')
    return r
  }

  const workPortOf = brandWorkPort(brandModules, workPortFor)
  const workstationPortOf = brandWorkstationPort(brandModules, workstationPortFor)
  const askPortOf = brandAskPort(brandModules, askPortFor)
  const freeChatPortOf = brandFreeChatPort(brandModules, freeChatPortFor)

  const platformCliLogins = new Map<string, PlatformCliLoginStore>()
  // WP245：CLI 装进应用自己的数据目录（`<data>/tools/<cli id>`）；内存档没有数据目录 = 不能一键装
  const platformCliRunner = createPlatformCliRunner({
    now: () => clock.now(),
    toolsDir: dbDir === undefined ? undefined : join(dbDir, 'tools'),
    env,
    registry: () => npmRegistry.choose(),
    ...options.platformCliRunner,
  })
  const platformCliProber = createPlatformCliProber({
    now: () => clock.now(),
    env,
    ...(options.platformCliExec === undefined ? {} : { exec: options.platformCliExec }),
    // WP245：优先认工作台自己装的那份，系统里已有的也认
    invocation: (spec) => platformCliRunner.invocation(spec),
  })
  const platformCliLoginOf = (ws: string): PlatformCliLoginStore => {
    let store = platformCliLogins.get(ws)
    if (store === undefined) {
      store = new PlatformCliLoginStore(brandDirOf(dbDir, ws as WorkspaceId, workspace.id))
      platformCliLogins.set(ws, store)
    }
    return store
  }
  // WP253：主题工坊与 CLI 卡认的是同一份检测、同一个起法、同一笔登录记录
  siteThemeCli.probe = (spec, fresh) => platformCliProber.probe(spec, { fresh })
  siteThemeCli.invocation = (spec) => platformCliRunner.invocation(spec)
  // WP261：店铺授权认的也是同一份检测、同一个起法；「一键安装」走 WP245 那一条
  shopCli.probe = (spec, fresh) => platformCliProber.probe(spec, { fresh })
  shopCli.invocation = (spec) => platformCliRunner.invocation(spec)
  shopCli.installJob = (spec) => platformCliRunner.job(spec.id)
  shopCli.install = (spec) => {
    try {
      platformCliRunner.start(spec, 'install', {
        onFinished: () => platformCliProber.invalidate?.(spec.id),
      })
    } catch (e) {
      if (e instanceof CliRunnerError && e.code === 'conflict')
        throw new ApiError('conflict', '正在装 / 登录 Shopify CLI，等它好了再点')
      throw e
    }
  }
  /*
   * WP253（Fable 10-07 真机 + 决定 138）：CLI 会话按品牌分开——每个品牌一份 CLI 配置目录
   * （`platform-cli-session.ts` 写了依据）。没有数据目录（内存档）就用整台电脑那一份。
   */
  const cliSessionOf = (ws: string, cli_id: string): CliSession => {
    const toolsDir = platformCliRunner.toolsDir
    return {
      alias: cliSessionAlias(ws),
      ...(toolsDir === undefined ? {} : { home: cliSessionHome(toolsDir, cli_id, ws) }),
    }
  }
  // 「登好了」= 按品牌记过一笔，而且这个品牌那一份会话目录还在（WP253 之前在整台电脑那一份登的要再登一次）
  siteThemeCli.loggedIn = (ws, cli_id) => {
    if (platformCliLoginOf(ws).confirmedAt(cli_id) === undefined) return false
    const home = cliSessionOf(ws, cli_id).home
    return home === undefined || existsSync(home)
  }
  siteThemeCli.sessionEnv = (ws, cli_id) => {
    const home = cliSessionOf(ws, cli_id).home
    return home === undefined ? undefined : cliSessionEnv(home)
  }
  const platformKitPort = createPlatformKitPort({
    now: () => clock.now(),
    platformOf: (ws) => brandPlatformOf(ws),
    setPlatform: (ws, p) => onboardingRef?.setStorefrontPlatform(ws, p, 'human') ?? false,
    hasRoles: (ws, role_ids) =>
      role_ids.some((r) => roles.assignments.listByRole(r, { workspace_id: ws }).length > 0),
    platformChoices: () => storefrontPlatformChoices(),
    prober: platformCliProber,
    runner: platformCliRunner,
    loginStoreOf: platformCliLoginOf,
    sessionOf: (ws, spec) => cliSessionOf(ws, spec.id),
    // WP258：登好了就去找这个账号下的店（后台跑；岗位页下一次刷新就看到结果）
    onLoggedIn: (ws) => {
      void siteThemeOf(ws as WorkspaceId)
        .then((theme) => theme?.refreshStores({ relogin: true }))
        .catch(() => undefined)
    },
    displayNameOf: (name) => {
      const extra = skills.registry.frontmatterOf(name)?.extra
      const zh = extra?.display_name?.trim() ?? ''
      const en = extra?.display_name_en?.trim() ?? ''
      return zh === '' && en === '' ? undefined : { zh: zh || en, en: en || zh }
    },
    mcpStatus: () => ({
      enabled: devMcp !== undefined,
      downloaded: devMcp?.status().available === true,
      tools: devMcp === undefined ? [] : Object.keys(devMcp.status().mapped),
    }),
    appendEvent: (ws, type, payload) =>
      appendEvent({
        schema_version: 1,
        workspace_id: ws,
        type,
        actor: { kind: 'system', id: 'platform.kit' },
        correlation: { trace_id: `trc_pkit_${Date.parse(clock.now()).toString(36)}` },
        payload,
      }),
  })

  /** WP215：设置页「后台」那一张的行——本人有成员资格的这家公司的品牌。 */
  const backgroundRowsOf = (actor: {
    workspace_id: string
    person_id: string
  }): { workspace_id: WorkspaceId; name: string; current: boolean }[] => {
    const org = identity
      .listOrganizations()
      .find((o) => identity.brandsOf(o.id).some((w) => w.id === actor.workspace_id))
    const mine = org === undefined ? [] : identity.brandsOf(org.id, actor.person_id as PersonId)
    const rows = mine.map((w) => ({
      workspace_id: w.id,
      name: brandNameOf(w),
      current: w.id === actor.workspace_id,
    }))
    if (rows.length === 0)
      rows.push({
        workspace_id: actor.workspace_id as WorkspaceId,
        name: brandNameOfWorkspace(actor.workspace_id as WorkspaceId),
        current: true,
      })
    return rows
  }
  /**
   * WP265：一键连 Shopify 时自动带的店铺域名，按先后：品牌档案里官网读到的 `shopify_domain`
   * → 建站岗位找到 / 选定的店 → Shopify CLI 店铺清单（WP258）→ 老的客户端凭据连接。
   * 建站那一份最多等 3 秒（它可能顺手去找店）；没等到就跳过，卡上让人填一格。
   */
  const shopifyShopHints = async (
    ws: WorkspaceId,
  ): Promise<{ shop: string; source: 'profile' | 'site' | 'cli' | 'connection' }[]> => {
    const out: { shop: string; source: 'profile' | 'site' | 'cli' | 'connection' }[] = []
    const profile = onboardingRef?.shopifyDomainOf(ws)
    if (profile !== undefined && profile !== '') out.push({ shop: profile, source: 'profile' })
    try {
      const theme = await siteThemeOf(ws)
      const ready =
        theme === undefined
          ? undefined
          : await Promise.race([
              theme.readiness(),
              new Promise<undefined>((resolve) => {
                setTimeout(() => resolve(undefined), 3000).unref?.()
              }),
            ])
      if (ready?.store !== undefined)
        out.push({
          shop: ready.store,
          source: ready.store_source === 'connection' ? 'connection' : 'site',
        })
      for (const row of ready?.store_lookup?.stores ?? [])
        out.push({ shop: row.store, source: 'cli' })
    } catch {
      // 建站那一份没装好 / 不是 Shopify：跳过
    }
    try {
      const brand = await brandModules.forWorkspace(ws)
      for (const r of brand.connections.shopify.list())
        out.push({ shop: r.shop, source: 'connection' })
    } catch {
      // 这个品牌的连接面还没起来：跳过
    }
    return out
  }
  const deps: GatewayDeps = {
    identity,
    // WP194：一次请求绑好分配之后，开一个「算在谁头上」的作用域（打云时带归属头）
    requestScope: (scope, next) =>
      withCloudAttribution(cloudAttributionOf(scope.assignment.id), next),
    halt: kernel.halt,
    // WP215：品牌急停只拦这个品牌的施行与发送（全局急停照旧在上面那一份）
    brandHalt: (ws) =>
      background.isBrand(ws as WorkspaceId) ? background.haltOf(ws as WorkspaceId) : undefined,
    trace: kernel.trace,
    clock,
    eventLog: eventLogPort,
    modules: kernel.modules,
    reconcile,
    approvals,
    // WP174：`POST /v1/approvals` 的 `scope_manager` 也走岗位上级 → 老板
    routeScopeManager,
    changes: txn.ledger,
    guardrails,
    knowledge: knowledgePort,
    skills: skillsPort,
    roles: rolesPort,
    meetings: meetings.port,
    // WP20 / WP66：连接面按品牌（死信与重投也按品牌，见 `brand-ports.ts`）
    connections: brandConnectionsPort(brandModules),
    // WP113（63）：消息——按请求的品牌取那一只邮箱库
    messages: brandMessagesPort(brandModules),
    // WP83（54 §4）：连接目录（按 kind 的总表）与岗位连接清单，也按品牌
    connectionDirectory: connectionDirectoryOf,
    /*
     * WP82（55 §3 末段）：浏览器设置。**不按品牌**（见上面 `browserSettings` 那段）。
     * 这条路上没有任何凭据：CDP 地址不是密码，登录态在用户自己的 Chrome 里。
     */
    /*
     * WP136（docs/79）：dsh 场景切换。其他场景由 DeepSeek 官方维护，这里只是入口；
     * 打开回的网址带 dsh 发的一次性 token，只在响应里出现、不进日志。
     */
    /*
     * WP155（docs/81）：搜索数据接口，按品牌取（设置与自带 key 都在那个品牌名下）。
     * 自带 key 只从 PUT 进来一次、进加密库，读视图里只有 has_key。
     */
    searchData: searchDataApiPort(async (ws) => (await brandModules.forWorkspace(ws)).searchData),
    /*
     * WP265：连接页 Shopify 卡的一键授权（接私有云 WP263），按品牌取那个品牌的云令牌。
     * 店铺令牌只在云上；本机只拿这个品牌的工作区令牌开口（动作集 store）。
     */
    shopifyConnect: createShopifyConnect({
      clock,
      cloudOf: (ws) => brandModules.cloud(ws),
      emailOf: async (ws) => {
        const v = await cloudAccount.port.status(ws)
        return v.linked ? v.email : undefined
      },
      shopHints: (ws) => shopifyShopHints(ws),
      startupBrand: workspace.id,
      links: cloudShopLinks,
      // WP267（决策 208）：老令牌缺 store → 一点补签（云上就地补，不用重新登录）
      upgrade: (ws) => cloudAccount.upgradeScopes(ws),
      // WP272：卡上不再出「更新授权」——撞上缺动作集就后台补签、接着做（与云面同一份去重 / 冷却）
      autoUpgrade: (ws) => scopeAutoUpgrade?.ensure(ws) ?? Promise.resolve(false),
    }),
    /*
     * WP246（决策 87 / 88）：取数路线（体检、设置、Reddit 读号），按品牌取。
     */
    // WP254：下载源（每台机一份；「换国内源再试」与设置 · 诊断里改回官方源）
    npmRegistry: {
      get: () => ({ ...npmRegistry.get(), urls: { ...NPM_REGISTRY_URLS } }),
      set: (source) => ({ ...npmRegistry.set(source), urls: { ...NPM_REGISTRY_URLS } }),
    },
    readRoutes: {
      view: async (actor) => (await readRoutesOf(actor.workspace_id)).view(),
      doctor: async (actor) => (await readRoutesOf(actor.workspace_id)).doctor(),
      setSettings: async (actor, patch) =>
        (await readRoutesOf(actor.workspace_id)).setSettings(patch),
      openRedditLogin: async (actor) => (await readRoutesOf(actor.workspace_id)).openRedditLogin(),
      checkRedditAccount: async (actor) =>
        (await readRoutesOf(actor.workspace_id)).checkRedditAccount(),
    },
    /*
     * WP192（docs/83 §4）：官方数据接口统一能力口，按品牌的云客户端走（路由键 `data.<能力>`，
     * 默认只有「Agents 工坊（用积分）」一级）。
     */
    dataService: dataServiceApiPort((ws) => brandModules.cloud(ws)),
    dshScenes: {
      list: async () => {
        const manager = dshScenesSetup.manager
        if (manager === undefined) return unavailableScenes(dshScenesSetup.reason)
        // WP184：用户自己装的官方桌面端多一行（没装就没有这个字段）
        const desktop = await manager.officialDesktop()
        return {
          ...manager.list(),
          ...(desktop === undefined ? {} : { official_desktop: desktop }),
        }
      },
      launchOfficialDesktop: () => dshScenes().launchOfficialDesktop(),
      create: (_actor, input) => dshScenes().create(input),
      remove: (_actor, name, confirm) => dshScenes().remove(name, confirm),
      open: (_actor, name) => dshScenes().open(name),
      stop: (_actor, name) => dshScenes().stop(name),
      restart: (_actor, name) => dshScenes().restart(name),
    },
    /*
     * WP144（docs/80）：电脑操控。**不按品牌**（同浏览器）。下载驱动与自检都是本机的事
     * （下载 + 校验 sha256 / 起一次驱动），留在服务进程这一侧；设置页只管按钮与结果。
     */
    /*
     * WP180：官方插件。**不按品牌**（同电脑操控）。出卡走同一条审批总线（批卡在 `officialPlugins.wrap` 里接住）。
     */
    /*
     * WP219（docs/90）：已审的内容更新。**按品牌**（设置、当前版、退回都是这个品牌的）。
     */
    ...(contentUpdates === undefined
      ? {}
      : {
          contentUpdates: {
            view: (actor) => contentUpdates.view(actor.workspace_id as WorkspaceId),
            setMode: (actor, mode) =>
              contentUpdates.setMode(actor.workspace_id as WorkspaceId, mode),
            check: async (actor) => {
              await contentUpdates.check()
              return contentUpdates.view(actor.workspace_id as WorkspaceId)
            },
            apply: (actor, id) =>
              contentUpdates.apply(actor.workspace_id as WorkspaceId, id, 'person'),
            rollback: (actor, id) => contentUpdates.rollback(actor.workspace_id as WorkspaceId, id),
            diff: (actor, id) => contentUpdates.diff(actor.workspace_id as WorkspaceId, id),
          },
        }),
    /*
     * WP216：平台专属那一套（官方技能 / Dev MCP / 官方 CLI 卡）。**按品牌档案**判断平台；
     * 「我登好了」按品牌的数据目录记一笔（不存凭据）；本机 CLI 检测是这台机器的事，一台一份缓存。
     */
    platformKit: platformKitPort,
    /*
     * WP261：「授权管理商品和页面」那一行（Shopify CLI `store auth`，按品牌；参数在服务端拼死）。
     */
    /*
     * WP268（决策 213）：品牌素材库（按品牌；先把品牌装起来，素材库随品牌建）。
     */
    brandAssets: {
      list: async (actor, filter) => {
        const lib = await brandAssetsOf(actor.workspace_id as WorkspaceId)
        const rows = lib
          .list({
            ...(filter.matter_id === undefined ? {} : { matter_id: filter.matter_id }),
            ...(filter.tag === undefined ? {} : { tag: filter.tag }),
            ...(filter.source === undefined ? {} : { source: filter.source }),
            status:
              filter.picked_only === true
                ? ['picked', 'published']
                : ['variant', 'picked', 'published'],
            limit: filter.limit ?? 100,
          })
          .map(brandAssetRow)
        return { rows }
      },
      file: async (actor, id) => (await brandAssetsOf(actor.workspace_id as WorkspaceId)).bytes(id),
      upload: async (actor, input) => {
        const lib = await brandAssetsOf(actor.workspace_id as WorkspaceId)
        try {
          const asset = await lib.importUpload({ ...input, by: actor.person_id })
          return { asset: brandAssetRow(asset) }
        } catch (e) {
          if (e instanceof BrandAssetError) throw new ApiError('invalid_input', e.message)
          throw e
        }
      },
    },
    shopAdmin: {
      view: async (actor, input) => {
        const m = await shopOf(actor.workspace_id as WorkspaceId)
        if (m === undefined) throw new ApiError('not_implemented', '这个品牌没装店铺授权')
        return m.auth.view(input.roles)
      },
      run: async (actor, input) => {
        const m = await shopOf(actor.workspace_id as WorkspaceId)
        if (m === undefined) throw new ApiError('not_implemented', '这个品牌没装店铺授权')
        try {
          return await m.auth.run(input.action, input.roles)
        } catch (e) {
          if (e instanceof ShopAdminError) throw new ApiError('conflict', e.message)
          throw e
        }
      },
      cancel: async (actor, input) => {
        const m = await shopOf(actor.workspace_id as WorkspaceId)
        if (m === undefined) throw new ApiError('not_implemented', '这个品牌没装店铺授权')
        return m.auth.cancel(input.roles)
      },
      setStore: async (actor, input) => {
        const m = await shopOf(actor.workspace_id as WorkspaceId)
        if (m === undefined) throw new ApiError('not_implemented', '这个品牌没装店铺授权')
        return m.auth.setStore(input.store, input.roles)
      },
    },
    officialPlugins: {
      view: () => officialPlugins.view(),
      request: (actor, input) =>
        officialPluginCall(() => officialPlugins.request(actor, input, approvals)),
      saveConfig: (actor, input) => officialPlugins.saveConfig(actor, input),
    },
    computerUse: {
      settings: () => computerUse.get(),
      setSettings: (_actor, input) => computerUseCall(() => computerUse.set(input)),
      install: () => computerUseCall(() => computerUse.install()),
      check: () => computerUse.check(),
      openSettings: (_actor, pane) => computerUseCall(() => computerUse.openSettings(pane)),
      active: () => {
        const active = computerUse.active()
        return active === undefined ? {} : { active }
      },
      stop: () => computerUse.stop(),
    },
    browser: {
      settings: () => browserSettings.get(),
      setSettings: (_actor, input) => {
        try {
          return browserSettings.set(input)
        } catch (err) {
          if (err instanceof BrowserSettingsError) throw new ApiError(err.code, err.message)
          throw err
        }
      },
      probe: (_actor, endpoint) => {
        try {
          return browserSettings.probe(endpoint)
        } catch (err) {
          if (err instanceof BrowserSettingsError) throw new ApiError(err.code, err.message)
          throw err
        }
      },
      /*
       * WP92（55 §10）：「我正在用的浏览器」那两条。装 `bsk` 与跑 `bsk doctor` 都是
       * **本机**的事（下载 + 校验 sha256 + 起一个子进程），所以留在服务进程这一侧；
       * 设置页只管按钮与结果。
       */
      browserSkillStatus: async () => {
        const path = browserSettings.bskPath()
        if (path === undefined) {
          return {
            installed: false,
            checks: [],
            ok: false,
            detail: '这台服务没有数据目录（全内存档），装不了 bsk',
          }
        }
        const pinned = lockVersion()
        return browserSkillDoctor({
          bskPath: path,
          allowed: runtimeMode() === 'local',
          ...(pinned === undefined ? {} : { pinnedVersion: pinned }),
        })
      },
      installBrowserSkill: async () => {
        if (runtimeMode() !== 'local') {
          throw new ApiError(
            'forbidden',
            '这一档不能用你正在用的浏览器（bsk 与扩展都在用户那台电脑上）',
          )
        }
        if (dbDir === undefined) {
          throw new ApiError('not_implemented', '这台服务没有数据目录（全内存档），装不了 bsk')
        }
        try {
          const res = await installBrowserSkillCli({ dataDir: dbDir })
          return await browserSkillDoctor({
            bskPath: res.path,
            pinnedVersion: res.version,
            allowed: true,
          })
        } catch (err) {
          if (err instanceof BrowserSkillInstallError) throw new ApiError(err.code, err.message)
          throw err
        }
      },
      /*
       * WP95（36 §11）：第三栏「运行中的浏览器」读的那一份。
       * 纯投影——把这次运行的事件折成"哪种执行器、当前域、最近一次导航 / 拒绝、
       * 等不等人接管"，服务端不为它多存一张表（`run-browser.ts`）。
       */
      runBrowser: (actor, run_id) => readRunBrowser(eventLogPort, actor.workspace_id, run_id),
    },
    /*
     * WP95（36 §11，`sidebar-compare` #11）：一条变更改了哪几个文件、哪几行。
     * 只有有数据目录的那一档才有——主题工作副本落在 `<data>/themes/<workspace>/<store>/`
     * （WP89）。全内存档不装配，那条路由回 `not_implemented`，面板照实说。
     */
    ...(dbDir === undefined
      ? {}
      : {
          changeFiles: {
            files: (_actor, change) => changeFiles(change, { dataDir: dbDir }),
          },
        }),
    // WP31：本机秘密库的密钥轮换（owner）。密钥只在请求体里出现一次，
    // 网关这一层不碰库、也不碰值，只把「换了几条」端出去。
    secrets: {
      available: () => secrets.available,
      rotate: (new_key) => {
        try {
          return secrets.rotate(new_key)
        } catch (err) {
          // 秘密库的错误码翻成网关的错误信封；**原文里没有密钥**（见 secret-store.ts）
          if (err instanceof SecretStoreError)
            throw new ApiError(
              err.code === 'key_missing' ? 'not_implemented' : 'invalid_input',
              err.message,
            )
          throw err
        }
      },
    },
    // WP25 / WP66：模型面按品牌（52 O3 的"跟随公司默认"也在这一层解析）
    models: brandModelsPort({
      brands: brandModules,
      brandName: brandNameOfWorkspace,
      // WP90：订阅登录按人、按机器——每个品牌看到的是同一份
      subscription: subscription.port,
      // WP134：DeepSeek 账号登录也按机器；登出时把每个品牌里那一条 provider 一起摘掉
      deepseekAccount: {
        view: () => deepseekAccount.view(),
        login: () => deepseekAccount.login(),
        cancel: (id: string) => deepseekAccount.cancel(id),
        // WP150：先停掉正在用这个账号跑的事（在 signOut 里），再登出，再摘各品牌里那一条
        signOut: async (_actor: ModelsActor) => {
          await deepseekAccount.signOut()
          await dropDeepSeekAccountProviders('signed_out')
        },
      },
    }),
    // WP59 / WP66：`/v1/cloud/*` 与 `/v1/settings/capability-sources`，按品牌
    cloud: brandCloudPort(brandModules),
    // WP40 数据后端（41 §2.4 的三档与迁移向导）
    storage: storage.port,
    // WP60（49 §6 / 48 L7）：在线值守的切档向导与"接回本机"
    standby: standby.port,
    // WP225（WP218 决定 ③）：岗位 AI 正在干活没有——跨所有已装起来的品牌数正在跑的运行（含后台定时任务起的）；
    // 没建起来的品牌不会有在跑的运行。只回数量：桌面壳「重启并更新」前问它
    activity: {
      snapshot: () => {
        const runs = (brands?.loaded() ?? []).reduce(
          (n, brand) => n + (brand.runtime?.activeRuns().length ?? 0),
          0,
        )
        return { busy: runs > 0, runs }
      },
    },
    // WP224：毛利率事实卡、两条止损线对照、本周经营一页纸（按主体所在品牌）
    economics: {
      margins: async (actor) =>
        (await brandModules.forWorkspace(actor.workspace_id)).economics.list(
          economicsReader(actor),
        ),
      saveMargin: async (actor, input) =>
        (await brandModules.forWorkspace(actor.workspace_id)).economics.save(
          economicsReader(actor),
          input,
        ),
      lineCompare: async (actor) =>
        summarizeLineCompare(
          (await brandModules.forWorkspace(actor.workspace_id)).ads.lineCompareRows(),
        ),
      weeklyReview: async (actor) =>
        (await (await brandModules.forWorkspace(actor.workspace_id)).weeklyReview.build()) ?? null,
      runWeeklyReview: async (actor) =>
        (await brandModules.forWorkspace(actor.workspace_id)).weeklyReview.run(),
      weeklyReviewSchedule: (actor) =>
        weeklyReviewScheduleView(schedule.scheduler.get(weeklyReviewTaskId(actor.workspace_id))),
      setWeeklyReviewSchedule: async (actor, input) => {
        const id = weeklyReviewTaskId(actor.workspace_id)
        const task = schedule.scheduler.get(id)
        if (task === undefined)
          throw new ApiError(
            'conflict',
            '这个品牌还没有一页纸那条定时（先有「公司设置与授权」岗位）',
          )
        const [hh, mm] = input.time.split(':').map(Number)
        const tz = task.trigger.kind === 'cron' ? task.trigger.tz : 'UTC'
        return weeklyReviewScheduleView(
          await schedule.scheduler.update(id, {
            trigger: { kind: 'cron', expr: `${mm} ${hh} * * ${input.weekday}`, tz },
          }),
        )
      },
    },
    // WP215：每个品牌一套后台——状态、全进程并发上限、品牌急停
    background: {
      settings: async (actor) => background.settings(backgroundRowsOf(actor)),
      setConcurrency: async (actor, n) => {
        background.setMaxConcurrent(
          n,
          actor.person_id as PersonId,
          actor.workspace_id as WorkspaceId,
        )
        return background.settings(backgroundRowsOf(actor))
      },
      setBrandHalt: async (actor, ws, input) => {
        const target = ws as WorkspaceId
        // 只认**同一家公司**的品牌（公司管理员不一定是每个品牌的成员，但只能管自己公司的）
        const home = identity
          .listOrganizations()
          .find((o) => identity.brandsOf(o.id).some((w) => w.id === actor.workspace_id))
        const sameOrg =
          home === undefined
            ? target === actor.workspace_id
            : identity.brandsOf(home.id).some((w) => w.id === target)
        if (!sameOrg) throw new ApiError('not_found', '这家公司下没有这个品牌')
        // 停 / 放开一个品牌的后台：那个品牌的负责人，或者公司的所有者 / 管理员（Fable 10-05）
        const owns = roles.assignments
          .listByPerson(actor.person_id as PersonId, {
            workspace_id: target,
            role_id: 'common.owner',
          })
          .some((a) => a.revoked_at === undefined)
        const org = identity
          .listOrganizations()
          .find((o) => identity.brandsOf(o.id).some((w) => w.id === target))
        const admin =
          org !== undefined && canAdministerOrganization(org, actor.person_id as PersonId)
        if (!owns && !admin)
          throw new ApiError('forbidden', '只有这个品牌的负责人或公司管理员能停 / 放开它的后台')
        background.setHalted(target, input.halted, actor.person_id as PersonId, input.reason)
        return background.status(target)
      },
    },
    // WP58（49 M1）：云账号关联（状态 / 起关联 / 回调 / 解除）
    cloudAccount: cloudAccount.port,
    org: org.port,
    // WP51（46）：首次设置向导、同事发现、邀请码与申请加入
    onboarding: onboarding.port,
    // WP121（70 §3）：贴一个网址，自动分析出品牌档案
    brandIntake: brandIntake.port,
    brandDesign: brandDesign.port,
    // WP65（52 O1）：组织与品牌（`/v1/orgs/*`）
    organizations: organizations.port,
    join: joinAssembly.port,
    // 41 §1 秘书面：`/v1/me/profile`、`/v1/people/:id/ask`、`/v1/people/:id/meet`、`/v1/me/secretary/route`
    // WP215：按主体所在品牌取那个品牌的秘书
    secretary: brandSecretaryPort(brandModules, async (ws) => (await secretaryOf(ws)).port),
    // 36 §3 问 AI：单轮、只回给本人、不落任何对客户可见的地方
    // WP57 / WP66：在线客服面（按品牌各一份，见 `chatPortOf`）
    chat: chatPortOf(boot),
    // WP66：问 AI 用**这个品牌**的模型与事项（问的是"我这个品牌现在怎么样"）
    ask: askPortOf,
    // WP188：随便聊（会话按品牌存；不开事项、不起运行）
    freeChat: freeChatPortOf,
    // 25 §5 定时与流程面
    schedules: createSchedulePort({
      workspace_id: workspace.id,
      scheduler: schedule.scheduler,
      workflows: schedule.workflows,
      approvals,
      // WP215：这家公司的每个品牌都能建自己的定时（之前只认第一个品牌的岗位）；
      // 跨品牌替别人建由端口那一侧拦（岗位必须在请求所在的品牌里）
      assignmentOf: (id) => {
        const found = roles.assignments.get(id)
        return found === undefined || !background.isBrand(found.workspace_id)
          ? undefined
          : {
              person_id: found.person_id,
              role_id: found.role_id,
              workspace_id: found.workspace_id,
            }
      },
      // WP181：右栏定时任务面板的「每天 / 每周几点」——官方校验、官方算下一次
      retime: (task, rule) => automation.retime(task, rule as OfficialSelector),
    }),
    // 21 §4「删这个人」：网关只转发，编排在 ./erase.ts；actor 带上 grants 与 ranges，
    // 因为数据层的删除同样要过 21 §3 的授权（没给删除开后门）
    privacy: {
      erase: async (input, actor) => {
        const config = roles.effectiveConfig(actor.assignment_id)
        const privacy = await privacyFor(actor.workspace_id)
        return privacy.erase(input, {
          person_id: actor.person_id,
          assignment_id: actor.assignment_id,
          workspace_id: actor.workspace_id,
          grants: config.scopes,
          ranges: config.ranges,
        })
      },
    },
    // 40 §2 工具箱与查重；五个"建"的入口经 `guardSimilar` 用同一份判定
    catalog: {
      ...catalog.port,
      // 复盘卡 / 工具箱上那个"合并"：出一张 policy_change 卡，批了才合
      merge: (input) =>
        catalog.proposeMerge({
          approvals,
          owner: person.id,
          role_id: ownerAssignment.role_id,
          keep: input.keep,
          drop: input.drop,
          by: input.by,
        }),
    },
    // WP36 40 §1.2：离职是一个正式动作。网关只转发，编排在 ./offboard.ts；
    // 三条路由都是 owner 级（动别人的分配、别人的个人数据、公司技能层）
    offboard: {
      offboard: (actor, person_id, input) =>
        offboard.offboard(
          {
            person_id,
            ...(input.handover_to === undefined ? {} : { handover_to: input.handover_to }),
            ...(input.personal_layer === undefined ? {} : { personal_layer: input.personal_layer }),
            ...(input.memory === undefined ? {} : { memory: input.memory }),
          },
          actor.person_id,
        ),
      archivedSkills: (_actor, owner) => offboard.archivedSkills(owner),
      adopt: (actor, input) =>
        offboard.adopt(
          {
            skill: input.skill,
            owner: input.owner,
            to_tier: input.to_tier,
            ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
          },
          { person_id: actor.person_id, role_id: actor.role_id },
        ),
    },
    // WP36 40 §1.3 备份：网关只转发；路径由服务端定（owner 也不能指定往哪写）
    ...(dbDir === undefined
      ? {}
      : {
          backup: {
            export: async (_actor, input) => {
              const out = runBackup({
                dataDir: dbDir,
                workspace_id: workspace.id,
                outDir: backupDirOf(env, dbDir),
                clock,
                keep: input.keep ?? backupKeepOf(env),
                release: env.AGENTSWS_VERSION ?? '0.1.0',
              })
              return {
                out: out.out,
                bytes: out.bytes,
                events: out.events,
                kept: out.kept,
                pruned: out.pruned,
                at: clock.now(),
              }
            },
          },
        }),
    // WP66：面板与工作模型都按品牌——首页数字块读的是**这个品牌**的店铺数据
    workstation: workstationPortOf,
    work: workPortOf,
    // WP207：左栏职责下的对话 / 任务、归档与找回（按品牌）
    workArchive: workArchivePortOf,
    // WP236：运行时长线（这台机器一份）
    runLimits: { get: () => runLimitsSettings.get(), set: (input) => runLimitsSettings.set(input) },
    // WP69（54）：岗位实体、交给岗位一件事、换职责
    positions: positionPortOf,
    // WP120（69 §4）：角色定位——右栏「角色」面板看的与改的就是它
    personas: personaPort,
    // WP68（48 §5.4）：本地红人库 `/v1/kol/*`（一个品牌一张库、一段加密库）
    kol: kolPortOf,
    // WP119（68）：浏览器插件 `/v1/extension/*`（配对码、插件令牌、观测入库）
    extension: extensionPortOf,
    // WP73（56 §6）：本地社媒库 `/v1/social/*`（同上；九条渠道是九个真账号，串不得）
    social: socialPortOf,
    // WP76（58 §5）：本地设计库 `/v1/design/*`（同上；素材按品牌进 blob store）
    design: designPortOf,
    // WP77（59 §2）：建站数据面 `/v1/site/*`（检查单 / 邮件模板 / App，一个品牌一张库）
    site: sitePortOf,
    // WP75（57 §5）：本地广告库 `/v1/ads/*`（同上；五个写口子全部先出卡）
    ads: adsPortOf,
    // WP78（60 §5）：本地公关库 `/v1/pr/*`
    pr: prPortOf,
    // WP172（docs/84）：本地 B2B 库 `/v1/b2b/*`
    b2b: b2bPortOf,
    b2bOutbound: b2bOutboundPortOf,
    b2bSales: b2bSalesPortOf,
    // WP154「内容与搜索」`/v1/seo/*`：按请求人所在品牌取那一份
    seo: seoPort,
    traceScope,
    options: {
      version: env.AGENTSWS_VERSION ?? '0.1.0',
      ...(idempotencyStore === undefined ? {} : { idempotencyStore }),
      // 本地单机档：一次性登录 token 直接回给调用方，工作台才能自动登录（20 §3）
      exposeMagicLinkToken: true,
      // 13 §5：桌面壳靠 pid / port 认出「这个 sidecar 就是我起的那个」
      instance: { pid: process.pid, port: () => boundPort },
      // 13 §5：配了会话密钥就开 cookie 那条路（`POST /v1/auth/session`）
      ...(sessionKey === undefined ? {} : { sessionKey }),
      sessionOwnerEmail: person.email,
    },
  }

  const gateway = createGateway(deps)
  /*
   * WP60：`/widget.js` 与公开访客那几条的 CORS 预检。
   *
   * 挂在网关路由之后、静态托管之前：它们不是 `/v1` 之下的 API（`/v1` 那套信封、
   * 鉴权、幂等对一段 JavaScript 与一次 OPTIONS 都没有意义），但必须排在
   * `mountStatic` 那个 `*` 前面，否则会被静态托管的 SPA fallback 吃掉。
   */
  mountChatWidget(gateway.app, {
    // 公开访客那一面照 52 O5 走 bootstrap 品牌（一个值守子进程一个品牌工作区）
    allowedOrigin: (origin) => boot.chatWidget.allowedOrigin(origin),
  })

  /*
   * WP85（54 §5）：微信 ClawBot（个人）与企业微信智能机器人（团队）。
   *
   * 挂在这儿的理由与 `mountChatWidget` 一样：网关的路由表是从 `collectRoutes()`
   * 那份声明生成的（OpenAPI 与 SDK 也从同一份生成），而这五条路由还没进契约
   * （见 WP85 报告的「契约改动」）。所以它们自带鉴权，排在网关之后、
   * `mountStatic` 那个 `*` 之前。
   *
   * 走 bootstrap 品牌：个人微信是**这台机器上这个人**的事，与品牌无关。
   */
  /*
   * WP215：**每个品牌各一套**。团队那三条（企业微信 / 飞书 / 钉钉）是公司的应用凭据，按品牌
   * 各存各的（加密库 key 带品牌前缀）、各进各的入站管线、问各自品牌的秘书；个人微信跟人走，
   * 只在第一个品牌那一套上开（同一个微信号两条长轮询会互相顶掉）。
   */
  const imFor = (ws: WorkspaceId, brand: BrandModuleSet): ImChannelsAssembly =>
    createImChannels({
      clock,
      workspace_id: ws,
      secrets: brand.secrets,
      identity,
      rawStore: brand.channels.raw,
      makePipeline: (input) => brand.channels.imPipeline(input),
      personalWechat: ws === workspace.id,
      // 游标与会话上下文跟渠道库走：落盘档重启之后不从头拉
      clawbotState: brand.channels.clawbotState,
      /*
       * WP211：三条团队渠道的真连接。企业微信那条在 WP85 只做了注入口、真装配没接上
       * （界面上填了也一直「连接中」），这里一并接上 `ws`。飞书走官方 SDK，选了才懒加载。
       */
      wecomSocket: wsSocketFactory,
      // Fable 09-30：公司的应用凭据只给负责人（`common.owner`）与公司管理员填、改、断开
      canManageTeamBots: createTeamBotManagerCheck({
        isOwner: (person_id) =>
          roles.assignments
            .listByPerson(person_id, { workspace_id: ws, role_id: 'common.owner' })
            .some((a) => a.revoked_at === undefined),
        organization: async () => {
          const org_id = (await identity.getWorkspace(ws))?.org_id
          return org_id === undefined ? undefined : identity.getOrganization(org_id)
        },
      }),
      feishuTransport: feishuSdkTransportFactory,
      dingtalkSocket: wsSocketFactory,
      dingtalkHttp: fetchHttp,
      appendEvent,
      newId: () => `im_${Math.floor(random() * 1e9).toString(36)}`,
      random,
      askAgent: async (input) => {
        // 本人问**自己的**代理：41 §1.3 的公开级别在 secretary 那一层照常生效，
        // 这里不放大任何权限（viewer === person_id 时他本来就看得见自己那一份）。
        const out = await (await secretaryOf(ws)).secretary.ask({
          viewer: input.viewer,
          person_id: input.viewer,
          question: input.question,
          assignment_id: input.assignment_id,
        })
        return { answer: out.answer }
      },
      assignmentOf: (person_id) =>
        roles.assignments
          .listByPerson(person_id, { workspace_id: ws })
          .find((a) => a.revoked_at === undefined)?.id,
      deepLinkBase: () =>
        env.AGENTSWS_SERVER_URL ??
        (boundPort === undefined ? 'http://127.0.0.1:7777' : `http://127.0.0.1:${boundPort}`),
      onError: (e) => {
        appendEvent({
          schema_version: 1,
          workspace_id: ws,
          type: 'connection.changed',
          actor: { kind: 'system', id: 'im-channels' },
          correlation: { trace_id: 'trc_im_error' },
          // 只有原因，没有凭据、没有正文
          payload: { im_event: 'im.error', detail: String(e) },
        })
      },
    })
  const imChannels = imFor(workspace.id, boot)
  const imByBrand = new Map<WorkspaceId, ImChannelsAssembly>([[workspace.id, imChannels]])
  const imOf = async (ws: WorkspaceId): Promise<ImChannelsAssembly | undefined> => {
    const known = imByBrand.get(ws)
    if (known !== undefined) return known
    if (!background.isBrand(ws) || background.stopped(ws)) return undefined
    const brand = await brandModules.forWorkspace(ws)
    const made = imByBrand.get(ws) ?? imFor(ws, brand)
    imByBrand.set(ws, made)
    return made
  }
  // WP215：路由只挂一次，按主体所在品牌转给那个品牌那一套
  mountBrandImRoutes(gateway.app, { identity, primary: imChannels, of: imOf })

  // 静态托管必须在网关路由之后挂（Hono 按注册顺序匹配，`*` 放最后）
  if (options.staticDir !== undefined) {
    mountStatic(gateway.app, {
      dir: options.staticDir,
      bootstrap: { owner_email: person.email, workspace: workspace.id, demo: mount !== undefined },
    })
  }
  let httpServer: ServerType | undefined
  let unmountWs: (() => Promise<void>) | undefined
  let closed = false

  const server: Server = {
    gateway,
    connectUrl,
    kernel,
    data,
    roles,
    knowledge,
    skills,
    learning,
    models,
    txn,
    work,
    meetings,
    /*
     * WP66：这几样现在**按品牌各一套**，这里端出去的是 bootstrap 品牌那一份。
     *
     * 为什么还留着：桌面壳、CLI 与测试都按名字拿过它们，而 `Server` 是公共接口
     * （只加不删）。要别的品牌那一套走 `server.brands.forWorkspace(ws)`。
     */
    connections: boot.connections,
    ...(boot.liveData === undefined ? {} : { liveData: boot.liveData }),
    channels: boot.channels,
    messages: boot.messages,
    b2b: boot.b2b,
    b2bOutbound: boot.b2bOutbound,
    b2bSales: boot.b2bSales,
    b2bService: boot.b2bService,
    // WP57：在线聊天车道
    chat: boot.chat,
    modelSettings: boot.ownModels,
    // WP66（52 O1）：一个进程里的多套品牌模块
    brands: brandModules,
    background,
    org,
    // WP120（69 §4）：运行时装 persona 段与右栏「角色」面板走的是同一份
    personas,
    onboarding,
    organizations,
    /*
     * WP117b（66 复测 #19）：把「批准了、等取消窗口」的卡施行掉，返回**还在等**的张数。
     *
     * 15 §5「通过 ≠ 施行」：批准只写下批准，施行由执行器另拍发起——模拟世界那一本
     * 的发起人在 demo 的 drain（`apps/cli/src/demo.ts`），服务进程这一本以前没有人
     * 发起，于是红人开发信批了之后永远停在 `approved`，演练世界一封信都收不到。
     * demo 的 drain 现在两本一起扫：先扫一遍拿到「还在等」的张数（与世界的加在
     * 一起决定要不要推合成时钟过取消窗口），推完再扫一遍真施行。
     * 取消窗口 / 父子顺序没到的下一拍再来（与模拟回路 `drainApprovals` 同一纪律）。
     */
    async drainApprovals(): Promise<number> {
      const APPROVED = ['approved', 'approved_edited', 'auto_approved'] as const
      const waiting = () =>
        txn.runtime.store
          .listApprovals({})
          .filter((i) => (APPROVED as readonly string[]).includes(i.state))
      if (waiting().length === 0) return 0
      for (const item of waiting()) {
        try {
          await txn.executor.applyApproval(item.id)
        } catch {
          // 取消窗口 / 父子顺序没到：下一拍再来
        }
      }
      return waiting().length
    },
    join: joinAssembly,
    orgDuplicates,
    secretary,
    offboard,
    secrets,
    cloudAccount,
    pricingCatalog,
    ...(contentUpdates === undefined ? {} : { contentUpdates }),
    schedule,
    automation,
    reconcile,
    ...(boot.runtime === undefined ? {} : { runtime: boot.runtime }),
    identity,
    backend,
    traceScope,
    bootstrap: { person, workspace, ownerAssignment, internalToken },
    async listen(port?: number) {
      const wanted =
        port ?? (env.AGENTSWS_PORT === undefined ? DEFAULT_PORT : Number(env.AGENTSWS_PORT))
      if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535)
        throw new Error(`AGENTSWS_PORT 不合法：${String(env.AGENTSWS_PORT)}`)
      const started = await new Promise<ServerType>((resolve) => {
        /*
         * WP134：官方 DeepSeek 账号模块的浏览器回调（`/oauth/callback`）走**这同一个端口**——
         * 它是官方在"宿主 webServer"上注册的路由，这里把那条请求的 node req / res 原样交给它
         * （它自己校验 state + PKCE、自己写响应）。没挂模块 / 不是它的路由就照常进网关。
         */
        const fetch = (req: Request, bindings: HttpBindings): Response | Promise<Response> => {
          const { incoming, outgoing } = bindings
          if (
            incoming.url?.startsWith('/oauth/callback') === true &&
            deepseekAccount.handle(incoming, outgoing)
          ) {
            return RESPONSE_ALREADY_SENT
          }
          return gateway.fetch(req)
        }
        const s = serve({ fetch: fetch as never, port: wanted, hostname: bindHost(env) }, () => {
          resolve(s)
        })
      })
      httpServer = started
      // 15 §5.8：接活之前先把账对完。`engage()` 已经在装配时把出站闸拉下来了，
      // 这里是慢的那一半（要查外部系统）；查不清的留成人工对账项，出站保持停着。
      await reconcile.run()
      // WP33：WebSocket 事件流挂在同一个端口的 upgrade 上（28 §2 唯一入口）
      unmountWs = mountEventStream({
        httpServer: started,
        deps,
        cookieName: deps.options?.sessionCookieName ?? SESSION_COOKIE,
      })
      // 25 §4：进程真的起来了才开始巡检（测试里 `scheduleIntervalMs: 0` 关掉）
      schedule.start()
      /*
       * WP85：上次绑好的微信 / 企业微信自己接着跑（游标在库里，不从头拉）。
       * 起不来不拦住整个进程——一条 IM 通道不是服务的前提，界面上会显示成「没连上」。
       */
      await imChannels.resume().catch(() => undefined)
      // WP215：其余品牌的团队渠道也各自接着跑（每个品牌自己的应用凭据、自己的入站管线）
      for (const ws of background.activeBrands()) {
        if (ws === workspace.id) continue
        await (await imOf(ws).catch(() => undefined))?.resume().catch(() => undefined)
      }
      const address = started.address()
      const bound = typeof address === 'object' && address !== null ? address.port : wanted
      boundPort = bound
      const url = `http://${HOST}:${bound}`
      server.url = url
      if (options.quiet !== true) {
        // 开发期：健康检查地址与内部凭据只在 stdout 出现一次（21 §5：不进事件日志）。
        process.stdout.write(`agentsws server listening on ${url}\n`)
        process.stdout.write(`health: ${url}/v1/health\n`)
        process.stdout.write(`workspace: ${workspace.id}  owner: ${person.email}\n`)
        process.stdout.write(
          `internal token: ${internalToken.slice(0, 8)}…（已遮罩；完整值只在进程内）\n`,
        )
      }
      return { url, port: bound }
    },
    async close() {
      if (closed) return
      closed = true
      for (const t of contentTimers) clearTimeout(t)
      // WP215：分配一变就即时对一遍定时——还在做的那几件先做完，别在关库之后再写
      await background.settled()
      if (unmountWs) {
        // 先把 WS 收掉：否则还开着的连接会让 http.Server 的 close 一直挂着
        await unmountWs()
        unmountWs = undefined
      }
      if (httpServer) {
        await new Promise<void>((resolve, reject) => {
          httpServer?.close((err) => (err ? reject(err) : resolve()))
        })
        httpServer = undefined
      }
      // WP85：先把两条 IM 长连接收掉（长轮询与 WebSocket 都会拦着进程退出）
      for (const im of imByBrand.values()) await im.close()
      // WP136：起过的其他场景一并关掉（它们是这个进程的子进程，不留孤儿占着端口）
      await dshScenesSetup.manager?.close()
      // WP245：替用户跑着的安装 / 登录一并停掉（不留孤儿进程等浏览器）
      platformCliRunner.dispose()
      // WP261：正在等浏览器的店铺授权一并停掉（回调端口整机一个，不能留着占住）
      storeAuthRunner.dispose()
      // WP247：正在下载的连接器一并停掉（下了一半的暂存目录由下载器自己清）
      localConnector?.dispose()
      learning.close()
      knowledge.close()
      data.close()
      // 接进来的世界由调用方关（它还持有事件日志与替身）
      if (options.mount === undefined) roles.close()
      meetings.close()
      schedule.close()
      automationFires?.close?.()
      catalog.close()
      for (const one of secretaries.values()) one.close()
      // WP188：随便聊的会话库（每个品牌一个）
      for (const store of freeChatStores) store.close()
      // WP66：每个品牌那一套各关各的（聊天车道 / 渠道 / 活数据源 / 连接面）
      await brandModules.dispose()
      await devMcp?.close()
      org.close()
      onboarding.close()
      joinAssembly.close()
      for (const scan of orgDuplicatesByBrand.values()) scan.close()
      offboard.close()
      await subscription.close()
      await deepseekAccount.close()
      secrets.close()
      txnStore?.close()
      workStore?.close()
      idempotencyStore?.close()
      if (identity instanceof SqliteIdentityService) identity.close()
      await kernel.dispose()
    },
  }
  return server
}

/**
 * WP154：新页面选题卡（`seo_topic`）被批了 → 那个品牌的「内容与搜索」开一件写这一页的事项。
 *
 * 照 `learning.wrap` 的做法用 Proxy（总线是类实例，方法在原型上）。只看 `seo_topic`，
 * 别的卡原样过；开事项失败不影响这一次决定本身（卡已经批了，事项可以手动开）。
 */
function seoDecided(bus: ApprovalBus, hook: SeoDecidedHook): ApprovalBus {
  return new Proxy(bus, {
    get(target, prop, receiver) {
      if (prop !== 'decide') {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (...args: Parameters<ApprovalBus['decide']>): Promise<ApprovalItem> => {
        const out = await target.decide(...args)
        if (
          out.kind === 'seo_topic' ||
          out.kind === B2B_SENDER_CHOICE_KIND ||
          out.kind === 'inbound_dead_letter' ||
          // WP268：挑图卡 / 超额卡
          out.kind === 'image_pick' ||
          out.kind === 'image_budget' ||
          // WP237：「这件事该走哪条职责」选定了 → 钉到那条、立刻开跑
          isRouteChoice(out)
        ) {
          try {
            await hook.current?.(out)
          } catch {
            // 事项没开成：卡照样是批了的，人可以在内容与搜索下自己开
          }
        }
        return out
      }
    },
  })
}

/** 品牌模块装好之后才有；决定发生时现取（与 `brands` 同一个晚绑定的套路）。每个服务进程一份。 */
interface SeoDecidedHook {
  current?: (item: ApprovalItem) => Promise<void>
}
