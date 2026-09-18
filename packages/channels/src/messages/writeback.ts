/**
 * WP113（63 §7）：**回写 IMAP**。
 *
 * 已读、星标、归档、删除都要回写，理由只有一句：用户回到自己的邮箱软件里看到的
 * 必须是同一个状态。做不到这一点的"集成"比不集成更糟——他得在两个地方各读一遍。
 *
 * 端口化（{@link MailboxWriter}）与 `MailSource` 同一条理由：测试里不能真去连一只
 * 邮箱。真实现是 {@link ImapMailboxWriter}，替身在 `test/` 里。
 *
 * **失败只 log**（沿用 WP55 归档那条纪律）：服务器拒绝 MOVE、文件夹建不了、
 * 这一瞬间连不上——信仍然在消息库里看得见，本机状态照改。回写是"让两边一致"的
 * 努力，不是收信的前提条件。
 */

import type { MaybePromise } from '@agentsws/contracts'
import type { CredentialSource } from '../email/imap.js'
import {
  defaultImapClient,
  type ImapClientLike,
  type ImapConfig,
  readPassword,
} from '../email/imap.js'

/** 回写端口。四个方法都**永不抛**，回 `false` = 没写成（调用方只记一条日志）。 */
export interface MailboxWriter {
  /** 加 / 去 flag（`\Seen`、`\Flagged`、`\Answered`，以及标签同步用的 keyword）。 */
  setFlags(
    folder: string,
    uid: number,
    add: readonly string[],
    remove: readonly string[],
  ): MaybePromise<boolean>
  /** 搬到另一个文件夹（目标不存在就先建一个）。 */
  move(folder: string, uid: number, to: string): MaybePromise<boolean>
  /** 这台服务器上有哪些文件夹（同步与"挪到哪儿"要按真名走）。 */
  listFolders?(): MaybePromise<string[]>
  /**
   * 这个文件夹支持自定义 keyword 吗（`PERMANENTFLAGS` 含 `\*`）。
   *
   * 支持 = 标签顺手同步成 keyword；不支持 = **只在本地**（63 §5）。
   * 不许为了标签去挪信——那会改变用户邮箱里的结构。
   */
  keywordsSupported?(folder: string): MaybePromise<boolean>
}

/** 一个什么都不做的回写端（没接邮箱、或用户关掉了回写时用）。 */
export const NO_WRITEBACK: MailboxWriter = {
  setFlags: () => false,
  move: () => false,
}

export interface ImapMailboxWriterOptions {
  config: ImapConfig
  createClient?: (config: ImapConfig, password: string) => ImapClientLike
  env?: NodeJS.ProcessEnv
  credentials?: CredentialSource
  /** 写不动时记一条（不抛）。 */
  onError?: (e: unknown) => void
}

/** 真 IMAP 回写。每次开一条连接、写、登出——与 `ImapMailSource` 同一档做法。 */
export class ImapMailboxWriter implements MailboxWriter {
  private readonly config: ImapConfig
  private readonly env: NodeJS.ProcessEnv
  private readonly createClient: (config: ImapConfig, password: string) => ImapClientLike
  private readonly credentials: CredentialSource | undefined
  private readonly onError: ((e: unknown) => void) | undefined

  constructor(opts: ImapMailboxWriterOptions) {
    this.config = opts.config
    this.env = opts.env ?? process.env
    this.createClient = opts.createClient ?? defaultImapClient
    this.credentials = opts.credentials
    this.onError = opts.onError
  }

  private client(): ImapClientLike {
    const password = readPassword(this.config, this.env, this.credentials)
    if (password === undefined)
      throw new Error('IMAP 回写要口令：既没有 password_env 也没有 connection_id')
    return this.createClient(this.config, password)
  }

  async setFlags(
    folder: string,
    uid: number,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<boolean> {
    let client: ImapClientLike | undefined
    try {
      client = this.client()
      await client.connect()
      const lock = await client.getMailboxLock(folder)
      try {
        if (add.length > 0) await client.messageFlagsAdd?.(String(uid), [...add], { uid: true })
        if (remove.length > 0)
          await client.messageFlagsRemove?.(String(uid), [...remove], { uid: true })
      } finally {
        lock.release()
      }
      await client.logout()
      return true
    } catch (e) {
      client?.close()
      this.onError?.(e)
      return false
    }
  }

  async move(folder: string, uid: number, to: string): Promise<boolean> {
    let client: ImapClientLike | undefined
    try {
      client = this.client()
      await client.connect()
      const lock = await client.getMailboxLock(folder)
      try {
        try {
          await client.messageMove?.(String(uid), to, { uid: true })
        } catch {
          // 目标文件夹可能还不存在（第一次挪进 kefuagents）：建一个再搬一次
          await client.mailboxCreate?.(to)
          await client.messageMove?.(String(uid), to, { uid: true })
        }
      } finally {
        lock.release()
      }
      await client.logout()
      return true
    } catch (e) {
      client?.close()
      this.onError?.(e)
      return false
    }
  }

  async listFolders(): Promise<string[]> {
    let client: ImapClientLike | undefined
    try {
      client = this.client()
      await client.connect()
      const boxes = (await client.list?.()) ?? []
      await client.logout()
      return boxes.map((b) => b.path)
    } catch (e) {
      client?.close()
      this.onError?.(e)
      return []
    }
  }

  async keywordsSupported(folder: string): Promise<boolean> {
    let client: ImapClientLike | undefined
    try {
      client = this.client()
      await client.connect()
      const box = await client.mailboxOpen?.(folder)
      await client.logout()
      const perm = box?.permanentFlags
      // `\*` = 服务器允许任意自定义 keyword（RFC 3501 §6.3.1）。
      // imapflow 给的是 Set，替身可能给数组——两种都认。
      if (perm === undefined) return false
      return [...perm].includes('\\*')
    } catch (e) {
      client?.close()
      this.onError?.(e)
      return false
    }
  }
}
