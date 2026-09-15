/**
 * 网站聊天窗的**公开访客面**（48 §4 L3 #11 的云端那一半，WP60）。
 *
 * WP57 那一版把话说得很清楚：公开访客端点"不是还没做，是故意不做"——
 * 一条不需要凭据就能写进工作区的路由，放在本地单机档里没有任何人受益，
 * 却让每一台跑着 agentsws 的机器多一个对外的写入口。
 *
 * 托管档改变的是这个判断的前提：值守起来之后，这个服务进程**本来就在公网后面**
 * （云进程的 `/w/<ws>/*` 反向代理），聊天窗是这一档卖的东西之一。所以这一层现在要做，
 * 但那条理由一个字都没变——它变成了这里的四道门：
 *
 * 1. **来源域名白名单**（`allowed_origins`）。**空 = 全拒**，不是全放。
 *    默认值要是放行所有，那么每个开了值守的工作区都自带一个任何人可写的入口。
 * 2. **限流**（`ChatRateLimiter`，与 WP57 同一个模块）。两处：建会话按来源计，
 *    发消息按访客计（后者在 `ChatChannelAdapter` 里本来就有）。
 * 3. **访客令牌**。建会话时给一把，之后每一次读写都要带。没有它，
 *    知道 `session_id` 的任何人都能读别人的对话——而 id 会出现在日志里。
 *    令牌是 `HMAC(secret, session_id)`：**不落库**，验就是重算一次。
 * 4. **凭据不进 URL**（20 §3 / 21 §5）。SSE 那条也走 `Authorization` 头，
 *    所以嵌入脚本用 `fetch` + `ReadableStream` 而不是 `EventSource`。
 *
 * 已有的登录态路由（`/v1/chat/sessions/*`）**一条都没动**。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatWidgetSettings } from '@agentsws/api'
import { ChatRateLimiter } from '@agentsws/channels'
import type {
  ChatWidgetConfig,
  ChatWidgetPublicConfig,
  Clock,
  WorkspaceId,
} from '@agentsws/contracts'
import { DEFAULT_CHAT_WIDGET_CONFIG } from '@agentsws/contracts'
import type { ChatLane } from './chat.js'
import type { SecretStore } from './secret-store.js'

/** 访客令牌的 HMAC 密钥在本机加密库里的 id。 */
export const WIDGET_SECRET_ID = 'chat.widget_visitor_secret'

/** widget 配置落在数据目录里的哪个文件。 */
export const WIDGET_CONFIG_FILE = 'chat-widget.json'

/** 默认主色与默认招呼语（商家没填就用这两个）。 */
export const DEFAULT_ACCENT = '#2563eb'
export const DEFAULT_GREETING = '你好，有什么可以帮你的？'

/**
 * 建会话的限流：**按来源域名**计，比发消息那条严得多。
 *
 * 为什么不按访客计：建会话这一步还没有访客——访客 id 是这一步的产物。
 * 按来源计意味着一个被刷的商家网站会挡住它自己那一路的新会话，
 * 而不会影响别的工作区（一个进程只服务一个工作区，这里的"别的"指别的来源）。
 */
export const SESSION_RATE = { per_minute: 10, per_hour: 60 }

interface WidgetFile {
  version: 1
  config: ChatWidgetConfig
  updated_at?: string
}

export interface ChatWidgetOptions {
  workspace_id: WorkspaceId
  clock: Clock
  chat: ChatLane
  /** `chat-widget.json` 的目录；不给就全内存（测试与一次性任务）。 */
  dbDir?: string
  /** 访客令牌的 HMAC 密钥从这里取；没有就用一把每进程的随机值。 */
  secrets?: SecretStore
}

export interface ChatWidgetAssembly {
  /** owner 读写的那一份（含 `allowed_origins`）。 */
  config(): ChatWidgetConfig
  setConfig(input: ChatWidgetConfig): ChatWidgetSettings
  /**
   * 这个 `Origin` 放不放行。放行就回**原样的 origin**（要写进
   * `Access-Control-Allow-Origin`，那里不能写 `*` 与带凭据的请求并存）。
   */
  allowedOrigin(origin: string | undefined): string | undefined
  /** 访客那一面看到的配置（**不含白名单**）。 */
  publicConfig(origin: string | undefined): ChatWidgetPublicConfig | undefined
  /** 开一条公开会话；被限流就回 `undefined` + `retry_after`。 */
  open(input: {
    origin: string | undefined
  }): Promise<
    { session_id: string; visitor_token: string } | { rate_limited: true; retry_after: number }
  >
  /** 这把访客令牌配不配这条会话。 */
  verify(session_id: string, token: string | undefined): boolean
}

/** `https://shop.example.com/a/b` → `https://shop.example.com`；不像地址就 `undefined`。 */
export function originOf(raw: string | undefined): string | undefined {
  const text = raw?.trim()
  if (text === undefined || text === '' || text === 'null') return undefined
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/** `#RRGGBB`；不合规就退回默认色（不把用户填的字符串直接塞进 CSS）。 */
export function safeAccent(raw: string | undefined): string {
  if (raw !== undefined && /^#[0-9a-fA-F]{6}$/.test(raw.trim())) return raw.trim().toLowerCase()
  return DEFAULT_ACCENT
}

export function createChatWidget(options: ChatWidgetOptions): ChatWidgetAssembly {
  const { clock, chat } = options
  const stateFile =
    options.dbDir === undefined ? undefined : join(options.dbDir, WIDGET_CONFIG_FILE)

  let state: WidgetFile = { version: 1, config: { ...DEFAULT_CHAT_WIDGET_CONFIG } }
  if (stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as WidgetFile
      state = {
        version: 1,
        config: {
          allowed_origins: parsed.config?.allowed_origins ?? [],
          ...(parsed.config?.accent === undefined ? {} : { accent: parsed.config.accent }),
          ...(parsed.config?.greeting === undefined ? {} : { greeting: parsed.config.greeting }),
        },
        ...(parsed.updated_at === undefined ? {} : { updated_at: parsed.updated_at }),
      }
    } catch {
      // 第一次跑，或者文件坏了：从"一个来源都不放行"开始，正是安全的默认值
    }
  }
  const flush = (): void => {
    if (stateFile === undefined) return
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  /*
   * 访客令牌的密钥。
   *
   * 进本机加密库（与邮箱口令、模型 key 同一个库、同一把密钥）；库不可用时
   * 退回一把每进程的随机值——那时重启会让已经开着的聊天窗重新建一条会话，
   * 这是**能看见的退化**，比"把密钥明文写进数据目录"好。
   *
   * **懒生成**：第一次真有访客用聊天窗时才写进秘密库。没开聊天窗的机器
   * （绝大多数本地单机档）秘密库里不该凭空多一行——那行会跟着每一份备份走，
   * 而且会让"这台机器存了哪些秘密"这个问题多一个要解释的答案。
   */
  let secret: Buffer | undefined
  const secretOf = (): Buffer => {
    if (secret !== undefined) return secret
    const secrets = options.secrets
    if (secrets !== undefined && secrets.available) {
      try {
        const existing = secrets.get(WIDGET_SECRET_ID)?.token
        if (existing !== undefined && existing !== '') {
          secret = Buffer.from(existing, 'base64')
          return secret
        }
        const fresh = randomBytes(32)
        secrets.put(WIDGET_SECRET_ID, { token: fresh.toString('base64') })
        secret = fresh
        return secret
      } catch {
        // 换过秘密库密钥：这一程用随机的
      }
    }
    secret = randomBytes(32)
    return secret
  }

  const tokenOf = (session_id: string): string =>
    createHmac('sha256', secretOf()).update(session_id).digest('base64url')

  const limiter = new ChatRateLimiter(SESSION_RATE)

  const allowedOrigin = (raw: string | undefined): string | undefined => {
    const origin = originOf(raw)
    if (origin === undefined) return undefined
    // 空列表 = 全拒（契约里写死的默认值），不是全放
    return state.config.allowed_origins.some((a) => originOf(a) === origin) ? origin : undefined
  }

  return {
    config: () => ({ ...state.config, allowed_origins: [...state.config.allowed_origins] }),

    setConfig(input): ChatWidgetSettings {
      const origins: string[] = []
      for (const raw of input.allowed_origins) {
        const origin = originOf(raw)
        if (origin !== undefined && !origins.includes(origin)) origins.push(origin)
      }
      const accent = input.accent?.trim()
      const greeting = input.greeting?.trim()
      state = {
        version: 1,
        config: {
          allowed_origins: origins,
          ...(accent === undefined || accent === '' ? {} : { accent: safeAccent(accent) }),
          ...(greeting === undefined || greeting === '' ? {} : { greeting }),
        },
        updated_at: clock.now(),
      }
      flush()
      return { ...state.config, updated_at: state.updated_at as string }
    },

    allowedOrigin,

    publicConfig(raw): ChatWidgetPublicConfig | undefined {
      // 放不放行只由这一个布尔说完：访客没有理由知道这家店还允许哪些站点嵌它
      if (allowedOrigin(raw) === undefined)
        return { enabled: false, accent: DEFAULT_ACCENT, greeting: '' }
      return {
        enabled: true,
        accent: safeAccent(state.config.accent),
        greeting: state.config.greeting ?? DEFAULT_GREETING,
      }
    },

    async open(input) {
      const origin = allowedOrigin(input.origin)
      if (origin === undefined) throw new Error('origin_not_allowed')
      const verdict = limiter.take(options.workspace_id, origin, Date.parse(clock.now()))
      if (!verdict.allowed) return { rate_limited: true, retry_after: verdict.retry_after ?? 60 }
      /*
       * 访客 id 是随机的，不是从 IP / UA / cookie 推出来的。
       *
       * 它是受控原始材料区的加密主体键（21 §4 随主体删除按它走），
       * 所以它不该能被反推回一个自然人——从 IP 派生就正好做反了这件事。
       */
      const visitor_id = `widget_${randomBytes(12).toString('base64url')}`
      const session = await chat.openSession({
        source: 'widget',
        external_session_id: `widget:${visitor_id}`,
        visitor_id,
        visitor_display: '网站访客',
      })
      return { session_id: session.id, visitor_token: tokenOf(session.id) }
    },

    verify(session_id, token) {
      if (token === undefined || token === '') return false
      const expected = Buffer.from(tokenOf(session_id))
      const given = Buffer.from(token)
      // 定长比较：长度不同直接不等，长度相同走 timingSafeEqual
      return expected.length === given.length && timingSafeEqual(expected, given)
    },
  }
}
