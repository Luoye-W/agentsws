/**
 * WP386：信息监控（`pr.monitoring`）的读工具 `list_mentions`——给模型看的名字、描述、参数。
 * 真正干活在服务端（`apps/server/src/pr-watch/tools.ts`）。
 *
 * 按组（自家 / 竞品 / 行业 / 指定网站）、竞品、来源、情绪、时间窗查提及库；同时带回各条监控源的状态——
 * 拉不到的源照实列出来，**不当成 0 条**。
 */
import type { ToolDef } from '@agentsws/contracts'

export const LIST_MENTIONS_TOOL = 'list_mentions'

export const PR_MONITOR_TOOL_NAMES: readonly string[] = [LIST_MENTIONS_TOOL]

export const PR_MONITOR_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: LIST_MENTIONS_TOOL,
    description:
      '查信息监控入库的提及（新闻、博客、论坛、Reddit…），可按组、竞品、来源、情绪、时间窗筛；同一条被多处转载已合并，seen_count 是被转了几次。结果里 sources 是各条监控源的状态：status 为 failed 的那几条这次没拉到，要照实告诉对方「没拉到」，不能说成没有提及。还没配监控源时会弹出配置卡',
    input_schema: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          enum: ['own', 'competitor', 'industry', 'site'],
          description:
            'own 自家 / competitor 竞品 / industry 行业品类 / site 指定网站；不给 = 全部',
        },
        competitor: { type: 'string', description: '只看说这个竞品的（名字）' },
        source: {
          type: 'string',
          description: '只看这条监控源来的：源的名字（如 Super73）或 id；reddit = Reddit 那一路',
        },
        sentiment: { type: 'string', enum: ['negative', 'neutral', 'positive'] },
        days: { type: 'integer', description: '最近几天（默认 7）' },
        since: { type: 'string', description: '起：ISO 时间（给了就不看 days）' },
        until: { type: 'string', description: '止：ISO 时间' },
        limit: { type: 'integer', description: '最多几条（默认 30，最多 100）' },
      },
    },
  },
]

export const PR_MONITOR_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  PR_MONITOR_TOOL_DEFS.map((d) => [d.name, d]),
)
