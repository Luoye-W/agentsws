/**
 * 47 J2 知识层与操作层的边界，在进入管道上的那一道拦。
 *
 * **知识层只存文字与判断，不存状态。** 事实卡可以说"退款政策是 30 天"，
 * 不能说"订单 #1001 已退款"——后者是操作层的实时状态，写进 Wiki 的那一刻就开始过期，
 * 而 Wiki 没有人会去更新它。等到半年后模型检索到它，它会理直气壮地告诉客户
 * 一件半年前为真的事。
 *
 * 所以带"状态词"的句子进 Wiki 时**降级为历史案例**（`layer: 'historical_case'`），
 * 打上"当时"的时间戳，不当事实。它仍然查得到、仍然有用（"上次这种情况我们怎么办的"），
 * 只是不再冒充"现在是什么样"。
 *
 * 判定是**表驱动 + 正则**，中英都认。两条纪律：
 *
 * 1. **宁可误伤，不可放过**：一条过时的状态混成事实，代价是答错客户；一条政策被
 *    误降成历史案例，代价是有人点一下改回来（`downgraded_from` 记着原来那层）。
 * 2. **只看句子，不看上下文**：这一层判不了"这个数字是政策还是状态"，
 *    所以判据要窄到"只有状态才会这么写"——订单号、履约状态、库存数、
 *    带货币符号的具体金额。**纯天数不算**（"30 天内可退"是政策）。
 */

export type StateWordCategory = 'order_id' | 'fulfillment' | 'inventory' | 'money' | 'payment'

export interface StateWordRule {
  category: StateWordCategory
  /** 一句人话：这条判据在抓什么。 */
  what: string
  match: RegExp
}

/**
 * 判据表。加一条就加一行——不要把新判据塞进已有的正则里，
 * 命中了哪一条要能说得出来（界面上那句"为什么降级"就是它）。
 */
export const STATE_WORD_RULES: readonly StateWordRule[] = [
  {
    category: 'order_id',
    what: '订单号 / 单号',
    // `#1001`、`订单 1001`、`order #1001`、`order 1001`、`ord_1001`
    match: /#\s*\d{3,}|(?:订单|单号|order|invoice)\s*(?:号)?\s*#?\s*\d{3,}|\bord_[a-z0-9]{3,}\b/i,
  },
  {
    category: 'fulfillment',
    what: '履约 / 物流状态',
    match:
      /已(?:发货|签收|送达|退款|退货|取消|发出|入库|出库)|未(?:发货|签收|送达|退款)|(?:已经|尚未)(?:发货|退款)|\b(?:has been|was|were|is|are)\s+(?:shipped|delivered|refunded|cancelled|canceled|returned|fulfilled|unfulfilled)\b|\b(?:fulfillment_status|financial_status)\b/i,
  },
  {
    category: 'inventory',
    what: '库存数 / 在库量',
    match:
      /(?:库存|在库|现货|可售)\s*(?:还有|剩下|为|是|:|：)?\s*\d+|\b\d+\s*(?:units?|pcs|in stock)\b|\b(?:stock|inventory)\s*(?:level|count|on hand)?\s*(?:is|:)\s*\d+/i,
  },
  {
    category: 'money',
    what: '具体金额（带货币）',
    // 政策里的"30 天"不算；"退了 129 美元 / $129 / USD 129"算
    // 注意不要在中文货币名后面写 `\b`：`\b` 只认 [A-Za-z0-9_]，"129 元"会漏
    match:
      /[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:美元|欧元|英镑|人民币|元)|\b(?:USD|EUR|GBP|CNY|JPY)\s?\d[\d,]*(?:\.\d+)?\b/i,
  },
  {
    category: 'payment',
    what: '支付 / 退款流水',
    match:
      /(?:退款|付款|扣款|到账)(?:已|于|在)\s*\d|\b(?:refund|payment|charge)\s+(?:id|reference|ref)\b|\bre_[a-z0-9]{6,}\b|\bch_[a-z0-9]{6,}\b/i,
  },
]

export interface StateWordHit {
  category: StateWordCategory
  what: string
  /** 命中的那一小段原文（界面上标黄给人看的那一截，最多 60 字）。 */
  matched: string
}

/**
 * 一句话里有没有状态词。命中多条就全都返回——界面要说清"因为这几处才降的级"。
 */
export function detectStateWords(text: string): StateWordHit[] {
  const hits: StateWordHit[] = []
  for (const rule of STATE_WORD_RULES) {
    const m = rule.match.exec(text)
    if (m === null) continue
    hits.push({ category: rule.category, what: rule.what, matched: m[0].slice(0, 60) })
  }
  return hits
}

/** 只问是不是。 */
export function hasStateWords(text: string): boolean {
  return STATE_WORD_RULES.some((r) => r.match.test(text))
}

/** 降级的理由，一句人话（进事件与界面）。 */
export function downgradeReason(hits: readonly StateWordHit[]): string {
  const what = [...new Set(hits.map((h) => h.what))].join('、')
  return `这句话里有${what}——那是操作层的实时状态，Wiki 存不住它，降成历史案例并记下当时的时间`
}
