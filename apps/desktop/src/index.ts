/**
 * `@agentsws/desktop` 的非 Electron 部分：状态机、配置、密钥、判定、菜单模型。
 * `main.ts` / `preload.cts` 不从这里导出——它们是进程入口，不是库。
 */
export type { BackoffOptions } from './backoff.js'
export { backoffDelay, DEFAULT_BACKOFF } from './backoff.js'
export type { BridgeInfo, DesktopBridge, NotifyInput } from './bridge-types.js'
export { BRIDGE_CHANNELS, BRIDGE_KEY } from './bridge-types.js'
export type { ConfigStore, DesktopConfig, Language } from './config.js'
export {
  createConfigStore,
  DEFAULT_CONFIG,
  DEFAULT_PORT,
  LANGUAGES,
  parseConfig,
  serializeConfig,
} from './config.js'
export type {
  ConnectHardeningCheck,
  ConnectLauncher,
  ConnectLaunchMode,
  ConnectRuntime,
  ConnectRuntimeOptions,
  ConnectRuntimeState,
  ConnectRuntimeStatus,
  HardeningProbe,
  HardeningReportLike,
} from './connect-runtime.js'
export {
  CONNECT_URL_ENV,
  classify,
  connectUrlFrom,
  createConnectRuntime,
  NotImplementedError,
  notImplementedLauncher,
} from './connect-runtime.js'
export { CONTENT_SECURITY_POLICY, withCsp } from './csp.js'
export type { HaltControl, HaltScope } from './halt.js'
export {
  createHaltControl,
  HALT_SCOPES,
  haltEnv,
  isHaltScope,
  parseHaltFile,
  serializeHaltFile,
} from './halt.js'
export type { HealthSnapshot, ProbeOptions, WaitOptions } from './health.js'
export { healthUrl, parseHealthBody, probeHealth, waitForHealth } from './health.js'
export type { Strings } from './i18n.js'
export { strings } from './i18n.js'
export type { Logger, LoggerOptions, LogLevel } from './logging.js'
export { createLogger, formatLine, silentLogger } from './logging.js'
export type { MenuAction, MenuItemModel, TrayModelInput } from './menu.js'
export {
  buildTrayMenu,
  canOpenWorkstation,
  connectStateLabel,
  serverStateLabel,
  trayTooltip,
} from './menu.js'
export {
  companyLabel,
  configPatchOf,
  type DesktopMode,
  type ModeSource,
  needsWizard,
  normalizeServerUrl,
  type ResolvedMode,
  resolveMode,
  SERVER_URL_ENV,
  serverUrlFrom,
  type WizardChoice,
} from './mode.js'
export type { NavigationDecision } from './navigation.js'
export {
  decideNavigation,
  decideWindowOpen,
  isLocalOrigin,
  isSafeExternal,
  originOf,
  parseUrl,
} from './navigation.js'
export { memoryFileStore, nodeFileStore } from './node-files.js'
export type { DesktopPaths } from './paths.js'
export { desktopPaths } from './paths.js'
export type {
  ChildHandle,
  Clock,
  FetchLike,
  FetchResponseLike,
  FileStore,
  RandomBytes,
  SafeStorageLike,
  Spawner,
  SpawnRequest,
  TimerHandle,
  TimerPort,
} from './ports.js'
export type { Redactor } from './redact.js'
export { createRedactor, defaultRedactor, REDACTED } from './redact.js'
export type {
  DesktopSecrets,
  SecretsErrorCode,
  SecretVault,
  SecretVaultOptions,
} from './secrets.js'
export {
  createSecretVault,
  generateSecrets,
  SECRET_BYTES,
  SecretsError,
  secretLiterals,
  secretsToEnv,
} from './secrets.js'
export type { RuntimeChoiceInput, ServerRuntime, ServerSpawnInput } from './server-process.js'
export {
  INHERITED_ENV,
  inheritEnv,
  resolveServerEntry,
  resolveServerRuntime,
  serverSpawnRequest,
} from './server-process.js'
export type {
  Sidecar,
  SidecarExit,
  SidecarOptions,
  SidecarSnapshot,
  SidecarState,
} from './sidecar.js'
export { createLineSplitter, createSidecar } from './sidecar.js'
export type {
  UpdateGate,
  UpdateGateOptions,
  UpdateInfo,
  UpdateOutcome,
  UpdaterPort,
} from './updater.js'
export { createUpdateGate } from './updater.js'
