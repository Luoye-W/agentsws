/**
 * WP173（docs/84 §2）：**B2B 开发信**——筛谁能发、今天发几封、三封模板、系统页脚。
 *
 * 新写的（BtoBAgents 里没有开发信）。序列节奏、日配额、预热与"下一封是哪封"是
 * `@agentsws/core` 的 `sequence.ts`（红人共用那一份），这里只放 B2B 自己的：
 *
 * 1. **筛**（{@link screenProspects}）：抑制名单上的、没写来源的、没邮箱的、已经在序列里的剔掉；
 *    **德国 / 奥地利没有往来的潜在客户默认不发**，卡上一句原因；加拿大没有「公开来源」的不发。
 * 2. **分**（{@link splitByQuota}）：今天配额以内的进这一张卡，超了的排到明天。
 * 3. **写**（{@link draftB2bOutreach}）：三封模板（英文：收信人是海外买家）。里面**没有**价格、
 *    交期、认证、MOQ、独家、账期的位置——模型写的版本同样要过 {@link reviewB2bOutreach}。
 * 4. **页脚由系统加**（{@link outreachFooter}）：退订方式 + 公司实体地址 + 联系方式从哪来的。
 *    模型不写、人也删不掉；公司地址没有就不能发。
 */
import type { B2bEnrollment, B2bSequenceStep, B2bStage } from '@agentsws/contracts'
import { B2B_DE_AT_REASON, B2B_EXCLUDED_COUNTRIES } from '@agentsws/contracts'

/** 一个想开发的联系人（服务进程从库里拼好递进来；**没有明文邮箱**）。 */
export interface B2bProspect {
  contact_id: string
  account_id: string
  name: string
  company: string
  country?: string
  has_email: boolean
  /** 来源（网址 + 日期）。没有 = 不能发（GDPR 第 14 条）。 */
  source?: { url?: string; observed_at?: string }
  /** 加拿大：对方自己公开过这个邮箱（CASL 默认同意的前提）。 */
  public_source?: boolean
  /** 这家公司和我们有没有往来（回过信、有询盘、在谈、下过单）。 */
  existing_relationship: boolean
  suppressed: boolean
  /** 已经在一轮序列里（排着 / 待批 / 进行中）。 */
  in_sequence: boolean
}

export type B2bExcludeReason =
  | 'suppressed'
  | 'no_source'
  | 'no_email'
  | 'in_sequence'
  | 'de_at'
  | 'ca_no_public_source'

/** 卡上 / 面板上那一句（德奥那句就是 docs/84 §11.1 第 6 条要"告诉用户"的原因）。 */
export const EXCLUDE_REASON_ZH: Readonly<Record<B2bExcludeReason, string>> = {
  suppressed: '在抑制名单上（退订 / 退信 / 说过不感兴趣）',
  no_source: '没写从哪来的（来源网址 + 日期），先补来源',
  no_email: '没有邮箱',
  in_sequence: '已经在一轮开发信里了',
  de_at: `德国 / 奥地利默认不发：${B2B_DE_AT_REASON}。要发得在「主动开发」里勾选并确认风险`,
  ca_no_public_source: '加拿大：对方没有自己公开过这个邮箱，默认不发（CASL）',
}

/** 这家公司算不算"有往来"：回过信、在谈、寄过样、报过价、成交过、丢单过（`contacted` 只是我们找过他）。 */
export function hasRelationship(account: { stage?: B2bStage; last_contact_at?: string }): boolean {
  return (
    account.last_contact_at !== undefined ||
    (account.stage !== undefined && account.stage !== 'contacted')
  )
}

/**
 * 筛一批人。顺序固定（先剔确定不能发的，再剔"默认不发"的），每个被剔的写明为什么。
 * `de_at_confirmed` = 用户在设置里勾选并确认了风险。
 */
export function screenProspects(
  prospects: readonly B2bProspect[],
  opts: { de_at_confirmed: boolean },
): {
  eligible: B2bProspect[]
  excluded: { prospect: B2bProspect; reason: B2bExcludeReason }[]
} {
  const eligible: B2bProspect[] = []
  const excluded: { prospect: B2bProspect; reason: B2bExcludeReason }[] = []
  for (const p of prospects) {
    const country = p.country?.trim().toUpperCase()
    const reason: B2bExcludeReason | undefined = p.suppressed
      ? 'suppressed'
      : p.in_sequence
        ? 'in_sequence'
        : !p.has_email
          ? 'no_email'
          : p.source?.observed_at === undefined || p.source.observed_at === ''
            ? 'no_source'
            : country !== undefined &&
                B2B_EXCLUDED_COUNTRIES.includes(country) &&
                !p.existing_relationship &&
                !opts.de_at_confirmed
              ? 'de_at'
              : country === 'CA' && p.public_source !== true && !p.existing_relationship
                ? 'ca_no_public_source'
                : undefined
    if (reason === undefined) eligible.push(p)
    else excluded.push({ prospect: p, reason })
  }
  return { eligible, excluded }
}

/** 今天配额以内的进这一张卡，超了的排到明天（顺序不变：先来的先发）。 */
export function splitByQuota<T>(
  items: readonly T[],
  remaining: number,
): { today: T[]; later: T[] } {
  const n = Math.max(0, Math.floor(remaining))
  return { today: items.slice(0, n), later: items.slice(n) }
}

/**
 * 某个时刻在这个时区里是哪一天（`YYYY-MM-DD`）。配额按**自然日**算（"排到明天"就是明天），
 * 不按滚动 24 小时——否则早上 9 点那一拍永远还差昨天 10 点那几封没"过期"。
 */
export function localDay(iso: string, timeZone: string): string {
  // 定时任务那边的时区写成 `+08:00` 这种偏移；IANA 名（`Asia/Shanghai`）也认
  const off = /^([+-])(\d{2}):(\d{2})$/.exec(timeZone)
  if (off !== null) {
    const minutes = (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3]))
    return new Date(Date.parse(iso) + minutes * 60_000).toISOString().slice(0, 10)
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** 序列漏斗的格子（顺序固定：柱子的位置不随数据变，同 `kol-core` 的 `FUNNEL_ORDER`）。 */
export const SEQUENCE_FUNNEL: readonly { stage: string; label: string }[] = [
  { stage: 'queued', label: '排着' },
  { stage: 'awaiting_approval', label: '待批' },
  { stage: 'first', label: '首封已发' },
  { stage: 'follow_up', label: '跟进已发' },
  { stage: 'finished', label: '收尾已发' },
  { stage: 'handed_to_sales', label: '转给业务' },
  { stage: 'replied', label: '回了' },
  { stage: 'stopped', label: '停了' },
]

/** 一批人 → 漏斗（空格子也出）。 */
export function sequenceFunnel(
  enrollments: readonly Pick<B2bEnrollment, 'status' | 'steps'>[],
): { stage: string; label: string; count: number }[] {
  const bucket = (e: Pick<B2bEnrollment, 'status' | 'steps'>): string =>
    e.status === 'active' ? (e.steps.at(-1)?.step ?? 'first') : e.status
  return SEQUENCE_FUNNEL.map((f) => ({
    ...f,
    count: enrollments.filter((e) => bucket(e) === f.stage).length,
  }))
}

export type { B2bSequenceStep }
