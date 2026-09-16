/**
 * 评论 / 私信 / 帖子的分类（56 §3 `triage.ts`）——**社媒运营这条职责的分水岭**。
 *
 * 56 的边界行（Luoye 定的）：
 *
 * > 社群 / 私信里的客户问题**不归社媒运营**，归客服岗位的「社群管理」。
 *
 * 这个文件就是那句话的落点。它回答的是"该谁接"，不是"该怎么答"——判完之后
 * 社媒运营只做两件事：判成 `customer_question` 的出一张**转客服卡**
 * （{@link handoffOf}），判成 `partnership` 的提示转红人营销。别的才自己处理。
 *
 * 三条纪律：
 *
 * 1. **封闭六类**（契约 `CommunityTriage`，与 `kol-core` 的回复分类同一条纪律）。
 *    判不准就落 `other`，**不猜**。多一个"疑似客户问题"的桶只会让两边都不接：
 *    社媒运营觉得客服会看，客服觉得那是评论区的事。
 * 2. **判据是词表 + 两条结构判断**，没有模型。模型那一半在运行时里；这里是它的
 *    兜底与测试锚点——模型没接上 / 拿不到额度的时候，这一份照样判得出来。
 * 3. **原文不进结论**。{@link TriageResult.signals} 只有命中的判据名，不抄原句：
 *    分类结论会进事件日志，而评论正文是**外部文本**（21 §1）。
 */

import type { CommunityTriage } from '@agentsws/contracts'

export interface TriageResult {
  klass: CommunityTriage
  /** 0–1。低于 {@link TRIAGE_FLOOR} 的一律降成 `other`。 */
  confidence: number
  /** 命中的判据名（**不是原句**，见文件头第 3 条）。 */
  signals: string[]
  /** 该谁接。`social` = 社媒运营自己处理。 */
  route: TriageRoute
}

/**
 * 判完之后交给谁。
 *
 * - `social`：社媒运营自己（夸、投诉、垃圾、其它）；
 * - `support`：客服的「社群管理」（`dtc.community-support`）——**客户的问题**；
 * - `kol`：红人营销（合作询问）。
 */
export type TriageRoute = 'social' | 'support' | 'kol'

/** 低于这个把握就当没分出来（落 `other`）。 */
export const TRIAGE_FLOOR = 0.5

/** 六类各归谁。**只有这一份**：转客服卡、岗位路由、面板计数都读它。 */
export const TRIAGE_ROUTES: Readonly<Record<CommunityTriage, TriageRoute>> = {
  customer_question: 'support',
  partnership: 'kol',
  praise: 'social',
  complaint: 'social',
  spam: 'social',
  other: 'social',
}

interface Rule {
  klass: CommunityTriage
  /** 命中一条给多少把握。明确的信号一条就够（越过 {@link TRIAGE_FLOOR}）。 */
  weight: number
  terms: readonly string[]
}

/**
 * 词表。**只可加行**（15 §2 对规则集的老规矩）。
 *
 * 几条取舍写在这里，免得后来的人以为是漏了：
 *
 * - "什么时候到""发货了吗""退款"这些进 `customer_question` 而不是 `complaint`：
 *   它们是**问题**，问题归客服；抱怨才是投诉。一条"我的单还没到，太慢了"
 *   两边都命中，按下面的加权算，`customer_question` 会赢——这是有意的：
 *   客服接得住抱怨，社媒运营接不住订单。
 * - 合作询问的词表故意收窄（"合作""商务""寄样"），因为社群里"合作"这个词
 *   也常常是闲聊。宁可漏判成 `other`（人自己会看到），也不要把一堆闲聊
 *   推给红人营销那条职责。
 */
const RULES: readonly Rule[] = [
  {
    klass: 'customer_question',
    weight: 0.62,
    terms: [
      '我的单',
      '我的订单',
      '订单号',
      '什么时候到',
      '什么时候发',
      '发货了吗',
      '还没收到',
      '物流',
      '快递',
      '单号',
      '退款',
      '退货',
      '换货',
      '保修',
      '发票',
      '怎么用',
      '怎么安装',
      '尺寸',
      '兼容',
      '支持吗',
      'my order',
      'order number',
      'when will it ship',
      'when will it arrive',
      'not received',
      'tracking',
      'refund',
      'return it',
      'exchange',
      'warranty',
      'how do i',
      'does it work with',
      'is it compatible',
    ],
  },
  {
    klass: 'partnership',
    weight: 0.6,
    terms: [
      '商务合作',
      '合作洽谈',
      '想合作',
      '寄样',
      '带货',
      '推广报价',
      'collab',
      'collaboration',
      'brand partnership',
      'sponsorship',
      'pr package',
      'media kit',
    ],
  },
  {
    klass: 'complaint',
    weight: 0.55,
    terms: [
      '太差',
      '垃圾产品',
      '骗人',
      '投诉',
      '差评',
      '再也不买',
      '失望',
      '客服不理',
      'terrible',
      'awful',
      'scam',
      'worst',
      'never buying',
      'disappointed',
      'no one replied',
    ],
  },
  {
    klass: 'praise',
    weight: 0.55,
    terms: [
      '太好用',
      '真香',
      '爱了',
      '好评',
      '推荐给',
      '质量很好',
      '很满意',
      'love it',
      'awesome',
      'great product',
      'highly recommend',
      'works great',
    ],
  },
  {
    klass: 'spam',
    weight: 0.7,
    terms: [
      '加微信',
      '私聊',
      '刷单',
      '代运营',
      '涨粉',
      '免费领',
      '点击链接',
      '博彩',
      'click here to win',
      'free followers',
      'crypto',
      'telegram.me/',
      'bit.ly/',
      'dm me for',
      'make $',
    ],
  },
]

const norm = (text: string): string => text.toLowerCase()

/**
 * 判一条。
 *
 * 加权很简单，故意的：每命中一条 term 就把那一类的分加上 `weight`，
 * 分最高的那一类赢；平手按 {@link RULES} 的顺序（客户问题在最前——
 * **漏判成客户问题的代价，比漏判成别的类小得多**：多转一张卡去给客服看，
 * 比让一个买家在群里等三天没人理要好）。
 *
 * `is_dm` 与 `mentions_us` 是两条结构判断：
 *
 * - 私信里一句"在吗"没有任何词命中，但它多半是要问东西——所以私信的
 *   `other` 给一点向 `customer_question` 的倾斜（见下面那一段）；
 * - 顺手 @ 了我们一下的闲聊不该因为出现了"订单"两个字就变成客服工单。
 */
export function triageThread(input: {
  text: string
  /** 是不是私信（`CommunityThread.surface === 'dm'`）。 */
  is_dm?: boolean
  /** 这条是不是冲着我们来的（@ 了我们 / 在我们自己的帖子下）。 */
  mentions_us?: boolean
}): TriageResult {
  const text = norm(input.text)
  const scores = new Map<CommunityTriage, number>()
  const signals: string[] = []
  for (const rule of RULES) {
    for (const term of rule.terms) {
      if (!text.includes(norm(term))) continue
      scores.set(rule.klass, (scores.get(rule.klass) ?? 0) + rule.weight)
      signals.push(`${rule.klass}:${term}`)
    }
  }

  /*
   * 私信的倾斜：一条没命中任何词的私信，多半是"在吗""你好"这种开场白，
   * 后面跟着的就是一个客户问题。给它一点分，让它落在 `customer_question`
   * 而不是 `other`——落 `other` 的后果是没人接，落客服的后果是客服看一眼
   * 发现是闲聊然后关掉。后者便宜得多。
   */
  if (input.is_dm === true && scores.size === 0 && text.trim() !== '') {
    scores.set('customer_question', TRIAGE_FLOOR + 0.01)
    signals.push('customer_question:dm_opener')
  }

  let best: CommunityTriage = 'other'
  let bestScore = 0
  for (const rule of RULES) {
    const s = scores.get(rule.klass) ?? 0
    // 严格大于：平手时 RULES 的顺序说了算（客户问题在最前）
    if (s > bestScore) {
      best = rule.klass
      bestScore = s
    }
  }

  const confidence = Math.min(1, bestScore)
  const klass = confidence >= TRIAGE_FLOOR ? best : 'other'
  return {
    klass,
    confidence: klass === 'other' && bestScore === 0 ? 0 : confidence,
    signals,
    route: TRIAGE_ROUTES[klass],
  }
}

/** 一张转出去的卡该带什么（{@link handoffOf} 的返回）。 */
export interface TriageHandoff {
  /** 转给哪条职责。 */
  to_role: 'dtc.community-support' | 'kol.meta' | string
  /** 卡面标题。 */
  title: string
  /** 为什么转（给人看的一句话，不是规则名）。 */
  reason: string
}

/**
 * 判成要转出去的那两类 → 一张卡该带什么；自己能处理的回 `undefined`。
 *
 * **社媒运营不答客户问题**这件事在这里变成代码：`customer_question` 出的是
 * 一张转客服卡，而不是一段草稿。想让它自己答，得先改 56 的那条边界。
 *
 * `kol` 那一路只给**提示**（"这像是合作询问，要不要转给红人营销"）而不是
 * 直接建一条合作：建合作永远 L1（15 §2 的 `HARD_L1`），不该由一条评论触发。
 */
export function handoffOf(
  result: TriageResult,
  ctx: { channel: string; author_handle: string },
): TriageHandoff | undefined {
  if (result.route === 'support') {
    return {
      to_role: 'dtc.community-support',
      title: `转客服：${ctx.author_handle} 在 ${ctx.channel} 里的问题`,
      reason:
        '这是客户的问题（订单 / 售后 / 怎么用），按 56 的边界归客服的「社群管理」答——社媒运营管内容、氛围、活动与群规。',
    }
  }
  if (result.route === 'kol') {
    return {
      to_role: 'kol.meta',
      title: `合作询问：${ctx.author_handle}（${ctx.channel}）`,
      reason:
        '这像是一条合作询问。红人营销那条职责有完整的建联与合作流程；这里只提示，不替它建合作（建合作永远人审）。',
    }
  }
  return undefined
}

/** 一批线程按类计数（面板上"转客服计数"那一格读它）。 */
export function triageCounts(
  results: readonly { klass: CommunityTriage }[],
): Record<CommunityTriage, number> {
  const out: Record<CommunityTriage, number> = {
    customer_question: 0,
    praise: 0,
    complaint: 0,
    spam: 0,
    partnership: 0,
    other: 0,
  }
  for (const r of results) out[r.klass] += 1
  return out
}
