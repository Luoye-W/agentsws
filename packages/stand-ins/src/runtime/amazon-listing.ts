/**
 * WP396（docs/106 §13，A1 ②）：**自家 Listing 体检**的三个工具——给模型看的名字、描述、参数。
 * 真正干活在服务端（`apps/server/src/amazon-listing/tools.ts`）。只给「亚马逊店铺运营」（`amz.store`）。
 *
 * | 工具 | 干什么 |
 * |---|---|
 * | `read_amazon_listings` | 读自家 ASIN 的前台商品页（内置浏览器，自报 Agent 身份；被拦就停、不绕），按规则表逐条判，存一份结果 |
 * | `get_listing_checkup` | 看最近一次体检结果（不读页面） |
 * | `set_listing_check_rule` | 改一条规则的建议值 / 开关 / 核对日期，或记下自家店铺名（判购物车是不是你） |
 *
 * 只出建议，不写 Amazon（一期没有写动作；改 Listing 二期按 A14 出卡）。
 */
import type { ToolDef } from '@agentsws/contracts'

export const READ_AMAZON_LISTINGS_TOOL = 'read_amazon_listings'
export const GET_LISTING_CHECKUP_TOOL = 'get_listing_checkup'
export const SET_LISTING_CHECK_RULE_TOOL = 'set_listing_check_rule'

/** 三个工具（排好序：`tools.allow` 要字节稳定）。 */
export const AMAZON_LISTING_TOOL_NAMES: readonly string[] = [
  GET_LISTING_CHECKUP_TOOL,
  READ_AMAZON_LISTINGS_TOOL,
  SET_LISTING_CHECK_RULE_TOOL,
].sort()

/** 只有「亚马逊店铺运营」才有。 */
export function isAmazonListingRole(role_id: string): boolean {
  return role_id === 'amz.store'
}

export const AMAZON_LISTING_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: READ_AMAZON_LISTINGS_TOOL,
    description:
      '体检自家 Amazon Listing：用内置浏览器打开自家 ASIN 的前台商品页（每个 ASIN 一页，算进内置浏览器每小时的额度），' +
      '按规则表逐条判，回每个 ASIN 的问题：哪条规则（rule_name + source 出处）、现在是什么（now）、建议怎么改（suggestion），' +
      '文案类带 draft 草稿，图片类带 design_request（界面上有「向设计岗下需求单」按钮），rule_stale=true 的要说「这条规则可能过时」。' +
      '回答时每条问题都写上规则出处；先说影响能不能买的（severity=blocker），再说影响搜得到的（search），最后是能更好的（improve）。' +
      '评分、评论数、价格照 facts 原样写，没有的写「没读到」，不要估。human_checks 是要人看一眼的（主图白底这类），不要替人下结论。' +
      'Amazon 出验证页会停下（stopped=blocked），照实说，不要重试、不要换办法绕。' +
      '自家 ASIN 还没填会回 needs_setup，运行时出一张卡让人勾。只出建议，不改 Amazon 上任何东西。' +
      '结尾照抄 footer 那一句（前台看不到被压制、买不了的原因，不猜）。',
    input_schema: {
      type: 'object',
      properties: {
        asins: {
          type: 'array',
          items: { type: 'string' },
          description: '只体检这几个（自家清单里的 ASIN）；不给 = 全部',
        },
      },
    },
  },
  {
    name: GET_LISTING_CHECKUP_TOOL,
    description:
      '看最近一次 Listing 体检的结果（不打开页面）：摘要、每个 ASIN 的问题与草稿、和上一次比修了几处、现在用的规则表（建议值、出处、核对日期）。',
    input_schema: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: '只看这一个 ASIN' },
        rules: { type: 'boolean', description: '要不要带上整张规则表（默认不带）' },
      },
    },
  },
  {
    name: SET_LISTING_CHECK_RULE_TOOL,
    description:
      '改 Listing 体检的一条规则（用户说「标题按 150 字」「视频那条别查了」「这条规则我核过了」时用）：' +
      'rule_id 用规则表里的 id，params 只改已有的参数名；enabled 开关；checked_at 写今天（YYYY-MM-DD）= 对着出处重新核过。' +
      '或者只给 own_sellers：自家店铺名（前台「Sold by」那一格的写法），用来判购物车是不是你。只动本机设置。',
    input_schema: {
      type: 'object',
      properties: {
        rule_id: { type: 'string', description: '规则 id，如 title.max_chars' },
        params: { type: 'object', description: '要改的建议值，如 {"max_chars": 150}' },
        enabled: { type: 'boolean', description: '开 / 关这一条' },
        checked_at: { type: 'string', description: '重新核对的日期 YYYY-MM-DD' },
        own_sellers: {
          type: 'array',
          items: { type: 'string' },
          description: '自家店铺名（整份替换）',
        },
      },
    },
  },
]

export const AMAZON_LISTING_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  AMAZON_LISTING_TOOL_DEFS.map((d) => [d.name, d]),
)
