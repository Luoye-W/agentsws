/**
 * 媒体名单与 pitch 序列（60 §2 `media.ts`）。
 *
 * 这是 48 §5.2 / WP55 那套建联规则**换了一批收件人**：日配额、抑制名单、
 * 序列节奏三件事的规则一个字都没改，改的只是"发给谁"与"发几封"。
 *
 * 三条纪律：
 *
 * 1. **抑制名单是全仓那一份**（`@agentsws/core` 的 `suppression.ts`）。
 *    这里 `import` 它，不抄一份——名单的口径（大小写、加号别名）一旦在两处
 *    分头演化，就会出现"记者点了退订、公关这边照发"的裂缝。
 * 2. **媒体的序列比红人短**（{@link MEDIA_SEQUENCE_DAYS}）：两封，不是三封。
 *    记者一天收几百封 pitch，第三封在他眼里与垃圾邮件没有分别，而且
 *    公关这行"被某家媒体拉黑"是会跟着品牌走的。
 * 3. **明文不进这里**。名单上存的是 {@link MediaContact.email_ref}
 *    （加密库 key 名）；这个模块只在比对抑制名单时碰一次调用方递进来的
 *    那个地址，不落库、不返回。
 */

import type { Iso8601, MediaContact, MediaPitchStage } from '@agentsws/contracts'
import { suppressionKey, withoutSuppressed } from '@agentsws/core'

/** 序列里的第几封。 */
export type PitchStep = 'first' | 'follow_up'

/**
 * 每一封相对**首封**隔几天。
 *
 * 首封是 0；跟进那封 +4 天——比红人那条（+3）宽一天，因为记者的稿期是按周走的：
 * 周一发的 pitch，周五之前他多半根本没打开。第三封不存在（文件头第 2 条）。
 */
export const MEDIA_SEQUENCE_DAYS: Readonly<Record<PitchStep, number>> = {
  first: 0,
  follow_up: 4,
}

/** 今天还能发几封（60 §6：默认 20 / 天）。 */
export interface PitchQuota {
  cap: number
  sent_today: number
  remaining: number
  allowed: boolean
}

/** 按"最近 24 小时里发过几封"算，不按自然日——自然日会在跨时区那一刻突然放开一整天。 */
export function pitchQuota(input: {
  cap: number
  sent_at: readonly Iso8601[]
  now: Iso8601
}): PitchQuota {
  const t = Date.parse(input.now)
  const dayAgo = t - 86_400_000
  const sent = input.sent_at.filter((s) => {
    const at = Date.parse(s)
    return !Number.isNaN(at) && at > dayAgo && at <= t
  }).length
  const remaining = Math.max(0, input.cap - sent)
  return { cap: input.cap, sent_today: sent, remaining, allowed: remaining > 0 }
}

/** 序列里下一封该是哪一封、什么时候发。 */
export interface NextPitch {
  step: PitchStep
  /** 该发的时刻（首封是"随时"，所以是空串）。 */
  due_at: string
  /** 为什么是它（卡面上那一句）。 */
  why: string
}

/**
 * 算序列的下一封。
 *
 * 四种情况没有下一封（回 `undefined`），每一种都是**故意**的：
 * - 他回过信了：接下来是人在谈，不是机器在跟；
 * - 他已经写过我们了（`covered`）：序列的目的达到了；
 * - 他明说过不感兴趣（`declined`）：再发一封就是骚扰；
 * - 跟进那封已经发了 / 他在抑制名单上。
 */
export function nextPitch(input: {
  stage: MediaPitchStage
  sent: readonly { step: PitchStep; at: Iso8601 }[]
  /** 这个人的邮箱（比抑制名单用；**不落库**）。 */
  contact: string
  suppressed: readonly string[]
}): NextPitch | undefined {
  if (input.stage === 'replied' || input.stage === 'covered') return undefined
  if (input.stage === 'declined' || input.stage === 'suppressed') return undefined
  if (withoutSuppressed([input.contact], input.suppressed).length === 0) return undefined
  const done = new Set(input.sent.map((s) => s.step))
  if (done.has('follow_up')) return undefined
  const first = input.sent.find((s) => s.step === 'first')
  if (first === undefined) return { step: 'first', due_at: '', why: '这个人还没发过第一封。' }
  const base = Date.parse(first.at)
  if (Number.isNaN(base)) return undefined
  return {
    step: 'follow_up',
    due_at: new Date(base + MEDIA_SEQUENCE_DAYS.follow_up * 86_400_000).toISOString(),
    why: `首封发出去 ${MEDIA_SEQUENCE_DAYS.follow_up} 天了还没回音，跟进一封。跟进之后就不再发——记者一天收几百封，第三封是骚扰。`,
  }
}

/** 为什么这个人今天没被选上（卡面上要说得出来，不能只报一个数）。 */
export type PitchSkipReason =
  | 'suppressed'
  | 'no_contact'
  | 'already_in_sequence'
  | 'beat_mismatch'
  | 'quota'

/**
 * 这一批候选人里，今天该给谁发。
 *
 * 一次把四件事都办了，因为它们必须一起看（同 48 §5.2 那条）：名单上的剔掉、
 * 没有邮箱的剔掉、已经在序列里的不重发、日配额到顶就停。分四处调的话总有一处会漏。
 *
 * `beats` 给了就再加一道：这条新闻是讲什么的，发给写这个领域的人。
 * **不给就不筛**——宁可多发给一个人，也不要因为我们没给领域标签就一封都不发。
 */
export function selectPitchTargets(input: {
  candidates: readonly Pick<MediaContact, 'id' | 'beats' | 'stage'>[]
  /** `id` → 这个人的邮箱（只在这一跳里用）。没有这一格 = 还发不出信。 */
  contacts: Readonly<Record<string, string>>
  suppressed: readonly string[]
  /** 这条新闻讲什么（不给就不按领域筛）。 */
  beats?: readonly string[]
  quota: PitchQuota
}): {
  picked: { contact_id: string; email: string }[]
  skipped: { contact_id: string; reason: PitchSkipReason }[]
} {
  const denied = new Set(input.suppressed.map(suppressionKey))
  const want = input.beats === undefined ? undefined : new Set(input.beats.map((b) => b.trim()))
  const picked: { contact_id: string; email: string }[] = []
  const skipped: { contact_id: string; reason: PitchSkipReason }[] = []
  for (const c of input.candidates) {
    const email = input.contacts[c.id]
    if (email === undefined || email.trim() === '') {
      skipped.push({ contact_id: c.id, reason: 'no_contact' })
      continue
    }
    if (denied.has(suppressionKey(email))) {
      skipped.push({ contact_id: c.id, reason: 'suppressed' })
      continue
    }
    if (c.stage !== 'new') {
      skipped.push({ contact_id: c.id, reason: 'already_in_sequence' })
      continue
    }
    if (want !== undefined && !c.beats.some((b) => want.has(b.trim()))) {
      skipped.push({ contact_id: c.id, reason: 'beat_mismatch' })
      continue
    }
    if (picked.length >= input.quota.remaining) {
      skipped.push({ contact_id: c.id, reason: 'quota' })
      continue
    }
    picked.push({ contact_id: c.id, email })
  }
  return { picked, skipped }
}

/** 建联漏斗上的一行（面板"pitch 漏斗"那一块读它）。 */
export interface PitchFunnelRow {
  stage: MediaPitchStage
  label: string
  count: number
}

/** 六个阶段各有几个人。**阶段顺序固定**，没有人的那一档也出一行（0 也是一句话）。 */
export function pitchFunnel(contacts: readonly Pick<MediaContact, 'stage'>[]): PitchFunnelRow[] {
  const labels: Readonly<Record<MediaPitchStage, string>> = {
    new: '还没发过',
    pitched: '发过了，等回音',
    replied: '回了，在谈',
    covered: '写了我们',
    declined: '明说不写',
    suppressed: '别再找他',
  }
  const order: MediaPitchStage[] = [
    'new',
    'pitched',
    'replied',
    'covered',
    'declined',
    'suppressed',
  ]
  return order.map((stage) => ({
    stage,
    label: labels[stage],
    count: contacts.filter((c) => c.stage === stage).length,
  }))
}

/** 邮箱脱敏（`a***@x.com`）：够人认出是哪一个，不足以拿去发信。 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  const head = local.slice(0, 1)
  return `${head}***${email.slice(at)}`
}
