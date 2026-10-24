/**
 * WP510（决策 1515，WP459-T2）：**同事 / 公司模式的收件箱**——谁在看、处理留名、邮箱负责人、催促卡按负责人分。
 *
 * 只在 ② 同事互联、③ 公司集体里出现；① 个人一个字都不多（docs/95）。
 *
 * - **谁在看**：打开着某一件（卡 / 信）的同事，别人那一行上出一个小头像「X 在看」，离开就消失（心跳，见
 *   {@link INBOX_PRESENCE_TTL_MS}）。只在内存里，不落盘、不写事件。
 * - **邮箱负责人**：每只接入的邮箱可以指定一人或多人。没指定的邮箱照旧谁都看得到（和以前一样）。
 * - **负责人不在**：多少天没上线算「不在」、不在时交给谁，都是**可配的**（不替用户定规矩）；缺省值见
 *   {@link TEAM_INBOX_DEFAULTS}。没有上线记录的人不算不在（不拿没有的数据下结论）。
 */
import type { Iso8601, PersonId } from './common.js'

/** 负责人都不在时交给谁：发起人 / 管理员，或同岗位的同事。 */
export type TeamInboxFallback = 'admins' | 'position'

export const TEAM_INBOX_FALLBACKS: readonly TeamInboxFallback[] = ['admins', 'position']

export interface TeamInboxSettings {
  /** 负责人多少天没上线算「不在」（1–30）。 */
  away_days: number
  fallback: TeamInboxFallback
  updated_at?: Iso8601
  updated_by?: PersonId
}

/** 缺省：3 天没上线算不在，交给发起人 / 管理员（决策 1822 待定，见 WP510 报告）。 */
export const TEAM_INBOX_DEFAULTS: Readonly<Pick<TeamInboxSettings, 'away_days' | 'fallback'>> = {
  away_days: 3,
  fallback: 'admins',
}

export const TEAM_INBOX_AWAY_DAYS_MIN = 1
export const TEAM_INBOX_AWAY_DAYS_MAX = 30

/** 「谁在看」心跳多久没来就算离开了（工作台 5 秒一跳）。 */
export const INBOX_PRESENCE_TTL_MS = 20_000
/** 工作台多久跳一次。 */
export const INBOX_PRESENCE_BEAT_MS = 5_000

/** 这个品牌里的一位同事。 */
export interface TeamMember {
  person_id: PersonId
  name: string
  /** ② 的发起人；③ 的老板 / 管理员。 */
  admin: boolean
  /** 最近一次在工坊里（任何一次带岗位的请求）。没有 = 还没记到。 */
  last_seen_at?: Iso8601
}

export interface TeamMemberView extends TeamMember {
  /** 按 `away_days` 算出来的「不在」。 */
  away: boolean
}

/** 一只邮箱的负责人。 */
export interface MailboxOwnersRow {
  account: string
  owners: PersonId[]
}

/** `GET /v1/inbox/team`：收件箱分工那一格。 */
export interface TeamInboxView {
  mode: 'solo' | 'peers' | 'company'
  /** 看的人自己（界面上「你」与「王五」分开写）。 */
  me: PersonId
  /** 能不能改：② 谁都能改；③ 老板 / 管理员。 */
  can_edit: boolean
  settings: TeamInboxSettings
  /** 现在连着的每只邮箱（没指定负责人的 `owners` 是空的）。 */
  mailboxes: MailboxOwnersRow[]
  members: TeamMemberView[]
}

/** `PUT /v1/inbox/team`：改一项（给 `mailbox` 就只改那只邮箱的负责人）。 */
export interface TeamInboxPatch {
  away_days?: number | undefined
  fallback?: TeamInboxFallback | undefined
  mailbox?: { account: string; owners: PersonId[] } | undefined
}

/** 「X 在看」里的那个人。 */
export interface InboxViewer {
  person_id: PersonId
  name: string
}

/** `POST /v1/inbox/presence`：我现在开着哪一件（`null` = 没开着）。 */
export interface InboxPresenceInput {
  /** 收件箱那一行的 id（`card:<id>` / `mail:<会话 id>`）。 */
  item: string | null
}

/** 别人开着哪几件（不含自己）。① 个人里永远是空的。 */
export interface InboxPresenceView {
  viewers: Record<string, InboxViewer[]>
}

const DAY = 86_400_000

/** 这个人现在算不算「不在」：有上线记录、且离现在超过 `away_days` 天。 */
export function isAway(
  member: Pick<TeamMember, 'last_seen_at'>,
  now: Iso8601,
  away_days: number,
): boolean {
  if (member.last_seen_at === undefined) return false
  const seen = Date.parse(member.last_seen_at)
  if (!Number.isFinite(seen)) return false
  return Date.parse(now) - seen > away_days * DAY
}

export function clampAwayDays(n: number): number {
  if (!Number.isFinite(n)) return TEAM_INBOX_DEFAULTS.away_days
  return Math.min(TEAM_INBOX_AWAY_DAYS_MAX, Math.max(TEAM_INBOX_AWAY_DAYS_MIN, Math.round(n)))
}

/** 一只邮箱现在该给谁。 */
export interface OwnerRoute {
  /** 现在给谁（按设的顺序）。空 = 这只邮箱没指定负责人，按老规矩走。 */
  to: PersonId[]
  /** 设的负责人（还在这个品牌里的）。 */
  owners: PersonId[]
  /** 负责人都不在、交给了兜底的人。 */
  fallback: boolean
  /** 不在的那几位负责人。 */
  away: PersonId[]
}

/**
 * 邮箱负责人 → 现在给谁：
 * - 没指定（或指定的人都不在这个品牌里了）→ `to` 空，调用方按老规矩走；
 * - 有人在 → 给在的那几位；
 * - 都不在 → 给兜底的人（`fallbackPeople` 里没有不在的那几位）；兜底一个都没有 → 还是给负责人（不丢）。
 */
export function routeToOwners(input: {
  owners: readonly PersonId[]
  members: readonly TeamMember[]
  now: Iso8601
  away_days: number
  fallbackPeople: readonly PersonId[]
}): OwnerRoute {
  const byId = new Map(input.members.map((m) => [m.person_id, m]))
  const owners = [...new Set(input.owners)].filter((p) => byId.has(p))
  if (owners.length === 0) return { to: [], owners: [], fallback: false, away: [] }
  const awayOf = (p: PersonId): boolean => {
    const m = byId.get(p)
    return m === undefined ? true : isAway(m, input.now, input.away_days)
  }
  const present = owners.filter((p) => !awayOf(p))
  const away = owners.filter((p) => awayOf(p))
  if (present.length > 0) return { to: present, owners, fallback: false, away }
  const backup = [...new Set(input.fallbackPeople)].filter(
    (p) => byId.has(p) && !awayOf(p) && !owners.includes(p),
  )
  if (backup.length === 0) return { to: owners, owners, fallback: false, away }
  return { to: backup, owners, fallback: true, away }
}

/** 邮箱地址统一成小写去空白（负责人表按它存）。 */
export const mailboxKey = (address: string): string => address.trim().toLowerCase()
