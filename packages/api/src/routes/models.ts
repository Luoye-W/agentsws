/**
 * 模型面（WP25 交付 C）：22 模型网关的 HTTP 投影。
 *
 * 在这之前，工作台上根本没有"接模型"这一项——不设 `DEEPSEEK_API_KEY` 环境变量就只有
 * stub 运行时，Agent 一句话都说不出来。这一组路由把它补上：原生表单填 key、
 * 按 purpose 选模型、三级预算与数据驻留、一张按 purpose 汇总的花费小表。
 *
 * 三条边界，和连接面（`routes/connections.ts`）一模一样：
 *
 * 1. **key 只走 `PUT /v1/models/providers/:id` 这一条路，而且只走一次。** 请求体里的
 *    `api_key` 由处理器原样交给端口，端口写进本机 AES-256-GCM 加密库，
 *    然后**没有任何一处**再持有它：不进事件日志、不进 trace、不进响应体、不进 OpenAPI 示例，
 *    `GET /v1/models/providers` 里连密文都没有，只有一个 `has_key: true`。
 * 2. **网关里不写业务**（28 §2）：怎么装配 provider、怎么热更新、怎么试跑，
 *    全在 `apps/server/src/models.ts` 里；这一层只做路由声明、权限判定与信封。
 * 3. **权限是 owner 的**（05）：模型 key 是花钱的东西，客服岗位看不到也改不了。
 *    读走 `store_config.read@workspace`，改走 `policy.stage@workspace`——
 *    和连接面同一套元组，理由也一样：这属于策略层，永远 L1。
 */
import type { MaybePromise, ModelPurpose, ModelRef } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

const TAG = 'models'

/** 22 的五个 purpose + WP23 的转写。设置页按它分组选默认模型。 */
export const MODEL_PURPOSES: readonly ModelPurpose[] = [
  'run',
  'extraction',
  'reflection',
  'embedding',
  'judge',
  'transcription',
]

// ── 端口类型（apps/server 实现）────────────────────────────────────────

/** 一个 provider 卡的种类。 */
export type ModelProviderKind =
  /** DeepSeek 官方（OpenAI 兼容形态，`https://api.deepseek.com`）。 */
  | 'deepseek'
  /** 任何 OpenAI 兼容网关：OpenAI 本身、Moonshot、通义、智谱、本地 Ollama…… */
  | 'openai_compatible'

/**
 * 一个 provider 的对外形状。**这里没有、也不会有 key 字段。**
 *
 * `has_key` 是唯一与凭据有关的信息——"这台机器上有没有存过一把"，
 * 一个布尔值，看不出长度、看不出前缀。
 */
export interface ModelProviderView {
  id: string
  kind: ModelProviderKind
  label: string
  /** 请求发到哪儿（不是秘密，用户自己填的）。 */
  base_url: string
  /** 主模型名（`deepseek-chat` / `gpt-4o-mini` / `qwen-plus` / `llama3.1`…）。 */
  model: string
  /** 给了才暴露 embed。 */
  embedding_model?: string
  /** 给了才暴露 transcribe（ASR）。 */
  transcription_model?: string
  /** 22 §2 数据驻留：这家在境内还是境外。 */
  region: 'cn' | 'global'
  /** 这台机器上存过 key 没有。**永远只是布尔值。** */
  has_key: boolean
  /** 现在这一份配置有没有真的挂在网关上（缺 key 就挂不上）。 */
  active: boolean
  /** 挂不上的原因（人话）。 */
  inactive_reason?: string
  /** 每百万 token 的价格（用户自己填，用于预算记账）；不填按 0 记。 */
  price_in?: number
  price_out?: number
  price_cached?: number
  /** 上次"测试"的结果。 */
  last_test?: ModelTestResult
  /** 这一条是环境变量给的（`DEEPSEEK_API_KEY`），界面上不给删。 */
  from_env?: boolean
}

/** 可以新建哪几种 provider——界面照着画卡片，文案在这里，不在前端。 */
export interface ModelProviderTemplate {
  kind: ModelProviderKind
  label: string
  summary: string
  default_base_url: string
  default_model: string
  region: 'cn' | 'global'
  /** ≤ 5 步的准备说明 + 外链，和连接面一个规格。 */
  steps: string[]
  links: { label: string; url: string }[]
  /** 常见的几个填法（Moonshot / 通义 / 智谱 / Ollama），点一下就把地址填好。 */
  presets?: {
    id: string
    label: string
    base_url: string
    model: string
    region: 'cn' | 'global'
  }[]
}

export interface ModelTestResult {
  ok: boolean
  reason?: string
  /** 人话。成功时是"回了 xx 字，用时 xx 毫秒"，**永远没有 key**。 */
  detail?: string
  /** 真正跑起来的那个模型（可能被降级过）。 */
  model?: string
  duration_ms?: number
  checked_at: string
}

/** 22 §2 的策略：默认模型 + 按 purpose 覆盖 + 驻留 + 三级预算。 */
export interface ModelDefaultsView {
  /** `provider_id/model`，与 `ModelProviderView.id` 对齐。 */
  default: string
  by_purpose: Partial<Record<ModelPurpose, string>>
  data_residency: 'cn' | 'any'
  budget: {
    workspace_daily_base?: number
    workspace_monthly_base?: number
    assignment_daily_base?: number
  }
  /** 可选的模型清单（`provider_id/model`），给下拉框用。 */
  choices: { id: string; label: string }[]
}

export interface ModelUsageRow {
  purpose: ModelPurpose
  calls: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cost_base: number
}

export interface ModelUsageView {
  since: string
  rows: ModelUsageRow[]
  total: ModelUsageRow | undefined
  /** 三级预算现在用了多少（`budget()` 的工作区档）。 */
  budget: { used_base: number; cap_base: number; frozen: boolean }
}

/** 改策略的入参。可选项一律显式带 `| undefined`（exactOptionalPropertyTypes）。 */
export interface SetModelDefaultsInput {
  default?: string | undefined
  by_purpose?: Partial<Record<ModelPurpose, string>> | undefined
  data_residency?: 'cn' | 'any' | undefined
  budget?:
    | {
        workspace_daily_base?: number | undefined
        workspace_monthly_base?: number | undefined
        assignment_daily_base?: number | undefined
      }
    | undefined
}

export interface ModelsActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

/** 保存一个 provider 的入参。**`api_key` 是唯一携带凭据原文的字段。** */
export interface SaveModelProviderInput {
  kind: ModelProviderKind
  label?: string | undefined
  base_url?: string | undefined
  model: string
  embedding_model?: string | undefined
  transcription_model?: string | undefined
  region?: 'cn' | 'global' | undefined
  /** 不给就是"别动已经存着的那一把"（改个模型名不用重填 key）。 */
  api_key?: string | undefined
  price_in?: number | undefined
  price_out?: number | undefined
  price_cached?: number | undefined
}

export interface ModelsPort {
  templates(actor: ModelsActor): MaybePromise<ModelProviderTemplate[]>
  providers(actor: ModelsActor): MaybePromise<ModelProviderView[]>
  /** **唯一**接触 key 原文的方法。实现必须写进加密库后立即遗忘。 */
  save(
    actor: ModelsActor,
    id: string,
    input: SaveModelProviderInput,
  ): MaybePromise<ModelProviderView>
  remove(actor: ModelsActor, id: string): MaybePromise<void>
  /** 经网关跑一次最小 complete（`purpose: 'judge'`，十来个 token）。 */
  test(actor: ModelsActor, id: string): MaybePromise<ModelTestResult>
  defaults(actor: ModelsActor): MaybePromise<ModelDefaultsView>
  setDefaults(actor: ModelsActor, input: SetModelDefaultsInput): MaybePromise<ModelDefaultsView>
  usage(actor: ModelsActor, since?: string): MaybePromise<ModelUsageView>
  /** 这台机器上有没有能用的模型（首页那条黄条按它出现 / 消失）。 */
  configured(): boolean
}

/** 装配方给网关的 ModelRef 拆解（`provider/model`）。 */
export function parseModelId(id: string): ModelRef | undefined {
  const at = id.indexOf('/')
  if (at <= 0 || at === id.length - 1) return undefined
  return { provider: id.slice(0, at), model: id.slice(at + 1) }
}

// ── 校验 ───────────────────────────────────────────────────────────────

const KIND = z.enum(['deepseek', 'openai_compatible'])
const REGION = z.enum(['cn', 'global'])
const PURPOSE = z.enum(['run', 'extraction', 'reflection', 'embedding', 'judge', 'transcription'])

/**
 * 保存 provider 的请求体。
 *
 * `api_key` 只限长度，不限内容（各家 key 的字符集不一样），校验失败时 zod 的 issue
 * 只有 path 与 message——**不会把值抄进错误信封**，这是"零泄漏"断言的一条。
 */
const SaveBody = z.object({
  kind: KIND,
  label: z.string().min(1).max(64).optional(),
  base_url: z.string().min(1).max(512).optional(),
  model: z.string().min(1).max(128),
  embedding_model: z.string().min(1).max(128).optional(),
  transcription_model: z.string().min(1).max(128).optional(),
  region: REGION.optional(),
  api_key: z.string().min(1).max(4096).optional(),
  price_in: z.number().min(0).max(100_000).optional(),
  price_out: z.number().min(0).max(100_000).optional(),
  price_cached: z.number().min(0).max(100_000).optional(),
})

const DefaultsBody = z.object({
  default: z.string().min(1).max(256).optional(),
  /**
   * **必须是 `partialRecord`。** zod 4 的 `z.record(枚举, …)` 是**穷尽**的：
   * 少给一个 purpose 就整体 400。而这一版界面本来就是"只改 judge 那一格"，
   * 用 `record` 等于按 purpose 选模型这条路根本走不通（WP25 端到端测试逮到的）。
   */
  by_purpose: z.partialRecord(PURPOSE, z.string().min(1).max(256)).optional(),
  data_residency: z.enum(['cn', 'any']).optional(),
  budget: z
    .object({
      workspace_daily_base: z.number().min(0).max(1_000_000).optional(),
      workspace_monthly_base: z.number().min(0).max(1_000_000).optional(),
      assignment_daily_base: z.number().min(0).max(1_000_000).optional(),
    })
    .optional(),
})

function portOf(deps: GatewayDeps): ModelsPort {
  const p = deps.models
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配模型面（GatewayDeps.models）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): ModelsActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

const ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'provider 的 id（自己起的名字，比如 deepseek / my-ollama）',
} as const

export function modelRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/models/providers',
        operationId: 'listModelProviders',
        summary: '已配的模型 provider（**永不含 key**：只有 has_key 这个布尔值）+ 可新建的种类',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ providers: ModelProviderView[], templates: ModelProviderTemplate[] }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        const actor = actorOf(c)
        return ok(c, {
          providers: await port.providers(actor),
          templates: await port.templates(actor),
        })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/models/defaults',
        operationId: 'getModelDefaults',
        summary: '按 purpose 的默认模型、数据驻留、三级预算（22 §2）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ModelDefaultsView',
      },
      async (c, deps) => ok(c, await portOf(deps).defaults(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/models/defaults',
        operationId: 'setModelDefaults',
        summary: '改默认模型 / 驻留 / 预算；保存即生效，不重启进程',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: DefaultsBody,
        returns: 'ModelDefaultsView',
      },
      async (c, deps) => {
        const input = await body(c, DefaultsBody)
        return ok(c, await portOf(deps).setDefaults(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/models/usage',
        operationId: 'getModelUsage',
        summary: '按 purpose 汇总的调用与花费（22 §3），外加工作区预算用了多少',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'since',
            in: 'query',
            required: false,
            description: 'ISO 时间；不给就是今天零点起',
          },
        ],
        returns: 'ModelUsageView',
      },
      async (c, deps) => {
        const since = c.req.query('since')
        return ok(
          c,
          await portOf(deps).usage(actorOf(c), ...(since === undefined ? [] : ([since] as const))),
        )
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/models/providers/:id',
        operationId: 'saveModelProvider',
        summary:
          '原生表单直填 API key（13 §4.3）：值只走这一条到本机服务进程，写进加密库后即遗忘；不进事件日志、不进 trace、不进模型',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [ID_PARAM],
        body: SaveBody,
        returns: 'ModelProviderView（无 key）',
      },
      async (c, deps) => {
        const input = await body(c, SaveBody)
        // 处理器只把值往下传一次，自己不读、不记、不回显。
        return ok(c, await portOf(deps).save(actorOf(c), param(c, 'id'), input))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/models/providers/:id/test',
        operationId: 'testModelProvider',
        summary:
          '经网关跑一次最小 complete（purpose=judge，十来个 token）：回延迟与模型名，不回 key',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [ID_PARAM],
        returns: 'ModelTestResult',
      },
      async (c, deps) => ok(c, await portOf(deps).test(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'delete',
        path: '/v1/models/providers/:id',
        operationId: 'removeModelProvider',
        summary: '删掉一个 provider（key 随之从加密库删除）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [ID_PARAM],
        returns: '{ removed: true }',
      },
      async (c, deps) => {
        await portOf(deps).remove(actorOf(c), param(c, 'id'))
        return ok(c, { removed: true })
      },
    ),
  ]
}
