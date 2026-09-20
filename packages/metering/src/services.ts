/**
 * 增值服务的登记表（67 §3，WP118）。
 *
 * 和 `pricing.json` / `topup-tiers.json` 一个道理（49 §3「定价表是数据不是代码」）：
 * 加一个按月订阅的服务是**往 json 里加一行**，不是写一份新代码。
 *
 * 一道自检（{@link subscriptionPricingGaps}）：登记表里的每个服务，价目表里都得有
 * 同名的一条、而且每月积分对得上。两张表分开写是有理由的（价目表要给界面看、
 * 登记表要给引擎跑），但分开写就会有人只改一张——那时用户看到的价钱和实际扣的
 * 数不是同一个，而这种错在界面上一点都看不出来。
 */
import type { Pricing, SubscriptionService, SubscriptionServices } from '@agentsws/contracts'
import RAW from './subscriptions.json' with { type: 'json' }

export interface SubscriptionServicesFile extends SubscriptionServices {
  note: string
}

export const SUBSCRIPTION_SERVICES_FILE: SubscriptionServicesFile = RAW as SubscriptionServicesFile

/** 全部登记的服务（含还没上线的）。 */
export const subscriptionServices = (
  file: SubscriptionServicesFile = SUBSCRIPTION_SERVICES_FILE,
): SubscriptionService[] => file.services

/** 现在真能订的那些（`available`）。界面上「可开通」的列表用它。 */
export const availableSubscriptionServices = (
  file: SubscriptionServicesFile = SUBSCRIPTION_SERVICES_FILE,
): SubscriptionService[] => file.services.filter((s) => s.available)

/** 按 id 找一个服务。**认不出就 `undefined`**，绝不退到某个默认服务。 */
export function subscriptionServiceById(
  id: string,
  file: SubscriptionServicesFile = SUBSCRIPTION_SERVICES_FILE,
): SubscriptionService | undefined {
  return file.services.find((s) => s.id === id)
}

/**
 * 登记表与价目表对不上的地方。空数组 = 全对。
 *
 * `missing`：价目表里根本没有这条能力（扣费时会因为"价目表里没有这一条"整笔拒掉）；
 * `mismatch`：有，但每月积分不是同一个数（界面显示 30、实际扣 50 这种）。
 */
export function subscriptionPricingGaps(
  pricing: Pricing,
  file: SubscriptionServicesFile = SUBSCRIPTION_SERVICES_FILE,
): { id: string; kind: 'missing' | 'mismatch'; expected: number; got?: number }[] {
  const out: { id: string; kind: 'missing' | 'mismatch'; expected: number; got?: number }[] = []
  for (const service of file.services) {
    const entry = pricing.entries.find((e) => e.capability === service.id)
    if (entry === undefined) {
      out.push({ id: service.id, kind: 'missing', expected: service.credits_per_month })
      continue
    }
    if (entry.credits_per_unit !== service.credits_per_month)
      out.push({
        id: service.id,
        kind: 'mismatch',
        expected: service.credits_per_month,
        got: entry.credits_per_unit,
      })
  }
  return out
}
