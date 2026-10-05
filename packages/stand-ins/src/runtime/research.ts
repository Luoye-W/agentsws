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

export const RESEARCH_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: READ_REDDIT_TOOL,
    description:
      '只读 Reddit：按关键词搜帖子（action=search）、读一个版最近的帖子（posts）、读一条帖子和它的评论（comments）。' +
      '走这个品牌设置的 Reddit 取数路由（接口中台 → 浏览器只读），每条带链接与时间，另附一条「从哪一路取的、命中缓存没有」。' +
      '两路都没取到会照实说原因——那不是「0 条」。不发帖、不回帖、不点赞。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'posts', 'comments'] },
        query: { type: 'string', description: '搜什么（search 必填）' },
        subreddit: {
          type: 'string',
          description: '版名，不带 r/（posts 必填；search 不填 = 全站）',
        },
        time_window: { type: 'string', enum: ['day', 'week', 'month', 'year', 'all'] },
        sort: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100 },
        post_url: { type: 'string', description: '帖子地址（comments 必填）' },
      },
      required: ['action'],
    },
  },
]

export const RESEARCH_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  RESEARCH_TOOL_DEFS.map((d) => [d.name, d]),
)
