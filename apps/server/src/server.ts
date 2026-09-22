/**
 * 协同服务进程（28 §1「一进程含内核与全部模块」）。
 *
 * 装配顺序：kernel → data → roles → knowledge → skills → model-gateway → txn → identity → api。
 * 只监听 127.0.0.1；一个进程一个端口（`AGENTSWS_PORT`，默认 4317）。
 */
import { mkdirSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { adDesignPrompt } from '@agentsws/ads-core'
import type {
  AskPort,
  ChatPort,
  ConnectionDirectoryPort,
  PositionEntryPort,
  WorkPort,
  WorkstationPort,
} from '@agentsws/api'
import {
  ApiError,
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
  type PersonaPort,
  parseSubprotocols,
  type RolesPort,
  readCookie,
  SESSION_COOKIE,
  type SkillsPort,
  SqliteExtensionStore,
  SqliteIdempotencyStore,
  SqliteIdentityService,
  type TraceScope,
  WS_SUBPROTOCOL,
  WsSession,
} from '@agentsws/api'
import { blobKey, blobUri, openBlobStore } from '@agentsws/blob'
import { designRoleFamily } from '@agentsws/brand-design'
import type { PageFetch as BrandIntakeFetch } from '@agentsws/brand-intake'
import type { ResolveMx } from '@agentsws/channels'
import type {
  ApprovalBus,
  ApprovalItem,
  Assignment,
  BrandDesignContext,
  Clock,
  EventEnvelope,
  KolChannel,
  Person,
  PersonId,
  PromptSection,
  SkillTier,
  StartRun,
  StorefrontPlatform,
  Workspace,
  WorkspaceId,
  WorkspaceVertical,
} from '@agentsws/contracts'
import { brandNameOf, KOL_CHANNEL_IDS, PR_ROLE_IDS, SOCIAL_ROLE_IDS } from '@agentsws/contracts'
import { evaluateGuardrail, extractFigures, uncitedFigures } from '@agentsws/core'
import { createDataStore, type SqliteDataStore } from '@agentsws/data'
import { withOwnSources } from '@agentsws/deck'
import { createKernel, type Kernel, seededRandom } from '@agentsws/kernel'
import {
  cardsToPack,
  createKnowledge,
  type Knowledge,
  type RecheckStatus,
  zipFiles,
} from '@agentsws/knowledge'
import {
  createModelGateway,
  type FetchLike,
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
} from '@agentsws/roles'
import { siteDesignPrompt, themeDesignVariables } from '@agentsws/site-core'
import { createSkills, type Skills } from '@agentsws/skills'
// WP74（37 §2.5）：统一日历里社媒那一层的撞车说明，判据只有 social-core 这一份
import { scheduleConflicts } from '@agentsws/social-core'
import { detectAnsweredBoundaries, SUPPORT_BOUNDARIES } from '@agentsws/support-core'
import { createTxn, SqliteTxnStore, type Txn } from '@agentsws/txn'
import { createWork, SqliteWorkStore, type Work } from '@agentsws/work'
import { type ServerType, serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { adsDeckData, createAdsStore, seedDemoAds } from './ads.js'
import { createAdsService } from './ads-service.js'
import { compositeApprovals } from './approvals-composite.js'
import { createAskPort } from './ask.js'
import { MemoryBackend } from './backend.js'
import { type BackupRunResult, backupDirOf, backupKeepOf, runBackup } from './backup.js'
import { type BrandDesignAssembly, createBrandDesign, designPageKindOf } from './brand-design.js'
import { createBrandIntake } from './brand-intake.js'
// WP121b（70 §3.5）：确认档案卡那一刻建的首批知识条目（政策要点 + 商品卡，一律 proposed）
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
  brandCloudPort,
  brandConnectionDirectoryPort,
  brandConnectionsPort,
  brandDesignPort,
  brandKolPort,
  brandMessagesPort,
  brandModelsPort,
  brandPositionPort,
  brandPrPort,
  brandSitePort,
  brandSocialPort,
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
import { type ChannelsAssembly, type ChannelsOptions, createChannels } from './channels.js'
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
import { createChatWidget, DEFAULT_ACCENT } from './chat-widget.js'
import { type CloudFetch as CloudEntryFetch, createCloud } from './cloud.js'
import { type CloudAccountAssembly, type CloudFetch, createCloudAccount } from './cloud-account.js'
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
import { createDesignService, createDesignStore, designDeckData, seedDemoDesign } from './design.js'
import type { MdnsFactory } from './discovery.js'
import { createPrivacyErase, type PrivacyErase } from './erase.js'
// WP119（68）：浏览器插件的本地一面（配对表按机器、写库按品牌、转发由本机做）
import { createExtensionContributor } from './extension-contribute.js'
import { brandExtensionPort } from './extension-port.js'
import { createApprovalDirectory } from './housekeeping.js'
import { createImChannels } from './im-channels.js'
import { createJoin, type JoinAssembly } from './join.js'
// WP56（48 §4 #9）：知识包导入的落库那一步
import { knowledgeSourceFile } from './knowledge-file.js'
import { importKnowledgePack } from './knowledge-pack.js'
import { checkUpload, UploadRejected, uploadBlobKey, uploadSubjectRef } from './knowledge-upload.js'
import { createKolStore, kolDeckData, seedDemoKol } from './kol.js'
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
import { createMeetings, type MeetingsAssembly, seedDemoMeetings } from './meetings.js'
// WP113（63）：消息——统一收件处（消息库 / 全量同步 / 分拣 / 回写）
import { createMessages, type MessagesAssembly, type MessagesOptions } from './messages.js'
import { createModels, type ModelsAssembly, STUB_REF } from './models.js'
import { createOffboard, type Offboard } from './offboard.js'
import { createOnboarding, type OnboardingAssembly } from './onboarding.js'
import { createOrg, type OrgAssembly } from './org.js'
import { createOrgDuplicateScan, type OrgDuplicateScan } from './org-duplicates.js'
import {
  createOrganizations as createOrganizationsAssembly,
  type OrganizationsAssembly,
} from './organizations.js'
import {
  createFilePersonaBackend,
  createPersonas,
  PersonaError,
  type PersonasAssembly,
  personaFileIn,
} from './personas.js'
import { createPositions, type PositionsAssembly } from './positions.js'
import { createPrStore, prDeckData, seedDemoPr } from './pr.js'
import { createPrService } from './pr-service.js'
import {
  createReconcileGuard,
  type ReconcileGuard,
  type ReconcileGuardOptions,
} from './reconcile.js'
import { createConnectRecordSource } from './records.js'
import { readRunBrowser } from './run-browser.js'
import { createRuntime, type MatterRecordSource, type RuntimeAssembly } from './runtime.js'
import {
  createScheduleAssembly,
  createSchedulePort,
  DEFAULT_RAW_RETENTION_DAYS,
  ensureSystemTasks,
  ensureTask,
  offsetToTz,
  registerAmazonSla,
  registerApprovalHousekeeping,
  registerBackup,
  registerDailyPlan,
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
  registerSkillsWeekly,
  registerSocialBroadcast,
  registerSocialPublish,
  registerTokenRefresh,
  type ScheduleAssembly,
  type SchedulePosition,
} from './schedule.js'
import {
  createSecretStore,
  namespaceSecrets,
  type SecretStore,
  SecretStoreError,
} from './secret-store.js'
import { createSecretaryAssembly, type SecretaryAssembly } from './secretary.js'
import type { BrokerFetch } from './shopify-broker.js'
import { createShopifyDevMcp } from './shopify-devmcp.js'
// WP77（59 §1 / §2）：建站库（三张表）+ `/v1/site/*` 的实现
import { createConnectSiteFacts, createSiteService, createSiteStore, seedDemoSite } from './site.js'
import { createSocialStore, seedDemoSocial, socialDeckData } from './social.js'
// WP73（56 §6）：九条渠道真打出去的那一跳 + 社媒库的 /v1 面
import { createSocialChannels, type SocialFetch } from './social-channels.js'
import { createSocialService } from './social-service.js'
import { createStandby } from './standby.js'
import { mountStatic } from './static.js'
import { createStorage } from './storage.js'
import { createSubscription, type SubscriptionOptions } from './subscription.js'
import {
  createSupportJudgment,
  SUPPORT_SLA_HANDLER,
  SUPPORT_SLA_TASK_ID,
  type SupportJudgment,
  supportSlaTask,
} from './support-judgment.js'
// WP60（48 §4 L3 #11 的云端一半）：聊天窗的嵌入脚本与 CORS 预检
import { CHAT_WIDGET_JS, mountChatWidget } from './widget.js'
import { createWorkPort, periodQueryRunner } from './work.js'
import {
  createWorkstationPort,
  emptyDataSource,
  type WorkstationDataSource,
} from './workstation.js'

/** 战报要数「今天处理掉的」，所以取队列时状态放全（等待类计数在 work 端自己过滤）。 */
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
  'social.meta',
  'social.tiktok',
  'social.x',
  'social.youtube',
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
  /** WP42：抓各家价目页用的 fetch（测试回放固定页面 → 价目刷新全程不联网）。 */
  pricingFetch?: PageFetch
  /**
   * WP90（55 §9 Q8）：起订阅登录那棵 dsh 树的工厂（测试注入替身 → 全程不联网、
   * 也不真的装一棵 Cordis 树）。生产不传：第一次有人点"用订阅登录"时才
   * `await import('@agentsws/dsh-adapter')`。
   */
  subscriptionLogin?: SubscriptionOptions['createLogin']
  /**
   * WP58（49 M1）/ WP59（49 M3）：往 agentsws 云发请求用的 fetch——关联账号那条
   * 与余额 / 价目那条共用同一个注入点。生产不传（走 `globalThis.fetch`）；
   * 测试传一个指向内存版 `createCloudServer()` 的替身 → 全程不联网。
   * 两边各自只用到 Response 的一小面（`text()` / `json()`），所以这里收一个交集。
   */
  cloudFetch?: CloudFetch & CloudEntryFetch
  /**
   * WP68（48 §5.4）：五条渠道适配器打出去用的 fetch。
   *
   * 生产不传（走 `globalThis.fetch`）；测试传一个假的，对着**真 URL 形状**断言——
   * 这五家的接口没有可以随便调的沙箱，所以"形状对不对"只能这么验。
   */
  kolFetch?: KolFetch
  /**
   * WP121b（70 §3）：品牌接入面（贴一个网址自动分析）抓页面用的 fetch。
   *
   * 生产不传（走 `globalThis.fetch`）；`agentsws demo` 传一个 replay——
   * demo 是**离线**的，它不该因为演示而去敲别人的服务器，也不该因为没网
   * 就演不出第 ② 步那张档案卡。
   */
  brandIntakeFetch?: BrandIntakeFetch
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
  /** 25 定时与流程：调度器 + 流程引擎 + 各个消费者的登记。 */
  schedule: ScheduleAssembly
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
  const clock: Clock = options.clock ?? { now: () => new Date().toISOString() }
  const random = options.random ?? seededRandom(Date.parse(clock.now()) % 2147483647)
  const dbDir = options.dbDir
  if (dbDir !== undefined) mkdirSync(dbDir, { recursive: true })
  const file = (name: string): string => (dbDir === undefined ? ':memory:' : join(dbDir, name))

  // 08 / 18：OpenConnector 的地址只在这一处解析（桌面壳读同名环境变量）
  const connectUrl = connectBaseUrl(env)

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
  }

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
  for (const migrated of roles.assignments.migrateRoleIds()) {
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
  const makeGateway = (): ModelGatewayApi =>
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
      ...(options.mount === undefined ? {} : { images: stubImageProvider({ seed: 7 }) }),
      policy: { default: STUB_REF, data_residency: 'cn', prices: priceTable },
      clock,
      env,
      halt: kernel.halt,
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
  const brandNameOfWorkspace = (id: WorkspaceId): string => {
    const owner = bootstrapOwner
    const found =
      owner === undefined ? undefined : identity.workspacesOf(owner).find((w) => w.id === id)
    return found === undefined ? (bootstrapWorkspaceName ?? id) : brandNameOf(found)
  }

  /** 组织上的公司级三样（首次设置那一面读它，不直接拿整个 `Organization`）。 */
  const organizationProfileOf = (
    id: string,
  ): { legal_name: string; domain?: string; discoverable: boolean } | undefined => {
    const org = identity.getOrganization(id)
    if (org === undefined) return undefined
    return {
      legal_name: org.legal_name,
      ...(org.domain === undefined ? {} : { domain: org.domain }),
      discoverable: org.discoverable,
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

  // 37 工作模型：给了数据目录就落盘（事项 / 时间线 / 目标 / 待办 / 计划 / 复盘）
  const workStore =
    dbDir === undefined
      ? undefined
      : new SqliteWorkStore({ dbPath: join(dbDir, 'work.sqlite'), clock })

  // ── 首次启动：owner + 默认工作区 + 内部凭据（28 §3「内部服务凭据」）
  const mount = options.mount
  const ownerEmail = mount?.owner.email ?? (env.AGENTSWS_OWNER_EMAIL?.trim() || 'owner@localhost')
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
    // 整个工作区的岗位（不是本人那几个）：算"哪些岗位在用"要全的
    positions: () =>
      roles.roles
        .list()
        .flatMap((r) => roles.assignments.listByRole(r.id, { workspace_id: workspace.id }))
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
  const approvals = catalog.wrap(learning.wrap(rawApprovals))
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
  // 默认**不起**：它要 `npx` 去网上拉一个包，装在别人机器上的进程不该悄悄这么干。
  // `AGENTSWS_SHOPIFY_DEVMCP=1` 打开。起不来就是空工具面（`toolNames()` 回空数组），
  // 写类变更照常能 stage——校验是加固，不是门禁。
  //
  // 它是**全进程一个**：一个只读的文档 / schema 工具源，与是哪个品牌无关。
  const devMcp =
    env.AGENTSWS_SHOPIFY_DEVMCP === '1'
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
  // 起它这件事不该拦着服务进程启动：后台起，起好之前 `toolNames()` 就是空的
  if (devMcp !== undefined) void devMcp.start()

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
     * 定位、市场、口吻样例还没有落盘的地方（WP121b 正在重写向导），所以现在它们
     * 一律取不到，于是 persona 里就没有那几行——这正是 69 §5 要的行为：**别编**。
     * WP122 的「视觉气质」走同一个槽位（`visual_tone`），填上就多一行。
     */
    brand: () => {
      const name = onboardingRef?.companyProfile()?.legal_name?.trim()
      return name === undefined || name === '' ? undefined : { brand_name: name }
    },
    appendEvent,
  })

  const assembleBrand = async (ws: WorkspaceId): Promise<BrandModuleSet> => {
    const isBootstrap = ws === workspace.id
    const dir = brandDirOf(dbDir, ws, workspace.id)
    // 新品牌的目录第一次用的时候才建（`better-sqlite3` 不会替我们 mkdir）
    if (dir !== undefined) mkdirSync(dir, { recursive: true })
    // 同一个加密库、同一把密钥，key 名按品牌加前缀（bootstrap 前缀为空）
    const brandSecrets = namespaceSecrets(secrets, secretsPrefixOf(ws, workspace.id))

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
    const workData: WorkstationDataSource = {
      ...baseWorkData,
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
      ads: () => adsDeckData(ads, { now: clock.now() }),
      // WP78（60 §3）：公关那五块同理——待发的稿子、自己攒的媒体名单是
      // **我们自己写的**，与连没连 Google Alerts 无关。外面那一侧（提及流 /
      // 负面预警）走 `google_alerts` 那个源，没连就照 36 §3 明说。
      pr: () => prDeckData(pr),
      // 红人库与社媒库都不是"连接"，所以它们不在那两份写死的数据源表里（见 `withOwnSources`）
      sources: () => withOwnSources(baseWorkData.sources()),
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
    const socialChannels = createSocialChannels({
      workspace_id: ws,
      clock,
      connections: () => connections.liveConnections(),
      secrets: brandSecrets,
      ...(options.socialFetch === undefined ? {} : { fetch: options.socialFetch }),
    })
    /**
     * WP73：社媒库的 `/v1` 面。
     *
     * `triage.ts` 与 `moderation.ts` 的调用方就在它里面——56 那条
     * "群里的客户问题不归社媒运营"的边界，从这一跳起是真会发生的事。
     */
    const socialService = createSocialService({
      workspace_id: ws,
      store: social,
      // WP73：到点真发出去那一跳走这九条适配器
      channels: socialChannels,
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
    const prService = createPrService({
      workspace_id: ws,
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
      store: ads,
      clock,
      ledger: txn.ledger,
      effectiveConfig: (id) => roles.effectiveConfig(id),
      appendEvent,
      random,
    })

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
    const ownGateway = makeGateway()
    const ownCloud = createCloud({
      clock,
      secrets: brandSecrets,
      env,
      // WP118 / 67 §3：云端红人库要同步的就是这个品牌自己那本红人库
      kol: () => kol,
      ...(dir === undefined ? {} : { dbDir: dir }),
      ...(options.cloudFetch === undefined ? {} : { fetch: options.cloudFetch }),
    })
    const ownModels = createModels({
      clock,
      gateway: ownGateway,
      secrets: brandSecrets,
      env,
      // WP42：价目刷新是一次普通出站 HTTP GET，照 28 §1 的 outbound 档管
      halt: kernel.halt,
      appendEvent: (e) => {
        appendEvent(e)
      },
      workspace_id: () => ws,
      ...(dir === undefined ? {} : { dbDir: dir }),
      ...(options.modelFetch === undefined ? {} : { fetch: options.modelFetch }),
      ...(options.pricingFetch === undefined ? {} : { pageFetch: options.pricingFetch }),
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
    const gatewayProxy: ModelGatewayApi = {
      complete: (req) => effectiveGateway().complete(req),
      transcribe: (req, meta, model) => effectiveGateway().transcribe(req, meta, model),
      usage: (filter) => effectiveGateway().usage(filter),
      records: () => effectiveGateway().records(),
      reconfigure: (next) => {
        effectiveGateway().reconfigure(next)
      },
      providers: () => effectiveGateway().providers(),
      budget: (filter) => effectiveGateway().budget(filter),
      embed: (req, meta) => effectiveGateway().embed(req, meta),
    }

    // 17 §4：换运行时只换这一处。`startRun: false` = 这个进程不跑运行时（老行为）。
    const runtime: RuntimeAssembly | undefined =
      options.startRun === false || typeof options.startRun === 'function'
        ? undefined
        : createRuntime({
            workspace_id: ws,
            clock,
            random,
            env,
            models: gatewayProxy,
            approvals,
            roles,
            appendEvent,
            // WP25：有没有模型问模型面（加密库里的配置 + 环境变量兜底）
            hasModel: () => effectiveModels().configured(),
            modelRef: () => effectiveModels().defaultRef(),
            // WP29：解析后的技能正文进 prompt——采纳过的 overlay 下一次运行就生效
            skills: skills.registry,
            ...(devMcp === undefined
              ? {}
              : {
                  devTools: {
                    toolNames: () => Object.keys(devMcp.status().mapped),
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
            vertical: () => brandProfileOf(ws).vertical,
            // WP82：这台机器配了浏览器才有；配没配由设置页说了算，改了不用重启
            browser: () => browserSettings.forRun(),
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
            personaSections: (input) => personas.sections(input),
            /*
             * WP122b（71 §9 第 7 条）：三个注入口通电——建站 / 社媒 / 投放出活时
             * 提示词里真带上品牌令牌。照 `design.ts` 的样板：取值口 + 现取
             * （每次运行都重新问 `brandDesignRef`，用户改一格下一次运行就生效）。
             * 出图那条路已在 `design.ts` 逐图注入（WP122），这里只补另外三条。
             */
            brandDesign: (role_id) => brandDesignSectionOf(ws, role_id),
          })
    const startRun = typeof options.startRun === 'function' ? options.startRun : runtime?.startRun

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
      appendEvent,
    })
    positionAssemblies.set(ws, positionsAssembly)
    // 六层技能里的 `position` 那一层、以及岗位层上下文那三样，都从这里来
    runtime?.bindPositions({
      positionOf: (role_id) => positionsAssembly.positionOf(role_id),
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
      halt: kernel.halt,
      // 18 §2.1 第一条纪律：受控原始材料区加密。与会议档共用同一个密钥环，
      // **但不共用它的表**（35 §2）。漏了这一行，邮件原文就是明文落盘。
      cipher: data.keyring,
      // WP40：附件字节落对象存储；邮件原文是文本，照旧留库加密
      ...(blobs === undefined ? {} : { blobs }),
      accounts: () => connections.mailAccounts(),
      credentials: connections.credentialSource(),
      work,
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
    const chat = createChatLane({
      clock,
      workspace_id: ws,
      appendEvent,
      halt: kernel.halt,
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
    const messages = createMessages({
      clock,
      workspace_id: ws,
      appendEvent,
      halt: kernel.halt,
      accounts: () => connections.mailAccounts(),
      credentials: connections.credentialSource(),
      work,
      position: () => firstPositionOf(ws),
      // 岗位开没开每次现查：昨天开了今天关了，信就不该再往 kefuagents 里挪
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
      // WP125（72 §P0-1）：分拣判成 `support` 的来信，下一步进客服判断层
      onSupportMail: async (input) => {
        await supportJudgmentRef?.judgeInbound(input)
      },
      ...(dir === undefined ? {} : { dbDir: dir }),
      ...(options.messageSource === undefined ? {} : { makeSource: options.messageSource }),
      ...(options.messageWriter === undefined ? {} : { makeWriter: options.messageWriter }),
    })

    // WP60（48 §4 L3 #11 的云端一半）：聊天窗的公开访客面（白名单 + 限流 + 访客令牌）
    const chatWidget = createChatWidget({
      workspace_id: ws,
      clock,
      chat,
      secrets: brandSecrets,
      ...(dir === undefined ? {} : { dbDir: dir }),
    })

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
       * 63 §4 那条链说的是：红人来信 → `route: 'kol'` → 挪进 `kolagents` 文件夹 →
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
          folder: 'kolagents',
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
      connections,
      ...(liveData === undefined ? {} : { liveData }),
      workData,
      records,
      kol,
      kolService,
      kolSandbox,
      pr,
      prService,
      social,
      socialService,
      socialChannels,
      design,
      designService,
      site,
      siteService,
      ads,
      adsService,
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
      async dispose() {
        await chat.close()
        messages.close()
        await channels.close()
        liveData?.close()
        connections.close()
        kol.close()
        // 云端红人库的同步账本也握着一个句柄（WP118）：跟着这个品牌一起关
        ownCloud.kolSync?.close()
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

  brands = createBrandModules({
    bootstrap: workspace.id,
    create: (ws) => assembleBrand(ws),
    orgDefault: (ws) => orgDefaultBrandOf(ws),
    brands: () => brandsOfThisOrg(),
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  const brandModules: BrandModules = brands
  /** bootstrap 品牌那一套：进程自己要用的那几处（会议 ASR、秘书、问 AI）取它。 */
  const boot = await brandModules.forWorkspace(workspace.id)
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
  })
  // 计划 / 复盘 / 战报这几条仍按 bootstrap 品牌那一套跑（52 O5：值守子进程一个品牌一个）
  const workData = boot.workData
  const work = boot.work
  const scheduleTz = offsetToTz(workData.tz_offset_minutes)
  const positionsOf = (): SchedulePosition[] =>
    roles.assignments
      .listByPerson(person.id, { workspace_id: workspace.id })
      .filter((a) => a.revoked_at === undefined)
      .map((a) => ({ assignment_id: a.id, person_id: a.person_id, role_id: a.role_id }))
  const cardsOfPosition = async (p: SchedulePosition): Promise<ApprovalItem[]> =>
    (await approvals.queue({
      workspace_id: workspace.id,
      person_id: p.person_id,
      lane: 'mine',
      state: [...QUEUE_STATES],
    })) as ApprovalItem[]
  const planDeps = {
    workspace_id: workspace.id,
    work,
    approvals,
    positions: positionsOf,
    tz: scheduleTz,
    goals: async (p: SchedulePosition) =>
      work.progress(
        periodQueryRunner(
          () => workData.orders({ assignment_id: p.assignment_id }),
          () => [],
          'USD',
        ),
        { position_id: p.assignment_id, status: ['active'] },
      ),
    cardsWaiting: async (p: SchedulePosition) =>
      (await cardsOfPosition(p)).filter((i) => WAITING_QUEUE_STATES.has(i.state)).length,
  }
  // ① 每日计划、② 复盘（day / week / month）、⑦ 复盘 → 次日计划草案的接力
  registerDailyPlan(schedule.scheduler, planDeps)
  const relay = registerPlanRelay({
    workspace_id: workspace.id,
    scheduler: schedule.scheduler,
    work,
    tz: scheduleTz,
  })
  registerReview(schedule.scheduler, {
    ...planDeps,
    cards: cardsOfPosition,
    lessons: () =>
      skills.lessons
        .list({ workspace_id: workspace.id, status: 'pooled' })
        .map((l) => ({ id: l.id, text: l.text })),
    relay: (review) => relay(review),
    // 40 §2.2：周复盘报"疑似重复"，并把过了 Wilson 门槛的好东西往上浮
    catalog: {
      duplicates: (limit) => catalog.duplicates(limit),
      proposePromotions: (deps, named) => catalog.proposePromotions(deps, named),
    },
  })
  // ③ 会议记录源轮询
  registerMeetingPoll(schedule.scheduler, {
    workspace_id: workspace.id,
    clock,
    meetings,
    actor: person.id,
  })
  // ④ 幂等表清理（内存档的那份归网关自己管，这里只扫落盘那份）
  if (idempotencyStore !== undefined) {
    registerIdempotencySweep(schedule.scheduler, { clock, store: idempotencyStore })
  }
  // ⑤ Shopify 令牌刷新：到期前一小时
  // WP66：每个品牌各有一套 Shopify 客户端凭据，所以换令牌要一个品牌一个品牌地换
  registerTokenRefresh({
    clock,
    scheduler: schedule.scheduler,
    refreshTokens: async () => {
      for (const brand of await brandModules.all()) await brand.connections.refreshTokens()
    },
    expiries: () =>
      brandModules.loaded().flatMap((b) => b.connections.shopify.list().map((r) => r.expires_at)),
  })
  // ⑥ 技能周合并
  registerSkillsWeekly(schedule.scheduler, {
    workspace_id: workspace.id,
    clock,
    weeklyConsolidate: (ws, now) => learning.weeklyConsolidate(ws, now),
  })
  // ⑧ 学习回路：每天 07:30 把昨天学到的整理成一张选择题卡
  registerLearning(schedule.scheduler, { clock, proposeDaily: (now) => learning.proposeDaily(now) })
  // ⑧ 审批过期与升级（39 待办 A）：模拟回路每 tick 调一次，真机器每分钟调一次。
  //    预占的「过期释放」也挂在这条上——15 §3.2 (d) 的释放是跟着审批项过期走的。
  registerApprovalHousekeeping(schedule.scheduler, { approvals })
  /*
   * ⑨ 邮箱轮询 + 入站管线的重试推进（39 待办 C）。
   *
   * WP66（52 O1）：调度器本体共享，**任务按品牌各跑一轮**——品牌 A 的信只能从 A 的
   * 邮箱进 A 的队列。走 `all()` 而不是 `loaded()`：一个今天没人点开过的品牌
   * 照样要收信，不能等到有人切过去才开始收。
   */
  registerMailPoll(schedule.scheduler, {
    poll: async () => {
      const out = { accounts: 0, messages: 0, retried: 0, failed: [] as string[] }
      for (const brand of await brandModules.all()) {
        const one = await brand.channels.poll()
        out.accounts += one.accounts
        out.messages += one.messages
        out.retried += one.retried
        // 哪个品牌的哪个账号拉不动要看得出来（一个坏了不该拖垮别的）
        out.failed.push(...one.failed.map((f) => `${brand.workspace_id}:${f}`))
        /*
         * WP113（63 §3）：同一拍里把**整只邮箱**也拉一轮（六个文件夹各一个游标）。
         *
         * 挂在同一条任务上而不是另起一条定时器：两条路看的是同一只邮箱，
         * 分开跑只会让"现在到底收到哪儿了"有两个答案。上面那一轮扫 INBOX 把客户
         * 来信变成事项，这一轮把每一封信落进消息库——租约 key 已经错开
         * （`msg:<地址>`），互相不抢。
         *
         * 一个品牌的消息同步炸了不该拖垮别的品牌的收信，所以单独 catch。
         */
        try {
          const mail = await brand.messages.poll()
          out.failed.push(...mail.failed.map((f) => `${brand.workspace_id}:messages:${f}`))
        } catch (e) {
          out.failed.push(
            `${brand.workspace_id}:messages: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      return out
    },
  })
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
  // WP55 / 48 §4 L3 #2：Amazon 24h 响应线三档 sweep（每 5 分钟，幂等三字段）
  registerAmazonSla(schedule.scheduler, {
    sweep: async () => {
      const out = { scanned: 0, reminders: 0, criticals: 0, accounted: 0 }
      for (const brand of await brandModules.all()) {
        const one = await brand.channels.amazonSlaSweep()
        out.scanned += one.scanned
        out.reminders += one.reminders
        out.criticals += one.criticals
        out.accounted += one.accounted
      }
      return out
    },
  })
  /*
   * WP68 / 48 §5.2：红人开发信的序列跟进，每天一轮，**按品牌各跑一轮**
   * （照 WP66 的写法）。一个品牌的跟进信只能用那个品牌的红人库与那个品牌的额度。
   */
  registerKolSequence(schedule.scheduler, {
    sweep: async () => {
      const out = { scanned: 0, staged: 0, skipped: [] as unknown[] }
      for (const brand of await brandModules.all()) {
        const one = await brand.kolService.sweepSequences()
        out.scanned += one.scanned
        out.staged += one.staged
        // 哪个品牌的哪一条没提要看得出来（一个坏了不该拖垮别的）
        out.skipped.push(...one.skipped.map((x) => ({ ...x, workspace_id: brand.workspace_id })))
      }
      return out
    },
  })
  /*
   * WP73 / 56 §6：社媒定时发布，每 5 分钟一轮，**按品牌各跑一轮**。
   *
   * 一个品牌的内容只能用那个品牌的连接与那个品牌的号发出去——串了品牌
   * 等于用 B 的号发 A 的东西，而那件事在平台那边是收不回来的。
   */
  /*
   * WP78 / 60 §5：品牌监控，每 15 分钟一轮，**按品牌各跑一轮**。
   *
   * 一个品牌的提及只能进那个品牌的库——媒体名单与舆情记录串了品牌，
   * 等于把一家公司攒了很多年的东西端给另一家。
   */
  registerPrMonitor(schedule.scheduler, {
    sweep: async () => {
      const out = { pulled: 0, created: 0, carded: 0, routed: 0, skipped: [] as unknown[] }
      for (const brand of await brandModules.all()) {
        const one = await brand.prService.monitorSweep()
        out.pulled += one.pulled
        out.created += one.created
        out.carded += one.carded
        out.routed += one.routed
        // 哪个品牌的哪个源没拉到要看得出来（一个坏了不该拖垮别的，
        // 而且"没拉到"这句话要一路走到面板上）
        out.skipped.push(...one.skipped)
      }
      return out
    },
  })
  registerSocialPublish(schedule.scheduler, {
    sweep: async () => {
      const out = { due: 0, published: 0, failed: 0, skipped: [] as unknown[] }
      for (const brand of await brandModules.all()) {
        const one = await brand.socialService.publishDue()
        out.due += one.due
        out.published += one.published
        out.failed += one.failed
        // 哪个品牌的哪一条没发要看得出来（一个坏了不该拖垮别的）
        out.skipped.push(...one.skipped.map((x) => ({ ...x, workspace_id: brand.workspace_id })))
      }
      return out
    },
  })
  /*
   * WP73 / 56 §6：批过的群发分批发出去，每分钟一轮，**按品牌各跑一轮**。
   */
  registerSocialBroadcast(schedule.scheduler, {
    sweep: async () => {
      const out = { due: 0, sent: 0, failed: 0, recipients: 0, skipped: [] as unknown[] }
      for (const brand of await brandModules.all()) {
        const one = await brand.socialService.broadcastDue()
        out.due += one.due
        out.sent += one.sent
        out.failed += one.failed
        out.recipients += one.recipients
        out.skipped.push(...one.skipped.map((x) => ({ ...x, workspace_id: brand.workspace_id })))
      }
      return out
    },
  })
  // WP55 / 48 §4 L3 #4：出站对账（每分钟）。`sent_unknown` 绝不自动重发
  registerReconcileDeliveries(schedule.scheduler, {
    reconcile: async () => {
      const out = { scanned: 0, confirmed: 0, still_unknown: 0, escalated: 0 }
      for (const brand of await brandModules.all()) {
        const one = await brand.channels.reconcileDeliveries()
        out.scanned += one.scanned
        out.confirmed += one.confirmed
        out.still_unknown += one.still_unknown
        out.escalated += one.escalated
      }
      return out
    },
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

  // WP50 45 H4：夜里扫一遍重复的品牌 / 产品线 / 店铺范围。装在这儿而不是 `createOrg`
  // 旁边，是因为它只认识职责层与审批总线——制度面那一套（岗位、成员、邀请）与它无关。
  const orgDuplicates = createOrgDuplicateScan({
    workspace_id: workspace.id,
    clock,
    roles,
    approvals,
    appendEvent,
    owner: async () => (await identity.getWorkspace(workspace.id))?.owner_id,
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  registerOrgDuplicateScan(schedule.scheduler, { scan: () => orgDuplicates.run() })

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

  /*
   * WP57：求助超时巡检（`support.chat_assist_timeout`，30 秒一拍）。
   *
   * 登记与排期放在一起，是为了不让调度装配那边多认识一个业务概念——
   * `createScheduleAssembly` 的消费者清单是注册表，注册表只追加（35 §2）。
   */
  schedule.scheduler.register(CHAT_ASSIST_TIMEOUT_HANDLER, async () => {
    const out = { scanned: 0, reminded: 0, demoted: 0 }
    for (const brand of await brandModules.all()) {
      const one = await brand.chat.sweepAssistTimeouts()
      out.scanned += one.scanned
      out.reminded += one.reminded
      out.demoted += one.demoted
    }
    return out
  })
  await ensureTask(
    schedule.scheduler,
    CHAT_ASSIST_TASK_ID,
    chatAssistTask({
      workspace_id: workspace.id,
      owner: person.id,
      role_id: ownerAssignment.role_id,
      assignment_id: ownerAssignment.id,
    }),
  )

  /*
   * WP125（72 §P0-1 ②）：**首响 SLA 巡检**（`support.sla_sweep`，一刻钟一拍）。
   *
   * 超时没回的来信进**岗位面板与通知，不出卡**（36 §2.2b：只有要人拍板的才是卡；
   * 一封信超时了要的是"去看一眼"，不是"在两个选项里挑一个"）。
   * 登记与排期放在一起，理由同上面那条聊天求助巡检。
   */
  schedule.scheduler.register(SUPPORT_SLA_HANDLER, async () => {
    const out = { scanned: 0, reminded: 0, breached: 0 }
    for (const brand of await brandModules.all()) {
      const one = await brand.supportJudgment.sweepSla()
      out.scanned += one.scanned
      out.reminded += one.reminded
      out.breached += one.breached
    }
    return out
  })
  await ensureTask(
    schedule.scheduler,
    SUPPORT_SLA_TASK_ID,
    supportSlaTask({
      workspace_id: workspace.id,
      owner: person.id,
      role_id: ownerAssignment.role_id,
      assignment_id: ownerAssignment.id,
    }),
  )

  await ensureSystemTasks(schedule.scheduler, {
    workspace_id: workspace.id,
    owner: person.id,
    role_id: ownerAssignment.role_id,
    assignment_id: ownerAssignment.id,
    tz: scheduleTz,
    positions: positionsOf(),
    has: {
      work: true,
      meetings: true,
      idempotency: idempotencyStore !== undefined,
      shopify: true,
      skills: true,
      learning: true,
      approvals: true,
      mail: true,
      raw: true,
      backup: dbDir !== undefined,
      pricing: true,
      orgDuplicates: true,
      /*
       * WP68：有人持有红人那几条渠道职责时才建这一条。
       *
       * 没人做红人营销的机器上建一条每天都跑一遍空库的任务，只是给 25 §3 的
       * "机器在替你定时做哪几件事"那张清单添一行看不懂的东西。
       */
      kol: KOL_CHANNEL_IDS.some(
        (channel) => roles.assignments.listByRole(`kol.${channel}`).length > 0,
      ),
      /*
       * WP73：有人持有社媒那九条渠道职责之一时才建那条巡检。
       * 与红人那一条同理——没人做社媒的机器上不该有这一行。
       */
      social: SOCIAL_ROLE_IDS.some((role_id) => roles.assignments.listByRole(role_id).length > 0),
      // WP78（60 §5）：有人持有公关那四条职责之一才建品牌监控那条定时
      pr: PR_ROLE_IDS.some((role_id) => roles.assignments.listByRole(role_id).length > 0),
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
  })
  rangeExpandedSink = org.onRangeExpanded

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
    workspaceName: () => workspace.name,
    appendEvent,
    roles,
    approvals,
    identity: {
      personByEmail: (email) => identity.personByEmail(email),
      createPerson: (input) => identity.createPerson(input),
      addMember: (m) => identity.addMember(m),
    },
    members: async () => {
      const rows = await identity.members(workspace.id)
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
    // WP66：首次设置这一面仍然只问 bootstrap 品牌那一套（52 O5：一个值守子进程
    // 一个品牌；向导本来就是"把当前这台机器上的这个品牌设起来"）
    connectedKinds: () => boot.connections.connectedKinds(),
    installedSkills: () => skills.registry.listSkillNames(),
    modelConfigured: () => boot.ownModels.configured(),
    // 46 I6：连上 Shopify 的店自动挂上岗位的范围；一家没连就挂空
    shopifyStores: () =>
      boot.connections.shopify.list().map((r) => ({ id: r.shop, label: r.alias })),
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
    // 52 O1：品牌名（顶栏切换器显示的那一个）。没迁过的就是工作区名
    brandName: () => brandNameOfWorkspace(workspace.id),
    setBrandName: (name) => {
      void identity.setBrand(workspace.id, { name }).catch(() => undefined)
    },
    updateOrganization: (patch) => {
      if (bootstrapOrg === undefined) return
      // 两档身份服务这一步都是同步落库的（Promise 只是签名）；唯一可能的失败是
      // 空的公司全称，而那一条 `setProfile` 在更早的地方就挡掉了
      void identity.updateOrganization(bootstrapOrg, patch).catch(() => undefined)
    },
  })

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
    newId: (prefix) => `${prefix}_${Math.floor(random() * 1e12).toString(36)}`,
    sinks: {
      applyProfile: async (profile) => {
        const legal = profile.legal_name?.value ?? profile.brand_name?.value
        if (typeof legal !== 'string' || legal.trim() === '') return
        await onboarding.port.setProfile(
          {
            workspace_id: workspace.id,
            person_id: person.id,
            assignment_id: '',
            role_id: '',
          },
          {
            legal_name: legal,
            ...(typeof profile.brand_name?.value === 'string'
              ? { brand_name: profile.brand_name.value }
              : {}),
            ...(profile.storefront_platform === undefined
              ? {}
              : { storefront_platform: profile.storefront_platform.value }),
          },
        )
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
      seedKnowledge: async (profile) => {
        for (const card of brandKnowledgeCards(profile, {
          workspace_id: workspace.id,
          at: clock.now(),
          owner: person.id,
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
    // WP122b 交付 ⑤：视觉档。走用户配置的模型（同一条默认 ref）；
    // 没配 provider 就回 undefined，看图整步跳过，产物里 imagery 留「未找到」。
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
      await cloudAccount.ensureBrandToken(ws)
    },
    // 发现开关的真源在组织上，但"开 / 关"这个动作在首次设置那一面——两边改都得生效
    onCompanyChanged: ({ by, discoverable, key_changed }) => {
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
    list: (actor) => learning.summaries(actor),
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

  /**
   * 41 §1 秘书 Agent。装在最后：它要用到工作模型、会议、工具箱、审批总线与调度器，
   * 自己不被任何人依赖——秘书是**加分项**，拆掉它工作台照常能用。
   */
  const secretary = createSecretaryAssembly({
    workspace_id: workspace.id,
    clock,
    random,
    appendEvent,
    tz_offset_minutes: workData.tz_offset_minutes,
    ...(dbDir === undefined ? {} : { dbDir }),
    identity: {
      members: (ws) => identity.members(ws),
      getPerson: (id) => identity.getPerson(id),
    },
    roles,
    work,
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
        .list({ workspace_id: workspace.id, owner: person_id })
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
                  { now: clock.now(), tz_offset_minutes: workData.tz_offset_minutes },
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
      const found = assembly.positionOf(assignment.role_id)
      if (found.position_id === undefined)
        throw new ApiError('not_found', found.note ?? `没有这个岗位：${id}`)
      return found.position_id
    }
    const port: PositionEntryPort = {
      instance: (actor, id) => assembly.instance(resolveId(actor, id), actor.person_id),
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
      reroute: async (actor, matter_id, role_id) => {
        const out = await assembly.reroute({ matter_id, role_id, person_id: actor.person_id })
        return {
          matter: {
            id: out.matter.id,
            ...(out.matter.role_id === undefined ? {} : { role_id: out.matter.role_id }),
          },
          assignment_id: out.assignment_id,
        }
      },
    }
    positionPorts.set(ws, port)
    return port
  }
  const positionPortOf = brandPositionPort(brandModules, positionPortFor)

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
         * 只改一边时另一边**先从现在生效的那一份补齐**，再整份存下去。
         * 不补的话 `{ zh: '新的' }` 存进去就是"英文那份空着"，而空着的那一份
         * 在 `applyPersonaOverride` 里会回落包里的原文——看着对，其实是两份
         * 不同来历的文字拼在一起，公司改了中文却不知道英文没跟着改。
         */
        const current = personas.view(subject).effective
        return personas.set({
          subject,
          text: {
            zh: text.zh ?? personaTextIn(current, 'zh'),
            en: text.en ?? personaTextIn(current, 'en'),
          },
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
      }
    },
  })
  /** WP73（56 §6）：社媒库 `/v1/social/*`（一个品牌一张库、一段加密库）。 */
  const socialPortOf = brandSocialPort(
    brandModules,
    async (ws) => (await brandModules.forWorkspace(ws)).socialService.port,
  )
  /** WP78（60 §5）：公关库 `/v1/pr/*`（同上；媒体名单是一家公司攒了很多年的东西）。 */
  const prPortOf = brandPrPort(
    brandModules,
    async (ws) => (await brandModules.forWorkspace(ws)).prService.port,
  )
  /** WP75（57 §5）：广告库 `/v1/ads/*`（一个品牌一张库——广告账户是花钱的，串不得）。 */
  const adsPortOf = brandAdsPort(
    brandModules,
    async (ws) => (await brandModules.forWorkspace(ws)).adsService.port,
  )
  /** WP77（59 §2）：建站数据面 `/v1/site/*`（一个品牌一张库）。 */
  const sitePortOf = brandSitePort(
    brandModules,
    async (ws) => (await brandModules.forWorkspace(ws)).siteService.port,
  )
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

  const workPortOf = brandWorkPort(brandModules, workPortFor)
  const workstationPortOf = brandWorkstationPort(brandModules, workstationPortFor)
  const askPortOf = brandAskPort(brandModules, askPortFor)

  const deps: GatewayDeps = {
    identity,
    halt: kernel.halt,
    trace: kernel.trace,
    clock,
    eventLog: eventLogPort,
    modules: kernel.modules,
    reconcile,
    approvals,
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
    }),
    // WP59 / WP66：`/v1/cloud/*` 与 `/v1/settings/capability-sources`，按品牌
    cloud: brandCloudPort(brandModules),
    // WP40 数据后端（41 §2.4 的三档与迁移向导）
    storage: storage.port,
    // WP60（49 §6 / 48 L7）：在线值守的切档向导与"接回本机"
    standby: standby.port,
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
    secretary: secretary.port,
    // 36 §3 问 AI：单轮、只回给本人、不落任何对客户可见的地方
    // WP57 / WP66：在线客服面（按品牌各一份，见 `chatPortOf`）
    chat: chatPortOf(boot),
    // WP66：问 AI 用**这个品牌**的模型与事项（问的是"我这个品牌现在怎么样"）
    ask: askPortOf,
    // 25 §5 定时与流程面
    schedules: createSchedulePort({
      workspace_id: workspace.id,
      scheduler: schedule.scheduler,
      workflows: schedule.workflows,
      approvals,
      assignmentOf: (id) => {
        const found = roles.assignments.get(id)
        return found === undefined || found.workspace_id !== workspace.id
          ? undefined
          : { person_id: found.person_id, role_id: found.role_id }
      },
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
  const imChannels = createImChannels({
    clock,
    workspace_id: workspace.id,
    secrets,
    identity,
    rawStore: boot.channels.raw,
    makePipeline: (input) => boot.channels.imPipeline(input),
    // 游标与会话上下文跟渠道库走：落盘档重启之后不从头拉
    clawbotState: boot.channels.clawbotState,
    appendEvent,
    newId: () => `im_${Math.floor(random() * 1e9).toString(36)}`,
    random,
    askAgent: async (input) => {
      // 本人问**自己的**代理：41 §1.3 的公开级别在 secretary 那一层照常生效，
      // 这里不放大任何权限（viewer === person_id 时他本来就看得见自己那一份）。
      const out = await secretary.secretary.ask({
        viewer: input.viewer,
        person_id: input.viewer,
        question: input.question,
        assignment_id: input.assignment_id,
      })
      return { answer: out.answer }
    },
    assignmentOf: (person_id) =>
      roles.assignments
        .listByPerson(person_id, { workspace_id: workspace.id })
        .find((a) => a.revoked_at === undefined)?.id,
    deepLinkBase: () =>
      env.AGENTSWS_SERVER_URL ??
      (boundPort === undefined ? 'http://127.0.0.1:7777' : `http://127.0.0.1:${boundPort}`),
    onError: (e) => {
      appendEvent({
        schema_version: 1,
        workspace_id: workspace.id,
        type: 'connection.changed',
        actor: { kind: 'system', id: 'im-channels' },
        correlation: { trace_id: 'trc_im_error' },
        // 只有原因，没有凭据、没有正文
        payload: { im_event: 'im.error', detail: String(e) },
      })
    },
  })
  imChannels.mount(gateway.app)

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
    // WP57：在线聊天车道
    chat: boot.chat,
    modelSettings: boot.ownModels,
    // WP66（52 O1）：一个进程里的多套品牌模块
    brands: brandModules,
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
    schedule,
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
        const s = serve({ fetch: gateway.fetch, port: wanted, hostname: bindHost(env) }, () => {
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
      await imChannels.close()
      learning.close()
      knowledge.close()
      data.close()
      // 接进来的世界由调用方关（它还持有事件日志与替身）
      if (options.mount === undefined) roles.close()
      meetings.close()
      schedule.close()
      catalog.close()
      secretary.close()
      // WP66：每个品牌那一套各关各的（聊天车道 / 渠道 / 活数据源 / 连接面）
      await brandModules.dispose()
      await devMcp?.close()
      org.close()
      onboarding.close()
      joinAssembly.close()
      orgDuplicates.close()
      offboard.close()
      await subscription.close()
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
