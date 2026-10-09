/**
 * WP192：云上「官方数据接口统一能力口」的**契约替身**（`/v1/data/capabilities`、`/v1/data/call/*`、
 * `/v1/data/tasks*`）。
 *
 * 真服务在私有仓（渠道注册表、共享缓存、每个任务一个 Durable Object）。开源这一侧（本机客户端的
 * 测试、demo、合成世界）要的只是契约上的几条口径：
 *
 * - 同步：先预扣再取数；**同一个问法第二次命中缓存，照价收**；0 条不收；
 * - 异步：提交按上限条数预扣；跑完按实际条数结算、多扣的退回；失败全退；取消时已经拿到的照收；
 * - 幂等键：同一个组织同一个键只建一个任务，重发回同一个（200，不是 202）；
 * - 别的组织的任务一律「没有这个任务」（404）；
 * - 输入走契约的 `normalizeDataInput`（白名单以外丢掉），与云上同一句人话。
 *
 * 数据全是编出来的（按输入确定性生成），价是**示意价**（{@link SAMPLE_DATA_PRICES}，不是云上的真价）。
 * 任务不真跑：每读一次状态往前走一步（排队 → 在跑 → 跑完），测试不用等。纯内存、不出进程。
 */
import type {
  DataCallResult,
  DataCapabilityList,
  DataCapabilitySpec,
  DataItem,
  DataTaskItemsPage,
  DataTaskStatus,
  DataTaskView,
  Iso8601,
} from '@agentsws/contracts'
import {
  DATA_CAPABILITY_CATALOG,
  DATA_TASK_TERMINAL_STATUSES,
  dataCapabilitySpec,
  normalizeDataInput,
} from '@agentsws/contracts'
import type { StandInKolPrincipal } from './kol-public.js'
import { roundStandInCredits, type StandInWallet, StandInWalletError } from './wallet.js'

/** 示意价（每单位积分）。**不是云上的真价**——真价只在云上（`/v1/pricing`）。 */
export const SAMPLE_DATA_PRICES: Readonly<Record<string, number>> = {
  'serp.google': 0.2,
  'serp.bing': 0.2,
  'ai_answer.chatgpt': 0.2,
  'ai_answer.gemini': 0.2,
  'ai_answer.google_ai_overview': 0.2,
  'amazon.keyword_research': 1,
  'amazon.asin_keywords': 1,
  'seo.backlinks': 0.01,
  'seo.domain_rating': 0.5,
  'maps.places': 0.05,
  'contacts.website': 0.05,
  'social.instagram.profile': 0.05,
  'social.instagram.posts': 0.02,
  'social.tiktok.profile': 0.05,
  'social.tiktok.posts': 0.02,
  'amazon.product': 0.05,
  'amazon.reviews': 0.01,
  'social.linkedin.profile': 0.1,
}

/** 结果保留多久（与云上默认一样：7 天）。 */
export const STAND_IN_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** 一页多少条（与云上一样）。 */
export const STAND_IN_TASK_PAGE_SIZE = 100

export type StandInDataErrorCode =
  | 'invalid_input'
  | 'insufficient_credits'
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'not_implemented'

const STATUS: Record<StandInDataErrorCode, number> = {
  invalid_input: 400,
  insufficient_credits: 402,
  not_found: 404,
  conflict: 409,
  gone: 410,
  not_implemented: 501,
}

/** 替身抛的错：码与云上同名，`status` 是云上会回的那个状态码。 */
export class StandInDataError extends Error {
  readonly code: StandInDataErrorCode
  readonly status: number
  constructor(code: StandInDataErrorCode, message: string) {
    super(message)
    this.name = 'StandInDataError'
    this.code = code
    this.status = STATUS[code]
  }
}

interface StandInTask {
  view: DataTaskView
  org_id: string
  input: Record<string, unknown>
  items: DataItem[]
  reservation?: ReturnType<StandInWallet['reserve']> | undefined
  /** 这一任务要编出几条（≤ max_items）。 */
  planned: number
}

/** 一个字符串 → 一个稳定的小整数（编数据用，不是哈希算法）。 */
function seedOf(s: string): number {
  let h = 7
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 100_003
  return h
}

/** 按能力编一条结果（字段与云上规范化之后的同名，数是假的）。 */
export function sampleDataItem(
  capability: string,
  n: number,
  input: Record<string, unknown>,
): DataItem {
  const q = JSON.stringify(input)
  const seed = seedOf(`${capability}|${q}|${String(n)}`)
  const first = (name: string): string => {
    const v = input[name]
    return Array.isArray(v) ? String(v[n % v.length] ?? '') : String(v ?? '')
  }
  switch (capability) {
    case 'serp.google':
    case 'serp.bing':
      return {
        position: n + 1,
        url: `https://example-${String(n + 1)}.test/${encodeURIComponent(first('query'))}`,
        domain: `example-${String(n + 1)}.test`,
        title: `示例结果 ${String(n + 1)}`,
        type: 'organic',
      }
    case 'ai_answer.chatgpt':
    case 'ai_answer.gemini':
    case 'ai_answer.google_ai_overview':
      return {
        platform: capability.slice('ai_answer.'.length),
        text: `（示例回答）关于「${first('question')}」……`,
        cited_urls: ['https://example-1.test/'],
      }
    case 'amazon.keyword_research':
    case 'amazon.asin_keywords':
      return { keyword: `示例词 ${String(n + 1)}`, searches_monthly: 1000 + (seed % 9000) }
    case 'seo.backlinks':
      return {
        url_from: `https://ref-${String(n + 1)}.test/post`,
        url_to: `https://${first('target')}/`,
        domain_rating: seed % 90,
        anchor: `示例锚文本 ${String(n + 1)}`,
      }
    case 'seo.domain_rating':
      return { target: first('target'), domain_rating: seed % 90 }
    case 'maps.places':
      return {
        name: `示例商家 ${String(n + 1)}`,
        category: first('query'),
        city: first('location'),
        website: `https://shop-${String(n + 1)}.test`,
        rating: 3 + (seed % 20) / 10,
        reviews_count: seed % 500,
      }
    case 'contacts.website':
      return {
        url: first('urls'),
        domain:
          first('urls')
            .replace(/^https?:\/\//u, '')
            .split('/')[0] ?? '',
        emails: [`hello@shop-${String(n + 1)}.test`],
        phones: [],
      }
    case 'social.instagram.profile':
    case 'social.tiktok.profile':
      return { username: first('usernames'), followers: 1000 + seed * 3, posts_count: seed % 400 }
    case 'social.instagram.posts':
    case 'social.tiktok.posts':
      return {
        post_url: `https://social.test/p/${String(seed)}`,
        owner: first('usernames'),
        likes: seed % 5000,
        comments: seed % 200,
      }
    case 'amazon.product':
      return {
        asin: first('asins'),
        title: `示例商品 ${first('asins')}`,
        price: 9.99 + (seed % 100),
        rating: 3 + (seed % 20) / 10,
      }
    case 'amazon.reviews':
      return { asin: first('asin'), rating: 1 + (seed % 5), title: `示例评论 ${String(n + 1)}` }
    default:
      return { n: n + 1 }
  }
}

export class DataServiceStandIn {
  private readonly wallet: StandInWallet
  private readonly now: () => Iso8601
  private readonly newId: (prefix: string) => string
  private readonly prices: Readonly<Record<string, number>>
  private readonly catalog: readonly DataCapabilitySpec[]
  private readonly cache = new Set<string>()
  private readonly tasks = new Map<string, StandInTask>()
  /** `org|幂等键` → 任务号。 */
  private readonly idempotency = new Map<string, string>()
  /** 下一个提交的任务跑失败（测「失败全退」用）。 */
  failNext = false

  constructor(options: {
    wallet: StandInWallet
    now: () => Iso8601
    newId: (prefix: string) => string
    prices?: Readonly<Record<string, number>>
    catalog?: readonly DataCapabilitySpec[]
  }) {
    this.wallet = options.wallet
    this.now = options.now
    this.newId = options.newId
    this.prices = options.prices ?? SAMPLE_DATA_PRICES
    this.catalog = options.catalog ?? DATA_CAPABILITY_CATALOG
  }

  capabilities(): DataCapabilityList {
    return {
      at: this.now(),
      capabilities: this.catalog.map((c) => {
        const price = this.prices[c.id]
        const available = c.default_off !== true && price !== undefined
        return {
          id: c.id,
          label_zh: c.label_zh,
          label_en: c.label_en,
          group: c.group,
          mode: c.mode,
          unit: c.unit,
          ...(price === undefined ? {} : { credits_per_unit: price }),
          ...(c.max_items === undefined ? {} : { max_items: c.max_items }),
          ...(c.default_items === undefined ? {} : { default_items: c.default_items }),
          available,
          ...(available ? {} : { reason: '这项能力现在没有开通。' }),
          input: c.input.map((f) => ({ ...f })),
        }
      }),
    }
  }

  private specOf(id: string, mode: 'sync' | 'async'): { spec: DataCapabilitySpec; price: number } {
    const spec = this.catalog.find((c) => c.id === id) ?? dataCapabilitySpec(id)
    if (spec === undefined || spec.mode !== mode)
      throw new StandInDataError(
        'not_found',
        `没有「${id}」这项${mode === 'sync' ? '同步' : '异步'}能力。`,
      )
    const price = this.prices[spec.id]
    if (spec.default_off === true || price === undefined)
      throw new StandInDataError(
        'not_implemented',
        `「${spec.label_zh}」现在没有开通，这一次没有扣积分。`,
      )
    return { spec, price }
  }

  private reserve(
    principal: StandInKolPrincipal,
    capability: string,
    unit: string,
    quantity: number,
    credits: number,
  ): ReturnType<StandInWallet['reserve']> {
    try {
      return this.wallet.reserve({
        org_id: principal.org_id,
        workspace_id: principal.workspace_id,
        capability,
        unit,
        quantity,
        credits,
        request_id: this.newId('req'),
      })
    } catch (err) {
      if (err instanceof StandInWalletError && err.code === 'insufficient_credits')
        throw new StandInDataError('insufficient_credits', err.message)
      throw err
    }
  }

  /** 同步调用。 */
  call(
    principal: StandInKolPrincipal,
    capability: string,
    body: { input?: unknown; fresh?: boolean },
  ): DataCallResult {
    const { spec, price } = this.specOf(capability, 'sync')
    const checked = normalizeDataInput(spec, body.input)
    if (!checked.ok) throw new StandInDataError('invalid_input', checked.message)
    const limit =
      spec.unit === 'row' ? Math.min(Number(checked.input.limit ?? 100), spec.max_items ?? 100) : 1
    const reserved = roundStandInCredits(price * limit)
    const reservation = this.reserve(principal, spec.id, spec.unit, limit, reserved)
    const key = `${spec.id}|${JSON.stringify(checked.input)}`
    const cached = body.fresh !== true && this.cache.has(key)
    const count = spec.unit === 'row' ? Math.min(3, limit) : 3
    const items = Array.from({ length: count }, (_, i) => sampleDataItem(spec.id, i, checked.input))
    const quantity = spec.unit === 'row' ? items.length : 1
    const credits = roundStandInCredits(price * quantity)
    this.wallet.settle(reservation, { quantity, credits })
    if (spec.personal_contacts !== true) this.cache.add(key)
    return {
      capability: spec.id,
      items,
      quantity,
      credits,
      cached,
      fetched_at: this.now(),
      source: 'official',
    }
  }

  /** 提交一个任务。回 `{ task, created }`：同一个幂等键第二次提交 `created = false`。 */
  submit(
    principal: StandInKolPrincipal,
    body: {
      capability?: unknown
      input?: unknown
      max_items?: unknown
      idempotency_key?: unknown
    },
  ): { task: DataTaskView; created: boolean } {
    const key = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : ''
    if (key === '' || key.length > 128)
      throw new StandInDataError('invalid_input', '要带一个幂等键（1–128 个字符）。')
    const existing = this.idempotency.get(`${principal.org_id}|${key}`)
    if (existing !== undefined) {
      const found = this.tasks.get(existing)
      if (found !== undefined) return { task: { ...found.view }, created: false }
    }
    const { spec, price } = this.specOf(String(body.capability ?? ''), 'async')
    const checked = normalizeDataInput(spec, body.input)
    if (!checked.ok) throw new StandInDataError('invalid_input', checked.message)
    const cap = spec.max_items ?? 100
    const asked = typeof body.max_items === 'number' ? Math.floor(body.max_items) : undefined
    const max_items = Math.max(1, Math.min(asked ?? spec.default_items ?? cap, cap))
    const reserved = roundStandInCredits(price * max_items)
    const reservation = this.reserve(principal, spec.id, spec.unit, max_items, reserved)
    const id = `dt_${this.newId('task').replace(/[^A-Za-z0-9]/gu, '')}`
    const view: DataTaskView = {
      id,
      capability: spec.id,
      status: 'queued',
      max_items,
      item_count: 0,
      reserved_credits: reserved,
      credits: 0,
      created_at: this.now(),
      source: 'official',
    }
    const planned = Math.max(
      0,
      Math.min(max_items, 3 + (seedOf(JSON.stringify(checked.input)) % 5)),
    )
    const task: StandInTask = {
      view,
      org_id: principal.org_id,
      input: checked.input,
      items: [],
      reservation,
      planned,
    }
    if (this.failNext) {
      this.failNext = false
      task.planned = -1
    }
    this.tasks.set(id, task)
    this.idempotency.set(`${principal.org_id}|${key}`, id)
    return { task: { ...view }, created: true }
  }

  private mine(principal: StandInKolPrincipal, id: string): StandInTask {
    const task = this.tasks.get(id)
    // 别的组织的任务与不存在的同一句话
    if (task === undefined || task.org_id !== principal.org_id)
      throw new StandInDataError('not_found', '没有这个任务。')
    return task
  }

  private finish(task: StandInTask, status: DataTaskStatus): void {
    const price = this.prices[task.view.capability] ?? 0
    const at = this.now()
    if (task.reservation !== undefined) {
      if (task.items.length > 0 && status !== 'failed' && status !== 'timed_out') {
        const credits = roundStandInCredits(price * task.items.length)
        this.wallet.settle(task.reservation, { quantity: task.items.length, credits })
        task.view.credits = credits
      } else {
        this.wallet.release(task.reservation)
        task.view.credits = 0
      }
      task.reservation = undefined
    }
    task.view.status = status
    task.view.finished_at = at
    task.view.refunded_credits = roundStandInCredits(task.view.reserved_credits - task.view.credits)
    task.view.expires_at = new Date(Date.parse(at) + STAND_IN_TASK_RETENTION_MS).toISOString()
  }

  /** 往前走一步（排队 → 在跑 → 跑完）。 */
  private step(task: StandInTask): void {
    if (DATA_TASK_TERMINAL_STATUSES.includes(task.view.status)) return
    if (task.view.status === 'queued') {
      task.view.status = 'running'
      task.view.started_at = this.now()
      return
    }
    if (task.planned < 0) {
      this.finish(task, 'failed')
      task.view.error = { code: 'provider_error', message: '这一次没跑成，预扣的积分全退了。' }
      return
    }
    task.items = Array.from({ length: task.planned }, (_, i) =>
      sampleDataItem(task.view.capability, i, task.input),
    )
    task.view.item_count = task.items.length
    this.finish(task, 'succeeded')
  }

  /** 看一个任务（替身里每看一次往前走一步）。 */
  task(principal: StandInKolPrincipal, id: string): DataTaskView {
    const task = this.mine(principal, id)
    this.step(task)
    return { ...task.view }
  }

  items(principal: StandInKolPrincipal, id: string, cursor?: string): DataTaskItemsPage {
    const task = this.mine(principal, id)
    if (task.view.status !== 'succeeded' && task.view.status !== 'cancelled')
      throw new StandInDataError('conflict', '任务还没跑完，结果还取不到。')
    if (task.view.expires_at !== undefined && task.view.expires_at <= this.now())
      throw new StandInDataError('gone', '结果过了保留期，已经删了。')
    const page = cursor === undefined || cursor === '' ? 0 : Number(cursor)
    if (!Number.isInteger(page) || page < 0)
      throw new StandInDataError('invalid_input', '这个翻页位置不对。')
    const start = page * STAND_IN_TASK_PAGE_SIZE
    const items = task.items.slice(start, start + STAND_IN_TASK_PAGE_SIZE)
    const more = start + STAND_IN_TASK_PAGE_SIZE < task.items.length
    return {
      task_id: id,
      items,
      total: task.items.length,
      ...(more ? { next_cursor: String(page + 1) } : {}),
      ...(task.view.expires_at === undefined ? {} : { expires_at: task.view.expires_at }),
    }
  }

  cancel(principal: StandInKolPrincipal, id: string): DataTaskView {
    const task = this.mine(principal, id)
    if (!DATA_TASK_TERMINAL_STATUSES.includes(task.view.status)) this.finish(task, 'cancelled')
    return { ...task.view }
  }
}
