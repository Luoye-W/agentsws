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
/**
 * WP506（决策 1796 C）：AI **提议**停用 / 启用几条知识——只出一张确认卡（中栏「要你处理」），人点了才生效。
 * 它自己停用不了：真停用 / 启用的接口只给人点。
 */
export const PROPOSE_KNOWLEDGE_TOGGLE_TOOL = 'propose_knowledge_toggle'

/** 两个工具（`tools.allow` 要字节稳定）。 */
export const KNOWLEDGE_LEARN_TOOL_NAMES: readonly string[] = [
  LEARN_SUPPORT_KNOWLEDGE_TOOL,
  PROPOSE_KNOWLEDGE_TOGGLE_TOOL,
]

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
  {
    name: PROPOSE_KNOWLEDGE_TOGGLE_TOOL,
    description:
      '提议停用（或启用回来）知识库里的几条知识：action=disable 停用（停用的回复和起草都不再用它，不删，随时能启用回来）、' +
      'action=enable 启用回来。用户说「这条过时了别再用」「把旧运费那几条停掉」「把停用的保修那条恢复」时用。' +
      '用 query 给一个关键词（按正文 / 主题找，最多 20 条）或用 ids 给知识 id；reason 写一句为什么（卡上给人看）。' +
      '**你自己停用不了**：这个工具只在「要你处理」里出一张确认卡，列出是哪几条、你的理由，用户点了才真停用 / 启用。' +
      '回来的是出没出卡、几条；照实说「出了一张卡，你点了才生效」。一条都没找到就说没找到，不要编。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['disable', 'enable'], description: '停用还是启用回来' },
        query: { type: 'string', description: '按正文 / 主题找的关键词' },
        ids: { type: 'array', items: { type: 'string' }, description: '知识 id（最多 20 个）' },
        reason: { type: 'string', description: '一句话：为什么要停用 / 启用' },
      },
      required: ['action', 'reason'],
    },
  },
]

export const KNOWLEDGE_LEARN_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  KNOWLEDGE_LEARN_TOOL_DEFS.map((d) => [d.name, d]),
)
