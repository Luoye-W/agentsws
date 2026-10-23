/**
 * 教程上官网（私有 docs/113 §5，Luoye 10-22 定）：工坊 AI 的「查工坊帮助」——给模型看的名字、描述、参数，
 * 回来的数据形状。真正干活在服务端（`apps/server/src/workshop-help-tool.ts`），搜的是本机帮助库
 * （官网拉回来存在本机的教程、工坊笔记、更新日志 + 安装包自带的教程）。
 *
 * 助理和所有岗位都有。三条纪律：
 * 1. **只在本机搜**：问题一个字都不发到官网；
 * 2. **只读**：不出卡、不碰任何业务数据；
 * 3. 查不到就照实说，回答带官网链接，不编功能、按钮、价格。
 */
import type { ToolDef } from '@agentsws/contracts'

export const SEARCH_WORKSHOP_HELP_TOOL = 'search_workshop_help'

/** 一个工具（`tools.allow` 要字节稳定）。 */
export const WORKSHOP_HELP_TOOL_NAMES: readonly string[] = [SEARCH_WORKSHOP_HELP_TOOL]

export const WORKSHOP_HELP_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: SEARCH_WORKSHOP_HELP_TOOL,
    description:
      '用户问的是 Agents 工坊本身的事——某个功能怎么用、在哪里点、怎么连某个平台或模型、要不要钱、' +
      '为什么这样设计、最近更新了什么——先调它，在工坊的教程、工坊笔记和更新日志里查（只在这台电脑上查，问题不会发出去）。' +
      '照查到的回答：先给答案，再说步骤；末尾附上查到的那篇的链接（url）。' +
      '查不到就照实说「教程里没找到」，不要编功能、按钮、菜单或价格。' +
      '回来的某篇 needs_newer_app 为 true：告诉用户这是新版才有的，更新后就能用。' +
      'query 写一句要查的话（把用户的问题归纳成功能 / 操作的说法），不要带店名、客户名、订单号、邮箱这类业务信息。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的一句话（功能 / 操作的说法，不带业务信息）' },
        kind: {
          type: 'string',
          enum: ['any', 'guide', 'note', 'changelog'],
          description: '只查哪一种：教程 guide / 工坊笔记 note / 更新日志 changelog；不给 = 都查',
        },
      },
      required: ['query'],
    },
  },
]

export const WORKSHOP_HELP_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  WORKSHOP_HELP_TOOL_DEFS.map((d) => [d.name, d]),
)

/** 查到的一篇（服务端白名单出参）。 */
export interface WorkshopHelpHit {
  kind: 'guide' | 'note' | 'changelog'
  title: string
  /** 官网上那一篇（安装包自带、官网还没有的没有）。 */
  url?: string
  description: string
  /** 最相关的那一节的标题与原文（截短）。 */
  section?: string
  excerpt: string
  needs_newer_app: boolean
  requires?: string
}

export interface WorkshopHelpResult {
  query: string
  results: WorkshopHelpHit[]
  /** 一句人话结论（查不到时说怎么办）。 */
  message: string
}
