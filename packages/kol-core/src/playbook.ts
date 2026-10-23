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
import { KOL_CHANNELS, type KolChannel } from '@agentsws/contracts'
import { builtinContentTable, readContentTable } from '@agentsws/core'
import type { OutreachStep } from './outreach.js'
import INTENTS_FILE from './playbook-intents.content.json' with { type: 'json' }
import WORDS_FILE from './playbook-words.content.json' with { type: 'json' }

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
  id: string
  intent: KolIntent
  terms: readonly string[]
}

/**
 * 判据表。顺序即优先级：**越具体的排越前**——「审一下这条视频」同时命中
 * 「视频」（找人那条也有）与「审」，该判成审稿而不是找人。
 *
 * WP404（docs/107 §3）：表是数据（`playbook-intents.content.json`，每条带 id；当初为什么这么排的原注释
 * 原样留在每条的 `notes` 里）。按品牌可覆盖：`readContentTable`。
 */
const INTENTS_TABLE = builtinContentTable<IntentRule>(INTENTS_FILE)

const isIntentRule = (r: unknown): r is IntentRule =>
  typeof (r as IntentRule).intent === 'string' &&
  Array.isArray((r as IntentRule).terms) &&
  (r as IntentRule).terms.every((t) => typeof t === 'string')

/**
 * WP404：剧本的几张词表（去噪词、中文渠道词、渠道词、一句话里点名的渠道）也是数据
 * （`playbook-words.content.json`，一个词一行、带 id）。
 */
interface WordRow {
  id: string
  list: 'noise' | 'cjk_channel' | 'channel' | 'in_text'
  word: string
  /** `in_text` 那几行：这个词指的是哪条渠道。 */
  channel?: KolChannel
}

const WORDS_TABLE = builtinContentTable<WordRow>(WORDS_FILE)

const isWordRow = (r: unknown): r is WordRow =>
  typeof (r as WordRow).word === 'string' && typeof (r as WordRow).list === 'string'

interface Words {
  noise: readonly string[]
  cjkChannel: readonly string[]
  channel: readonly string[]
  /** 按渠道出现的顺序，每条渠道一组词。 */
  inText: readonly (readonly [KolChannel, readonly string[]])[]
}

const wordsCache = new WeakMap<readonly WordRow[], Words>()

function words(brand?: string): Words {
  const rows = readContentTable(WORDS_TABLE, { brand, accepts: isWordRow })
  let hit = wordsCache.get(rows)
  if (hit === undefined) {
    const of = (list: WordRow['list']): string[] =>
      rows.filter((r) => r.list === list).map((r) => r.word)
    const inText = new Map<KolChannel, string[]>()
    for (const r of rows)
      if (r.list === 'in_text' && r.channel !== undefined)
        inText.set(r.channel, [...(inText.get(r.channel) ?? []), r.word])
    hit = {
      noise: of('noise'),
      cjkChannel: of('cjk_channel'),
      channel: of('channel'),
      inText: [...inText.entries()],
    }
    wordsCache.set(rows, hit)
  }
  return hit
}

/** 一句话 → 意图。大小写不敏感；命中的词都留在 `signals` 里。 */
export function classifyKolTask(text: string, options: { brand?: string } = {}): KolIntentHit {
  const lower = text.toLowerCase()
  for (const rule of readContentTable(INTENTS_TABLE, {
    brand: options.brand,
    accepts: isIntentRule,
  })) {
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

/** WP295：「超过 7 天还没回」→ 7；没说几天按跟进节奏的第一档（3 天跟进、7 天收尾里取 7）。 */
export function parseQuietDays(text: string): number {
  const m = text.match(/(\d{1,3})\s*天/)
  const n = m?.[1] === undefined ? Number.NaN : Number.parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : 7
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
 *
 * WP295：渠道词常粘在品类词后面（「数码频道」「美妆博主」「科技油管主」）——中文没有空格，
 * 按词拆不开，整串当关键词又对不上库里的「数码」。中文的渠道词按**子串**去掉；
 * 英文的（`ins` 这种短词）仍只按整词去，免得把 `insulated` 切坏。
 *
 * 说的是"哪条渠道"而不是"什么样的人"的那些词与 {@link channelInText} 同一份口径。
 * WP404：去噪词、中文渠道词、渠道词三张表在 `playbook-words.content.json`（list = noise / cjk_channel /
 * channel），见 `words()`。
 */
export function searchQueryOf(text: string, options: { brand?: string } = {}): string {
  const w = words(options.brand)
  let out = text.replace(/\d+(?:\.\d+)?\s*万?/g, ' ').replace(/[，。,.!！?？;；:：、]/g, ' ')
  for (const n of w.cjkChannel) out = out.split(n).join(' ')
  for (const n of w.noise) out = out.split(n).join(' ')
  const kept = out
    .split(/\s+/)
    .filter((x) => x.length > 1)
    .filter((x) => !w.channel.includes(x.toLowerCase()))
  return kept.slice(0, 6).join(' ').trim()
}

/** 一句话里的渠道词（用户点名了「油管」就按 youtube，哪怕这条职责是别的）。 */
export function channelInText(
  text: string,
  options: { brand?: string } = {},
): KolChannel | undefined {
  const lower = text.toLowerCase()
  for (const [channel, terms] of words(options.brand).inText)
    if (terms.some((t) => lower.includes(t))) return channel
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
      /*
       * WP295：没点名是谁就**不拿这句话去搜**——「给这个频道起草一封开发信：说清合作形式……」
       * 按关键词搜出来是 0 个，回话就成了「一个合适的都没找到」。改成把库里这条渠道的几个人
       * 列出来（不带关键词），回话问「写给谁」。
       */
      if (ctx.creator_id === undefined)
        return [{ tool: 'search_creators', input: { channel, limit: KOL_REPLY_NAMES } }]
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
      // WP295：「谁还没回」——只要已建联、这么多天没动静的那几条（每行带名字与天数）
      if (ctx.creator_id === undefined)
        return [
          {
            tool: 'list_collaborations',
            input: { channel, quiet_days: parseQuietDays(ctx.text) },
          },
        ]
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
      // WP295：没点名哪条合作 = 问「哪几个真带货了」——读归因那张表，不是读合作清单
      return ctx.collaboration_id === undefined
        ? [{ tool: 'list_tracked_links', input: { channel } }]
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
  if (input.readTools.length > 0)
    parts.push(`查了${[...new Set(input.readTools.map(toolZh))].join('、')}`)
  if (input.drafted === true) parts.push('起草了一封开发信（待批）')
  if (input.stagedWhat !== undefined) parts.push(`提了一条${input.stagedWhat}（待批）`)
  if (input.askedWhat !== undefined) parts.push(`问了一句：${input.askedWhat}`)
  if (input.exhausted !== undefined)
    parts.push(`${BUDGET_ZH[input.exhausted] ?? '这次的额度'}用完了，先停在这里`)
  return parts.join('；')
}

/**
 * WP141（docs/78 §2 红人第 14 步）：摘要里不印工具名。原来写「查了 search_creators」——
 * 工具名是给模型看的，给人看的是它干了什么。表里没有的工具退回一句「一个工具」。
 */
export const KOL_TOOL_ZH: Readonly<Record<string, string>> = {
  search_creators: '红人库',
  get_creator: '红人资料',
  list_collaborations: '合作清单',
  list_deliverables: '交付物清单',
  list_tracked_links: '归因',
  search_policies: '合作规矩',
  add_to_campaign: '活动名单',
  draft_outreach: '开发信草稿',
  review_deliverable: '交付物审核',
  create_tracked_link: '追踪链接',
  import_creator_sheet: '红人表',
  update_stages_from_mail: '过往邮件',
}

const toolZh = (tool: string): string => KOL_TOOL_ZH[tool] ?? '一个工具'

/** 预算的哪一格用完了（`max_tool_calls` 这种键不上屏）。 */
const BUDGET_ZH: Readonly<Record<string, string>> = {
  max_tool_calls: '这次能查的次数',
  max_tokens: '这次能写的字数',
  max_wall_ms: '这次能用的时间',
  max_cost_usd: '这次的花费额度',
}

/**
 * WP142：工具名 → **动作**的人话（回话里一行一件事：「- 找人：……」「- 查政策：完成」）。
 *
 * 与上面 WP141 的 `KOL_TOOL_ZH`（摘要里「查了红人库」用的名词）分开：一个说"查了什么"，
 * 一个说"干了什么"。认不出的工具说「查了一下资料」，也不露名字。
 */
export const KOL_TOOL_ACTION_ZH: Readonly<Record<string, string>> = {
  search_creators: '找人',
  get_creator: '看这个人的资料',
  list_collaborations: '看合作清单',
  list_deliverables: '看交付物',
  list_tracked_links: '看归因',
  score_creator: '打分',
  add_to_campaign: '进候选池',
  draft_outreach: '起草开发信',
  advance_collaboration: '推进合作阶段',
  register_deliverable: '登记交付物',
  review_deliverable: '验收交付物',
  create_tracked_link: '建追踪链接',
  import_creator_sheet: '读红人表',
  update_stages_from_mail: '用邮件更新阶段',
  search_policies: '查政策',
}

export function kolToolZh(tool: string): string {
  const bare = tool.includes('.') ? tool.slice(tool.indexOf('.') + 1) : tool
  return KOL_TOOL_ACTION_ZH[bare] ?? '查了一下资料'
}

/** 找人回话里的一个人（名字 + 粉丝数，够认人就行）。 */
export interface KolFoundCreator {
  name: string
  followers?: number
  /** WP295：表格里那两列（有才填）。 */
  engagement_rate?: number
  score?: number
}

/** 回话里那几个站内链接（服务端知道这条职责的分配 id，拼好了递进来）。 */
export interface KolReplyLinks {
  /** 候选池（「去候选池看全部」）。 */
  pool?: string
  /** 关联官方数据接口（设置 → 账号与积分）。 */
  linkAccount?: string
  /** 导入一张表（岗位页「活动」那一栏里的导入）。 */
  importTable?: string
  /** WP295：合作线程（「谁还没回」回话里的去处）。 */
  threads?: string
}

/** 回话里最多点名几个（多了就是一张表，表在候选池里）。 */
export const KOL_REPLY_NAMES = 5

/** 粉丝数说人话：48000 → 「4.8 万粉」，8500 → 「8,500 粉」。 */
export function followersZh(n: number): string {
  if (n >= 10_000) {
    const wan = Math.round(n / 1000) / 10
    return `${wan.toLocaleString('en-US', { maximumFractionDigits: 1 })} 万粉`
  }
  return `${n.toLocaleString('en-US')} 粉`
}

/** 站内链接写成 `[字](/路径)`——工作台时间线把它画成可点的链接（只认 `/` 开头的站内路径）。 */
function link(label: string, href: string | undefined): string | undefined {
  return href === undefined ? undefined : `[${label}](${href})`
}

/**
 * WP142（docs/78 §1 #5，第 14 步）：「找 N 个」的回话。
 *
 * 以前只报一个数（「找人：2 条」），不说是谁、为什么不够、下一步怎么办。现在三段：
 *
 * 1. **是谁**：前 5 个名字（带粉丝数）+「去候选池看全部」；
 * 2. **为什么不够**（找到的少于要的）：库里只有 N 个在这个区间；这一份若是退到了
 *    本地红人库（这条渠道没连任何数据来源），把这件事说出来；
 * 3. **下一步**：两个动作——关联官方数据接口 / 导入一张表。
 *
 * 纯函数，三个运行时同一份：stub 直接拼；direct / dsh 的模型自己写回话时，
 * 服务端的时间线兜底也可以用它。
 */
export function describeFindReply(input: {
  channel: string
  band?: { min: number; max: number } | undefined
  /** 用户点名要几个；没说就 undefined（不替他说「你要 20 个」）。 */
  wanted?: number | undefined
  found: readonly KolFoundCreator[]
  /** 这一份从哪来：`local_library` = 这条渠道没接数据来源，退到了自己的红人库。 */
  source?: string | undefined
  links?: KolReplyLinks | undefined
}): string[] {
  const where = channelZh(input.channel)
  const band =
    input.band === undefined
      ? ''
      : `按粉丝 ${input.band.min.toLocaleString('en-US')}–${input.band.max.toLocaleString('en-US')} `
  const n = input.found.length
  const lines: string[] = []
  lines.push(
    n === 0
      ? `在 ${where} 上${band}找了一遍，一个合适的都没找到。`
      : `在 ${where} 上${band}找了一遍，找到 ${n} 个：`,
  )
  /*
   * WP295（docs/96 P4 问答就是组件）：找到的人是一张**表**（名字 · 粉丝 · 互动率 · 分），不是
   * 一串圆点。岗位页的当场回答与时间线都由安全 markdown 把它画成表。
   * 表前表后各空一行：第一段是那一句话，表后面的话进末尾那块字。
   */
  if (n > 0) {
    lines.push('', '| 红人 | 粉丝 | 互动率 | 分 |', '|---|---|---|---|')
    for (const c of input.found.slice(0, KOL_REPLY_NAMES))
      lines.push(
        `| ${c.name.replace(/\|/g, '/')} | ${c.followers === undefined ? '—' : followersZh(c.followers).replace(/\s*粉$/u, '')} | ${
          c.engagement_rate === undefined
            ? '—'
            : `${(Math.round(c.engagement_rate * 1000) / 10).toString()}%`
        } | ${c.score === undefined ? '—' : String(c.score)} |`,
      )
    lines.push('')
  }
  const pool = link('去候选池看全部', input.links?.pool)
  if (n > KOL_REPLY_NAMES)
    lines.push(`……还有 ${n - KOL_REPLY_NAMES} 个${pool === undefined ? '' : `，${pool}`}`)
  else if (n > 0 && pool !== undefined) lines.push(pool)

  const short = input.wanted !== undefined && n < input.wanted
  if (short || n === 0) {
    const local = input.source === 'local_library'
    const range = input.band === undefined ? '' : '在这个区间'
    lines.push(
      local
        ? `${input.wanted === undefined ? '' : `你要 ${input.wanted} 个，`}库里只有 ${n} 个${range}——${where} 还没接数据来源，这一份只是你自己红人库里的人。`
        : `${input.wanted === undefined ? '' : `你要 ${input.wanted} 个，`}这次只找到 ${n} 个${range}。`,
    )
    const actions = [
      link('关联官方数据接口', input.links?.linkAccount),
      link('导入一张表', input.links?.importTable),
    ].filter((a): a is string => a !== undefined)
    if (actions.length > 0) lines.push(`想要更多人：${actions.join(' · ')}`)
  }
  return lines
}

/**
 * WP295：「谁还没回」的回话——点名、带天数、说下一步在哪。
 *
 * 以前这句快捷提示回的是「看合作清单：26 条」，等于没答。
 */
export function describeQuietReply(input: {
  channel: string
  days: number
  rows: readonly { name: string; days?: number | undefined }[]
  links?: KolReplyLinks | undefined
}): string[] {
  const where = channelZh(input.channel)
  if (input.rows.length === 0)
    return [`${where} 上建联超过 ${input.days} 天还没回音的：一个都没有。`]
  const lines = [`${where} 上建联超过 ${input.days} 天还没回音的有 ${input.rows.length} 个：`]
  for (const r of input.rows.slice(0, KOL_REPLY_NAMES))
    lines.push(`- ${r.name}（${r.days === undefined ? '没记下发信时间' : `${r.days} 天`}）`)
  if (input.rows.length > KOL_REPLY_NAMES)
    lines.push(`- ……还有 ${input.rows.length - KOL_REPLY_NAMES} 个`)
  const threads = link('合作线程', input.links?.threads)
  lines.push(
    `要跟进就${threads === undefined ? '在合作线程里' : `在${threads}里`}点开那个人，提第二封（跟进那封）；不想再联系的推到「谢绝了」。`,
  )
  return lines
}

/**
 * WP295：「起草开发信」没点名写给谁——问一句，顺手列出库里这条渠道的几个人。
 *
 * 以前拿整句话当关键词去搜，回「一个合适的都没找到」，人根本不知道问题在哪。
 */
export function describeWhoToWriteReply(input: {
  channel: string
  found: readonly KolFoundCreator[]
  links?: KolReplyLinks | undefined
}): string[] {
  const where = channelZh(input.channel)
  const pool = link('候选池', input.links?.pool)
  const lines = [
    `这封开发信写给谁？在${pool ?? '候选池'}里点开那个人，点「起草」；信起好了会出一张卡等你批。`,
  ]
  if (input.found.length > 0) {
    lines.push(`${where} 上手边这几位：`)
    for (const c of input.found.slice(0, KOL_REPLY_NAMES))
      lines.push(`- ${c.name}${c.followers === undefined ? '' : `（${followersZh(c.followers)}）`}`)
  }
  return lines
}

/**
 * WP295：「哪几个真带货了」的回话——一句结论 + 一张表（点击 · 订单 · 收入）+ 没建链接的单说一句。
 *
 * 数字原样端出去（归因那一跳回填的），不在这里现算比例；没带来订单的也在表里（0 单），
 * 还没建追踪链接的合作是「算不出来」，与「0 单」分开说。
 */
export function describeAttributionReply(input: {
  channel: string
  rows: readonly { name: string; clicks: number; orders: number; revenue: number }[]
  withoutLink?: readonly string[] | undefined
}): string[] {
  const where = channelZh(input.channel)
  const sold = input.rows.filter((r) => r.orders > 0)
  const lines: string[] = []
  if (input.rows.length === 0) lines.push(`${where} 上还没有一条追踪链接，带没带货算不出来。`)
  else
    lines.push(
      sold.length === 0
        ? `${where} 上 ${input.rows.length} 条追踪链接，一单都还没带来。`
        : `${where} 上带来订单的有 ${sold.length} 个：${sold
            .slice(0, KOL_REPLY_NAMES)
            .map((r) => `${r.name}（${r.orders} 单）`)
            .join('、')}。`,
    )
  if (input.rows.length > 0) {
    lines.push('', '| 红人 | 点击 | 订单 | 收入 |', '|---|---|---|---|')
    for (const r of input.rows.slice(0, 10))
      lines.push(
        `| ${r.name.replace(/\|/g, '/')} | ${r.clicks.toLocaleString('en-US')} | ${r.orders.toLocaleString('en-US')} | ${r.revenue.toLocaleString('en-US', { maximumFractionDigits: 2 })} |`,
      )
    lines.push('')
  }
  const missing = input.withoutLink ?? []
  if (missing.length > 0)
    lines.push(
      `还没建追踪链接、算不出来的：${missing.slice(0, KOL_REPLY_NAMES).join('、')}${missing.length > KOL_REPLY_NAMES ? ` 等 ${missing.length} 个` : ''}。在合作线程里点开那个人就能建一条。`,
    )
  return lines
}

/**
 * WP295：「审一条稿」没点名哪一条——列出待审的（是谁 · 什么 · 哪天交 · 链接），说清去哪儿审。
 * 以前回「看交付物：2 条」。
 */
export function describePendingReviewReply(input: {
  channel: string
  rows: readonly { name: string; kind: string; due_at?: string; url?: string }[]
  links?: KolReplyLinks | undefined
}): string[] {
  const where = channelZh(input.channel)
  if (input.rows.length === 0) return [`${where} 上现在没有待审的交付物。`]
  const lines = [`${where} 上有 ${input.rows.length} 条交付物等你审：`, '']
  lines.push('| 红人 | 形态 | 交稿 | 链接 |', '|---|---|---|---|')
  for (const r of input.rows.slice(0, 10))
    lines.push(
      `| ${r.name.replace(/\|/g, '/')} | ${KIND_ZH[r.kind] ?? r.kind} | ${r.due_at?.slice(0, 10) ?? '—'} | ${r.url === undefined ? '还没给' : `[看一眼](${r.url})`} |`,
    )
  const threads = link('合作线程', input.links?.threads)
  lines.push(
    '',
    `在${threads ?? '合作线程'}里点开那一条：广告标识、禁用词、链接与折扣码逐条对，选通过 / 要改 / 不合格，结论出一张卡等你批。`,
  )
  return lines
}

const KIND_ZH: Readonly<Record<string, string>> = {
  video: '视频',
  post: '帖子',
  story: '快拍',
  reel: 'Reels',
  thread: '长帖',
  live: '直播',
}

/** 渠道 id → 名字（`youtube` → `YouTube`）。认不出原样给。 */
function channelZh(channel: string): string {
  return KOL_CHANNELS.find((c) => c.id === channel)?.zh ?? channel
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
