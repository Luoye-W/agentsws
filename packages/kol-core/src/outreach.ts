/**
 * 开发信：起草、禁承诺自查、序列与日配额（48 §5.2「建联」）。
 *
 * 四条纪律：
 *
 * 1. **禁承诺词表只有一份**。它在 `@agentsws/core` 的 `KOL_OUTREACH_FORBIDDEN` 里，
 *    因为 guardrail 那道最后的闸也要读它。这里 `import` 的就是那一个数组，不抄。
 *    起草时先自查是为了**尽早**给模型反馈（改一版再提，而不是提上去被拦），
 *    不是为了代替那道闸——闸在 guardrail，永远在。
 * 2. **日配额与抑制名单复用，不复制**。抑制名单是 `@agentsws/core` 的
 *    `suppression.ts`（与客服出站、邮件营销同一份）；日配额这里只算"今天还能发几封"，
 *    真正的拦在 guardrail 的 `max_outreach_per_day`。
 * 3. **序列是三封，不是无限跟进**：首封 → 3 天跟进 → 7 天收尾。收尾那封写明
 *    "不回我就不再打扰"，然后**真的不再发**——序列里没有第四封这个选项。
 * 4. **没有 `Date.now()`**：时间一律由调用方按注入的 Clock 传进来。
 */

import type { KolChannel } from '@agentsws/contracts'
import { KOL_OUTREACH_FORBIDDEN, suppressionKey, withoutSuppressed } from '@agentsws/core'

/** 序列里的第几封。 */
export type OutreachStep = 'first' | 'follow_up' | 'final'

/** 序列的节奏（天）。首封是第 0 天。 */
export const SEQUENCE_DAYS: Readonly<Record<OutreachStep, number>> = {
  first: 0,
  follow_up: 3,
  final: 7,
}

export const SEQUENCE_ORDER: readonly OutreachStep[] = ['first', 'follow_up', 'final']

/** 起草一封信要的变量。少一个必填变量就不起草（见 {@link draftOutreach}）。 */
export interface OutreachVars {
  /** 红人的显示名。 */
  creator_name: string
  /** 品牌名。 */
  brand: string
  /** 一句话说我们是做什么的。 */
  brand_pitch: string
  /** 想聊的那个产品。 */
  product: string
  /** 为什么找他（打分里最高的那一项的 `why` 直接塞进来最好）。 */
  reason: string
  /** 署名。 */
  sender_name: string
  /** 渠道（正文里的说法按渠道换：YouTube 说"频道"，X 说"你的帖子"）。 */
  channel: KolChannel
}

/** 起草的结果。`blocked` 有值就是这一封不能提上去。 */
export interface OutreachDraft {
  step: OutreachStep
  subject: string
  body: string
  /** 正文里命中禁承诺词表的那几个词（空数组 = 干净）。 */
  forbidden_hits: string[]
  /** 变量里没填的那几个（空数组 = 齐了）。 */
  missing_vars: string[]
  /** 能不能提上去。`false` 时看上面两格。 */
  ok: boolean
}

const CHANNEL_NOUN: Readonly<Record<KolChannel, string>> = {
  youtube: '频道',
  facebook: '主页',
  instagram: '账号',
  tiktok: '账号',
  x: '账号',
}

const CHANNEL_WORK: Readonly<Record<KolChannel, string>> = {
  youtube: '视频',
  facebook: '帖子',
  instagram: '帖子',
  tiktok: '短视频',
  x: '帖子',
}

/**
 * 三封信的模板。
 *
 * 为什么是模板而不是每封让模型现写：开发信这件事上，**可预期**比**惊艳**值钱得多——
 * 模板里没有承诺的位置，而一段现写的话里随时可能冒出一句"我们会付你"。
 * 模型的活儿是填 `reason` 那一格（为什么找他），不是重写整封信。
 */
const TEMPLATES: Readonly<
  Record<
    OutreachStep,
    (v: OutreachVars, noun: string, work: string) => { subject: string; body: string }
  >
> = {
  first: (v, noun, work) => ({
    subject: `${v.brand} × ${v.creator_name}：想聊聊合作`,
    body: [
      `${v.creator_name} 你好，`,
      '',
      `我是 ${v.brand} 的 ${v.sender_name}。${v.brand_pitch}`,
      '',
      `${v.reason}所以想问问你对 ${v.product} 有没有兴趣，看看有没有合作的可能。`,
      '',
      `如果你愿意聊，回一封信告诉我你的合作方式和档期就行，具体怎么做我们再一起定。`,
      '',
      `另外，你${noun}上的${work}我们看过，不是群发——有想问的随时说。`,
      '',
      `${v.sender_name}`,
      v.brand,
    ].join('\n'),
  }),
  follow_up: (v) => ({
    subject: `Re: ${v.brand} × ${v.creator_name}：想聊聊合作`,
    body: [
      `${v.creator_name} 你好，`,
      '',
      `几天前给你写过一封关于 ${v.product} 的信，怕它掉进垃圾箱里了，再发一次。`,
      '',
      `${v.reason}如果现在档期排满了，或者这个方向你不做，回一句我就不再打扰。`,
      '',
      `${v.sender_name}`,
      v.brand,
    ].join('\n'),
  }),
  final: (v) => ({
    subject: `Re: ${v.brand} × ${v.creator_name}：最后一封`,
    body: [
      `${v.creator_name} 你好，`,
      '',
      `这是我就 ${v.product} 给你写的最后一封信——没收到回音，我就当这次不合适，不再发了。`,
      '',
      `以后有想聊的，随时回这封信。祝顺利。`,
      '',
      `${v.sender_name}`,
      v.brand,
    ].join('\n'),
  }),
}

const REQUIRED_VARS: readonly (keyof OutreachVars)[] = [
  'creator_name',
  'brand',
  'brand_pitch',
  'product',
  'reason',
  'sender_name',
]

/**
 * 正文里有没有禁承诺的说法。大小写不敏感，返回命中的**原词表写法**
 * （不是正文里的写法——卡面上要说的是"你写了『我们付你』这类话"）。
 */
export function scanForbiddenPromises(text: string): string[] {
  const lower = text.toLowerCase()
  return KOL_OUTREACH_FORBIDDEN.filter((w) => lower.includes(w.toLowerCase()))
}

/**
 * 起草一封。
 *
 * 变量缺了就**不起草**（`ok: false` + `missing_vars`）：拿一封写着
 * "{{product}}" 的信去问人要不要发，比不起草更糟。
 */
export function draftOutreach(step: OutreachStep, vars: Partial<OutreachVars>): OutreachDraft {
  const missing = REQUIRED_VARS.filter((k) => {
    const v = vars[k]
    return typeof v !== 'string' || v.trim() === ''
  })
  const channel = vars.channel ?? 'youtube'
  if (missing.length > 0)
    return {
      step,
      subject: '',
      body: '',
      forbidden_hits: [],
      missing_vars: missing,
      ok: false,
    }
  const full = { ...(vars as OutreachVars), channel }
  const { subject, body } = TEMPLATES[step](full, CHANNEL_NOUN[channel], CHANNEL_WORK[channel])
  const hits = scanForbiddenPromises(`${subject}\n${body}`)
  return {
    step,
    subject,
    body,
    forbidden_hits: hits,
    missing_vars: [],
    ok: hits.length === 0,
  }
}

/**
 * 已经写好的一封（模型改过、人改过）再过一遍禁承诺。
 *
 * 起草与复查分成两个函数，是因为真实路径上这一封会被改：模型补一段、人删一句，
 * 改完之后**必须**再扫一遍，否则模板干净等于什么都没保证。
 */
export function reviewOutreachBody(input: { subject: string; body: string }): {
  ok: boolean
  forbidden_hits: string[]
  /** 一句人话（`ok` 时是空串）。 */
  message: string
} {
  const hits = scanForbiddenPromises(`${input.subject}\n${input.body}`)
  if (hits.length === 0) return { ok: true, forbidden_hits: [], message: '' }
  return {
    ok: false,
    forbidden_hits: hits,
    message: `这封信里写了「${hits.join('」「')}」这类承诺。给钱、白送样品、保证效果都要走"建一条合作"那条路（那一步永远要人点头），不能在信里写死。把这几句删掉或者改成"我们再聊具体怎么做"。`,
  }
}

/** 今天还能发几封（日配额）。 */
export interface OutreachQuota {
  /** 上限（职责 yml 的 `max_outreach_per_day`）。 */
  cap: number
  /** 今天已经发出去几封。 */
  sent_today: number
  /** 还剩几封。 */
  remaining: number
  /** 还能不能发。 */
  allowed: boolean
}

/**
 * 算日配额。
 *
 * **只算，不拦**：真正的拦在 guardrail（`max_outreach_per_day`）。这里算出来的数
 * 是给面板与卡面用的——"今天还能发 12 封"这句话要在人点批准之前就看得见。
 */
export function outreachQuota(input: {
  cap: number
  /** 今天发出去那几封的时间戳（ISO）。 */
  sent_at: readonly string[]
  /** 现在（注入）。 */
  now: string
}): OutreachQuota {
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
export interface NextInSequence {
  step: OutreachStep
  /** 该发的时间（ISO）。 */
  due_at: string
  /** 为什么是它（卡面上那一句）。 */
  why: string
}

/**
 * 算序列的下一封。
 *
 * 三种情况没有下一封（回 `undefined`），每一种都是**故意**的：
 * - 对方回过信了：序列的目的达到了，接下来是人在谈，不是机器在跟；
 * - 收尾那封已经发了：序列里没有第四封；
 * - 这个人在抑制名单上：他说过别来找我。
 */
export function nextInSequence(input: {
  /** 已经发过的那几封（按发送顺序）。 */
  sent: readonly { step: OutreachStep; at: string }[]
  /** 对方回过信没有。 */
  replied: boolean
  /** 联系方式（比抑制名单用）。 */
  contact: string
  /** 抑制 / 退订名单。 */
  suppressed: readonly string[]
}): NextInSequence | undefined {
  if (input.replied) return undefined
  if (withoutSuppressed([input.contact], input.suppressed).length === 0) return undefined
  const done = new Set(input.sent.map((s) => s.step))
  if (done.has('final')) return undefined
  const first = input.sent.find((s) => s.step === 'first')
  if (first === undefined) return { step: 'first', due_at: '', why: '这个人还没发过第一封。' }
  const base = Date.parse(first.at)
  if (Number.isNaN(base)) return undefined
  const step: OutreachStep = done.has('follow_up') ? 'final' : 'follow_up'
  const due = new Date(base + SEQUENCE_DAYS[step] * 86_400_000).toISOString()
  return {
    step,
    due_at: due,
    why:
      step === 'follow_up'
        ? `首封发出去 ${SEQUENCE_DAYS.follow_up} 天了还没回音，跟进一封。`
        : `第二封也没回音，发收尾那封——写明不再打扰，然后真的不再发。`,
  }
}

/**
 * 一批候选人里，哪些人今天可以发信。
 *
 * 一次把三件事都办了，因为它们必须一起看：名单上的人剔掉、已经在序列里的不重发、
 * 日配额到顶就停。分三处调的话，总有一处会漏——WP55 的客服出站就是这么立的规矩。
 */
export function selectOutreachTargets(input: {
  candidates: readonly { creator_id: string; contact: string }[]
  suppressed: readonly string[]
  /** 已经发过信的那几个 `creator_id`。 */
  already_contacted: readonly string[]
  quota: OutreachQuota
}): {
  picked: { creator_id: string; contact: string }[]
  /** 被剔掉的与为什么（卡面上要说得出来）。 */
  skipped: { creator_id: string; reason: 'suppressed' | 'already_contacted' | 'quota' }[]
} {
  const denied = new Set(input.suppressed.map(suppressionKey))
  const contacted = new Set(input.already_contacted)
  const picked: { creator_id: string; contact: string }[] = []
  const skipped: { creator_id: string; reason: 'suppressed' | 'already_contacted' | 'quota' }[] = []
  for (const c of input.candidates) {
    if (denied.has(suppressionKey(c.contact))) {
      skipped.push({ creator_id: c.creator_id, reason: 'suppressed' })
      continue
    }
    if (contacted.has(c.creator_id)) {
      skipped.push({ creator_id: c.creator_id, reason: 'already_contacted' })
      continue
    }
    if (picked.length >= input.quota.remaining) {
      skipped.push({ creator_id: c.creator_id, reason: 'quota' })
      continue
    }
    picked.push(c)
  }
  return { picked, skipped }
}
