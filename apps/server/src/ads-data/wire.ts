/**
 * WP315：看数据接进服务进程的几段胶水（`server.ts` 只调这里，自己不写业务）。
 *
 * - 邮箱备用的取信口（读消息库里最近的来信头与附件，附件字节走受控原始材料区）；
 * - 建「工坊日报」那张 L3 告知卡（`policy_change` + `form: 'ads_report_setup'`，自动放行、只通知：
 *   与 `org.ts` 范围变了那张同一个做法）；
 * - 第一次有数之后给投放岗种的那条日报定时：一件「广告日报」事项 + 一条官方「自动化任务」。
 *   **提示词就是默认的日报要求**——用户在那件事里说一句，AI 用官方工具改（时间、内容、停掉）。
 */

import type { MessageStore } from '@agentsws/channels'
import type {
  ApprovalItem,
  Assignment,
  CreateApprovalInput,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import type { AutomationAssembly } from '../automation.js'
import type { AdsMail, AdsMailSource } from './service.js'
import type { AdsDataPlatform } from './store.js'

/** 告知卡的 `form`（卡面按通用「策略」骨架画，标题与摘要就是内容）。 */
export const ADS_REPORT_SETUP_FORM = 'ads_report_setup'

/** 日报默认几点出（导出默认 9 点后，留一小时给插件）。 */
export const ADS_DAILY_REPORT_TIME = '10:00:00'
export const ADS_DAILY_REPORT_TITLE = '广告日报'

/**
 * 默认的日报要求（种定时用；之后以用户在那件事里说的为准）。只说要看什么，不规定格式。
 */
export const ADS_DAILY_REPORT_PROMPT = [
  '出一份广告日报。用 query_ads_data 取数（默认看昨天整天，和前一天比；今天到现在的花费单列），写清：',
  '1. 花了多少、带回多少（转化、转化价值、ROAS），分平台；',
  '2. 哪几条表现差（花得多、ROAS 低），列出来；',
  '3. 今天离日花费总闸还有多少；',
  '4. 止损：数据一到工坊已经按判据自动判过（按昨天整天、今天到现在各判一次），越线的已出止损卡；这里列出停了哪几条，差一条判据的说差在哪。',
  '数据没到就照实说哪家没到、为什么。用 publish_report 发布，系列名「广告日报」。',
].join('\n')

/** 消息库 → 邮箱备用的取信口。 */
export function adsMailSourceOf(options: {
  store(): MessageStore | undefined
  attachment(message_id: string, attachment_id: string): Promise<{ bytes: Uint8Array } | undefined>
}): AdsMailSource {
  return {
    async recent(since) {
      const store = options.store()
      if (store === undefined) return []
      const list = await store.list({ limit: 200 })
      return list
        .filter((m) => m.date >= since)
        .map(
          (m): AdsMail => ({
            id: m.id,
            from: m.from.email,
            subject: m.subject,
            date: m.date,
            attachments: m.attachments
              .filter((a) => a.inline !== true)
              .map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size })),
          }),
        )
    },
    async attachment(message_id, attachment_id) {
      return (await options.attachment(message_id, attachment_id))?.bytes
    },
  }
}

const ZH: Record<AdsDataPlatform, string> = { google: 'Google', meta: 'Meta' }

/** 建「工坊日报」的 L3 告知卡（自动放行、只通知）。回卡的编号。 */
export async function adsReportSetupNotice(options: {
  approvals: { create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>> }
  workspace_id: WorkspaceId
  holder: Assignment | undefined
  platform: AdsDataPlatform
  title: string
  summary: string
}): Promise<string | undefined> {
  const holder = options.holder
  if (holder === undefined) return undefined
  const item = await options.approvals.create({
    workspace_id: options.workspace_id,
    schema_version: 1,
    kind: 'policy_change',
    role_id: holder.role_id,
    subject: { object: { type: 'ad_account', id: `ads_report_setup:${options.platform}` } },
    dedupe_key: `${options.workspace_id}:ads_report_setup:${options.platform}`,
    title: options.title,
    summary: options.summary,
    payload: { form: ADS_REPORT_SETUP_FORM, platform: ZH[options.platform] },
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: { kind: 'system', id: 'ads.data' },
    // L3：默认放行、只通知（docs/101 §5.3「建保存报表 L3 告知」）
    automation: {
      level_at_creation: 'L3',
      auto_approved: true,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: holder.person_id as PersonId, via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'digest',
  } as CreateApprovalInput<Record<string, unknown>>)
  return item.id
}

/** 第一次有数之后：开一件「广告日报」事项，在里面种一条每天 10 点的官方定时。 */
export async function seedAdsDailyReport(options: {
  workspace_id: WorkspaceId
  holder: Assignment | undefined
  createMatter(input: {
    kind: 'project'
    title: string
    entry: 'role'
    role_id: string
    position_id: string
    participants: string[]
  }): { id: string }
  automation: Pick<AutomationAssembly, 'seed'>
}): Promise<{ task_id?: string; matter_id: string } | undefined> {
  const holder = options.holder
  if (holder === undefined) return undefined
  const matter = options.createMatter({
    kind: 'project',
    title: ADS_DAILY_REPORT_TITLE,
    entry: 'role',
    role_id: holder.role_id,
    position_id: holder.id,
    participants: [holder.person_id],
  })
  const task_id = await options.automation.seed({
    workspace_id: options.workspace_id,
    person_id: holder.person_id,
    role_id: holder.role_id,
    assignment_id: holder.id,
    matter_id: matter.id,
    title: ADS_DAILY_REPORT_TITLE,
    prompt: ADS_DAILY_REPORT_PROMPT,
    selector: { daily: { time: ADS_DAILY_REPORT_TIME } } as never,
  })
  return { matter_id: matter.id, ...(task_id === undefined ? {} : { task_id }) }
}
