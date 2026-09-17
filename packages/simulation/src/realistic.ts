/**
 * realistic 档（26 §4 第二行）：**真模型可选、按预算**。
 *
 * 三件事和 fast 档不一样：
 * 1. Agent 走真模型（经 22 的网关，key 只从环境变量取，业务代码里 grep 不到 key）
 * 2. 合成人由真模型扮演——"这个人会不会批"由人设与卡片内容决定，不是掷骰子
 * 3. 客户来信由真模型按人设写
 *
 * 两条纪律让它仍然是**回归题**而不是抽奖：
 * - **同 seed 下客户来信的内容固定**：第一次经模型生成后落进 `out/realistic-cache/`，
 *   之后一律回放缓存。所以"上周红的那条"今天还能一模一样地红一次。
 * - **预算是硬的**：一次跑全部场景的 `cost_base` 之和不得超过 `--max-cost-base`，
 *   超了就停在那一条并把已跑的部分报出来（22 §3 预算三级里最外面那一级）。
 *
 * 没有 key 就整档跳过并说明——**不红**（26 §1：CI 无 key 时 replay 重打分）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ApprovalItem, DecisionAction, ModelProvider, ModelRef } from '@agentsws/contracts'
import type { PriceTable } from '@agentsws/model-gateway'
import { catalogPrice, openaiCompatibleProvider } from '@agentsws/model-gateway'
import type { Pack } from './pack.js'
import type { RealisticHooks } from './runner.js'
import type { World } from './world.js'

/** 环境变量名（**只读名字，不在代码里写值**）。 */
export const SIM_MODEL_ENV = {
  provider: 'AGENTSWS_SIM_MODEL_PROVIDER',
  model: 'AGENTSWS_SIM_MODEL_NAME',
  baseUrl: 'AGENTSWS_SIM_MODEL_BASE_URL',
  /** 装 key 的那个环境变量**叫什么**（默认 `AGENTSWS_SIM_MODEL_API_KEY`） */
  keyEnv: 'AGENTSWS_SIM_MODEL_API_KEY_ENV',
  key: 'AGENTSWS_SIM_MODEL_API_KEY',
  region: 'AGENTSWS_SIM_MODEL_REGION',
  priceIn: 'AGENTSWS_SIM_MODEL_PRICE_IN',
  priceOut: 'AGENTSWS_SIM_MODEL_PRICE_OUT',
  priceCached: 'AGENTSWS_SIM_MODEL_PRICE_CACHED',
} as const

/** DeepSeek 的默认档（22 §2 的默认模型）；价格是每百万 token 的基准货币。 */
const DEEPSEEK = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  region: 'cn' as const,
  price: { in: 0.27, out: 1.1, cached: 0.07 },
}

/**
 * **阿里云百炼·按量计费**那一档（WP88）。
 *
 * 为什么值得一个名字：realistic 档是整套里唯一一处"真花钱"的地方，而 Luoye 手上
 * 已经有百炼的账号——一个变量就把地址、地域、价目全带出来，剩下只要给一把 key，
 * 不用再去办别家的。（他实际买的是 Token Plan 订阅，那是下面那一档。）
 *
 * 默认模型 `qwen-plus`：￥0.8 / ￥2 每百万 token（2026-09-17 核官网），
 * 在百炼上属于便宜又够用的一档。想更省有 `qwen-turbo`，想更强有 `qwen3.8-max`，
 * DeepSeek 系（`deepseek-v4.1-flash` / `deepseek-r1`）是同一把 key、同一个地址——
 * 换 `AGENTSWS_SIM_MODEL_NAME` 一个变量就行，价目表里都有价。
 */
const BAILIAN = {
  provider: 'qwen',
  model: 'qwen-plus',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  region: 'cn' as const,
}

/**
 * 百炼的两个**订阅**档（WP88）。它们和上面那一档、以及彼此之间都是**三套互不通用**
 * 的东西：地址不同、key 不同（订阅档的 key 是 `sk-sp-` 开头）、计费方式也不同。
 * Luoye 实测：Token Plan 的 key 打标准口，国内国际都回 `401 invalid_api_key`。
 *
 * 两个订阅档都**不按 token 计费**（Token Plan 按 Credits、Coding Plan 按次数配额），
 * 所以价目表里三个价都是 0，`--max-cost-base` 在这两档**拦不住任何东西**——也没东西
 * 可拦：跑一轮不额外花钱，用掉的是订阅额度，剩多少只有百炼控制台算得出来。
 *
 * Token Plan 官方只支持华北2（北京），没有国际口。
 */
const BAILIAN_TOKEN_PLAN = {
  provider: 'qwen',
  model: 'qwen3.7-plus',
  baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  region: 'cn' as const,
}

/** Coding Plan 那一档。注意地址里**没有** `/compatible-mode`。 */
const BAILIAN_CODING = {
  provider: 'qwen',
  model: 'qwen3.7-plus',
  baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
  region: 'cn' as const,
}

/** `AGENTSWS_SIM_MODEL_PROVIDER` 写这几个名字之一，就按 {@link BAILIAN} 那一档来。 */
const BAILIAN_ALIASES = new Set(['bailian', 'dashscope', 'qwen', '百炼'])

/**
 * 订阅档的别名 → 走哪一档。
 *
 * **先于** {@link BAILIAN_ALIASES} 认：`bailian_token_plan` 里也含 `bailian`，
 * 顺序反了就落到按量那档上——于是拿订阅的 key 去打标准口，401。
 */
const BAILIAN_PLAN_ALIASES: Readonly<Record<string, typeof BAILIAN_TOKEN_PLAN>> = {
  bailian_token_plan: BAILIAN_TOKEN_PLAN,
  'bailian-token-plan': BAILIAN_TOKEN_PLAN,
  token_plan: BAILIAN_TOKEN_PLAN,
  'token-plan': BAILIAN_TOKEN_PLAN,
  tokenplan: BAILIAN_TOKEN_PLAN,
  bailian_coding: BAILIAN_CODING,
  'bailian-coding': BAILIAN_CODING,
  coding_plan: BAILIAN_CODING,
  'coding-plan': BAILIAN_CODING,
  codingplan: BAILIAN_CODING,
}

export interface ResolvedSimModel {
  provider: ModelProvider
  ref: ModelRef
  prices: PriceTable
  /** 报告里写清楚这次是拿谁跑的（**不含 key**）。 */
  describe: string
}

export type Env = Record<string, string | undefined>

/**
 * 从环境变量解析 realistic 档要用的模型。**没有 key 就返回 undefined**——
 * 调用方据此整档跳过（不是失败）。
 *
 * 认三档预设（WP88）：
 *
 * - 不写 `AGENTSWS_SIM_MODEL_PROVIDER` → DeepSeek 官方（老行为一个字没变）；
 * - 写 `bailian` / `dashscope` / `qwen` → 阿里云百炼**按量计费**那一档；
 * - 写 `bailian_token_plan` / `token_plan` → 百炼 **Token Plan 订阅**那一档；
 * - 写 `bailian_coding` / `coding_plan` → 百炼 **Coding Plan 订阅**那一档。
 *   （三套的地址、key、计费方式都不通用，见 `BAILIAN_TOKEN_PLAN` 上面那段。）
 *
 * 选中预设后地址、地域、模型名、价目全都跟着出来，只剩一把 key 要填。
 * 写别的名字就是"自定义"：地址与价自己给。
 *
 * 价的来源有三层，从可靠到兜底：
 * 1. `AGENTSWS_SIM_MODEL_PRICE_*` 三个变量（用户自己写死的，永远最优先）；
 * 2. **内置价目表**按 (接口地址, 模型名) 查——百炼、DeepSeek、OpenAI、Kimi、智谱都在里面；
 * 3. 查不到才落 DeepSeek 那三个数字。
 *
 * 第 2 层是 `--max-cost-base` 能拦得住人的前提：拿 DeepSeek 的美元价去算百炼的人民币
 * 花费，预算上限会差出好几倍。
 */
export function resolveSimModel(env: Env = process.env): ResolvedSimModel | undefined {
  const keyEnv = env[SIM_MODEL_ENV.keyEnv] ?? SIM_MODEL_ENV.key
  const hasOwnKey = (env[keyEnv] ?? '').trim().length > 0
  const hasDeepseek = (env.DEEPSEEK_API_KEY ?? '').trim().length > 0
  if (!hasOwnKey && !hasDeepseek) return undefined

  const named = (env[SIM_MODEL_ENV.provider] ?? '').trim()
  const lower = named.toLowerCase()
  // 订阅档先认：`bailian_token_plan` 里也含 `bailian`，顺序反了就落到按量那档上，
  // 于是拿订阅的 key 去打标准口——401（Luoye 实测），或者更糟：被当按量付费扣钱
  const plan = BAILIAN_PLAN_ALIASES[lower]
  const isBailian = plan !== undefined || BAILIAN_ALIASES.has(lower)
  const preset = plan ?? (isBailian ? BAILIAN : DEEPSEEK)
  // 百炼那几个别名一律归成 `qwen`——22 §1 的 `ModelRef.provider` 是个固定小表，
  // 记账与报表按它归类，不该因为用户写了 `bailian` 还是 `dashscope` 分成两家
  const provider = named === '' || isBailian ? preset.provider : named
  const model = env[SIM_MODEL_ENV.model] ?? preset.model
  const baseUrl = env[SIM_MODEL_ENV.baseUrl] ?? preset.baseUrl
  const region = (env[SIM_MODEL_ENV.region] ?? preset.region) as 'cn' | 'global'
  const num = (raw: string | undefined, fallback: number): number => {
    const v = Number.parseFloat(raw ?? '')
    return Number.isFinite(v) ? v : fallback
  }
  // 内置价目表里这个 (地址, 模型) 的价；查不到就落 DeepSeek 那三个数字
  const listed = catalogPrice(baseUrl, model)
  const base = listed ?? DEEPSEEK.price
  const ref: ModelRef = { provider: provider as ModelRef['provider'], model, region }
  return {
    ref,
    provider: openaiCompatibleProvider({
      baseUrl,
      // key 只经环境变量名传进去，取值在 provider 内部现取现用，不落任何变量
      apiKeyEnv: hasOwnKey ? keyEnv : 'DEEPSEEK_API_KEY',
      model,
      provider,
      region,
      env,
    }),
    prices: {
      [`${provider}/${model}`]: {
        in: num(env[SIM_MODEL_ENV.priceIn], base.in),
        out: num(env[SIM_MODEL_ENV.priceOut], base.out),
        cached: num(env[SIM_MODEL_ENV.priceCached], base.cached),
      },
    },
    describe:
      `${provider}/${model} @ ${baseUrl}（key 来自环境变量 ${hasOwnKey ? keyEnv : 'DEEPSEEK_API_KEY'}）` +
      // 价是哪儿来的要写在报告里：`--max-cost-base` 拦不拦得住人全看这三个数字
      (listed === undefined
        ? ''
        : listed.in === 0 && listed.out === 0
          ? `；${listed.vendor_label}——订阅内，不按 token 计价，所以花费一律记 0（--max-cost-base 在这一档不拦任何东西），token 照记`
          : `；价按内置价目表的 ${listed.vendor_label}（${listed.currency}，${listed.as_of} 核对官网）`),
  }
}

/**
 * 客户来信缓存（`out/realistic-cache/`）。
 *
 * 键 = (pack, 场景 id, 事件序号, seed, 发件人, 主题) 的哈希。第一次跑写盘，之后回放。
 * 这是 realistic 档"同 seed 可复现"的全部秘密——模型不确定，但**同一条键只问一次模型**。
 */
export class RealisticCache {
  readonly dir: string
  private readonly mem = new Map<string, string>()
  /** 这次跑里有几条是从盘上回放的 / 新写进去的 */
  hits = 0
  writes = 0

  constructor(dir: string) {
    this.dir = resolve(dir)
  }

  static keyOf(parts: readonly (string | number)[]): string {
    return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)
  }

  get(key: string): string | undefined {
    const cached = this.mem.get(key)
    if (cached !== undefined) return cached
    const file = join(this.dir, `${key}.txt`)
    if (!existsSync(file)) return undefined
    const text = readFileSync(file, 'utf8')
    this.mem.set(key, text)
    this.hits += 1
    return text
  }

  put(key: string, text: string): void {
    this.mem.set(key, text)
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, `${key}.txt`), text, 'utf8')
    this.writes += 1
  }
}

/** 预算闸门（22 §3）：跑到超了就不再开下一条场景。 */
export class CostGuard {
  readonly cap: number
  spent = 0

  constructor(cap: number) {
    this.cap = cap
  }

  add(cost: number): void {
    this.spent += cost
  }

  get remaining(): number {
    return Math.max(0, this.cap - this.spent)
  }

  get exhausted(): boolean {
    return this.spent >= this.cap
  }
}

const ORDER_RE = /#(\d{3,})/

export interface RealisticHookOptions {
  world: World
  pack: Pack
  cache: RealisticCache
  guard: CostGuard
  /** 人设不确定时的兜底：直接照场景写的决定走。 */
  strict?: boolean
}

/**
 * 装出 realistic 档的两个钩子。两者都**失败即退回确定性行为**——
 * 模型抽风不该让一条回归题变成红的（26 原则 ④：替身跑通不等于上线可靠，反之亦然）。
 */
export function createRealisticHooks(opts: RealisticHookOptions): RealisticHooks {
  const { world, pack, cache, guard } = opts
  const complete = async (system: string, user: string, run_id: string): Promise<string> => {
    if (guard.exhausted) return ''
    const res = await world.gateway().complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      seed: 0,
      max_cost_base: Math.max(0.01, guard.remaining),
      meta: {
        workspace_id: world.workspace_id,
        assignment_id: world.assignment.id,
        role_id: world.assignment.role_id,
        run_id,
        purpose: 'reflection',
      },
    })
    guard.add(res.usage.cost_base)
    return res.text.trim()
  }

  return {
    async writeInbound(input) {
      const key = RealisticCache.keyOf([
        pack.manifest.pack,
        input.scenario,
        input.index,
        pack.manifest.seed,
        input.from,
        input.subject,
      ])
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      const customer = pack.customerByEmail(input.from)
      const persona =
        customer === undefined ? input.from : `${customer.name}（${customer.market} 市场）`
      try {
        const text = await complete(
          '你在扮演一位网店客户，用客户自己的语气写一封邮件。只输出邮件正文，不要主题行、不要解释。' +
            '保留原信里出现的订单号与诉求，不要新增事实，不要写"作为一个 AI"。',
          `客户：${persona}\n主题：${input.subject}\n他想说的事（照这个意思重写成自然的一封信）：\n${input.fallback}`,
          `realistic_inbound_${key}`,
        )
        // 订单号丢了就等于把场景改了：宁可用 fixture，也不要一条对不上的回归题
        const wantOrder = ORDER_RE.exec(input.fallback)?.[0]
        if (text.length < 20 || (wantOrder !== undefined && !text.includes(wantOrder))) {
          return input.fallback
        }
        cache.put(key, text)
        return text
      } catch {
        return input.fallback
      }
    },

    async decide(input) {
      const person = pack.people.find((p) => p.id === input.person)
      const summary = summarize(input.item)
      try {
        const text = await complete(
          '你在扮演一位网店的同事，正在工作台上处置一张待办卡。' +
            '只输出一个词：approve、approve_edited 或 reject；如果是 reject，第二行写一句中文原因。',
          `你的身份：${person?.title ?? input.person}（${person?.name ?? input.person}）\n` +
            `卡片：${summary}\n` +
            `你的习惯做法是 ${input.action}。除非卡片里有明显问题，否则按习惯走。`,
          `realistic_decide_${input.item.id}`,
        )
        const first = text.split('\n')[0]?.trim().toLowerCase() ?? ''
        const action: DecisionAction | undefined = (
          ['approve_edited', 'approve', 'reject'] as const
        ).find((a) => first.startsWith(a))
        if (action === undefined) return { action: input.action }
        const reason = text.split('\n').slice(1).join(' ').trim()
        return {
          action,
          ...(action === 'reject' && reason.length > 0 ? { reason } : {}),
          ...(action === 'reject' && reason.length === 0 ? { reason: '合成人（真模型）驳回' } : {}),
        }
      } catch {
        return { action: input.action }
      }
    },
  }
}

function summarize(item: ApprovalItem): string {
  const payload = item.payload as { body?: { subject?: unknown; text?: unknown } }
  const body = String(payload.body?.text ?? '')
  return `[${item.kind}] ${item.title}\n${item.summary}\n${body.slice(0, 800)}`
}
