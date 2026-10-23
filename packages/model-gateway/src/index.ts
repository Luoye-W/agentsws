// WP473：用量按功能拆、缓存分组键（只发哈希）
export { featureOf, promptCacheKeyOf } from './feature.js'
export type {
  ExternalUsage,
  ModelGatewayApi,
  ModelGatewayOptions,
  TranscribeRequest,
  UsageFilter,
  UsageReport,
} from './gateway.js'
export { createModelGateway } from './gateway.js'
// WP274：生图跟着用户自己的模型走（认厂商、两个型号合一、估美元）+ Google 生图
export {
  cloudImageModels,
  defaultImageModels,
  estimateImageUsd,
  GPT_IMAGE_EDIT_MODEL,
  GPT_IMAGE_GENERATE_MODEL,
  IMAGE_MODEL_CAPS,
  type ImageModelCaps,
  type ImageVendor,
  imageMaskSupported,
  imageVendorOf,
  isRetiredImageModel,
  normalizeImageModel,
  RETIRED_IMAGE_MODELS,
  splitImageProvider,
} from './image-routing.js'
// WP76（22 图片槽 / 58 §1）：图片能力的两个实现 + 「没有图片模型」那句人话
export type { StubImageProviderOptions } from './images.js'
export {
  encodePng,
  IMAGE_SAFETY_REFUSAL_ZH,
  imageFidelitySupported,
  imageSizeFor,
  NO_IMAGE_MODEL_EN,
  NO_IMAGE_MODEL_ZH,
  parseImageSize,
  placeholderPng,
  stubImageProvider,
  unavailableImageProvider,
} from './images.js'
export type { BudgetCtx, BudgetScopeState, CapSpec, Reservation } from './ledger.js'
export { BudgetLedger } from './ledger.js'
// WP242：网络层失败的真原因（cause.code）
export {
  describeFetchError,
  isTransientNetError,
  type NetCause,
  netCauseOf,
  STREAM_INCOMPLETE_CODE,
  streamIncompleteError,
} from './net-cause.js'
export { staticPrefixHash, staticPrefixLength, truncateToHour } from './prefix.js'
export type {
  CatalogHit,
  CatalogModel,
  CatalogPrice,
  CatalogVendor,
  PriceCatalog,
  PriceParserId,
} from './pricing/catalog.js'
export {
  catalogModels,
  catalogPrice,
  catalogVision,
  catalogVisionByName,
  findModel,
  hostOf,
  PRICE_CATALOG,
  vendorForBaseUrl,
} from './pricing/catalog.js'
export type { PageFetch, RefreshOptions, VendorRefresh } from './pricing/refresh.js'
export {
  PRICING_TIMEOUT_MS,
  PRICING_USER_AGENT,
  parseDeepSeek,
  parseKimi,
  parseOpenAi,
  parseZhipu,
  refreshPriceCatalog,
} from './pricing/refresh.js'
export {
  CACHE_WRITE_MULTIPLIER,
  costOf,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  estimateCost,
  estimateInputTokens,
  priceFor,
  priceKey,
} from './pricing.js'
// WP374：Anthropic 兼容口（Claude 中转站等；协议是官方 pi-ai 的 anthropic-messages）
export type {
  AnthropicCompatibleOptions,
  AnthropicModelFacts,
} from './providers/anthropic-compatible.js'
export {
  ANTHROPIC_MESSAGES_API,
  ANTHROPIC_VERSION,
  anthropicCompatibleProvider,
  anthropicListingUrl,
  anthropicModelFacts,
  anthropicProviderError,
  anthropicRootUrl,
  loadAnthropicCatalog,
  readAnthropicListing,
} from './providers/anthropic-compatible.js'
export {
  piToolNames,
  readPiAssistant,
  toAnthropicPiContext,
  toPiContext,
} from './providers/anthropic-pi.js'
// WP134：第三种模型来源「用我的 DeepSeek 账号登录」的推理口（Messages 形态 + x-dsh-auth-token）
export type {
  AccountFetch,
  DeepSeekAccountProviderOptions,
  DeepSeekMessagesCredential,
  DeepSeekMessagesProviderOptions,
  MessagesRequestOptions,
  WireImageSource,
} from './providers/deepseek-account.js'
export {
  DEEPSEEK_ACCOUNT_BASE_URL,
  DEEPSEEK_ACCOUNT_DEFAULT_MODEL,
  // WP150：账号登录失效 / 没登录时那一次调用的失败原因（人话）
  DEEPSEEK_ACCOUNT_EXPIRED_MESSAGE,
  DEEPSEEK_ACCOUNT_MODELS,
  DEEPSEEK_ACCOUNT_SIGN_IN_REQUIRED_MESSAGE,
  // WP370：官方 DeepSeek 适配器的思考档（off / low / high / max，默认 high）与 Messages 那两格
  DEEPSEEK_DEFAULT_REASONING_EFFORT,
  DEEPSEEK_REASONING_EFFORTS,
  deepseekAccountProvider,
  deepseekMessagesProvider,
  messagesEffortFields,
  toMessagesRequest,
} from './providers/deepseek-account.js'
// WP367：账号模型目录从账号的 GET /models 取（移植自官方 dsh-llm-deepseek-account@0.2.1-alpha.4）
export type {
  AccountBuiltinModel,
  AccountCatalogModel,
  AccountModelCatalogView,
  AccountModelEntry,
  AccountModelListing,
  AccountModelOverride,
  AccountModelRefusal,
  DeepSeekAccountModelCatalogOptions,
  ListingFetch,
  ResolvedAccountCatalog,
} from './providers/deepseek-account-models.js'
export {
  AccountModelListingError,
  accountModelRefusalMessage,
  DEFAULT_MODELS_MAX_AGE_MS,
  DEFAULT_MODELS_TIMEOUT_MS,
  DeepSeekAccountModelCatalog,
  listingEndpoint,
  parseModelListing,
  resolveAccountCatalog,
} from './providers/deepseek-account-models.js'
// WP378（决策 1055）：DeepSeek 官方 API key 走 Chat 口的思考档（三档与工坊积分一致）
export {
  DEEPSEEK_THINKING_LEVELS,
  type DeepSeekThinkingLevels,
  deepseekChatEffortFields,
  deepseekThinkingLevelsOf,
} from './providers/deepseek-chat-thinking.js'
// WP143：DeepSeek Files API 复用（移植自官方 dsh-llm-deepseek@0.1.7-rc.1）
export type {
  DeepSeekFileConnection,
  DeepSeekFileStoreOptions,
  DeepSeekUploadIndex,
  DeepSeekUploadRecord,
  FilesFetch,
} from './providers/deepseek-files.js'
export {
  DeepSeekFileStore,
  DeepSeekFilesError,
  imageKeyOf,
  jsonFileUploadIndex,
  MESSAGES_FILES_BETA,
  memoryUploadIndex,
} from './providers/deepseek-files.js'
// WP151：DeepSeek 余额不足（判定照官方 0.1.7-rc.2：402 / 余额不足措辞；账号路与 API key 路各说各的）
export type { DeepSeekBalanceListener, DeepSeekQuotaKind } from './providers/deepseek-quota.js'
export {
  DEEPSEEK_ACCOUNT_QUOTA_MESSAGE,
  DEEPSEEK_API_QUOTA_MESSAGE,
  DEEPSEEK_PLATFORM_TOP_UP_URL,
  deepseekQuotaKindOf,
  isDeepSeekQuotaFailure,
  isQuotaExceededError,
} from './providers/deepseek-quota.js'
export {
  GEMINI_ASPECT_RATIOS,
  GEMINI_MAX_REFERENCE_IMAGES,
  GEMINI_NATIVE_BASE_URL,
  type GeminiImageOptions,
  geminiCanvas,
  geminiImageProvider,
  geminiNativeBase,
  NANO_BANANA_MODEL,
} from './providers/gemini-images.js'
export type { FetchLike, OpenAiCompatibleOptions } from './providers/openai-compatible.js'
export {
  // WP194：官方接口回 402（本月额度 / 公司积分）→ 那句人话
  cloudQuotaError,
  extensionFor,
  ollamaTagsUrl,
  openaiCompatibleProvider,
  // WP147：工具结果里的截图怎么出线（OpenAI 兼容口）
  TOOL_IMAGE_PLACEHOLDER,
  TOOL_IMAGES_LEAD,
  // WP243：「关思考」在各家线上的写法
  thinkingOffFields,
  toWireMessages,
} from './providers/openai-compatible.js'
export type { OpenAiImageOptions } from './providers/openai-images.js'
// WP127：生图单独一档的真实现（OpenAI 形态 `/images/generations`）
export { IMAGE_TIMEOUT_MS, openaiImageProvider } from './providers/openai-images.js'
// WP376（决策 1027）：自己接的 OpenAI 兼容口——地址是官方目录认识的那家时走官方 pi-ai（档位与传法照目录）
export type { OfficialRouteFacts, OpenAiPiApi, PiRouteOptions } from './providers/pi-route.js'
export {
  isOfficialRouteUrl,
  levelsSentApart,
  loadOfficialRoutes,
  OPENAI_PI_APIS,
  officialRouteFacts,
  piRouteProvider,
  routeEffortOf,
  routeKey,
} from './providers/pi-route.js'
export type { StubProviderOptions, StubScript } from './providers/stub.js'
export { stubProvider } from './providers/stub.js'
export type { StubAsrProviderOptions } from './providers/stub-asr.js'
export { decodeReadableText, segmentText, stubAsrProvider } from './providers/stub-asr.js'
// WP425：AI 来源顺序——自己的用不了时切到工坊积分
export type {
  ModelSourceKeyRejectedPayload,
  ModelSourceReloginPayload,
  SourceFallbackOff,
  SourceFallbackPolicy,
  SourceStep,
} from './source-fallback.js'
export {
  isSourceFallbackOffText,
  SOURCE_COOLDOWN,
  SOURCE_FALLBACK_OFF_MARK,
  sourceChainMessage,
  sourceFallbackOffError,
  sourceFallbackOffMessage,
  sourceFallbackOffOf,
  sourceLabelOf,
  sourceSwitchMessage,
  sourceSwitchReasonOf,
  WORKSHOP_SOURCE_LABEL,
} from './source-fallback.js'
// WP145：语音识别器选择层（对齐官方 ctx.speechToText；现在只有网关这一个识别器）
export type {
  LocalSpeechResult,
  SpeechContext,
  SpeechErrorCode,
  SpeechPreparation,
  SpeechPreparationOptions,
  SpeechPreparationState,
  SpeechProvider,
  SpeechProviderId,
  SpeechProviderInfo,
  SpeechProviderView,
  SpeechRequest,
  SpeechSelection,
  SpeechSetupEstimate,
  SpeechSpec,
  SpeechToText,
  SpeechToTextOptions,
} from './speech.js'
export {
  createSpeechToText,
  GATEWAY_SPEECH_PROVIDER_ID,
  gatewaySpeechProvider,
  localTranscription,
  SpeechError,
  speechAudioDigest,
} from './speech.js'
export type {
  BudgetExhaustedPayload,
  BudgetFrozenPayload,
  BudgetPolicy,
  CompleteRequest,
  EstimatePolicy,
  ModelEventSink,
  ModelEventType,
  ModelGatewayEvent,
  ModelGatewayPolicy,
  ModelUsagePayload,
  PriceEntry,
  PriceTable,
  ProviderDownPayload,
  UsageRecord,
} from './types.js'
export { GatewayError, isRetryableProviderError, ProviderError } from './types.js'
export type { CheckModelInput, ModelCheckErrorView, ModelCheckOutcome } from './vision-probe.js'
// WP127：模型验证三步（连通 → 文字 → 带图），向导与设置页共用
export {
  CANNOT_SEE_IMAGES_ZH,
  checkModel,
  hasImagePart,
  textProbeMessages,
  VISION_PROBE_PROMPT,
  VISION_PROBE_WORD,
  visionProbeBase64,
  visionProbeMessages,
  visionProbePassed,
  visionProbePng,
} from './vision-probe.js'
