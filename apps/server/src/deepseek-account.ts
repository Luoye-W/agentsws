/**
 * 第三种模型来源「用我的 DeepSeek 账号登录」：服务端那一半（WP134，Luoye 09-24）。
 *
 * 三件事：
 *
 * 1. **开 / 关模块**。默认关：进程里一行官方账号模块的代码都没有。用户在向导或设置里点了
 *    「用我的 DeepSeek 账号登录」，才 `await import('@agentsws/dsh-adapter/deepseek-account')`
 *    挂一棵只为它的最小 dsh 树（docs/42 红线 7 的路线 (b)：profile 层关死，服务进程在用户选中时
 *    打开）。选过就记一笔 `deepseek-account.json`（**只有一个布尔**），重启后照样挂上，不然
 *    已经登录的账号重启就用不了；登出就摘掉并记回 false。
 * 2. **把官方状态翻成界面的样子**：登录进行到哪一步、授权页地址、账号名、余额；失败说人话。
 *    令牌一个字节都不在这里——状态、资料、余额都是官方投影过的（官方只给 UID / 名字 / 平台
 *    脱敏过的手机号或邮箱 / 钱包余额）。
 * 3. **回调走现有端口**：官方模块在"宿主 webServer"上注册 `/oauth/callback`。我们的 webServer
 *    就是服务进程这一个端口；`handle()` 把那条请求（node 的 req / res）原样交给官方处理器。
 *
 * 只在本机档（`AGENTSWS_RUNTIME_MODE=local`）可用：官方只收回环地址的回调
 * （README「non-loopback reverse proxies are unsupported」），Docker / 托管档的浏览器回不来。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { DeepSeekAccountView, DeepSeekWalletView } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type { DeepSeekAccountHost } from '@agentsws/dsh-adapter/deepseek-account'
import { DEEPSEEK_ACCOUNT_DEFAULT_MODEL } from '@agentsws/model-gateway'

/** 这一条 provider 在 `models.json` 里的 id（与云那条 `agentsws` 一样写死：一台机器只有一条）。 */
export const DEEPSEEK_ACCOUNT_PROVIDER_ID = 'deepseek-account'

/** 公司档 / 托管档上那句人话。 */
export const DEEPSEEK_ACCOUNT_UNAVAILABLE =
  '这台机器不是本机档：用 DeepSeek 账号登录要在这台电脑的浏览器里授权，授权完浏览器要回到这台电脑上的 Agents 工坊，' +
  '放在服务器上的 Agents 工坊回不来。请改用 DeepSeek 的 API key。'

/** 官方四个失败码 → 人话。 */
export const DEEPSEEK_SIGN_IN_ERRORS: Readonly<
  Record<'network' | 'protocol' | 'expired' | 'storage', string>
> = {
  network: '连不上 DeepSeek（网络不通，或者对方没回）。检查一下网络，再点一次登录。',
  protocol: 'DeepSeek 那边的回应不对，这次登录没成。再点一次登录试试。',
  expired: '浏览器里一直没点完，这次登录过期了。再点一次登录。',
  storage: '这台电脑上存登录凭据的地方写不进去，登录没成。',
}

/** 余额查不到时那句话（查不到**不等于** 0，也不影响用它干活）。 */
export const DEEPSEEK_BALANCE_FAILED =
  '余额暂时查不到——DeepSeek 那边这会儿没回话。不影响用它干活，过一会儿再看，或者去 DeepSeek 开放平台看。'

/** 账号资料查不到时那句话。 */
export const DEEPSEEK_PROFILE_FAILED = '账号资料暂时没查到（DeepSeek 那边没回话），不影响使用。'

/** 登出后官方模块再留多久才摘（让它把后台的远端登出重试做完；官方重试间隔 1+2+4+8+16 秒）。 */
const SIGN_OUT_GRACE_MS = 4 * 60_000

/** 起登录后等多久拿授权页地址（等不到就先回，界面轮询）。 */
const FIRST_URL_WAIT_MS = 5000

export interface DeepSeekAccountOptions {
  /** 这台机器的档位；只有 `local` 才开这一块。 */
  runtimeMode(): 'local' | 'docker' | 'hosted'
  /** `deepseek-account.json` 与 dsh 凭据库（`dsh-home/`）落在哪；不给就全内存 + 装不了真模块。 */
  dbDir?: string
  /** 服务进程现在的回环地址（`http://127.0.0.1:<端口>`）；还没 listen 时回 `undefined`。 */
  callbackOrigin(): string | undefined
  /**
   * 起官方那一侧的宿主。缺省是**懒加载** `@agentsws/dsh-adapter/deepseek-account`，
   * 凭据库放在 `<dbDir>/dsh-home/.credentials.yaml`。测试与 demo 注入替身。
   */
  createHost?: () => Promise<DeepSeekAccountHost>
  /** 登录状态变了（登上 / 登出）：模型面据此重新装配网关。 */
  onChange?: () => void
  /** 登出后多久摘掉官方模块（测试调成 0）。 */
  signOutGraceMs?: number
}

export interface DeepSeekAccountAssembly {
  /** 本机凭据库里有没有授权（同步，缓存自官方 `watch`）。模型面判"这条能不能用"用它。 */
  signedIn(): boolean
  /** 官方 `resolveToken`：只对 `api.deepseek.com` 给值；没挂模块就是 `undefined`。 */
  resolveToken(url: string): Promise<string | undefined>
  /** 回环回调：是官方注册着的路由就交给它、回 true。 */
  handle(req: IncomingMessage, res: ServerResponse): boolean
  view(): Promise<DeepSeekAccountView>
  login(): Promise<DeepSeekAccountView>
  cancel(attempt_id: string): Promise<DeepSeekAccountView>
  signOut(): Promise<void>
  /** 启动时：上次选过这条路就把模块挂回来（只读本机凭据库，不出网）。 */
  resume(): Promise<void>
  close(): Promise<void>
}

interface StateFile {
  version: 1
  /** 用户选过这条路没有（**只有这一个布尔**）。 */
  enabled: boolean
}

export function createDeepSeekAccount(options: DeepSeekAccountOptions): DeepSeekAccountAssembly {
  const file =
    options.dbDir === undefined ? undefined : join(options.dbDir, 'deepseek-account.json')
  let memory: StateFile = { version: 1, enabled: false }
  const readState = (): StateFile => {
    if (file === undefined) return memory
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateFile>
      return { version: 1, enabled: parsed.enabled === true }
    } catch {
      return { version: 1, enabled: false }
    }
  }
  const writeState = (next: StateFile): void => {
    memory = next
    if (file === undefined || options.dbDir === undefined) return
    mkdirSync(options.dbDir, { recursive: true })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }

  const createHost =
    options.createHost ??
    (async (): Promise<DeepSeekAccountHost> => {
      if (options.dbDir === undefined) {
        throw new ApiError(
          'invalid_input',
          '这个服务进程没有数据目录，DeepSeek 账号的登录凭据无处存放',
        )
      }
      const { createDeepSeekAccountHost } = await import('@agentsws/dsh-adapter/deepseek-account')
      return createDeepSeekAccountHost({ dshHome: join(options.dbDir, 'dsh-home') })
    })

  let host: DeepSeekAccountHost | undefined
  let mounting: Promise<DeepSeekAccountHost> | undefined
  let watching: AbortController | undefined
  let signed = false
  let graceTimer: NodeJS.Timeout | undefined

  const available = (): boolean => options.runtimeMode() === 'local'

  const setSigned = (next: boolean): void => {
    if (next === signed) return
    signed = next
    options.onChange?.()
  }

  const watch = (h: DeepSeekAccountHost): void => {
    const controller = new AbortController()
    watching = controller
    void (async () => {
      try {
        for await (const v of h.watch(controller.signal)) {
          setSigned(v.status === 'credential-stored')
        }
      } catch {
        // 模块被摘了 / 凭据库读不出来：当成没登录
        setSigned(false)
      }
    })()
  }

  /** 挂上官方模块（只挂一次）。 */
  const mount = async (): Promise<DeepSeekAccountHost> => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer)
      graceTimer = undefined
    }
    if (host !== undefined) return host
    mounting ??= (async () => {
      const h = await createHost()
      host = h
      const first = await h.state().catch(() => undefined)
      setSigned(first?.status === 'credential-stored')
      watch(h)
      return h
    })().finally(() => {
      mounting = undefined
    })
    return mounting
  }

  const unmount = async (): Promise<void> => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer)
      graceTimer = undefined
    }
    watching?.abort()
    watching = undefined
    const h = host
    host = undefined
    setSigned(false)
    await h?.dispose()
  }

  const base = (): DeepSeekAccountView => ({
    available: available(),
    ...(available() ? {} : { unavailable_reason: DEEPSEEK_ACCOUNT_UNAVAILABLE }),
    enabled: host !== undefined,
    signed_in: false,
    default_model: DEEPSEEK_ACCOUNT_DEFAULT_MODEL,
    region: 'cn',
  })

  const wallets = (rows: readonly { currency: 'CNY' | 'USD'; balance: string }[]) =>
    rows.map((w): DeepSeekWalletView => ({ currency: w.currency, balance: w.balance }))

  const view = async (): Promise<DeepSeekAccountView> => {
    const out = base()
    const h = host
    if (!out.available || h === undefined) return out
    let state: Awaited<ReturnType<DeepSeekAccountHost['state']>>
    try {
      state = await h.state()
    } catch {
      return {
        ...out,
        enabled: true,
        attempt: {
          id: '',
          phase: 'failed',
          error_code: 'storage',
          error: DEEPSEEK_SIGN_IN_ERRORS.storage,
        },
      }
    }
    const signedIn = state.status === 'credential-stored'
    setSigned(signedIn)
    const a = state.attempt
    const result: DeepSeekAccountView = {
      ...out,
      enabled: true,
      signed_in: signedIn,
      usage_url: state.links.usageUrl,
      top_up_url: state.links.topUpUrl,
      ...(a === null
        ? {}
        : {
            attempt: {
              id: a.id,
              phase: a.phase,
              ...(a.phase === 'waiting-browser' && a.authorizeUrl !== undefined
                ? { authorize_url: a.authorizeUrl }
                : {}),
              ...(a.expiresAt === undefined
                ? {}
                : { expires_at: new Date(a.expiresAt).toISOString() }),
              ...(a.errorCode === undefined
                ? {}
                : {
                    error_code: a.errorCode,
                    error: DEEPSEEK_SIGN_IN_ERRORS[a.errorCode],
                  }),
            },
          }),
    }
    if (!signedIn) return result
    const [profile, balance] = await Promise.all([
      h.profile().catch(() => ({ status: 'failed' as const })),
      h.balance().catch(() => ({ status: 'failed' as const })),
    ])
    if (profile?.status === 'ready') {
      const name = profile.value.name ?? profile.value.contact
      if (name !== null) result.account = name
    } else if (profile?.status === 'failed') {
      result.account_error = DEEPSEEK_PROFILE_FAILED
    }
    if (balance?.status === 'ready') {
      result.balance = {
        status: 'ready',
        wallets: wallets(balance.value),
        bonus: wallets(balance.bonusWallets),
      }
    } else if (balance?.status === 'failed') {
      result.balance = { status: 'failed', message: DEEPSEEK_BALANCE_FAILED }
    }
    return result
  }

  return {
    signedIn: () => signed,
    resolveToken: async (url) => (host === undefined ? undefined : host.resolveToken(url)),
    handle: (req, res) => host?.handle(req, res) ?? false,
    view,

    async login() {
      if (!available()) throw new ApiError('forbidden', DEEPSEEK_ACCOUNT_UNAVAILABLE)
      const origin = options.callbackOrigin()
      if (origin === undefined) {
        throw new ApiError('invalid_input', '服务还没起来（没有本机回调地址），稍后再点一次登录')
      }
      const h = await mount()
      writeState({ version: 1, enabled: true })
      const started = await h.startSignIn({
        callbackOrigin: origin,
        locale: 'zh-CN',
        loginSource: 'web',
      })
      // 官方起完会先回 initializing；等一小会儿拿到授权页地址，界面就能当场打开浏览器
      const deadline = Date.now() + FIRST_URL_WAIT_MS
      let phase = started.attempt?.phase
      while (phase === 'initializing' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
        phase = (await h.state()).attempt?.phase
      }
      return view()
    },

    async cancel(attempt_id) {
      if (host !== undefined) await host.cancelSignIn(attempt_id)
      return view()
    },

    async signOut() {
      writeState({ version: 1, enabled: false })
      const h = host
      if (h === undefined) return
      await h.signOut()
      setSigned(false)
      // 官方登出是"先删本机、后台调平台 logout（最多重试 5 次）"；马上摘模块会把那几次重试一起掐掉
      const grace = options.signOutGraceMs ?? SIGN_OUT_GRACE_MS
      if (grace <= 0) {
        await unmount()
        return
      }
      graceTimer = setTimeout(() => {
        graceTimer = undefined
        if (!readState().enabled) void unmount()
      }, grace)
      graceTimer.unref()
    },

    async resume() {
      if (!available() || !readState().enabled) return
      try {
        await mount()
      } catch {
        // 挂不回来（凭据库坏了之类）：界面上那张卡会显示"还没登录"，再点一次就是
      }
    },

    async close() {
      await unmount()
    },
  }
}
