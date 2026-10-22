import type {
  AssignmentId,
  ChatMessage,
  Clock,
  Completion,
  CompletionUsage,
  Halt,
  ImageProvider,
  Iso8601,
  ModelGateway,
  ModelMeta,
  ModelProvider,
  ModelRef,
  ModelSourceSwitch,
  ModelSourceSwitchReason,
  ProviderNetTry,
  RoleId,
  ToolDef,
  Trace,
  TranscribeAudio,
  Transcription,
  TranscriptionAudioDigest,
  WorkspaceId,
} from '@agentsws/contracts'
import { NO_VISION_REASON } from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import { featureOf } from './feature.js'
import { unavailableImageProvider } from './images.js'
import type { BudgetCtx, CapSpec, Reservation } from './ledger.js'
import { BudgetLedger } from './ledger.js'
import { staticPrefixHash } from './prefix.js'
import {
  costOf,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  estimateCost,
  estimateInputTokens,
  priceFor,
  priceKey,
} from './pricing.js'
import { deepseekQuotaKindOf } from './providers/deepseek-quota.js'
import type { ModelSourceReloginPayload, SourceFallbackPolicy } from './source-fallback.js'
import {
  SOURCE_COOLDOWN,
  sourceChainMessage,
  sourceFallbackOffError,
  sourceLabelOf,
  sourceSwitchReasonOf,
  WORKSHOP_SOURCE_LABEL,
} from './source-fallback.js'
import type {
  BudgetExhaustedPayload,
  BudgetFrozenPayload,
  CompleteRequest,
  ModelEventSink,
  ModelEventType,
  ModelGatewayPolicy,
  ModelUsagePayload,
  ProviderDownPayload,
  UsageRecord,
} from './types.js'
import { GatewayError, isRetryableProviderError, ProviderError } from './types.js'
import { CANNOT_SEE_IMAGES_ZH, hasImagePart } from './vision-probe.js'

export interface ModelGatewayOptions {
  providers: ModelProvider[]
  policy: ModelGatewayPolicy
  clock: Clock
  eventSink: ModelEventSink
  /** 28 §1 急停；也认环境变量 AGENTSWS_MODEL_HALT=1。 */
  halt?: Halt
  env: Record<string, string | undefined>
  trace?: Trace
  /**
   * WP76（22 图片槽 / 58 §1）：图片能力。**可选**——不给就是"这台机器不出图"，
   * 调用方看 `gateway.images` 是不是 `undefined` 或 `available === false`，
   * 然后说人话（`NO_IMAGE_MODEL_ZH`），而不是显示一句"生成失败"。
   */
  images?: ImageProvider
}

export interface UsageReport {
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cost_base: number
  calls: number
}

export interface UsageFilter {
  workspace_id: WorkspaceId
  assignment_id?: AssignmentId
  role_id?: RoleId
  since?: Iso8601
  run_id?: string
  model?: string
}

/**
 * 22 ASR 槽的网关入参。`ref` 档由宿主解引用（受控原始材料区在 `@agentsws/meetings`，
 * 网关不认识它），所以到网关这里必须已经是字节。
 */
export interface TranscribeRequest extends Omit<TranscribeAudio, 'ref'> {
  bytes: Uint8Array
  max_cost_base?: number
  /** 覆盖预留时的预计输出 token 数（默认 0：ASR 的输出相对音频成本可忽略）。 */
  estimated_output_tokens?: number
}

/** WP179：一笔不经网关的模型调用（`ModelGatewayApi.recordExternal`）。 */
export interface ExternalUsage {
  meta: ModelMeta
  /** 实际打的是谁（例：`{ provider: 'deepseek-account', model: 'deepseek-v4-flash' }`）。 */
  model: ModelRef
  /** 拿得到就给；拿不到的项记 0。`cost_base` 一律 0（工坊不收这笔钱）。 */
  usage?: Partial<Omit<CompletionUsage, 'cost_base'>>
  duration_ms?: number
}

export interface ModelGatewayApi extends ModelGateway {
  complete(req: CompleteRequest): Promise<Completion>
  transcribe(req: TranscribeRequest, meta: ModelMeta, model?: ModelRef): Promise<Transcription>
  usage(filter: UsageFilter): Promise<UsageReport>
  /** 只读账目，测试与报表用（与 model.usage 事件一一对应）。 */
  records(): readonly UsageRecord[]
  /**
   * WP179：**不经网关的那一次模型调用**补记一笔（官方 `dsh-web-search-deepseek`：一次网页搜索 =
   * 一次完整的 DeepSeek 模型回合，但它直接打 DeepSeek，不经我们的 provider）。
   *
   * 记账口径与 `complete` 相同：进 `records()`、发一条 `model.usage`，用量页照 purpose 汇总看得到。
   * **不动预算**：这笔钱是用户自己的 DeepSeek 账号 / key 付的，工坊不扣积分；token 拿得到就记，
   * 拿不到（官方提供方不回报）就记 0——"调了一次"这件事照样看得见。可选方法：老的实现不用改。
   */
  recordExternal?(input: ExternalUsage): void
  /**
   * 换一套 provider / 策略（WP25 设置页「保存后立刻生效」）。
   *
   * 为什么是"换"而不是"重建一个网关"：**账不能丢**。预算的已花额度、并发预留、
   * usage 记录全在这个实例里；重建一个新网关等于把今天花的钱清零，
   * 三级预算（22 §3）当场失效。所以只替换配置，账原样留着。
   *
   * 22 §5「业务代码里没有 key」照旧：调用方给的是**装配好的 provider**，
   * key 怎么来（环境变量还是本机加密库）是装配方的事，网关不看值。
   */
  reconfigure(next: {
    providers?: ModelProvider[]
    policy?: ModelGatewayPolicy
    /**
     * WP127：换生图那一档（设置页「生图」那一块改完立刻生效）。
     * `null` = 退回装配时那一条（生产上是"没有图片模型"，demo 里是占位图）。
     */
    images?: ImageProvider | null
  }): void
  /** 现在挂着哪几个 provider（设置页要显示"当前生效的是谁"）。 */
  providers(): readonly ModelRef[]
}

const HALT_ENV = 'AGENTSWS_MODEL_HALT'

/** WP425：记几轮「这一轮切过了」（够一台机器同时在跑的那些；多了最旧的先忘）。 */
const SWITCHED_RUNS_KEPT = 500

/** WP430：来源顺序里的一跳。`workshop` = 工坊积分那一条。 */
interface SourceHop {
  ref: ModelRef
  workshop: boolean
}

/** WP430：换来的那一家报这些错时不再往下换——预算 / 急停是同一本账，换谁都一样。 */
function stopsChain(e: unknown): boolean {
  if (!(e instanceof GatewayError)) return false
  return e.code === 'budget_exhausted' || e.code === 'halted'
}

class Gateway implements ModelGatewayApi {
  /**
   * WP76（22 图片槽）：装配时给什么就是什么；**没给也有一条**——
   * {@link unavailableImageProvider}，它 `available: false` 并带一句
   * 人话（`NO_IMAGE_MODEL_ZH`）。
   *
   * 为什么不是 `undefined`：调用方要说的那句话（58 §1「没有就明说」）
   * 得有地方放。留成 `undefined` 的结果是每个调用点自己编一句"生成失败"。
   */
  private currentImages: ImageProvider
  private readonly initialImages: ImageProvider
  private readonly ledger: BudgetLedger
  private readonly usageRecords: UsageRecord[] = []

  constructor(private readonly opts: ModelGatewayOptions) {
    this.initialImages = opts.images ?? unavailableImageProvider()
    this.currentImages = this.initialImages
    this.ledger = new BudgetLedger(opts.policy.budget ?? {}, {
      onFrozen: (cap, used, ctx) => this.emitFrozen(cap, used, ctx),
      onRunExhausted: (used, cap, ctx) => this.emitRunExhausted(used, cap, ctx),
    })
  }

  /** 生图那一档。getter 而不是一格：`reconfigure({ images })` 之后下一次取就是新的。 */
  get images(): ImageProvider {
    return this.currentImages
  }

  // ---- 事件 ----

  private emit(type: ModelEventType, ctx: BudgetCtx, payload: unknown): void {
    this.opts.eventSink({
      schema_version: 1,
      workspace_id: ctx.workspace_id,
      type,
      at: this.opts.clock.now(),
      actor: { kind: 'agent', id: ctx.assignment_id, run_id: ctx.run_id },
      correlation: {
        trace_id: this.opts.trace?.newTraceId() ?? ctx.run_id,
        run_id: ctx.run_id,
      },
      payload,
    })
  }

  private emitFrozen(cap: CapSpec, used: number, ctx: BudgetCtx): void {
    const payload: BudgetFrozenPayload = {
      scope: cap.scope,
      period: cap.period,
      used_base: used,
      cap_base: cap.cap,
      ...(cap.assignment_id === undefined ? {} : { assignment_id: cap.assignment_id }),
    }
    this.emit('model.budget_frozen', ctx, payload)
  }

  private emitRunExhausted(used: number, cap: number, ctx: BudgetCtx): void {
    const payload: BudgetExhaustedPayload = {
      which: 'max_cost_base',
      used,
      cap,
      run_id: ctx.run_id,
    }
    this.emit('budget.exhausted', ctx, payload)
  }

  // ---- 急停 ----

  private assertNotHalted(): void {
    const byEnv = this.opts.env[HALT_ENV] === '1'
    const byApi = this.opts.halt?.isHalted('model') === true
    if (byEnv || byApi) {
      throw new GatewayError('halted', 'model calls halted', {
        by: byEnv ? 'env' : 'halt',
        scope: 'model',
      })
    }
  }

  // ---- 路由 ----

  private resolveRef(meta: ModelMeta, explicit?: ModelRef): ModelRef {
    return explicit ?? this.opts.policy.by_purpose?.[meta.purpose] ?? this.opts.policy.default
  }

  private findProvider(ref: ModelRef): ModelProvider {
    const exact = this.opts.providers.find((p) => priceKey(p.ref) === priceKey(ref))
    const byProvider = this.opts.providers.find((p) => p.ref.provider === ref.provider)
    const found = exact ?? byProvider
    if (found === undefined) {
      throw new GatewayError('invalid_input', 'no provider registered for model', {
        model: priceKey(ref),
      })
    }
    return found
  }

  private candidates(ref: ModelRef): ModelRef[] {
    const fallbacks = this.opts.policy.fallbacks
    const list = fallbacks?.[priceKey(ref)] ?? fallbacks?.['*'] ?? []
    return [ref, ...list]
  }

  // ---- 记账 ----

  private record(
    meta: ModelMeta,
    model: ModelRef,
    usage: CompletionUsage,
    at: Iso8601,
    staticPrefix: string,
    durationMs: number,
    audio?: TranscriptionAudioDigest,
    netRetries?: ProviderNetTry[],
  ): void {
    // WP473：哪个功能在用（用量页把「运行」按它拆开；显式给的优先，没给按 purpose / run_id 认）
    const feature = featureOf(meta)
    this.usageRecords.push({
      at,
      workspace_id: meta.workspace_id,
      assignment_id: meta.assignment_id,
      role_id: meta.role_id,
      run_id: meta.run_id,
      purpose: meta.purpose,
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_tokens: usage.cached_tokens,
      cost_base: usage.cost_base,
      feature,
    })
    const payload: ModelUsagePayload = {
      model,
      purpose: meta.purpose,
      assignment_id: meta.assignment_id,
      role_id: meta.role_id,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_tokens: usage.cached_tokens,
      cost_base: usage.cost_base,
      static_prefix_hash: staticPrefix,
      duration_ms: durationMs,
      feature,
      ...(usage.cache_write_tokens === undefined || usage.cache_write_tokens === 0
        ? {}
        : { cache_write_tokens: usage.cache_write_tokens }),
      // 21 §1「秘密从不进」的音频版：只记摘要，字节与转写正文永不进事件日志
      ...(audio === undefined ? {} : { audio }),
      // WP243：成了之前重发过——也记下来（「重发要看得见」）
      ...(netRetries === undefined || netRetries.length === 0 ? {} : { net_retries: netRetries }),
    }
    this.emit('model.usage', ctxOf(meta), payload)
  }

  private reserveFor(
    meta: ModelMeta,
    messages: ChatMessage[],
    tools: ToolDef[] | undefined,
    ref: ModelRef,
    at: Iso8601,
    runCap: number | undefined,
    expectedOutput: number | undefined,
  ): Reservation {
    const estimate = this.opts.policy.estimate ?? {}
    const price = priceFor(this.opts.policy.prices, ref)
    const inputTokens = estimateInputTokens(
      messages,
      tools,
      estimate.chars_per_token ?? DEFAULT_CHARS_PER_TOKEN,
    )
    const amount = estimateCost(
      price,
      inputTokens,
      expectedOutput ?? estimate.expected_output_tokens ?? DEFAULT_EXPECTED_OUTPUT_TOKENS,
    )
    return this.ledger.reserve({
      ctx: ctxOf(meta),
      at,
      amount,
      ...(runCap === undefined ? {} : { run_cap: runCap }),
    })
  }

  // ---- 契约实现 ----

  /**
   * WP425 / WP430：这一次走不走 AI 来源顺序。设置页「测试」那一次（测的就是这一家）不走；策略里没有这一格也不走。
   */
  private sourceFallbackFor(req: CompleteRequest): SourceFallbackPolicy | undefined {
    const fb = this.opts.policy.source_fallback
    if (fb === undefined || req.capability_probe === true) return undefined
    return fb
  }

  /**
   * WP430（决策 1288）：这一次的来源顺序——这次选的 → 自己配的其它（按「AI 来源」里排的顺序，同一家只算一次）
   * → 工坊积分（开关开着才有）。网关上没挂的那一家跳过（切过去也是「没注册」）。
   * `cloudOff` = 登录了工坊账号、但开关关着（排到最后都不行时，照实停下并出「用工坊积分接着做」那张卡）。
   */
  private sourceChain(
    fb: SourceFallbackPolicy,
    primary: ModelRef,
  ): { chain: SourceHop[]; cloudOff: boolean } {
    const registered = (provider: string): boolean =>
      this.opts.providers.some((p) => p.ref.provider === provider)
    const chain: SourceHop[] = [{ ref: primary, workshop: fb.to?.provider === primary.provider }]
    const has = (provider: string): boolean => chain.some((h) => h.ref.provider === provider)
    for (const ref of fb.own ?? []) {
      if (ref.provider === fb.to?.provider || has(ref.provider) || !registered(ref.provider))
        continue
      chain.push({ ref, workshop: false })
    }
    let cloudOff = false
    const cloud = fb.to
    if (cloud !== undefined && !has(cloud.provider) && registered(cloud.provider)) {
      if (fb.enabled) chain.push({ ref: cloud, workshop: true })
      else cloudOff = true
    }
    return { chain, cloudOff }
  }

  /** WP425：这一轮切过了（run_id → 切到的那一条）。只留最近的一批，旧的自然淘汰。 */
  private readonly switchedRuns = new Map<string, ModelRef>()

  private markSwitched(runId: string, to: ModelRef): void {
    this.switchedRuns.delete(runId)
    this.switchedRuns.set(runId, to)
    while (this.switchedRuns.size > SWITCHED_RUNS_KEPT) {
      const oldest = this.switchedRuns.keys().next().value
      if (oldest === undefined) break
      this.switchedRuns.delete(oldest)
    }
  }

  /**
   * WP430（决策 1290）：按来源记的连续失败与冷却（本机内存，重启清零；改了模型设置也清零——
   * 重新登录 / 换了 key 之后应当马上再试）。
   */
  private readonly sourceHealth = new Map<
    string,
    { fails: number; until?: number; reason: ModelSourceSwitchReason }
  >()

  /** WP430 / WP436：已经发过「要重新登录」/「key 用不了了」的来源（重新能用之前不再发）。 */
  private readonly reloginSent = new Set<string>()

  private nowMs(): number {
    const t = Date.parse(this.opts.clock.now())
    return Number.isNaN(t) ? Date.now() : t
  }

  private coolingDown(provider: string, now: number): ModelSourceSwitchReason | undefined {
    const h = this.sourceHealth.get(provider)
    return h?.until !== undefined && h.until > now ? h.reason : undefined
  }

  private noteSourceFailure(
    fb: SourceFallbackPolicy,
    provider: string,
    reason: ModelSourceSwitchReason,
    now: number,
  ): void {
    const rule = fb.cooldown ?? SOURCE_COOLDOWN
    const prev = this.sourceHealth.get(provider)
    const fails = (prev?.fails ?? 0) + 1
    // 到了次数就冷却；冷却过了再试一次还不行，马上再冷却一轮（不用重新攒两次）
    const until = fails >= rule.failures ? now + rule.ms : undefined
    this.sourceHealth.set(provider, { fails, reason, ...(until === undefined ? {} : { until }) })
  }

  private noteSourceOk(provider: string): void {
    this.sourceHealth.delete(provider)
    this.reloginSent.delete(provider)
  }

  /**
   * WP430（决策 1289）：登录类来源登录失效——发一次「要重新登录」；
   * WP436（决策 1316）：自带 API key 被拒——发一次「key 用不了了」。站内通知都接。
   */
  private maybeRelogin(
    fb: SourceFallbackPolicy,
    req: CompleteRequest,
    ref: ModelRef,
    reason: ModelSourceSwitchReason,
  ): void {
    if (reason !== 'auth') return
    const type = (fb.relogin ?? []).includes(ref.provider)
      ? ('model_source.relogin_needed' as const)
      : (fb.keys ?? []).includes(ref.provider)
        ? ('model_source.key_rejected' as const)
        : undefined
    if (type === undefined || this.reloginSent.has(ref.provider)) return
    this.reloginSent.add(ref.provider)
    const payload: ModelSourceReloginPayload = {
      provider: ref.provider,
      label: sourceLabelOf(fb, ref),
    }
    this.emit(type, ctxOf(req.meta), payload)
  }

  /**
   * 没得切（只有这一条）时也要认出「登录失效 / key 被拒」——照实报错之前先发提醒（WP436：以前这一路直接调，
   * 自带 key 失效了只有这一条来源的人收不到任何提醒）。
   */
  private async completeAlone(
    fb: SourceFallbackPolicy,
    req: CompleteRequest,
    ref: ModelRef,
  ): Promise<Completion> {
    try {
      const out = await this.completeOn(req, ref)
      this.noteSourceOk(ref.provider)
      return out
    } catch (e) {
      if (!isAborted(req.signal) && sourceSwitchReasonOf(e) === 'auth')
        this.maybeRelogin(fb, req, ref, 'auth')
      throw e
    }
  }

  async complete(req: CompleteRequest): Promise<Completion> {
    this.assertNotHalted()
    const primary = this.resolveRef(req.meta, req.model)
    const fb = this.sourceFallbackFor(req)
    if (fb === undefined) return this.completeOn(req, primary)
    const { chain, cloudOff } = this.sourceChain(fb, primary)
    if (chain.length === 1 && !cloudOff) return this.completeAlone(fb, req, primary)
    const runId = req.meta.run_id
    // 一轮里切过就用到底（不来回切）；下一轮 run_id 不同，自然先试原选
    const sticky = this.switchedRuns.get(runId)
    const at =
      sticky === undefined ? -1 : chain.findIndex((h) => priceKey(h.ref) === priceKey(sticky))
    const hops = at > 0 ? chain.slice(at) : chain
    // WP430（决策 1290）：冷却中的直接跳过；全都在冷却就照顺序都试（不至于一个都不试就停）
    const now = this.nowMs()
    const skipCooling = hops.some((h) => this.coolingDown(h.ref.provider, now) === undefined)
    const failed: { hop: SourceHop; reason: ModelSourceSwitchReason }[] = []
    let firstError: unknown
    for (const hop of hops) {
      const cooling = skipCooling ? this.coolingDown(hop.ref.provider, now) : undefined
      if (cooling !== undefined) {
        failed.push({ hop, reason: cooling })
        continue
      }
      /*
       * 这次选的那一家已经不在网关上了（DeepSeek 账号登录失效被摘掉、跑到一半删了那条 key…）：
       * 算「登录或 key 失效」，直接往下接，不再停下（决策 1289）
       */
      if (
        hop === hops[0] &&
        hops.length > 1 &&
        !this.opts.providers.some((p) => p.ref.provider === hop.ref.provider)
      ) {
        firstError ??= new GatewayError('invalid_input', 'no provider registered for model', {
          model: priceKey(hop.ref),
        })
        failed.push({ hop, reason: 'auth' })
        continue
      }
      // 已经往外吐过字的不切（换一家从头说会把两段拼在一起）
      let streamed = false
      const onDelta = req.on_delta
      const watched: CompleteRequest =
        onDelta === undefined
          ? req
          : {
              ...req,
              on_delta: (text: string) => {
                if (text !== '') streamed = true
                onDelta(text)
              },
            }
      try {
        const out = await this.completeOn(watched, hop.ref)
        this.noteSourceOk(hop.ref.provider)
        if (failed.length === 0) return out
        this.markSwitched(runId, hop.ref)
        const steps = failed.map((f) => ({ label: this.hopLabel(fb, f.hop), reason: f.reason }))
        const message = sourceChainMessage(
          steps,
          hop.workshop ? undefined : sourceLabelOf(fb, hop.ref),
        )
        const first = failed[0] as (typeof failed)[number]
        const source_switch: ModelSourceSwitch = {
          from: first.hop.ref,
          to: hop.ref,
          reason: first.reason,
          message,
          target: hop.workshop ? 'workshop' : 'own',
        }
        this.emit('model.source_switched', ctxOf(req.meta), source_switch)
        return { ...out, source_switch }
      } catch (e) {
        if (streamed || isAborted(req.signal)) throw e
        const reason = sourceSwitchReasonOf(e)
        if (reason === undefined) {
          // 第一跳的「请求本身不对 / 预算用完」照原样报；换来的那一家不认这次请求（比如看不了图）就再往下
          if (firstError === undefined || stopsChain(e)) throw e
          continue
        }
        firstError ??= e
        this.noteSourceFailure(fb, hop.ref.provider, reason, now)
        this.maybeRelogin(fb, req, hop.ref, reason)
        failed.push({ hop, reason })
      }
    }
    // 排到最后都不行
    const first = failed.find((f) => f.hop.ref.provider === primary.provider) ?? failed[0]
    if (cloudOff && first !== undefined) {
      const rest = failed
        .filter((f) => f !== first)
        .map((f) => ({ label: this.hopLabel(fb, f.hop), reason: f.reason }))
      throw sourceFallbackOffError(
        firstError ?? new GatewayError('provider_unavailable', 'all sources cooling down'),
        first.reason,
        first.hop.ref,
        this.hopLabel(fb, first.hop),
        rest,
      )
    }
    if (firstError !== undefined) throw firstError
    // 全在冷却里又都跳过了（不会走到：全在冷却时一个都不跳）——照原选再试一次
    return this.completeOn(req, primary)
  }

  /** 给人看的来源名：工坊积分那一条就叫工坊积分。 */
  private hopLabel(fb: SourceFallbackPolicy, hop: SourceHop): string {
    return hop.workshop ? WORKSHOP_SOURCE_LABEL : sourceLabelOf(fb, hop.ref)
  }

  private async completeOn(req: CompleteRequest, primary: ModelRef): Promise<Completion> {
    const { meta } = req
    const ctx = ctxOf(meta)
    const primaryProvider = this.findProvider(primary)
    const withImages = hasImagePart(req.messages)
    // WP127：声明了看不了图的模型，带图的请求在这里就拦下——不花钱、说人话。
    // 验证那一次（`capability_probe`）不拦：它问的正是"现在还看不看得了"。
    if (withImages && req.capability_probe !== true) {
      assertCanSee(primary, primaryProvider)
    }
    const staticPrefix = staticPrefixHash(req.messages, req.tools, req.cache_breakpoints)
    const startedAt = this.opts.clock.now()
    const reservation = this.reserveFor(
      meta,
      req.messages,
      req.tools,
      primary,
      startedAt,
      req.max_cost_base,
      // WP243：给了输出上限、没给预估的，按上限预留（不会比它多）
      req.estimated_output_tokens ?? req.max_output_tokens,
    )

    /*
     * WP188：流式与停止。`streamed` 是这一次已经交给调用方的正文——停下时它就是结果，
     * provider 不会流式时（没调过 `on_delta`）拿到整段之后补调一次。
     */
    let streamed = ''
    const onDelta =
      req.on_delta === undefined
        ? undefined
        : (text: string): void => {
            if (text === '') return
            streamed += text
            req.on_delta?.(text)
          }
    const stoppedCompletion = (ref: ModelRef): Completion => {
      const finishedAt = this.opts.clock.now()
      const cpt = this.opts.policy.estimate?.chars_per_token ?? DEFAULT_CHARS_PER_TOKEN
      const partial = {
        input_tokens: estimateInputTokens(req.messages, req.tools, cpt),
        output_tokens: Math.ceil(streamed.length / cpt),
        cached_tokens: 0,
      }
      const usage: CompletionUsage = {
        ...partial,
        cost_base: costOf(priceFor(this.opts.policy.prices, ref), partial),
      }
      this.ledger.settle(reservation, usage.cost_base)
      this.record(
        meta,
        ref,
        usage,
        finishedAt,
        staticPrefix,
        Math.max(Date.parse(finishedAt) - Date.parse(startedAt), 0),
      )
      return { text: streamed, usage, model: ref, static_prefix_hash: staticPrefix, stopped: true }
    }
    if (req.signal?.aborted === true) {
      // 还没发请求就停了：什么都没花，不记账
      this.ledger.release(reservation)
      return {
        text: '',
        usage: { ...ZERO_USAGE },
        model: primary,
        static_prefix_hash: staticPrefix,
        stopped: true,
      }
    }

    const attempts: ProviderDownPayload['attempts'] = []
    /*
     * WP150：provider 明说"要重新登录"（`unauthenticated`，例如 DeepSeek 账号登录失效）不是上游宕了——
     * 降级换一家救不回来，泛泛的 `all providers failed` 也说不清。记进 attempts 之后**原样**往上抛，
     * 运行的失败原因就是 provider 那句人话。WP151 的"DeepSeek 余额不足"同样走这条。
     */
    let signIn: GatewayError | undefined
    try {
      for (const ref of this.candidates(primary)) {
        let provider: ModelProvider
        try {
          provider = this.findProvider(ref)
          if (ref !== primary) {
            priceFor(this.opts.policy.prices, ref)
            // 降级到一个看不了图的备选，等于把图悄悄丢掉：跳过它
            if (withImages && req.capability_probe !== true) assertCanSee(ref, provider)
          }
        } catch (e) {
          attempts.push({ model: ref, message: messageOf(e) })
          continue
        }
        try {
          const call = provider.complete({
            messages: req.messages,
            ...(req.tools === undefined ? {} : { tools: req.tools }),
            ...(req.seed === undefined ? {} : { seed: req.seed }),
            // WP194：谁在调（官方接口那一条据此带上「谁 / 哪个岗位」）
            meta,
            // 22：provider 不声明原生支持就剥掉 tool_choice（退化为 auto），由运行时自己兜底
            ...(req.tool_choice === undefined || provider.supports_tool_choice !== true
              ? {}
              : { tool_choice: req.tool_choice }),
            ...(onDelta === undefined ? {} : { on_delta: onDelta }),
            ...(req.signal === undefined ? {} : { signal: req.signal }),
            // WP243：输出上限 / 关思考（只是提示，provider 认得才照做）
            ...(req.max_output_tokens === undefined
              ? {}
              : { max_output_tokens: req.max_output_tokens }),
            ...(req.thinking === undefined ? {} : { thinking: req.thinking }),
            // WP370：思考程度（provider 只认自己声明过的档）
            ...(req.reasoning_effort === undefined
              ? {}
              : { reasoning_effort: req.reasoning_effort }),
          })
          // WP188：停了就不再等上游（不会流式的 provider 也一样停得下来）
          const raw = req.signal === undefined ? await call : await untilAborted(call, req.signal)
          if (raw === STOPPED) return stoppedCompletion(ref)
          if (onDelta !== undefined && streamed === '' && raw.text !== '') req.on_delta?.(raw.text)
          const finishedAt = this.opts.clock.now()
          const usage: CompletionUsage = {
            input_tokens: raw.usage.input_tokens,
            output_tokens: raw.usage.output_tokens,
            cached_tokens: raw.usage.cached_tokens,
            cost_base: costOf(priceFor(this.opts.policy.prices, ref), raw.usage),
            // WP473：写缓存那部分（Anthropic 系）照带，记进用量
            ...(raw.usage.cache_write_tokens === undefined || raw.usage.cache_write_tokens === 0
              ? {}
              : { cache_write_tokens: raw.usage.cache_write_tokens }),
          }
          this.ledger.settle(reservation, usage.cost_base)
          this.record(
            meta,
            ref,
            usage,
            finishedAt,
            staticPrefix,
            Math.max(Date.parse(finishedAt) - Date.parse(startedAt), 0),
            undefined,
            raw.net_retries,
          )
          return {
            text: raw.text,
            ...(raw.tool_calls === undefined ? {} : { tool_calls: raw.tool_calls }),
            // 思考模型的推理内容要透传：运行时下一轮带回 provider（DeepSeek thinking 模式硬要求）
            ...(raw.reasoning === undefined ? {} : { reasoning: raw.reasoning }),
            // WP143：Messages 口的思考块（含签名）同样透传
            ...(raw.reasoning_replay === undefined
              ? {}
              : { reasoning_replay: raw.reasoning_replay }),
            usage,
            model: ref,
            static_prefix_hash: staticPrefix,
          }
        } catch (e) {
          // WP188：调用方停的——不算上游坏了，不降级、不报 provider_down
          if (isAborted(req.signal)) return stoppedCompletion(ref)
          if (e instanceof ProviderError && e.tries !== undefined && e.tries.length > 0) {
            // WP243：provider 内部重发过——每一次单独一条（错误码 + 耗时），看得出重没重发、各断在哪
            for (const t of e.tries) {
              attempts.push({
                model: ref,
                ...(t.status === undefined ? {} : { status: t.status }),
                message: t.message,
                ...(t.code === undefined ? {} : { code: t.code }),
                duration_ms: t.duration_ms,
              })
            }
          } else {
            attempts.push({
              model: ref,
              ...(e instanceof ProviderError && e.status !== undefined ? { status: e.status } : {}),
              message: messageOf(e),
            })
          }
          // WP151：DeepSeek 余额不足同理——换一家救不回来，也不该悄悄换模型；原样往上抛
          // WP194：官方接口说「本月额度用完了 / 公司积分用完了」也一样——换一家救不回来，原样那句人话往上抛
          // WP362：ChatGPT 订阅被限流（`rate_limited`）同理——换一家等于悄悄换模型，照实那句人话往上抛
          if (
            e instanceof GatewayError &&
            (e.code === 'unauthenticated' ||
              e.code === 'rate_limited' ||
              e.code === 'budget_exhausted' ||
              deepseekQuotaKindOf(e) !== undefined)
          ) {
            signIn = e
            break
          }
          if (!isRetryableProviderError(e)) break
          // 已经往外吐过字了：换一家从头说会把两段拼在一起，不如照实报错
          if (streamed !== '') break
        }
      }
    } catch (e) {
      this.ledger.release(reservation)
      throw e
    }
    this.ledger.release(reservation)
    const payload: ProviderDownPayload = { model: primary, attempts }
    this.emit('model.provider_down', ctx, payload)
    if (signIn !== undefined) throw signIn
    throw new GatewayError('provider_unavailable', 'all providers failed', payload)
  }

  async embed(
    texts: string[],
    meta: ModelMeta,
    model?: ModelRef,
  ): Promise<{ vectors: number[][]; usage: CompletionUsage }> {
    this.assertNotHalted()
    const ctx = ctxOf(meta)
    const ref = this.resolveRef(meta, model)
    const provider = this.findProvider(ref)
    if (provider.embed === undefined) {
      throw new GatewayError('invalid_input', 'provider does not support embed', {
        model: priceKey(ref),
      })
    }
    const messages: ChatMessage[] = texts.map((t) => ({ role: 'user', content: t }))
    const startedAt = this.opts.clock.now()
    const reservation = this.reserveFor(meta, messages, undefined, ref, startedAt, undefined, 0)
    let raw: { vectors: number[][]; usage: CompletionUsage }
    try {
      raw = await provider.embed(texts, meta)
    } catch (e) {
      this.ledger.release(reservation)
      const payload: ProviderDownPayload = {
        model: ref,
        attempts: [{ model: ref, message: messageOf(e) }],
      }
      this.emit('model.provider_down', ctx, payload)
      throw new GatewayError('provider_unavailable', 'embed provider failed', payload)
    }
    const finishedAt = this.opts.clock.now()
    const usage: CompletionUsage = {
      input_tokens: raw.usage.input_tokens,
      output_tokens: raw.usage.output_tokens,
      cached_tokens: raw.usage.cached_tokens,
      cost_base: costOf(priceFor(this.opts.policy.prices, ref), raw.usage),
    }
    this.ledger.settle(reservation, usage.cost_base)
    this.record(
      meta,
      ref,
      usage,
      finishedAt,
      '',
      Math.max(Date.parse(finishedAt) - Date.parse(startedAt), 0),
    )
    return { vectors: raw.vectors, usage }
  }

  /**
   * 22 ASR：音频 → 文本。与 `complete` 共用急停 / 路由 / 驻留 / 预算 / 记账五道；
   * **音频字节永不进事件日志**——`model.usage` 里只多一个 `audio` 摘要（哈希、时长、字节数）。
   */
  async transcribe(
    req: TranscribeRequest,
    meta: ModelMeta,
    model?: ModelRef,
  ): Promise<Transcription> {
    this.assertNotHalted()
    const ctx = ctxOf(meta)
    const ref = this.resolveRef(meta, model)
    const provider = this.findProvider(ref)
    if (provider.transcribe === undefined) {
      throw new GatewayError('not_implemented', 'provider does not support transcribe', {
        model: priceKey(ref),
      })
    }
    const digest = audioDigest(req)
    const startedAt = this.opts.clock.now()
    // 音频不是消息，估算按"每秒音频折 1 token"（与 stub / OpenAI 的按秒计价一致）
    const seconds = Math.max(1, Math.ceil(digest.duration_ms / 1000))
    const price = priceFor(this.opts.policy.prices, ref)
    const reservation = this.ledger.reserve({
      ctx,
      at: startedAt,
      amount: estimateCost(price, seconds, req.estimated_output_tokens ?? 0),
      ...(req.max_cost_base === undefined ? {} : { run_cap: req.max_cost_base }),
    })
    let raw: Awaited<ReturnType<NonNullable<ModelProvider['transcribe']>>>
    try {
      raw = await provider.transcribe({
        bytes: req.bytes,
        mime: req.mime,
        ...(req.language === undefined ? {} : { language: req.language }),
      })
    } catch (e) {
      this.ledger.release(reservation)
      const payload: ProviderDownPayload = {
        model: ref,
        attempts: [
          {
            model: ref,
            ...(e instanceof ProviderError && e.status !== undefined ? { status: e.status } : {}),
            message: messageOf(e),
          },
        ],
      }
      this.emit('model.provider_down', ctx, payload)
      throw new GatewayError('provider_unavailable', 'transcribe provider failed', payload)
    }
    const finishedAt = this.opts.clock.now()
    const usage: CompletionUsage = {
      input_tokens: raw.usage.input_tokens,
      output_tokens: raw.usage.output_tokens,
      cached_tokens: raw.usage.cached_tokens,
      cost_base: costOf(price, raw.usage),
    }
    this.ledger.settle(reservation, usage.cost_base)
    this.record(
      meta,
      ref,
      usage,
      finishedAt,
      '',
      Math.max(Date.parse(finishedAt) - Date.parse(startedAt), 0),
      digest,
    )
    return {
      text: raw.text,
      segments: raw.segments,
      ...(raw.speakers === undefined ? {} : { speakers: raw.speakers }),
      ...(raw.language === undefined ? {} : { language: raw.language }),
      usage,
      model: ref,
      audio: digest,
    }
  }

  async usage(filter: UsageFilter): Promise<UsageReport> {
    const sinceMs = filter.since === undefined ? undefined : Date.parse(filter.since)
    const rows = this.usageRecords.filter((r) => {
      if (r.workspace_id !== filter.workspace_id) return false
      if (filter.assignment_id !== undefined && r.assignment_id !== filter.assignment_id)
        return false
      if (filter.role_id !== undefined && r.role_id !== filter.role_id) return false
      if (filter.run_id !== undefined && r.run_id !== filter.run_id) return false
      if (filter.model !== undefined && priceKey(r.model) !== filter.model) return false
      if (sinceMs !== undefined && Date.parse(r.at) < sinceMs) return false
      return true
    })
    return rows.reduce<UsageReport>(
      (acc, r) => ({
        input_tokens: acc.input_tokens + r.input_tokens,
        output_tokens: acc.output_tokens + r.output_tokens,
        cached_tokens: acc.cached_tokens + r.cached_tokens,
        cost_base: acc.cost_base + r.cost_base,
        calls: acc.calls + 1,
      }),
      { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_base: 0, calls: 0 },
    )
  }

  async budget(scope: {
    workspace_id: WorkspaceId
    assignment_id?: AssignmentId
  }): Promise<{ used_base: number; cap_base: number; frozen: boolean }> {
    return this.ledger.state(scope, this.opts.clock.now())
  }

  records(): readonly UsageRecord[] {
    return this.usageRecords
  }

  recordExternal(input: ExternalUsage): void {
    this.record(
      input.meta,
      input.model,
      {
        input_tokens: input.usage?.input_tokens ?? 0,
        output_tokens: input.usage?.output_tokens ?? 0,
        cached_tokens: input.usage?.cached_tokens ?? 0,
        cost_base: 0,
      },
      this.opts.clock.now(),
      '',
      input.duration_ms ?? 0,
    )
  }

  reconfigure(next: {
    providers?: ModelProvider[]
    policy?: ModelGatewayPolicy
    images?: ImageProvider | null
  }): void {
    if (next.providers !== undefined) {
      this.opts.providers = next.providers
      // WP430：改了模型设置（重新登录、换了 key…）——冷却与「要重新登录」清零，下一次马上再试
      this.sourceHealth.clear()
      this.reloginSent.clear()
    }
    if (next.images !== undefined) this.currentImages = next.images ?? this.initialImages
    if (next.policy !== undefined) {
      this.opts.policy = next.policy
      this.ledger.setPolicy(next.policy.budget ?? {})
    }
  }

  providers(): readonly ModelRef[] {
    return this.opts.providers.map((p) => ({ ...p.ref }))
  }
}

/**
 * WP127：这个模型声明了看不了图，就不把图递给它。
 *
 * 只认**明确声明 `vision: false`** 的——没声明（没验证过）照常放行，
 * 让上游自己回答；"不知道"不等于"不能"。
 */
function assertCanSee(ref: ModelRef, provider: ModelProvider): void {
  if (provider.capabilities?.vision !== false) return
  throw new GatewayError('invalid_input', CANNOT_SEE_IMAGES_ZH, {
    reason: NO_VISION_REASON,
    model: priceKey(ref),
  })
}

function ctxOf(meta: ModelMeta): BudgetCtx {
  return {
    workspace_id: meta.workspace_id,
    assignment_id: meta.assignment_id,
    run_id: meta.run_id,
  }
}

/** 音频摘要：事件日志里唯一允许出现的音频信息（22 + 37 §4.3）。 */
function audioDigest(req: TranscribeRequest): TranscriptionAudioDigest {
  let hex = ''
  for (const b of req.bytes) hex += b.toString(16).padStart(2, '0')
  return {
    sha256: sha256(hex),
    duration_ms: req.duration_ms ?? 0,
    bytes: req.bytes.byteLength,
    mime: req.mime,
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 22：唯一持有 provider 凭据与预算的入口；业务代码只见这个函数。 */
export function createModelGateway(opts: ModelGatewayOptions): ModelGatewayApi {
  return new Gateway(opts)
}

/** WP188：停下时网关没来得及发请求（一开始就停了）——什么都没花。 */
const ZERO_USAGE: CompletionUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cost_base: 0,
}

const STOPPED = Symbol('stopped')

/** 读一次"停了没有"（不让 TS 把前面判过一次的结果当成永远不变）。 */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true

/**
 * WP188：等 provider，或者等调用方喊停——先到先算。喊停之后 provider 那边的 Promise 还在跑
 * （会流式的 provider 自己也收到同一个 `signal`，会停），它迟来的结果 / 报错一律吞掉。
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof STOPPED> {
  if (signal.aborted) {
    work.catch(() => undefined)
    return Promise.resolve(STOPPED)
  }
  return new Promise<T | typeof STOPPED>((resolve, reject) => {
    const onAbort = (): void => {
      resolve(STOPPED)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) resolve(STOPPED)
        else reject(e)
      },
    )
  })
}
