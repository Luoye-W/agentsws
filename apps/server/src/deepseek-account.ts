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
 * WP150（跟官方 0.1.7-rc.2）两件：
 *
 * 4. **登录失效**：官方说"登录失效了"（推理 401 经 `rejectToken`，或资料 / 余额口 401 / 40003——判定
 *    与清本机凭据全是官方的）→ 记一笔"是失效登出的"（卡片上那句"登录过期了，点一下重新登录"），
 *    再交给装配方做和手动登出**同一条路**的收尾：停掉正在用这个账号跑的事、摘掉各品牌里那一条模型来源。
 * 5. **登出前停任务**：`view()` 带上"现在正在用这个账号跑的事"（界面确认框里列它们）；`signOut()`
 *    先停这些运行、再登出（官方 `installAccountTaskCancellation` 的做法，只是次序按派工单"先停再登出"）。
 *
 * 只在本机档（`AGENTSWS_RUNTIME_MODE=local`）可用：官方只收回环地址的回调
 * （README「non-loopback reverse proxies are unsupported」），Docker / 托管档的浏览器回不来。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type {
  DeepSeekAccountTaskView,
  DeepSeekAccountView,
  DeepSeekWalletView,
} from '@agentsws/api'
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

/** WP150：登录失效后卡片上那句话（`DeepSeekAccountView.session_expired.message`）。 */
export const DEEPSEEK_SESSION_EXPIRED =
  'DeepSeek 账号的登录过期了（DeepSeek 那边不认这次的登录了），点一下重新登录。'

/** WP150：登出前被停掉的那几次运行，时间线上写的原因。 */
export const DEEPSEEK_SIGN_OUT_STOPPED =
  'DeepSeek 账号登出了，这件事正在用这个账号跑，所以先停下了。换一个模型或者重新登录之后，再让它重做一遍。'

/** WP150：登录失效时被停掉的那几次运行，时间线上写的原因。 */
export const DEEPSEEK_EXPIRED_STOPPED =
  'DeepSeek 账号的登录过期了，这件事正在用这个账号跑，所以先停下了。去「设置 → 模型」点一下重新登录，再让它重做一遍。'

/** 登出后官方模块再留多久才摘（让它把后台的远端登出重试做完；官方重试间隔 1+2+4+8+16 秒）。 */
const SIGN_OUT_GRACE_MS = 4 * 60_000

/** 起登录后等多久拿授权页地址（等不到就先回，界面轮询）。 */
const FIRST_URL_WAIT_MS = 5000

export interface DeepSeekAccountOptions {
  /** 这台机器的档位；只有 `local` 才开这一块。 */
  runtimeMode(): 'local' | 'docker' | 'hosted'
  /** `deepseek-account.json` 落在哪；不给就全内存。 */
  dbDir?: string
  /**
   * dsh 本机凭据库所在的 `DSH_HOME`（WP136 的 `dshHomeOf`：数据目录**旁边**的 `<userData>/dsh`，
   * 所有 dsh 场景共用一份——在哪个场景登录 DeepSeek 都算数；不在数据目录里，备份不打包令牌）。
   * 不给就装不了真模块。
   */
  dshHome?: string
  /** 服务进程现在的回环地址（`http://127.0.0.1:<端口>`）；还没 listen 时回 `undefined`。 */
  callbackOrigin(): string | undefined
  /**
   * 起官方那一侧的宿主。缺省是**懒加载** `@agentsws/dsh-adapter/deepseek-account`，
   * 凭据库放在 `<dshHome>/.credentials.yaml`。测试与 demo 注入替身。
   */
  createHost?: () => Promise<DeepSeekAccountHost>
  /** 登录状态变了（登上 / 登出）：模型面据此重新装配网关。 */
  onChange?: () => void
  /** 登出后多久摘掉官方模块（测试调成 0）。 */
  signOutGraceMs?: number
  /**
   * WP150：正在用这个账号跑的事（装配方从各品牌的运行时里挑出"开跑时绑的是账号那条来源"的）。
   * `list` 给登出确认框；`stop` 停掉它们（时间线上写 `reason`），等它们收尾再回。不给 = 没有运行时。
   */
  tasks?: {
    list(): DeepSeekAccountTaskView[]
    stop(reason: string): Promise<void>
  }
  /**
   * WP150：官方说登录失效了（本机凭据官方已经清掉）之后调一次：装配方走和手动登出同一条路的收尾
   * （摘掉各品牌里那一条模型来源）。正在跑的账号任务由这里先停掉，再调它。
   */
  onExpired?: () => void | Promise<void>
  /** 时间（记"什么时候失效的"）。缺省系统时间。 */
  now?: () => string
}

export interface DeepSeekAccountAssembly {
  /** 本机凭据库里有没有授权（同步，缓存自官方 `watch`）。模型面判"这条能不能用"用它。 */
  signedIn(): boolean
  /** 官方 `resolveToken`：只对 `api.deepseek.com` 给值；没挂模块就是 `undefined`。 */
  resolveToken(url: string): Promise<string | undefined>
  /**
   * WP150：推理口回 401 时把那一次的令牌报回官方 `rejectToken`（官方只在它仍是当前登录时才清，
   * 清了就发「登录失效」→ 这里接着做收尾）。没挂模块就什么都不做。
   */
  rejectToken(token: string): Promise<void>
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
  /** 用户选过这条路没有。 */
  enabled: boolean
  /**
   * WP150：上一次是登录失效把人登出的（什么时候）。重新登上 / 手动登出就清掉。
   * 落盘是为了重启之后卡片上那句"登录过期了"还在（不是秘密：只有一个时间）。
   */
  expired_at?: string
}

export function createDeepSeekAccount(options: DeepSeekAccountOptions): DeepSeekAccountAssembly {
  const file =
    options.dbDir === undefined ? undefined : join(options.dbDir, 'deepseek-account.json')
  let memory: StateFile = { version: 1, enabled: false }
  const readState = (): StateFile => {
    if (file === undefined) return memory
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateFile>
      return {
        version: 1,
        enabled: parsed.enabled === true,
        ...(typeof parsed.expired_at === 'string' ? { expired_at: parsed.expired_at } : {}),
      }
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
      const dshHome = options.dshHome
      if (dshHome === undefined) {
        throw new ApiError(
          'invalid_input',
          '这个服务进程没有数据目录，DeepSeek 账号的登录凭据无处存放',
        )
      }
      const { createDeepSeekAccountHost } = await import('@agentsws/dsh-adapter/deepseek-account')
      return createDeepSeekAccountHost({ dshHome })
    })

  let host: DeepSeekAccountHost | undefined
  let mounting: Promise<DeepSeekAccountHost> | undefined
  let watching: AbortController | undefined
  /** WP150：退订官方「登录失效」通知。 */
  let offExpired: (() => void) | undefined
  const now = options.now ?? (() => new Date().toISOString())
  let signed = false
  let graceTimer: NodeJS.Timeout | undefined

  const available = (): boolean => options.runtimeMode() === 'local'

  const setSigned = (next: boolean): void => {
    if (next === signed) return
    signed = next
    // WP150：重新登上了——"登录过期了"那句话就不用再说了
    if (next) {
      const st = readState()
      if (st.expired_at !== undefined) writeState({ version: 1, enabled: st.enabled })
    }
    options.onChange?.()
  }

  /**
   * WP150：官方说登录失效了（本机凭据官方已经删了）。记下"是失效登出的"，再走和手动登出同一条路的收尾：
   * 先停掉正在用这个账号跑的事，再让装配方摘掉各品牌里那一条模型来源。官方模块**不摘**——
   * 用户多半马上要点"重新登录"。
   */
  const expired = async (): Promise<void> => {
    const st = readState()
    writeState({ version: 1, enabled: st.enabled, expired_at: now() })
    setSigned(false)
    try {
      await options.tasks?.stop(DEEPSEEK_EXPIRED_STOPPED)
    } catch {
      // 停不下来的那一次会在下一次问模型时以"要重新登录"失败，原因同样清楚
    }
    try {
      await options.onExpired?.()
    } catch {
      // 摘不掉也不要紧：这条来源没有登录就挂不上网关（hasKey = 登录了没有）
    }
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
      offExpired = h.onSessionExpired?.(() => {
        void expired()
      })
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
    offExpired?.()
    offExpired = undefined
    const h = host
    host = undefined
    setSigned(false)
    await h?.dispose()
  }

  const base = (): DeepSeekAccountView => {
    const at = available() ? readState().expired_at : undefined
    return {
      available: available(),
      ...(available() ? {} : { unavailable_reason: DEEPSEEK_ACCOUNT_UNAVAILABLE }),
      enabled: host !== undefined,
      signed_in: false,
      default_model: DEEPSEEK_ACCOUNT_DEFAULT_MODEL,
      region: 'cn',
      ...(at === undefined ? {} : { session_expired: { at, message: DEEPSEEK_SESSION_EXPIRED } }),
    }
  }

  const wallets = (rows: readonly { currency: 'CNY' | 'USD'; balance: string }[]) =>
    rows.map((w): DeepSeekWalletView => ({ currency: w.currency, balance: w.balance }))

  const view = async (recheck = true): Promise<DeepSeekAccountView> => {
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
    // 登录着：session_expired 那一格不给（base 里读的是上一次的，setSigned(true) 已清）
    delete result.session_expired
    const [profile, balance] = await Promise.all([
      h.profile().catch(() => ({ status: 'failed' as const })),
      h.balance().catch(() => ({ status: 'failed' as const })),
    ])
    /*
     * WP150：官方在资料 / 余额口回 401 / 40003 时当场清掉登录、回 `null`。这一刻再看一次状态，
     * 界面这一轮拿到的就已经是"登录过期了"，而不是一张半空的"已登录"。
     */
    if ((profile === null || balance === null) && recheck) {
      const again = await h.state().catch(() => undefined)
      if (again?.status !== 'credential-stored') return view(false)
    }
    const running = options.tasks?.list() ?? []
    if (running.length > 0) result.running_tasks = running
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
    rejectToken: async (token) => {
      await host?.rejectToken?.(token)
    },
    handle: (req, res) => host?.handle(req, res) ?? false,
    view: () => view(),

    async login() {
      if (!available()) throw new ApiError('forbidden', DEEPSEEK_ACCOUNT_UNAVAILABLE)
      const origin = options.callbackOrigin()
      if (origin === undefined) {
        throw new ApiError('invalid_input', '服务还没起来（没有本机回调地址），稍后再点一次登录')
      }
      const h = await mount()
      // 起登录不清"登录过期了"那一笔：真登上了（setSigned(true)）才清
      writeState({ ...readState(), version: 1, enabled: true })
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
      // WP150：先停掉正在用这个账号跑的事（界面已经让人确认过），再登出
      if ((options.tasks?.list().length ?? 0) > 0) {
        await options.tasks?.stop(DEEPSEEK_SIGN_OUT_STOPPED)
      }
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

/**
 * demo / 截图用的替身（**一个字节都不出网**）：宿主换成 `createStandInDeepSeekAccountHost`
 * （授权页就是本机回调、打开即登录，账号与余额是替身数据），推理口换成一个认得测试图的假
 * Messages 口（三步验证照常跑、照常过）。生产路径从不调它。
 */
export function deepseekAccountStandIn(
  options: { balance?: 'ok' | 'fail' } = {},
): NonNullable<import('./server.js').ServerOptions['deepseekAccount']> {
  return {
    createHost: async () => {
      const { createStandInDeepSeekAccountHost } = await import(
        '@agentsws/dsh-adapter/deepseek-account-stand-in'
      )
      return createStandInDeepSeekAccountHost(
        options.balance === undefined ? {} : { balance: options.balance },
      )
    },
    fetch: async (_url, init) => {
      const { VISION_PROBE_WORD } = await import('@agentsws/model-gateway')
      const req = JSON.parse(init.body) as { messages: { content: { type: string }[] }[] }
      const image = req.messages.some((m) => m.content.some((b) => b.type === 'image'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: image ? VISION_PROBE_WORD : '好' }],
          usage: { input_tokens: 12, output_tokens: 1 },
        }),
        text: async () => '',
      }
    },
    signOutGraceMs: 0,
  }
}
