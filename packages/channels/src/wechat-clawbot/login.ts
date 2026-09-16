/**
 * 扫码登录状态机（WP85）。
 *
 * 官方那一份（`login-qr.ts`）是 CLI 形态：一个 `while` 循环边轮询边往 stdout 写字，
 * 配对码从 stdin 读。我们要的是**工作台形态**：起一次拿二维码，前端拿着 `login_id`
 * 自己按节奏问状态，所以这里把那个循环拆成 `start()` + `poll()` 两个可重入的调用，
 * 状态留在一张按 `login_id` 的表里。
 *
 * 三条纪律：
 * 1. **`bot_token` 不从这里出去。** `poll()` 在 `confirmed` 这一档把 token 交给
 *    注入的 `onConfirmed`（装配方把它直接塞进秘密库），返回给调用方的那个对象里
 *    **没有 token 字段**（13 §4.3：凭据不进响应体、不进日志、不经模型）。
 * 2. 时间一律经注入的 Clock；过期、TTL、节流都拿它算，没有一处 `Date.now()`。
 * 3. 服务端让换域名（`scaned_but_redirect`）就换，换完继续轮询同一个 `login_id`。
 */

import type { Clock, MaybePromise } from '@agentsws/contracts'
import { ChannelError } from '../errors.js'
import { ILINK_BASE_URL, type QrcodeStatus, type QrcodeStatusResp } from './protocol.js'
import type { ClawBotTransport } from './transport.js'

/** 一次扫码的存活时间（官方 `ACTIVE_LOGIN_TTL_MS`，已核实）。 */
export const LOGIN_TTL_MS = 5 * 60_000

/** 二维码过期后最多自动换几次（官方 `MAX_QR_REFRESH_COUNT`，已核实）。 */
export const MAX_QR_REFRESH = 3

/** 给工作台看的那一档状态。比线上的状态少几种——界面不需要知道 IDC 重定向。 */
export type LoginView =
  | 'waiting'
  | 'scanned'
  | 'need_verify_code'
  | 'verify_code_blocked'
  | 'confirmed'
  | 'already_connected'
  | 'expired'
  | 'failed'

export interface LoginStartResult {
  login_id: string
  /** 二维码图片的链接（不是秘密，可以进响应体）。 */
  qrcode_url: string
  expires_at: string
}

export interface LoginPollResult {
  login_id: string
  status: LoginView
  /** 换过的新二维码（过期自动换时出现）。 */
  qrcode_url?: string
  /** 连上之后是哪个微信账号（`ilink_bot_id`）。不是秘密。 */
  account_id?: string
  /** 扫码那个人的 `ilink_user_id`：只有他发来的消息才认（allow-list）。不是秘密。 */
  user_id?: string
  /** 人话；直接往界面上摆。 */
  message: string
}

/** `confirmed` 那一刻交出去的东西。**只走这一条路**，别处拿不到 token。 */
export interface ClawBotCredentialHandoff {
  login_id: string
  account_id: string
  /** **秘密**：实现方必须直接写进秘密库，不许转手、不许回显、不许 log。 */
  bot_token: string
  /** 之后所有 Bot API 都打这个域名。 */
  base_url: string
  user_id?: string
}

export interface ClawBotLoginOptions {
  clock: Clock
  transport: ClawBotTransport
  /** 新 id（注入：测试要可重现）。 */
  newId: () => string
  /** `confirmed` 时的唯一出口。抛异常 = 这次登录算失败（凭据也不会留下）。 */
  onConfirmed(handoff: ClawBotCredentialHandoff): MaybePromise<void>
  /** 本机已有的 token（官方拿它认「这台机器已经连过」）。默认没有。 */
  localTokens?: () => MaybePromise<readonly string[]>
  base_url?: string
}

interface LoginSession {
  id: string
  qrcode: string
  qrcode_url: string
  started_at_ms: number
  base_url: string
  refreshes: number
  verify_code: string | undefined
  view: LoginView
}

const MESSAGES: Readonly<Record<LoginView, string>> = {
  waiting: '用手机微信扫一下这个码。',
  scanned: '扫到了，正在你手机上确认。',
  need_verify_code: '手机微信上会显示几位数字，把它填进来。',
  verify_code_blocked: '数字连续填错了几次，微信暂时挡住了。过一会儿再来。',
  confirmed: '连上了。从现在起你可以在微信里直接跟自己的代理说话。',
  already_connected: '这台机器已经连过这个微信了，不用再连一次。',
  expired: '二维码过期了，重新生成一个。',
  failed: '没连上。',
}

/** 线上的状态 → 界面上的那一档。 */
export function viewOf(status: QrcodeStatus): LoginView {
  switch (status) {
    case 'wait':
      return 'waiting'
    case 'scaned':
    case 'scaned_but_redirect':
      return 'scanned'
    case 'need_verifycode':
      return 'need_verify_code'
    case 'verify_code_blocked':
      return 'verify_code_blocked'
    case 'confirmed':
      return 'confirmed'
    case 'binded_redirect':
      return 'already_connected'
    case 'expired':
      return 'expired'
  }
}

export class ClawBotLogin {
  readonly #options: ClawBotLoginOptions
  readonly #sessions = new Map<string, LoginSession>()

  constructor(options: ClawBotLoginOptions) {
    this.#options = options
  }

  /** 起一次扫码。每调一次就是一张新的码（前端「换一张」按钮直接再调它）。 */
  async start(): Promise<LoginStartResult> {
    this.#purge()
    const base_url = this.#options.base_url ?? ILINK_BASE_URL
    const local = (await this.#options.localTokens?.()) ?? []
    const qr = await this.#options.transport.qrcode({ base_url, local_tokens: local })
    const now_ms = Date.parse(this.#options.clock.now())
    const id = this.#options.newId()
    this.#sessions.set(id, {
      id,
      qrcode: qr.qrcode,
      qrcode_url: qr.qrcode_img_content,
      started_at_ms: now_ms,
      base_url,
      refreshes: 0,
      verify_code: undefined,
      view: 'waiting',
    })
    return {
      login_id: id,
      qrcode_url: qr.qrcode_img_content,
      expires_at: new Date(now_ms + LOGIN_TTL_MS).toISOString(),
    }
  }

  /**
   * 问一次状态。前端按自己的节奏调（服务端这边是一次长轮询，最长 35s）。
   *
   * `verify_code` 只在 `need_verify_code` 那一档要——它不是秘密（手机屏幕上就显示着），
   * 但也没有必要留：用过一次就从会话里抹掉。
   */
  async poll(login_id: string, verify_code?: string): Promise<LoginPollResult> {
    const session = this.#sessions.get(login_id)
    if (session === undefined)
      throw new ChannelError('not_found', '这次扫码已经不在了，重新生成一个二维码。')
    const now_ms = Date.parse(this.#options.clock.now())
    if (now_ms - session.started_at_ms >= LOGIN_TTL_MS && session.view !== 'confirmed') {
      return this.#refreshOrGiveUp(session, now_ms)
    }
    if (verify_code !== undefined && verify_code.trim() !== '')
      session.verify_code = verify_code.trim()

    const resp: QrcodeStatusResp = await this.#options.transport.qrcodeStatus({
      base_url: session.base_url,
      qrcode: session.qrcode,
      ...(session.verify_code === undefined ? {} : { verify_code: session.verify_code }),
    })
    const view = viewOf(resp.status)
    session.view = view

    if (resp.status === 'scaned_but_redirect') {
      // IDC 重定向：换个域名接着问同一张码
      const host = resp.redirect_host
      if (host !== undefined && host !== '') session.base_url = `https://${host}`
      return { login_id, status: 'scanned', message: MESSAGES.scanned }
    }
    if (resp.status === 'scaned') {
      // 填对了：配对码用过就不留
      session.verify_code = undefined
      return { login_id, status: 'scanned', message: MESSAGES.scanned }
    }
    if (resp.status === 'expired' || resp.status === 'verify_code_blocked') {
      session.verify_code = undefined
      return this.#refreshOrGiveUp(session, now_ms, view)
    }
    if (resp.status === 'binded_redirect') {
      this.#sessions.delete(login_id)
      return { login_id, status: 'already_connected', message: MESSAGES.already_connected }
    }
    if (resp.status === 'confirmed') {
      const account_id = resp.ilink_bot_id?.trim()
      const token = resp.bot_token?.trim()
      this.#sessions.delete(login_id)
      if (account_id === undefined || account_id === '' || token === undefined || token === '') {
        return {
          login_id,
          status: 'failed',
          message: '微信说确认了，但没给回账号信息。请重新扫一次。',
        }
      }
      const nextBase = resp.baseurl?.trim()
      // 唯一出口：token 从这里直接进秘密库，不回给调用方
      await this.#options.onConfirmed({
        login_id,
        account_id,
        bot_token: token,
        base_url: nextBase === undefined || nextBase === '' ? session.base_url : nextBase,
        ...(resp.ilink_user_id === undefined ? {} : { user_id: resp.ilink_user_id }),
      })
      return {
        login_id,
        status: 'confirmed',
        account_id,
        ...(resp.ilink_user_id === undefined ? {} : { user_id: resp.ilink_user_id }),
        message: MESSAGES.confirmed,
      }
    }
    return { login_id, status: view, message: MESSAGES[view] }
  }

  /** 放弃这次扫码（前端关掉弹窗）。 */
  cancel(login_id: string): void {
    this.#sessions.delete(login_id)
  }

  /** 观察面：还有几次扫码在进行中。 */
  get pending(): number {
    return this.#sessions.size
  }

  async #refreshOrGiveUp(
    session: LoginSession,
    now_ms: number,
    view: LoginView = 'expired',
  ): Promise<LoginPollResult> {
    session.refreshes += 1
    if (session.refreshes > MAX_QR_REFRESH) {
      this.#sessions.delete(session.id)
      return {
        login_id: session.id,
        status: view === 'verify_code_blocked' ? 'verify_code_blocked' : 'expired',
        message:
          view === 'verify_code_blocked'
            ? MESSAGES.verify_code_blocked
            : '二维码连着失效了几次，先停下。过一会儿再试。',
      }
    }
    const local = (await this.#options.localTokens?.()) ?? []
    const qr = await this.#options.transport.qrcode({
      base_url: session.base_url,
      local_tokens: local,
    })
    session.qrcode = qr.qrcode
    session.qrcode_url = qr.qrcode_img_content
    session.started_at_ms = now_ms
    session.view = 'waiting'
    return {
      login_id: session.id,
      status: 'waiting',
      qrcode_url: qr.qrcode_img_content,
      message: '换了一张新的码，再扫一次。',
    }
  }

  #purge(): void {
    const now_ms = Date.parse(this.#options.clock.now())
    for (const [id, s] of [...this.#sessions])
      if (now_ms - s.started_at_ms >= LOGIN_TTL_MS * 2) this.#sessions.delete(id)
  }
}
