/**
 * WP426（Luoye 10-19）：积分什么时候算「快用完了」。
 *
 * 原来用云端钱包给的 `low_balance`（门槛写死 50 积分）——注册才送 5 积分，一注册就红。
 * 改成按**还够跑几轮**判：便宜档一轮对话约 {@link CREDITS_PER_ROUND} 积分（依据：赠送规则
 * `packages/metering/src/bonuses.json` 里 Luoye 10-19 那句「剩 3 积分够十几轮便宜档对话」，
 * 3 ÷ 12 ≈ 0.25），少于 {@link LOW_ROUNDS} 轮才提醒。
 *
 * - 刚注册 5 积分 ≈ 20 轮：不红；
 * - 做完一次基础分析（封顶 2 积分）剩 3 ≈ 12 轮：不红；
 * - 剩 2.4 积分（≈ 9 轮）起提醒。
 *
 * 只是界面上的提醒口径：钱包那边的 `wallet.low_balance` 事件照旧（只记事件，不弹窗）。
 */
export const CREDITS_PER_ROUND = 0.25
export const LOW_ROUNDS = 10

/** 这点积分大约还够几轮便宜档对话（向下取整，负数按 0）。 */
export function roundsLeft(available: number): number {
  if (!Number.isFinite(available) || available <= 0) return 0
  return Math.floor(available / CREDITS_PER_ROUND + 1e-9)
}

/** 该不该提醒充值。 */
export function creditsLow(available: number): boolean {
  return roundsLeft(available) < LOW_ROUNDS
}
