/**
 * WP343（决策 334 / 859）：「我的助理」手上的五个工具——四个只读、一个派活。
 * WP350（决策 900）：多一个「拆成多份」（`plan_fanout`）——只出方案卡，人确认之前什么都不发。
 *
 * 「我的助理」是原来的「随便聊」：能随便聊，也能问全局（各岗位在做什么、今天要我处理的卡、
 * 最近发出去的、某件事到哪了），还能像对岗位那样交代一件事——它**不自己做**，挑好岗位 / 职责，
 * 走现有的交办入口开一件事，那个岗位去做；要改外部的事照旧由那个岗位出审批。
 *
 * 这里是名字、给模型看的描述与参数表——**全仓唯一一份**：随便聊那条模型回合（直连网关，
 * 与 stub / direct 同一种 JSON Schema）用它，dsh 那一侧的参数表也从它原样转（`dsh-adapter` 的
 * `themeParams`），严格参数表测试钉住。真正取数据 / 开事项在服务端（`apps/server/src/assistant.ts`）。
 *
 * 出参是**白名单**：只有名字、标题、状态、时间——没有邮箱、没有凭据、没有对方的原话全文。
 */
import type { ToolDef } from '@agentsws/contracts'

export const ASSISTANT_OVERVIEW_TOOL = 'work_overview'
export const ASSISTANT_CARDS_TOOL = 'my_pending_cards'
export const ASSISTANT_SENT_TOOL = 'recent_sent'
export const ASSISTANT_PROGRESS_TOOL = 'matter_progress'
export const ASSISTANT_DISPATCH_TOOL = 'hand_to_position'
/** WP350（决策 900）：一段话 / 一份资料按岗位拆成多份，出方案卡给人确认（确认之前什么都不发）。 */
export const ASSISTANT_FANOUT_TOOL = 'plan_fanout'

/** 四个只读的（不产生任何 staged / applied，也不开事项）。 */
export const ASSISTANT_READ_TOOLS: readonly string[] = [
  ASSISTANT_OVERVIEW_TOOL,
  ASSISTANT_CARDS_TOOL,
  ASSISTANT_SENT_TOOL,
  ASSISTANT_PROGRESS_TOOL,
]

/** 全部（排好序：字节稳定）。WP350 起六个（多了拆成多份那一个）。 */
export const ASSISTANT_TOOL_NAMES: readonly string[] = [
  ...ASSISTANT_READ_TOOLS,
  ASSISTANT_DISPATCH_TOOL,
  ASSISTANT_FANOUT_TOOL,
].sort()

export const isAssistantTool = (name: string): boolean => ASSISTANT_TOOL_NAMES.includes(name)

export const ASSISTANT_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: ASSISTANT_OVERVIEW_TOOL,
    description:
      '看用户的各个岗位 / 职责在做什么：每个岗位下面的职责、进行中的事（标题与最近一句进展）、' +
      '最近做完的、等用户拍板的卡有几张。只读。给了 position 就只看那一个岗位。',
    input_schema: {
      type: 'object',
      properties: {
        position: { type: 'string', description: '只看这个岗位（岗位名），不填 = 全部' },
      },
    },
  },
  {
    name: ASSISTANT_CARDS_TOOL,
    description:
      '今天等用户本人处理的卡（要他拍板的事）：标题、哪个岗位、等了多久。只读，不会替他决定任何一张。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: ASSISTANT_SENT_TOOL,
    description:
      '最近已经发出去的东西（回帖、邮件、私信、发帖…）：发到哪、什么时候、谁批的、一句摘要。只读。',
    input_schema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: '只看这个渠道（reddit / email / x …），不填 = 全部',
        },
        limit: { type: 'integer', description: '最多几条，默认 10，最多 30' },
      },
    },
  },
  {
    name: ASSISTANT_PROGRESS_TOOL,
    description:
      '查某件事到哪了：按关键词找用户的事项，回状态、归哪个岗位 / 职责、最近几句进展、还有几张卡等他定。只读。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（事项标题、说过的事、对方名字）' },
      },
      required: ['query'],
    },
  },
  {
    name: ASSISTANT_DISPATCH_TOOL,
    description:
      '把用户交代的一件事交给他的某个岗位去做（开一件事，那个岗位去办；你自己不做、也不改任何外部的东西）。' +
      '岗位按用户的话挑，用户点了名就照点的；拿不准是哪个岗位时**不要猜**，先不调这个工具，问用户一句。' +
      '工具回「没交出去」+ 候选时，把候选说给用户、让他选。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '交给岗位的那件事（用用户的原话，必要时补全上下文）' },
        position: { type: 'string', description: '交给哪个岗位（岗位名）' },
        duty: {
          type: 'string',
          description: '岗位里的哪条职责（职责名），不确定就不填，岗位自己分',
        },
      },
      required: ['text'],
    },
  },
  {
    name: ASSISTANT_FANOUT_TOOL,
    description:
      '用户给了一段话 / 一份资料（会议记录、文档、聊天记录），里面的事要交给**好几个岗位**、或要好几个岗位记住一些口径时用：' +
      '把它拆成一条一条——要做的事（task：交给哪个岗位、一句为什么、截止、原文出处）、' +
      '要记住的业务口径（note：记进哪个岗位的知识库，品牌通用的写「品牌」，必带原文出处）、' +
      '用户本人的偏好（memory：只记在助理这里）。工具会摆一张方案卡给用户，**用户点了「就这样」才派、才记**；' +
      '你不用再调派活工具重复派。拿不准归哪个岗位就别填 position，卡上会标「归属待定」让用户挑。只有一件事、一个岗位时用派活工具。',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '这份资料一句话叫什么（「10-16 周会」），不填就用文件名',
        },
        items: {
          type: 'array',
          description: '拆出来的每一条',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['task', 'note', 'memory'],
                description: 'task 要做的事 / note 要记住的业务口径 / memory 用户本人的偏好',
              },
              text: { type: 'string', description: '这一条（一句话说清楚）' },
              position: {
                type: 'string',
                description: '归哪个岗位（岗位名）；note 品牌通用写「品牌」；拿不准不填',
              },
              duty: { type: 'string', description: '岗位里的哪条职责（职责名），不确定不填' },
              why: { type: 'string', description: '一句为什么（task）' },
              due: { type: 'string', description: '截止（原话，有才填）' },
              quote: { type: 'string', description: '资料里的原文那一段（出处）' },
            },
            required: ['kind', 'text'],
          },
        },
      },
      required: ['items'],
    },
  },
]

export const ASSISTANT_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  ASSISTANT_TOOL_DEFS.map((d) => [d.name, d]),
)

/** `work_overview` 的一行（一个岗位）。 */
export interface AssistantPositionRow {
  name: string
  duties: string[]
  /** 进行中的事（≤ 5 条）：标题 + 最近一句进展 + 归哪条职责。 */
  doing: { title: string; latest?: string; duty?: string }[]
  /** 最近做完的（≤ 5 条，新的在前）：「今天做了什么」看它。 */
  done: { title: string; latest?: string; duty?: string; at: string }[]
  /** 进行中的一共几件（可能比 `doing` 多）。 */
  open: number
  /** 等用户拍板的卡几张。 */
  waiting_cards: number
}

/** `my_pending_cards` 的一行。 */
export interface AssistantCardRow {
  title: string
  position?: string
  /** 等了多久（人话：「3 小时」「2 天」）。 */
  waiting: string
}

/** `recent_sent` 的一行。 */
export interface AssistantSentRow {
  at: string
  channel: string
  action: string
  to?: string
  /** 我们发的那一条，截到 80 字。 */
  gist: string
  approved_by?: string
}

/** `matter_progress` 的一行。 */
export interface AssistantMatterRow {
  title: string
  status: string
  position?: string
  duty?: string
  updated_at: string
  /** 最近几句进展（≤ 3 句，每句 ≤ 120 字）。 */
  latest: string[]
  waiting_cards: number
}

/** `hand_to_position` 的结果。 */
export type AssistantDispatchResult =
  | {
      dispatched: true
      position: string
      duty?: string
      title: string
    }
  | {
      dispatched: false
      /** 为什么没交（人话）。 */
      reason: string
      /** 拿不准时的候选（岗位名，或「岗位 · 职责」）。 */
      candidates: string[]
    }

/** `plan_fanout` 的一条（与 `@agentsws/roles` 的 `FanoutDraftItem` 同形）。 */
export interface AssistantFanoutDraft {
  kind: 'task' | 'note' | 'memory'
  text: string
  position?: string
  why?: string
  due?: string
  quote?: string
}

const MEMORY_LINE = /我(个人)?(喜欢|习惯|偏好)|以后(给我|跟我)|(给我|跟我)(汇报|说话)/u
const NOTE_LINE = /记住|记一下|口径|统一|一律|以后都|规定|政策|定为|定成|改成.*(天|%|元)|不再/u
const TASK_LINE = /要|负责|跟进|安排|准备|写|发|回|改|查|整理|做|出|联系|上架|下架|更新/u
const DUE =
  /(今天|明天|后天|本周[一二三四五六日天]?|下周[一二三四五六日天]?|周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|\d{1,2}[-/]\d{1,2})(之?前)?/u

/**
 * WP350：**替身**的拆法（demo 的云替身与模拟世界用；真模型不走这里）——一行一条：
 * 提到「我喜欢 / 以后给我…」是个人偏好，提到「记住 / 统一 / 一律 / 口径…」是要记的口径，其余像在交代事的是要做的事；
 * 岗位按行里出现的岗位名认（最长的那个），要记的那条提到「品牌」就归品牌公共。确定性：同输入同输出。
 */
export function stubFanoutDraft(
  text: string,
  positions: readonly string[],
): { title?: string; items: AssistantFanoutDraft[] } {
  const names = [...positions].filter((n) => n.trim() !== '').sort((a, b) => b.length - a.length)
  let title: string | undefined
  const items: AssistantFanoutDraft[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      title ??= line.replace(/^#+\s*/u, '').slice(0, 40)
      continue
    }
    const body = line.replace(/^([-*·•]|\d+[.、)])\s*/u, '').trim()
    if (body.length < 4) continue
    const position = names.find((n) => body.includes(n))
    const plain = (
      position === undefined
        ? body
        : body.replace(new RegExp(`^${escapeRe(position)}\\s*[：:]\\s*`, 'u'), '')
    ).trim()
    const due = DUE.exec(body)?.[0]
    if (MEMORY_LINE.test(body)) {
      items.push({ kind: 'memory', text: plain, quote: body })
      continue
    }
    if (NOTE_LINE.test(body)) {
      items.push({
        kind: 'note',
        text: plain,
        quote: body,
        ...(position !== undefined
          ? { position }
          : /品牌|全公司/u.test(body)
            ? { position: '品牌' }
            : {}),
      })
      continue
    }
    if (position !== undefined || TASK_LINE.test(body))
      items.push({
        kind: 'task',
        text: plain,
        quote: body,
        why: '会上定的',
        ...(position === undefined ? {} : { position }),
        ...(due === undefined ? {} : { due }),
      })
  }
  return { ...(title === undefined ? {} : { title }), items }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
