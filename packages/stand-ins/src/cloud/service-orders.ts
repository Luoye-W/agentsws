/**
 * WP390（docs/105，WP389 的契约）：云上「工坊服务」（`/v1/services*`）的**契约替身**。
 *
 * 真服务在私有仓（每单一个订单对象 + 闹钟、钱包托管、运营后台）。开源这一侧（本机客户端的测试、demo）
 * 要的只是契约上的几条口径：
 *
 * - 服务目录：几项示意服务（{@link SAMPLE_SERVICES}）；`addService` = 「后台加一行」，本机不改代码就看得到；
 * - 下单：标准件按价目单校验算钱（契约的 `normalizeServiceLines`）、一口价的定制件直接付；先报价的不扣钱；
 *   **下单即扣、进托管**；幂等键：同一个键只建一单、只扣一次（重发回 200 + 同一单）；
 * - 状态只按契约的转移表走（`serviceOrderTransition`），表里没有的一律 409；
 * - 验收：标准件按凭证里实际完成的件数结算、没做完的按件退；定制件按段结算；返工次数用完 409；
 *   申请退款交给「运营」判（{@link ServiceOrdersStandIn.resolve}）；取消 / 超时把没结算的全退；
 * - 用量三行（托管 / 完成 / 退回，能力名 `workshop.service.*`）记在 {@link ServiceOrdersStandIn.ledger}。
 *
 * 「服务方 / 运营」那一侧（报价、接单、要材料、交付、发消息、要联系方式、判争议、到期）是方法，测试和 demo
 * 直接调，不走 HTTP（一期合作方本来就不登录系统，docs/105 §6）。纯内存、不出进程、不联网。
 */
import type {
  Iso8601,
  ServiceAcceptance,
  ServiceContact,
  ServiceContactExchange,
  ServiceDeliverable,
  ServiceDeliveryProof,
  ServiceIntentReport,
  ServiceList,
  ServiceMilestone,
  ServiceMilestoneView,
  ServiceOrderAction,
  ServiceOrderActor,
  ServiceOrderLineView,
  ServiceOrderList,
  ServiceOrderMessage,
  ServiceOrderStatus,
  ServiceOrderView,
  ServiceQuote,
  ServiceRequirementAnswer,
  ServiceView,
} from '@agentsws/contracts'
import {
  normalizeServiceLines,
  normalizeServiceRequirements,
  SERVICE_LEDGER_CAPABILITIES,
  SERVICE_ORDER_DEFAULTS,
  SERVICE_ORDER_TERMINAL_STATUSES,
  serviceMilestoneCredits,
  serviceOrderActions,
  serviceOrderTransition,
} from '@agentsws/contracts'

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000
const HOUR = 3_600_000

export class StandInServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

const common = {
  revisions: SERVICE_ORDER_DEFAULTS.revisions,
  available: true,
} as const

/** 示意服务目录（**不是**云上的真价、真服务；名字后缀「示意」）。 */
export const SAMPLE_SERVICES: readonly ServiceView[] = [
  {
    ...common,
    id: 'workshop.site_build',
    kind: 'custom',
    label_zh: '工坊建站',
    label_en: 'Workshop site build',
    summary_zh: '帮你搭好 Shopify 独立站：先聊需求、再报价，分三段交付。',
    summary_en:
      'We build your Shopify store: requirements first, then a quote, delivered in 3 steps.',
    pricing_mode: 'quote',
    from_credits: 800,
    milestones: [
      { id: 'brief', label_zh: '需求确认', label_en: 'Brief', share_percent: 20 },
      { id: 'design', label_zh: '设计稿', label_en: 'Design', share_percent: 40 },
      { id: 'launch', label_zh: '上线', label_en: 'Launch', share_percent: 40 },
    ],
    promise: { accept_hours: 24, quote_hours: 48, deliver_hours: 240 },
    revisions: 2,
    auto_accept_hours: SERVICE_ORDER_DEFAULTS.custom_auto_accept_hours,
    questions: [
      { id: 'sell', label_zh: '卖什么', label_en: 'What you sell', required: true },
      { id: 'market', label_zh: '目标市场', label_en: 'Target market', required: true },
      { id: 'refs', label_zh: '参考网站', label_en: 'Reference sites' },
      { id: 'pages', label_zh: '要几页', label_en: 'Pages' },
      { id: 'assets', label_zh: '有没有素材', label_en: 'Assets on hand' },
      { id: 'budget', label_zh: '预算区间', label_en: 'Budget range' },
    ],
    deliverables: ['platform_object', 'link'],
    landing: 'theme',
    positions: ['site', 'web-ops'],
    intents: ['想找人建站', '网站想改版', '找外包做网站', '找专业机构做网站', '重做网站'],
    blockers: ['setup:site.store', '品牌没有独立站'],
    provider_label: 'workshop_team',
  },
  {
    ...common,
    id: 'demo.engagement',
    kind: 'standard',
    label_zh: '社媒互动（示意）',
    label_en: 'Social engagement (sample)',
    summary_zh: '给指定的帖子加点赞、评论，按件计，没做完的按件退。',
    summary_en: 'Likes and comments on a post you pick, per unit; undone units refunded.',
    pricing_mode: 'per_unit',
    menu: [
      {
        id: 'like',
        label_zh: '点赞',
        label_en: 'Likes',
        unit_zh: '个',
        unit_en: 'each',
        credits_per_unit: 0.5,
        min_quantity: 10,
        max_quantity: 500,
        target_fields: [
          { name: 'post_url', type: 'string', required: true, max: 300, label_zh: '帖子链接' },
        ],
      },
      {
        id: 'comment',
        label_zh: '评论',
        label_en: 'Comments',
        unit_zh: '条',
        unit_en: 'each',
        credits_per_unit: 8,
        min_quantity: 1,
        max_quantity: 50,
        target_fields: [
          { name: 'post_url', type: 'string', required: true, max: 300, label_zh: '帖子链接' },
        ],
      },
    ],
    promise: { accept_hours: 24, deliver_hours: 24 },
    auto_accept_hours: SERVICE_ORDER_DEFAULTS.standard_auto_accept_hours,
    questions: [],
    deliverables: ['link'],
    landing: 'resume_step',
    positions: ['social-media', 'pr'],
    intents: ['帖子要点赞', '帖子没人互动', '想要更多评论', '帖子冷清'],
    provider_label: 'partner_team',
  },
  {
    ...common,
    id: 'demo.google_account',
    kind: 'standard',
    label_zh: '代开 Google 账号（示意）',
    label_en: 'Google account setup (sample)',
    summary_zh: '替你开好一个 Google 账号，开不成全退。',
    summary_en: 'We open a Google account for you; full refund if it fails.',
    pricing_mode: 'fixed',
    price_credits: 30,
    menu: [
      {
        id: 'account',
        label_zh: 'Google 账号',
        label_en: 'Google account',
        unit_zh: '个',
        unit_en: 'each',
        credits_per_unit: 30,
        min_quantity: 1,
        max_quantity: 1,
        target_fields: [],
      },
    ],
    promise: { accept_hours: 24, deliver_hours: 24 },
    auto_accept_hours: SERVICE_ORDER_DEFAULTS.standard_auto_accept_hours,
    questions: [],
    deliverables: ['receipt'],
    landing: 'resume_step',
    positions: ['web-ops', 'social-media'],
    intents: ['没有谷歌账号', '帮我开谷歌账号', '注册 Google 账号'],
    blockers: ['connect:google', 'connect:gsc', '没有 Google 账号'],
    provider_label: 'workshop_team',
  },
]

interface OrderRecord {
  view: ServiceOrderView
  key: string
  service: ServiceView
  messages: ServiceOrderMessage[]
  /** 在做 / 在验的是第几段（定制件）。 */
  segment: number
  provider_contact?: ServiceContact
  /** 自动驾驶（demo）走过的那几步。 */
  auto?: { said?: true; asked?: true }
}

export interface ServiceOrdersStandInOptions {
  now: () => Iso8601
  newId: (prefix: string) => string
  /** 现在可用多少积分（下单前看够不够）。 */
  available: () => number
  /** 扣进托管 / 退回（替身自己那本账）。 */
  spend: (credits: number) => void
  refund: (credits: number) => void
  services?: readonly ServiceView[]
  /**
   * demo 用：服务方是替身，**每列一次订单就把没结束的单各往前推一步**（报价 → 接单 → 要一次材料 → 交付），
   * 在等你的那几步（报价了、等你补材料、交付了）停着等你。测试不开（服务方那一侧由测试自己调）。
   */
  autopilot?: boolean
}

/** 用量明细里的一行（托管 / 完成 / 退回）。 */
export interface StandInServiceLedgerRow {
  capability: string
  order_id: string
  credits: number
  quantity: number
  at: Iso8601
}

export class ServiceOrdersStandIn {
  private readonly services: ServiceView[]
  private readonly orders = new Map<string, OrderRecord>()
  private readonly byKey = new Map<string, string>()
  private readonly ledgerRows: StandInServiceLedgerRow[] = []
  private readonly intentRows: ServiceIntentReport[] = []
  private catalogAt: Iso8601

  constructor(private readonly options: ServiceOrdersStandInOptions) {
    this.services = (options.services ?? SAMPLE_SERVICES).map((s) => structuredClone(s))
    this.catalogAt = options.now()
  }

  private now(): Iso8601 {
    return this.options.now()
  }

  private plus(hours: number): Iso8601 {
    return new Date(Date.parse(this.now()) + hours * HOUR).toISOString()
  }

  /* ── 目录（「后台加一行」） ──────────────────────────────────────── */

  catalog(): ServiceList {
    return { services: this.services.map((s) => structuredClone(s)), at: this.catalogAt }
  }

  /** 后台加一行 / 改一行（同 id 替换）：本机不改代码就看得到。 */
  addService(view: ServiceView): void {
    const at = this.services.findIndex((s) => s.id === view.id)
    if (at >= 0) this.services[at] = structuredClone(view)
    else this.services.push(structuredClone(view))
    this.catalogAt = this.now()
  }

  removeService(id: string): void {
    const at = this.services.findIndex((s) => s.id === id)
    if (at >= 0) this.services.splice(at, 1)
    this.catalogAt = this.now()
  }

  /** P8：没接住的意向（只有说法与岗位）。 */
  intent(body: Record<string, unknown>): void {
    const phrase = typeof body.phrase === 'string' ? body.phrase.trim().slice(0, 200) : ''
    if (phrase === '') throw new StandInServiceError(400, 'invalid_input', '意向说法不能空')
    this.intentRows.push({
      phrase,
      ...(typeof body.position_id === 'string' ? { position_id: body.position_id } : {}),
    })
  }

  intents(): ServiceIntentReport[] {
    return this.intentRows.map((r) => ({ ...r }))
  }

  ledger(): StandInServiceLedgerRow[] {
    return this.ledgerRows.map((r) => ({ ...r }))
  }

  /* ── 用户那一侧（HTTP） ─────────────────────────────────────────── */

  submit(body: Record<string, unknown>): { created: boolean; order: ServiceOrderView } {
    const key = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : ''
    if (key === '' || key.length > 128)
      throw new StandInServiceError(400, 'invalid_input', '幂等键要 1–128 个字符')
    const prior = this.byKey.get(key)
    if (prior !== undefined) return { created: false, order: this.view(prior) }
    const service = this.services.find((s) => s.id === body.service_id)
    if (service === undefined) throw new StandInServiceError(404, 'not_found', '没有这项服务')
    if (!service.available)
      throw new StandInServiceError(409, 'conflict', service.reason ?? '这项服务现在接不了单')
    const id = this.options.newId('svo')
    const at = this.now()
    let lines: ServiceOrderLineView[] | undefined
    let requirements: ServiceRequirementAnswer[] | undefined
    let total: number | undefined
    if (service.kind === 'standard') {
      const check = normalizeServiceLines(service, body.lines)
      if (!check.ok) throw new StandInServiceError(400, 'invalid_input', check.message)
      lines = check.lines
      total = check.total_credits
    } else {
      const check = normalizeServiceRequirements(service, body.requirements)
      if (!check.ok) throw new StandInServiceError(400, 'invalid_input', check.message)
      requirements = check.requirements
      if (service.pricing_mode !== 'quote') total = service.price_credits ?? 0
    }
    const status: ServiceOrderStatus = total === undefined ? 'quote_requested' : 'paid'
    if (total !== undefined) this.charge(id, total)
    const view: ServiceOrderView = {
      id,
      service_id: service.id,
      kind: service.kind,
      label_zh: service.label_zh,
      label_en: service.label_en,
      status,
      provider_label: service.provider_label,
      ...(lines === undefined ? {} : { lines }),
      ...(requirements === undefined ? {} : { requirements }),
      ...(total === undefined ? {} : { total_credits: total }),
      escrow_credits: total ?? 0,
      settled_credits: 0,
      refunded_credits: 0,
      revisions_left: service.revisions,
      respond_by:
        status === 'paid'
          ? this.plus(service.promise.accept_hours)
          : this.plus(service.promise.quote_hours ?? 48),
      deliverables: [],
      acceptances: [],
      message_count: 0,
      actions: [],
      created_at: at,
      updated_at: at,
    }
    const rec: OrderRecord = { view, key, service, messages: [], segment: 0 }
    if (service.kind === 'custom' && total !== undefined) this.splitMilestones(rec, total)
    this.orders.set(id, rec)
    this.byKey.set(key, id)
    return { created: true, order: this.view(id) }
  }

  list(status: string | null): ServiceOrderList {
    if (this.options.autopilot === true)
      for (const r of this.orders.values()) {
        try {
          this.autopilotStep(r)
        } catch {
          // 推不动就停在这一步
        }
      }
    const all = [...this.orders.values()].map((r) => this.view(r.view.id))
    const orders =
      status === 'all'
        ? all.slice(-100)
        : all.filter((o) => !SERVICE_ORDER_TERMINAL_STATUSES.includes(o.status))
    return { orders: orders.reverse(), at: this.now() }
  }

  get(id: string): ServiceOrderView {
    return this.view(this.rec(id).view.id)
  }

  acceptQuote(id: string): ServiceOrderView {
    const r = this.rec(id)
    // 一单最多扣一次：已经付过（重发 / 点两次）就回那一单
    if (r.view.status !== 'quoted' && r.view.quote !== undefined && r.view.escrow_credits > 0)
      return this.view(id)
    // 先看走不走得通、钱够不够，再动状态（积分不够 402 时这一单原样停在「已报价」）
    if (serviceOrderTransition(r.view.status, 'accept_quote', 'user') === undefined)
      throw new StandInServiceError(409, 'conflict', '这一单现在不能这样做。')
    const quote = r.view.quote as ServiceQuote
    this.charge(id, quote.credits)
    this.step(r, 'accept_quote', 'user')
    r.view.total_credits = quote.credits
    r.view.escrow_credits = quote.credits
    r.view.respond_by = this.plus(r.service.promise.accept_hours)
    this.splitMilestones(r, quote.credits, quote.milestones)
    return this.touch(r)
  }

  messages(id: string): { order_id: string; messages: ServiceOrderMessage[] } {
    const r = this.rec(id)
    return { order_id: id, messages: r.messages.map((m) => ({ ...m })) }
  }

  postMessage(id: string, body: Record<string, unknown>): ServiceOrderMessage {
    const r = this.rec(id)
    if (r.view.kind !== 'custom')
      throw new StandInServiceError(409, 'conflict', '标准件没有消息串（不用沟通）。')
    if (SERVICE_ORDER_TERMINAL_STATUSES.includes(r.view.status))
      throw new StandInServiceError(409, 'conflict', '这一单已经结束了。')
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text === '' || text.length > 4000)
      throw new StandInServiceError(400, 'invalid_input', '消息要 1–4000 个字')
    const msg = this.pushMessage(r, 'user', 'text', text)
    if (r.view.status === 'waiting_user') {
      this.step(r, 'user_reply', 'user')
      delete r.view.waiting_for
    }
    this.touch(r)
    return msg
  }

  contact(id: string, body: Record<string, unknown>): ServiceOrderView {
    const r = this.rec(id)
    const ex = r.view.contact
    if (ex === undefined || ex.id !== body.request_id)
      throw new StandInServiceError(404, 'not_found', '没有这个交换联系方式的请求')
    if (ex.status !== 'pending') return this.view(id)
    const at = this.now()
    if (body.accept === true) {
      const c = (body.contact ?? {}) as Partial<ServiceContact>
      const kinds = ['wechat', 'phone', 'email']
      if (typeof c.kind !== 'string' || !kinds.includes(c.kind) || typeof c.value !== 'string')
        throw new StandInServiceError(400, 'invalid_input', '选一种联系方式并填上')
      const value = c.value.trim()
      if (value === '' || value.length > 120)
        throw new StandInServiceError(400, 'invalid_input', '联系方式要 1–120 个字')
      r.view.contact = {
        ...ex,
        status: 'accepted',
        answered_at: at,
        user_contact: { kind: c.kind as ServiceContact['kind'], value },
        ...(r.provider_contact === undefined ? {} : { provider_contact: r.provider_contact }),
      }
      this.pushMessage(r, 'system', 'status', '双方交换了联系方式。')
    } else {
      r.view.contact = { ...ex, status: 'declined', answered_at: at }
      this.pushMessage(r, 'system', 'status', '你没同意交换联系方式，接着在订单里沟通。')
    }
    return this.touch(r)
  }

  accept(id: string, by: 'user' | 'system' = 'user'): ServiceOrderView {
    const r = this.rec(id)
    const to = this.step(r, by === 'user' ? 'accept' : 'auto_accept', by)
    void to
    const at = this.now()
    const acceptance: ServiceAcceptance = { decision: 'accept', by, at }
    if (r.view.kind === 'standard') {
      // 按凭证里实际完成的件数结算，没做完的按件退
      let settle = 0
      for (const line of r.view.lines ?? []) {
        const done = Math.min(line.completed ?? line.quantity, line.quantity)
        settle = round4(settle + done * line.credits_per_unit)
      }
      this.settle(r, Math.min(settle, r.view.escrow_credits))
      if (r.view.escrow_credits > 0) this.refundOf(r, r.view.escrow_credits)
      r.view.status = 'completed'
    } else {
      const ms = r.view.milestones ?? []
      const cur = ms[r.segment]
      if (cur !== undefined) {
        cur.status = 'accepted'
        cur.accepted_at = at
        delete cur.auto_accept_at
        acceptance.milestone_id = cur.id
        this.settle(r, cur.credits)
      }
      const next = ms[r.segment + 1]
      if (next !== undefined) {
        r.segment += 1
        next.status = 'in_progress'
        r.view.status = 'in_progress'
        r.view.deliver_by = this.plus(r.view.quote?.deliver_hours ?? 240)
      } else r.view.status = 'completed'
    }
    delete r.view.auto_accept_at
    r.view.acceptances.push(acceptance)
    if (r.view.status === 'completed') this.finish(r)
    return this.touch(r)
  }

  revise(id: string, body: Record<string, unknown>): ServiceOrderView {
    const r = this.rec(id)
    if (r.view.status === 'delivered' && r.view.revisions_left <= 0)
      throw new StandInServiceError(409, 'conflict', '返工次数用完了，可以通过或者申请退款。')
    this.step(r, 'revise', 'user')
    r.view.revisions_left -= 1
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 2000) : undefined
    const cur = r.view.milestones?.[r.segment]
    if (cur !== undefined) {
      cur.status = 'in_progress'
      delete cur.auto_accept_at
    }
    delete r.view.auto_accept_at
    r.view.acceptances.push({
      decision: 'revise',
      by: 'user',
      at: this.now(),
      ...(cur === undefined ? {} : { milestone_id: cur.id }),
      ...(reason === undefined || reason === '' ? {} : { reason }),
    })
    if (reason !== undefined && reason !== '' && r.view.kind === 'custom')
      this.pushMessage(r, 'user', 'text', `要改：${reason}`)
    return this.touch(r)
  }

  dispute(id: string, body: Record<string, unknown>): ServiceOrderView {
    const r = this.rec(id)
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 2000) : ''
    if (reason === '') throw new StandInServiceError(400, 'invalid_input', '申请退款要写一句为什么')
    this.step(r, 'dispute', 'user')
    const at = this.now()
    r.view.dispute = { reason, opened_at: at }
    const cur = r.view.milestones?.[r.segment]
    r.view.acceptances.push({
      decision: 'dispute',
      by: 'user',
      at,
      reason,
      ...(cur === undefined ? {} : { milestone_id: cur.id }),
    })
    delete r.view.auto_accept_at
    return this.touch(r)
  }

  cancel(id: string): ServiceOrderView {
    const r = this.rec(id)
    this.step(r, 'cancel', 'user')
    if (r.view.escrow_credits > 0) this.refundOf(r, r.view.escrow_credits)
    for (const m of r.view.milestones ?? []) m.status = 'refunded'
    r.view.status = 'cancelled'
    this.finish(r)
    return this.touch(r)
  }

  /* ── 服务方 / 运营那一侧（测试、demo 直接调） ─────────────────────── */

  quote(
    id: string,
    q: { credits: number; deliver_hours: number; note?: string; milestones?: ServiceMilestone[] },
  ): ServiceOrderView {
    const r = this.rec(id)
    this.step(r, 'quote', 'operator')
    r.view.quote = {
      credits: q.credits,
      deliver_hours: q.deliver_hours,
      ...(q.milestones === undefined ? {} : { milestones: q.milestones }),
      ...(q.note === undefined ? {} : { note: q.note }),
      quoted_at: this.now(),
    }
    r.view.total_credits = q.credits
    delete r.view.respond_by
    this.pushMessage(r, 'system', 'status', `报价 ${q.credits} 积分。`)
    return this.touch(r)
  }

  take(id: string): ServiceOrderView {
    const r = this.rec(id)
    const from = r.view.status
    this.step(r, 'take', 'operator')
    delete r.view.respond_by
    delete r.view.waiting_for
    if (from === 'paid') {
      const hours = r.view.quote?.deliver_hours ?? r.service.promise.deliver_hours ?? 336
      r.view.deliver_by = this.plus(hours)
      const first = r.view.milestones?.[0]
      if (first !== undefined) first.status = 'in_progress'
      this.pushMessage(r, 'system', 'status', '接单了。')
    }
    return this.touch(r)
  }

  askUser(id: string, waiting_for: string): ServiceOrderView {
    const r = this.rec(id)
    this.step(r, 'ask_user', 'provider')
    r.view.waiting_for = waiting_for
    this.pushMessage(r, 'provider', 'need_input', waiting_for)
    return this.touch(r)
  }

  /** 服务方说一句（定制件）。 */
  say(id: string, text: string, kind: ServiceOrderMessage['kind'] = 'text'): ServiceOrderMessage {
    const r = this.rec(id)
    const msg = this.pushMessage(r, 'provider', kind, text)
    this.touch(r)
    return msg
  }

  requestContact(id: string, reason: string, provider: ServiceContact): ServiceContactExchange {
    const r = this.rec(id)
    if (r.view.kind !== 'custom')
      throw new StandInServiceError(409, 'conflict', '标准件不出联系方式。')
    r.provider_contact = provider
    r.view.contact = {
      id: this.options.newId('ctx'),
      reason,
      status: 'pending',
      requested_at: this.now(),
    }
    this.touch(r)
    return { ...r.view.contact }
  }

  deliver(
    id: string,
    input: {
      proof?: ServiceDeliveryProof
      deliverables?: Omit<ServiceDeliverable, 'delivered_at'>[]
    },
  ): ServiceOrderView {
    const r = this.rec(id)
    this.step(r, 'deliver', 'provider')
    const at = this.now()
    const auto = this.plus(r.service.auto_accept_hours)
    if (r.view.kind === 'standard') {
      const proof = input.proof ?? { links: [], screenshots: [], completed: [] }
      r.view.proof = proof
      for (const line of r.view.lines ?? []) {
        const done = proof.completed.find((c) => c.item_id === line.item_id)
        line.completed = Math.min(done?.quantity ?? line.quantity, line.quantity)
      }
    }
    const cur = r.view.milestones?.[r.segment]
    if (cur !== undefined) {
      cur.status = 'delivered'
      cur.delivered_at = at
      cur.auto_accept_at = auto
    }
    for (const d of input.deliverables ?? [])
      r.view.deliverables.push({
        ...d,
        ...(cur === undefined ? {} : { milestone_id: cur.id }),
        delivered_at: at,
      })
    r.view.auto_accept_at = auto
    this.pushMessage(
      r,
      'system',
      'status',
      cur === undefined ? '交付了。' : `「${cur.label_zh}」交付了。`,
    )
    return this.touch(r)
  }

  /** 到点自动通过（替真云的闹钟）。 */
  autoAccept(id: string): ServiceOrderView {
    return this.accept(id, 'system')
  }

  /** 没人接 / 没报价 / 超时没交付：没结算的全退。 */
  expire(id: string): ServiceOrderView {
    const r = this.rec(id)
    this.step(r, 'expire', 'system')
    if (r.view.escrow_credits > 0) this.refundOf(r, r.view.escrow_credits)
    for (const m of r.view.milestones ?? []) if (m.status !== 'accepted') m.status = 'refunded'
    r.view.status = 'expired'
    this.finish(r)
    return this.touch(r)
  }

  /** 运营判争议：全退 / 部分退 / 不退（P6：用户看得到一句理由）。 */
  resolve(
    id: string,
    resolution: 'full_refund' | 'partial_refund' | 'no_refund',
    note: string,
    refund_credits?: number,
  ): ServiceOrderView {
    const r = this.rec(id)
    this.step(r, 'resolve', 'operator')
    const cur = r.view.milestones?.[r.segment]
    const inReview = cur?.credits ?? r.view.escrow_credits
    const back =
      resolution === 'full_refund'
        ? inReview
        : resolution === 'partial_refund'
          ? Math.min(refund_credits ?? 0, inReview)
          : 0
    if (back > 0) this.refundOf(r, back)
    if (inReview - back > 0) this.settle(r, round4(inReview - back))
    if (cur !== undefined) cur.status = back >= inReview ? 'refunded' : 'accepted'
    // 没开始的段一律全退
    for (const m of (r.view.milestones ?? []).slice(r.segment + 1)) {
      this.refundOf(r, m.credits)
      m.status = 'refunded'
    }
    if (r.view.kind === 'standard' && r.view.escrow_credits > 0)
      this.refundOf(r, r.view.escrow_credits)
    r.view.dispute = {
      ...(r.view.dispute ?? { reason: '', opened_at: this.now() }),
      resolution,
      refund_credits: back,
      note,
      resolved_at: this.now(),
    }
    r.view.status = resolution === 'no_refund' ? 'completed' : 'refunded'
    this.finish(r)
    return this.touch(r)
  }

  /** demo 的自动驾驶：替服务方往前走一步（在等用户的那几步不动）。 */
  private autopilotStep(r: OrderRecord): void {
    const v = r.view
    if (r.auto === undefined) r.auto = {}
    const auto = r.auto
    if (v.status === 'quote_requested') {
      const base = r.service.from_credits ?? r.service.price_credits ?? 100
      this.quote(v.id, {
        credits: Math.round(base * 1.5),
        deliver_hours: r.service.promise.deliver_hours ?? 240,
        note: '按需求单报价（演示）',
      })
      return
    }
    if (v.status === 'paid') {
      this.take(v.id)
      if (v.kind === 'custom' && auto.said !== true) {
        auto.said = true
        this.say(v.id, '收到需求了。首页要不要放一段产品视频？')
      }
      return
    }
    if (v.status !== 'in_progress') return
    if (v.kind === 'custom' && auto.asked !== true) {
      auto.asked = true
      this.askUser(v.id, '上传 Logo 原图')
      return
    }
    const last = (v.milestones ?? []).length - 1
    const isLast = v.kind === 'standard' || r.segment >= last
    this.deliver(v.id, {
      ...(v.kind === 'standard'
        ? {
            proof: {
              links: ['https://demo.invalid/proof/1'],
              screenshots: [],
              completed: (v.lines ?? []).map((l) => ({ item_id: l.item_id, quantity: l.quantity })),
            },
          }
        : {
            deliverables: [
              isLast && r.service.landing === 'theme'
                ? {
                    type: 'platform_object' as const,
                    label: '新主题（未发布）',
                    ref: '100099',
                    url: 'https://demo.invalid/?preview_theme_id=100099',
                  }
                : {
                    type: 'link' as const,
                    label: '这一段的稿子',
                    url: 'https://demo.invalid/draft',
                  },
            ],
          }),
    })
  }

  /** demo / 测试：把交付物保留期挪近（看「快到期」的提醒）。 */
  setDeliverablesExpiry(id: string, at: Iso8601): void {
    this.rec(id).view.deliverables_expire_at = at
  }

  /* ── HTTP ─────────────────────────────────────────────────────── */

  /** `/v1/services*` 一跳；不是这几条路径回 `undefined`。 */
  handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
  ): { status: number; body: unknown } | undefined {
    const ok = (data: unknown, status = 200) => ({ status, body: { data } })
    try {
      if (method === 'GET' && path === '/v1/services') return ok(this.catalog())
      if (method === 'POST' && path === '/v1/services/intents') {
        this.intent(body)
        return ok({ ok: true }, 202)
      }
      if (path === '/v1/services/orders') {
        if (method === 'GET') return ok(this.list(query.get('status')))
        if (method === 'POST') {
          const out = this.submit(body)
          return ok(out.order, out.created ? 201 : 200)
        }
      }
      const m = /^\/v1\/services\/orders\/([^/]+)(?:\/([a-z-]+))?$/u.exec(path)
      if (m === null) return undefined
      const id = decodeURIComponent(m[1] as string)
      const sub = m[2]
      if (method === 'GET' && sub === undefined) return ok(this.get(id))
      if (method === 'GET' && sub === 'messages') return ok(this.messages(id))
      if (method !== 'POST') return undefined
      if (sub === 'accept-quote') return ok(this.acceptQuote(id))
      if (sub === 'messages') return ok(this.postMessage(id, body), 201)
      if (sub === 'contact') return ok(this.contact(id, body))
      if (sub === 'accept') return ok(this.accept(id))
      if (sub === 'revise') return ok(this.revise(id, body))
      if (sub === 'dispute') return ok(this.dispute(id, body))
      if (sub === 'cancel') return ok(this.cancel(id))
      return undefined
    } catch (err) {
      if (err instanceof StandInServiceError)
        return {
          status: err.status,
          body: {
            code: err.code,
            message: err.message,
            ...(err.details === undefined ? {} : { details: err.details }),
          },
        }
      throw err
    }
  }

  /* ── 内部 ─────────────────────────────────────────────────────── */

  private rec(id: string): OrderRecord {
    const r = this.orders.get(id)
    if (r === undefined) throw new StandInServiceError(404, 'not_found', '没有这一单')
    return r
  }

  private step(r: OrderRecord, action: ServiceOrderAction, by: ServiceOrderActor): void {
    const t = serviceOrderTransition(r.view.status, action, by)
    if (t === undefined)
      throw new StandInServiceError(409, 'conflict', '这一单现在不能这样做。', {
        status: r.view.status,
        action,
      })
    r.view.status = t.to[0] as ServiceOrderStatus
  }

  private charge(id: string, credits: number): void {
    const available = this.options.available()
    if (available < credits)
      throw new StandInServiceError(
        402,
        'insufficient_credits',
        `积分不够了：这一单要 ${credits} 积分，可用 ${available}。去"账号与积分"里充值后再试。`,
        { required: credits, available },
      )
    this.options.spend(credits)
    this.ledgerRows.push({
      capability: SERVICE_LEDGER_CAPABILITIES.escrow,
      order_id: id,
      credits,
      quantity: credits,
      at: this.now(),
    })
  }

  private settle(r: OrderRecord, credits: number): void {
    if (credits <= 0) return
    r.view.escrow_credits = round4(r.view.escrow_credits - credits)
    r.view.settled_credits = round4(r.view.settled_credits + credits)
    this.ledgerRows.push({
      capability: SERVICE_LEDGER_CAPABILITIES.complete,
      order_id: r.view.id,
      credits: 0,
      quantity: credits,
      at: this.now(),
    })
  }

  private refundOf(r: OrderRecord, credits: number): void {
    const back = Math.min(round4(credits), r.view.escrow_credits)
    if (back <= 0) return
    r.view.escrow_credits = round4(r.view.escrow_credits - back)
    r.view.refunded_credits = round4(r.view.refunded_credits + back)
    this.options.refund(back)
    this.ledgerRows.push({
      capability: SERVICE_LEDGER_CAPABILITIES.refund,
      order_id: r.view.id,
      credits: -back,
      quantity: back,
      at: this.now(),
    })
  }

  private splitMilestones(r: OrderRecord, total: number, custom?: ServiceMilestone[]): void {
    const ms = custom ??
      r.service.milestones ?? [
        { id: 'all', label_zh: '交付', label_en: 'Delivery', share_percent: 100 },
      ]
    const credits = serviceMilestoneCredits(total, ms)
    r.view.milestones = ms.map(
      (m, i): ServiceMilestoneView => ({ ...m, credits: credits[i] ?? 0, status: 'pending' }),
    )
  }

  private pushMessage(
    r: OrderRecord,
    from: ServiceOrderMessage['from'],
    kind: ServiceOrderMessage['kind'],
    text: string,
  ): ServiceOrderMessage {
    const msg: ServiceOrderMessage = {
      id: this.options.newId('svm'),
      from,
      kind,
      text,
      at: this.now(),
    }
    r.messages.push(msg)
    if (r.view.kind === 'custom') r.view.message_count = r.messages.length
    return msg
  }

  private finish(r: OrderRecord): void {
    const at = this.now()
    r.view.finished_at = at
    delete r.view.respond_by
    delete r.view.deliver_by
    delete r.view.waiting_for
    r.view.deliverables_expire_at = new Date(
      Date.parse(at) + SERVICE_ORDER_DEFAULTS.deliverable_retention_days * 24 * HOUR,
    ).toISOString()
  }

  private touch(r: OrderRecord): ServiceOrderView {
    r.view.updated_at = this.now()
    return this.view(r.view.id)
  }

  /** 给出去的那一份：下一步能做的按转移表算；订单结束后联系方式不再返回。 */
  private view(id: string): ServiceOrderView {
    const r = this.rec(id)
    const v = structuredClone(r.view)
    if (r.view.kind === 'standard') v.message_count = 0
    else v.message_count = r.messages.length
    v.actions = serviceOrderActions(v.status, 'user').filter(
      (a) => !(a === 'revise' && v.revisions_left <= 0),
    )
    if (SERVICE_ORDER_TERMINAL_STATUSES.includes(v.status) && v.contact !== undefined) {
      delete v.contact.provider_contact
      delete v.contact.user_contact
    }
    return v
  }
}
