/**
 * WP3 制度：职责与分配。
 *
 * - 05 §1 RoleDefinition / §2 Position 的 YAML 加载与 schema 校验
 * - 05 §3 Assignment 与 WorkspacePolicy 存储、额度解析（core.resolveMandate）
 * - 05 §4（31 §3.1 修订）单 Assignment 的 EffectiveConfig，不做跨 Assignment 并集
 * - 31 §3.1 完整元组的 Casbin 策略编译与判定
 * - 31 §3.4 采纳率只是体验指标：只有 low 风险才可能被建议升到 L2
 */
export {
  adoptionLowerBound,
  adoptionRate,
  demote,
  recordDecision,
  suggestPromotion,
  Z_95_ONE_SIDED,
} from './automation.js'
export type { AssignmentFilter, StoreBackend } from './backend.js'
export { createMemoryBackend, createSqliteBackend } from './backend.js'
export { changeKindOf, effectiveConfig, riskClassOf } from './effective.js'
export {
  BUNDLED_POSITIONS_DIR,
  BUNDLED_ROLES_DIR,
  bundledPositionOfRole,
  loadBundledPosition,
  loadBundledPositions,
  loadBundledRole,
  loadBundledRoles,
  loadPosition,
  loadRole,
  parsePosition,
  parseRole,
  ROLE_ID_ALIASES,
  resolveRoleId,
} from './load.js'
export { assertTighterOverrides } from './overrides.js'
export type {
  PersonaBrandContext,
  PersonaLang,
  PersonaProblem,
  PersonaSectionsInput,
} from './persona.js'
export {
  applyPersonaOverride,
  checkAllPersonas,
  checkPersona,
  MAX_PERSONA_CHARS,
  PERSONA_ORDER,
  PERSONA_SECTIONS_EN,
  PERSONA_SECTIONS_ZH,
  personaIsEmpty,
  personaKey,
  personaSections,
  personaTextIn,
  personaView,
  renderBrandContext,
  sameSubject,
} from './persona.js'
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
} from './route.js'
export {
  ACTION_TERMS,
  containsRouteTerm,
  DOMAIN_TERMS,
  GENERIC_ROLES,
  MIN_PICKED_SCORE,
  MIN_SEPARATION,
  normalizeRouteText,
  ROUTE_WEIGHT,
  roleRouteTerms,
  routeWithinPosition,
  SHORT_TERM_PENALTY,
  scoreRouteRoles,
  splitRoutePhrases,
} from './route.js'
export { collectUnknownKeys, POSITION_SCHEMA, ROLE_SCHEMA } from './schema.js'
export type {
  AssignmentApi,
  CreateAssignmentInput,
  PolicyApi,
  ProductLineApi,
  RangeExpanded,
  RangeGroupApi,
  RevokeInput,
  RoleMigration,
  RoleRegistry,
  RoleStore,
  RoleStoreOptions,
  UpdateAssignmentInput,
} from './store.js'
export { createRoleStore } from './store.js'
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
