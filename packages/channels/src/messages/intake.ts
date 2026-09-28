/**
 * WP167：**收信只走一个入口**（docs/63 §D「收信一个入口」）。
 *
 * 以前同一只邮箱上有两条收信路各干各的：渠道那一路（`EmailChannelAdapter`，WP55）
 * 给 INBOX **每一封**新信开事项、起 Run；消息同步（`MailboxSync`，WP113）落消息库、分拣。
 * 订阅、通知、红人来信都在工作台上变成一条事项、花一次模型钱。
 *
 * 现在只有消息同步在收：它先分拣，**只有判成客服的信**才交给客服那一路
 * （复用渠道的入站管线：Amazon 子渠道判定、线程归并、去重、判断层、起 Run）。
 * 这个文件放两边（服务进程与模拟世界）共用的那三样纯东西：
 *
 * 1. {@link intakeOf}：一封分拣过的信接下来去哪一路；
 * 2. {@link supportIntakeKey}：同一封信只进一次客服管线的那把钥匙；
 * 3. {@link SupportIntakeLedger}：钥匙记在哪（内存档在这里，SQLite 档在 `sqlite-queue.ts`）。
 */

import type { Iso8601, MessageFolderKind, MessageTriage } from '@agentsws/contracts'

/**
 * 一封信分拣之后去哪一路。
 *
 * - `support`：交给客服那一路（开事项、过判断层、起 Run）；
 * - `kol`：交给红人那一路（照现在的规矩：归并到合作线程）；
 * - `b2b`（WP172）：交给 B2B 那一路（落成询盘或往来记录；B2B 岗位开着才开事项、起 Run）；
 * - `pending`：分拣判不准（把握不够的客服 / 红人判定）——**不开事项**，放「消息」页的
 *   「待确认」一栏，人点一下才交出去；
 * - `none`：其余一切（订阅、通知、供应商、没开岗位的客服信）——只进「消息」页，
 *   不开事项、不起 Run、不花模型钱。
 */
export type MailIntake = 'support' | 'kol' | 'b2b' | 'pending' | 'none'

export function intakeOf(input: {
  triage: Pick<MessageTriage, 'route' | 'suggested_route' | 'by'>
  /** 这封信现在在哪种文件夹里。 */
  folder_kind: MessageFolderKind
}): MailIntake {
  const { triage, folder_kind } = input
  // 已发 / 草稿 / 垃圾箱里的东西要么是自己写的，要么已经被判过了（同步那一侧本来就不分拣它们）
  if (folder_kind === 'sent' || folder_kind === 'drafts' || folder_kind === 'trash') return 'none'
  if (triage.route === 'support') return 'support'
  if (triage.route === 'kol') return 'kol'
  if (triage.route === 'b2b') return 'b2b'
  const wanted = triage.suggested_route
  if (triage.by !== 'user' && (wanted === 'support' || wanted === 'kol' || wanted === 'b2b'))
    return 'pending'
  return 'none'
}

/**
 * 同一封信只进一次客服管线的钥匙。
 *
 * 有 `Message-ID` 就按它（**不带邮箱地址**：同一封信抄送到两只已连的邮箱，也只该开一条事项，
 * 与入站管线「同一封信从两个账号进来只该产生一条事件」同一条纪律）；没有就按
 * 「邮箱 × 文件夹 × UID」——信被挪走之后 UID 会换，但没有 Message-ID 的信本来就只能这样认。
 */
export function supportIntakeKey(input: {
  account: string
  message_id?: string | undefined
  folder: string
  uid?: number | undefined
}): string {
  const mid = input.message_id?.trim().toLowerCase()
  if (mid !== undefined && mid !== '') return `mid:${mid}`
  return `uid:${input.account.toLowerCase()}|${input.folder}|${String(input.uid ?? 0)}`
}

/** 进过客服管线的那几封信（钥匙见 {@link supportIntakeKey}）。**不过期**——去重表那个 24h 窗口不够。 */
export interface SupportIntakeLedger {
  has(key: string): boolean | Promise<boolean>
  add(key: string, at: Iso8601): void | Promise<void>
}

/** 内存档（测试与没有数据目录的装配）。 */
export class MemorySupportIntakeLedger implements SupportIntakeLedger {
  private readonly seen = new Map<string, Iso8601>()

  has(key: string): boolean {
    return this.seen.has(key)
  }

  add(key: string, at: Iso8601): void {
    if (!this.seen.has(key)) this.seen.set(key, at)
  }

  get size(): number {
    return this.seen.size
  }
}
