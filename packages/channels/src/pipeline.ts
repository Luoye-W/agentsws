import type {
  ChannelAdapter,
  ChannelName,
  Clock,
  EventEnvelope,
  InboundEvent,
  InboundPipeline,
  KnownEventType,
  MaybePromise,
  MessagePart,
  ObjectRef,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { EXTERNAL_FENCE, sha256 } from '@agentsws/core'
import { isCustomerLetter } from './dead-letter-policy.js'
import { ChannelError } from './errors.js'
import {
  type AutoRequeuePolicy,
  autoRequeueDelayMs,
  backoffMs,
  DEFAULT_AUTO_REQUEUE,
  DEFAULT_LEASE_MS,
  DEFAULT_RETRY,
  type DeadLetterRecord,
  laneOf,
  MemoryQueueStore,
  type QueueItem,
  type QueueStore,
  type RetryPolicy,
} from './queue.js'
import type { RawStore } from './raw-store.js'
import { scrubSecrets } from './secrets.js'

/** 事件出口：结构上兼容 `EventLog.append`，所以内核的事件日志可以直接传进来。 */
export interface ChannelEventSink {
  append(e: Omit<EventEnvelope<KnownEventType, unknown>, 'id' | 'at'>): MaybePromise<unknown>
}

export interface RouteInput {
  channel: ChannelName
  workspace_id: WorkspaceId
  actor_external_id?: string
  subject?: string
  /** 已脱敏、未围栏的正文（路由器是我们自己的代码，不是模型） */
  text: string
  /** WP55 / 48 §4 L3 #2：渠道细分（`amazon`）。传输层仍是邮件，收信岗位不是。 */
  sub_channel?: string
  /** WP55：渠道细分的判定结果（路由器只读，不改）。 */
  channel_meta?: Record<string, unknown>
}

export interface RouteResult {
  role_id?: RoleId
  work_item_id?: string
  confidence: number
}

/**
 * WP55 / 48 §4 L3 #2：Amazon 买家消息的收信岗位。
 *
 * 它跟普通 DTC 售后**不是同一条职责**：Amazon 的社区规范、24h 响应率考核、
 * relay 地址回信都只对这条岗位成立，落错岗位 = 出站硬闸那一层根本不会被调用。
 */
export const AMAZON_ROLE_ID: RoleId = 'amz.support'

/**
 * 默认路由（06 §2.4 同一路由器的 v1 形态）：按渠道映射到职责。
 * 邮件 = 英文客服邮件全接管的入口，落 `dtc.support`（WP54 合并售前售后）；
 * 判定成 Amazon 的那一份落 `amz.support`（WP55）。
 */
export function defaultRoute(input: RouteInput): RouteResult {
  if (input.sub_channel === 'amazon') return { role_id: AMAZON_ROLE_ID, confidence: 0.9 }
  if (input.channel === 'email') return { role_id: 'dtc.support', confidence: 0.6 }
  return { confidence: 0 }
}

/** 去重表里一条：什么时候见过、见过的是哪条事件。 */
export interface Seen {
  at_ms: number
  event: InboundEvent
}

export interface DedupeStore {
  get(key: string): MaybePromise<Seen | undefined>
  set(key: string, seen: Seen): MaybePromise<void>
  /** 丢弃窗口外的记录 */
  prune(before_ms: number): MaybePromise<void>
}

export class MemoryDedupeStore implements DedupeStore {
  private readonly seen = new Map<string, Seen>()

  get(key: string): Seen | undefined {
    return this.seen.get(key)
  }

  set(key: string, seen: Seen): void {
    this.seen.set(key, seen)
  }

  prune(before_ms: number): void {
    for (const [k, v] of this.seen) if (v.at_ms < before_ms) this.seen.delete(k)
  }

  get size(): number {
    return this.seen.size
  }
}

export interface ChannelInboundPipelineOptions {
  clock: Clock
  /** 按 `name` 分派；同名后者覆盖前者 */
  adapters: readonly ChannelAdapter[]
  workspace_id?: WorkspaceId
  events?: ChannelEventSink
  /** 有它才能在发现秘密后兜底洗一遍受控原始材料区 */
  rawStore?: RawStore
  resolveActor?: (external_id: string) => MaybePromise<ObjectRef | undefined>
  resolveThread?: (external_id: string) => MaybePromise<ObjectRef | undefined>
  route?: (input: RouteInput) => MaybePromise<RouteResult | undefined>
  /** 触发一跳：生成 RunRequest / 注入工作项。抛异常即触发重试 */
  onEvent?: (event: InboundEvent) => MaybePromise<void>
  dedupe?: DedupeStore
  /** 去重窗口，默认 24h */
  dedupe_window_ms?: number
  queue?: QueueStore
  /** 领取一条入站消息的租约时长；领取方崩了，过了它这条自动回到可领取状态 */
  lease_ms?: number
  retry?: Partial<RetryPolicy>
  /** WP210：死信自动重投的退避（缺省 30 分钟 → 2 小时 → 8 小时 → 24 小时，四轮后放弃）。 */
  auto_requeue?: Partial<AutoRequeuePolicy>
  raw_secret_policy?: 'redact' | 'keep'
  /** 解析不到发件人身份就直接进死信（默认 false：陌生客户首封邮件是常态） */
  dead_letter_on_unresolved_actor?: boolean
  /** 正文进围栏前的截断上限 */
  max_text_chars?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 入站管线（18 §2.2）：
 * 去重 → 围栏 + 秘密检测 → 解析 → 路由 → 排队（退避重试 / 死信）→ 触发。
 *
 * 两条纪律与替身实现（`stand-ins/inbound.ts`）逐字一致：
 * ① `parts.text` 出管线时已在 `EXTERNAL_FENCE` 里，运行时与执行器都不再信任外部文本；
 * ② 秘密在进事件之前就换成占位符，原文（去秘密后）只留在 `raw_ref`。
 */
export class ChannelInboundPipeline implements InboundPipeline {
  private readonly clock: Clock
  private readonly adapters = new Map<ChannelName, ChannelAdapter>()
  private readonly workspace: WorkspaceId
  private readonly events: ChannelEventSink | undefined
  private readonly rawStore: RawStore | undefined
  private readonly resolveActor:
    | ((external_id: string) => MaybePromise<ObjectRef | undefined>)
    | undefined
  private readonly resolveThread:
    | ((external_id: string) => MaybePromise<ObjectRef | undefined>)
    | undefined
  private readonly router: (input: RouteInput) => MaybePromise<RouteResult | undefined>
  private readonly onEvent: ((event: InboundEvent) => MaybePromise<void>) | undefined
  private readonly dedupeStore: DedupeStore
  private readonly windowMs: number
  private readonly queue: QueueStore
  private readonly retry: RetryPolicy
  private readonly autoRequeue: AutoRequeuePolicy
  private readonly leaseMs: number
  private readonly rawSecretPolicy: 'redact' | 'keep'
  private readonly deadLetterOnUnresolvedActor: boolean
  private readonly maxTextChars: number | undefined
  private readonly accepted: InboundEvent[] = []
  private seq = 0

  constructor(opts: ChannelInboundPipelineOptions) {
    this.clock = opts.clock
    for (const a of opts.adapters) this.adapters.set(a.name, a)
    this.workspace = opts.workspace_id ?? 'ws_local'
    this.events = opts.events
    this.rawStore = opts.rawStore
    this.resolveActor = opts.resolveActor
    this.resolveThread = opts.resolveThread
    this.router = opts.route ?? defaultRoute
    this.onEvent = opts.onEvent
    this.dedupeStore = opts.dedupe ?? new MemoryDedupeStore()
    this.windowMs = opts.dedupe_window_ms ?? DAY_MS
    this.queue = opts.queue ?? new MemoryQueueStore()
    this.retry = { ...DEFAULT_RETRY, ...opts.retry }
    this.autoRequeue = { ...DEFAULT_AUTO_REQUEUE, ...opts.auto_requeue }
    this.leaseMs = opts.lease_ms ?? DEFAULT_LEASE_MS
    this.rawSecretPolicy = opts.raw_secret_policy ?? 'redact'
    this.deadLetterOnUnresolvedActor = opts.dead_letter_on_unresolved_actor ?? false
    this.maxTextChars = opts.max_text_chars
  }

  /** 一条入站消息走完六步。同一 `dedupe_key` 在窗口内重复投递只产出一条事件。 */
  async ingest(
    channel: ChannelName,
    raw: unknown,
    workspace_id: WorkspaceId,
  ): Promise<{ event?: InboundEvent; deduped: boolean }> {
    const adapter = this.adapters.get(channel)
    if (adapter === undefined) {
      throw new ChannelError('invalid_input', `没有注册 ${channel} 渠道适配器`, { channel })
    }
    const ws = workspace_id.length > 0 ? workspace_id : this.workspace
    const head = await adapter.toInbound(raw, ws)
    const now = this.clock.now()
    const now_ms = Date.parse(now)

    // ① 去重（24h 窗口）
    await this.dedupeStore.prune(now_ms - this.windowMs)
    const prior = await this.dedupeStore.get(head.dedupe_key)
    if (prior !== undefined && now_ms - prior.at_ms < this.windowMs) {
      await this.emit('inbound.deduped', prior.event, { dedupe_key: head.dedupe_key })
      return { event: prior.event, deduped: true }
    }

    // ② 围栏 + 秘密检测：秘密先换占位符，再整段进 EXTERNAL_FENCE
    const rules: string[] = []
    const parts: MessagePart[] = head.parts.map((p) => {
      if (p.type !== 'text') return p
      const scrubbed = scrubSecrets(p.text)
      for (const r of scrubbed.rules) if (!rules.includes(r)) rules.push(r)
      const clipped =
        this.maxTextChars === undefined ? scrubbed.text : scrubbed.text.slice(0, this.maxTextChars)
      return { type: 'text', text: EXTERNAL_FENCE.fencePayload(clipped) }
    })
    const secrets_scrubbed = rules.length > 0
    if (secrets_scrubbed && this.rawSecretPolicy === 'redact') {
      // 兜底：适配器若把原始 MIME 原样落了受控区，这里再洗一遍（幂等）
      await this.rawStore?.scrub?.(head.raw_ref, (t) => scrubSecrets(t).text)
    }

    // ③ 解析（客户 / 线程）
    const actorResolved =
      head.actor === undefined ? undefined : await this.resolveActor?.(head.actor.external_id)
    const threadResolved =
      head.thread === undefined ? undefined : await this.resolveThread?.(head.thread.external_id)

    // ④ 路由
    const plainText = head.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => scrubSecrets(p.text).text)
      .join('\n')
    const routed = await this.router({
      channel,
      workspace_id: ws,
      text: plainText,
      ...(head.actor === undefined ? {} : { actor_external_id: head.actor.external_id }),
      // WP55：渠道细分先于路由（判定不花积分），路由器据它落到 `amz.support`
      ...(head.sub_channel === undefined ? {} : { sub_channel: head.sub_channel }),
      ...(head.channel_meta === undefined ? {} : { channel_meta: head.channel_meta }),
    })

    this.seq += 1
    const event: InboundEvent = {
      ...head,
      id: `in_${this.seq}_${sha256(head.dedupe_key).slice(0, 8)}`,
      workspace_id: ws,
      parts,
      routing: routed ?? { confidence: 0 },
      secrets_scrubbed,
      ...(head.actor === undefined
        ? {}
        : {
            actor: {
              ...head.actor,
              ...(actorResolved === undefined ? {} : { resolved: actorResolved }),
            },
          }),
      ...(head.thread === undefined
        ? {}
        : {
            thread: {
              ...head.thread,
              ...(threadResolved === undefined ? {} : { resolved: threadResolved }),
            },
          }),
    }
    await this.dedupeStore.set(event.dedupe_key, { at_ms: now_ms, event })
    await this.emit('inbound.received', event, {
      dedupe_key: event.dedupe_key,
      secrets_scrubbed,
      ...(rules.length === 0 ? {} : { secret_rules: rules }),
    })

    // 解析 / 路由不成 → 直接进 owner 车道的死信，不占重试预算
    const unresolvedActor = this.deadLetterOnUnresolvedActor && actorResolved === undefined
    if (event.routing.role_id === undefined || unresolvedActor) {
      await this.toDeadLetter(
        event,
        unresolvedActor ? 'actor_unresolved' : 'no_route',
        event.routing.role_id,
      )
      return { event, deduped: false }
    }

    // ⑤ 排队 + ⑥ 触发（首次尝试就地做，失败转退避重试）
    const item: QueueItem = {
      id: `q_${event.id}`,
      lane: laneOf(ws, event.routing.role_id),
      workspace_id: ws,
      event,
      attempts: 0,
      next_at_ms: now_ms,
      ...(event.routing.role_id === undefined ? {} : { role_id: event.routing.role_id }),
    }
    await this.queue.put(item)
    await this.attempt(item)
    return { event, deduped: false }
  }

  /**
   * 推一轮到期的重试（宿主的定时器调用；时间经 Clock，测试用假时钟推进）。
   * 领取带租约：同一条不会被两个 pump 同时处理；领取方崩了，租约到期后它回到队列。
   */
  async pump(): Promise<number> {
    const now_ms = Date.parse(this.clock.now())
    const due = await this.queue.claim(now_ms, this.leaseMs)
    let handled = 0
    for (const item of due) {
      await this.attempt(item)
      handled += 1
    }
    return handled
  }

  async deadLetters(workspace_id: WorkspaceId): Promise<InboundEvent[]> {
    return (await this.queue.deadLetters(workspace_id)).map((d) => d.event)
  }

  /** 死信的完整记录（原因 / 尝试次数 / 最后一次错误），工作台要展示的就是这个。 */
  async deadLetterRecords(workspace_id: WorkspaceId): Promise<DeadLetterRecord[]> {
    const records = await this.queue.deadLetters(workspace_id)
    if (this.queue.deadLetterRetry === undefined) return records
    const out: DeadLetterRecord[] = []
    for (const record of records) {
      const retry = await this.queue.deadLetterRetry(record.id)
      out.push(retry === undefined ? record : { ...record, retry })
    }
    return out
  }

  /** WP210：这条死信下一次自动重投的时刻（epoch ms）；不会再自动重投了回 `undefined`。 */
  nextAutoRequeueAt(record: DeadLetterRecord): number | undefined {
    if (record.reason !== 'retries_exhausted') return undefined
    const rounds = record.retry?.rounds ?? 0
    if (record.retry?.gave_up === true || rounds >= this.autoRequeue.max_rounds) return undefined
    return record.at_ms + autoRequeueDelayMs(rounds, this.autoRequeue)
  }

  /**
   * WP210（Luoye 09-30）：失败的信**自动**重投，不再要人一封封点。
   *
   * 宿主每一拍（收信那一轮）调一次。只管这条管线认得的渠道；每条死信：
   * - 原因是 `retries_exhausted`（触发那一跳一直抛错，多半是我们的 bug 或上游抽风）→
   *   按退避自动重投：死了 30 分钟后第一轮，再死 2 小时后第二轮…… 四轮还死就**放弃**；
   * - **换了版本**（`release` 与上一轮不同，多半是修好了）→ 轮数从头数、立刻再投一次，
   *   放弃过的也再给一次机会；
   * - 原因是 `no_route` / `actor_unresolved`（路由判定，重投不会重新路由）→ 直接放弃。
   *
   * 放弃的只进后台日志（`inbound.dead_letter_gave_up`，诊断页能翻、能手动重投）；
   * 返回的 `gave_up` 里标了 `customer` 的，宿主给人出一张提醒卡——只有**客户来信**
   * 才值得打扰人（`isCustomerLetter`）。存储层没实现重投进度的，什么都不做（老行为）。
   */
  async sweepDeadLetters(
    opts: { release?: string } = {},
  ): Promise<{ requeued: string[]; gave_up: Array<DeadLetterRecord & { customer: boolean }> }> {
    const out = {
      requeued: [] as string[],
      gave_up: [] as Array<DeadLetterRecord & { customer: boolean }>,
    }
    const store = this.queue
    if (store.deadLetterRetry === undefined || store.setDeadLetterRetry === undefined) return out
    const now_ms = Date.parse(this.clock.now())
    for (const record of await store.deadLetters(this.workspace)) {
      if (!this.adapters.has(record.event.channel)) continue
      const state = await store.deadLetterRetry(record.id)
      const retriable = record.reason === 'retries_exhausted'
      const newRelease =
        opts.release !== undefined && state?.release !== undefined && state.release !== opts.release
      if (retriable && (newRelease || state?.gave_up !== true)) {
        const rounds = newRelease ? 0 : (state?.rounds ?? 0)
        const due =
          newRelease ||
          (rounds < this.autoRequeue.max_rounds &&
            now_ms >= record.at_ms + autoRequeueDelayMs(rounds, this.autoRequeue))
        if (due) {
          await store.setDeadLetterRetry(record.id, {
            rounds: rounds + 1,
            last_at_ms: now_ms,
            ...(opts.release === undefined ? {} : { release: opts.release }),
            ...(state?.notified === true ? { notified: true } : {}),
          })
          const done = await this.requeueDeadLetter(record.id, { auto: true, round: rounds + 1 })
          if (done.requeued) out.requeued.push(record.id)
          continue
        }
        if (rounds < this.autoRequeue.max_rounds) continue
      }
      if (state?.gave_up === true) continue
      // 彻底投不进：记一笔、只给客户来信出卡（每条最多一张）
      const customer = isCustomerLetter(record.event)
      await store.setDeadLetterRetry(record.id, {
        rounds: state?.rounds ?? 0,
        last_at_ms: state?.last_at_ms ?? now_ms,
        ...(state?.release === undefined ? {} : { release: state.release }),
        gave_up: true,
        ...(customer || state?.notified === true ? { notified: true } : {}),
      })
      await this.emit('inbound.dead_letter_gave_up', record.event, {
        dead_letter_id: record.id,
        reason: record.reason,
        rounds: state?.rounds ?? 0,
        customer,
      })
      if (state?.notified !== true) out.gave_up.push({ ...record, customer })
    }
    return out
  }

  /**
   * WP55 / 18 §2.2：把一条死信**重投**回队列。
   *
   * 09-12 的真账号验收里，三封信死在 `canonicalJson` 的 bug 上，修好之后只能手改
   * SQLite 把它们放回队列——这就是那次留下的后置项。
   *
   * 重投会让这条消息重新起一次 Run（会写草稿；对外发送照旧要过审批）。WP55 时它只是人按的
   * 按钮；WP210（Luoye 09-30「应该自动重投，不该由用户手动」）起系统按退避自己投
   * （`sweepDeadLetters`），这个按钮只留在诊断页。重投成功就把死信记录删掉（它已经不是死信了）。
   */
  async requeueDeadLetter(
    id: string,
    /** WP210：自动重投那一路带上 `auto` 与第几轮，事件里分得清是人按的还是系统投的。 */
    opts: { auto?: boolean; round?: number } = {},
  ): Promise<{ requeued: boolean }> {
    const record = await this.queue.deadLetter?.(id)
    if (record === undefined) return { requeued: false }
    const now_ms = Date.parse(this.clock.now())
    const role_id = record.role_id ?? record.event.routing.role_id
    const item: QueueItem = {
      id: `q_${record.event.id}`,
      lane: laneOf(record.workspace_id, role_id),
      workspace_id: record.workspace_id,
      event: record.event,
      // 从头开始数：上一次是因为别的原因失败的，修好之后它值得一个完整的重试预算
      attempts: 0,
      next_at_ms: now_ms,
      ...(role_id === undefined ? {} : { role_id }),
    }
    await this.queue.put(item)
    await this.queue.removeDead?.(id)
    await this.emit('inbound.requeued', record.event, {
      dead_letter_id: id,
      reason: record.reason,
      attempts: record.attempts,
      ...(opts.auto === true ? { auto: true } : {}),
      ...(opts.round === undefined ? {} : { round: opts.round }),
    })
    await this.attempt(item)
    return { requeued: true }
  }

  /** 观察面：已成功触发的事件。 */
  delivered(): InboundEvent[] {
    return [...this.accepted]
  }

  /** 观察面：队列里还没成功的项。 */
  async pending(): Promise<QueueItem[]> {
    return this.queue.all()
  }

  private async attempt(item: QueueItem): Promise<void> {
    if (this.onEvent === undefined) {
      await this.queue.remove(item.id)
      this.accepted.push(item.event)
      return
    }
    try {
      await this.onEvent(item.event)
      await this.queue.remove(item.id)
      this.accepted.push(item.event)
    } catch (e) {
      const attempts = item.attempts + 1
      const detail = e instanceof Error ? e.message : String(e)
      if (attempts >= this.retry.max_attempts) {
        await this.queue.remove(item.id)
        await this.toDeadLetter(item.event, 'retries_exhausted', item.role_id, {
          attempts,
          last_error: detail,
        })
        return
      }
      // 退避重排：顺手清掉租约，这条立刻回到「等到期」而不是「有人在处理」
      const { lease_until_ms: _lease, ...rest } = item
      await this.queue.put({
        ...rest,
        attempts,
        next_at_ms: Date.parse(this.clock.now()) + backoffMs(attempts, this.retry),
        last_error: detail,
      })
    }
  }

  private async toDeadLetter(
    event: InboundEvent,
    reason: string,
    role_id: RoleId | undefined,
    extra?: { attempts?: number; last_error?: string },
  ): Promise<void> {
    // 18 §2.2：死信落盘并进 owner 车道，重启后还能翻
    await this.queue.putDead({
      id: `dl_${event.id}`,
      lane: laneOf(event.workspace_id, undefined),
      workspace_id: event.workspace_id,
      event,
      reason,
      attempts: extra?.attempts ?? 0,
      at_ms: Date.parse(this.clock.now()),
      ...(role_id === undefined ? {} : { role_id }),
      ...(extra?.last_error === undefined ? {} : { last_error: extra.last_error }),
    })
    await this.emit('inbound.dead_letter', event, {
      reason,
      lane: laneOf(event.workspace_id, undefined),
      ...(role_id === undefined ? {} : { intended_role_id: role_id }),
      ...extra,
    })
  }

  private async emit(
    type: KnownEventType,
    event: InboundEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.events === undefined) return
    await this.events.append({
      schema_version: 1,
      workspace_id: event.workspace_id,
      type,
      actor: { kind: 'system', id: `channel:${event.channel}` },
      subject: { type: 'message', id: event.id },
      correlation: { trace_id: `tr_${sha256(event.dedupe_key).slice(0, 16)}` },
      payload: {
        inbound_id: event.id,
        channel: event.channel,
        raw_ref: event.raw_ref,
        routing: event.routing,
        ...(event.actor === undefined ? {} : { actor_external_id: event.actor.external_id }),
        ...(event.thread === undefined ? {} : { thread_external_id: event.thread.external_id }),
        // WP55：渠道细分只记结论（marketplace / 消息类型 / 置信），正文永不进日志
        ...(event.sub_channel === undefined ? {} : { sub_channel: event.sub_channel }),
        ...(event.channel_meta === undefined ? {} : { channel_meta: event.channel_meta }),
        ...payload,
      },
    })
  }
}
