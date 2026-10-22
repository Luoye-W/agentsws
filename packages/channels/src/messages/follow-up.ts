/**
 * WP442（docs/108 §5.3 / M4）：**回信跟进**的纯函数——我们发出去、对方是真人、N 个工作日没回 → 提醒。
 *
 * 这里只算，不存、不出卡、不发信（那些在服务进程 `message-follow-up.ts`）：
 *
 * | 函数 | 干什么 |
 * |---|---|
 * | {@link addBusinessDays} / {@link businessDaysBetween} | 工作日（品牌时区，周六日不算） |
 * | {@link promisedReplyAt} | 对方说「下周一给你答复」→ 那一天（分拣时抽，`chrono-node` + 薄薄一层中文补充） |
 * | {@link followUpCandidate} | 这条会话要不要盯：最后一封是我们发的、收件人是真人、在回看窗口里 |
 * | {@link followUpDue} | 哪天提醒：默认 N 个工作日（催过一次翻倍）/ 对方说过的那天再过 1 个工作日 / 再等等 |
 * | {@link nudgeTemplate} | 没接模型时的催促草稿（按对方语言，短） |
 *
 * 时区只用「分钟偏移」（品牌 `tz_offset_minutes`），与工作数据那一份同口径；夏令时不追。
 */
import type { MessageAddress, MessageFollowUpBasis, MessageRecord } from '@agentsws/contracts'
import { NOTICE_KINDS } from '@agentsws/contracts'
import * as chrono from 'chrono-node'
import { isInbound } from './query.js'
import { isAutomatedMail } from './triage.js'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

/* ── 工作日 ───────────────────────────────────────────────────────────── */

/** 品牌时区里的「墙上时间」（用 UTC 字段装着，只拿来读年月日、星期、时分）。 */
function wall(iso: string, tz: number): Date {
  return new Date(Date.parse(iso) + tz * MINUTE_MS)
}

/** 墙上时间 → 真时刻（ISO）。 */
function fromWall(d: Date, tz: number): string {
  return new Date(d.getTime() - tz * MINUTE_MS).toISOString()
}

const isWeekend = (d: Date): boolean => d.getUTCDay() === 0 || d.getUTCDay() === 6

/**
 * 往后数 `n` 个工作日（周六日不算），**保留当地的钟点**：周五 15:00 发的，3 个工作日是下周三 15:00；
 * 周六发的从周一算起（周一、二、三）。`n <= 0` 原样回。
 */
export function addBusinessDays(fromIso: string, n: number, tz: number): string {
  const d = wall(fromIso, tz)
  let left = Math.max(0, Math.floor(n))
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    if (!isWeekend(d)) left -= 1
  }
  return fromWall(d, tz)
}

/** 从 `fromIso` 到 `toIso` 已经过去几个**整**工作日（「X 还没回（3 个工作日）」那个数）。 */
export function businessDaysBetween(fromIso: string, toIso: string, tz: number): number {
  const end = Date.parse(toIso)
  if (!(end > Date.parse(fromIso))) return 0
  let n = 0
  // 上限防呆：一年的工作日也就 260 来个
  while (n < 400 && Date.parse(addBusinessDays(fromIso, n + 1, tz)) <= end) n += 1
  return n
}

/**
 * 某一天（当地）之后的下一个工作日早上 `hour` 点——「对方说周一答复」= 周二早上还没回才提醒。
 */
export function nextBusinessMorning(dayIso: string, tz: number, hour = 9): string {
  const d = wall(dayIso, tz)
  d.setUTCHours(hour, 0, 0, 0)
  do {
    d.setUTCDate(d.getUTCDate() + 1)
  } while (isWeekend(d))
  return fromWall(d, tz)
}

/** 当地那一天的 00:00（ISO）。 */
export function localDayStart(iso: string, tz: number): string {
  const d = wall(iso, tz)
  d.setUTCHours(0, 0, 0, 0)
  return fromWall(d, tz)
}

/* ── 对方说过什么时候答复 ────────────────────────────────────────────── */

/** 一句话里有没有「答复 / 确认 / 回你」这类许诺的词——没有这类词的日期（「促销周五结束」）不算。 */
const CUE_EN =
  /\b(get back|getting back|reply|respond|confirm|let you know|update you|keep you posted|revert|follow up|answer|decide|decision|circle back|come back to you|be in touch|touch base|feedback|send (?:you|it|over|the))\b/i
const CUE_ZH =
  /(答复|答覆|回复|回覆|回你|回您|确认|確認|告诉你|告诉您|告訴你|通知你|通知您|给你消息|给您消息|给你答|给您答|反馈|回话|定下来|给你结果|给您结果|发给你|发给您|联系你|联系您|回信)/

/** 引用的上一封、签名分隔线之后的不算（只看对方这一封新写的）。 */
export function ownText(text: string): string {
  const head =
    text.split(
      /\n(?:On .{0,200}wrote:|-{2,}\s*Original Message\s*-{2,}|在 .{0,80}写道：|From: .{0,200}\nSent: )/i,
    )[0] ?? ''
  return head
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
}

/** 当地某天（墙上时间）往后挪 `days` 天、或挪到本周 / 下周的星期 `dow`。 */
function shiftWall(base: Date, opts: { days?: number; weekday?: number; weeks?: number }): Date {
  const d = new Date(base.getTime())
  d.setUTCHours(0, 0, 0, 0)
  if (opts.days !== undefined) d.setUTCDate(d.getUTCDate() + opts.days)
  if (opts.weekday !== undefined) {
    // 本周一为起点（周日算上一周的最后一天）
    const monOffset = (d.getUTCDay() + 6) % 7
    d.setUTCDate(d.getUTCDate() - monOffset + 7 * (opts.weeks ?? 0) + ((opts.weekday + 6) % 7))
  }
  return d
}

/** `chrono-node` 认不了、或者认得太早的那几种说法（中英各补一点）。 */
const EXTRA: readonly {
  re: RegExp
  at(base: Date): Date
}[] = [
  // 月底 / 月末 / end of (the) month → 这个月最后一天
  {
    re: /(月底|月末|end of (?:the )?month)/i,
    at: (b) => new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0)),
  },
  // 光说「下周」没说周几 → 下周五（宁晚别早：说下周答复的人，周一没回不算失约）
  {
    re: /((?:下周|下星期|下个星期|下礼拜|下個星期)(?![一二三四五六日天1-7])|\bnext week\b)/i,
    at: (b) => shiftWall(b, { weekday: 5, weeks: 1 }),
  },
  // 光说「这周 / 本周」→ 本周五
  {
    re: /((?:这周|本周|這週|这个星期|这礼拜)(?![一二三四五六日天1-7])|\bthis week\b)/i,
    at: (b) => shiftWall(b, { weekday: 5 }),
  },
  // 过两天 / 过几天 / 改天 / in a few days
  { re: /(过两天|過兩天)/, at: (b) => shiftWall(b, { days: 2 }) },
  {
    re: /(过几天|過幾天|改天|\bin a few days\b|\bin a couple of days\b)/i,
    at: (b) => shiftWall(b, { days: 3 }),
  },
]

/** 太远的不算（半年后的「年底确认」不是这轮往来的事）。 */
const MAX_PROMISE_DAYS = 90

/**
 * 对方这封信里说过「什么时候答复」——回那一天当地 00:00（ISO）；没说、说的是过去、太远的回 `undefined`。
 *
 * 只认**同一句话里带许诺词**的日期（`CUE_EN` / `CUE_ZH`），只看对方新写的部分（引用的旧信不算）。
 * 一句话里有几个日期取最晚的那个（「周一先看，周三前确认」→ 周三）。
 *
 * @param refIso 这封信的时间（「下周一」按它算）
 * @param tz 品牌时区（分钟偏移）
 */
export function promisedReplyAt(text: string, refIso: string, tz: number): string | undefined {
  const own = ownText(text).slice(0, 4000)
  if (own.trim() === '') return undefined
  const ref = { instant: new Date(refIso), timezone: tz }
  const baseWall = wall(refIso, tz)
  baseWall.setUTCHours(0, 0, 0, 0)
  const sentences = own
    .split(/(?<=[.!?。！？;；])\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  let best: Date | undefined
  const consider = (d: Date): void => {
    const day = new Date(d.getTime())
    day.setUTCHours(0, 0, 0, 0)
    const ahead = (day.getTime() - baseWall.getTime()) / DAY_MS
    if (ahead < 0 || ahead > MAX_PROMISE_DAYS) return
    if (best === undefined || day.getTime() > best.getTime()) best = day
  }
  for (const s of sentences) {
    if (!CUE_EN.test(s) && !CUE_ZH.test(s)) continue
    const extraHit = new Set<string>()
    for (const x of EXTRA) {
      const m = s.match(x.re)
      if (m === null) continue
      extraHit.add((m[1] ?? m[0]).toLowerCase())
      consider(x.at(baseWall))
    }
    const parsed = [
      ...chrono.en.casual.parse(s, ref, { forwardDate: true }),
      ...chrono.zh.hans.parse(s, ref, { forwardDate: true }),
    ]
    for (const r of parsed) {
      const t = r.text.trim().toLowerCase()
      // 补充那一层已经按自己的口径算过的（「next week」「this week」）不再按 chrono 的算一遍
      if ([...extraHit].some((h) => t.includes(h) || h.includes(t))) continue
      consider(wall(r.start.date().toISOString(), tz))
    }
  }
  return best === undefined ? undefined : fromWall(best, tz)
}

/* ── 要不要盯、哪天提醒 ──────────────────────────────────────────────── */

/** 不盯的理由（测试与事件里看得懂）。 */
export type FollowUpSkip =
  /** 最后一封是对方的（或者根本没有我们发的）。 */
  | 'replied'
  /** 最后那封我们发的太早了（回看窗口外）。 */
  | 'stale'
  /** 没有收件人（只发给了自己）。 */
  | 'no_recipient'
  /** 收件人是机器（noreply、群发、通知类）。 */
  | 'not_human'
  /** 在别的跟进里（客服回复时限、红人 / B2B 序列）。 */
  | 'other_follow_up'

export interface FollowUpCandidate {
  ok: true
  /** 我们最后发出的那一封（从它开始等）。 */
  anchor: MessageRecord
  account: string
  waiting_on: MessageAddress
  to: MessageAddress[]
  cc: MessageAddress[]
  /** 对方最近一封来信（有的话）。 */
  last_inbound?: MessageRecord
  /** 对方最近一封里说过的「什么时候答复」。 */
  promised_reply_at?: string
}

const ROUTED = new Set(['support', 'kol', 'b2b'])

/**
 * 这条会话要不要盯（docs/108 §5.3「盯哪些」）：
 *
 * 1. 最后一封（草稿不算）是**我们发的**；
 * 2. 收件人是**真人**：地址不是 noreply 之类，对方在这条会话里来过的信不是群发 / 通知（分拣现有的判断）；
 * 3. **不在别的跟进里**：会话里有信归了客服 / 红人 / B2B（路由或岗位文件夹），或宿主说它是那几条线的
 *    （`otherFollowUp`：客服线程、我们的开发信序列）；
 * 4. 最后那封在回看窗口里（{@link FOLLOW_UP_LOOKBACK_DAYS} 天）。
 */
export function followUpCandidate(
  messages: readonly MessageRecord[],
  opts: {
    now: string
    lookback_days: number
    ownAddresses?: readonly string[]
    otherFollowUp?: boolean
  },
): FollowUpCandidate | { ok: false; reason: FollowUpSkip } {
  const list = messages
    .filter((m) => m.folder_kind !== 'drafts')
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
  const last = list[list.length - 1]
  if (last === undefined || isInbound(last)) return { ok: false, reason: 'replied' }
  if (
    opts.otherFollowUp === true ||
    list.some((m) => ROUTED.has(m.route) || ROUTED.has(m.folder_kind))
  )
    return { ok: false, reason: 'other_follow_up' }
  if (Date.parse(opts.now) - Date.parse(last.date) > opts.lookback_days * DAY_MS)
    return { ok: false, reason: 'stale' }
  const own = new Set(
    [last.account, ...(opts.ownAddresses ?? [])].map((a) => a.trim().toLowerCase()),
  )
  const to = last.to.filter((a) => !own.has(a.email.trim().toLowerCase()))
  const cc = last.cc.filter((a) => !own.has(a.email.trim().toLowerCase()))
  const first = to[0]
  if (first === undefined) return { ok: false, reason: 'no_recipient' }
  const inbound = list.filter(isInbound)
  const fromThem = inbound.filter(
    (m) => m.from.email.trim().toLowerCase() === first.email.trim().toLowerCase(),
  )
  if (!isHumanAddress(first.email) || fromThem.some(isMachineMail))
    return { ok: false, reason: 'not_human' }
  const lastInbound = inbound[inbound.length - 1]
  const promised = lastInbound?.triage?.promised_reply_at
  return {
    ok: true,
    anchor: last,
    account: last.account,
    waiting_on: first,
    to,
    cc,
    ...(lastInbound === undefined ? {} : { last_inbound: lastInbound }),
    ...(promised === undefined ? {} : { promised_reply_at: promised }),
  }
}

/** 地址本身像机器（noreply / mailer-daemon …）——与分拣第 ③ 层同一个判据。 */
export function isHumanAddress(email: string): boolean {
  return (
    isAutomatedMail({
      from_email: email,
      subject: '',
      text: '',
      thread_id: '',
      references: [],
      headers: {},
      has_attachments: false,
    }) === undefined
  )
}

/** 这封来信是机器发的（群发头 / noreply / 分拣判成通知类）。 */
function isMachineMail(m: MessageRecord): boolean {
  if (
    isAutomatedMail({
      from_email: m.from.email,
      subject: m.subject,
      text: '',
      thread_id: m.thread_id,
      references: m.references,
      headers: m.headers ?? {},
      has_attachments: false,
    }) !== undefined
  )
    return true
  const kind = m.triage?.kind
  return kind !== undefined && NOTICE_KINDS.includes(kind)
}

export interface FollowUpDueInput {
  /** 我们最后发出那一封的时间。 */
  anchor_at: string
  /** 经卡「发出」的上一封催促的时间（邮箱「已发送」还没同步回来时用它）。 */
  nudged_at?: string
  nudges: number
  business_days: number
  /** 对方说过的那一天（当地 00:00）。只在还没催过时算数。 */
  promised_reply_at?: string
  /** 「再等等」到哪天。 */
  wait_until?: string
  tz: number
}

/**
 * 哪天提醒（docs/108 §5.3「什么时候提醒」）：
 *
 * - 卡上点过「再等等」：到它说的那天；
 * - 对方说过哪天答复（还没催过）：那天再过 1 个工作日（早上 9 点）；不再按 N 天算；
 * - 默认：最后一封往后 N 个工作日；催过一次之后翻倍（第二次是 2N）。
 */
export function followUpDue(input: FollowUpDueInput): {
  due_at: string
  basis: MessageFollowUpBasis
} {
  const anchor =
    input.nudged_at !== undefined && Date.parse(input.nudged_at) > Date.parse(input.anchor_at)
      ? input.nudged_at
      : input.anchor_at
  if (input.wait_until !== undefined && Date.parse(input.wait_until) > Date.parse(anchor))
    return { due_at: input.wait_until, basis: 'waited' }
  if (
    input.nudges === 0 &&
    input.promised_reply_at !== undefined &&
    Date.parse(input.promised_reply_at) >= Date.parse(localDayStart(anchor, input.tz))
  )
    return { due_at: nextBusinessMorning(input.promised_reply_at, input.tz), basis: 'promised' }
  const n = input.business_days * 2 ** Math.max(0, input.nudges)
  return { due_at: addBusinessDays(anchor, n, input.tz), basis: 'default' }
}

/* ── 催促草稿（没接模型时） ─────────────────────────────────────────── */

/** 回信主题：已经是「Re: …」的不再加。 */
export function nudgeSubject(subject: string): string {
  const s = subject.trim()
  return /^(re|aw|sv|antw|回复|答复|回覆)\s*[:：]/i.test(s) ? s : `Re: ${s}`
}

/** 称呼里只取名（「Clara Jones」→「Clara」；没名字就不称呼）。 */
function givenName(a: MessageAddress | undefined, lang: string): string | undefined {
  const name = a?.name?.trim()
  if (name === undefined || name === '' || name.includes('@')) return undefined
  if (lang === 'zh' || lang === 'ja') return name
  return name.split(/\s+/)[0]
}

const TEMPLATES: Readonly<
  Record<string, (v: { name?: string; subject: string; again: boolean }) => string>
> = {
  zh: ({ name, subject, again }) =>
    [
      name === undefined ? '你好，' : `${name}你好，`,
      '',
      again
        ? `再跟进一下「${subject}」这件事，不知道你那边有结果了吗？方便时回我一句就好。`
        : `想跟进一下上次关于「${subject}」的邮件，不知道你那边有消息了吗？方便时回我一句就好。`,
      '',
      '谢谢！',
    ].join('\n'),
  en: ({ name, subject, again }) =>
    [
      name === undefined ? 'Hi,' : `Hi ${name},`,
      '',
      again
        ? `Following up once more on "${subject}" — is there any update on your side? A quick reply whenever you have a moment would be great.`
        : `Just following up on my last email about "${subject}". Any update on your side? A quick reply whenever you have a moment would be great.`,
      '',
      'Thanks!',
    ].join('\n'),
  de: ({ name, subject, again }) =>
    [
      name === undefined ? 'Hallo,' : `Hallo ${name},`,
      '',
      again
        ? `ich melde mich noch einmal wegen „${subject}“ – gibt es schon etwas Neues? Eine kurze Rückmeldung wäre super.`
        : `ich wollte kurz wegen meiner letzten E-Mail zu „${subject}“ nachfragen. Gibt es schon etwas Neues? Eine kurze Rückmeldung wäre super.`,
      '',
      'Danke!',
    ].join('\n'),
  fr: ({ name, subject, again }) =>
    [
      name === undefined ? 'Bonjour,' : `Bonjour ${name},`,
      '',
      again
        ? `Je reviens une nouvelle fois vers vous au sujet de « ${subject} ». Avez-vous du nouveau ? Un petit retour quand vous aurez un moment serait parfait.`
        : `Je me permets de revenir vers vous au sujet de mon dernier e-mail « ${subject} ». Avez-vous du nouveau ? Un petit retour quand vous aurez un moment serait parfait.`,
      '',
      'Merci !',
    ].join('\n'),
  es: ({ name, subject, again }) =>
    [
      name === undefined ? 'Hola:' : `Hola ${name}:`,
      '',
      again
        ? `Vuelvo a escribir sobre «${subject}». ¿Hay alguna novedad? Una respuesta breve cuando puedas sería genial.`
        : `Solo quería hacer seguimiento de mi último correo sobre «${subject}». ¿Hay alguna novedad? Una respuesta breve cuando puedas sería genial.`,
      '',
      '¡Gracias!',
    ].join('\n'),
  ja: ({ name, subject, again }) =>
    [
      name === undefined ? 'お世話になっております。' : `${name}様`,
      '',
      again
        ? `「${subject}」の件で再度ご連絡いたしました。その後いかがでしょうか。お手すきの際にご返信いただけますと幸いです。`
        : `先日お送りした「${subject}」の件について、その後いかがでしょうか。お手すきの際にご返信いただけますと幸いです。`,
      '',
      'よろしくお願いいたします。',
    ].join('\n'),
}

/** 催促草稿的语言里有模板的那几种（别的退回英文）。 */
export const NUDGE_TEMPLATE_LANGS: readonly string[] = Object.keys(TEMPLATES)

/**
 * 没接模型（演示 / stub）时的催促草稿：按对方语言、短、不编任何承诺。第二次提醒换一句「再跟进一下」。
 */
export function nudgeTemplate(input: {
  lang: string
  waiting_on?: MessageAddress
  subject: string
  reminder: number
}): string {
  const lang = TEMPLATES[input.lang] === undefined ? 'en' : input.lang
  const subject = input.subject.replace(/^(re|aw|sv|回复|答复)\s*[:：]\s*/i, '').trim()
  const name = givenName(input.waiting_on, lang)
  const fill = TEMPLATES[lang] as (v: { name?: string; subject: string; again: boolean }) => string
  return fill({
    ...(name === undefined ? {} : { name }),
    subject: subject === '' ? '—' : subject,
    again: input.reminder > 1,
  })
}
