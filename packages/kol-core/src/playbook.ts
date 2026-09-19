/**
 * WP117（66 断点 #1）：红人岗位的**剧本**——「交给岗位一件事」之后先干什么。
 *
 * 为什么这一份要在共享包里而不是写在 stub 里：三个运行时都要用同一份口径
 * （同 `support-core` 的 `boundaryGate`）。stub 照它直接调；direct / dsh 下真模型
 * 自己挑工具，但**摘要、意图判定与参数抽取**仍走这一份，不然同一句话在三个运行时
 * 下会被判成三件事，模拟回路的不变量就钉不住了。
 *
 * 纯函数：没有 `Date.now()`、没有 IO、没有模型调用（本包的纪律）。
 */
import type { KolChannel } from '@agentsws/contracts'
import type { OutreachStep } from './outreach.js'

/**
 * 一件事落在红人这条链的哪一步。
 *
 * 封闭七类，判不出来是 `unknown`——`unknown` 不是错误，是「这件事我先去看合作清单，
 * 然后说人话问一句」。不猜一个动作：猜错了等于替人做了决定。
 */
export type KolIntent =
  | 'find'
  | 'outreach'
  | 'follow_up'
  | 'negotiate'
  | 'collab_status'
  | 'deliverable_review'
  | 'attribution'
  | 'unknown'

export interface KolIntentHit {
  intent: KolIntent
  /** 命中的词（卡面与时间线上的「为什么这么判」）。 */
  signals: string[]
}

interface IntentRule {
  intent: KolIntent
  terms: readonly string[]
}

/**
 * 判据表。顺序即优先级：**越具体的排越前**——「审一下这条视频」同时命中
 * 「视频」（找人那条也有）与「审」，该判成审稿而不是找人。
 */
const RULES: readonly IntentRule[] = [
  {
    intent: 'deliverable_review',
    terms: [
      '审稿',
      '审一下',
      '审一条',
      '审核',
      '验收',
      '交付物',
      '交稿',
      '打回',
      '不合格',
      'review',
    ],
  },
  {
    intent: 'attribution',
    terms: ['归因', '带货', '带来订单', '追踪链接', '折扣码', '联盟码', 'utm', '效果', '转化'],
  },
  {
    intent: 'follow_up',
    terms: ['跟进', '没回', '没回音', '没有回复', '催一下', '再发一封', 'follow up', 'follow-up'],
  },
  /*
   * 起草类排在议价前面：**要的是一封信还是一个价钱**，这是分界。
   * 「起草一封开发信……不提具体报价」里有「报价」，但它是否定句里的词——
   * 判成议价的话这次运行就不起草了，而人明明要的是那封信。
   */
  {
    intent: 'outreach',
    terms: ['开发信', '建联', '邀约', '合作意向', '写信', '发信', '联系他', '联系她', 'outreach'],
  },
  {
    intent: 'negotiate',
    terms: ['报价', '议价', '谈价', '多少钱', '预算', '砍价', '费用', '佣金', 'quote', 'price'],
  },
  {
    intent: 'collab_status',
    terms: ['到哪一步', '进展', '状态', '合作清单', '寄样', '推进', '阶段', 'status'],
  },
  {
    intent: 'find',
    terms: [
      '找',
      '搜',
      '挑',
      '候选',
      '名单',
      '红人',
      '达人',
      '博主',
      '频道',
      'up 主',
      'creator',
      'channel',
    ],
  },
]

/** 一句话 → 意图。大小写不敏感；命中的词都留在 `signals` 里。 */
export function classifyKolTask(text: string): KolIntentHit {
  const lower = text.toLowerCase()
  for (const rule of RULES) {
    const hits = rule.terms.filter((t) => lower.includes(t.toLowerCase()))
    if (hits.length > 0) return { intent: rule.intent, signals: hits }
  }
  return { intent: 'unknown', signals: [] }
}

/** 「找 20 个」「20 个频道」→ 20。没写就 undefined（由调用方给默认值）。 */
export function parseWantedCount(text: string): number | undefined {
  const m = text.match(/(\d{1,3})\s*(?:个|条|位|名)/)
  const n = m?.[1] === undefined ? Number.NaN : Number.parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 「1 万到 10 万」「10000-100000」→ 粉丝区间。两头都认不出就 undefined。 */
export function parseFollowerBand(text: string): { min: number; max: number } | undefined {
  const wan = text.match(/(\d+(?:\.\d+)?)\s*万\s*(?:到|至|-|~|—)\s*(\d+(?:\.\d+)?)\s*万/)
  if (wan?.[1] !== undefined && wan[2] !== undefined) {
    return { min: Math.round(Number(wan[1]) * 10_000), max: Math.round(Number(wan[2]) * 10_000) }
  }
  const plain = text.match(/(\d{3,9})\s*(?:到|至|-|~|—)\s*(\d{3,9})/)
  if (plain?.[1] !== undefined && plain[2] !== undefined) {
    const min = Number.parseInt(plain[1], 10)
    const max = Number.parseInt(plain[2], 10)
    if (min < max) return { min, max }
  }
  return undefined
}

/** 一句话里点名的第几封（默认首封）。 */
export function parseOutreachStep(text: string): OutreachStep {
  const lower = text.toLowerCase()
  if (['收尾', '最后一封', '第三封', 'final'].some((t) => lower.includes(t))) return 'final'
  if (['跟进', '第二封', '再发一封', 'follow'].some((t) => lower.includes(t))) return 'follow_up'
  return 'first'
}

/**
 * 从一句话里挑关键词当搜索词：去掉数量词、粉丝区间与那些没有信息量的动词。
 *
 * WP117b（66 复测 #15）：**渠道词也是噪声**。
 *
 * 「找 20 个粉丝 1 万到 10 万的 YouTube 频道」里唯一剩下的词是 `youtube` 与 `频道`，
 * 而它们说的是"在哪条渠道找"，不是"找什么样的人"——渠道已经由
 * {@link channelInText} 单独读走了。留着它们，搜索就变成"名字里带 youtube 的人"，
 * 于是库里那两个 48,000 / 31,000 粉的频道一个都搜不到（回「找到 0 个」）。
 *
 * 一个关键词都不剩是**正常结局**：那句话本来就没说要什么样的人，只说了渠道与
 * 粉丝区间。这时回空串，调用方按"不加关键词、只按区间筛"去搜。
 */
const NOISE = [
  '帮我',
  '请',
  '按',
  '这个',
  '在',
  '上',
  '找',
  '搜',
  '挑',
  '一批',
  '一个',
  '给我',
  '排',
  '按匹配度',
  '粉丝',
  '的',
  '个',
]

/** 说的是"哪条渠道"而不是"什么样的人"的那些词（与 {@link channelInText} 同一份口径）。 */
const CHANNEL_WORDS = [
  'youtube',
  '油管',
  '频道',
  'instagram',
  'ins',
  'tiktok',
  '抖音国际',
  'facebook',
  '脸书',
  'twitter',
  '推特',
  'up 主',
  '红人',
  '达人',
  '博主',
  'creator',
  'channel',
]

export function searchQueryOf(text: string): string {
  let out = text.replace(/\d+(?:\.\d+)?\s*万?/g, ' ').replace(/[，。,.!！?？;；:：、]/g, ' ')
  for (const n of NOISE) out = out.split(n).join(' ')
  const words = out
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .filter((w) => !CHANNEL_WORDS.includes(w.toLowerCase()))
  return words.slice(0, 6).join(' ').trim()
}

/** 一句话里的渠道词（用户点名了「油管」就按 youtube，哪怕这条职责是别的）。 */
export function channelInText(text: string): KolChannel | undefined {
  const lower = text.toLowerCase()
  if (['youtube', '油管', 'yt', '频道'].some((t) => lower.includes(t))) return 'youtube'
  if (['instagram', 'ins', 'ig'].some((t) => lower.includes(t))) return 'instagram'
  if (['tiktok', '抖音国际', 'tt'].some((t) => lower.includes(t))) return 'tiktok'
  if (['facebook', 'fb', '脸书'].some((t) => lower.includes(t))) return 'facebook'
  if (['twitter', ' x ', '推特'].some((t) => lower.includes(t))) return 'x'
  return undefined
}

/** 一次计划好的工具调用。 */
export interface PlannedKolCall {
  tool: string
  input: Record<string, unknown>
}

/** 现场有什么（服务端从事项上下文里读出来的那几个 id）。 */
export interface KolTaskContext {
  /** 这条职责的渠道（`kol.youtube` → youtube）。 */
  channel: KolChannel
  /** 事项正文 / 简报。 */
  text: string
  creator_id?: string
  collaboration_id?: string
  deliverable_id?: string
  /** 活动名（没有就用事项标题）。 */
  campaign?: string
  /** 要推的产品（公司档案或事项里读出来的）。 */
  product?: string
  /** 落地页（建追踪链接用）。 */
  target_url?: string
}

/**
 * 意图 + 现场 → **按顺序**该调哪几个工具。
 *
 * 三条纪律：
 *
 * 1. **先读后写**：每条路都以一个读工具开头（47 J3 的组序在 prompt 里是提示，
 *    在剧本里是硬顺序）——没读过就写，provenance 那条不变量当场红。
 * 2. **缺 id 就降级**：要 `collaboration_id` 而现场没有，不编一个，改成先
 *    `list_collaborations` 把清单读出来（然后这次运行只回一句「是哪一条」）。
 * 3. **写工具一次只提一件**：`draft_outreach` 一次一个人。批量在服务端那一侧
 *    由 campaign 清单卡承担（人点一次批一组），不在这里展开成 20 次调用。
 */
export function planKolTools(intent: KolIntent, ctx: KolTaskContext): PlannedKolCall[] {
  const channel = channelInText(ctx.text) ?? ctx.channel
  const limit = parseWantedCount(ctx.text) ?? 20
  /*
   * WP117b（66 复测 #15）：**粉丝区间是条件，得递给工具**。
   *
   * 「1 万到 10 万」以前只被 `parseFollowerBand` 读出来写在回话里，一次都没进过
   * 搜索的入参——于是"找 20 个粉丝 1 万到 10 万的频道"与"找 20 个频道"打的是
   * 同一个请求。关键词那一格同理：算出来是空串就**不带 q**（不再退回渠道名当关键词，
   * 那是回 0 个的直接原因）。
   */
  const band = parseFollowerBand(ctx.text)
  const q = searchQueryOf(ctx.text)
  const find: PlannedKolCall = {
    tool: 'search_creators',
    input: {
      channel,
      ...(q === '' ? {} : { q }),
      limit,
      ...(band === undefined ? {} : { min_followers: band.min, max_followers: band.max }),
    },
  }
  const collabs: PlannedKolCall = { tool: 'list_collaborations', input: { channel } }

  switch (intent) {
    case 'find':
      return ctx.campaign === undefined
        ? [find]
        : [find, { tool: 'add_to_campaign', input: { creator_ids: [], campaign: ctx.campaign } }]

    case 'outreach': {
      if (ctx.creator_id === undefined) return [find]
      const step = parseOutreachStep(ctx.text)
      return [
        { tool: 'get_creator', input: { creator_id: ctx.creator_id } },
        { tool: 'search_policies', input: { query: '合作政策 寄样 佣金' } },
        {
          tool: 'draft_outreach',
          input: {
            creator_id: ctx.creator_id,
            channel,
            step,
            ...(ctx.product === undefined ? {} : { product: ctx.product }),
          },
        },
      ]
    }

    case 'follow_up': {
      if (ctx.creator_id === undefined) return [collabs]
      return [
        collabs,
        {
          tool: 'draft_outreach',
          input: { creator_id: ctx.creator_id, channel, step: parseOutreachStep(ctx.text) },
        },
      ]
    }

    // 议价**不自己定价**：读完合作与政策就停，价格永远是人在卡上填的那个数。
    case 'negotiate':
      return [collabs, { tool: 'search_policies', input: { query: '报价 佣金 预算 上限' } }]

    case 'collab_status':
      return [collabs]

    case 'deliverable_review': {
      const list: PlannedKolCall = {
        tool: 'list_deliverables',
        input:
          ctx.collaboration_id === undefined
            ? { pending: true }
            : { collaboration_id: ctx.collaboration_id },
      }
      if (ctx.deliverable_id === undefined) return [list]
      return [
        list,
        { tool: 'search_policies', input: { query: '广告标识 禁用词 合规' } },
        {
          tool: 'review_deliverable',
          input: { deliverable_id: ctx.deliverable_id, review: 'changes_requested' },
        },
      ]
    }

    case 'attribution':
      return ctx.collaboration_id === undefined
        ? [collabs]
        : [
            collabs,
            {
              tool: 'create_tracked_link',
              input: {
                collaboration_id: ctx.collaboration_id,
                ...(ctx.target_url === undefined ? {} : { target_url: ctx.target_url }),
              },
            },
          ]

    default:
      return [collabs]
  }
}

/** 这次运行的摘要（17 §3，三个运行时同一份拼法）。 */
export function describeKolRun(input: {
  intent: KolIntent
  readTools: readonly string[]
  found?: number
  drafted?: boolean
  stagedWhat?: string
  askedWhat?: string
  exhausted?: string
}): string {
  const parts: string[] = [KOL_INTENT_ZH[input.intent]]
  if (input.found !== undefined) parts.push(`找到 ${input.found} 个候选`)
  if (input.readTools.length > 0) parts.push(`查了 ${[...new Set(input.readTools)].join('、')}`)
  if (input.drafted === true) parts.push('起草了一封开发信（待批）')
  if (input.stagedWhat !== undefined) parts.push(`提了一条${input.stagedWhat}（待批）`)
  if (input.askedWhat !== undefined) parts.push(`问了一句：${input.askedWhat}`)
  if (input.exhausted !== undefined) parts.push(`${input.exhausted} 预算耗尽，先停在这里`)
  return parts.join('；')
}

/** 意图的人话（摘要与时间线上用的就是这几个词）。 */
export const KOL_INTENT_ZH: Readonly<Record<KolIntent, string>> = {
  find: '找人',
  outreach: '建联起草',
  follow_up: '跟进',
  negotiate: '议价',
  collab_status: '看合作进展',
  deliverable_review: '审交付物',
  attribution: '看归因',
  unknown: '先看合作清单',
}
