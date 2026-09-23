/**
 * 费用估算：按官方单价（`pricing.ts`）算「这个实例这个月大概花了多少」。
 *
 * **这是估算，不是账单**。真账在 Cloudflare 后台；这里的数只给运营后台那一格用，
 * 让人一眼看出「一个订阅的工作区一个月大约多少钱、30 积分盖不盖得住」。
 *
 * 不扣账号包含的免费量：那是整账号共享的（25 GiB·小时内存只够一个 basic 实例
 * 跑一天多），摊到每个工作区上接近 0，扣了反而让单个工作区的数看着比实际便宜。
 */
import { CONTAINERS_PRICING, type HostedInstanceType } from './pricing.js'

/**
 * CPU「忙的比例」的默认假设：10%。
 *
 * 官方 CPU 只按真用了的算。一个客服实例大部分时间在等访客、偶尔跑一次话轮
 * （话轮里真正耗时的是等模型，那段 CPU 是闲的）。10% 是往保守里放的数，
 * 上线后以 Cloudflare 后台的真实 vCPU·秒为准回头改这一个常量。
 */
export const DEFAULT_CPU_ACTIVE_RATIO = 0.1

export interface CostInput {
  instance_type: HostedInstanceType
  /** 容器活着的秒数。 */
  seconds: number
  cpu_active_ratio?: number
}

export interface CostBreakdown {
  memory_usd: number
  cpu_usd: number
  disk_usd: number
  total_usd: number
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000

export function estimateCost(input: CostInput): CostBreakdown {
  const spec = CONTAINERS_PRICING.instance_types[input.instance_type]
  const rates = CONTAINERS_PRICING.rates_usd
  const seconds = Math.max(0, input.seconds)
  const ratio = Math.min(1, Math.max(0, input.cpu_active_ratio ?? DEFAULT_CPU_ACTIVE_RATIO))
  const memory = spec.memory_gib * seconds * rates.memory_per_gib_second
  const cpu = spec.vcpu * ratio * seconds * rates.vcpu_per_second
  const disk = spec.disk_gb * seconds * rates.disk_per_gb_second
  return {
    memory_usd: round4(memory),
    cpu_usd: round4(cpu),
    disk_usd: round4(disk),
    total_usd: round4(memory + cpu + disk),
  }
}

/** 某个月（`YYYY-MM`）有多少秒。 */
export function secondsInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number)
  if (y === undefined || m === undefined || !Number.isFinite(y) || !Number.isFinite(m))
    return 30 * 24 * 3600
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return days * 24 * 3600
}

/** 常驻一整月（7×24）要多少钱——订阅了的工作区就是这个数。 */
export function fullMonthCost(
  instance_type: HostedInstanceType,
  month = '2026-09',
  cpu_active_ratio = DEFAULT_CPU_ACTIVE_RATIO,
): CostBreakdown {
  return estimateCost({ instance_type, seconds: secondsInMonth(month), cpu_active_ratio })
}
