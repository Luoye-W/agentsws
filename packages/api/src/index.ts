/**
 * `@agentsws/api` —— API 网关（28 §2）。
 *
 * 框架无关的路由声明（鉴权元组 / Assignment / send-apply 标记）+ 一个 Hono 实现，
 * 由 `apps/server` 用具体模块装配。本包不 import 任何实现包，只依赖契约类型。
 */
export { bearerToken, collectRoutes, createGateway, type Gateway, OPENAPI_PATH } from './app.js'
// WP414：同类卡跟着前一个决定（「同类」由宿主注入 `similarCards`）
export {
  type CardFollowResult,
  FOLLOW_KINDS,
  FOLLOW_LIMIT,
  type FollowBasis,
  type FollowedCard,
  followDecision,
  followReason,
  givenReason,
  type ReasonJudgeInput,
  type SimilarCard,
} from './card-follow.js'
export {
  type CloudAuth,
  type CloudEnv,
  type CloudRequestContext,
  type CloudRoute,
  type CloudRouteHandler,
  type CloudRouteSpec,
  cloudBearer,
  cloudBody,
  cloudCtx,
  cloudOk,
  cloudParam,
  cloudRoute,
  cloudSession,
  cloudToken,
  toRouteSpec,
} from './cloud-route.js'
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
/*
 * WP119（68）：浏览器插件的本地一面。
 *
 * 配对 / 令牌那张表与路由端口一起导出——`apps/server` 要拿
 * `createMemoryExtensionStore` 建那张表，拿 `ExtensionPort` 装配它的实现。
 */
export {
  browserLabelFromUserAgent,
  browserSaysExtensionRequest,
  createMemoryExtensionStore,
  DEFAULT_EXTENSION_LABEL,
  EXTENSION_SCOPES,
  EXTENSION_TOKEN_TTL_MS,
  type ExtensionScope,
  type ExtensionSession,
  type ExtensionStore,
  type ExtensionTokenView,
  extensionIdOfOrigin,
  MemoryExtensionStore,
  PAIRING_TTL_MS,
  type PairingView,
  type RedeemedToken,
  tokenLabel,
} from './extension-store.js'
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
  BROWSER_SESSION_TTL_MS,
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
  type VerifyLoginOptions,
} from './identity.js'
export {
  asyncApiFragment,
  buildOpenApi,
  type OpenApiDocument,
  toOpenApiPath,
} from './openapi.js'
export {
  type AttachWorkspaceInput,
  type CreateOrganizationInput,
  canAdministerOrganization,
  createOrganizations,
  type MigratedWorkspace,
  type OrganizationPatch,
  type OrganizationRole,
  type Organizations,
  type OrganizationsOptions,
  type OrgBackend,
  organizationRoleOf,
  type RemovedOrganizationMember,
} from './organizations.js'
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
// WP225：岗位 AI 正在干活没有（桌面壳重启并更新前问）
export { type ActivityPort, type ActivityView, activityRoutes } from './routes/activity.js'
// WP317（docs/101 §5.1④）：素材流水线那一面
export {
  type AdCreativeDesignView,
  type AdCreativeImportView,
  type AdCreativePort,
  adCreativeRoutes,
} from './routes/ad-creative.js'
// WP75（57 §5）：广告库那一面
export type {
  AdsAccountRow,
  AdsCampaignRow,
  AdsChangesView,
  AdsOverviewView,
  AdsPort,
  AdsStagedView,
} from './routes/ads.js'
export { adsRoutes } from './routes/ads.js'
export type { AdsActor } from './routes/ads-types.js'
// WP398：Amazon 词库
export {
  type AmazonKeywordsActor,
  type AmazonKeywordsPort,
  amazonKeywordRoutes,
} from './routes/amazon-keywords.js'
// WP396：自家 Amazon Listing 体检
export type {
  AmazonListingPort,
  AmazonListingRulePatch,
  AmazonListingRunView,
} from './routes/amazon-listing.js'
export { amazonListingRoutes } from './routes/amazon-listing.js'
// WP287：「发给他的卡他必须点得动」那把尺子（只关于本人的卡）——服务端岗位页计数也用它
export { isSelfCard, SELF_CARD_FORMS } from './routes/approvals.js'
export { type AskActor, type AskAnswer, type AskPort, askRoutes } from './routes/ask.js'
export { autoMemoryRoutes } from './routes/auto-memory.js'
// WP428（决策 1244 改）：全自动（够条件 → 建议开、人点了才开、随时能关）
export {
  type AutopilotActor,
  type AutopilotPort,
  type AutopilotScopeView,
  autopilotRoutes,
} from './routes/autopilot.js'
// WP172（docs/84）：B2B 库的列表 / 详情 / 草稿 / 提交改动卡 / CSV 导入
export type {
  B2bActor,
  B2bCsvImportInput,
  B2bDetailView,
  B2bDraftInput,
  B2bDraftView,
  B2bFactCategoryView,
  B2bFactsView,
  B2bImportView,
  B2bListView,
  B2bOutboundPort,
  B2bOutboundSettingsInput,
  B2bOutboundView,
  B2bPort,
  B2bQuoteSendInput,
  B2bQuoteSheetView,
  B2bReplyClassifyInput,
  B2bReplyClassifyView,
  B2bRow,
  B2bSalesPort,
  B2bSalesView,
  B2bSampleAdvanceInput,
  B2bSequenceRowView,
  B2bSequenceStartInput,
  B2bSequenceStartView,
  B2bStagedView,
} from './routes/b2b.js'
export { B2B_COLLECTION_ROUTES, b2bRoutes } from './routes/b2b.js'
export {
  BACKGROUND_CONCURRENCY_MAX,
  BACKGROUND_CONCURRENCY_MIN,
  type BackgroundActor,
  type BackgroundPort,
  type BackgroundSettingsView,
  type BrandBackgroundView,
  backgroundRoutes,
} from './routes/background.js'
export type { BackupExportView, BackupPort } from './routes/backup.js'
export { backupRoutes } from './routes/backup.js'
// WP268：品牌素材库
export {
  BRAND_ASSET_UPLOAD_MAX_BYTES,
  type BrandAssetRow,
  type BrandAssetsActor,
  type BrandAssetsPort,
  brandAssetRoutes,
} from './routes/brand-assets.js'
// WP122（71）：每个品牌一份 DESIGN.md
export type { BrandDesignActor, BrandDesignPort } from './routes/brand-design.js'
export { brandDesignRoutes } from './routes/brand-design.js'
// WP121（70 §3）：贴一个网址自动分析
export type { BrandIntakeActor, BrandIntakePort } from './routes/brand-intake.js'
export { brandIntakeRoutes } from './routes/brand-intake.js'
export { type BrowserActor, type BrowserPort, browserRoutes } from './routes/browser.js'
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
// WP57（48 §4 L3 #11）：网站在线客服的本地 API；WP60 加公开访客面与 widget 配置
export {
  CHAT_SSE_HEARTBEAT_MS,
  type ChatAutoAnswerView,
  type ChatFrame,
  type ChatMessageView,
  type ChatPort,
  type ChatRelayHostedView,
  type ChatSessionView,
  type ChatTurnView,
  type ChatWidgetSettings,
  chatRoutes,
  type PublicOpenResult,
  sseResponse,
} from './routes/chat.js'
export {
  CLIENT_ERROR_MAX_BODY,
  CLIENT_ERROR_RATE,
  clientErrorRoutes,
  sanitizeClientError,
  scrubClientText,
} from './routes/client-errors.js'
export type { CloudActor, CloudPort } from './routes/cloud.js'
export { cloudRoutes } from './routes/cloud.js'
export type {
  BeginCloudLinkInput,
  BeginCloudLinkResult,
  CloudAccountPort,
  CloudAccountView,
  CloudAuthDoneView,
  CloudAuthPort,
  CloudCodeSentView,
  CloudUnlinkResult,
} from './routes/cloud-account.js'
export { cloudAccountRoutes } from './routes/cloud-account.js'
// WP392：竞品监控
export type { CompetitorChangeRow, CompetitorWatchPort } from './routes/competitor-watch.js'
export { competitorWatchRoutes } from './routes/competitor-watch.js'
export {
  type ComputerUseActor,
  type ComputerUsePort,
  computerUseRoutes,
} from './routes/computer-use.js'
export type {
  ConnectionDirectoryItemView,
  ConnectionDirectoryPort,
  ConnectionRuntimeState,
  PositionConnectionItemView,
  PositionConnectionsView,
} from './routes/connection-directory.js'
export { connectionDirectoryRoutes } from './routes/connection-directory.js'
export type {
  BeginConnectResult,
  BrandConflictKind,
  ConnectionOwnership,
  ConnectionStatus,
  ConnectionsActor,
  ConnectionsPort,
  ConnectionView,
  ConnectRequestStatus,
  ConnectTestResult,
  CredentialStore,
  LocalConnectorJobView,
  LocalConnectorView,
  MailboxDetectResult,
  MailboxPresetView,
  MailboxSwitchesInput,
  MailboxSwitchesView,
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
  type ContentDigestActor,
  type ContentDigestPort,
  contentDigestRoutes,
} from './routes/content-digest.js'
export {
  type ContentUpdatesActor,
  type ContentUpdatesPort,
  contentUpdatesRoutes,
} from './routes/content-updates.js'
export {
  type DataServiceActor,
  type DataServiceApiPort,
  dataServiceRoutes,
} from './routes/data-service.js'
// WP76（58 §5）：设计库的 `/v1` 面
export type {
  DesignAssetInput,
  DesignAssetRow,
  DesignAssetView,
  DesignBriefRow,
  DesignBriefView,
  DesignPort,
  DesignRequestInput,
  DesignRequestRow,
  DesignRequestView,
  DesignStagedView,
  DesignVariantView,
} from './routes/design.js'
export { designRoutes } from './routes/design.js'
export type { DesignActor } from './routes/design-types.js'
// WP136（docs/79）：dsh 场景切换
export { type DshScenesActor, type DshScenesPort, dshScenesRoutes } from './routes/dsh-scenes.js'
// WP224：毛利率事实卡、两条止损线对照、本周经营一页纸
export {
  type EconomicsActor,
  type EconomicsPort,
  economicsRoutes,
  type WeeklyReviewRunView,
} from './routes/economics.js'
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
export type {
  ExtensionAutoScoreQueued,
  ExtensionAutoScoreView,
  ExtensionBioLinkObservation,
  ExtensionBioLinkResult,
  ExtensionContactContribution,
  ExtensionContactDispute,
  ExtensionContactLookup,
  ExtensionContactSave,
  ExtensionContactSaveResult,
  ExtensionContentComment,
  ExtensionContentObservation,
  ExtensionContentResult,
  ExtensionContentSave,
  ExtensionContentSaveResult,
  ExtensionContentStats,
  ExtensionCreatorKey,
  ExtensionCreatorRecentItem,
  ExtensionCreatorReport,
  ExtensionCreatorSave,
  ExtensionCreatorSaveResult,
  ExtensionHello,
  ExtensionIngestResult,
  ExtensionIngestRow,
  ExtensionIngestStatus,
  ExtensionObservation,
  ExtensionPort,
  ExtensionProfileRow,
  ExtensionRevealPricing,
  ExtensionSeedSignature,
  ExtensionSetup,
} from './routes/extension.js'
export {
  EXTENSION_BATCH_ID,
  EXTENSION_BIO_LINK_OBSERVATION_SCHEMA,
  EXTENSION_CONTENT_OBSERVATION_SCHEMA,
  EXTENSION_CREATOR_SAVE_SCHEMA,
  EXTENSION_INGEST_SCHEMA,
  extensionRoutes,
  KOL_SETUP_PATH,
  REVEAL_FREE_WINDOW_DAYS,
} from './routes/extension.js'
// WP313：插件动作通道（广告后台）
export type {
  ActionEnqueueInput,
  ActionEnqueueResult,
  ExtensionActionsPort,
} from './routes/extension-actions.js'
export { extensionActionRoutes } from './routes/extension-actions.js'
// WP345：插件随工坊安装与更新
export type {
  ExtensionFolderSync,
  ExtensionInstallPort,
  ExtensionInstallView,
  ExtensionOpenResult,
  ExtensionOpenTarget,
  ExtensionRunningVersion,
  ExtensionVersionReply,
  ExtensionVersionReport,
} from './routes/extension-install.js'
export { extensionInstallRoutes } from './routes/extension-install.js'
// WP360：需要插件的岗位一开始就引导装好插件
export type {
  ExtensionFollowStep,
  ExtensionNeedsActor,
  ExtensionNeedsView,
  ExtensionOnboardingPort,
} from './routes/extension-onboarding.js'
export { extensionOnboardingRoutes } from './routes/extension-onboarding.js'
// WP413：插件常驻侧边栏
export type { ExtensionPanelFacts, ExtensionPanelPort } from './routes/extension-panel.js'
export {
  editedPayloadOf,
  extensionPanelRoutes,
  isPanelCard,
  panelCardOf,
} from './routes/extension-panel.js'
export {
  FEEDBACK_LOCAL_MAX_BODY,
  type FeedbackActor,
  type FeedbackPageContext,
  type FeedbackPort,
  feedbackRoutes,
  routeOnly as feedbackRouteOnly,
} from './routes/feedback.js'
// WP188：随便聊
export type {
  // WP343：「我的助理」
  AssistantHistoryHitView,
  AssistantMemoryView,
  AssistantSegmentView,
  AssistantStateView,
  AssistantSuggestionView,
  AssistantTargetView,
  AssistantThreadView,
  FreeChatActor,
  FreeChatAttachment,
  FreeChatCitation,
  FreeChatDispatchView,
  FreeChatFanoutEditInput,
  FreeChatFanoutItemView,
  FreeChatFanoutSummaryView,
  FreeChatFanoutView,
  FreeChatFrame,
  FreeChatImage,
  FreeChatMessageView,
  FreeChatModelChoice,
  FreeChatModelPrice,
  FreeChatModelsView,
  FreeChatModelThinking,
  FreeChatPort,
  FreeChatReportView,
  FreeChatSessionView,
  FreeChatSource,
  FreeChatThinkingLevel,
  FreeChatTurnInput,
} from './routes/free-chat.js'
export { freeChatRoutes } from './routes/free-chat.js'
export {
  type GenuiImageHostsPort,
  genuiImageHostsRoutes,
} from './routes/genui-image-hosts.js'
export { HALT_SCOPES, haltRoutes } from './routes/halt.js'
export {
  type ColleagueView,
  type HandoffActor,
  type HandoffKind,
  type HandoffLists,
  type HandoffPort,
  type HandoffView,
  handoffRoutes,
  type MyWorkExport,
  type PersonUsageView,
} from './routes/handoff.js'
export { healthRoutes, type ReconcilePort } from './routes/health.js'
export { type HelpPort, helpRoutes } from './routes/help.js'
export { inboxRoutes } from './routes/inbox.js'
export {
  type JoinActor,
  type JoinDecisionInput,
  type JoinImportReceipt,
  type JoinPort,
  joinRoutes,
} from './routes/join.js'
export type {
  KolActor,
  KolCampaignAcceptView,
  KolCampaignBrief,
  KolCampaignGroup,
  KolCampaignPick,
  KolCampaignView,
  KolCollaborationInput,
  KolCollaborationRow,
  KolContactView,
  KolCreatorChecksView,
  KolCreatorDetail,
  KolCreatorInput,
  KolCreatorPatch,
  KolCreatorProfileView,
  KolCreatorReviewView,
  KolCreatorRow,
  KolImportCommitView,
  KolImportPreviewView,
  KolImportView,
  KolMailStageEstimateView,
  KolMailStageRunView,
  KolMergeSuggestionView,
  KolOutreachBatchProgressView,
  KolOutreachBatchSendView,
  KolOutreachBatchView,
  KolOutreachDefaultsView,
  KolOutreachView,
  KolPort,
  KolRevealPrice,
  KolReviewFilter,
  KolSearchHit,
  KolSearchResult,
  KolStagedView,
  KolStageSegment,
  KolTrackedLinkInput,
} from './routes/kol.js'
export {
  DEFAULT_OUTREACH_PER_HOUR,
  KOL_TAG_MAX_LENGTH,
  KOL_TAGS_MAX,
  kolRoutes,
  OUTREACH_PER_HOUR_ESTABLISHED,
  OUTREACH_PER_HOUR_MAX,
  OUTREACH_PER_HOUR_MIN,
  OUTREACH_PER_HOUR_NEW,
} from './routes/kol.js'
export type {
  MeetingIngestInput,
  MeetingProcessOutcome,
  MeetingSendCardInput,
  MeetingsPort,
} from './routes/meetings.js'
export { meetingRoutes } from './routes/meetings.js'
// WP113（63）：消息——统一收件处
export type {
  MailAssistantView,
  MessageAccountView,
  MessageActor,
  MessageAutoReplyMark,
  MessagesPort,
  MessageThreadView,
} from './routes/messages.js'
export { messageRoutes } from './routes/messages.js'
export type {
  DeepSeekAccountPhase,
  DeepSeekAccountTaskView,
  DeepSeekAccountView,
  DeepSeekQuotaView,
  DeepSeekWalletView,
  DiscoverModelsInput,
  ModelAiSourceView,
  ModelDefaultsView,
  ModelEnableModelView,
  ModelEnableNotice,
  ModelEnableSourceView,
  ModelEnableView,
  ModelImageUsing,
  ModelImageView,
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
  ModelVisionStatus,
  SaveModelProviderInput,
  SetModelDefaultsInput,
  SetModelEnableInput,
  SetModelImageInput,
  SubscriptionLoginInput,
  SubscriptionLoginMethodName,
  SubscriptionNoticeView,
  SubscriptionProviderKind,
  SubscriptionQuestionView,
  SubscriptionView,
} from './routes/models.js'
export { MODEL_PURPOSES, modelRoutes, parseModelId } from './routes/models.js'
// WP429：站内通知
export {
  type NotificationActor,
  type NotificationsPort,
  notificationsRoutes,
} from './routes/notifications.js'
// WP254：下载源（官方源 / 国内源，每台机一份）
export {
  type NpmRegistryPort,
  type NpmRegistryView,
  npmRegistryRoutes,
} from './routes/npm-registry.js'
export {
  type OfficialPluginsActor,
  type OfficialPluginsPort,
  officialPluginsRoutes,
} from './routes/official-plugins.js'
export type {
  DiscoveryHelloView,
  DiscoveryPeerView,
  DiscoveryStateView,
  InviteView,
  MembershipClaimRequest,
  MembershipRequestInput,
  MembershipRequestView,
  OnboardingActor,
  OnboardingApplyView,
  OnboardingConnectorItem,
  OnboardingExtensionItem,
  OnboardingPlanInput,
  OnboardingPlannedPosition,
  OnboardingPlanView,
  OnboardingPlatformCliItem,
  OnboardingPort,
  OnboardingPositionPlanItem,
  OnboardingPositionView,
  OnboardingSkillItem,
  OnboardingStateView,
  OnboardingSuggestInput,
  OnboardingSuggestView,
  SupersedeInput,
  TeamJoinView,
  TeamLinkView,
  TeamSubscriptionLocalView,
  VerticalChoiceView,
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
  LeavePreviewView,
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
  OwnerTransferView,
  PeerOfferKind,
  PeerOfferView,
  PersonalLayerPolicy,
  PolicyPatchInput,
  PositionInput,
  PositionReshapeView,
  PositionSupervisorInput,
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
export type {
  BrandCopyView,
  BrandSwitchView,
  BrandView,
  CompanyModeView,
  CreateBrandInput,
  OrganizationActor,
  OrganizationInviteView,
  OrganizationMemberView,
  OrganizationOffboardView,
  OrganizationProfileInput,
  OrganizationsPort,
  OrganizationView,
  SetOrganizationModeInput,
} from './routes/organizations.js'
export { organizationRoutes } from './routes/organizations.js'
// WP323：发出记录与记录去处
export type {
  OutboundActor,
  OutboundExportView,
  OutboundFollowUpInput,
  OutboundListQuery,
  OutboundPort,
} from './routes/outbound.js'
export { outboundRoutes } from './routes/outbound.js'
export type { PersonaActor, PersonaPort } from './routes/personas.js'
export { personaRoutes } from './routes/personas.js'
export {
  type PlatformCliAction,
  type PlatformCliJobView,
  type PlatformCliState,
  type PlatformCliView,
  type PlatformKitActor,
  type PlatformKitPort,
  type PlatformKitView,
  platformKitRoutes,
} from './routes/platform-kit.js'
export type {
  OpenAtPositionView,
  PositionActor,
  PositionAnswerRecordView,
  PositionAnswerView,
  PositionEntryPort,
  RouteCandidateView,
} from './routes/positions.js'
export { positionEntryRoutes } from './routes/positions.js'
// WP78（60 §5）：公关库的最小一套
export type {
  PrActor,
  PrContactRow,
  PrExternalPostInput,
  PrExternalPostRow,
  PrExternalPostView,
  PrMentionFilter,
  PrMentionInput,
  PrMentionRow,
  PrMentionView,
  PrPort,
  PrReleaseInput,
  PrReleaseRow,
  PrStagedView,
  PrWatchLinkResult,
  PrWatchSourcePatch,
  PrWatchSourceRow,
  PrWatchView,
} from './routes/pr.js'
export { prRoutes } from './routes/pr.js'
export {
  type PrivacyEraseStepView,
  type PrivacyEraseView,
  type PrivacyPort,
  privacyRoutes,
} from './routes/privacy.js'
// WP246：取数路线（体检、设置、Reddit 读号）
export {
  type ReadRoutesActor,
  type ReadRoutesApiPort,
  readRoutesRoutes,
} from './routes/read-routes.js'
// WP328：Reddit 每日巡查
export type { RedditWatchItemsQuery, RedditWatchPort } from './routes/reddit-watch.js'
export { redditWatchRoutes } from './routes/reddit-watch.js'
export type { RoleRulesActor, RoleRulesPort } from './routes/role-rules.js'
export { roleRuleRoutes } from './routes/role-rules.js'
// WP236：运行时长线
export { type RunLimitsPort, runLimitsRoutes } from './routes/run-limits.js'
export { scheduleRoutes } from './routes/schedules.js'
export {
  type SearchDataActor,
  type SearchDataApiPort,
  searchDataRoutes,
} from './routes/search-data.js'
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
// WP154「内容与搜索」：问题清单与现在跑一轮
export type {
  ClaimRulesPatch,
  GeoQuestionsView,
  GoogleSourcesView,
  GoogleSourceView,
  SeoActor as SeoRouteActor,
  SeoPort,
  SeoRunView,
} from './routes/seo.js'
export { seoRoutes } from './routes/seo.js'
export {
  type ShopAdminActor,
  type ShopAdminAuthJob,
  type ShopAdminPort,
  type ShopAdminState,
  type ShopAdminView,
  shopAdminRoutes,
} from './routes/shop-admin.js'
// WP265：连接页 Shopify 卡的一键授权（接私有云 WP263）
export {
  type ShopifyConnectActor,
  type ShopifyConnectAttemptView,
  type ShopifyConnectBlockedReason,
  type ShopifyConnectPort,
  type ShopifyConnectRow,
  type ShopifyConnectStarted,
  type ShopifyConnectTestResult,
  type ShopifyConnectUpgradeResult,
  type ShopifyConnectView,
  type ShopifyShopSource,
  shopifyConnectRoutes,
} from './routes/shopify-connect.js'
// WP77（59 §1 / §2）：建站那一侧最小一组
export type {
  SiteAppInstallInput,
  SiteAppRow,
  SiteChecklistView,
  SiteEmailTemplateInput,
  SiteEmailTemplateView,
  SitePort,
  SiteStagedView,
  SiteThemeStoreChoice,
  SiteThemeView,
} from './routes/site.js'
export { siteRoutes } from './routes/site.js'
// WP381：网站 / 商品体检与 AI 来源流量
export {
  type SiteHealthActor,
  type SiteHealthPort,
  type SiteHealthView,
  siteHealthRoutes,
} from './routes/site-health.js'
export type { SiteActor } from './routes/site-types.js'
export type {
  SocialAccountInput,
  SocialAccountRow,
  SocialBroadcastAudience,
  SocialBroadcastInput,
  SocialBroadcastView,
  SocialCalendarCell,
  SocialCalendarView,
  SocialIngestAccountView,
  SocialIngestView,
  SocialMemberRow,
  SocialPort,
  SocialPostInput,
  SocialPostRow,
  SocialPostView,
  SocialReplyDraftView,
  SocialStagedView,
  SocialTagSettingsView,
  SocialThreadInput,
  SocialThreadRow,
  SocialThreadView,
} from './routes/social.js'
export { socialRoutes } from './routes/social.js'
export type { SocialActor } from './routes/social-types.js'
// WP60（49 §6 / 48 L7）：在线值守的本地一面
export type {
  StandbyActor,
  StandbyBringHomeView,
  StandbyPort,
  StandbySwitchView,
} from './routes/standby.js'
export { standbyRoutes } from './routes/standby.js'
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
export { type TeamInboxPort, teamInboxRoutes } from './routes/team-inbox.js'
// WP476：设置 → 数据与隐私 →「帮助改进工坊（匿名使用数据）」
export { type TelemetrySettingsPort, telemetryRoutes } from './routes/telemetry.js'
// WP337：重启并更新前看一眼 / 暂停全部 / 放开
export {
  type UpdateBusyCounts,
  type UpdateBusyItem,
  type UpdateBusyKind,
  type UpdatePausePort,
  type UpdateReadinessView,
  type UpdateResumeSummary,
  updatePauseRoutes,
} from './routes/update-pause.js'
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
export {
  type ArchivedListFilter,
  type ArchivedMatterView,
  type RailDutyView,
  type RailMatterState,
  type RailMatterView,
  type RailPositionView,
  type WorkArchivePort,
  type WorkRailView,
  workArchiveRoutes,
} from './routes/work-archive.js'
export {
  type WorkshopServicesActor,
  type WorkshopServicesApiPort,
  workshopServicesRoutes,
} from './routes/workshop-services.js'
export { fromDeckError, workstationRoutes } from './routes/workstation.js'
// WP483（决策 1660）：岗位上的「发之前让我看一眼」
export {
  type WriteReviewActor,
  type WriteReviewPort,
  writeReviewRoutes,
} from './routes/write-review.js'
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
  IDEMPOTENCY_EPOCH,
  IDEMPOTENCY_MIGRATIONS,
  IDEMPOTENCY_MIGRATIONS_TABLE,
  type SqlIdempotencyOptions,
  SqlIdempotencyStore,
} from './sql-idempotency.js'
export { SqliteExtensionStore } from './sqlite-extension-store.js'
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
export {
  DEFAULT_MIGRATIONS_TABLE,
  type MigrateOptions,
  type Migration,
  migrate,
  schemaVersion,
} from './sqlite-migrations.js'
export { createAsyncTraceScope, createNoopTraceScope } from './trace-scope.js'
export type {
  AccountLoginPort,
  AutoMemoryPort,
  ChangesPort,
  ClientErrorEntry,
  ClientErrorPort,
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
  MemoryChangeView,
  ModulesPort,
  OwnerSetupCodePort,
  PositionSummary,
  Principal,
  RateLimitPolicy,
  ReportSnapshotMeta,
  ReportStorePort,
  RequestContext,
  RoleReconfirmView,
  RolesPort,
  SavedReport,
  ScheduleActor,
  ScheduleCreateInput,
  ScheduledTaskView,
  ScheduleListQuery,
  SchedulePatchInput,
  SchedulePort,
  ScheduleRunOutcome,
  SkillOverlayView,
  SkillPositionRef,
  SkillProposalSummary,
  SkillRoleRef,
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
