/**
 * 模型面的装配（WP25 交付 C）。
 *
 * 一句话职责：把「本机加密秘密库里的 API key + 一份 JSON 配置」装配成 22 的模型网关，
 * 并且**保存即生效**——改完设置下一次 `complete` 就走新 provider，不用重启进程。
 *
 * 为什么非做不可：在这之前，这台机器上有没有模型只看一个环境变量
 * （`DEEPSEEK_API_KEY`）。没设就是 stub 运行时——工作台看着一切正常，Agent 却一句
 * 人话都说不出来，而界面上没有任何地方能让用户把 key 填进去。
 *
 * 四条纪律（22 §5 + 13 §4.3）：
 *
 * 1. **key 只在网关**。业务代码拿到的是装配好的 `ModelProvider`；key 的值只在
 *    `openaiCompatibleProvider` 的 `apiKey()` 回调里出现一次，直接进 `Authorization` 头。
 *    它不进 `process.env`、不进配置对象、不进事件、不进响应体。
 * 2. **配置与凭据分开落盘**：非秘密的（base_url / 模型名 / 价格 / 预算）进
 *    `models.json`，key 进 `secrets.sqlite` 的 `model_provider:` 前缀（AES-256-GCM，
 *    与邮箱口令同一个库、不同前缀）。
 * 3. **热更新不清账**：换 provider 走网关的 `reconfigure`，预算已花额度与 usage
 *    记录原样留着（重建一个网关等于把今天花的钱清零，三级预算当场失效）。
 * 4. 时间经注入的 `Clock`；没有一处 `Date.now()` / `Math.random()` 裸调。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ModelDefaultsView,
  ModelProviderKind,
  ModelProviderTemplate,
  ModelProviderView,
  ModelsActor,
  ModelsPort,
  ModelTestResult,
  ModelUsageRow,
  ModelUsageView,
  SaveModelProviderInput,
  SetModelDefaultsInput,
} from '@agentsws/api'
import type { Clock, ModelProvider, ModelPurpose, ModelRef } from '@agentsws/contracts'
import type { FetchLike, ModelGatewayApi, ModelGatewayPolicy } from '@agentsws/model-gateway'
import { openaiCompatibleProvider, stubProvider } from '@agentsws/model-gateway'
import type { SecretStore } from './secret-store.js'
import { SECRETS_KEY_ENV } from './secret-store.js'

/** 秘密库里模型 key 的前缀（和连接 id、Shopify 应用凭据分开）。 */
export const MODEL_KEY_PREFIX = 'model_provider:'

/** 无界面时的兜底：这个环境变量还认（`scripts/dev-real.sh` / CI 靠它）。 */
export const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY'

/** 环境变量兜底出来的那条 provider 的固定 id。 */
export const ENV_PROVIDER_ID = 'deepseek'

/** stub provider 的 ref——一个模型都没配时，运行时落回它（确定性、不花钱）。 */
export const STUB_REF: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

const STUB_PRICES = { 'stub/stub-v1': { in: 0, out: 0, cached: 0 } }

/** 一条 provider 的**非秘密**配置。key 不在这里，在加密库里。 */
export interface ModelProviderConfig {
  id: string
  kind: ModelProviderKind
  label: string
  base_url: string
  model: string
  embedding_model?: string
  transcription_model?: string
  region: 'cn' | 'global'
  price_in?: number
  price_out?: number
  price_cached?: number
}

interface ModelsStateFile {
  version: 1
  providers: ModelProviderConfig[]
  defaults: {
    default?: string
    by_purpose?: Partial<Record<ModelPurpose, string>>
    data_residency?: 'cn' | 'any'
    budget?: {
      workspace_daily_base?: number
      workspace_monthly_base?: number
      assignment_daily_base?: number
    }
  }
  /** provider id → 上次测试结果（只有 ok / 延迟 / 模型名，没有 key 线索）。 */
  tests: Record<string, ModelTestResult>
}

export interface ModelsOptions {
  clock: Clock
  /** 网关。装配好之后由本模块 `reconfigure`。 */
  gateway: ModelGatewayApi
  /** 与连接凭据同一个加密库、不同 key 前缀。 */
  secrets: SecretStore
  env: Record<string, string | undefined>
  /** `models.json` 的目录；不给就全内存（测试与一次性任务）。 */
  dbDir?: string
  /** 试跑用的 fetch（测试注入 fixture，不联网）。 */
  fetch?: FetchLike
}

export interface ModelsAssembly {
  port: ModelsPort
  /** 这台机器上有没有能用的模型（运行时与首页黄条问它，不再看环境变量）。 */
  configured(): boolean
  /** 现在生效的默认模型（运行时组 `RunRequest.runtime.model` 用）。 */
  defaultRef(): ModelRef
}

// ── 可以新建哪几种 ─────────────────────────────────────────────────────

/**
 * v1 只做两种：**DeepSeek 官方** + **OpenAI 兼容自定义**。
 *
 * 后者一种形态覆盖一大片：OpenAI 本身、Moonshot（Kimi）、通义千问、智谱 GLM、
 * 硅基流动、以及本地跑的 Ollama / vLLM——它们的 `/chat/completions` 是同一个形状，
 * 差别只在地址和模型名。所以给一组预设点一下就填好，而不是每家写一张卡。
 */
export const MODEL_TEMPLATES: readonly ModelProviderTemplate[] = [
  {
    kind: 'deepseek',
    label: 'DeepSeek 官方',
    summary: '国内直连、便宜、够用。没别的偏好就选它。',
    default_base_url: 'https://api.deepseek.com',
    default_model: 'deepseek-chat',
    region: 'cn',
    steps: [
      '打开 platform.deepseek.com，用手机号注册登录',
      '左边找到"API keys"，点"创建 API key"',
      '复制那一串（只显示一次，关掉就看不到了）',
      '粘进下面的表单，点保存',
      '点"测试"——回了模型名和延迟就是通了',
    ],
    links: [{ label: 'DeepSeek 开放平台', url: 'https://platform.deepseek.com/api_keys' }],
  },
  {
    kind: 'openai_compatible',
    label: 'OpenAI 兼容（自定义）',
    summary:
      '任何"OpenAI 格式"的服务都能接：OpenAI、Moonshot、通义千问、智谱，以及这台电脑上跑的 Ollama。',
    default_base_url: 'https://api.openai.com/v1',
    default_model: 'gpt-4o-mini',
    region: 'global',
    steps: [
      '去你要用的那家的控制台，创建一个 API key',
      '找到它文档里写的"接口地址"（一般以 /v1 结尾）',
      '把地址、模型名、key 填进下面的表单',
      '境外的服务把"数据驻留"选 global，境内的选 cn',
      '点"测试"确认能通',
    ],
    links: [
      { label: 'Moonshot（Kimi）', url: 'https://platform.moonshot.cn' },
      { label: '通义千问（DashScope）', url: 'https://help.aliyun.com/zh/model-studio/' },
      { label: '智谱 GLM', url: 'https://open.bigmodel.cn' },
      { label: 'Ollama（本地跑）', url: 'https://ollama.com' },
    ],
    presets: [
      {
        id: 'openai',
        label: 'OpenAI',
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        region: 'global',
      },
      {
        id: 'moonshot',
        label: 'Moonshot / Kimi',
        base_url: 'https://api.moonshot.cn/v1',
        model: 'moonshot-v1-8k',
        region: 'cn',
      },
      {
        id: 'qwen',
        label: '通义千问',
        base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus',
        region: 'cn',
      },
      {
        id: 'zhipu',
        label: '智谱 GLM',
        base_url: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-4-plus',
        region: 'cn',
      },
      {
        id: 'ollama',
        label: '本机 Ollama',
        base_url: 'http://127.0.0.1:11434/v1',
        model: 'llama3.1',
        region: 'cn',
      },
    ],
  },
]

// ── 小工具 ─────────────────────────────────────────────────────────────

/** `provider_id/model`——网关的价目表与 `findProvider` 都按这个键。 */
export function modelIdOf(config: { id: string; model: string }): string {
  return `${config.id}/${config.model}`
}

class ModelsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ModelsError'
  }
}

const notFound = (m: string): ModelsError => new ModelsError('not_found', m)
const invalid = (m: string, d?: unknown): ModelsError => new ModelsError('invalid_input', m, d)

/**
 * 只留下真的想改的那几个键。
 *
 * `exactOptionalPropertyTypes` 下 `{ a: undefined }` 与 `{}` 是两回事，
 * 所以返回类型也把 `undefined` 从值里摘掉——不然赋回去还是不合法。
 */
function defined<T extends object>(
  input: T,
): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<{
    [K in keyof T]: Exclude<T[K], undefined>
  }>
}

/** 今天零点（按 UTC；工作区时区的日切在 work 那边，这里只是个默认起点）。 */
function startOfDay(at: string): string {
  return `${at.slice(0, 10)}T00:00:00.000Z`
}

const EMPTY_ROW = (purpose: ModelPurpose): ModelUsageRow => ({
  purpose,
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cost_base: 0,
})

// ── 装配 ───────────────────────────────────────────────────────────────

export function createModels(options: ModelsOptions): ModelsAssembly {
  const { clock, gateway, secrets, env } = options
  const stateFile = options.dbDir === undefined ? undefined : join(options.dbDir, 'models.json')

  let state: ModelsStateFile = { version: 1, providers: [], defaults: {}, tests: {} }
  if (stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as ModelsStateFile
      state = {
        version: 1,
        providers: parsed.providers ?? [],
        defaults: parsed.defaults ?? {},
        tests: parsed.tests ?? {},
      }
    } catch {
      // 第一次跑，或者文件坏了：从空开始。加密库里的 key 不受影响
    }
  }
  const flush = (): void => {
    if (stateFile === undefined) return
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  const keyOf = (id: string): string => `${MODEL_KEY_PREFIX}${id}`

  /** 这条 provider 有没有 key（不读值，只看在不在）。 */
  const hasKey = (id: string): boolean => {
    if (id === ENV_PROVIDER_ID && envKey() !== undefined) return true
    if (!secrets.available) return false
    return secrets.record(keyOf(id)) !== undefined
  }

  const envKey = (): string | undefined => {
    const raw = env[DEEPSEEK_KEY_ENV]
    return raw === undefined || raw.trim() === '' ? undefined : raw.trim()
  }

  /**
   * key 的取值回调。**每次请求现取**：改完设置下一次调用自然就是新的，
   * 而且 key 不在任何配置对象里长住。
   */
  const keySource = (id: string) => (): string | undefined => {
    if (secrets.available) {
      try {
        const fields = secrets.get(keyOf(id))
        const key = fields?.api_key
        if (key !== undefined && key !== '') return key
      } catch {
        // 换过秘密库密钥：当成"没有 key"，界面上那条会显示 inactive
      }
    }
    // 环境变量兜底只对那条固定 id 生效（无界面部署走这条）
    return id === ENV_PROVIDER_ID ? envKey() : undefined
  }

  /** 环境变量给了 key 但设置页里还没有这条：兜出一条，界面上标 from_env。 */
  const effectiveConfigs = (): ModelProviderConfig[] => {
    const rows = [...state.providers]
    if (envKey() !== undefined && !rows.some((p) => p.id === ENV_PROVIDER_ID)) {
      rows.unshift({
        id: ENV_PROVIDER_ID,
        kind: 'deepseek',
        label: 'DeepSeek 官方（环境变量）',
        base_url: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        region: 'cn',
        price_in: 0.27,
        price_out: 1.1,
        price_cached: 0.07,
      })
    }
    return rows
  }

  const fromEnvOnly = (id: string): boolean =>
    id === ENV_PROVIDER_ID && !state.providers.some((p) => p.id === ENV_PROVIDER_ID)

  /** 一条配置 → 一个真 provider。缺 key 就不装（网关上没有它，选它会报没注册）。 */
  const buildProvider = (config: ModelProviderConfig): ModelProvider | undefined => {
    if (!hasKey(config.id)) return undefined
    return openaiCompatibleProvider({
      baseUrl: config.base_url,
      apiKey: keySource(config.id),
      model: config.model,
      provider: config.id,
      region: config.region,
      env,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(config.embedding_model === undefined ? {} : { embeddingModel: config.embedding_model }),
      ...(config.transcription_model === undefined
        ? {}
        : { transcriptionModel: config.transcription_model }),
    })
  }

  const activeConfigs = (): ModelProviderConfig[] => effectiveConfigs().filter((c) => hasKey(c.id))

  /** 现在应该用哪个 ModelRef 当默认。一个都没配就是 stub（运行时据此落回 stub）。 */
  const defaultRef = (): ModelRef => {
    const active = activeConfigs()
    const wanted = state.defaults.default
    const byId = wanted === undefined ? undefined : active.find((c) => modelIdOf(c) === wanted)
    const picked = byId ?? active[0]
    if (picked === undefined) return STUB_REF
    return { provider: picked.id, model: picked.model, region: picked.region }
  }

  const refOf = (id: string | undefined): ModelRef | undefined => {
    if (id === undefined) return undefined
    const hit = activeConfigs().find((c) => modelIdOf(c) === id)
    return hit === undefined
      ? undefined
      : { provider: hit.id, model: hit.model, region: hit.region }
  }

  const policyOf = (): ModelGatewayPolicy => {
    const prices: ModelGatewayPolicy['prices'] = { ...STUB_PRICES }
    for (const c of activeConfigs()) {
      prices[modelIdOf(c)] = {
        in: c.price_in ?? 0,
        out: c.price_out ?? 0,
        cached: c.price_cached ?? 0,
      }
    }
    const by_purpose: Partial<Record<ModelPurpose, ModelRef>> = {}
    for (const [purpose, id] of Object.entries(state.defaults.by_purpose ?? {})) {
      const ref = refOf(id)
      if (ref !== undefined) by_purpose[purpose as ModelPurpose] = ref
    }
    const budget = state.defaults.budget ?? {}
    return {
      default: defaultRef(),
      ...(Object.keys(by_purpose).length === 0 ? {} : { by_purpose }),
      // 一条都没配时驻留仍按 cn（stub 是 cn），配了境外模型就得允许 any
      data_residency: state.defaults.data_residency ?? 'cn',
      prices,
      budget: defined(budget),
    }
  }

  /**
   * 把当前配置推给网关。**这就是"热更新"**——保存 / 删除 / 改默认之后各调一次。
   *
   * 一条 provider 都装不上时仍然挂一个 stub：运行时与会议管线拿到的网关永远是能用的，
   * 只是回的是确定性假话（而且首页会有一条黄条告诉用户去接模型）。
   */
  const reassemble = (): void => {
    const providers: ModelProvider[] = []
    for (const config of activeConfigs()) {
      const provider = buildProvider(config)
      if (provider !== undefined) providers.push(provider)
    }
    if (providers.length === 0) providers.push(stubProvider({ seed: 7 }))
    gateway.reconfigure({ providers, policy: policyOf() })
  }

  reassemble()

  const viewOf = (config: ModelProviderConfig): ModelProviderView => {
    const has_key = hasKey(config.id)
    const test = state.tests[config.id]
    return {
      id: config.id,
      kind: config.kind,
      label: config.label,
      base_url: config.base_url,
      model: config.model,
      ...(config.embedding_model === undefined ? {} : { embedding_model: config.embedding_model }),
      ...(config.transcription_model === undefined
        ? {}
        : { transcription_model: config.transcription_model }),
      region: config.region,
      has_key,
      active: has_key,
      ...(has_key
        ? {}
        : {
            inactive_reason: secrets.available
              ? '还没填 API key'
              : `这台机器没有秘密库密钥（环境变量 ${SECRETS_KEY_ENV}），key 无处安全存放`,
          }),
      ...(config.price_in === undefined ? {} : { price_in: config.price_in }),
      ...(config.price_out === undefined ? {} : { price_out: config.price_out }),
      ...(config.price_cached === undefined ? {} : { price_cached: config.price_cached }),
      ...(test === undefined ? {} : { last_test: test }),
      ...(fromEnvOnly(config.id) ? { from_env: true } : {}),
    }
  }

  const defaultsView = (): ModelDefaultsView => {
    const active = activeConfigs()
    const budget = state.defaults.budget ?? {}
    return {
      default: state.defaults.default ?? (active[0] === undefined ? '' : modelIdOf(active[0])),
      by_purpose: { ...state.defaults.by_purpose },
      data_residency: state.defaults.data_residency ?? 'cn',
      budget: defined(budget),
      choices: active.map((c) => ({ id: modelIdOf(c), label: `${c.label}（${c.model}）` })),
    }
  }

  const port: ModelsPort = {
    templates: () => MODEL_TEMPLATES.map((t) => ({ ...t })),

    providers: () => effectiveConfigs().map(viewOf),

    /**
     * **唯一接触 key 原文的方法。**
     *
     * `input.api_key` 进来之后只做一件事：写进本机 AES-256-GCM 加密库。
     * 不抄进 `state`（那是明文 JSON）、不进事件、不进返回值、不进日志。
     * 不给 `api_key` 就是"别动已经存着的那一把"——改个模型名不用重填 key。
     */
    save(_actor: ModelsActor, id: string, input: SaveModelProviderInput): ModelProviderView {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
        throw invalid('provider 的 id 只能是小写字母、数字、下划线和短横线（32 位以内）')
      }
      const template = MODEL_TEMPLATES.find((t) => t.kind === input.kind)
      if (template === undefined) throw invalid(`不认识的模型种类：${input.kind}`)
      const key = input.api_key?.trim()
      if (key !== undefined && key !== '') {
        if (!secrets.available) {
          throw invalid(
            `这台机器没有秘密库密钥（环境变量 ${SECRETS_KEY_ENV}），API key 无处安全存放。` +
              '桌面壳会在首次启动时生成它；直接跑服务进程时请自己生成一把 32 字节密钥再启动。',
          )
        }
        // 值在这里第一次也是最后一次被本模块持有
        secrets.put(keyOf(id), { api_key: key })
      }
      const existing = state.providers.find((p) => p.id === id)
      const config: ModelProviderConfig = {
        id,
        kind: input.kind,
        label: input.label?.trim() ?? existing?.label ?? template.label,
        base_url: input.base_url?.trim() ?? existing?.base_url ?? template.default_base_url,
        model: input.model.trim(),
        region: input.region ?? existing?.region ?? template.region,
        ...defined({
          embedding_model: input.embedding_model ?? existing?.embedding_model,
          transcription_model: input.transcription_model ?? existing?.transcription_model,
          price_in: input.price_in ?? existing?.price_in,
          price_out: input.price_out ?? existing?.price_out,
          price_cached: input.price_cached ?? existing?.price_cached,
        }),
      }
      if (existing === undefined) state.providers.push(config)
      else state.providers[state.providers.indexOf(existing)] = config
      // 第一条能用的 provider 自动成为默认，用户不用再去下拉框里点一次
      if (state.defaults.default === undefined && hasKey(id)) {
        state.defaults.default = modelIdOf(config)
      }
      flush()
      reassemble()
      return viewOf(config)
    },

    remove(_actor, id) {
      const at = state.providers.findIndex((p) => p.id === id)
      if (at < 0 && !fromEnvOnly(id)) throw notFound(`没有这个 provider：${id}`)
      if (fromEnvOnly(id)) {
        throw invalid(
          `这一条是环境变量 ${DEEPSEEK_KEY_ENV} 给的，界面上删不掉；把那个环境变量去掉再重启即可`,
        )
      }
      const removed = state.providers[at]
      state.providers.splice(at, 1)
      delete state.tests[id]
      if (removed !== undefined && state.defaults.default === modelIdOf(removed)) {
        delete state.defaults.default
      }
      for (const [purpose, value] of Object.entries(state.defaults.by_purpose ?? {})) {
        if (removed !== undefined && value === modelIdOf(removed)) {
          delete state.defaults.by_purpose?.[purpose as ModelPurpose]
        }
      }
      if (secrets.available) secrets.remove(keyOf(id))
      flush()
      reassemble()
    },

    /**
     * 试跑：经网关走一次最小 `complete`（`purpose: 'judge'`，十来个 token）。
     *
     * 为什么经网关而不是直接打 provider：要一并验证驻留策略、预算、价目表都配对了——
     * 用户点"测试"要的是"这条路整条通不通"，不是"这个 URL 能不能连"。
     * 回的是延迟与模型名，**永远没有 key**。
     */
    async test(actor, id): Promise<ModelTestResult> {
      const config = effectiveConfigs().find((c) => c.id === id)
      if (config === undefined) throw notFound(`没有这个 provider：${id}`)
      const checked_at = clock.now()
      if (!hasKey(id)) {
        const result: ModelTestResult = {
          ok: false,
          reason: 'no_key',
          detail: '还没填 API key，先保存一把再测',
          checked_at,
        }
        state.tests[id] = result
        flush()
        return result
      }
      const startedAt = Date.parse(clock.now())
      let result: ModelTestResult
      try {
        const completion = await gateway.complete({
          model: { provider: config.id, model: config.model, region: config.region },
          messages: [
            { role: 'system', content: '只回一个字：好' },
            { role: 'user', content: '在吗' },
          ],
          meta: {
            workspace_id: actor.workspace_id,
            assignment_id: actor.assignment_id,
            role_id: actor.role_id,
            run_id: `run_model_test_${id}`,
            purpose: 'judge',
          },
        })
        result = {
          ok: true,
          reason: 'ok',
          model: `${completion.model.provider}/${completion.model.model}`,
          duration_ms: Math.max(0, Date.parse(clock.now()) - startedAt),
          detail: `通了：回了 ${completion.text.trim().length} 个字，用了 ${completion.usage.input_tokens + completion.usage.output_tokens} 个 token`,
          checked_at,
        }
      } catch (e) {
        result = {
          ok: false,
          reason: codeOf(e),
          // 上游报错原文里不会有 key（provider 只把它放进 header），但仍然截短
          detail: humanizeModelError(codeOf(e), messageOf(e)),
          duration_ms: Math.max(0, Date.parse(clock.now()) - startedAt),
          checked_at,
        }
      }
      state.tests[id] = result
      flush()
      return result
    },

    defaults: () => defaultsView(),

    setDefaults(_actor, input: SetModelDefaultsInput) {
      if (input.default !== undefined) {
        if (refOf(input.default) === undefined) {
          throw invalid(`这个模型现在用不了（没配或者没填 key）：${input.default}`)
        }
        state.defaults.default = input.default
      }
      if (input.by_purpose !== undefined) {
        const next: Partial<Record<ModelPurpose, string>> = {}
        for (const [purpose, id] of Object.entries(input.by_purpose)) {
          if (id === undefined || id === '') continue
          if (refOf(id) === undefined) throw invalid(`这个模型现在用不了：${id}`)
          next[purpose as ModelPurpose] = id
        }
        state.defaults.by_purpose = next
      }
      if (input.data_residency !== undefined) state.defaults.data_residency = input.data_residency
      if (input.budget !== undefined) state.defaults.budget = defined(input.budget)
      flush()
      reassemble()
      return defaultsView()
    },

    async usage(actor, since): Promise<ModelUsageView> {
      const from = since ?? startOfDay(clock.now())
      const rows = new Map<ModelPurpose, ModelUsageRow>()
      for (const record of gateway.records()) {
        if (record.workspace_id !== actor.workspace_id) continue
        if (record.at < from) continue
        const row = rows.get(record.purpose) ?? EMPTY_ROW(record.purpose)
        row.calls += 1
        row.input_tokens += record.input_tokens
        row.output_tokens += record.output_tokens
        row.cached_tokens += record.cached_tokens
        row.cost_base += record.cost_base
        rows.set(record.purpose, row)
      }
      const list = [...rows.values()].sort((a, b) => b.cost_base - a.cost_base)
      const total = list.reduce<ModelUsageRow | undefined>((acc, row) => {
        if (acc === undefined) return { ...row, purpose: row.purpose }
        return {
          purpose: acc.purpose,
          calls: acc.calls + row.calls,
          input_tokens: acc.input_tokens + row.input_tokens,
          output_tokens: acc.output_tokens + row.output_tokens,
          cached_tokens: acc.cached_tokens + row.cached_tokens,
          cost_base: acc.cost_base + row.cost_base,
        }
      }, undefined)
      return {
        since: from,
        rows: list,
        total,
        budget: await gateway.budget({ workspace_id: actor.workspace_id }),
      }
    },

    configured: () => activeConfigs().length > 0,
  }

  return {
    port,
    configured: () => activeConfigs().length > 0,
    defaultRef,
  }
}

// ── 错误 → 人话 ────────────────────────────────────────────────────────

function codeOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'provider_error'
}

/**
 * 试跑失败时**真正的**那句原文。
 *
 * 坑在这里：网关把每一次 provider 失败都收进 `details.attempts`，自己只抛一句
 * `provider_unavailable: all providers failed`。照那句话翻，用户点"测试"永远只看到
 * "连不上这个地址"——哪怕真实原因是 key 填错了（401）或者余额不足（402）。
 * 所以先钻进 `attempts` 拿最后一次的 status 与原文，钻不进去才用外层那句。
 */
function messageOf(e: unknown): string {
  const attempt = lastAttempt(e)
  if (attempt !== undefined) {
    const status = attempt.status === undefined ? '' : `HTTP ${attempt.status} `
    return `${status}${attempt.message}`.slice(0, 200)
  }
  return (e instanceof Error ? e.message : String(e)).slice(0, 200)
}

/** 网关 `ProviderDownPayload.attempts` 的最后一条（降级链上最后一次尝试）。 */
function lastAttempt(e: unknown): { status?: number; message: string } | undefined {
  if (typeof e !== 'object' || e === null || !('details' in e)) return undefined
  const details = (e as { details: unknown }).details
  if (typeof details !== 'object' || details === null || !('attempts' in details)) return undefined
  const attempts = (details as { attempts: unknown }).attempts
  if (!Array.isArray(attempts) || attempts.length === 0) return undefined
  const last = attempts[attempts.length - 1] as { status?: unknown; message?: unknown }
  if (typeof last.message !== 'string') return undefined
  return {
    ...(typeof last.status === 'number' ? { status: last.status } : {}),
    message: last.message,
  }
}

/** 试跑失败的中文人话。原文只在括号里当补充。 */
export function humanizeModelError(code: string, message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key'))
    return `API key 不对或者已经失效，去控制台重新生成一把（${message}）`
  if (lower.includes('402') || lower.includes('insufficient') || lower.includes('balance'))
    return `这个账号余额不足，去控制台充一点（${message}）`
  if (lower.includes('404') || lower.includes('model not found'))
    return `模型名或接口地址不对：这家没有你填的那个模型（${message}）`
  if (lower.includes('429')) return `请求太频繁了，等一会儿再点一次（${message}）`
  switch (code) {
    case 'residency_blocked':
    case 'forbidden':
      return `数据驻留设成了"只用境内"，但这个模型在境外。要么换模型，要么把驻留改成 any（${message}）`
    case 'budget_exhausted':
      return `预算用完了，先把上限调高再测（${message}）`
    case 'provider_unavailable':
      return `连不上这个地址：检查接口地址、网络，本地模型的话看看它起来了没有（${message}）`
    case 'invalid_input':
      return `配置不完整：${message}`
    default:
      return `没通：${message}`
  }
}
