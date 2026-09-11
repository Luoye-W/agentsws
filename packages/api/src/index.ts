/**
 * `@agentsws/api` —— API 网关（28 §2）。
 *
 * 框架无关的路由声明（鉴权元组 / Assignment / send-apply 标记）+ 一个 Hono 实现，
 * 由 `apps/server` 用具体模块装配。本包不 import 任何实现包，只依赖契约类型。
 */
export { bearerToken, collectRoutes, createGateway, type Gateway, OPENAPI_PATH } from './app.js'
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
export {
  asyncApiFragment,
  buildOpenApi,
  type OpenApiDocument,
  toOpenApiPath,
} from './openapi.js'
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
export type { BackupExportView, BackupPort } from './routes/backup.js'
export { backupRoutes } from './routes/backup.js'
export {
  CATALOG_KINDS,
  CATALOG_LAYERS,
  type CatalogDuplicateView,
  type CatalogEntryView,
  type CatalogKindName,
  type CatalogLayerName,
  type CatalogPort,
  type CatalogSimilarHit,
  type CatalogSimilarQuery,
  catalogRoutes,
  DuplicateAck,
  type DuplicateAckInput,
  guardSimilar,
  MIN_DUPLICATE_REASON,
  recordCatalogNote,
  triggerKeyOf,
} from './routes/catalog.js'
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
export {
  AssignmentVisibility,
  canReadAll,
  DEFAULT_EVENT_LIMIT,
  type EventQuery,
  eventRoutes,
  parseSince,
  parseUntil,
  readVisibleEvents,
} from './routes/events.js'
export { HALT_SCOPES, haltRoutes } from './routes/halt.js'
export { healthRoutes, type ReconcilePort } from './routes/health.js'
export {
  type JoinActor,
  type JoinDecisionInput,
  type JoinImportReceipt,
  type JoinPort,
  joinRoutes,
} from './routes/join.js'
export type {
  MeetingIngestInput,
  MeetingProcessOutcome,
  MeetingSendCardInput,
  MeetingsPort,
} from './routes/meetings.js'
export { meetingRoutes } from './routes/meetings.js'
export type {
  DiscoverModelsInput,
  ModelDefaultsView,
  ModelListing,
  ModelPricingModel,
  ModelPricingRefreshResult,
  ModelPricingVendorView,
  ModelPricingView,
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
  DiscoveryHelloView,
  DiscoveryPeerView,
  DiscoveryStateView,
  InviteView,
  MembershipRequestInput,
  MembershipRequestView,
  OnboardingActor,
  OnboardingApplyView,
  OnboardingConnectorItem,
  OnboardingPlanInput,
  OnboardingPlanView,
  OnboardingPort,
  OnboardingPositionPlanItem,
  OnboardingPositionView,
  OnboardingSkillItem,
  OnboardingStateView,
  SupersedeInput,
  WorkspaceProfileInput,
  WorkspaceProfileView,
} from './routes/onboarding.js'
export { onboardingRoutes } from './routes/onboarding.js'
export type {
  AcceptedInvitationView,
  AdoptArchivedInput,
  AdoptReceiptView,
  ArchivedSkillView,
  AssignInput,
  AssignmentView,
  CopyRoleInput,
  InvitationView,
  InviteInput,
  MemberView,
  MemoryPolicy,
  OffboardInput,
  OffboardPort,
  OffboardReportView,
  OffboardStepView,
  OrgActor,
  OrgChangeReceipt,
  OrgDuplicateAckInput,
  OrgDuplicateHit,
  OrgDuplicateQuery,
  OrgPort,
  PersonalLayerPolicy,
  PolicyPatchInput,
  PositionInput,
  PositionView,
  ProductLineInput,
  ProductLineRuleInput,
  ProductLineView,
  ProposeRangeChangeInput,
  RangeGroupInput,
  RangeGroupView,
  RoleDetailView,
  RolePatchInput,
  RoleSummaryView,
  UpdateAssignInput,
  WorkspacePolicyView,
} from './routes/org.js'
export { MIN_ORG_DUPLICATE_REASON, orgRoutes, positionName } from './routes/org.js'
export {
  type PrivacyEraseStepView,
  type PrivacyEraseView,
  type PrivacyPort,
  privacyRoutes,
} from './routes/privacy.js'
export { scheduleRoutes } from './routes/schedules.js'
export type {
  AgendaCheckView,
  AskedView,
  AskView,
  AvailabilityPatchView,
  AvailabilityView,
  DisclosureLevelName,
  DisclosurePatchView,
  MeetingBriefView,
  MeetView,
  MyProfileView,
  PersonCardView,
  ProfileFieldName,
  ProfilePositionView,
  ProfileSkillView,
  RouteView,
  SecretaryActor,
  SecretaryPort,
  VisibleProfileView,
} from './routes/secretary.js'
export { PROFILE_FIELD_NAMES, secretaryRoutes } from './routes/secretary.js'
export type { SecretsPort, SecretsRotationView } from './routes/secrets.js'
export { secretRoutes } from './routes/secrets.js'
export {
  type StorageBackendInput,
  type StorageBackendView,
  type StorageMigrationView,
  type StoragePort,
  type StorageTestResult,
  type StorageTier,
  type StorageView,
  storageRoutes,
} from './routes/storage.js'
export {
  type MatterListFilter,
  type TodoListFilter,
  type WorkActor,
  type WorkHome,
  type WorkInProgressItem,
  type WorkMatterView,
  type WorkPoolItem,
  type WorkPort,
  workRoutes,
} from './routes/work.js'
export { fromDeckError, workstationRoutes } from './routes/workstation.js'
export {
  classify,
  HALT_ONLY_EVENT,
  parseSubprotocols,
  summarize,
  WS_BEARER_PREFIX,
  WS_CLOSE,
  WS_DEFAULT_PREFIXES,
  WS_SUBPROTOCOL,
  type WsClientMessage,
  type WsControlFrame,
  type WsEventFrame,
  type WsFrame,
  type WsFrameType,
  type WsOptions,
  WsSession,
  type WsSink,
  type WsSubscribeMessage,
  wsOptions,
  wsRoutes,
} from './routes/ws.js'
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
  GatewayActor,
  GatewayDeps,
  GatewayOptions,
  GuardrailEvaluateInput,
  GuardrailPort,
  IdentityTokenInfo,
  KnowledgeGap,
  KnowledgeGapAnswer,
  KnowledgeGapInput,
  KnowledgeGapStatus,
  KnowledgePort,
  KnowledgeSourceInput,
  ModulesPort,
  PositionSummary,
  Principal,
  RateLimitPolicy,
  RequestContext,
  RolesPort,
  ScheduleActor,
  ScheduleCreateInput,
  ScheduledTaskView,
  ScheduleListQuery,
  SchedulePatchInput,
  SchedulePort,
  ScheduleRunOutcome,
  SkillOverlayView,
  SkillProposalSummary,
  SkillSummary,
  SkillsPort,
  TokenInfo,
  TraceScope,
  WorkflowInstanceView,
  WorkflowListQuery,
  WorkstationActor,
  WorkstationPort,
  WorkstationRange,
} from './types.js'
export { hasTokenInfo } from './types.js'
