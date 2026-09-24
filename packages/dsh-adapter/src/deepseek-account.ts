/**
 * 第三种模型来源：**用我的 DeepSeek 账号登录**（WP134，Luoye 09-24）。
 *
 * 一句话：登录流程、令牌存放、账号 / 余额查询、登出，**一行都不是我们写的**——全是 dsh 0.1.7
 * 官方的 `@deepseek-ai/dsh-deepseek-account-platform`（系统浏览器 PKCE 授权）。这个文件只做
 * 三件官方模块要宿主做的事：
 *
 * 1. **起一棵只为它的最小 dsh 树**：`ctx.credentials`（官方 `dsh-credentials-local`，令牌落在
 *    dsh 自己的本机凭据库 `<dshHome>/.credentials.yaml`，**不进我们的秘密库**）+ `ctx.authorization`
 *    + 官方账号模块。没有 Agent、没有 Session、没有 LLM 适配器。
 * 2. **给它一个 `webServer`**：官方模块在"现有的 Host webServer"上注册 `/oauth/callback`
 *    （README：「registers /oauth/callback on the existing Host webServer」）。我们的现有 web server
 *    就是服务进程自己那个端口——这里给一个只收 exact 路由的小登记表，服务进程在它的 HTTP 入口把
 *    这条路径原样（node 的 req / res）交给官方处理器（{@link DeepSeekAccountHost.handle}）。
 *    **不另开端口**，回调仍是官方模块自己校验 state + PKCE、自己写响应。
 * 3. **按官方默认值走**：`platformOrigin` / `inferenceOrigin` / `requestTimeoutMs` / `attemptTimeoutMs`
 *    一个都不覆盖，不加 `requestHeaders`、不开 `allowLoopbackHttp`、不开 `rewriteBrowserOrigin`。
 *    `desktopPlatform` 按文档默认 `null`（所有请求带 `x-client-platform: web`）——我们的界面是网页，
 *    桌面壳里也是同一个网页。这一项要**显式**写（见 {@link OFFICIAL_DEFAULTS}，上游默认值没生效）。
 *    只有测试会传 {@link DeepSeekAccountHostOptions.config}（调短超时、指向替身平台）。
 *
 * **默认关**（docs/42 红线 7）：这个模块只在用户选了「用我的 DeepSeek 账号登录」之后才被
 * `import()` 进来、才挂上；profile 那一层（`profiles/agentsws/cordis.patch.yml`）仍然写死关着，
 * 真起完整 profile 时要显式叠 `deepseek-account.on.patch.yml` 才开（见那份文件的注释）。
 * 两档运行时的模块图里**没有**它（`profile-lockdown.test.ts` 的 `FORBIDDEN`）——它只从
 * `@agentsws/dsh-adapter/deepseek-account` 这个子路径进来，主入口不 re-export。
 *
 * **凭据纪律**：令牌只在官方模块与 dsh 凭据库之间走。对外只有「登录了没有 / 账号名 / 余额」；
 * 推理时由 {@link DeepSeekAccountHost.resolveToken}（官方 `resolveToken`，只对 `inferenceOrigin`
 * 给值）现取现用，调用方直接放进 `x-dsh-auth-token` 头，不落任何变量。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Authorization from '@deepseek-ai/dsh-authorization'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import type {
  AccountDetails,
  AccountView,
  DeepSeekAccount,
  SignInAttemptId,
} from '@deepseek-ai/dsh-deepseek-account'
import PlatformAccount, {
  type Config as PlatformAccountConfig,
} from '@deepseek-ai/dsh-deepseek-account-platform'
import { DshAdapterError } from './errors.js'

export type {
  AccountDetails,
  AccountProfile,
  AccountView,
  AccountWallet,
  SignInAttemptView,
  SignInErrorCode,
} from '@deepseek-ai/dsh-deepseek-account'
export type { PlatformAccountConfig }

/**
 * 官方 `inferenceOrigin` 的默认值（`dsh-deepseek-account-platform` 的 `Config`：
 * `inferenceOrigin: Schema.string().default("https://api.deepseek.com")`）。
 * 账号令牌**只**对这个源给值；推理地址必须落在它下面。
 */
export const DEEPSEEK_ACCOUNT_INFERENCE_ORIGIN = 'https://api.deepseek.com'

/**
 * 账号令牌走的推理口：官方 `dsh-llm-deepseek` 的 `PUBLIC_BASE_URL`（Anthropic Messages 形态）。
 * 官方 README：「Messages 和 Files 请求通过 `x-dsh-auth-token` 发送账号 token，不加 Bearer 前缀」。
 */
export const DEEPSEEK_ACCOUNT_MESSAGES_BASE_URL = `${DEEPSEEK_ACCOUNT_INFERENCE_ORIGIN}/anthropic`

/**
 * 我们**显式**写出来的唯一一项配置：`desktopPlatform: null`——它就是官方文档写的默认值
 * （README：「`desktopPlatform` defaults to `null`. Every profile then sends `x-client-platform: web`」）。
 *
 * 为什么要写：0.1.7-rc.1 里这条默认值**实际没生效**（WP134 实测）。`Config({})` 回来的
 * `desktopPlatform` 是 `undefined` 而不是 `null`（schemastery 的 `.default(null)` 不落值），
 * 构造函数里 `desktopClientHeaders(undefined)` 只认 `=== null`，于是所有平台请求带的是
 * `x-client-platform: desktop-mac`——与文档相反。显式传 `null` 才得到文档说的 `web`。
 * 官方自己的组合里看不出这个洞，因为 `dsh-base` 的 patch 替它**显式**写了这一项
 * （`dsh --dump-config` 实测：`desktopPlatform: !!js "ctx.get('profileContext')?.name === 'desktop' && …
 * ? process.platform : null"`——不是 desktop profile 就是 `null`）。我们不走 bundle，所以照这个结果写死 `null`。
 * 钉住它：`test/deepseek-account.test.ts` 第一条 + 「官方默认值」那一组的哨兵。
 */
export const OFFICIAL_DEFAULTS: PlatformAccountConfig = { desktopPlatform: null }

/** 官方模块在宿主 webServer 上注册的回调路径（`lib/index.js`：`path: "/oauth/callback"`）。 */
export const DEEPSEEK_ACCOUNT_CALLBACK_PATH = '/oauth/callback'

/** 官方账号模块在 dsh 凭据库里的记录 owner 段（`credentialKey("deepseek-account-platform", …)`）。 */
export const DEEPSEEK_ACCOUNT_RECORD_SCOPE = 'deepseek-account-platform'

export interface DeepSeekAccountHostOptions {
  /**
   * dsh 本机凭据库所在的目录（官方 `dsh-credentials-local` 的 `dshHome`；令牌写在
   * `<dshHome>/.credentials.yaml`，权限只有当前系统用户）。与 `credentials` 二选一。
   */
  dshHome?: string
  /**
   * 替身：一个 `CredentialProvider` 插件类（测试用内存版）。给了就不挂 `dsh-credentials-local`。
   * 类型故意是 `unknown`：与 `SubscriptionLoginOptions.credentials` 同一条纪律。
   */
  credentials?: unknown
  /**
   * **只给测试**：覆盖官方配置（把 `attemptTimeoutMs` 调短、把 `platformOrigin` 指向替身）。
   * 生产路径不传——按官方默认值走（派工单硬要求）。
   */
  config?: PlatformAccountConfig
  /** 装配超时（毫秒）。 */
  readyTimeoutMs?: number
}

/** 一次登录由谁发起：官方 `loginSource`。我们的界面是网页（桌面壳里也是同一个网页）。 */
export type DeepSeekLoginSource = 'web' | 'desktop'

export interface DeepSeekAccountHost {
  /** 现在什么样：登录了没有 + 最近一次登录尝试走到哪一步。**没有令牌。** */
  state(): Promise<AccountView>
  /** 账号资料（名字、平台脱敏过的手机号 / 邮箱）。没登录回 `null`。 */
  profile(): Promise<AccountDetails['profile'] | null>
  /** 余额（充值钱包与赠送钱包分开）。查不到是 `{ status: 'failed' }`，**不会变成 0**。 */
  balance(): Promise<AccountDetails['balance'] | null>
  /**
   * 起一次登录（或加入正在跑的那一次）。回来时不等浏览器——`attempt.authorizeUrl`
   * 出现（`waiting-browser`）之后交给系统浏览器打开。
   */
  startSignIn(input: {
    /** 浏览器能访问到的回环地址（`http://127.0.0.1:<端口>`），官方只收回环 HTTP + 显式端口。 */
    callbackOrigin: string
    locale: string
    loginSource?: DeepSeekLoginSource
  }): Promise<AccountView>
  /** 只取消这一次（id 不对就什么都不做）。 */
  cancelSignIn(id: string): Promise<AccountView>
  /** 登出：官方先删本机凭据、再在后台调平台 logout（最多重试 5 次）。 */
  signOut(): Promise<AccountView>
  /** 官方 `resolveToken`：只对 `inferenceOrigin` 下的地址给值。**调用方现取现用。** */
  resolveToken(url: string): Promise<string | undefined>
  /** 订阅状态变化（含一份完整初始状态）。`signal` 结束订阅，不取消登录。 */
  watch(signal: AbortSignal): AsyncIterable<AccountView>
  /**
   * 回环回调：这条请求是不是官方模块现在注册着的路由；是就交给它（它自己写响应、自己决定
   * 什么时候 `end()`），回 `true`。不是回 `false`，调用方照常处理。
   */
  handle(req: IncomingMessage, res: ServerResponse): boolean
  /** 收树。官方 shutdown 会中止还在跑的请求（包括后台登出重试）并等它们结束。 */
  dispose(): Promise<void>
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * 官方模块要的 `webServer` 只用到 `register({ kind: 'exact', path, handler })`。
 * 我们不起 `@deepseek-ai/dsh-host-webserver`（它会自己 listen 一个端口）——登记表就够了。
 */
class LoopbackRoutes {
  readonly exact = new Map<string, RouteHandler>()

  register(route: { kind: 'exact' | 'prefix'; path: string; handler: RouteHandler }): () => void {
    if (route.kind !== 'exact') {
      throw new DshAdapterError('invalid_input', `只支持 exact 路由：${route.path}`)
    }
    if (this.exact.has(route.path)) {
      throw new DshAdapterError('invalid_input', `路由重复注册：${route.path}`)
    }
    this.exact.set(route.path, route.handler)
    return () => {
      if (this.exact.get(route.path) === route.handler) this.exact.delete(route.path)
    }
  }

  registerUpgrade(): () => void {
    throw new DshAdapterError('invalid_input', 'DeepSeek 账号登录不需要 upgrade 路由')
  }

  registerFallback(): () => void {
    throw new DshAdapterError('invalid_input', 'DeepSeek 账号登录不需要 fallback 路由')
  }

  tapIndex(): () => void {
    return () => undefined
  }
}

/**
 * 起一棵只为 DeepSeek 账号登录的最小 dsh 树。调用方（服务进程）**懒加载**这个模块：
 * 没人选「用我的 DeepSeek 账号登录」，进程里就没有一行它的代码。
 */
export async function createDeepSeekAccountHost(
  options: DeepSeekAccountHostOptions = {},
): Promise<DeepSeekAccountHost> {
  if (options.credentials === undefined && options.dshHome === undefined) {
    throw new DshAdapterError('invalid_input', 'DeepSeek 账号登录要一个 dsh 凭据库目录（dshHome）')
  }
  const root = new Context()
  const routes = new LoopbackRoutes()
  root.provide('webServer', routes as never)
  if (options.credentials !== undefined) {
    root.plugin(options.credentials as Parameters<Context['plugin']>[0], undefined as never)
  } else {
    // 本机只有我们这个进程写它：不开文件监视（少一个常驻 watcher）
    root.plugin(CredentialsLocal as never, { dshHome: options.dshHome, watch: false } as never)
  }
  root.plugin(Authorization)
  root.plugin(PlatformAccount as never, { ...OFFICIAL_DEFAULTS, ...options.config } as never)

  const ctx = await injectReady(
    root,
    ['credentials', 'authorization', 'deepseekAccount'],
    options.readyTimeoutMs,
  )
  const account = ctx.get('deepseekAccount') as DeepSeekAccount

  return {
    state: () => account.getState(),
    profile: () => account.getProfile(),
    balance: () => account.getBalance(),
    startSignIn: (input) =>
      account.startSignIn(input.locale, input.callbackOrigin, input.loginSource ?? 'web'),
    cancelSignIn: (id) => account.cancelSignIn(id as SignInAttemptId),
    signOut: () => account.signOut(),
    resolveToken: (url) => account.resolveToken(url),
    watch: (signal) => account.watch(signal),
    handle(req, res) {
      let path: string
      try {
        path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      } catch {
        return false
      }
      const handler = routes.exact.get(path)
      if (handler === undefined) return false
      void Promise.resolve(handler(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'cache-control': 'no-store' })
        res.end()
      })
      return true
    },
    async dispose() {
      await root.fiber.dispose()
    },
  }
}

/** 等一批服务就绪（与 `subscription.ts` 的同名函数同一件事）。 */
async function injectReady(root: Context, services: string[], timeoutMs = 5000): Promise<Context> {
  return new Promise<Context>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new DshAdapterError('timeout', `dsh 服务未就绪：${services.join(', ')}`, {
          retryable: true,
        }),
      )
    }, timeoutMs)
    root.plugin({
      name: 'agentsws-deepseek-account-host',
      inject: services,
      apply(ctx: Context) {
        clearTimeout(timer)
        resolve(ctx)
      },
    })
  })
}
