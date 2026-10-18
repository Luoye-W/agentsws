/**
 * WP394（docs/104 C4）：Amazon 对标款的**云端兜底**——内置浏览器被拦、或这台没有桌面壳时，走工坊云端数据的
 * `amazon.product`（异步任务，按个扣积分；和决策 897 搜索「免费先、扣积分兜底」一个规矩）。
 *
 * 云端那一路**没有划线价和优惠券**：交回的几格里本来就没有，读的那一轮把它们标成「这次读不到」照实空着。
 * 扣了多少积分照任务的实扣数报回去，对话里说一句。用户看得到的字不提任何数据供应商名。
 */
import type { AmazonCloudItem, AmazonCloudRead } from '@agentsws/brand-intake'
import {
  AMAZON_CLOUD_CAPABILITY,
  DATA_TASK_TERMINAL_STATUSES,
  type DataItem,
  type DataTaskItemsPage,
  type DataTaskView,
} from '@agentsws/contracts'

/** 数据能力口里用得到的那几样（`createDataService(cloud)` 交回的那一份）。 */
export interface AmazonCloudPort {
  submit(input: {
    capability: string
    input: Record<string, unknown>
    max_items?: number
    idempotency_key?: string
  }): Promise<DataTaskView>
  task(id: string): Promise<DataTaskView>
  items(id: string, cursor?: string): Promise<DataTaskItemsPage>
}

/** 等云端任务跑完最多多久；隔多久问一次。 */
export const AMAZON_CLOUD_WAIT_MS = 5 * 60_000
export const AMAZON_CLOUD_POLL_MS = 5_000

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** 云端规范化之后的一条 → 读的那一轮认的形状（认不出 ASIN 的丢掉）。 */
export function amazonCloudItemOf(raw: DataItem): AmazonCloudItem | undefined {
  const asin = str(raw.asin)?.toUpperCase()
  if (asin === undefined || !/^[A-Z0-9]{10}$/.test(asin)) return undefined
  const out: AmazonCloudItem = { asin }
  const title = str(raw.title)
  if (title !== undefined) out.title = title.slice(0, 300)
  const price = num(raw.price)
  if (price !== undefined) out.price = price
  const currency = str(raw.currency)?.toUpperCase()
  if (currency !== undefined) out.currency = currency
  const rating = num(raw.rating)
  if (rating !== undefined) out.rating = rating
  const reviews = num(raw.reviews_count)
  if (reviews !== undefined) out.reviews_count = reviews
  const bsr = num(raw.bsr)
  if (bsr !== undefined) out.bsr = bsr
  const category = str(raw.category)
  if (category !== undefined) out.category = category.slice(0, 200)
  const url = str(raw.url)
  if (url !== undefined) out.url = url
  const image = str(raw.image)
  if (image !== undefined) out.image = image
  if (typeof raw.in_stock === 'boolean') out.in_stock = raw.in_stock
  return out
}

/**
 * 云端读一批 ASIN：提交任务（最多要这么多条）→ 等它跑完 → 取全部结果。失败照实回一句（不带上游名）。
 */
export async function readAmazonCloud(
  port: AmazonCloudPort,
  input: { marketplace: string; asins: string[] },
  opts: { sleep(ms: number): Promise<void>; nowMs(): number },
): Promise<AmazonCloudRead> {
  try {
    let task = await port.submit({
      capability: AMAZON_CLOUD_CAPABILITY,
      input: { asins: input.asins, marketplace: input.marketplace },
      max_items: input.asins.length,
    })
    const until = opts.nowMs() + AMAZON_CLOUD_WAIT_MS
    while (!DATA_TASK_TERMINAL_STATUSES.includes(task.status)) {
      if (opts.nowMs() >= until) return { error: '工坊云端数据这次等太久没回来，下一拍再试' }
      await opts.sleep(AMAZON_CLOUD_POLL_MS)
      task = await port.task(task.id)
    }
    if (task.status !== 'succeeded')
      return { error: task.error?.message ?? '工坊云端数据这次没读成' }
    const items: AmazonCloudItem[] = []
    let cursor: string | undefined
    for (let i = 0; i < 20; i += 1) {
      const page = await port.items(task.id, cursor)
      for (const raw of page.items) {
        const it = amazonCloudItemOf(raw)
        if (it !== undefined) items.push(it)
      }
      if (page.next_cursor === undefined) break
      cursor = page.next_cursor
    }
    return { items, credits: task.credits }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
