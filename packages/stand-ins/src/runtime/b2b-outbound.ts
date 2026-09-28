/**
 * WP176（Fable 09-28）：**Run 里的开发信工具**（`b2b.outbound`「主动开发」那条职责）。
 *
 * WP173 只有界面与 `/v1/b2b/outbound/*`，Run 里没有一个开发信的工具——快捷提示「起草开发信」
 * 进 Run 之后动不了序列，只能回一段话。这里是三个工具的名字、给模型看的描述、回来的数据形状，
 * 以及 stub 运行时用的那一段剧本。真正干活在服务端（`apps/server/src/b2b-outbound-tools.ts`，
 * 落到 `B2bOutboundPort` 上——与界面那几条路由同一份装配，不另开一本账）。
 *
 * 三条纪律：
 *
 * 1. **只读或只出卡，不直接发**：开一轮 = 出「发信域名」选择卡或首封批量卡，批了执行器才发。
 * 2. **只给主动开发**：`tools.allow` 里只有 `b2b.outbound` 才有这三个名字（`runtime.ts`），
 *    执行器里再判一次职责。
 * 3. 回来的数据是白名单：名字、公司、走到哪一步；**没有邮箱**（联系人库本来就只有加密库引用）。
 */
import type { RunRequest, ToolDef } from '@agentsws/contracts'

export const B2B_OUTBOUND_ROLE_ID = 'b2b.outbound'
export const B2B_LIST_SEQUENCES_TOOL = 'list_outreach_sequences'
export const B2B_START_ROUND_TOOL = 'start_outreach_round'
export const B2B_CLASSIFY_REPLY_TOOL = 'classify_outreach_reply'

/** 三个工具（排好序：`tools.allow` 要字节稳定）。 */
export const B2B_OUTBOUND_TOOL_NAMES: readonly string[] = [
  B2B_CLASSIFY_REPLY_TOOL,
  B2B_LIST_SEQUENCES_TOOL,
  B2B_START_ROUND_TOOL,
].sort()

export const isB2bOutboundRole = (role_id: string): boolean => role_id === B2B_OUTBOUND_ROLE_ID

/** 给模型看的定义（描述写人话：它是在挑工具的那一刻读描述的）。 */
export const B2B_OUTBOUND_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: B2B_LIST_SEQUENCES_TOOL,
    description:
      '列出开发信序列：漏斗（排着 / 待批 / 首封已发 / 跟进已发 / 收尾已发 / 转给业务 / 回了 / 停了），' +
      '每个联系人走到哪一封、下一封哪天，排着的原因，今天还能发几封，还差什么才能发（发信邮箱、体检、公司地址），' +
      '以及说过不感兴趣、还在冷却里的人。只读。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: B2B_START_ROUND_TOOL,
    description:
      '开一轮开发信（三封：第 0 / 3 / 7 天）。**不会直接发信**：还没选发信邮箱就出一张「用哪只邮箱发」的选择卡；' +
      '选好了、体检过了就出一张「首封批量」的卡，人批了才发。超了今天配额的排到明天；德国 / 奥地利没往来的、' +
      '在抑制名单上的、说过不感兴趣还在冷却里的不放进来（原因逐个写明）。不给 contact_ids = 库里所有还没开过的联系人。',
    input_schema: {
      type: 'object',
      properties: {
        product: {
          type: 'string',
          description: '想聊的产品线（英文，如 GaN chargers）；不给用上一次的',
        },
        contact_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '只开这几位（联系人 id）；不给 = 全部还没开过的',
        },
      },
    },
  },
  {
    name: B2B_CLASSIFY_REPLY_TOOL,
    description:
      '把一封开发信的回信分类：有意向 / 要资料 / 问价（交给业务）、晚点再说、不感兴趣（停这一轮、冷却）、' +
      '退订（进抑制名单）、自动回复（顺延）、退信。给往来记录的 id，或者直接给信的主题与正文。' +
      '只判，不改序列——收到的真回信由邮件分拣自动停序列。',
    input_schema: {
      type: 'object',
      properties: {
        inquiry_id: { type: 'string', description: '往来记录的 id（邮件分拣落进来的那一条）' },
        subject: { type: 'string', description: '回信主题（没有记录 id 时给）' },
        text: { type: 'string', description: '回信正文（没有记录 id 时给）' },
      },
    },
  },
]

export const B2B_OUTBOUND_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  B2B_OUTBOUND_TOOL_DEFS.map((d) => [d.name, d]),
)

/** 列序列回的数据（服务端 `b2b-outbound-tools.ts` 拼）。 */
export interface B2bSequencesData {
  funnel: { label: string; count: number }[]
  /** 还差什么才能发（人话）。 */
  needs: string[]
  /** 今天还能发几封（没选发信邮箱就没有）。 */
  remaining_today?: number
  rows: { name: string; company: string; status: string; next_step?: string; due_at?: string }[]
  cooling: { name: string; until: string; count: number }[]
}

/** 开一轮回的数据。 */
export interface B2bStartRoundData {
  status: 'staged' | 'queued' | 'nothing_to_send' | 'blocked'
  message: string
  picked: number
  queued_tomorrow: number
  approval_item_id?: string
  excluded: { name: string; company: string; label: string }[]
}

const START = /起草|开一轮|发一轮|再开一轮|draft|write/i
const LIST = /序列|漏斗|进度|到哪|走到|排着|冷却|funnel|status/i
const OUTREACH = /开发信|cold email|outreach/i
const REPLY = /回信|回复|分类|分一下|reply|replies/i

/**
 * stub 的岔口：主动开发职责、工具面里有这几个工具、而且说的是开发信，才走这一边；否则照旧
 * （stub 的其余路径一个字节不变）。回的是要调的工具（按顺序）：
 *
 * - 问回信 → 先列序列（回信分类是收件时自动做的；要分某一封得给那封信）；
 * - 问进度 → 列序列；
 * - 起草 / 开一轮 → 先列一次（看还差什么），再开一轮（出卡，不直接发）。
 */
export function b2bOutboundBranch(req: RunRequest, text: string): string[] | undefined {
  if (!isB2bOutboundRole(req.actor.role_id)) return undefined
  const has = (n: string): boolean => req.tools.allow.includes(n)
  if (!has(B2B_LIST_SEQUENCES_TOOL)) return undefined
  const start = has(B2B_START_ROUND_TOOL)
    ? [B2B_LIST_SEQUENCES_TOOL, B2B_START_ROUND_TOOL]
    : [B2B_LIST_SEQUENCES_TOOL]
  if (REPLY.test(text)) return [B2B_LIST_SEQUENCES_TOOL]
  // 明说「起草 / 开一轮」→ 开；问进度 → 只列；只提到开发信 → 开（快捷提示那一句）
  if (START.test(text)) return start
  if (LIST.test(text)) return [B2B_LIST_SEQUENCES_TOOL]
  if (OUTREACH.test(text)) return start
  return undefined
}

const obj = (data: unknown): Record<string, unknown> =>
  data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}

export function sequencesOf(data: unknown): B2bSequencesData | undefined {
  const o = obj(data)
  return Array.isArray(o.funnel) && Array.isArray(o.rows)
    ? (o as unknown as B2bSequencesData)
    : undefined
}

export function startRoundOf(data: unknown): B2bStartRoundData | undefined {
  const o = obj(data)
  return typeof o.status === 'string' && typeof o.message === 'string'
    ? (o as unknown as B2bStartRoundData)
    : undefined
}

/** stub 给主动开发的那段回话（markdown）。读不到的那一半照实说，不编。 */
export function renderB2bOutboundAnswer(input: {
  sequences?: B2bSequencesData
  started?: B2bStartRoundData
  /** 问的是回信。 */
  replies?: boolean
  failed?: Readonly<Record<string, string>>
}): string {
  const lines: string[] = []
  const s = input.started
  if (s !== undefined) {
    const head =
      s.status === 'staged'
        ? `开了一轮：**${s.picked} 封首封**进了一张待你批的卡，批了才发。`
        : s.status === 'queued'
          ? `名单排上了，还没出首封卡：${s.message}`
          : s.status === 'blocked'
            ? `这一轮被拦下了：${s.message}`
            : `这一轮没有能发的人：${s.message}`
    lines.push(head)
    if (s.status === 'staged' && s.queued_tomorrow > 0)
      lines.push(`另有 ${s.queued_tomorrow} 位超了今天配额，排到明天。`)
    if (s.excluded.length > 0) {
      lines.push('', '**没放进来的**')
      for (const x of s.excluded.slice(0, 5)) lines.push(`- ${x.company}（${x.name}）：${x.label}`)
      if (s.excluded.length > 5)
        lines.push(`- 还有 ${s.excluded.length - 5} 位，原因见「主动开发」`)
    }
  } else if (input.failed?.[B2B_START_ROUND_TOOL] !== undefined) {
    lines.push(`没开成这一轮：${input.failed[B2B_START_ROUND_TOOL]}。`)
  }
  const q = input.sequences
  if (q !== undefined) {
    const busy = q.funnel.filter((f) => f.count > 0)
    lines.push(
      ...(lines.length === 0 ? [] : ['']),
      '**开发信序列**',
      busy.length === 0
        ? '- 还没开过一轮。'
        : `- ${busy.map((f) => `${f.label} ${f.count}`).join(' · ')}`,
    )
    if (q.remaining_today !== undefined) lines.push(`- 今天还能发 ${q.remaining_today} 封`)
    for (const n of q.needs) lines.push(`- 还差：${n}`)
    if (q.cooling.length > 0)
      lines.push(
        `- 冷却中 ${q.cooling.length} 位（说过不感兴趣）：${q.cooling
          .slice(0, 3)
          .map((c) => `${c.name} 到 ${c.until.slice(0, 10)}`)
          .join('、')}`,
      )
  } else if (input.failed?.[B2B_LIST_SEQUENCES_TOOL] !== undefined) {
    lines.push(`序列没读到：${input.failed[B2B_LIST_SEQUENCES_TOOL]}。`)
  }
  if (input.replies === true)
    lines.push(
      '',
      '回信是收件时自动分的：有意向 / 要资料 / 问价的已经交给业务；不感兴趣的停这一轮、冷却；退订的进了抑制名单。要我分某一封，把那封信贴给我。',
    )
  return lines.join('\n')
}
