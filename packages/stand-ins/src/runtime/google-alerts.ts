/**
 * WP387（docs/103 v2 §3.3）：浏览器建完 / 读完 Google 提醒后**交代结果**的那个工具 `report_google_alerts`——
 * 给模型看的名字、描述、参数。真正干活在服务端（`apps/server/src/pr-alerts/`）：认 change_id 是不是一趟
 * 同意过、还在跑的；只认卡上的行；读回的必须是 RSS 链接；存成监控源并先拉一次；没建成的列出来退回手动。
 *
 * 只有信息监控这条职责、服务端接了才有它。
 */
import type { ToolDef } from '@agentsws/contracts'

export const REPORT_GOOGLE_ALERTS_TOOL = 'report_google_alerts'

/** 一个工具（`tools.allow` 要字节稳定）。 */
export const GOOGLE_ALERTS_TOOL_NAMES: readonly string[] = [REPORT_GOOGLE_ALERTS_TOOL]

export const GOOGLE_ALERTS_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: REPORT_GOOGLE_ALERTS_TOOL,
    description:
      '在用户的浏览器里建完 / 改完 / 读完 Google 提醒之后调一次，交代结果（照技能「google-alerts」的「交代结果」那一段填）。' +
      '建 / 改那一趟：change_id 填任务说明里给的那个，lines 里卡上每一行一条（id 用卡上的行号）。' +
      '只读一遍已有提醒那一趟：change_id 不填，读到的放进 existing。' +
      '工具回来的那段话原样转述给用户，不要自己说「全部成功」。',
    input_schema: {
      type: 'object',
      properties: {
        change_id: { type: 'string', description: '同意过的那张卡对应的改动号（只读那一趟不填）' },
        lines: {
          type: 'array',
          description: '卡上每一行的结局',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '卡上的行号（ga_1…）' },
              outcome: {
                type: 'string',
                description: 'created / existing / switched / existing_email / failed / not_attempted',
              },
              feed_url: { type: 'string', description: '读回的 RSS 链接（google.com/alerts/feeds/…）' },
              reason: { type: 'string', description: '没成 / 没轮到时的一句原因' },
            },
            required: ['id', 'outcome'],
          },
        },
        existing: {
          type: 'array',
          description: '读到的账号里已有的提醒（可选）',
          items: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '查询语句（原样）' },
              delivery: { type: 'string', description: 'rss / email / unknown' },
              feed_url: { type: 'string', description: 'RSS 投递才有' },
              language: { type: 'string', description: '语言（看得到才填）' },
              region: { type: 'string', description: '地区（看得到才填）' },
            },
            required: ['query', 'delivery'],
          },
        },
        stop: {
          type: 'string',
          description: 'done / not_signed_in / captcha / page_changed / other',
        },
        note: { type: 'string', description: '停下时的一句人话（哪一步对不上）' },
      },
      required: ['stop'],
    },
  },
]

export const GOOGLE_ALERTS_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  GOOGLE_ALERTS_TOOL_DEFS.map((d) => [d.name, d]),
)

/** 工具回的数据（服务端白名单出参；没有任何一条 feed 的完整地址）。 */
export interface GoogleAlertsToolData {
  ok: boolean
  /** 建好 / 已有 / 改成 RSS 的条数。 */
  done?: number
  /** 没成的条数（退回手动贴链接）。 */
  failed?: number
  /** 账号里已有、还在发邮件、另出一张卡的条数。 */
  email?: number
  /** 只读那一趟：能导入的 / 邮箱投递的条数。 */
  importable?: number
  /** 给模型的那一句（原样转告用户）。 */
  message: string
}
