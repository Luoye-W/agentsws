export type {
  ModelGatewayApi,
  ModelGatewayOptions,
  TranscribeRequest,
  UsageFilter,
  UsageReport,
} from './gateway.js'
export { createModelGateway } from './gateway.js'
// WP76（22 图片槽 / 58 §1）：图片能力的两个实现 + 「没有图片模型」那句人话
export type { StubImageProviderOptions } from './images.js'
export {
  encodePng,
  NO_IMAGE_MODEL_EN,
  NO_IMAGE_MODEL_ZH,
  parseImageSize,
  placeholderPng,
  stubImageProvider,
  unavailableImageProvider,
} from './images.js'
export type { BudgetCtx, BudgetScopeState, CapSpec, Reservation } from './ledger.js'
export { BudgetLedger } from './ledger.js'
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
  costOf,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  estimateCost,
  estimateInputTokens,
  priceFor,
  priceKey,
} from './pricing.js'
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
  DEEPSEEK_ACCOUNT_MODELS,
  deepseekAccountProvider,
  deepseekMessagesProvider,
  toMessagesRequest,
} from './providers/deepseek-account.js'
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
export type { FetchLike, OpenAiCompatibleOptions } from './providers/openai-compatible.js'
export {
  extensionFor,
  ollamaTagsUrl,
  openaiCompatibleProvider,
  // WP147：工具结果里的截图怎么出线（OpenAI 兼容口）
  TOOL_IMAGE_PLACEHOLDER,
  TOOL_IMAGES_LEAD,
  toWireMessages,
} from './providers/openai-compatible.js'
export type { OpenAiImageOptions } from './providers/openai-images.js'
// WP127：生图单独一档的真实现（OpenAI 形态 `/images/generations`）
export { IMAGE_TIMEOUT_MS, openaiImageProvider } from './providers/openai-images.js'
export type { StubProviderOptions } from './providers/stub.js'
export { stubProvider } from './providers/stub.js'
export type { StubAsrProviderOptions } from './providers/stub-asr.js'
export { decodeReadableText, segmentText, stubAsrProvider } from './providers/stub-asr.js'
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
  BlockedResidencyPayload,
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
