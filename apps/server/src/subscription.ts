/**
 * 用 ChatGPT / Claude 的**订阅**登录：服务端那一半（WP90，55 §9 Q8）。
 *
 * 三件事，一件都不能少：
 *
 * 1. **只在个人档**。`AGENTSWS_RUNTIME_MODE` 是 `docker` / `hosted` 的机器上，
 *    这一整块都不可用——那里的"个人订阅账号"只能是被代持的共享账号，违反
 *    OpenAI / Anthropic 的条款（20 / 55 §9 事实表最后一行）。界面上灰掉，
 *    接口上 403 + 一句人话。
 * 2. **凭据进本机加密秘密库，按人分开**。key 名是 `subscription:<person_id>:<provider>`，
 *    与连接（`conn:*`）、模型 key（`model_provider:*`）同一个库、同一把密钥、
 *    不同前缀。**别人的那一条读不到**——不是"没权限"，是"不存在"（报权限会
 *    泄漏"这台机器上有人登录过 ChatGPT"）。
 * 3. **登录流是官方的**。这个文件一行 OAuth 都没有：起一棵最小 dsh 树
 *    （`@agentsws/dsh-adapter` 的 `createSubscriptionLogin`），调 `ctx.authorization.begin()`，
 *    把它报上来的"去这个网址、输这串码"原样转给界面。
 *
 * **token 一个字节都不出这个模块**：不进事件、不进日志、不进任何 `/v1` 响应。
 * 对外只有四样：登没登录、账号脱敏后的样子、什么时候过期、现在进行到哪一步。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ModelsActor,
  SubscriptionLoginInput,
  SubscriptionProviderKind,
  SubscriptionView,
} from '@agentsws/api'
import type { Clock } from '@agentsws/contracts'
import {
  CompositeCredentials,
  envRefSource,
  type SubscriptionRecordSource,
} from '@agentsws/credentials-openconnector'
import type { SubscriptionLoginHandle, SubscriptionQuestion } from '@agentsws/dsh-adapter'
/*
 * **静态** import 的只有这一行：`subscription-facts` 是一个没有任何 dsh 依赖的
 * 纯常量模块（开哪两家、各能怎么登、风险提示那一段）。真正那棵 dsh 树在
 * `stateOf()` 里按需 `await import('@agentsws/dsh-adapter')`——公司档上没人能登录，
 * 那棵树一次都不会被装进来。
 */
import {
  SUBSCRIPTION_FACTS,
  SUBSCRIPTION_RISK_NOTE,
} from '@agentsws/dsh-adapter/subscription-facts'
import type { Context } from '@deepseek-ai/cordis'
import type { SecretStore } from './secret-store.js'

/** 秘密库里订阅凭据的前缀（与 `conn:` / `model_provider:` 分开）。 */
export const SUBSCRIPTION_KEY_PREFIX = 'subscription:'

/** 这条记录在秘密库里叫什么。**按人分开**——账号是人的，不是工作区的。 */
export function subscriptionSecretId(person_id: string, provider: string): string {
  return `${SUBSCRIPTION_KEY_PREFIX}${person_id}:${provider}`
}

/** 秘密库里那一条的字段名（值是 pi-ai 的 grant JSON，原样存）。 */
const RECORD_FIELD = 'record'

/** 第一条"去这儿输这串码"最多等多久（毫秒）。等不到就先把界面画出来，让它轮询。 */
const FIRST_NOTICE_TIMEOUT_MS = 20_000

/** 公司档 / 托管档上那句人话。 */
export const SUBSCRIPTION_UNAVAILABLE =
  '这台机器是公司档 / 托管档，不支持用个人的 ChatGPT / Claude 订阅登录：' +
  '那个账号只属于你本人，放在共用的机器上就是共享账号，违反 OpenAI / Anthropic 的条款。' +
  '公司要用，请在设置里填这两家的 API key。'

export interface SubscriptionOptions {
  clock: Clock
  /** 本机加密秘密库（**不按品牌分**：订阅账号是这台机器上这个人的事）。 */
  secrets: SecretStore
  /** 这台机器的档位；只有 `local` 才开这一块。 */
  runtimeMode(): 'local' | 'docker' | 'hosted'
  /** 选中的模型名落在哪（`subscription.json`）；不给就全内存。 */
  dbDir?: string
  /**
   * 起 dsh 那一侧的登录树。缺省是**懒加载**
   * `@agentsws/dsh-adapter`——没人点"用订阅登录"，这个服务进程里就没有一行 dsh
   * 被 import 进来（31 §3.5 的精神：执行器不平白装第三方代码）。测试注入替身。
   */
  createLogin?: (options: { credentials: unknown }) => Promise<SubscriptionLoginHandle>
}

export interface SubscriptionPortLike {
  list(actor: ModelsActor): Promise<SubscriptionView[]>
  get(actor: ModelsActor, provider: string): Promise<SubscriptionView>
  login(actor: ModelsActor, input: SubscriptionLoginInput): Promise<SubscriptionView>
  answer(actor: ModelsActor, provider: string, value: string): Promise<SubscriptionView>
  selectModel(actor: ModelsActor, provider: string, model: string): Promise<SubscriptionView>
  signOut(actor: ModelsActor, provider: string): Promise<void>
}

export interface SubscriptionAssembly {
  port: SubscriptionPortLike
  /** 把还开着的登录树收掉（进程退出时）。 */
  close(): Promise<void>
}

/** 一次正在跑的登录尝试。**里面没有 token**，只有"现在进行到哪一步"。 */
interface Attempt {
  method: 'device' | 'browser'
  controller: AbortController
  notice: { message: string; url?: string; code?: string } | undefined
  question: { kind: 'text' | 'secret'; message: string; placeholder?: string } | undefined
  answer: ((value: string) => void) | undefined
  decline: ((reason: Error) => void) | undefined
  error: string | undefined
  settled: boolean
}

interface PersonState {
  handle: SubscriptionLoginHandle
  attempts: Map<string, Attempt>
}

interface SelectedModels {
  version: 1
  /** `<person_id>/<provider>` → 模型名。**只有模型名**，没有任何凭据。 */
  chosen: Record<string, string>
}

export function createSubscription(options: SubscriptionOptions): SubscriptionAssembly {
  const people = new Map<string, PersonState>()
  const file = options.dbDir === undefined ? undefined : join(options.dbDir, 'subscription.json')

  const readChosen = (): SelectedModels => {
    if (file === undefined) return memory
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as SelectedModels
    } catch {
      return { version: 1, chosen: {} }
    }
  }
  const memory: SelectedModels = { version: 1, chosen: {} }
  const writeChosen = (next: SelectedModels): void => {
    if (file === undefined) {
      memory.chosen = next.chosen
      return
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }

  const available = (): boolean => options.runtimeMode() === 'local' && options.secrets.available

  const unavailableReason = (): string | undefined => {
    if (options.runtimeMode() !== 'local') return SUBSCRIPTION_UNAVAILABLE
    if (!options.secrets.available) {
      return '这台机器没有秘密库密钥，登录拿到的凭据无处安全存放；桌面壳会在首次启动时生成它。'
    }
    return undefined
  }

  /**
   * 一个人的本机记录层。
   *
   * `enabled()` 每次都重新问一遍档位——档位是环境变量给的，进程跑着的时候不会变，
   * 但**写死成一个布尔就没法在测试里换档**，而这条闸正是公司档那条用例要按的。
   */
  const recordsFor = (person_id: string): SubscriptionRecordSource => ({
    enabled: available,
    async read(provider) {
      if (!available()) return undefined
      const row = options.secrets.get(subscriptionSecretId(person_id, provider))
      const raw = row?.[RECORD_FIELD]
      if (raw === undefined) return undefined
      try {
        return JSON.parse(raw) as unknown
      } catch {
        // 库被改过 / 格式变了：当成没登录，让人重登一次，别把坏数据递给官方适配器
        return undefined
      }
    },
    async write(provider, payload) {
      options.secrets.put(subscriptionSecretId(person_id, provider), {
        [RECORD_FIELD]: JSON.stringify(payload),
      })
    },
    async remove(provider) {
      options.secrets.remove(subscriptionSecretId(person_id, provider))
    },
    async list() {
      const prefix = `${SUBSCRIPTION_KEY_PREFIX}${person_id}:`
      return options.secrets
        .list()
        .filter((r) => r.connection_id.startsWith(prefix))
        .map((r) => r.connection_id.slice(prefix.length))
        .sort()
    },
  })

  const stateOf = async (person_id: string): Promise<PersonState> => {
    const existing = people.get(person_id)
    if (existing !== undefined) return existing
    const records = recordsFor(person_id)
    // 官方 `ctx.credentials` 是单 provider：一棵树上就这一个，第三条路指向上面那个库
    const credentials = class extends CompositeCredentials {
      constructor(ctx: Context) {
        super(ctx, { refs: envRefSource(), subscriptions: records })
      }
    }
    const create =
      options.createLogin ??
      (async (o: { credentials: unknown }) => {
        /*
         * 懒加载：没人点登录，这个进程里就没有 dsh 被 import 进来。
         *
         * 装不上就如实说一句人话，而不是抛一个堆栈：公司档的镜像将来可能把
         * `@agentsws/dsh-adapter` 整个剪掉（那里这一块本来就不可用），
         * 到那时这条路要退化成"这个安装里没有这个模块"，不是 500。
         */
        try {
          const mod = await import('@agentsws/dsh-adapter')
          return mod.createSubscriptionLogin(o)
        } catch {
          throw new SubscriptionInvalid(
            '这个安装里没有订阅登录模块（@agentsws/dsh-adapter 没装）；' +
              '个人端的桌面壳与源码安装都带着它，公司档的精简镜像可能剪掉了。',
          )
        }
      })
    const handle = await create({ credentials })
    const state: PersonState = { handle, attempts: new Map() }
    people.set(person_id, state)
    return state
  }

  const facts = (): {
    id: SubscriptionProviderKind
    label: string
    summary: string
    methods: string[]
    risk: string
  }[] =>
    SUBSCRIPTION_FACTS.map((f) => ({
      id: f.id,
      label: f.label,
      summary: f.summary,
      methods: [...f.methods],
      risk: SUBSCRIPTION_RISK_NOTE,
    }))

  const viewOf = async (
    actor: ModelsActor,
    provider: SubscriptionProviderKind,
  ): Promise<SubscriptionView> => {
    const all = facts()
    const fact = all.find((f) => f.id === provider)
    if (fact === undefined) throw new SubscriptionInvalid(`未知的订阅 provider：${provider}`)
    const reason = unavailableReason()
    const base: SubscriptionView = {
      provider,
      label: fact.label,
      summary: fact.summary,
      methods: fact.methods as SubscriptionView['methods'],
      risk_note: fact.risk,
      available: reason === undefined,
      ...(reason === undefined ? {} : { unavailable_reason: reason }),
      signed_in: false,
      in_flight: false,
      models: [],
    }
    if (reason !== undefined) return base
    const state = await stateOf(actor.person_id)
    const status = await state.handle.status(provider)
    const attempt = state.attempts.get(provider)
    const chosen = readChosen().chosen[`${actor.person_id}/${provider}`]
    return {
      ...base,
      signed_in: status.signed_in,
      ...(status.account === undefined ? {} : { account: status.account }),
      ...(status.expires_at === undefined ? {} : { expires_at: status.expires_at }),
      in_flight: attempt !== undefined && !attempt.settled,
      ...(attempt?.notice === undefined ? {} : { notice: attempt.notice }),
      ...(attempt?.question === undefined ? {} : { question: attempt.question }),
      ...(attempt?.error === undefined ? {} : { last_error: attempt.error }),
      ...(chosen === undefined ? {} : { selected_model: chosen }),
      // 目录来自 pi-ai（gpt-5.x / claude-*），价目一律显示"订阅"——不按 token 收钱
      models: status.signed_in ? await state.handle.models(provider) : [],
    }
  }

  const known = async (value: string): Promise<SubscriptionProviderKind> => {
    const hit = facts().find((f) => f.id === value)
    if (hit === undefined) throw new SubscriptionInvalid(`没有这一家订阅登录：${value}`)
    return hit.id
  }

  const requireAvailable = (): void => {
    const reason = unavailableReason()
    if (reason !== undefined) throw new SubscriptionForbidden(reason)
  }

  return {
    port: {
      async list(actor) {
        const all = facts()
        const out: SubscriptionView[] = []
        for (const f of all) out.push(await viewOf(actor, f.id))
        return out
      },

      async get(actor, provider) {
        return viewOf(actor, await known(provider))
      },

      async login(actor, input) {
        requireAvailable()
        const provider = await known(input.provider)
        const state = await stateOf(actor.person_id)
        const running = state.attempts.get(provider)
        if (running !== undefined && !running.settled) {
          // 一次一个：两个人对着同一条流回答问题只会互相答错对方的题
          return viewOf(actor, provider)
        }
        const attempt: Attempt = {
          method: input.method,
          controller: new AbortController(),
          notice: undefined,
          question: undefined,
          answer: undefined,
          decline: undefined,
          error: undefined,
          settled: false,
        }
        state.attempts.set(provider, attempt)

        // 第一条"去这个网址、输这串码"来了就把界面画出来；剩下的靠轮询
        let announce: (() => void) | undefined
        const firstNotice = new Promise<void>((resolve) => {
          announce = resolve
        })

        const run = state.handle
          .begin({
            provider,
            method: input.method,
            signal: attempt.controller.signal,
            notify: (notice) => {
              attempt.notice = notice
              // 有网址或有码才算"人可以动手了"
              if (notice.url !== undefined || notice.code !== undefined) announce?.()
            },
            ask: async (question: SubscriptionQuestion) =>
              new Promise<string>((resolve, reject) => {
                attempt.question = {
                  kind: question.kind,
                  message: question.message,
                  ...(question.placeholder === undefined
                    ? {}
                    : { placeholder: question.placeholder }),
                }
                attempt.answer = (value) => {
                  attempt.question = undefined
                  attempt.answer = undefined
                  attempt.decline = undefined
                  resolve(value)
                }
                attempt.decline = (error) => {
                  attempt.question = undefined
                  attempt.answer = undefined
                  attempt.decline = undefined
                  reject(error)
                }
                announce?.()
              }),
          })
          .then((outcome) => {
            if (outcome === 'cancelled') attempt.error = '登录已取消'
          })
          .catch((e: unknown) => {
            // **原样那句话**，但绝不带值：官方的报错里只有状态码与端点
            attempt.error = e instanceof Error ? e.message : String(e)
          })
          .finally(() => {
            attempt.settled = true
            attempt.question = undefined
            announce?.()
          })
        // 失败已经在上面收干净了；这里只是不让它变成未处理的 rejection
        void run

        await Promise.race([
          firstNotice,
          new Promise<void>((resolve) => setTimeout(resolve, FIRST_NOTICE_TIMEOUT_MS)),
        ])
        return viewOf(actor, provider)
      },

      async answer(actor, provider, value) {
        requireAvailable()
        const id = await known(provider)
        const state = await stateOf(actor.person_id)
        const attempt = state.attempts.get(id)
        if (attempt?.answer === undefined)
          throw new SubscriptionInvalid('现在没有在等你回答的问题（登录可能已经结束或被取消）')
        attempt.answer(value)
        return viewOf(actor, id)
      },

      async selectModel(actor, provider, model) {
        const id = await known(provider)
        const next = readChosen()
        writeChosen({
          version: 1,
          chosen: { ...next.chosen, [`${actor.person_id}/${id}`]: model },
        })
        return viewOf(actor, id)
      },

      async signOut(actor, provider) {
        const id = await known(provider)
        const state = await stateOf(actor.person_id)
        const attempt = state.attempts.get(id)
        if (attempt !== undefined && !attempt.settled) {
          attempt.controller.abort()
          attempt.decline?.(new Error('登录已取消'))
        }
        state.attempts.delete(id)
        await state.handle.signOut(id)
      },
    },

    async close() {
      for (const state of people.values()) {
        for (const attempt of state.attempts.values()) attempt.controller.abort()
        await state.handle.dispose()
      }
      people.clear()
    },
  }
}

/**
 * 公司档 / 托管档上这一整块不可用；路由把它翻成 403 + 这句人话。
 *
 * `code` 这个字段是**故意**的：网关的 `normalizeError` 只认它（28 §2 的码表），
 * 没有它就会被当成未归类错误收成 500 "internal error"，用户看不到上面那句话。
 */
export class SubscriptionForbidden extends Error {
  readonly code = 'forbidden' as const
  constructor(message: string) {
    super(message)
    this.name = 'SubscriptionForbidden'
  }
}

/** 入参不对（没有这一家、现在没有在等回答的问题）：400 + 人话，同样靠 `code`。 */
export class SubscriptionInvalid extends Error {
  readonly code = 'invalid_input' as const
  constructor(message: string) {
    super(message)
    this.name = 'SubscriptionInvalid'
  }
}
