import type {
  AssignmentId,
  ChatMessage,
  Clock,
  Completion,
  CompletionUsage,
  Halt,
  Iso8601,
  ModelGateway,
  ModelMeta,
  ModelProvider,
  ModelRef,
  RoleId,
  ToolDef,
  Trace,
  TranscribeAudio,
  Transcription,
  TranscriptionAudioDigest,
  WorkspaceId,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
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
import type {
  BlockedResidencyPayload,
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

export interface ModelGatewayOptions {
  providers: ModelProvider[]
  policy: ModelGatewayPolicy
  clock: Clock
  eventSink: ModelEventSink
  /** 28 §1 急停；也认环境变量 AGENTSWS_MODEL_HALT=1。 */
  halt?: Halt
  env: Record<string, string | undefined>
  trace?: Trace
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
  /** 该次转写涉及欧洲客户数据（22 §2 eu_customer_to_cloud_brain；音频同 eu 规则）。 */
  eu_customer?: boolean
  max_cost_base?: number
  /** 覆盖预留时的预计输出 token 数（默认 0：ASR 的输出相对音频成本可忽略）。 */
  estimated_output_tokens?: number
}

export interface ModelGatewayApi extends ModelGateway {
  complete(req: CompleteRequest): Promise<Completion>
  transcribe(req: TranscribeRequest, meta: ModelMeta, model?: ModelRef): Promise<Transcription>
  usage(filter: UsageFilter): Promise<UsageReport>
  /** 只读账目，测试与报表用（与 model.usage 事件一一对应）。 */
  records(): readonly UsageRecord[]
}

const HALT_ENV = 'AGENTSWS_MODEL_HALT'

class Gateway implements ModelGatewayApi {
  private readonly ledger: BudgetLedger
  private readonly usageRecords: UsageRecord[] = []

  constructor(private readonly opts: ModelGatewayOptions) {
    this.ledger = new BudgetLedger(opts.policy.budget ?? {}, {
      onFrozen: (cap, used, ctx) => this.emitFrozen(cap, used, ctx),
      onRunExhausted: (used, cap, ctx) => this.emitRunExhausted(used, cap, ctx),
    })
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

  /** 22 §2 数据出境：cn 驻留下禁 region=global；欧洲客户数据按策略禁 cloud_brain。 */
  private assertResidency(
    ref: ModelRef,
    provider: ModelProvider,
    ctx: BudgetCtx,
    purpose: ModelMeta['purpose'],
    euCustomer: boolean,
  ): void {
    const policy = this.opts.policy
    const region = ref.region ?? provider.ref.region
    const block = (reason: BlockedResidencyPayload['reason'], message: string): never => {
      const payload: BlockedResidencyPayload = {
        model: { ...ref, ...(region === undefined ? {} : { region }) },
        purpose,
        data_residency: policy.data_residency,
        reason,
      }
      this.emit('model.blocked_residency', ctx, payload)
      throw new GatewayError('forbidden', message, payload)
    }
    if (policy.data_residency === 'cn' && region === 'global') {
      block('region_global', 'data_residency cn forbids region global provider')
    }
    if (
      euCustomer &&
      ref.provider === 'cloud_brain' &&
      (policy.eu_customer_to_cloud_brain ?? 'deny') === 'deny'
    ) {
      block('eu_customer_to_cloud_brain', 'eu customer data may not reach cloud_brain')
    }
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
  ): void {
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
      // 21 §1「秘密从不进」的音频版：只记摘要，字节与转写正文永不进事件日志
      ...(audio === undefined ? {} : { audio }),
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

  async complete(req: CompleteRequest): Promise<Completion> {
    this.assertNotHalted()
    const { meta } = req
    const ctx = ctxOf(meta)
    const primary = this.resolveRef(meta, req.model)
    const primaryProvider = this.findProvider(primary)
    this.assertResidency(primary, primaryProvider, ctx, meta.purpose, req.eu_customer === true)
    const staticPrefix = staticPrefixHash(req.messages, req.tools, req.cache_breakpoints)
    const startedAt = this.opts.clock.now()
    const reservation = this.reserveFor(
      meta,
      req.messages,
      req.tools,
      primary,
      startedAt,
      req.max_cost_base,
      req.estimated_output_tokens,
    )

    const attempts: ProviderDownPayload['attempts'] = []
    try {
      for (const ref of this.candidates(primary)) {
        let provider: ModelProvider
        try {
          provider = this.findProvider(ref)
          if (ref !== primary) {
            this.assertResidency(ref, provider, ctx, meta.purpose, req.eu_customer === true)
            priceFor(this.opts.policy.prices, ref)
          }
        } catch (e) {
          attempts.push({ model: ref, message: messageOf(e) })
          continue
        }
        try {
          const raw = await provider.complete({
            messages: req.messages,
            ...(req.tools === undefined ? {} : { tools: req.tools }),
            ...(req.seed === undefined ? {} : { seed: req.seed }),
            // 22：provider 不声明原生支持就剥掉 tool_choice（退化为 auto），由运行时自己兜底
            ...(req.tool_choice === undefined || provider.supports_tool_choice !== true
              ? {}
              : { tool_choice: req.tool_choice }),
          })
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
            staticPrefix,
            Math.max(Date.parse(finishedAt) - Date.parse(startedAt), 0),
          )
          return {
            text: raw.text,
            ...(raw.tool_calls === undefined ? {} : { tool_calls: raw.tool_calls }),
            usage,
            model: ref,
            static_prefix_hash: staticPrefix,
          }
        } catch (e) {
          attempts.push({
            model: ref,
            ...(e instanceof ProviderError && e.status !== undefined ? { status: e.status } : {}),
            message: messageOf(e),
          })
          if (!isRetryableProviderError(e)) break
        }
      }
    } catch (e) {
      this.ledger.release(reservation)
      throw e
    }
    this.ledger.release(reservation)
    const payload: ProviderDownPayload = { model: primary, attempts }
    this.emit('model.provider_down', ctx, payload)
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
    this.assertResidency(ref, provider, ctx, meta.purpose, false)
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
      raw = await provider.embed(texts)
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
    this.assertResidency(ref, provider, ctx, meta.purpose, req.eu_customer === true)
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
