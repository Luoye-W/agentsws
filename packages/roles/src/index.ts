/**
 * WP3 制度：职责与分配。
 *
 * - 05 §1 RoleDefinition / §2 Position 的 YAML 加载与 schema 校验
 * - 05 §3 Assignment 与 WorkspacePolicy 存储、额度解析（core.resolveMandate）
 * - 05 §4（31 §3.1 修订）单 Assignment 的 EffectiveConfig，不做跨 Assignment 并集
 * - 31 §3.1 完整元组的 Casbin 策略编译与判定
 * - 31 §3.4 采纳率只是体验指标：只有 low 风险才可能被建议升到 L2
 */

// WP350（决策 900）：助理一次拆成多份——认岗位、改方案、知识条目（服务进程与模拟世界同一份）
export {
  applyFanoutEdits,
  FANOUT_MAX_ITEMS,
  FANOUT_NOTE_SUBJECT,
  FANOUT_QUOTE_MAX,
  FANOUT_TEXT_MAX,
  type FanoutDraftItem,
  type FanoutEdit,
  type FanoutItem,
  type FanoutKind,
  type FanoutNoteCard,
  fanoutLooksSecret,
  fanoutNoteCard,
  mentionedPositions,
  resolveFanout,
} from './assistant-fanout.js'
// WP343（决策 859）：「我的助理」派活挑岗位 / 职责（服务进程与模拟世界同一份）
export {
  PICK_MAX_CANDIDATES,
  type PickPosition,
  type PickRequest,
  type PickResult,
  pickDispatchTarget,
  pickKey,
} from './assistant-pick.js'
export {
  adoptionLowerBound,
  adoptionRate,
  demote,
  recordDecision,
  suggestPromotion,
  Z_95_ONE_SIDED,
} from './automation.js'
// WP428（决策 1244 改）：够条件 → 建议开全自动（判定这一半；开关与「开了能多做什么」由各职责自己接）
export {
  type AutopilotEligibility,
  type AutopilotHistoryItem,
  type AutopilotOutcome,
  autopilotOutcomeOf,
  evaluateAutopilot,
} from './autopilot.js'
export type { AssignmentFilter, StoreBackend } from './backend.js'
export { createMemoryBackend, createSqliteBackend } from './backend.js'
// WP404（docs/107）：岗位内容叠到骨架上（白名单外整份拒收）、抽内容那一半
export {
  applyPositionContent,
  applyRoleContent,
  bundledContentFiles,
  checkContentFile,
  checkPositionContent,
  checkRoleContent,
  loadBundledPositionWithContent,
  loadBundledRoleWithContent,
  positionContentFileOf,
  positionContentOf,
  roleContentFileOf,
  roleContentOf,
} from './content.js'
export { changeKindOf, effectiveConfig, riskClassOf, webOf } from './effective.js'
export type {
  EntryClassifyComplete,
  EntryKind,
  EntryKindResult,
} from './entry-kind.js'
export {
  classifyEntryKind,
  ENTRY_CLASSIFY_MAX_INPUT,
  ENTRY_CLASSIFY_MAX_OUTPUT,
  ENTRY_CLASSIFY_TIMEOUT_MS,
  ENTRY_KINDS,
  entryClassifyPrompt,
  entryKindByRules,
  parseEntryKind,
} from './entry-kind.js'
export type { EntryIntent, EntryIntentResult } from './intent.js'
export { classifyEntryIntent, LONG_TASK_CHARS } from './intent.js'
export {
  BUNDLED_POSITIONS_DIR,
  BUNDLED_ROLES_DIR,
  bundledPositionIcon,
  bundledPositionOfRole,
  bundledRoleFile,
  loadBundledPosition,
  loadBundledPositions,
  loadBundledRole,
  loadBundledRoles,
  loadPosition,
  loadRole,
  parsePosition,
  parseRole,
  positionFromDocument,
  ROLE_ID_ALIASES,
  ROLE_ID_SPLITS,
  resolveRoleId,
  roleFromDocument,
  SUPERSEDED_POSITION_IDS,
} from './load.js'
// WP462：职责升大版本之后老分配怎么接上（只收窄 / 登记过的拆分自动，其余出确认卡）
export {
  autoUpgradable,
  heirsOf,
  isStaleMajor,
  majorOf,
  majorUpgradePath,
  ROLE_MAJOR_UPGRADES,
  type RoleMajorUpgrade,
  type RoleMajorUpgradeKind,
  type RoleUpgradeNeeded,
  roleUpgradeText,
} from './major-upgrades.js'
export { assertTighterOverrides } from './overrides.js'
export type {
  PersonaBrandContext,
  PersonaLang,
  PersonaProblem,
  PersonaSectionPart,
  PersonaSectionsInput,
  SplitPersona,
} from './persona.js'
export {
  applyPersonaOverride,
  applyPersonaSectionOverride,
  checkAllPersonas,
  checkGeneratedPersonaEn,
  checkPersona,
  HOUSE_RULE_SECTIONS,
  HOUSE_RULES,
  HOUSE_RULES_ORDER,
  type HouseRuleSection,
  hasChineseText,
  houseRulesSection,
  joinPersonaSections,
  MAX_PERSONA_CHARS,
  NEXT_SUGGESTION_ORDER,
  nextSuggestionSection,
  overriddenPersonaSections,
  PERSONA_ORDER,
  PERSONA_SECTION_IDS,
  PERSONA_SECTIONS_EN,
  PERSONA_SECTIONS_ZH,
  personaIsEmpty,
  personaKey,
  personaMergeSections,
  personaSectionDiff,
  personaSectionEdits,
  personaSections,
  personaTextIn,
  personaUntranslated,
  personaView,
  REPLY_LANGUAGE_ORDER,
  REPLY_LANGUAGE_RULE,
  renderBrandContext,
  replyLanguageSection,
  sameSubject,
  splitPersonaSections,
} from './persona.js'
export type { GeneratedPersonaEn, PersonaEnFile, PersonaEnProblem } from './persona-en.js'
export {
  checkPersonaEn,
  loadGeneratedPersonaEn,
  PERSONA_EN_FILE,
  personaZhHash,
  personaZhSource,
  withGeneratedEn,
} from './persona-en.js'
export type { PolicyEngine } from './policy.js'
export { compilePolicies, createPolicyEngine, rangeCovers, sensAtMost } from './policy.js'
export type {
  ApplyPositionOptions,
  AssignmentFactoryOptions,
  AssignmentInit,
} from './position.js'
export { applyPosition, buildAssignment, initialAutomationState } from './position.js'
export type { RangeTarget, TargetInRangeResult } from './ranges.js'
export {
  dedupeRanges,
  expandRanges,
  PRODUCT_LINE_PARENT_KINDS,
  productLineMatches,
  rangeCoversRef,
  rangeKey,
  rangeTargetOfProduct,
  shopifyLineQuery,
  targetInRange,
} from './ranges.js'
export type {
  RouteCandidate,
  RouteRoleLike,
  RouteRoleProfile,
  RouteRoleScore,
  RouteTerm,
  RouteWithinPositionResult,
  SettledRouteResult,
} from './route.js'
export {
  ACTION_TERMS,
  containsRouteTerm,
  DOMAIN_TERMS,
  GENERIC_ROLES,
  looksLikeSmallTalk,
  MIN_PICKED_SCORE,
  MIN_SEPARATION,
  namedRole,
  normalizeRouteText,
  ROUTE_WEIGHT,
  roleRouteTerms,
  routeWithinPosition,
  SHORT_TERM_PENALTY,
  scoreRouteRoles,
  settleAlways,
  settleCloseCall,
  settleNoHit,
  splitRoutePhrases,
} from './route.js'
export { collectUnknownKeys, POSITION_SCHEMA, ROLE_SCHEMA } from './schema.js'
export type {
  AssignmentApi,
  AutomationDefaultMigration,
  CreateAssignmentInput,
  PolicyApi,
  ProductLineApi,
  RangeExpanded,
  RangeGroupApi,
  RevokeInput,
  RoleMajorUpgradeRecord,
  RoleMigration,
  RoleRegistry,
  RoleStore,
  RoleStoreOptions,
  UpdateAssignmentInput,
} from './store.js'
export { createRoleStore, RETIRED_AUTOMATION_DEFAULTS } from './store.js'
// WP174：`scope_manager` 的审批落到谁（岗位上级 → 老板），服务进程与模拟世界共用
export type {
  ScopeManagerInput,
  ScopeManagerReason,
  ScopeManagerRoute,
  SupervisedPosition,
} from './supervisor.js'
export {
  hasApprovalFlow,
  positionOfRole,
  reconfirmReasonText,
  resolveScopeManager,
  returnOnDowngrade,
  scopeManagerReasonText,
} from './supervisor.js'
export type {
  AccessRequest,
  DecisionOutcome,
  EffectiveAction,
  EffectiveAutomation,
  EffectiveConfig,
  EffectiveConfigInput,
  GroundingRule,
  HomeBlock,
  NotificationRule,
  PolicyRow,
  Position,
  PromotionSuggestion,
  RoleDefinitionFull,
  RoleResolver,
} from './types.js'
export { RoleError, RoleSchemaError } from './types.js'
