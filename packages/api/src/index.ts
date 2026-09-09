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
  type AcceptedInvitation,
  type CreateInvitationInput,
  createMemoryIdentity,
  DEFAULT_INVITE_TTL,
  DEFAULT_WORKSPACE_POLICY,
  type Invitation,
  type IssuedInvitation,
  type IssuedToken,
  type LocalIdentityService,
  type MemoryIdentityOptions,
  MemoryIdentityService,
  nameFromEmail,
  readCookie,
  SESSION_COOKIE,
  secretEquals,
  sessionCookie,
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
export { type AskActor, type AskAnswer, type AskPort, askRoutes } from './routes/ask.js'
export type {
  BeginConnectResult,
  ConnectionOwnership,
  ConnectionStatus,
  ConnectionsActor,
  ConnectionsPort,
  ConnectionView,
  ConnectRequestStatus,
  ConnectTestResult,
  CredentialStore,
  MailboxDetectResult,
  MailboxPresetView,
  ProviderAuthKind,
  ProviderAuthOption,
  ProviderFieldSpec,
  ProviderSetupGuide,
  ProviderView,
  RuntimeStatusView,
  SubmitConnectionInput,
} from './routes/connections.js'
export { connectionRoutes } from './routes/connections.js'
export { HALT_SCOPES, haltRoutes } from './routes/halt.js'
export type {
  MeetingIngestInput,
  MeetingProcessOutcome,
  MeetingSendCardInput,
  MeetingsPort,
} from './routes/meetings.js'
export { meetingRoutes } from './routes/meetings.js'
export type {
  ModelDefaultsView,
  ModelProviderKind,
  ModelProviderTemplate,
  ModelProviderView,
  ModelsActor,
  ModelsPort,
  ModelTestResult,
  ModelUsageRow,
  ModelUsageView,
  SaveModelProviderInput,
  SetModelDefaultsInput,
} from './routes/models.js'
export { MODEL_PURPOSES, modelRoutes, parseModelId } from './routes/models.js'
export type {
  AcceptedInvitationView,
  AssignInput,
  AssignmentView,
  CopyRoleInput,
  InvitationView,
  InviteInput,
  MemberView,
  OrgActor,
  OrgChangeReceipt,
  OrgPort,
  PolicyPatchInput,
  PositionInput,
  PositionView,
  RoleDetailView,
  RolePatchInput,
  RoleSummaryView,
  UpdateAssignInput,
  WorkspacePolicyView,
} from './routes/org.js'
export { orgRoutes, positionName } from './routes/org.js'
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
