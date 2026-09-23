/**
 * `@agentsws/hosted` —— 客服增值服务的托管实例（WP128 / docs/64 §13 / docs/74 §5）。
 *
 * 纯逻辑，不起服务：生命周期判定、容器环境变量契约、托管令牌、费用估算。
 * 住在 Cloudflare Containers 上的那个对象在 `apps/cloud-worker/src/hosted-instance-do.ts`，
 * 容器里那一份 `apps/server` 读这里的 `parseHostedEnv`。
 */
export {
  type CostBreakdown,
  type CostInput,
  DEFAULT_CPU_ACTIVE_RATIO,
  estimateCost,
  fullMonthCost,
  secondsInMonth,
} from './cost.js'
export {
  buildHostedEnv,
  deriveHostedKey,
  HOSTED_DATA_DIR,
  HOSTED_ENV,
  HOSTED_MAX_TENANTS_PER_CONTAINER,
  type HostedBootConfig,
  type HostedContainerSpec,
  type HostedTenant,
  hostedRelayEndpoint,
  hostedSnapshotUrl,
  parseHostedEnv,
} from './env.js'
export {
  desiredFor,
  HOSTED_HEARTBEAT_TIMEOUT_MS,
  HOSTED_KEEPALIVE_MS,
  HOSTED_MAX_HEARTBEAT_FAILURES,
  HOSTED_PORT,
  type HostedDesired,
  type HostedState,
  type HostedStopReason,
  RESTART_BACKOFF_MS,
  restartBackoffMs,
  SNAPSHOT_KEEP_COUNT,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_PUSH_INTERVAL_MS,
  SNAPSHOT_RETENTION_DAYS,
  snapshotKeptUntil,
  stateOf,
  stopReasonFor,
} from './lifecycle.js'
export {
  CONTAINERS_PRICING,
  type HostedInstanceType,
  type InstanceSpec,
  isInstanceType,
} from './pricing.js'
export {
  composeHostedToken,
  HOSTED_TOKEN_PREFIX,
  HOSTED_TOKEN_SCOPES,
  HOSTED_TOKEN_TTL_MS,
  isHostedToken,
  workspaceOfHostedToken,
} from './token.js'
export type {
  HostedInstanceStatus,
  SupportServiceAdminPort,
  SupportServiceSummary,
} from './types.js'
