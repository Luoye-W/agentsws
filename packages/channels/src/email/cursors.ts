/**
 * Extracted from KefuAgent `support_inbox_connection` 的
 * `folder_cursors` / `folder_sync_faults` / 扫描租约三列（`connection-scan-lease.ts`、
 * `service.ts` 的 `runInboxPollUnderLease` 与 `POISON_MESSAGE_MAX_ATTEMPTS`），
 * rewritten for agentsws contracts。
 *
 * 邮箱加固的三件事（48 §4 L3 #5），每一件都对应一次真实的事故形态：
 *
 * ## ① 每文件夹 UID 游标持久化
 *
 * IMAP 的 UID 只在**一个文件夹内**唯一，所以扫多个文件夹必须一个文件夹一个游标。
 * 游标只在内存里的后果是：进程一重启就从头拉，几百封老信重新进管线——去重表能
 * 挡住产出，挡不住那一轮的网络与解析开销，也挡不住去重窗口（24h）之外的老信
 * 重新变成事项。
 *
 * `uid_validity` 是第二条纪律：服务器重建邮箱时会换掉它，这时**旧游标全部作废**，
 * 必须从 0 重新拉——继续用旧水位会静默漏掉所有信。
 *
 * ## ② 毒消息隔离
 *
 * 一封解析就抛异常的信（畸形 MIME、超大附件、编码炸弹），如果让它卡住游标，
 * 它后面的每一封信都永远进不来。所以：记下它、跳过它、继续拉；连续失败到阈值就
 * 永久越过并出一张卡——**跳过是有记录的跳过**，不是悄悄丢。
 *
 * ## ③ 扫描租约
 *
 * 同一个邮箱同一时刻只该有一个进程在扫。两个进程同时扫的后果不是"扫两遍"，
 * 是两边各自推进游标、各自归档，最后谁也说不清哪封处理过。租约到期自动释放
 * ——持有者崩在半路不该把这只邮箱锁死。
 */

import type { Iso8601, MaybePromise } from '@agentsws/contracts'

/** 一个文件夹的 UID 水位。 */
export interface FolderCursor {
  folder: string
  /**
   * 服务器给的 `UIDVALIDITY`。它一变，`last_seen_uid` 立刻作废——
   * 继续用旧水位会静默漏掉所有信。
   */
  uid_validity: number
  last_seen_uid: number
}

/** 一个文件夹的毒消息隔离状态。 */
export interface FolderSyncFault {
  folder: string
  /** 当前卡住、正在重试的 UID。 */
  failed_uid?: number
  /** 该 UID 连续失败的次数。 */
  fail_count: number
  last_error?: string
  last_failed_at?: Iso8601
  /** 连续失败满阈值后被**永久越过**的 UID（已出卡、已审计）。 */
  skipped_uids: number[]
}

/** 连续失败几次就永久越过。 */
export const POISON_MESSAGE_MAX_ATTEMPTS = 3

/** 扫描租约默认时长：一轮拉取不该超过这么久。 */
export const DEFAULT_SCAN_LEASE_MS = 180_000

/** 归档时是否顺手标已读。 */
export const ARCHIVE_MARK_READ_DEFAULT = true

/**
 * 游标 / 隔离 / 租约的存储端口。
 *
 * 三样放一起是因为它们的生命周期一样：都跟着"这只邮箱"走，都要在重启后还在。
 */
export interface MailboxStateStore {
  cursor(account: string, folder: string): MaybePromise<FolderCursor | undefined>
  setCursor(account: string, cursor: FolderCursor): MaybePromise<void>
  fault(account: string, folder: string): MaybePromise<FolderSyncFault | undefined>
  setFault(account: string, fault: FolderSyncFault): MaybePromise<void>
  /**
   * 原子领取：租约为空或已过期才领得到。领到回 `true`。
   *
   * 必须是**条件写**而不是"先查后写"——两个进程同时读到"没人占着"、然后各自
   * 写上自己，这不是理论问题。
   */
  claimScanLease(
    account: string,
    owner: string,
    now_ms: number,
    ttl_ms: number,
  ): MaybePromise<boolean>
  /** 释放（只有持有者能释放；不是持有者就什么也不做）。 */
  releaseScanLease(account: string, owner: string): MaybePromise<void>
  /** 观察面。 */
  faults(account: string): MaybePromise<FolderSyncFault[]>
}

interface LeaseRow {
  owner: string
  expires_at_ms: number
}

export class MemoryMailboxStateStore implements MailboxStateStore {
  private readonly cursors = new Map<string, FolderCursor>()
  private readonly faultRows = new Map<string, FolderSyncFault>()
  private readonly leases = new Map<string, LeaseRow>()

  cursor(account: string, folder: string): FolderCursor | undefined {
    const row = this.cursors.get(`${account}|${folder}`)
    return row === undefined ? undefined : { ...row }
  }

  setCursor(account: string, cursor: FolderCursor): void {
    this.cursors.set(`${account}|${cursor.folder}`, { ...cursor })
  }

  fault(account: string, folder: string): FolderSyncFault | undefined {
    const row = this.faultRows.get(`${account}|${folder}`)
    return row === undefined ? undefined : { ...row, skipped_uids: [...row.skipped_uids] }
  }

  setFault(account: string, fault: FolderSyncFault): void {
    this.faultRows.set(`${account}|${fault.folder}`, {
      ...fault,
      skipped_uids: [...fault.skipped_uids],
    })
  }

  faults(account: string): FolderSyncFault[] {
    const out: FolderSyncFault[] = []
    for (const [key, row] of this.faultRows)
      if (key.startsWith(`${account}|`)) out.push({ ...row, skipped_uids: [...row.skipped_uids] })
    return out
  }

  claimScanLease(account: string, owner: string, now_ms: number, ttl_ms: number): boolean {
    const held = this.leases.get(account)
    if (held !== undefined && held.expires_at_ms > now_ms && held.owner !== owner) return false
    this.leases.set(account, { owner, expires_at_ms: now_ms + ttl_ms })
    return true
  }

  releaseScanLease(account: string, owner: string): void {
    if (this.leases.get(account)?.owner === owner) this.leases.delete(account)
  }
}

/* ------------------------------------------------------------------ */
/* 纯函数：游标推进与毒消息记账                                           */
/* ------------------------------------------------------------------ */

/**
 * 这一轮该从哪个 UID 之后开始拉。
 *
 * `uid_validity` 变了 = 服务器重建过这个邮箱，旧水位**全部作废**，从 0 重来。
 * 宁可重拉一遍（去重表挡住重复产出），也不要静默漏信。
 */
export function resumeFrom(prior: FolderCursor | undefined, uid_validity: number): number {
  if (prior === undefined) return 0
  if (prior.uid_validity !== uid_validity) return 0
  return prior.last_seen_uid
}

/** 处理完一封信之后的水位（只进不退）。 */
export function advanceCursor(
  prior: FolderCursor | undefined,
  folder: string,
  uid_validity: number,
  uid: number,
): FolderCursor {
  const base = prior !== undefined && prior.uid_validity === uid_validity ? prior.last_seen_uid : 0
  return { folder, uid_validity, last_seen_uid: Math.max(base, uid) }
}

/** 这个 UID 是不是已经被永久越过了（越过了就不该再拉进来）。 */
export function isSkipped(fault: FolderSyncFault | undefined, uid: number): boolean {
  return fault?.skipped_uids.includes(uid) === true
}

/**
 * 一封信解析炸了之后的记账。
 *
 * 返回的 `quarantined` = 这一封已经连续失败到阈值，**永久越过**（游标推过它、
 * 出一张卡），下一轮不再碰它。没到阈值就只记一笔，下一轮还会再试一次——
 * 很多"解析失败"其实是那一瞬间的内存 / 网络抖动。
 */
export function recordFault(
  prior: FolderSyncFault | undefined,
  input: { folder: string; uid: number; error: string; at: Iso8601 },
): { fault: FolderSyncFault; quarantined: boolean } {
  const sameUid = prior?.failed_uid === input.uid
  const fail_count = (sameUid ? prior.fail_count : 0) + 1
  const skipped = [...(prior?.skipped_uids ?? [])]
  const quarantined = fail_count >= POISON_MESSAGE_MAX_ATTEMPTS
  if (quarantined && !skipped.includes(input.uid)) skipped.push(input.uid)
  return {
    quarantined,
    fault: {
      folder: input.folder,
      failed_uid: input.uid,
      fail_count,
      last_error: input.error.slice(0, 500),
      last_failed_at: input.at,
      skipped_uids: skipped,
    },
  }
}

/** 一封信处理成功之后：如果它正是卡住的那一封，把计数清掉。 */
export function clearFault(
  prior: FolderSyncFault | undefined,
  folder: string,
  uid: number,
): FolderSyncFault | undefined {
  if (prior === undefined) return undefined
  if (prior.failed_uid !== uid) return prior
  const next: FolderSyncFault = { folder, fail_count: 0, skipped_uids: [...prior.skipped_uids] }
  return next
}
