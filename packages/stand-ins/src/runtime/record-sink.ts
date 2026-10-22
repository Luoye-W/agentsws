/**
 * WP323（docs/102 §5，决策 665 / 666）：**记录去处**的三个工具——给模型看的名字、描述、参数，回来的数据形状，
 * 以及 stub 运行时那一段剧本（岔口 + 说人话）。真正干活在服务端（`apps/server/src/outbound/tools.ts`）。
 *
 * 这是一项**通用能力**：用户在任何岗位说一句「以后每发一条记到这张表（链接），列是……」，AI 就用它们配好，
 * 不为任何一家表格单独做界面。去处的种类（飞书、Google Sheets、钉钉……）由服务端按链接认。
 *
 * 纪律：AI 只决定「每一列填哪个标准字段 / 固定值 / 留空，以及日期写法、截断、值替换」；值从发出记录里直接取，
 * 不经模型（docs/29）。配好之前一定出一张「定规矩」卡给人确认（带一行预览）——工具本身不直接生效。
 */
import type { RunRequest, ToolDef } from '@agentsws/contracts'

export const READ_RECORD_TARGET_TOOL = 'read_record_target'
export const PROPOSE_RECORD_SINK_TOOL = 'propose_record_sink'
export const LIST_RECORD_SINKS_TOOL = 'list_record_sinks'

/** 三个工具（排好序：`tools.allow` 要字节稳定）。 */
export const RECORD_SINK_TOOL_NAMES: readonly string[] = [
  LIST_RECORD_SINKS_TOOL,
  PROPOSE_RECORD_SINK_TOOL,
  READ_RECORD_TARGET_TOOL,
].sort()

const FIELD_HINT =
  '标准字段（只能从这里选）：sent_at 发出时间、sent_date 发出日期、channel 渠道、action 动作、destination 发到哪、' +
  'thread_title 原帖标题、thread_url 原帖链接、counterpart 对方、counterpart_text 对方原话、subject 主题、' +
  'content 我们发的内容、link 我们发的链接、status 状态、approved_by 谁批的、approved_at 批的时间、tier AI 判的档位、' +
  'faq 用到的 FAQ、follow_up_count 对方回了几条、record_id 记录编号、draft_content AI 草稿（人改过才有）、score 票数；' +
  '消息规则记下的来信另有：sender 发件人、received_at 收到时间、message_kind 类型、summary 摘要、rule_names 命中规则、message_link 原件链接。'

export const RECORD_SINK_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: READ_RECORD_TARGET_TOOL,
    description:
      '用户要把「发出记录」记到一张在线表格时先调它：读那张表的表头（列名、列类型、单选项）和已有的几行，' +
      '用来决定每一列填什么。只读。读不了时会回一句原因和用户要做的那一步（权限、共享），照实转告用户。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '用户贴的表格链接（打开表格时地址栏里那一条）' },
      },
      required: ['url'],
    },
  },
  {
    name: PROPOSE_RECORD_SINK_TOOL,
    description:
      '把用户交代的「记录去处」配起来：每发出去一条（帖子 / 评论 / 回复 / 邮件 / 消息…），按列对照往这张表写一行。' +
      '不会直接生效：会出一张「定规矩」卡（带一行预览）给用户点「记下」。用户要改已有的去处也用它（同一张表就是改）。' +
      `columns 里每一列给一个来源：field（${FIELD_HINT}）、value（固定写这个字）或 empty。` +
      '可选格式：date（日期写法，如 YYYY/MM/DD）、max_chars（最多几个字）、map（值替换，如 {"reply":"回复"}）。' +
      '没给的列按列名自动对。只记某些渠道 / 动作就给 channels / actions（例如 ["reddit"]）。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '表格链接' },
        instruction: { type: 'string', description: '用户的原话（照抄）' },
        name: {
          type: 'string',
          description: '去处的名字（用户怎么叫就怎么写，例如「IVRA 回复记录」）',
        },
        columns: {
          type: 'array',
          description: '列对照（列名与表头一字不差）',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: '列名' },
              field: { type: 'string', description: '标准字段 id' },
              value: { type: 'string', description: '固定值' },
              empty: { type: 'boolean', description: '这一列留空' },
              date: { type: 'string', description: '日期写法' },
              max_chars: { type: 'number', description: '最多几个字' },
              map: {
                type: 'object',
                description: '值替换表',
                additionalProperties: { type: 'string' },
              },
            },
          },
        },
        channels: { type: 'array', items: { type: 'string' }, description: '只记这些渠道' },
        actions: {
          type: 'array',
          items: { type: 'string' },
          description:
            '只记这些动作（reply / comment / post …）。发布的报告（周报、日报…）是 report、消息规则记下的来信是 message_rule，只有列了它们才记',
        },
        sink_id: { type: 'string', description: '要改的那个去处（list_record_sinks 里的 id）' },
      },
      required: ['url', 'instruction'],
    },
  },
  {
    name: LIST_RECORD_SINKS_TOOL,
    description:
      '列出这个品牌已经配好的记录去处：名字、在不在记、写了几条、待补写几条、最近一次的问题。只读。',
    input_schema: { type: 'object', properties: {} },
  },
]

export const RECORD_SINK_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  RECORD_SINK_TOOL_DEFS.map((d) => [d.name, d]),
)

/** 工具回的数据（服务端白名单出参）。 */
export interface RecordSinkProposeData {
  ok: boolean
  name?: string
  revision?: boolean
  card?: boolean
  columns?: { column: string; fill: string }[]
  unknown?: string[]
  message?: string
  hint?: string
}

const TABLE_LINK =
  /https?:\/\/[^\s]*(feishu\.cn|feishu\.net|larksuite\.com|larkoffice\.com|docs\.google\.com\/spreadsheets|dingtalk\.com)[^\s)）]*/i
const WANTS = /记(到|进|在|录)|写(到|进)|同步(到|进)|log|record/i

/**
 * stub 的岔口：工具面里有这几个工具、话里有一张在线表格的链接、说的是「记到 / 写进」，就配一次去处。
 * 回的是要调的那一步；否则 undefined（stub 的其余路径一个字节不变）。
 */
export function recordSinkBranch(
  req: RunRequest,
  text: string,
): { tool: string; input: Record<string, unknown> } | undefined {
  if (!req.tools.allow.includes(PROPOSE_RECORD_SINK_TOOL)) return undefined
  const url = TABLE_LINK.exec(text)?.[0]
  if (url === undefined || !WANTS.test(text)) return undefined
  return { tool: PROPOSE_RECORD_SINK_TOOL, input: { url, instruction: text.trim().slice(0, 2000) } }
}

export function recordSinkDataOf(data: unknown): RecordSinkProposeData | undefined {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return typeof o.ok === 'boolean' ? (o as unknown as RecordSinkProposeData) : undefined
}

/** 回话（短）：配成了说记到哪、几列怎么填、去卡上点「记下」；没成照实说原因与那一步。 */
export function renderRecordSinkAnswer(input: {
  data?: RecordSinkProposeData
  failed?: string
}): string {
  const d = input.data
  if (d === undefined) return `这一步没走通：${input.failed || '工具没回话'}。`
  if (!d.ok) return [d.message ?? '没配成。', d.hint].filter(Boolean).join('\n')
  const lines = (d.columns ?? []).map((c) => `- ${c.column} ← ${c.fill}`)
  const extra =
    (d.unknown ?? []).length > 0 ? `\n表里没有这几列：${(d.unknown ?? []).join('、')}。` : ''
  const card =
    d.card === false ? '（卡没出成，再说一次试试）' : '确认卡已经发到卡片流，点「记下」就生效。'
  return `「${d.name ?? '记录表'}」${d.revision === true ? '的新对照' : ''}：\n${lines.join('\n')}${extra}\n${card}`
}
