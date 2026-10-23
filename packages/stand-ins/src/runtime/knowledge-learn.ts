/**
 * WP488（决策 1680 / 1681）：客服岗位「学一遍」的工具 `learn_support_knowledge`——给模型看的名字、描述、参数。
 * 真正干活在服务端（`apps/server/src/knowledge-learn-tools.ts` → `knowledge-learn.ts`）。
 *
 * 用户在对话里说一句「从过往邮件学一下」「售后站是 help.example.com，学一下」，模型调它：开一件「学一遍」的事，
 * 后台跑（有进度），学到的一律待确认、出一张汇总卡。没接邮箱 → 工具回 `needs_connection:imap_smtp`，运行就地出连接卡。
 *
 * 纪律：不直接改知识库（只写待确认的条目 + 一张卡），不发信、不改网站。
 */
import type { ToolDef } from '@agentsws/contracts'

export const LEARN_SUPPORT_KNOWLEDGE_TOOL = 'learn_support_knowledge'

/** 一个工具（`tools.allow` 要字节稳定）。 */
export const KNOWLEDGE_LEARN_TOOL_NAMES: readonly string[] = [LEARN_SUPPORT_KNOWLEDGE_TOOL]

/** 客服那几条职责（邮件客服、亚马逊客服、在线客服）。 */
export function isKnowledgeLearnRole(role_id: string): boolean {
  return role_id === 'dtc.support' || role_id === 'amz.support' || role_id === 'dtc.live-chat'
}

export const KNOWLEDGE_LEARN_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: LEARN_SUPPORT_KNOWLEDGE_TOOL,
    description:
      '让客服知识库「学一遍」：source=email 从已接邮箱的过往往来里学（默认回看 12 个月，用户说了别的月数就填 months）；' +
      'source=website 从官网 / 售后（帮助中心）网站学（用户给了网址就填 urls，不给就用品牌建档时的官网）。' +
      '后台跑：开一件事（有进度），学到的都是待确认的，最后出一张「学到 N 条」的卡让用户确认、改范围（公共 / 售前 / 售后）。' +
      '回来的是开跑结果，不是学到的内容——照实说「开始学了，学完会出一张卡给你确认」；' +
      '回 needs_connection 就是还没接邮箱（卡会自己出来），不要编；over_budget 是模型用量快到上限。',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['email', 'website'], description: '从哪儿学' },
        months: { type: 'number', description: '邮件：回看几个月（1–36，默认 12）' },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: '网站：官网 / 售后网站的网址（最多 5 个）',
        },
      },
      required: ['source'],
    },
  },
]

export const KNOWLEDGE_LEARN_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  KNOWLEDGE_LEARN_TOOL_DEFS.map((d) => [d.name, d]),
)
