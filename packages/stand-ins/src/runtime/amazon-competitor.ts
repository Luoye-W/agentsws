/**
 * WP394（docs/104 一期 B，docs/106 §13）：亚马逊店铺运营「竞品动向」的工具——给模型看的名字、描述、参数。
 * 真正干活在服务端（`apps/server/src/competitor-watch/amazon-tools.ts`）。只给亚马逊店铺运营（`amz.store`）。
 *
 * | 工具 | 干什么 |
 * |---|---|
 * | `read_amazon_competitors` | 现在读一次 Amazon 对标款（和上一次比出改价 / 打折 / 断货 / 评分 / 评论数 / 排名）；还没配好就回「先出方案卡」 |
 *
 * 查变化表用 WP392 的 `list_competitor_changes`；配「盯哪些 ASIN、各对标谁、什么算重要」用 `request_setup`
 * （设置目标 `amazon.competitor_watch`）。只读 Amazon 前台公开页面，不登录、不出审批卡。
 */
import type { ToolDef } from '@agentsws/contracts'

export const READ_AMAZON_COMPETITORS_TOOL = 'read_amazon_competitors'

/** 这一组（排好序：`tools.allow` 要字节稳定）。 */
export const AMAZON_COMPETITOR_TOOL_NAMES: readonly string[] = [READ_AMAZON_COMPETITORS_TOOL]

/** 只给这几条职责（docs/104 C2 / docs/106 A1：竞品对标在亚马逊店铺运营「Listing 与关键词」那一块）。 */
export const AMAZON_COMPETITOR_ROLES: readonly string[] = ['amz.store']

/** 方案卡的设置目标 id（与 `@agentsws/contracts` 的 `AMAZON_COMPETITOR_TARGET` 一致）。 */
export const AMAZON_COMPETITOR_SETTING = 'amazon.competitor_watch'

export const AMAZON_COMPETITOR_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: READ_AMAZON_COMPETITORS_TOOL,
    description:
      '现在读一次竞品在 Amazon 上的对标款（工坊内置浏览器读前台商品页；被 Amazon 拦了就停、改走工坊云端数据并按个扣积分），' +
      '和上一次比出改价 / 打折 / 断货 / 评分 / 评论数 / 排名的变化（第一次只建底子），带「比你的 X 便宜 $N」。' +
      '回这一次的变化、哪几条按用户确认的规则算重要、哪家没读到、走了哪条路、扣了多少积分（要照实告诉对方）。' +
      '还没配好盯哪些 ASIN 时回 needs_setup（运行时会出方案卡）。只读公开页面，不登录、不改店里任何东西。',
    input_schema: {
      type: 'object',
      properties: {
        competitor: {
          type: 'string',
          description: '只读这一家（竞品名或 id；不给 = 全部，含自家对照款）',
        },
      },
    },
  },
]

export const AMAZON_COMPETITOR_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  AMAZON_COMPETITOR_TOOL_DEFS.map((d) => [d.name, d]),
)

/** stub 的岔口：「帮我盯 Amazon 上的竞品」这类话（Amazon / 亚马逊 + 盯 / 监控 + 竞品 / 对标）→ 要方案卡。 */
export const AMAZON_COMPETITOR_ASK = /(?:盯|监控|看着|跟踪)/
export const AMAZON_COMPETITOR_WORDS = /竞品|对手|对标/
export const AMAZON_COMPETITOR_SITE = /amazon|亚马逊/i
