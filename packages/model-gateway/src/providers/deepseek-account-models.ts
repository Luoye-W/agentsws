/**
 * 「用 DeepSeek 账号登录」这一路的**模型目录**：从账号的 `GET /models` 取（WP357，决策 919 后半条）。
 *
 * 移植自官方 MIT 包 `@deepseek-ai/dsh-llm-deepseek-account@0.2.1-alpha.4` 的 `lib/index.js`
 * （源码段 `lib/types/listing.js`、`catalog.js`、`resolve-catalog.js`，以及 `config.js` 的
 * `listingEndpoint` 与两个默认值）。版权 DeepSeek，MIT 许可；改动见下面"与官方的差别"。
 *
 * 官方的口径（README「Use this package」）照搬：
 *
 * - 清单在 Messages `baseURL` 的**源**下的 `/models`（官方口即 `https://api.deepseek.com/models`），不可配；
 *   请求带 `x-dsh-auth-token`（令牌每次现取自官方账号模块 `resolveToken`）、拒绝重定向。
 * - 一份令牌一份清单（缓存键 = 地址 + 令牌的 SHA-256），这样服务端能先给部分账号放新模型。
 * - 第一次用某份令牌时等清单（最多 `timeoutMs`，默认 5 秒）；之后直接用已加载的，老过 `maxAgeMs`
 *   （默认 10 分钟）就在后台刷新；**拉失败或拉回空的保留上一份**；一份都还没拉到之前用**内置目录**
 *   （就是原来写死的那两个：`deepseek-flash` 与 `deepseek-v4-pro`）。清单那边回 401 不清登录。
 * - 清单里声明了 `client_requirements["deepseek-harness"].min_version` 的模型，只有当前版本
 *   **不低于**它（按语义化版本比较，含 alpha / rc 预发布号）才给用；没声明的，只有内置目录认得的 id 才给用；
 *   别的一律隐藏。点名要一个被拒的模型，发请求**之前**就失败（要更新 / 不支持），见 {@link accountModelRefusalMessage}。
 *   清单里没提到的 id 原样放行。
 * - 给用的模型：名字、能不能看图、单次输出上限取清单的，盖在内置那一条上。
 * - `modelOverrides` 只能调单个模型的字段，不能加模型、不能让被拒的模型变可用。
 *
 * 与官方的差别：
 *
 * - 日志：官方写 `console.info / warn`（带 `[llm-deepseek-account]`）；这里由装配方注入 `log`，
 *   内容同样只有地址、条数与原因，**令牌从不进日志、事件或错误信息**。
 * - "当前版本"：官方比的是 dsh 自己的 `APP_IDENTITY.version`；我们不是 dsh harness 本体，比的是
 *   我们装着的那一版 dsh 账号模块的版本号（装配方传进来，见 `apps/server` 里的 `DEEPSEEK_ACCOUNT_CLIENT_VERSION`）。
 * - 模型条目只留我们用得上的字段（id / 名字 / 能否看图 / 输出上限 / 上下文窗口）；官方的
 *   `systemPromptUpdate`、`toolUpdate`、图片预算属于它自己的流式适配器，我们的网关不读。
 * - `fetch` 可注入（测试与 demo 用替身，不联网）。
 */
import { createHash } from 'node:crypto'
import semver from 'semver'

/** 官方 `APP_IDENTITY.product`：清单里 `client_requirements` 下面认的那个键。 */
export const DEEPSEEK_HARNESS_PRODUCT = 'deepseek-harness'

/** 一次清单请求、以及第一次使用时最多等多久（官方 `DEFAULT_MODELS_TIMEOUT_MS`）。 */
export const DEFAULT_MODELS_TIMEOUT_MS = 5_000

/** 清单多老之后下一次访问在后台刷新；拉失败后也隔这么久再试（官方 `DEFAULT_MODELS_MAX_AGE_MS`）。 */
export const DEFAULT_MODELS_MAX_AGE_MS = 600_000

/** 我们这一版认得的模态（官方 `LISTED_MODALITIES`）。 */
const LISTED_MODALITIES = ['text', 'image'] as const
type Modality = (typeof LISTED_MODALITIES)[number]

/** 账号令牌放在哪个头里（Messages / Files / 清单三处同一个；官方 `TOKEN_HEADER`）。 */
const TOKEN_HEADER = 'x-dsh-auth-token'

// ── listing：一次带令牌的请求 + 逐条解码 ─────────────────────────────

export type AccountModelRequirement =
  | { kind: 'none' }
  | { kind: 'min-version'; version: string }
  | { kind: 'invalid' }

export interface AccountModelFacts {
  inputModalities: Modality[]
  contextWindow?: number
  maxOutputTokens?: number
}

export type AccountModelCapabilities =
  | { usable: true; facts: AccountModelFacts }
  | { usable: false; reason: string }

/** 清单里的一条（解码后）。 */
export interface AccountModelEntry {
  id: string
  name?: string
  requirement: AccountModelRequirement
  capabilities: AccountModelCapabilities
}

/** 一份解码好的清单。`skipped` = 没有可用 id（或重复）而跳过的行数。 */
export interface AccountModelListing {
  entries: AccountModelEntry[]
  skipped: number
}

/** 清单请求失败。`code` 照官方：`TIMEOUT` / `ABORTED` / `TRANSPORT` / `HTTP_<状态码>` / `INVALID_RESPONSE`。 */
export class AccountModelListingError extends Error {
  readonly code: string
  readonly status: number | undefined
  constructor(message: string, code: string, status?: number) {
    super(message)
    this.name = 'AccountModelListingError'
    this.code = code
    this.status = status
  }
}

const fieldsOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** 我们这一版认得的输入 / 输出模态，按清单里的顺序、去重；不是数组回 `undefined`。 */
function knownModalities(value: unknown): Modality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const listed: unknown[] = value
  return LISTED_MODALITIES.filter((m) => listed.includes(m)).sort(
    (a, b) => listed.indexOf(a) - listed.indexOf(b),
  )
}

/** 一个声明的容量：没写 `undefined`，不是正的安全整数 `false`。 */
function capacity(value: unknown): number | undefined | false {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : false
}

function requirementOf(entry: Record<string, unknown>): AccountModelRequirement {
  if (entry.client_requirements === undefined) return { kind: 'none' }
  const requirements = fieldsOf(entry.client_requirements)
  if (requirements === undefined) return { kind: 'invalid' }
  const declared = requirements[DEEPSEEK_HARNESS_PRODUCT]
  if (declared === undefined) return { kind: 'none' }
  const own = fieldsOf(declared)
  if (own === undefined) return { kind: 'invalid' }
  if (own.min_version === undefined) return { kind: 'none' }
  return typeof own.min_version === 'string' && own.min_version.length > 0
    ? { kind: 'min-version', version: own.min_version }
    : { kind: 'invalid' }
}

function capabilitiesOf(entry: Record<string, unknown>): AccountModelCapabilities {
  const messages = fieldsOf(fieldsOf(entry.api_capabilities)?.anthropic_messages)
  if (messages === undefined) {
    return { usable: false, reason: 'declares no api_capabilities.anthropic_messages' }
  }
  const outputs =
    entry.output_modalities === undefined ? ['text'] : knownModalities(entry.output_modalities)
  if (outputs?.includes('text') !== true)
    return { usable: false, reason: 'declares no text output' }
  const inputs =
    entry.input_modalities === undefined
      ? (['text'] as Modality[])
      : knownModalities(entry.input_modalities)
  if (inputs === undefined || inputs.length === 0) {
    return { usable: false, reason: 'declares no input modality this client supports' }
  }
  const contextWindow = capacity(entry.context_window)
  const maxOutputTokens = capacity(entry.max_output_tokens)
  if (contextWindow === false || maxOutputTokens === false) {
    return { usable: false, reason: 'declares an invalid context_window or max_output_tokens' }
  }
  return {
    usable: true,
    facts: {
      inputModalities: inputs,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    },
  }
}

/**
 * 逐条解码一份 `/models` 响应体。
 * @throws AccountModelListingError `INVALID_RESPONSE`：没有 `data` 数组，或一条可用的都没有。
 */
export function parseModelListing(body: unknown): AccountModelListing {
  const data = fieldsOf(body)?.data
  if (!Array.isArray(data)) {
    throw new AccountModelListingError(
      'DeepSeek model listing has no "data" array',
      'INVALID_RESPONSE',
    )
  }
  const rows: unknown[] = data
  const entries: AccountModelEntry[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const entry = fieldsOf(row)
    const id = entry?.id
    if (entry === undefined || typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    entries.push({
      id,
      ...(typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {}),
      requirement: requirementOf(entry),
      capabilities: capabilitiesOf(entry),
    })
  }
  if (entries.length === 0) {
    throw new AccountModelListingError(
      'DeepSeek model listing contains no model entry',
      'INVALID_RESPONSE',
    )
  }
  return { entries, skipped: rows.length - entries.length }
}

/** 清单地址：Messages 根的**源**下的 `/models`——账号令牌只给这个源（官方 `listingEndpoint`）。 */
export function listingEndpoint(baseUrl: string): string {
  return new URL('/models', new URL(baseUrl).origin).href
}

/** 清单请求用的 fetch（真网络就是全局 `fetch`；测试注入替身）。 */
export type ListingFetch = (
  input: string,
  init: {
    method: 'GET'
    headers: Record<string, string>
    redirect: 'error'
    signal: AbortSignal
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/**
 * 请求并解码一份清单。重定向一律失败，令牌只到请求的那个源。
 * `timedOut()` 为真表示是**截止时间**到了（报 `TIMEOUT`），否则一次中止报 `ABORTED`。
 */
export async function requestModelListing(
  url: string,
  token: string,
  doFetch: ListingFetch,
  signal: AbortSignal,
  timedOut: () => boolean = () => false,
): Promise<AccountModelListing> {
  let response: Awaited<ReturnType<ListingFetch>>
  let text: string
  try {
    response = await doFetch(url, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: { accept: 'application/json', [TOKEN_HEADER]: token },
    })
    text = await response.text()
  } catch {
    if (timedOut()) {
      throw new AccountModelListingError(
        `DeepSeek model listing request to ${url} timed out`,
        'TIMEOUT',
      )
    }
    throw signal.aborted
      ? new AccountModelListingError(
          `DeepSeek model listing request to ${url} was aborted`,
          'ABORTED',
        )
      : new AccountModelListingError(`could not reach ${url}`, 'TRANSPORT')
  }
  if (!response.ok) {
    throw new AccountModelListingError(
      `${url} answered HTTP ${response.status}`,
      `HTTP_${response.status}`,
      response.status,
    )
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new AccountModelListingError(`${url} did not answer with JSON`, 'INVALID_RESPONSE')
  }
  return parseModelListing(body)
}

// ── resolve-catalog：版本门槛 + 内置目录 + 单模型覆盖 ─────────────────

/** 内置目录里的一条（`DEEPSEEK_ACCOUNT_MODELS` 的形状）。 */
export interface AccountBuiltinModel {
  id: string
  name: string
  vision: boolean
}

/** 目录里给用的一个模型。 */
export interface AccountCatalogModel {
  id: string
  name: string
  vision: boolean
  /** 单次输出上限（清单的 `max_output_tokens`，或覆盖里的 `maxTokens`）。 */
  maxOutputTokens?: number
  contextWindow?: number
}

/** 单个模型的覆盖（官方 `modelOverrides.<id>` 里我们用得上的那几样）。不写的字段沿用。 */
export interface AccountModelOverride {
  name?: string
  vision?: boolean
  maxTokens?: number
  contextWindow?: number
}

export type AccountModelRefusal =
  | { kind: 'upgrade-required'; requiredVersion: string }
  | { kind: 'unsupported' }

export interface ResolvedAccountCatalog {
  /** `listing` = 照账号清单；`builtin` = 清单还没拉到，用内置目录。 */
  source: 'listing' | 'builtin'
  /** 给用的模型，按清单顺序。 */
  offered: AccountCatalogModel[]
  /** 清单里点了名、但这一版不给用的模型。 */
  refusals: Map<string, AccountModelRefusal>
  /** 清单里读不懂 / 不能用的条目（给日志）。 */
  problems: string[]
  /** 没生效的覆盖（给日志 / 诊断）。 */
  overrideErrors: string[]
}

const positiveInt = (v: unknown): boolean =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/** 一份覆盖能不能用；不能用回原因。 */
function overrideProblem(override: AccountModelOverride): string | undefined {
  if (override.name !== undefined && (typeof override.name !== 'string' || override.name === ''))
    return 'name must be a non-empty string'
  if (override.vision !== undefined && typeof override.vision !== 'boolean')
    return 'vision must be a boolean'
  if (override.maxTokens !== undefined && !positiveInt(override.maxTokens))
    return 'maxTokens must be a positive integer'
  if (override.contextWindow !== undefined && !positiveInt(override.contextWindow))
    return 'contextWindow must be a positive integer'
  return undefined
}

function gateOf(
  entry: AccountModelEntry,
  known: boolean,
  clientVersion: string,
  problems: string[],
): AccountModelRefusal | undefined {
  const requirement = entry.requirement
  if (requirement.kind === 'none') return known ? undefined : { kind: 'unsupported' }
  if (requirement.kind === 'min-version' && semver.valid(requirement.version) !== null) {
    return semver.gte(clientVersion, requirement.version)
      ? undefined
      : { kind: 'upgrade-required', requiredVersion: requirement.version }
  }
  problems.push(`model "${entry.id}" declares an unreadable client requirement`)
  return { kind: 'unsupported' }
}

/**
 * 解析账号目录（官方 `resolveAccountCatalog`）。清单里声明了最低版本的，看版本给不给；
 * 没声明的，只给内置目录认得的；别的隐藏。没有清单 = 内置目录。
 */
export function resolveAccountCatalog(input: {
  listing: readonly AccountModelEntry[] | undefined
  builtin: readonly AccountBuiltinModel[]
  clientVersion: string
  overrides?: Readonly<Record<string, AccountModelOverride>>
}): ResolvedAccountCatalog {
  const builtin = new Map(input.builtin.map((m) => [m.id, m]))
  const overrides = input.overrides ?? {}
  const problems: string[] = []
  const overrideErrors: string[] = []
  const withOverride = (model: AccountCatalogModel): AccountCatalogModel => {
    const override = overrides[model.id]
    if (override === undefined) return model
    const problem = overrideProblem(override)
    if (problem !== undefined) {
      overrideErrors.push(`modelOverrides.${model.id} does not apply (${problem})`)
      return model
    }
    return {
      ...model,
      ...(override.name === undefined ? {} : { name: override.name }),
      ...(override.vision === undefined ? {} : { vision: override.vision }),
      ...(override.maxTokens === undefined ? {} : { maxOutputTokens: override.maxTokens }),
      ...(override.contextWindow === undefined ? {} : { contextWindow: override.contextWindow }),
    }
  }
  const builtinModel = (m: AccountBuiltinModel): AccountCatalogModel => ({
    id: m.id,
    name: m.name,
    vision: m.vision,
  })

  if (input.listing === undefined) {
    for (const id of Object.keys(overrides)) {
      if (!builtin.has(id)) {
        overrideErrors.push(
          `modelOverrides names "${id}", which the built-in catalog does not describe`,
        )
      }
    }
    return {
      source: 'builtin',
      offered: input.builtin.map((m) => withOverride(builtinModel(m))),
      refusals: new Map(),
      problems,
      overrideErrors,
    }
  }

  const offered: AccountCatalogModel[] = []
  const refusals = new Map<string, AccountModelRefusal>()
  for (const entry of input.listing) {
    const refusal = gateOf(entry, builtin.has(entry.id), input.clientVersion, problems)
    if (refusal !== undefined) {
      refusals.set(entry.id, refusal)
      continue
    }
    if (!entry.capabilities.usable) {
      problems.push(`model "${entry.id}" ${entry.capabilities.reason}`)
      refusals.set(entry.id, { kind: 'unsupported' })
      continue
    }
    const base = builtin.get(entry.id)
    const facts = entry.capabilities.facts
    offered.push(
      withOverride({
        id: entry.id,
        name: entry.name ?? base?.name ?? entry.id,
        vision: facts.inputModalities.includes('image'),
        ...(facts.maxOutputTokens === undefined ? {} : { maxOutputTokens: facts.maxOutputTokens }),
        ...(facts.contextWindow === undefined ? {} : { contextWindow: facts.contextWindow }),
      }),
    )
  }
  const listedIds = new Set(input.listing.map((e) => e.id))
  for (const id of Object.keys(overrides)) {
    if (!listedIds.has(id) && !builtin.has(id)) {
      overrideErrors.push(
        `modelOverrides names "${id}", which neither the account listing nor the built-in catalog describes`,
      )
    }
  }
  return { source: 'listing', offered, refusals, problems, overrideErrors }
}

/**
 * 点名要一个被拒的模型时的失败原因（人话；官方同一处是 `CLIENT_UPGRADE_REQUIRED` / `MODEL_UNSUPPORTED`）。
 */
export function accountModelRefusalMessage(
  model: string,
  refusal: AccountModelRefusal,
  clientVersion: string,
): string {
  return refusal.kind === 'upgrade-required'
    ? `DeepSeek 账号里的 ${model} 要更新版的工坊才能用（要求 ${refusal.requiredVersion} 或更新，现在是 ${clientVersion}），这次没跑。先换一个模型，等工坊更新后再用它。`
    : `DeepSeek 账号里的 ${model} 这一版工坊还不支持，这次没跑。先换一个模型。`
}

// ── catalog：按令牌分的缓存，单飞加载、后台刷新、保留上一份好的 ─────────

/** 等 `task`，除非 `signal` 先中止（task 本身照跑）。 */
async function abandonable(task: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return task
  signal.throwIfAborted()
  let abandon: (() => void) | undefined
  const abandoned = new Promise<void>((_, reject) => {
    abandon = () => reject(signal.reason)
    signal.addEventListener('abort', abandon, { once: true })
  })
  try {
    await Promise.race([task, abandoned])
  } finally {
    if (abandon !== undefined) signal.removeEventListener('abort', abandon)
  }
}

export interface AccountModelCatalogView {
  signedIn: boolean
  listing: AccountModelListing | undefined
}

export interface DeepSeekAccountModelCatalogOptions {
  /** 官方账号模块的 `resolveToken`：**每次现取**；回 `undefined` = 没登录（或地址不在官方允许的源下）。 */
  resolveToken: (url: string) => Promise<string | undefined>
  /** 当前版本（拿来比清单里的 `min_version`）。给函数 = 每次用时现取（宿主是懒加载的）。 */
  clientVersion: string | (() => string)
  /** 内置目录：清单还没拉到时就用它；没声明版本要求的清单条目也只认它里面的 id。 */
  builtin: readonly AccountBuiltinModel[]
  /** Messages 根；清单在它的源下的 `/models`。 */
  baseUrl: string
  fetch?: ListingFetch
  timeoutMs?: number
  maxAgeMs?: number
  overrides?: Readonly<Record<string, AccountModelOverride>>
  now?: () => number
  /** 诊断日志（只有地址、条数、原因；从不带令牌）。不给就不写。 */
  log?: { info(message: string): void; warn(message: string): void }
  /** 一份新清单加载成功之后调一次（装配方据此刷新设置页的模型下拉）。 */
  onLoaded?: () => void
}

/**
 * 账号模型目录（官方 `AccountModelCatalog`）。一个进程一个，按"地址 + 令牌哈希"分区：
 * 换了账号（令牌变了）就清掉上一份重新拉。
 */
export class DeepSeekAccountModelCatalog {
  readonly url: string
  private readonly options: DeepSeekAccountModelCatalogOptions
  private readonly doFetch: ListingFetch
  private readonly now: () => number
  private scope: string | undefined
  private listing: AccountModelListing | undefined
  /** 这一分区最近一次加载落定的时间；第一次落定之前是 `undefined`。 */
  private settledAt: number | undefined
  private inflight: Promise<void> | undefined
  private request: AbortController | undefined
  private generation = 0
  private failing = false
  private closed = false
  private loggedListing: AccountModelListing | undefined

  constructor(options: DeepSeekAccountModelCatalogOptions) {
    this.options = options
    this.url = listingEndpoint(options.baseUrl)
    this.doFetch = options.fetch ?? (globalThis.fetch as unknown as ListingFetch)
    this.now = options.now ?? Date.now
  }

  /** 当前版本（拿来比清单里的 `min_version`）。 */
  get clientVersion(): string {
    const v = this.options.clientVersion
    return typeof v === 'string' ? v : v()
  }

  /** 最近一次发布的视图，不做 I/O。 */
  current(): AccountModelCatalogView {
    return { signedIn: this.scope !== undefined, listing: this.listing }
  }

  /**
   * 按当前令牌取视图。某份令牌第一次访问时等它加载完（受 `timeoutMs` 限）；之后立刻返回，
   * 清单老了就在后台刷新。`signal` 只放弃这一次等待，共享的加载照跑。
   */
  async view(signal?: AbortSignal): Promise<AccountModelCatalogView> {
    // 值只在这一段里活一次：现取 → 当哈希输入 / 进清单请求头 → 结束
    const token = await this.options.resolveToken(this.url)
    signal?.throwIfAborted()
    if (this.closed) return this.current()
    const scope =
      token === undefined
        ? undefined
        : `${this.url}\n${createHash('sha256').update(token).digest('hex')}`
    if (scope !== this.scope) this.rescope(scope)
    if (token !== undefined) {
      const maxAge = this.options.maxAgeMs ?? DEFAULT_MODELS_MAX_AGE_MS
      if (this.settledAt === undefined) await abandonable(this.start(token), signal)
      else if (this.now() - this.settledAt >= maxAge) void this.start(token)
    }
    return this.current()
  }

  /** 解析一份视图（缺省当前那一份）成给用的目录。 */
  resolve(view: AccountModelCatalogView = this.current()): ResolvedAccountCatalog {
    const result = resolveAccountCatalog({
      listing: view.listing?.entries,
      builtin: this.options.builtin,
      clientVersion: this.clientVersion,
      ...(this.options.overrides === undefined ? {} : { overrides: this.options.overrides }),
    })
    // 一份清单只记一次它隐藏 / 读不懂的条目
    if (view.listing !== this.loggedListing) {
      this.loggedListing = view.listing
      for (const problem of [...result.problems, ...result.overrideErrors]) {
        this.options.log?.warn(problem)
      }
    }
    return result
  }

  /** 发请求之前问一句：这个模型这一版给不给用（按当前清单，不做 I/O）。给用回 `undefined`。 */
  refusal(model: string): AccountModelRefusal | undefined {
    if (this.listing === undefined) return undefined
    return this.resolve().refusals.get(model)
  }

  /** 这个模型在当前目录里的那一条（不做 I/O）。 */
  model(id: string): AccountCatalogModel | undefined {
    return this.resolve().offered.find((m) => m.id === id)
  }

  /** 中止进行中的加载；之后的结果与访问都不再改任何东西。 */
  dispose(): void {
    this.closed = true
    this.generation += 1
    this.request?.abort()
  }

  private rescope(scope: string | undefined): void {
    this.request?.abort()
    this.scope = scope
    this.listing = undefined
    this.settledAt = undefined
    this.inflight = undefined
    this.failing = false
    this.generation += 1
  }

  private start(token: string): Promise<void> {
    if (this.inflight !== undefined) return this.inflight
    this.generation += 1
    const generation = this.generation
    const request = new AbortController()
    this.request = request
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      request.abort()
    }, this.options.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS)
    const url = this.url
    const run = requestModelListing(url, token, this.doFetch, request.signal, () => timedOut)
      .then(
        (listing) => {
          if (generation !== this.generation) return
          this.listing = listing
          this.settledAt = this.now()
          this.failing = false
          this.options.log?.info(
            `model listing from ${url} loaded ${listing.entries.length} model(s), skipped ${listing.skipped} row(s)`,
          )
          try {
            this.options.onLoaded?.()
          } catch {
            // 装配方的回调出错不影响目录
          }
        },
        (error: unknown) => {
          if (generation !== this.generation) return
          if (!this.failing) {
            const fallback =
              this.listing === undefined
                ? 'using the bundled catalog'
                : 'keeping the previous catalog'
            const reason =
              error instanceof AccountModelListingError
                ? `${error.code}: ${error.message}`
                : 'error'
            this.options.log?.warn(`model listing from ${url} failed (${reason}); ${fallback}`)
          }
          this.settledAt = this.now()
          this.failing = true
        },
      )
      .finally(() => {
        clearTimeout(timer)
        if (this.inflight === run) this.inflight = undefined
      })
    this.inflight = run
    return run
  }
}
