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

/**
 * DeepSeek 的默认档（22 §2 的默认模型）；价格是每百万 token 的基准货币。
 *
 * WP87：模型名从 `deepseek-chat` 改成 `deepseek-flash`——`deepseek-chat` 已经不在官方
 * `GET /models` 的清单里（WP42 那次对着官网真页面核过，见 docs/35 2026-09-10 那条），
 * 拿它去跑 realistic 档只会在第一次调用上 404。价钱**不再写死在这里**，改成查
 * `PRICE_CATALOG`（`packages/model-gateway/src/pricing/catalog.json`，每条带 `source_url`
 * 与 `as_of`，每周一自动刷）：一处价一份出处，不再有第二份会过期的数字。
 * 下面这三个数只是查不到时的兜底，与 catalog 里 2026-09-10 那份 deepseek-flash 一致。
 */
const DEEPSEEK = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com',
  region: 'cn' as const,
  price: { in: 0.3, out: 1.2, cached: 0.006 },
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
 */
export function resolveSimModel(env: Env = process.env): ResolvedSimModel | undefined {
  const keyEnv = env[SIM_MODEL_ENV.keyEnv] ?? SIM_MODEL_ENV.key
  const hasOwnKey = (env[keyEnv] ?? '').trim().length > 0
  const hasDeepseek = (env.DEEPSEEK_API_KEY ?? '').trim().length > 0
  if (!hasOwnKey && !hasDeepseek) return undefined

  const provider = env[SIM_MODEL_ENV.provider] ?? DEEPSEEK.provider
  const model = env[SIM_MODEL_ENV.model] ?? DEEPSEEK.model
  const baseUrl = env[SIM_MODEL_ENV.baseUrl] ?? DEEPSEEK.baseUrl
  const region = (env[SIM_MODEL_ENV.region] ?? DEEPSEEK.region) as 'cn' | 'global'
  const num = (raw: string | undefined, fallback: number): number => {
    const v = Number.parseFloat(raw ?? '')
    return Number.isFinite(v) ? v : fallback
  }
  // 环境变量没写价就查内置价目表（按接口地址认家、按模型名认价；认不出来才用兜底）
  const listed = catalogPrice(baseUrl, model)
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
        in: num(env[SIM_MODEL_ENV.priceIn], listed?.in ?? DEEPSEEK.price.in),
        out: num(env[SIM_MODEL_ENV.priceOut], listed?.out ?? DEEPSEEK.price.out),
        cached: num(env[SIM_MODEL_ENV.priceCached], listed?.cached ?? DEEPSEEK.price.cached),
      },
    },
    describe: `${provider}/${model} @ ${baseUrl}（key 来自环境变量 ${hasOwnKey ? keyEnv : 'DEEPSEEK_API_KEY'}）`,
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
