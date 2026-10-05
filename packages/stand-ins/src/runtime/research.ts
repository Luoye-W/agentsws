/**
 * WP220（Luoye 10-05）：**读 Reddit** 这一个只读工具——研究技能（`trend-research` / `social-research`）
 * 在 Reddit 那一块取数只走它。名字与给模型看的描述在这里，真去取数在服务端
 * （`apps/server/src/research-tools.ts` → `@agentsws/social-core` 的 Reddit 两路路由）。
 *
 * 挂在哪：职责 yml 的 `grounding` 里写 `tool: read_reddit` 的那几条（`pr.monitoring`、`pr.reddit`、
 * `pr.forums`、`social.reddit`）——grounding 的工具名本来就进这次运行的工具白名单。
 *
 * `read_` 开头：门禁按「只读外部」放行（`classifySideEffect` 的前缀表）。它不发帖、不回帖。
 */
import type { ToolDef } from '@agentsws/contracts'

export const READ_REDDIT_TOOL = 'read_reddit'

export const RESEARCH_TOOL_NAMES: readonly string[] = [READ_REDDIT_TOOL]

/**
 * WP236：不给 `limit` 时取几条。原来不给就走接口中台的缺省（25 条）——10-06 真机一次「看一眼」
 * 五次搜索花了约 6.7 积分。先少取、看清了再加大。
 */
export const READ_REDDIT_DEFAULT_LIMIT = 10

/**
 * WP237（#67，Fable 定）：「多少积分一条」**每次运行按价目表现填**，不写死在描述里——
 * 价目表只放云上（docs/83 §2），改了价描述跟着变；取不到价就不写数，只说「按条计积分」。
 * `price` 是每条多少积分（`RunRequest.tool_prices.read_reddit`）。
 */
export function readRedditDescription(price?: number): string {
  const cost =
    price === undefined || !Number.isFinite(price) || price <= 0
      ? `走接口中台按条计积分（不填 limit 就取 ${READ_REDDIT_DEFAULT_LIMIT} 条）`
      : `走接口中台按条计积分（现价约 ${fmtCredits(price)} 积分一条；不填 limit 就取 ${READ_REDDIT_DEFAULT_LIMIT} 条，约 ${fmtCredits(price * READ_REDDIT_DEFAULT_LIMIT)} 积分）`
  return (
    '只读 Reddit：按关键词搜帖子（action=search）、读一个版最近的帖子（posts）、读一条帖子和它的评论（comments）。' +
    'action 可以不填：给了 query 就是 search，给了 subreddit 就是 posts，给了 post_url 就是 comments。' +
    `${cost}——先少取，看清了再按需加大；` +
    '同一个问题换词搜别超过 3 次，这次运行的取数预算快用完时会提醒你收尾。' +
    '走这个品牌设置的 Reddit 取数路由（接口中台 → 浏览器只读），每条带链接与时间，另附一条「从哪一路取的、命中缓存没有」。' +
    '两路都没取到会照实说原因——那不是「0 条」。不发帖、不回帖、不点赞。'
  )
}

/** 积分数写成人看的样子（最多两位小数，去掉尾巴上的 0）。 */
function fmtCredits(n: number): string {
  return String(Math.round(n * 100) / 100)
}

function readRedditDef(price?: number): ToolDef {
  return {
    name: READ_REDDIT_TOOL,
    description: readRedditDescription(price),
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'posts', 'comments'],
          description: '可不填：有 query → search，有 subreddit → posts，有 post_url → comments',
        },
        query: { type: 'string', description: '搜什么（search 必填）' },
        subreddit: {
          type: 'string',
          description: '版名，不带 r/（posts 必填；search 不填 = 全站）',
        },
        time_window: { type: 'string', enum: ['day', 'week', 'month', 'year', 'all'] },
        sort: { type: 'string' },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: `取几条，缺省 ${READ_REDDIT_DEFAULT_LIMIT}；按条计积分，先少取`,
        },
        post_url: { type: 'string', description: '帖子地址（comments 必填）' },
      },
    },
  }
}

/** 没有价目时的那一份（只说「按条计积分」，不写数）。 */
export const RESEARCH_TOOL_DEFS: readonly ToolDef[] = [readRedditDef()]

/**
 * WP237：这次运行给模型看的研究工具定义——单价从 `RunRequest.tool_prices` 现填。
 * 不是研究工具回 `undefined`。
 */
export function researchToolDef(
  name: string,
  prices?: Readonly<Record<string, number>>,
): ToolDef | undefined {
  if (name !== READ_REDDIT_TOOL) return undefined
  return readRedditDef(prices?.[READ_REDDIT_TOOL])
}

export const RESEARCH_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  RESEARCH_TOOL_DEFS.map((d) => [d.name, d]),
)
