/**
 * WP398（docs/106 §5.6 / §13 A8）：**Amazon 词库**的三个工具——给模型看的名字、描述、参数。
 * 真正干活在服务端（`apps/server/src/amazon-keywords/tools.ts`）。只给「亚马逊店铺运营」（`amz.store`）。
 *
 * | 工具 | 干什么 |
 * |---|---|
 * | `read_amazon_keywords` | 刷新词库：读 Amazon 前台搜索框联想词（内置浏览器，自报 Agent 身份；被拦就停）+ 拆竞品 / 自家 Listing 的标题五点 + 算差距 |
 * | `get_amazon_keywords` | 看词库（不读页面）：总数、差距词（按竞品出现次数排）、可按来源 / 标记筛的词表 |
 * | `mark_amazon_keyword` | 标一个词：核心 / 不要 / 已埋进 Listing；或者自己加一个词（只动本机） |
 *
 * 一期没有搜索量：差距词按「出现在几家竞品里」排，回答里照实说。只出建议，不写 Amazon。
 */
import type { ToolDef } from '@agentsws/contracts'

export const READ_AMAZON_KEYWORDS_TOOL = 'read_amazon_keywords'
export const GET_AMAZON_KEYWORDS_TOOL = 'get_amazon_keywords'
export const MARK_AMAZON_KEYWORD_TOOL = 'mark_amazon_keyword'

/** 第三栏词表的地址（回答里放一个 `open:` 按钮）。 */
export const AMAZON_KEYWORDS_ADDRESS = 'agentsws://amazon-keywords/all'

/** 三个工具（排好序：`tools.allow` 要字节稳定）。 */
export const AMAZON_KEYWORD_TOOL_NAMES: readonly string[] = [
  GET_AMAZON_KEYWORDS_TOOL,
  MARK_AMAZON_KEYWORD_TOOL,
  READ_AMAZON_KEYWORDS_TOOL,
].sort()

/** 只有「亚马逊店铺运营」才有。 */
export function isAmazonKeywordRole(role_id: string): boolean {
  return role_id === 'amz.store'
}

const SOURCES = ['autocomplete', 'competitor_listing', 'own_listing', 'user']
const MARKS = ['core', 'exclude', 'in_listing']

export const AMAZON_KEYWORD_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: READ_AMAZON_KEYWORDS_TOOL,
    description:
      '刷新 Amazon 词库（用户说「帮我看看关键词」「词库更新一下」时先用 get_amazon_keywords 看有没有，没有或要新的再用这个）：' +
      '用内置浏览器读 Amazon 前台搜索框联想词（一个种子词本身 + 后面接 a–z，一批最多 27 页，算进内置浏览器每小时的额度），' +
      '再把竞品和自家 Listing 的标题 / 五点拆成词组，算出每个自家 ASIN「竞品有、你没有」的差距词。' +
      'seeds 给英文品类词（品牌档案的品类是中文时你翻成 Amazon 上的说法，如 portable power station）；不给就用自家商品标题的核心词。' +
      'autocomplete.status=blocked 是 Amazon 出了验证页、这一轮停了，照实说，不要重试、不要换办法绕；quota 是这一小时额度满了；' +
      'unavailable 是这里没有内置浏览器。一期没有搜索量，不要估任何数字。只出建议，不改 Amazon 上任何东西。',
    input_schema: {
      type: 'object',
      properties: {
        seeds: {
          type: 'array',
          items: { type: 'string' },
          description: '种子词（英文品类词），第一个这次就读；会记下来下次接着用',
        },
        marketplace: { type: 'string', description: '站点国家码，如 US；不给 = 自家商品所在站点' },
        autocomplete: {
          type: 'boolean',
          description: 'false = 只拆 Listing、不读联想词（默认读）',
        },
      },
    },
  },
  {
    name: GET_AMAZON_KEYWORDS_TOOL,
    description:
      '看 Amazon 词库（不打开页面）：多少个词、几个差距词、最近一次更新，每个自家 ASIN 的差距词（按出现在几家竞品里排），' +
      '和一张可筛的词表（source 来源 / mark 标记 / gap 只看差距词 / other_brand 只看含他牌名的）。' +
      '回答时：差距词照 competitors 说「几家竞品在用」，写明 sort_note（没有搜索量，按竞品里出现的次数排）；' +
      'other_brand 的词要提醒「含别家品牌名，不能填进后台关键词」。完整词表在第三栏：' +
      `回答里放一个按钮，action 写 open:${AMAZON_KEYWORDS_ADDRESS}，按钮字写「打开词表」。`,
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: SOURCES, description: '只看这个来源' },
        mark: { type: 'string', enum: MARKS, description: '只看标了这个的' },
        gap: { type: 'boolean', description: '只看差距词' },
        other_brand: { type: 'boolean', description: '只看含他牌名的' },
        asin: { type: 'string', description: '只看这个自家 ASIN 的差距词' },
        q: { type: 'string', description: '词里包含这几个字' },
        limit: { type: 'number', description: '词表最多几行（默认 30）' },
      },
    },
  },
  {
    name: MARK_AMAZON_KEYWORD_TOOL,
    description:
      '标一个词（用户说「这个是核心词」「这个不要」「这个已经写进 Listing 了」时用）：id 用词库里的 id（如 US:removable battery），' +
      '或者给 term 自己加一个词。add / remove 是标记：core 核心、exclude 不要、in_listing 已埋进 Listing（核心和不要互斥）。只动本机词库。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '词的 id' },
        term: { type: 'string', description: '没有 id 时：要加 / 要标的词' },
        marketplace: { type: 'string', description: 'term 那个词属于哪个站点（默认自家站点）' },
        add: { type: 'array', items: { type: 'string', enum: MARKS }, description: '加上的标记' },
        remove: {
          type: 'array',
          items: { type: 'string', enum: MARKS },
          description: '去掉的标记',
        },
      },
    },
  },
]

export const AMAZON_KEYWORD_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  AMAZON_KEYWORD_TOOL_DEFS.map((d) => [d.name, d]),
)
