/**
 * `@agentsws/api` —— API 网关（28 §2）。
 *
 * 框架无关的路由声明（鉴权元组 / Assignment / send-apply 标记）+ 一个 Hono 实现，
 * 由 `apps/server` 用具体模块装配。本包不 import 任何实现包，只依赖契约类型。
 */
export { collectRoutes, createGateway, type Gateway, OPENAPI_PATH } from './app.js'
export {
  ApiError,
  type ApiErrorOptions,
  type ErrorBody,
  errorBody,
  type GatewayErrorCode,
  normalizeError,
  STATUS_BY_CODE,
  statusFor,
} from './errors.js'
export {
  assignmentOf,
  body,
  ctxOf,
  intParam,
  listParam,
  ok,
  principalOf,
  redactItem,
  tokenFor,
} from './helpers.js'
export {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  fingerprint,
  type IdempotencyRecord,
  type IdempotencyStore,
  MemoryIdempotencyStore,
  type SweepableIdempotencyStore,
} from './idempotency.js'
export {
  createMemoryIdentity,
  DEFAULT_WORKSPACE_POLICY,
  type IssuedToken,
  type LocalIdentityService,
  type MemoryIdentityOptions,
  MemoryIdentityService,
  type TokenKind,
} from './identity.js'
export { buildOpenApi, type OpenApiDocument, toOpenApiPath } from './openapi.js'
export { DEFAULT_RATE_LIMITS, type RateLimitVerdict, TokenBucketLimiter } from './rate-limit.js'
export {
  type AuthzSpec,
  type GatewayEnv,
  type HttpMethod,
  type ParamSpec,
  type Route,
  type RouteHandler,
  type RouteSpec,
  route,
} from './route-spec.js'
export type {
  MeetingIngestInput,
  MeetingProcessOutcome,
  MeetingSendCardInput,
  MeetingsPort,
} from './routes/meetings.js'
export { meetingRoutes } from './routes/meetings.js'
export {
  type MatterListFilter,
  type TodoListFilter,
  type WorkActor,
  type WorkHome,
  type WorkPort,
  workRoutes,
} from './routes/work.js'
export { fromDeckError, workstationRoutes } from './routes/workstation.js'
export {
  createSqliteIdempotencyStore,
  type SqliteIdempotencyOptions,
  SqliteIdempotencyStore,
} from './sqlite-idempotency.js'
export {
  createSqliteIdentity,
  type SqliteIdentityOptions,
  SqliteIdentityService,
} from './sqlite-identity.js'
export { type Migration, migrate, schemaVersion } from './sqlite-migrations.js'
export { createAsyncTraceScope, createNoopTraceScope } from './trace-scope.js'
export type {
  ChangesPort,
  EffectiveConfigLike,
  EventLogPort,
  GatewayDeps,
  GatewayOptions,
  GuardrailEvaluateInput,
  GuardrailPort,
  KnowledgePort,
  ModulesPort,
  PositionSummary,
  Principal,
  RateLimitPolicy,
  RequestContext,
  RolesPort,
  SkillsPort,
  TraceScope,
  WorkstationActor,
  WorkstationPort,
  WorkstationRange,
} from './types.js'
