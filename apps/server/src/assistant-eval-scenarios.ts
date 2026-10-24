/**
 * WP511（决策 1547，docs/115 §4 第 5 条）：助理长对话评测用的**合成**生意长对话（跨几天、换几次话题、带附件、改过口径），
 * 里面埋探针：期望记住的（退货期限、某个价格、交给了哪个岗位、附件深处的一个数）与不该记住的（被改掉的旧口径、
 * 只是假设没定的数）。全部是编的示例店，不含任何真实客户。
 *
 * 填充的闲聊按种子确定地生成（同一个种子同样的对话），用来把原话撑过预算、逼出段内压缩。
 */

export interface EvalFile {
  name: string
  text: string
}

export interface EvalTurn {
  /** ISO 时间（换天 / 隔两小时会自动切段）。 */
  at: string
  text: string
  files?: EvalFile[]
}

export interface EvalProbe {
  id: string
  at: string
  /** 问助理的那一句。 */
  ask: string
  /** 替身模型在上下文里找答案用的关键词（全部出现的那一行算找到）。 */
  keys: string[]
  /** 回答里出现其中任何一个算答对。 */
  expect: string[]
  /**
   * 误记：回答里出现其中任何一个、**而且**没有答对（只提一句「之前是 30 天」不算误记）——被改掉的旧口径、没定的假设。
   */
  forbid?: string[]
  /** 这一条考的是什么。 */
  kind: 'fact' | 'superseded' | 'attachment' | 'dispatch' | 'preference'
}

export interface EvalScenario {
  id: string
  title: string
  turns: EvalTurn[]
  probes: EvalProbe[]
}

/** 确定的伪随机（mulberry32）。 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FILLER = [
  '帮我把这周社媒的发帖节奏理一下，周二周四各一条，周末看情况。',
  '客服那边说最近问物流的变多了，你看下要不要加一段常见问题。',
  '新品详情页的卖点再顺一下，第一屏只留三条，别堆参数。',
  '下周要和两个红人聊合作，先把报价区间和寄样流程准备好。',
  '店铺首页的横幅换成秋季那套，旧的先下线。',
  '帮我想三个邮件标题，给老客户发复购券用的，别太像广告。',
  '把上个月的退款原因按类别汇总一下，看看哪类最多。',
  'Reddit 那边的帖子回复语气再口语一点，别像客服模板。',
]

/** 一句填充：按种子挑一条，后面拖一段说明把字数撑长（`size` 个汉字左右）。 */
export function filler(rand: () => number, size: number): string {
  const head = FILLER[Math.floor(rand() * FILLER.length)] ?? FILLER[0]
  const pad = '具体按之前的做法来，有拿不准的先列出来我再看'
  return `${head}${pad.repeat(Math.max(1, Math.round(size / pad.length)))}。`
}

const day = (d: number, hh: number, mm = 0): string =>
  `2026-10-${String(12 + d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`

/** 一天里连着说 `n` 句填充（每句隔 3 分钟，不切段）。 */
function chatter(d: number, hh: number, n: number, rand: () => number, size: number): EvalTurn[] {
  const from = Date.parse(day(d, hh))
  return Array.from({ length: n }, (_, i) => ({
    at: new Date(from + i * 3 * 60_000).toISOString(),
    text: filler(rand, size),
  }))
}

/** 周会纪要：开头是常规事项，深处埋一个数（附件探针）。 */
function minutes(rand: () => number): string {
  const items = Array.from(
    { length: 60 },
    (_, i) => `${i + 1}. ${filler(rand, 40).replace(/。$/u, '')}；负责人按岗位分工。`,
  )
  return [
    '# 10-14 周会纪要（示例店）',
    '',
    '本周主要过了大促备货、客服话术和社媒节奏三件事。',
    '',
    ...items.slice(0, 40),
    '',
    '大促安排：双十一预售定金定为 88 元，尾款 11 月 10 日 20 点开付。',
    '',
    ...items.slice(40),
  ].join('\n')
}

/**
 * 三条合成长对话。`size` = 每句填充多少字（撑预算用），`chatterPerDay` = 每天几句填充。
 */
export function evalScenarios(
  opts: { seed?: number; size?: number; chatterPerDay?: number } = {},
): EvalScenario[] {
  const rand = seeded(opts.seed ?? 42)
  const size = opts.size ?? 200
  const per = opts.chatterPerDay ?? 24
  const returns: EvalScenario = {
    id: 'returns-policy',
    title: '退货口径与价格（跨 5 天，中途改过一次口径）',
    turns: [
      { at: day(0, 2), text: '先定个规矩：退货期限 30 天，从签收那天算。' },
      ...chatter(0, 3, per, rand, size),
      { at: day(1, 2), text: 'A1 型号的售价定 99 元，B2 型号先定 129 元。' },
      ...chatter(1, 3, per, rand, size),
      { at: day(2, 2), text: '退货期限改一下：从 30 天改成 15 天，下周一起生效，之前的单照旧。' },
      ...chatter(2, 3, per, rand, size),
    ],
    probes: [
      {
        id: 'returns-now',
        at: day(4, 2),
        ask: '现在退货期限是几天？',
        keys: ['退货期限'],
        expect: ['15 天', '15天'],
        forbid: ['30 天', '30天'],
        kind: 'superseded',
      },
      {
        id: 'a1-price',
        at: day(4, 2, 5),
        ask: 'A1 型号卖多少钱来着？',
        keys: ['A1', '元'],
        expect: ['99'],
        kind: 'fact',
      },
    ],
  }
  const attach: EvalScenario = {
    id: 'meeting-notes',
    title: '附了一份长纪要，几天后问深处的数',
    turns: [
      {
        at: day(0, 6),
        text: '这是这周的周会纪要，你先看一下。',
        files: [{ name: '周会纪要.md', text: minutes(rand) }],
      },
      { at: day(0, 6, 3), text: '里面社媒那部分你帮我拆一下，排个先后。' },
      { at: day(0, 6, 6), text: '这件事交给社媒运营岗做，周五前出排期。' },
      ...chatter(0, 7, per, rand, size),
      ...chatter(1, 6, per, rand, size),
    ],
    probes: [
      {
        id: 'deposit',
        at: day(3, 6),
        ask: '纪要里双十一预售定金是多少？',
        keys: ['定金'],
        expect: ['88'],
        kind: 'attachment',
      },
      {
        id: 'balance-time',
        at: day(3, 6, 5),
        ask: '尾款几号开付？',
        keys: ['尾款'],
        expect: ['11 月 10 日', '11月10日', '11 月 10'],
        kind: 'attachment',
      },
      {
        id: 'who-social',
        at: day(3, 6, 10),
        ask: '社媒排期那件事交给谁了？',
        keys: ['交给', '社媒'],
        expect: ['社媒运营'],
        kind: 'dispatch',
      },
    ],
  }
  const hypo: EvalScenario = {
    id: 'hypothetical',
    title: '只是假设、没定的数不该记成定了的；本人偏好要记住',
    turns: [
      { at: day(0, 9), text: '以后给我汇报都用表格，别写大段文字。' },
      ...chatter(0, 10, per, rand, size),
      { at: day(1, 9), text: '如果 B2 型号改卖 199 元会怎样？先别定，只是想想。' },
      { at: day(1, 9, 3), text: '算了，B2 型号还是卖 129 元，不改了。' },
      ...chatter(1, 10, per, rand, size),
    ],
    probes: [
      {
        id: 'b2-price',
        at: day(3, 9),
        ask: 'B2 型号现在卖多少？',
        keys: ['B2', '元'],
        expect: ['129'],
        forbid: ['199'],
        kind: 'superseded',
      },
      {
        id: 'report-format',
        at: day(3, 9, 5),
        ask: '我汇报喜欢什么格式？',
        keys: ['汇报'],
        expect: ['表格'],
        kind: 'preference',
      },
    ],
  }
  return [returns, attach, hypo]
}
