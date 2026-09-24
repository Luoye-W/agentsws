/**
 * `@agentsws/server` —— 协同服务进程。
 *
 * `createServer()` 装配内核与全部已合并模块并返回一个可 listen 的句柄；
 * 直接 `node dist/index.js` 时启动并监听，SIGTERM / SIGINT 优雅关闭。
 */
export { type AskOptions, createAskPort } from './ask.js'
export { type BackendCall, LATE_WRITE_ERROR, MemoryBackend } from './backend.js'
export {
  BACKUP_DIR_ENV,
  BACKUP_FORMAT,
  BACKUP_KEEP_ENV,
  BackupError,
  type BackupFileEntry,
  type BackupManifest,
  type BackupRunInput,
  type BackupRunResult,
  backupDirOf,
  backupFiles,
  backupKeepOf,
  backupName,
  crc32,
  DEFAULT_BACKUP_KEEP,
  type ExportInput,
  type ExportResult,
  exportWorkspace,
  head,
  type ImportInput,
  type ImportResult,
  importWorkspace,
  MANIFEST,
  runBackup,
  unzipTo,
  zipDir,
} from './backup.js'
export {
  CATALOG,
  type CatalogAuth,
  type CatalogEntry,
  type CatalogFlow,
  catalogEntry,
  flowOf,
  serviceOfUpstream,
  UPSTREAM_TO_SERVICE,
} from './catalog.js'
export {
  type ChannelsAssembly,
  type ChannelsOptions,
  createChannels,
  forDisplay,
  type MailPollReport,
  OUTBOUND_HALTED,
} from './channels.js'
// WP60（48 §4 L3 #11 的云端一半）：聊天窗的公开访客面
export {
  type ChatWidgetAssembly,
  type ChatWidgetOptions,
  createChatWidget,
  DEFAULT_ACCENT,
  DEFAULT_GREETING,
  originOf,
  SESSION_RATE,
  safeAccent,
  WIDGET_CONFIG_FILE,
  WIDGET_SECRET_ID,
} from './chat-widget.js'
export {
  CLOUD_BASE_URL_ENV,
  CLOUD_TOKEN_SECRET_ID,
  type CloudAccountAssembly,
  type CloudAccountOptions,
  type CloudFetch,
  cloudBaseUrl,
  createCloudAccount,
  DEFAULT_CLOUD_BASE_URL,
  LINK_PENDING_TTL_MS,
} from './cloud-account.js'
// WP140：demo 里「官方云那一跳」的替身（不出网）
export {
  CLOUD_STAND_IN_BASE_URL,
  type CloudStandIn,
  type CloudStandInOptions,
  type CloudStandInRequest,
  cloudStandIn,
} from './cloud-stand-in.js'
export {
  CONNECT_URL_ENV,
  connectBaseUrl,
  DEFAULT_CONNECT_URL,
} from './connect-url.js'
export {
  type ConnectionsAssembly,
  type ConnectionsOptions,
  type ConnectLike,
  createConnections,
  createMailProbe,
  type MailAccount,
  type MailProbe,
  smokeDetail,
} from './connections.js'
// WP134：「用我的 DeepSeek 账号登录」的 demo / 截图替身（不出网）
export { deepseekAccountStandIn } from './deepseek-account.js'
// WP136（docs/79）：dsh 场景切换
export {
  createDshScenes,
  DSH_APP_DATA_ENV,
  DSH_HOME_ENV,
  DSH_WORKSPACE_ENV,
  type DshScenesManager,
  type DshScenesOptions,
  dshHomeOf,
  unavailableScenes,
  workspaceProblem,
  workspaceRootOf,
} from './dsh-scenes.js'
export {
  createPrivacyErase,
  type EraseInput,
  type EraseResult,
  type EraseStep,
  type PrivacyErase,
  type PrivacyEraseOptions,
} from './erase.js'
export {
  type ApprovalDirectoryOptions,
  createApprovalDirectory,
  type HousekeepingDeps,
  type HousekeepingOutcome,
  runApprovalHousekeeping,
} from './housekeeping.js'
export {
  createJoin,
  type JoinAssembly,
  type JoinOptions,
  unionRule,
} from './join.js'
export {
  createLiveDataSource,
  DEFAULT_REFRESH_SECONDS,
  LIVE_ASSIGNMENT,
  type LiveConnection,
  type LiveDataConnections,
  type LiveDataOptions,
  type LiveDataSource,
  type LiveDataStatus,
  type LiveRefreshReport,
  ORDER_MAX_PAGES,
  ORDER_PAGE_LIMIT,
  ORDER_WINDOW_DAYS,
  offsetMinutesOf,
  ordersArrayOf,
  REFRESH_SECONDS_ENV,
  refreshSecondsOf,
  shopCurrencyOf,
  shopTimezoneOffsetOf,
  toOrderRow,
} from './live-data.js'
export {
  createModels,
  DEEPSEEK_KEY_ENV,
  ENV_PROVIDER_ID,
  humanizeModelError,
  MODEL_KEY_PREFIX,
  MODEL_TEMPLATES,
  type ModelProviderConfig,
  type ModelsAssembly,
  type ModelsOptions,
  modelIdOf,
  STUB_REF,
} from './models.js'
export {
  type AdoptInput,
  type AdoptReceipt,
  type ArchivedSkillView,
  createOffboard,
  type MemoryPolicy,
  type Offboard,
  type OffboardInput,
  type OffboardOptions,
  type OffboardReport,
  type OffboardStep,
  type OffboardStepId,
  type PersonalLayerPolicy,
  personSubject,
} from './offboard.js'
export { createOrg, type OrgAssembly, type OrgOptions } from './org.js'
export {
  createReconcileGuard,
  RECONCILE_HALT_REASON,
  type ReconcileGuard,
  type ReconcileGuardOptions,
  type ReconcileReport,
  type ReconcileState,
} from './reconcile.js'
export {
  createRuntime,
  hasModelProvider,
  type MatterRecordSource,
  type RuntimeAssembly,
  type RuntimeOptions,
} from './runtime.js'
export {
  type BackupDeps,
  buildReviewsFor,
  createScheduleAssembly,
  createSchedulePort,
  DEFAULT_RAW_RETENTION_DAYS,
  draftPlansFor,
  ensureSystemTasks,
  ensureTask,
  HANDLERS,
  HOUSEKEEPING_INTERVAL_MS,
  isMonthEnd,
  MAIL_POLL_INTERVAL_MS,
  type MailPollDeps,
  type MeetingPollDeps,
  nextMorningAt,
  nextTokenCheck,
  offsetToTz,
  type PlanDeps,
  pollMeetingSources,
  pruneRawStores,
  type RawPruneDeps,
  type RelayDeps,
  type ReviewDeps,
  registerApprovalHousekeeping,
  registerBackup,
  registerDailyPlan,
  registerIdempotencySweep,
  registerIdleTodos,
  registerMailPoll,
  registerMeetingPoll,
  registerPlanRelay,
  registerRawPrune,
  registerReview,
  registerSkillsWeekly,
  registerTokenRefresh,
  type ScheduleAssembly,
  type ScheduleAssemblyOptions,
  type SchedulePlanOptions,
  type SchedulePortOptions,
  type SchedulePosition,
  ServerScheduleError,
  type SkillsWeeklyDeps,
  TOKEN_IDLE_INTERVAL_MS,
  TOKEN_REFRESH_LEAD_MS,
  type TokenRefreshDeps,
} from './schedule.js'
export {
  createSecretStore,
  parseSecretsKey,
  SECRETS_KEY_ENV,
  type SecretFields,
  type SecretRecord,
  type SecretStore,
  SecretStoreError,
  type SecretStoreOptions,
  sameKey,
} from './secret-store.js'
export {
  type Bootstrap,
  BUNDLED_ROLES,
  createServer,
  DEFAULT_PORT,
  HOST,
  type MountedWorld,
  type Server,
  type ServerOptions,
} from './server.js'
export {
  createShopifyBroker,
  exchangeClientCredentials,
  mapExchangeError,
  normalizeShopDomain,
  REFRESH_LEAD_MS,
  SHOPIFY_APP_PREFIX,
  type ShopifyBroker,
  ShopifyBrokerError,
  type ShopifyBrokerErrorCode,
  type ShopifyBrokerRecord,
  scrub,
} from './shopify-broker.js'
export type {
  DevMcpStatus,
  GraphqlVerdict,
  McpChannel,
  ShopifyDevMcp,
  ShopifyDevMcpOptions,
  SpawnMcp,
  StageGuardOutcome,
} from './shopify-devmcp.js'
export {
  createShopifyDevMcp,
  DEV_MCP_ARGS,
  DEV_MCP_COMMAND,
  DEV_MCP_TOOLS,
  DOCS_TOOL,
  guardGraphqlStage,
  readVerdict,
  SCHEMA_TOOL,
  UPSTREAM_CANDIDATES,
  VALIDATE_TOOL,
} from './shopify-devmcp.js'
export type {
  CliResult,
  PushedTheme,
  RunCli,
  ShopifyTheme,
  ShopifyThemeErrorCode,
  ShopifyThemeOptions,
  SpawnCli,
  ThemeCliStatus,
  ThemeProcess,
  ThemePublishProposal,
  ThemeSummary,
} from './shopify-theme.js'
export {
  createShopifyTheme,
  PASSTHROUGH_ENV,
  ShopifyThemeError,
  scrubCliOutput,
  THEME_CLI_INSTALL,
  THEME_STORE_ENV,
  THEME_TOKEN_ENV,
} from './shopify-theme.js'
// WP60（49 §6 / 48 L7）：在线值守的本地一面
export {
  createStandby,
  embedSnippet,
  publicUrlOf,
  STANDBY_READ_TIMEOUT_MS,
  STANDBY_TIMEOUT_MS,
  type StandbyAssembly,
  type StandbyFetch,
  type StandbyOptions,
} from './standby.js'
export { mountStatic, resolveAsset, type StaticOptions } from './static.js'
// WP111 升级闸：升级前自动备份、迁移失败不启动、还原上一份备份
export {
  clearUpgradeFailure,
  guardBeforeStart,
  latestUpgradeBackup,
  planUpgrade,
  pruneUpgradeBackups,
  RESTORE_REQUEST_FILE,
  type RestoreRequest,
  readRestoreRequest,
  readSchemaVersions,
  readUpgradeFailure,
  readUpgradeState,
  recordUpgradeSuccess,
  SCHEMA_TARGETS,
  type SchemaAdvance,
  schemaFiles,
  UPGRADE_BACKUP_KEEP,
  UPGRADE_FAILED_FILE,
  UPGRADE_STATE_FILE,
  type UpgradeFailure,
  type UpgradeFailureStage,
  type UpgradeGuardInput,
  type UpgradeGuardReport,
  type UpgradePlan,
  type UpgradeState,
  upgradeBackupName,
  workspaceIdOf,
  writeRestoreRequest,
  writeUpgradeFailure,
} from './upgrade-guard.js'
export { CHAT_WIDGET_JS, mountChatWidget, WIDGET_API_PATH, WIDGET_PATH } from './widget.js'
export {
  createWorkModel,
  createWorkPort,
  periodQueryRunner,
  type WorkPortOptions,
} from './work.js'
export {
  createWorkstationPort,
  emptyDataSource,
  type WorkstationDataSource,
  type WorkstationPortOptions,
} from './workstation.js'

import { pathToFileURL } from 'node:url'
import {
  hostedModeOf,
  pushHostedSnapshot,
  restoreHostedSnapshot,
  startHostedSnapshotLoop,
} from './hosted-mode.js'
import { createServer } from './server.js'
import {
  guardBeforeStart,
  recordUpgradeSuccess,
  type UpgradeGuardReport,
  writeUpgradeFailure,
} from './upgrade-guard.js'

/** 进程入口：启动、打印 /v1/health、挂优雅关闭。 */
export async function main(): Promise<void> {
  // WP18：AGENTSWS_DATA_DIR 存在就整套走 SQLite；不给则全部内存档。
  // 旧名 AGENTSWS_DB_DIR 仍然认，避免已有脚本断掉。
  const dbDir = process.env.AGENTSWS_DATA_DIR ?? process.env.AGENTSWS_DB_DIR
  // 单机真账号档：给了工作台构建目录就一并托管（demo 之外也能开工作台）
  const staticDir = process.env.AGENTSWS_STATIC_DIR
  const release = process.env.AGENTSWS_VERSION ?? '0.0.0'
  const clock = { now: () => new Date().toISOString() }
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }

  /*
   * WP128：托管实例（Cloudflare Container 里那一份）。盘是临时的，所以**建服务之前**
   * 先把云端最新那一份快照拉回来导进数据目录（WP36：跑着的进程不换自己脚下的库）。
   * 拉失败就抛——容器退出，HostedInstanceDO 按退避重起；不起一个空库装没事。
   */
  const hosted = hostedModeOf(process.env)
  if (hosted !== undefined && dbDir !== undefined)
    await restoreHostedSnapshot({ config: hosted, dataDir: dbDir, log })

  /*
   * WP111 升级闸（13 §5「更新前跑一次冒烟；失败回滚」）。只有落盘档有——
   * 内存档没有可丢的东西。
   *
   * 顺序是死的：**先办还原单 → 会动数据就先备份 → 再建服务**（各库的迁移在
   * `createServer()` 里各自跑）。建服务炸了就**不 listen、不半启动**，留一张纸条
   * （`upgrade-failed.json`）说清楚数据动没动、备份在哪，托盘照着念。
   * 半启动比不启动糟得多：她会以为能用，然后往一个坏掉的库里写东西。
   */
  let guarded: UpgradeGuardReport | undefined
  /** 出事就留一张纸条，然后原样抛出去。托盘照着这张纸条说话。 */
  const noteAndRethrow = (stage: 'backup' | 'migrate', err: unknown): never => {
    if (dbDir !== undefined) {
      writeUpgradeFailure(dbDir, {
        at: clock.now(),
        release,
        ...(guarded?.plan.previousRelease === undefined
          ? {}
          : { previous_release: guarded.plan.previousRelease }),
        stage,
        error: String(err instanceof Error ? (err.stack ?? err.message) : err),
        ...(guarded?.backup === undefined ? {} : { backup: guarded.backup }),
        // 迁移在一个事务里跑（各包 `migrate()` 的 `db.transaction`），失败整条回滚；
        // 卡在备份那一步则一条迁移都还没跑。两种情形数据都没动——
        // 这一格就是这道闸存在的意义：出事之后能对用户说"你的数据还在"。
        data_touched: false,
      })
      process.stderr.write(
        `升级没成功，数据没动。${guarded?.backup === undefined ? '' : `备份在 ${guarded.backup}。`}\n`,
      )
    }
    throw err
  }

  if (dbDir !== undefined) {
    try {
      guarded = await guardBeforeStart({
        dataDir: dbDir,
        release,
        clock,
        env: process.env,
        log: (line) => process.stdout.write(`${line}\n`),
      })
    } catch (err) {
      // 备份没做成就**不往下走**：留不成还照样跑迁移，等于把闸拆了还留着门框。
      noteAndRethrow('backup', err)
    }
  }

  let server: Awaited<ReturnType<typeof createServer>>
  try {
    server = await createServer({
      ...(dbDir === undefined ? {} : { dbDir }),
      ...(staticDir === undefined ? {} : { staticDir }),
    })
  } catch (err) {
    return noteAndRethrow('migrate', err)
  }

  await server.listen()
  // 起来了才记：下次就知道上一版是什么、各库到了哪一版
  if (dbDir !== undefined) recordUpgradeSuccess({ dataDir: dbDir, release, clock })
  // WP128：托管实例每 6 小时推一份快照回云端
  const stopSnapshots =
    hosted !== undefined && dbDir !== undefined
      ? startHostedSnapshotLoop({ config: hosted, dataDir: dbDir, clock, log })
      : undefined
  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    process.stdout.write(`\n${signal} received, closing…\n`)
    stopSnapshots?.()
    // WP128：托管实例收到 SIGTERM（取消订阅 / 平台滚动更新）先推最后一份快照；
    // 平台给 15 分钟，DO 那边给一分钟再强停——推不完也照样关，不卡住关机
    const lastPush =
      hosted !== undefined && dbDir !== undefined
        ? Promise.race([
            pushHostedSnapshot({ config: hosted, dataDir: dbDir, clock }).then(
              (bytes) => log(`托管实例：最后一份快照已推（${String(bytes)} 字节）`),
              (err: unknown) =>
                log(`托管实例：${err instanceof Error ? err.message : String(err)}`),
            ),
            new Promise<void>((resolve) => setTimeout(resolve, 45_000).unref()),
          ])
        : Promise.resolve()
    lastPush
      .then(() => server.close())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`shutdown failed: ${String(err)}\n`)
        process.exit(1)
      })
  }
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })
}

// 只有被当作进程入口执行时才监听；被 import（测试、CLI 内嵌）时什么都不做。
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
