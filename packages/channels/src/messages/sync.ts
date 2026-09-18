/**
 * WP113（63 §3）：**全量同步**。
 *
 * WP55 那一版只扫 INBOX，而且只为了"把客户来信变成事项"。这一版要把整只邮箱
 * 接进来：INBOX + 已发 + 草稿 + 垃圾箱 + `kefuagents` + `kolagents`，一个文件夹
 * 一个 UID 游标（IMAP 的 UID 只在文件夹内唯一，这一条不是可选项）。
 *
 * **沿用 WP55 的那一套，不另起炉灶**（`cursors.ts`）：每文件夹 UID 游标、
 * `UIDVALIDITY` 作废重来、毒消息隔离、扫描租约。区别只有两处：
 *
 * 1. 租约的 key 是 `msg:<地址>` 而不是 `<地址>`。**故意错开**：邮件适配器
 *    （`EmailChannelAdapter`）自己也在扫这只邮箱的 INBOX，两边抢同一把租约的话
 *    谁也扫不动。它们看的是同一堆信，做的是两件事——那边把客户来信变成事项，
 *    这边把每一封信落进消息库。
 * 2. 首次只回溯最近 30 天 / 最多 2000 封（{@link DEFAULT_BACKFILL_DAYS} /
 *    {@link DEFAULT_BACKFILL_LIMIT}）。一只用了五年的邮箱有几万封信，
 *    第一次打开消息页不该等十分钟。人要更早的按"再往前取"。
 */

import type {
  Clock,
  Iso8601,
  MessageFolderKind,
  MessageRecord,
  MessageSyncReport,
  MessageTriage,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  advanceCursor,
  clearFault,
  type FolderSyncFault,
  isSkipped,
  type MailboxStateStore,
  recordFault,
  resumeFrom,
} from '../email/cursors.js'
import type { MailSource, RawEmailMessage } from '../email/imap.js'
import { ChannelError } from '../errors.js'
import type { RawStore } from '../raw-store.js'
import { parseMessage } from './parse.js'
import { folderKindOf, type MessageStore } from './store.js'
import type { MailboxWriter } from './writeback.js'

/** 首次回溯多少天。 */
export const DEFAULT_BACKFILL_DAYS = 30
/** 首次最多拉多少封。 */
export const DEFAULT_BACKFILL_LIMIT = 2000

/**
 * 默认要扫的文件夹（语义）。真名按服务器上的清单解析——各家叫法不一样。
 *
 * 草稿箱也在里面：一个普通邮箱该有草稿，而用户在手机上起的那份草稿只能从
 * 服务器上拿。
 */
export const DEFAULT_SYNC_FOLDER_KINDS: readonly MessageFolderKind[] = [
  'inbox',
  'sent',
  'drafts',
  'trash',
  'spam',
  'support',
  'kol',
]

/** 一只邮箱的装配（每个文件夹一个 `MailSource`）。 */
export interface MailboxAccount {
  address: string
  /** 这只邮箱上要扫哪几个文件夹（真名）。 */
  folders: readonly string[]
  /** 按文件夹开一个收信端口。测试注入内存实现。 */
  open(folder: string): MailSource
  /** 回写端（已读 / 星标 / 挪信）。不给 = 只改本机（63 §7 的降级）。 */
  writer?: MailboxWriter
}

export interface MailboxSyncOptions {
  clock: Clock
  workspace_id: WorkspaceId
  store: MessageStore
  /** 每文件夹游标 / 毒消息隔离 / 租约，沿用 WP55 那一套。 */
  state: MailboxStateStore
  accounts(): readonly MailboxAccount[]
  /** 分拣一封新来信。由宿主注入（规则 + 模型都在它后面）。 */
  triage(record: MessageRecord): Promise<MessageTriage>
  /**
   * 分拣判成 `support` / `kol` 之后**真正要做的事**（交给客服流程 / 归并到红人
   * 合作线程）。回 `false` = 那一侧不接（岗位没开、线程建不了），此时**不挪信**。
   */
  handoff?(record: MessageRecord, triage: MessageTriage): Promise<boolean>
  /** 原始 MIME 落受控原始材料区；不给就不落（测试）。 */
  rawStore?: RawStore
  backfill_days?: number
  backfill_limit?: number
  scan_owner?: string
  on_error?: (e: unknown) => void
  on_folder_fault?: (fault: FolderSyncFault & { account: string; quarantined: boolean }) => void
}

/** 同步器。调度器每分钟调一次 {@link MailboxSync.sync}。 */
export class MailboxSync {
  private readonly opts: MailboxSyncOptions
  private readonly owner: string
  /** 「再往前取」按过之后，这只邮箱的回溯下界（毫秒）。 */
  private readonly floorMs = new Map<string, number>()

  constructor(opts: MailboxSyncOptions) {
    this.opts = opts
    this.owner = opts.scan_owner ?? `msgsync_${process.pid}`
  }

  /** 拉一轮所有邮箱的所有文件夹。一只坏了不拖垮别的。 */
  async sync(): Promise<MessageSyncReport> {
    const report: MessageSyncReport = {
      accounts: 0,
      folders: 0,
      fetched: 0,
      triaged: 0,
      moved: 0,
      failed: [],
    }
    for (const account of this.opts.accounts()) {
      report.accounts += 1
      const leaseKey = `msg:${account.address}`
      const got = await this.opts.state.claimScanLease(
        leaseKey,
        this.owner,
        Date.parse(this.opts.clock.now()),
        180_000,
      )
      // 别人正在扫这只邮箱：让开，下一轮再来（两个进程各推各的游标 = 谁也说不清）
      if (!got) continue
      try {
        for (const folder of account.folders) {
          report.folders += 1
          try {
            await this.syncFolder(account, folder, report)
          } catch (e) {
            this.opts.on_error?.(e)
            report.failed.push(`${account.address}/${folder}`)
          }
        }
      } finally {
        await this.opts.state.releaseScanLease(leaseKey, this.owner)
      }
    }
    return report
  }

  /** 「再往前取」：把这只邮箱的回溯下界往前挪 `days` 天，下一轮 sync 生效。 */
  backfill(account: string, days = DEFAULT_BACKFILL_DAYS): Iso8601 {
    const base =
      this.floorMs.get(account) ??
      Date.parse(this.opts.clock.now()) -
        (this.opts.backfill_days ?? DEFAULT_BACKFILL_DAYS) * 86_400_000
    const next = base - days * 86_400_000
    this.floorMs.set(account, next)
    return new Date(next).toISOString()
  }

  /** 这只邮箱现在回溯到哪一天（界面上"再往前取"旁边那句话）。 */
  backfillFloor(account: string): Iso8601 {
    return new Date(this.floorOf(account)).toISOString()
  }

  private floorOf(account: string): number {
    const explicit = this.floorMs.get(account)
    if (explicit !== undefined) return explicit
    const days = this.opts.backfill_days ?? DEFAULT_BACKFILL_DAYS
    return Date.parse(this.opts.clock.now()) - days * 86_400_000
  }

  private async syncFolder(
    account: MailboxAccount,
    folder: string,
    report: MessageSyncReport,
  ): Promise<void> {
    const { state, store, clock } = this.opts
    const source = account.open(folder)
    const now = clock.now()
    const uid_validity = (await source.uidValidity?.()) ?? 0
    const prior = await state.cursor(account.address, folder)
    const since = resumeFrom(prior, uid_validity)
    let cursor = prior
    let fault = await state.fault(account.address, folder)
    let blocked: number | undefined

    const advance = async (uid: number): Promise<void> => {
      if (blocked !== undefined) return
      cursor = advanceCursor(cursor, folder, uid_validity, uid)
      await state.setCursor(account.address, cursor)
    }

    const limit = this.opts.backfill_limit ?? DEFAULT_BACKFILL_LIMIT
    const batch = await source.fetchSince(since, limit)
    const floor = this.floorOf(account.address)

    for (const raw of batch) {
      if (isSkipped(fault, raw.uid)) {
        await advance(raw.uid)
        continue
      }
      try {
        const handled = await this.ingest(account, folder, raw, floor, report)
        report.fetched += handled ? 1 : 0
        await advance(raw.uid)
        const cleared = clearFault(fault, folder, raw.uid)
        if (cleared !== fault && cleared !== undefined) {
          fault = cleared
          await state.setFault(account.address, cleared)
        }
      } catch (e) {
        // 毒消息隔离：记一笔、跳过、继续（WP55 的原样）
        this.opts.on_error?.(e)
        const next = recordFault(fault, {
          folder,
          uid: raw.uid,
          error: e instanceof Error ? e.message : String(e),
          at: now,
        })
        fault = next.fault
        await state.setFault(account.address, next.fault)
        this.opts.on_folder_fault?.({
          ...next.fault,
          account: account.address,
          quarantined: next.quarantined,
        })
        if (next.quarantined) await advance(raw.uid)
        else if (blocked === undefined) blocked = raw.uid
      }
    }
    void store
  }

  /** 一封信：解析 → 去重 → 落库 → 分拣 → （必要时）交接与挪信。 */
  private async ingest(
    account: MailboxAccount,
    folder: string,
    raw: RawEmailMessage,
    floorMs: number,
    report: MessageSyncReport,
  ): Promise<boolean> {
    const { store, clock, workspace_id } = this.opts
    const parsed = await parseMessage({
      raw,
      account: account.address,
      folder,
      workspace_id,
      received_at: clock.now(),
      ...(this.opts.rawStore === undefined ? {} : { rawStore: this.opts.rawStore }),
    })
    // 回溯下界之外的：游标照推（不再重拉），但不落库
    if (Date.parse(parsed.date) < floorMs) return false

    const mid = parsed.message_id
    if (mid !== undefined) {
      const existing = await store.find(account.address, mid)
      if (existing !== undefined) {
        // 同一封信换了文件夹（人在手机上挪过）：更新它的位置，不重新分拣
        if (existing.folder !== folder) {
          await store.update(existing.id, {
            folder,
            folder_kind: folderKindOf(folder),
            uid: raw.uid,
          })
        }
        return false
      }
    }
    await store.put(parsed)

    // 已发 / 草稿 / 垃圾箱里的信不分拣——分拣说的是"这封来信归谁"，
    // 而这三个文件夹里的东西要么是自己写的，要么已经被判过了
    const kind = parsed.folder_kind
    if (kind === 'sent' || kind === 'drafts' || kind === 'trash') return true

    const triage = await this.opts.triage(parsed)
    report.triaged += 1
    await store.update(parsed.id, { triage, route: triage.route, labels: triage.labels })

    if (triage.route === 'inbox') return true
    // 交接给客服 / 红人那一侧；那边不接就**不挪信**（信留在 INBOX 仍然看得见）
    const accepted = (await this.opts.handoff?.(parsed, triage)) ?? false
    if (!accepted) return true
    const to = triage.route === 'support' ? 'kefuagents' : 'kolagents'
    const moved = (await account.writer?.move(folder, raw.uid, to)) ?? false
    if (moved) {
      report.moved += 1
      await store.update(parsed.id, { folder: to, folder_kind: folderKindOf(to) })
    } else {
      // MOVE 失败只 log：信仍在消息里可见（WP55 的纪律）
      this.opts.on_error?.(
        new ChannelError('provider_unavailable', `挪不动：${folder} → ${to}（uid ${raw.uid}）`),
      )
    }
    return true
  }
}
