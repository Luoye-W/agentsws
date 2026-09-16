/**
 * ClawBot 的两样持久状态：**长轮询游标**与 **`context_token` 缓存**（WP85）。
 *
 * ## ① 游标 `get_updates_buf`
 *
 * 官方的 `getupdates` 是「把上一轮服务端给的 buf 原样带回去」的长轮询
 * （`monitor.ts` 把它落在 `~/.openclaw/.../{accountId}.sync.json`）。
 * 只在内存里的后果与邮箱 UID 游标一模一样：进程一重启就从头拉，
 * 去重表能挡住产出、挡不住那一轮的开销，也挡不住去重窗口之外的老消息
 * 重新变成事项。所以它必须落盘，而且**按账号**落——一台机器上可能不止一个人。
 *
 * ## ② `context_token`
 *
 * 官方 `sendmessage` 要回传**最近一条入站消息**里的 `context_token`；缺了它
 * 客户端只是记一条 warning 照发，服务端收不收是另一回事（协议文档原话）。
 * 派工说明另给了两条**协议文档里查不到**的事实：约 15h 失效、失效时
 * `ret=-2 prepare failed`。我们的处理不赌这两个数字：
 *
 * - 缓存带一个**可注入**的 TTL（缺省 15h），过期就当没有；
 * - 真发出去撞上 `-2` 就把这一条丢掉，**不重试、不重扫**，
 *   只回一句人话让本人再发一条消息（新的入站会带来新的 token）。
 *
 * 这一条不是保守过头：ClawBot 的定位是「本人 ↔ 本人的代理」，本人随时会再说话；
 * 为了抢着回一句而去反复试一个已经失效的会话上下文，换来的只有账号风险（6.1 / 6.4）。
 */

import type { MaybePromise } from '@agentsws/contracts'

/** 一条缓存的会话上下文。 */
export interface CachedContextToken {
  token: string
  expires_at_ms: number
}

/**
 * 端口：游标 + `context_token`。两样放一起是因为生命周期一样——
 * 都跟着「这个微信账号」走，解绑时一起清掉。
 */
export interface ClawBotStateStore {
  cursor(account: string): MaybePromise<string | undefined>
  setCursor(account: string, get_updates_buf: string): MaybePromise<void>
  /** 没有 / 已过期都返回 `undefined`（过期判断由调用方给的 `now_ms` 决定）。 */
  contextToken(account: string, user_id: string, now_ms: number): MaybePromise<string | undefined>
  setContextToken(account: string, user_id: string, value: CachedContextToken): MaybePromise<void>
  clearContextToken(account: string, user_id: string): MaybePromise<void>
  /** 解绑：这个账号的一切状态一起没。 */
  clear(account: string): MaybePromise<void>
}

export class MemoryClawBotStateStore implements ClawBotStateStore {
  private readonly cursors = new Map<string, string>()
  private readonly tokens = new Map<string, CachedContextToken>()

  cursor(account: string): string | undefined {
    return this.cursors.get(account)
  }

  setCursor(account: string, get_updates_buf: string): void {
    this.cursors.set(account, get_updates_buf)
  }

  contextToken(account: string, user_id: string, now_ms: number): string | undefined {
    const row = this.tokens.get(`${account}|${user_id}`)
    if (row === undefined) return undefined
    if (row.expires_at_ms <= now_ms) {
      this.tokens.delete(`${account}|${user_id}`)
      return undefined
    }
    return row.token
  }

  setContextToken(account: string, user_id: string, value: CachedContextToken): void {
    this.tokens.set(`${account}|${user_id}`, { ...value })
  }

  clearContextToken(account: string, user_id: string): void {
    this.tokens.delete(`${account}|${user_id}`)
  }

  clear(account: string): void {
    this.cursors.delete(account)
    for (const key of [...this.tokens.keys()])
      if (key.startsWith(`${account}|`)) this.tokens.delete(key)
  }
}
