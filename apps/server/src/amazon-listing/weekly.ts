/**
 * WP420（自查 ads-amazon B4 / B9）：Listing 体检与词库**自己会跑**。
 *
 * 以前：面板标题叫「每日巡检」，体检却只有「手动 / 工具」两种触发；词库也不会自己更新。现在照广告日报的做法：
 * 有人担「亚马逊店铺运营」就种一条官方「自动化任务」（每周一 10:30，品牌时区），挂在一件「Amazon 每周体检」事项上——
 * 提示词就是默认要求：体检一次自家 Listing、刷新一次词库、把要紧的几处说给人。
 * 用户在那件事里说一句就能改时间、改内容、停掉（WP331 那一套），不是固定功能。
 *
 * 只种一次（记在竞品监控那张小表的 kv 里）；没人担、托管实例（没有自动化）都不种，下一拍再试。
 */
import type { Assignment, WorkspaceId } from '@agentsws/contracts'
import type { AutomationAssembly } from '../automation.js'

export const AMAZON_WEEKLY_TITLE = 'Amazon 每周体检'
/** 每周几、几点（ISO 星期：1 = 周一）。 */
export const AMAZON_WEEKLY_SELECTOR = { weekly: { time: '10:30:00', weekdays: [1] } } as const
export const AMAZON_WEEKLY_KV = 'amazon_weekly_seeded'

export const AMAZON_WEEKLY_PROMPT = [
  '每周一次的 Amazon 体检：',
  '1. 用 read_amazon_listings 体检一次自家 Listing（没设自家 ASIN 就先出那张方案卡）；',
  '2. 用 read_amazon_keywords 刷新一次词库，看有没有新的差距词；',
  '3. 把影响能不能买、能不能被搜到的那几处先说，每处写清是哪条规矩；没读到的照实说为什么（被 Amazon 拦了、额度满了）。',
].join('\n')

export interface AmazonWeeklyDeps {
  workspace_id: WorkspaceId
  holder(): Assignment | undefined
  createMatter(input: {
    kind: 'project'
    title: string
    entry: 'role'
    role_id: string
    position_id: string
    participants: string[]
  }): { id: string }
  automation: Pick<AutomationAssembly, 'seed'>
  kv: { get(): unknown; set(v: unknown): void }
  now(): string
}

/** 种一次（种过 / 没人担 / 种不上回 `undefined`）。 */
export async function seedAmazonWeekly(
  deps: AmazonWeeklyDeps,
): Promise<{ matter_id: string; task_id?: string } | undefined> {
  if (deps.kv.get() !== undefined && deps.kv.get() !== null) return undefined
  const holder = deps.holder()
  if (holder === undefined) return undefined
  const matter = deps.createMatter({
    kind: 'project',
    title: AMAZON_WEEKLY_TITLE,
    entry: 'role',
    role_id: holder.role_id,
    position_id: holder.id,
    participants: [holder.person_id],
  })
  const task_id = await deps.automation.seed({
    workspace_id: deps.workspace_id,
    person_id: holder.person_id,
    role_id: holder.role_id,
    assignment_id: holder.id,
    matter_id: matter.id,
    title: AMAZON_WEEKLY_TITLE,
    prompt: AMAZON_WEEKLY_PROMPT,
    selector: AMAZON_WEEKLY_SELECTOR as never,
  })
  // 种不上（自动化没开）也记下：不然每一拍都多开一件空事项
  deps.kv.set({
    matter_id: matter.id,
    ...(task_id === undefined ? {} : { task_id }),
    at: deps.now(),
  })
  return { matter_id: matter.id, ...(task_id === undefined ? {} : { task_id }) }
}
