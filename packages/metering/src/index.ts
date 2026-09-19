/*
 * WP115（65）：成本会计、后台聚合、会员 term / cycle。
 *
 * 全部写在**新文件**里（`cost.ts` / `admin-queries.ts` / `plans.ts` + 两张 json），
 * 既有文件只做了两处最小追加：`wallet.ts` 的 `SettleMeta`，`sqlite-store.ts` 的
 * 迁移 v2（八个 ADD COLUMN + 三条索引）。
 */

export type {
  BreakdownRow,
  GroupKey,
  LedgerFilter,
  LedgerRow,
  LossRow,
  LossSummary,
  OrgUsage,
  Totals,
  TrendPoint,
  Window as AdminWindow,
} from './admin-queries.js'
export {
  anonymizeOrg,
  balancesByOrgs,
  breakdown,
  chargeHealth,
  dailyTrend,
  distinctValues,
  expiringSoon,
  GROUPABLE,
  grantLedger,
  ledger,
  ledgerBatches,
  lossAlert,
  lotsOfOrg,
  NON_USAGE_CAPABILITIES,
  outstandingCredits,
  paidOrgIds,
  revokeRemaining,
  totals,
  usageByOrgs,
} from './admin-queries.js'
export type { CostEstimate, CostTable, TokenCostEntry, UnitCostEntry } from './cost.js'
export {
  COST_TABLE,
  cnyToMicros,
  costTableNeedsReview,
  matchTokenCost,
  mostExpensiveTokenCost,
  providerOfModel,
  toCny,
  tokenCostMicros,
  unitCostMicros,
} from './cost.js'
export type { KolCycleCharge } from './kol-subscription.js'
export {
  cancelKolSubscription,
  dueKolCharges,
  grantKolMonths,
  kolChargeKeyOf,
  kolChargePaid,
  kolChargeUnpaid,
  kolGraceUntil,
  kolStatusAt,
  startKolSubscription,
} from './kol-subscription.js'
export type { PlannedCycle, PlansFile, TermPlanInput } from './plans.js'
export {
  addCalendarMonths,
  dueCycles,
  grantKeyOf,
  PLANS_FILE,
  planById,
  planCycles,
  plans,
  shanghaiDate,
  termEndsAt,
} from './plans.js'
export type { PricingFile, TokenUsage } from './pricing.js'
export {
  aiCredits,
  buildPricing,
  ceilCredits,
  creditsFor,
  creditsPerThousandTokens,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_ESTIMATED_OUTPUT_TOKENS,
  entryFor,
  estimateAiCredits,
  estimateTokens,
  isCnAvailable,
  modelPrice,
  PRICING_FILE,
  roundCredits,
  TOKEN_CAPABILITIES,
} from './pricing.js'
export type { EventRow, SqlWalletStore, SqlWalletStoreOptions } from './sql-store.js'
export {
  createSqlWalletStore,
  toEvent,
  WALLET_MIGRATIONS,
  WALLET_MIGRATIONS_TABLE,
} from './sql-store.js'
export type { SqliteWalletStore, SqliteWalletStoreOptions } from './sqlite-store.js'
export { createSqliteWalletStore } from './sqlite-store.js'
export type { TopupTiersFile } from './topup-tiers.js'
export {
  CREDITS_PER_USD,
  TOPUP_TIERS_FILE,
  topupTierById,
  topupTiers,
  topupTiersConsistent,
} from './topup-tiers.js'
export type {
  LedgerWriter,
  SqlWalletAdminPortOptions,
  UsageLedger,
  WalletAdminPort,
} from './usage-ledger.js'
export {
  eventIdOf,
  LEDGER_MIGRATIONS,
  LEDGER_MIGRATIONS_TABLE,
  sqlLedgerWriter,
  sqlUsageLedger,
  sqlWalletAdminPort,
} from './usage-ledger.js'
export type {
  SettleMeta,
  UsageFilter,
  WalletErrorCode,
  WalletEvent,
  WalletOptions,
  WalletReservation,
  WalletStore,
} from './wallet.js'
export {
  assertMeteringEvent,
  DEFAULT_LOW_BALANCE_THRESHOLD,
  MemoryWalletStore,
  settleMetaFields,
  Wallet,
  WalletError,
} from './wallet.js'
