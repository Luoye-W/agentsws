/**
 * WP415（自查 R2 / R3，决策 1230）：**哪些工具名在宿主里有执行器**。
 *
 * 职责模板的 `grounding` 写着「遇到这类问题先调某个工具」，可有几个工具从来没有执行器——模型一调就是
 * `unsupported_tool`，快捷问题问了只能编（审计：`list_social_posts`、`list_design_requests`、
 * `get_brand_system`、`list_press_releases`……）。这里把执行链（`runtime.ts` 的 `executeToolRaw` 与
 * `records.ts` 的连接器工具）认得的名字收成一份，职责页据此把没有执行器的标「还没接通」。
 *
 * 只认「有没有执行器」，不认「这一次能不能跑」（店铺授权过期、插件没开这类由工具自己照实回）。
 * 加了新工具的组：把工具名常量加进下面的并集；守卫测试会盯着职责模板里的 grounding 工具。
 */
import { KOL_TOOL_NAMES } from '@agentsws/kol-core'
import {
  ADS_DATA_TOOL_NAMES,
  ADS_TOOL_NAMES,
  AMAZON_COMPETITOR_TOOL_NAMES,
  AMAZON_KEYWORD_TOOL_NAMES,
  AMAZON_LISTING_TOOL_NAMES,
  B2B_OUTBOUND_TOOL_NAMES,
  COMPETITOR_STORE_TOOL_NAMES,
  DESK_TOOL_NAMES,
  GOOGLE_ALERTS_TOOL_NAMES,
  IMAGE_TOOL_NAMES,
  MESSAGE_RULE_TOOL_NAMES,
  OWNER_TOOL_NAMES,
  PR_MONITOR_TOOL_NAMES,
  READ_SKILL_TOOL,
  READ_WEBPAGE_TOOL,
  RECORD_SINK_TOOL_NAMES,
  REPORT_TOOL_NAMES,
  RESEARCH_TOOL_NAMES,
  SCHEDULE_TOOL_NAMES,
  SETUP_REQUEST_TOOL_NAMES,
  SHOP_TOOL_NAMES,
  SITE_HEALTH_TOOL_NAMES,
  SOCIAL_WORK_TOOL_NAMES,
  THEME_TOOL_NAMES,
  toolWordZh,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WORKSHOP_HELP_TOOL_NAMES,
  WORKSHOP_SERVICE_TOOL_NAMES,
} from '@agentsws/stand-ins'
import {
  CHAT_SESSIONS_TOOL,
  COMMUNITY_THREADS_TOOL,
  POLICY_TOOL,
  SUPPORT_THREADS_TOOL,
  TOOL_ACTIONS,
} from '../records.js'

/** 宿主里有执行器的工具名（裸名）。 */
export const HOST_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(TOOL_ACTIONS),
  POLICY_TOOL,
  COMMUNITY_THREADS_TOOL,
  // WP417：客服查询类（等着回的来信 / 聊天会话），执行在 records.ts 的记录源执行器
  SUPPORT_THREADS_TOOL,
  CHAT_SESSIONS_TOOL,
  READ_SKILL_TOOL,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  READ_WEBPAGE_TOOL,
  ...KOL_TOOL_NAMES,
  ...RESEARCH_TOOL_NAMES,
  ...SCHEDULE_TOOL_NAMES,
  ...OWNER_TOOL_NAMES,
  ...B2B_OUTBOUND_TOOL_NAMES,
  ...ADS_TOOL_NAMES,
  ...THEME_TOOL_NAMES,
  ...SHOP_TOOL_NAMES,
  ...IMAGE_TOOL_NAMES,
  ...RECORD_SINK_TOOL_NAMES,
  // WP441：一句话写消息规则（转规则只出卡）
  ...MESSAGE_RULE_TOOL_NAMES,
  ...REPORT_TOOL_NAMES,
  ...PR_MONITOR_TOOL_NAMES,
  ...ADS_DATA_TOOL_NAMES,
  ...AMAZON_LISTING_TOOL_NAMES,
  ...AMAZON_KEYWORD_TOOL_NAMES,
  ...SETUP_REQUEST_TOOL_NAMES,
  ...SITE_HEALTH_TOOL_NAMES,
  ...GOOGLE_ALERTS_TOOL_NAMES,
  ...WORKSHOP_SERVICE_TOOL_NAMES,
  // 教程上官网（私有 docs/113）：查工坊帮助（只读本机帮助库）
  ...WORKSHOP_HELP_TOOL_NAMES,
  ...COMPETITOR_STORE_TOOL_NAMES,
  ...AMAZON_COMPETITOR_TOOL_NAMES,
  // WP419：社媒发帖 / Reddit 起草（查只读本机，起草只出卡）
  ...SOCIAL_WORK_TOOL_NAMES,
  // WP421：公关 / 内容与搜索 / B2B / 设计的读数与起草工具
  ...DESK_TOOL_NAMES,
])

/** `mcp__shopify__get_order` → `get_order`。 */
const bare = (name: string): string => name.split('__').pop() ?? name

export function toolWired(name: string): boolean {
  return HOST_TOOL_NAMES.has(bare(name))
}

/** 职责详情里「能查什么」那一行：工具的人话名 + 有没有执行器。 */
export function toolWiringView(name: string): {
  name: string
  label: string
  wired: boolean
} {
  const word = toolWordZh(name)
  // 人话表里没有的不说「一个工具」（职责页上一排「一个工具」没人看得懂），退回原名
  return { name, label: word === '一个工具' ? bare(name) : word, wired: toolWired(name) }
}
