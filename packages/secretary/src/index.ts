/**
 * `@agentsws/secretary` —— 秘书 Agent（41 §1）。
 *
 * 每人自带的个人 Agent，以本人权限运行，只管四件事：profile 与公开级别、代答、
 * 日程与约时间、任务路由。专业的事不归它——它只把事路由给对的岗位。
 *
 * 没有 IO、没有框架、没有模型：存储与"世界"（日程、撞车、查重、认领卡）都是注入的，
 * 纯逻辑部分（`answerQuestion` / `checkAgenda` / `routeTask` / `visibleProfile`）
 * 给同样的输入永远出同样的输出。
 */
export {
  type AgendaCheckInput,
  type AlternativesInput,
  alternativeSlots,
  busySlots,
  checkAgenda,
  DEFAULT_ALTERNATIVES,
  DEFAULT_HORIZON_DAYS,
  localDayStart,
  localWeekday,
  meetingsOnDay,
  parseHm,
  SLOT_STEP_MINUTES,
  withinAvailability,
} from './agenda.js'
export {
  type AnswerInput,
  answerQuestion,
  classifyQuestion,
  FIELDS_BY_KIND,
  MAX_TITLES,
} from './answer.js'
export { notFound, SecretaryError, type SecretaryErrorCode } from './errors.js'
export {
  buildSecretaryRunRequest,
  forbiddenTools,
  SECRETARY_PERSONA,
  SECRETARY_ROLE_ID,
  SECRETARY_TOOLS,
  type SecretaryRunInput,
} from './persona.js'
export {
  applyProfilePatch,
  clampLevel,
  dedupeSkills,
  defaultProfile,
  relationOf,
  visibleProfile,
  visibleTo,
} from './profile.js'
export {
  ACTION_TERMS,
  DOMAIN_TERMS,
  GENERIC_ROLES,
  MIN_CONFIDENCE,
  type RoleLike,
  type RouteInput,
  roleTermsOf,
  routeTask,
  scoreRoles,
} from './route.js'
export {
  type AskInput,
  type AskOutcome,
  BUSY_HORIZON_DAYS,
  type ClaimRequest,
  createSecretary,
  type MeetInput,
  type MeetingBriefSource,
  type RouteInputArgs,
  Secretary,
  type SecretaryEventSink,
  type SecretaryEventType,
  type SecretaryOptions,
  TITLE_MAX,
} from './service.js'
export {
  createSqliteSecretaryStore,
  type Migration,
  migrate,
  SECRETARY_MIGRATIONS,
  SqliteSecretaryStore,
  type SqliteSecretaryStoreOptions,
} from './sqlite-store.js'
export {
  type AskedFilter,
  type MeetFilter,
  MemorySecretaryStore,
  type SecretaryStore,
} from './store.js'
export { containsTerm, looksLikeQuestion, normalize, splitPhrases } from './text.js'
export {
  type AgendaCheckResult,
  type AgendaItem,
  type AnswerFacts,
  type AnswerKind,
  type AskedRecord,
  type Availability,
  type AvailabilityRule,
  COLLEAGUES_CEILING,
  type ConflictReason,
  type ContactPolicy,
  DEFAULT_AVAILABILITY,
  DEFAULT_DISCLOSURE,
  DISCLOSURE_LEVELS,
  type DisclosureLevel,
  type MeetingBrief,
  type MeetProposal,
  type MeetSlot,
  type MeetState,
  type PersonProfile,
  PRIVATE_TOPICS,
  PROFILE_FIELDS,
  type PrivateTopic,
  type ProfileField,
  type ProfilePatch,
  type ProfilePosition,
  type ProfileRecord,
  type ProfileSkill,
  type Relation,
  type RoleProfile,
  type RoleTerm,
  type RouteResult,
  type RouteScore,
  type RouteVerdict,
  type SecretaryAnswer,
  type VisibleProfile,
} from './types.js'
