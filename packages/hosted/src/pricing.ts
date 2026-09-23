/**
 * Cloudflare Containers 的官方单价（**抄自官网，不是我们编的**）。
 *
 * 来源：https://developers.cloudflare.com/containers/pricing/ 与
 * https://developers.cloudflare.com/containers/platform-details/limits/ ，
 * 2026-09-23 用 WebFetch 读的现行版本（docs/64 §13 的上游评估一节原样记着）。
 *
 * 三条口径要记住，估算全靠它们：
 *
 * 1. **内存与磁盘按「开着的规格」计**（provisioned），容器活着一秒就算一秒；
 * 2. **CPU 只按真用了的算**（active usage）——客服实例大部分时间在等访客，
 *    所以 CPU 那一项要乘一个「忙的比例」，那个比例是**我们的假设**（见 `cost.ts`）；
 * 3. **睡着不计费**：「Charges stop after the container instance goes to sleep」。
 *    但订阅了的工作区我们刻意不让它睡（冷启动对聊天窗不可接受，WP124 报告），
 *    所以常驻实例一个月就是整月的内存 + 磁盘。
 *
 * 官网改价了就改这一张表（与 `packages/metering/src/pricing.json` 同一条纪律：
 * 改数 = 改数据，不改逻辑），`as_of` 同步改。
 */

export type HostedInstanceType =
  | 'lite'
  | 'basic'
  | 'standard-1'
  | 'standard-2'
  | 'standard-3'
  | 'standard-4'

export interface InstanceSpec {
  /** vCPU（lite 是 1/16）。 */
  vcpu: number
  memory_gib: number
  disk_gb: number
}

export const CONTAINERS_PRICING = {
  as_of: '2026-09-23',
  source_urls: [
    'https://developers.cloudflare.com/containers/pricing/',
    'https://developers.cloudflare.com/containers/platform-details/limits/',
  ],
  /** Workers Paid 月费（已经在付——同一个账号、同一份账单）。 */
  workers_paid_usd_per_month: 5,
  /** 每账号每月包含的量（整账号共享，不是每个实例）。 */
  included: {
    memory_gib_hours: 25,
    vcpu_minutes: 375,
    disk_gb_hours: 200,
  },
  /** 超出部分的单价（美元）。 */
  rates_usd: {
    memory_per_gib_second: 0.0000025,
    vcpu_per_second: 0.00002,
    disk_per_gb_second: 0.00000007,
  },
  /** 北美 / 欧洲出站：每 GB，每月含 1 TB。客服实例的出站是文字，忽略不计。 */
  egress_usd_per_gb_na_eu: 0.025,
  instance_types: {
    lite: { vcpu: 1 / 16, memory_gib: 0.25, disk_gb: 2 },
    basic: { vcpu: 1 / 4, memory_gib: 1, disk_gb: 4 },
    'standard-1': { vcpu: 1 / 2, memory_gib: 4, disk_gb: 8 },
    'standard-2': { vcpu: 1, memory_gib: 6, disk_gb: 12 },
    'standard-3': { vcpu: 2, memory_gib: 8, disk_gb: 16 },
    'standard-4': { vcpu: 4, memory_gib: 12, disk_gb: 20 },
  } satisfies Record<HostedInstanceType, InstanceSpec>,
  /** 镜像大小上限 = 该规格的磁盘；整账号镜像存储 50 GB。 */
  account_image_storage_gb: 50,
} as const

export function isInstanceType(value: string): value is HostedInstanceType {
  return value in CONTAINERS_PRICING.instance_types
}
