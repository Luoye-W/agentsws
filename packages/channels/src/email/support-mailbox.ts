/**
 * WP163：**判成客服的那封信**在邮箱里要做的两件事（标已读 / 挪进 `KefuAgents`）。
 *
 * 语义照搬 Luoye 的老产品 KefuAgent：
 * `src/lib/support/service.ts` 的 `moveCustomerServiceMessageToAiFolder`（约 2030 行起）。
 * 只搬判断顺序与开关含义，不搬它的 drizzle / ImapFlow 写法：
 *
 * 1. 影子模式（`shadowMode`）→ 整条流程照跑，**邮箱一下都不动**，只记一笔「跳过」；
 * 2. 客服文件夹接管关了（`aiSupportFolderEnabled`）→ 同上，记「跳过」；
 * 3. 标已读开关（`aiSupportMarkRead`）→ 先在原文件夹里标已读，成败各记一笔，
 *    **失败不挡挪信**；
 * 4. 挪信开关（`aiSupportMoveEmails`）+ 信不在目标文件夹里 → MOVE，成败各记一笔。
 *
 * 调用方只在「这封信判成客服」之后才调它——非客服信根本走不到这里，原地不动、不标已读。
 * 默认值照老产品的表定义：影子模式关、接管开、挪信开、标已读开。
 */

/** 老产品那四个开关（agentsws 里已有 `archive_folder` / `archive_mark_read` 的，由调用方折算进来）。 */
export interface SupportMailboxSwitches {
  /** 影子模式：只记不动（老产品 `shadowMode`，默认关）。 */
  shadow_mode: boolean
  /** 客服文件夹接管总开关（老产品 `aiSupportFolderEnabled`，默认开；`archive_folder: null` 即关）。 */
  folder_enabled: boolean
  /** 挪信（老产品 `aiSupportMoveEmails`，默认开）。 */
  move: boolean
  /** 标已读（老产品 `aiSupportMarkRead`，默认开；即 `archive_mark_read`）。 */
  mark_read: boolean
}

export const SUPPORT_MAILBOX_DEFAULTS: Readonly<SupportMailboxSwitches> = Object.freeze({
  shadow_mode: false,
  folder_enabled: true,
  move: true,
  mark_read: true,
})

/** 只给了一部分就按默认补齐（`undefined` 一律当没给）。 */
export function supportMailboxSwitches(
  partial?: Partial<Record<keyof SupportMailboxSwitches, boolean | undefined>>,
): SupportMailboxSwitches {
  const d = SUPPORT_MAILBOX_DEFAULTS
  return {
    shadow_mode: partial?.shadow_mode ?? d.shadow_mode,
    folder_enabled: partial?.folder_enabled ?? d.folder_enabled,
    move: partial?.move ?? d.move,
    mark_read: partial?.mark_read ?? d.mark_read,
  }
}

/** 动作种类（老产品 `actionType` 的对应：`shadow_mode_observe` / `mark_read` / `move_to_ai_support_folder`）。 */
export type MailboxActionKind = 'observe' | 'mark_read' | 'move'

export type MailboxActionStatus = 'completed' | 'skipped' | 'failed'

/**
 * 原因码（**零正文**：界面按码翻成人话，日志里只有码）。
 *
 * - `shadow_mode` / `folder_disabled` / `move_disabled`：开关让它跳过；
 * - `handoff_refused`：判成客服但客服那一侧没接（岗位没开 / 线程建不了），信不动；
 * - `owned_elsewhere`：这只邮箱的挪信归消息同步管，渠道那一路让开（见 docs/63 §D）；
 * - `unsupported`：这个收信端做不了这个动作；
 * - `server_refused`：服务器回了「不行」；`error`：抛了异常。
 */
export type MailboxActionReason =
  | 'shadow_mode'
  | 'folder_disabled'
  | 'move_disabled'
  | 'handoff_refused'
  | 'owned_elsewhere'
  | 'unsupported'
  | 'server_refused'
  | 'error'

/** 一条邮箱动作记录（老产品 `supportMailboxActionLog` 那一行的最小对应）。 */
export interface MailboxActionRecord {
  account: string
  uid: number
  from_folder: string
  to_folder?: string
  action: MailboxActionKind
  status: MailboxActionStatus
  reason?: MailboxActionReason
  /** 失败时的一句技术原因：已截断、邮箱地址已遮掉。 */
  detail?: string
}

/** 收信端能做的两个动作（替身与真 IMAP 各自实现；不实现 = 这一步记「做不了」）。 */
export interface SupportMailboxOps {
  /** 在原文件夹里标已读。回 `false` = 服务器没答应。 */
  markRead?(): Promise<boolean>
  /**
   * 挪进 `to`。`mark_read_too` 为真 = 收信端没有单独的标已读，顺手在这一步标
   * （WP55 的 `MailSource.archive` 就是这种合在一起的动作）。
   */
  move?(to: string, mark_read_too: boolean): Promise<boolean>
}

/** 失败原因只留一句技术话：截断，邮箱地址遮掉（日志不打完整地址，63 §10）。 */
export function safeActionDetail(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return text.replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, '***').slice(0, 160)
}

const sameFolder = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * 一封**判成客服**的信：按开关标已读、挪信，每一步记一笔（见文件头的四条）。
 * 永不抛：邮箱动作是锦上添花，不该拖垮收信（WP55 的纪律）。
 */
export async function applySupportMailboxActions(input: {
  switches: SupportMailboxSwitches
  account: string
  uid: number
  from_folder: string
  /** 客服文件夹在这只邮箱上的真名；`undefined` = 没有可挪的目标。 */
  to_folder: string | undefined
  ops: SupportMailboxOps
  record(r: MailboxActionRecord): void | Promise<void>
}): Promise<{ marked_read: boolean; moved: boolean }> {
  const { switches, ops } = input
  const base = { account: input.account, uid: input.uid, from_folder: input.from_folder }
  const to = input.to_folder
  const note = async (r: Omit<MailboxActionRecord, keyof typeof base>): Promise<void> => {
    try {
      await input.record({ ...base, ...r })
    } catch {
      // 记账失败不回头影响邮箱动作（老产品的 recordMailboxActionBestEffort）
    }
  }
  // ① 影子模式：只看不动（不标已读、不挪）
  if (switches.shadow_mode) {
    await note({ action: 'observe', status: 'skipped', reason: 'shadow_mode' })
    return { marked_read: false, moved: false }
  }
  // ② 客服文件夹接管关了
  if (!switches.folder_enabled) {
    await note({ action: 'observe', status: 'skipped', reason: 'folder_disabled' })
    return { marked_read: false, moved: false }
  }
  const willMove = switches.move && to !== undefined && !sameFolder(input.from_folder, to)
  let marked = false
  let folded = false
  // ③ 标已读（先于挪信，在原文件夹里标；失败不挡挪信）
  if (switches.mark_read) {
    if (ops.markRead !== undefined) {
      try {
        marked = await ops.markRead()
        await note(
          marked
            ? { action: 'mark_read', status: 'completed' }
            : { action: 'mark_read', status: 'failed', reason: 'server_refused' },
        )
      } catch (e) {
        await note({
          action: 'mark_read',
          status: 'failed',
          reason: 'error',
          detail: safeActionDetail(e),
        })
      }
    } else if (willMove && ops.move !== undefined) {
      folded = true
    } else {
      await note({ action: 'mark_read', status: 'skipped', reason: 'unsupported' })
    }
  }
  // ④ 挪信
  if (!switches.move) {
    await note({ action: 'move', status: 'skipped', reason: 'move_disabled' })
    return { marked_read: marked, moved: false }
  }
  if (!willMove || to === undefined) return { marked_read: marked, moved: false }
  if (ops.move === undefined) {
    await note({ action: 'move', status: 'skipped', reason: 'unsupported', to_folder: to })
    return { marked_read: marked, moved: false }
  }
  let moved = false
  let failure: Pick<MailboxActionRecord, 'reason' | 'detail'> = { reason: 'server_refused' }
  try {
    moved = await ops.move(to, folded)
  } catch (e) {
    failure = { reason: 'error', detail: safeActionDetail(e) }
  }
  if (folded) {
    marked = moved
    await note(
      moved
        ? { action: 'mark_read', status: 'completed' }
        : { action: 'mark_read', status: 'failed', ...failure },
    )
  }
  await note(
    moved
      ? { action: 'move', status: 'completed', to_folder: to }
      : { action: 'move', status: 'failed', to_folder: to, ...failure },
  )
  return { marked_read: marked, moved }
}
