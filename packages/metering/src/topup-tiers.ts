/**
 * 充值档位（67 §2，Luoye 2026-09-19 定四档）。
 *
 * 这个文件里**没有一个价钱**——四档的数字全在 `topup-tiers.json` 里，和
 * `pricing.json` 一个道理（49 §3「定价表是数据不是代码」）。这里只有三件事：
 *
 * 1. 把那份 json 端出来（带类型）；
 * 2. 按 id 找一档——**找不到就回 `undefined`，绝不猜一个默认档**。猜错的后果是
 *    用户按 US$20 那张卡付了钱，到账却是别的数；
 * 3. 一道自检（{@link topupTiersConsistent}）：每一档的 `credits` 必须正好等于
 *    `usd × credits_per_usd`。为什么要有它：那张表是手写的，写错一位数是最容易
 *    发生、也最难在界面上看出来的事故（140 写成 1400 没人会觉得奇怪）。
 */
import type { TopupTier, TopupTiers } from '@agentsws/contracts'
import RAW from './topup-tiers.json' with { type: 'json' }

export interface TopupTiersFile extends TopupTiers {
  note: string
}

export const TOPUP_TIERS_FILE: TopupTiersFile = RAW as TopupTiersFile

/** 1 美元几积分。恒为 7（口径写在 json 里，这里只是转出来给调用方读）。 */
export const CREDITS_PER_USD: number = TOPUP_TIERS_FILE.credits_per_usd

/** 四档，按表里的顺序（界面上从左到右就是这个顺序）。 */
export const topupTiers = (file: TopupTiersFile = TOPUP_TIERS_FILE): TopupTier[] => file.tiers

/** 按 id 找一档。**认不出就 `undefined`**，调用方回一句人话，不退到某个默认档。 */
export function topupTierById(
  id: string,
  file: TopupTiersFile = TOPUP_TIERS_FILE,
): TopupTier | undefined {
  return file.tiers.find((t) => t.id === id)
}

/**
 * 每一档的 `credits` 对不对得上 `usd × credits_per_usd`。
 *
 * 回的是**对不上的那几档**（空数组 = 全对）。测试钉住它；健康页也可以读它。
 */
export function topupTiersConsistent(
  file: TopupTiersFile = TOPUP_TIERS_FILE,
): { id: string; expected: number; got: number }[] {
  const out: { id: string; expected: number; got: number }[] = []
  for (const tier of file.tiers) {
    const expected = tier.usd * file.credits_per_usd
    if (expected !== tier.credits) out.push({ id: tier.id, expected, got: tier.credits })
  }
  return out
}
