/**
 * `@agentsws/standby` —— 在线值守与聊天窗托管的云侧编排（49 §6 WP60、48 L6 / L7）。
 *
 * **一个库 + 一个路由包，不起服务**：由 `apps/cloud` 挂上去（照 WP59 的
 * `packages/cloud-entry` 那个写法）。
 */
export type { ChildTokensOptions, VerifiedChildToken } from './child-token.js'
export { CHILD_SCOPES, CHILD_TOKEN_TTL_MS, ChildTokens } from './child-token.js'
export { createFileKeyring, createMemoryKeyring, newTenantKey, TENANT_KEY_FILE } from './keyring.js'
export {
  allocateLoopbackPort,
  baseChildEnv,
  CHILD_ENV_PASSTHROUGH,
  nodeFs,
  nodeSecrets,
  nodeSpawnAdapter,
} from './node-host.js'
export { BACKOFF_MS, backoffMs, HEALTH_TIMEOUT_MS, ProcessPool } from './orchestrator.js'
export type { ProxyDeps } from './proxy.js'
export { childPath, HOP_BY_HOP, PUBLIC_PREFIX, proxyToChild } from './proxy.js'
export type {
  StandbyEnv,
  StandbyPrincipal,
  StandbyRouteDeps,
  StandbyVerifier,
} from './routes.js'
export {
  authenticate,
  bearerToken,
  createStandbyApp,
  errorResponse,
  MAX_PACKAGE_BYTES,
  mountStandbyRoutes,
  STANDBY_SCOPE,
  WORKSPACE_TOKEN_PREFIX,
} from './routes.js'
export type { StandbyServiceDeps } from './service.js'
export { MAX_SEATS, STANDBY_CAPABILITY, StandbyService, toView } from './service.js'
export type { SqliteLike } from './store.js'
export {
  MemoryStandbyStore,
  MemoryTokenStore,
  SqliteStandbyStore,
  SqliteTokenStore,
} from './store.js'
export type {
  ChildHandle,
  ChildTokenRow,
  FetchLike,
  SpawnLike,
  SpawnOptions,
  StandbyDeps,
  StandbyErrorCode,
  StandbyFs,
  StandbyKeyring,
  StandbyPackager,
  StandbyRecord,
  StandbySecrets,
  StandbyStore,
  StandbyTokenStore,
  TempFile,
} from './types.js'
export {
  assertWorkspaceId,
  STANDBY_STATUS,
  StandbyError,
  shouldRun,
  WORKSPACE_ID_RE,
} from './types.js'
