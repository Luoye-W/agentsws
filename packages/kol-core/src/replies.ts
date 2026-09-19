/**
 * 回复分类与陌生来信（48 §5.2「回复识别、陌生来信」）。
 *
 * **封闭六类**，跟 KefuAgents 的入站分类同一条纪律：分不出来就是 `unknown`，
 * 不许为了让数字好看而硬塞进某一类。六类是：
 *
 * | 类 | 什么样 | 接下来该干什么 |
 * |---|---|---|
 * | `interested` | "有兴趣""想了解一下" | 进谈条件 |
 * | `wants_quote` | "报个价""你们预算多少" | 起一条合作（永远人审） |
 * | `declined` | "不做""没档期""别再发了" | 谢绝 + 进抑制名单（如果他明说别发了） |
 * | `already_working` | "我已经和你们合作过了""在跟你同事谈" | 先查库，别让两个人同时谈一个人 |
 * | `cold_inbound` | 不是我们发过信的人主动来信 | 当作一条新线索，先打分 |
 * | `spam` | 群发推广、代运营、卖粉 | 丢掉，不进库 |
 *
 * 判据是**词表 + 一条结构判断**（是不是我们发过信的人），没有模型。
 * 模型那一半在运行时里，这里是它的兜底与测试锚点。
 */
import type { KolReplyClass } from '@agentsws/contracts'

/**
 * WP117b（66 复测 #19）：口径搬到契约里了（{@link KolReplyClass}）——回信分类现在
 * 要**存下来**（`KolExchange.reply_class`）并跨包传到界面上，两份同名不同步的
 * 联合迟早会对不上。这里留一个别名，本包的调用方一个字都不用改。
 */
export type ReplyClass = KolReplyClass

export interface ReplyClassification {
  klass: ReplyClass
  /** 0–1。低于 {@link CONFIDENCE_FLOOR} 的一律降成 `unknown`（见 {@link classifyReply}）。 */
  confidence: number
  /** 命中的那几条判据（卡面上的"为什么这么判"）。 */
  signals: string[]
  /**
   * 对方是不是明说了"别再发了"。
   *
   * 与 `declined` **分得开**："这次不做"和"以后都别找我"是两件事，
   * 只有后者才进抑制名单——把前者也加进去，等于把一个还能合作的人永久拉黑。
   */
  opt_out: boolean
}

/** 低于这个把握就当没分出来。 */
export const CONFIDENCE_FLOOR = 0.5

interface Rule {
  klass: ReplyClass
  terms: readonly string[]
  /**
   * 命中一条给多少把握。
   *
   * 一条**明确**的信号就该够（"这次不合适"不需要第二条证据），所以单条就越过
   * {@link CONFIDENCE_FLOOR}；含糊一些的（"有兴趣"也可能是客套）压低一点，
   * 让它在与别的类打平时让位。
   */
  weight: number
}

const RULES: readonly Rule[] = [
  {
    klass: 'wants_quote',
    weight: 0.6,
    terms: [
      '报价',
      '报个价',
      '多少钱',
      '预算是多少',
      '合作费',
      '坑位费',
      'rate card',
      'my rates',
      'how much',
      'what is your budget',
      'pricing',
    ],
  },
  {
    klass: 'already_working',
    weight: 0.6,
    terms: [
      '已经合作',
      '合作过',
      '在跟你们',
      '跟你同事',
      'already working with',
      'already partnered',
      'your colleague',
      'we spoke before',
    ],
  },
  {
    klass: 'declined',
    weight: 0.6,
    terms: [
      '不合适',
      '暂时不',
      '没档期',
      '不做推广',
      '谢绝',
      '不感兴趣',
      'not interested',
      'no thanks',
      'not a fit',
      'pass on this',
      'fully booked',
    ],
  },
  {
    klass: 'interested',
    weight: 0.55,
    terms: [
      '有兴趣',
      '感兴趣',
      '想了解',
      '可以聊',
      '愿意试试',
      'interested',
      'sounds good',
      'would love to',
      'tell me more',
      'happy to chat',
    ],
  },
  {
    klass: 'spam',
    weight: 0.65,
    terms: [
      '代运营',
      '涨粉',
      '刷量',
      '一键分发',
      '加微信了解',
      'seo services',
      'buy followers',
      'guest post',
      'link building',
      'increase your traffic',
      'unsubscribe from this list',
    ],
  },
]

/** 明说"别再发了"的说法。命中 → `opt_out`，进抑制名单。 */
const OPT_OUT_TERMS: readonly string[] = [
  '别再发',
  '不要再发',
  '退订',
  '取消订阅',
  '请勿再联系',
  'stop emailing',
  'do not contact',
  'unsubscribe me',
  'remove me',
  'take me off',
]

/**
 * 分一封回信。
 *
 * `known_contact` 是那条结构判断：我们没给他发过信、他自己找上门 = `cold_inbound`。
 * 这件事从词表里看不出来，必须由调用方回答。
 */
export function classifyReply(input: {
  text: string
  /** 这个地址是不是我们发过开发信的人。 */
  known_contact: boolean
}): ReplyClassification {
  const text = input.text.toLowerCase()
  const signals: string[] = []
  const scores = new Map<ReplyClass, number>()
  for (const rule of RULES) {
    for (const term of rule.terms) {
      if (!text.includes(term.toLowerCase())) continue
      signals.push(`${rule.klass}:${term}`)
      scores.set(rule.klass, (scores.get(rule.klass) ?? 0) + rule.weight)
    }
  }
  const opt_out = OPT_OUT_TERMS.some((t) => text.includes(t.toLowerCase()))
  if (opt_out) signals.push('opt_out')

  let best: ReplyClass = 'unknown'
  let confidence = 0
  for (const [klass, score] of scores) {
    if (score <= confidence) continue
    best = klass
    confidence = score
  }
  confidence = Math.min(1, confidence)

  // 明说别再发了：不管上面判成什么，这是一条谢绝（而且要进抑制名单）
  if (opt_out) return { klass: 'declined', confidence: Math.max(confidence, 0.9), signals, opt_out }

  // 垃圾邮件哪怕来自我们发过信的地址也是垃圾（对方的邮箱被人拿去群发了）
  if (best === 'spam' && confidence >= CONFIDENCE_FLOOR)
    return { klass: 'spam', confidence, signals, opt_out }

  if (!input.known_contact) {
    // 不是我们发过信的人：这是一条陌生来信。
    // 里面要是有明确的报价 / 已合作信号，照那个判——陌生来信里也有直接开价的。
    if (confidence >= CONFIDENCE_FLOOR && (best === 'wants_quote' || best === 'already_working'))
      return { klass: best, confidence, signals, opt_out }
    return {
      klass: 'cold_inbound',
      confidence: 0.8,
      signals: [...signals, 'unknown_sender'],
      opt_out,
    }
  }

  if (confidence < CONFIDENCE_FLOOR) return { klass: 'unknown', confidence, signals, opt_out }
  return { klass: best, confidence, signals, opt_out }
}

/** 这一类回信接下来该干什么（卡面上那一句建议；**建议不是动作**，人点了才发生）。 */
export const NEXT_STEP_ZH: Readonly<Record<ReplyClass, string>> = {
  interested: '他有兴趣——把这条合作推进到「谈条件中」，然后聊具体怎么做。',
  wants_quote: '他要报价——建一条合作把预算写清楚（这一步永远要人点头）。',
  declined: '他谢绝了——把这条合作标成「已谢绝」；他要是说了别再发，顺手加进抑制名单。',
  already_working: '他说已经在合作了——先在库里查一遍，别让两个人同时谈同一个人。',
  cold_inbound: '陌生来信——先给他打个分，再决定要不要谈。',
  spam: '是垃圾邮件——丢掉，不进库。',
  unknown: '看不出他什么意思——这封得人读一遍。',
}
