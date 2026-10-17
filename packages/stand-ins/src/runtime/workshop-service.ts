/**
 * WP390（docs/105 §4 / §7）：**工坊服务**的两个通用工具——给模型看的名字、描述、参数，回来的数据形状，以及 stub
 * 运行时那一段剧本。真正干活在服务端（`apps/server/src/workshop-service-tools.ts`）。
 *
 * - `find_service`：用户说出「想找人建站」这类意向时查服务目录（意向 + 当前岗位 → 匹配项，工坊自营排第一）。
 *   推荐卡由宿主挂在回答末尾一行（同一对话一项只推一次、说过「不用」30 天不推、定时任务里不推）——AI 正常回答就行，
 *   **不在正文里推销、不写风险、不写合作方名字**。没匹配上的意向只上报 AI 归纳的那句说法 + 岗位（P8）。
 * - `draft_service_order`：问清楚了出卡——标准件出价目单（可预填几行）、定制件出需求单。**只出卡，不下单**：
 *   下单永远是用户在卡上点（L1）。
 */
import type { RunRequest, ToolDef } from '@agentsws/contracts'

export const FIND_SERVICE_TOOL = 'find_service'
export const DRAFT_SERVICE_ORDER_TOOL = 'draft_service_order'

/** 两个工具（`tools.allow` 要字节稳定）。 */
export const WORKSHOP_SERVICE_TOOL_NAMES: readonly string[] = [
  DRAFT_SERVICE_ORDER_TOOL,
  FIND_SERVICE_TOOL,
]

export const WORKSHOP_SERVICE_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: FIND_SERVICE_TOOL,
    description:
      '用户说出想找人 / 找机构替他做成一件事的意向（「想找人建站」「帖子没人互动」「没有谷歌账号」）时调它，查「工坊服务」目录' +
      '（工坊团队或工坊合作的专业团队替用户做、花积分）。照常回答用户的问题；匹配上的服务会由界面在你回答末尾挂一行推荐（名字 · 起价 · 看看），' +
      '你**不要在正文里推销、不要写风险、不要写合作方是谁**。用户要下单时：标准件直接调 draft_service_order 出价目单；' +
      '定制件按返回的 questions 一个一个问（一次问一个，问清楚了再调 draft_service_order 出需求单）。' +
      'intent 写你归纳的一句意向说法（不是用户原话，不超过 30 字）。',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: '归纳的一句意向说法（如「想找人重做网站」）' },
      },
      required: ['intent'],
    },
  },
  {
    name: DRAFT_SERVICE_ORDER_TOOL,
    description:
      '用户要用某项工坊服务、需求问清楚了时调它：出一张卡给用户点。标准件出**价目单**（lines 可预填要哪几项、各多少、对象如帖子链接）；' +
      '定制件出**需求单**（answers 按 find_service 返回的 questions 填）。**只出卡不下单**——用户在卡上点「下单 / 提交」才算数，' +
      '你不能替他点，也不要说「已经下单了」。调完说一声「在下面这张卡上看一眼」就停。',
    input_schema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'find_service 返回的服务 id' },
        lines: {
          type: 'array',
          description: '标准件：预填的几行',
          items: {
            type: 'object',
            properties: {
              item_id: { type: 'string' },
              quantity: { type: 'number' },
              target: { type: 'object', description: '这一项要填的对象（如 post_url）' },
            },
            required: ['item_id', 'quantity'],
          },
        },
        answers: {
          type: 'array',
          description: '定制件：需求单的答案',
          items: {
            type: 'object',
            properties: {
              question_id: { type: 'string' },
              answer: { type: 'string' },
            },
            required: ['question_id', 'answer'],
          },
        },
      },
      required: ['service_id'],
    },
  },
]

export const WORKSHOP_SERVICE_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  WORKSHOP_SERVICE_TOOL_DEFS.map((d) => [d.name, d]),
)

/** `find_service` 回的一项（白名单出参：没有后台备注、没有合作方名字）。 */
export interface FoundService {
  id: string
  name: string
  kind: 'standard' | 'custom'
  /** 工坊团队 / 工坊合作的专业团队。 */
  by: string
  summary: string
  from_credits?: number
  /** 定制件要问的（按顺序一个一个问）。 */
  questions?: { id: string; label: string; required: boolean; hint?: string; options?: string[] }[]
  /** 标准件的价目单。 */
  menu?: {
    id: string
    label: string
    unit: string
    credits_per_unit: number
    min: number
    max: number
    targets: string[]
  }[]
}

export interface FindServiceData {
  ok: boolean
  services: FoundService[]
  /** 界面会不会在这一轮回答末尾挂推荐（同一对话推过 / 说过不用 / 定时任务里就不挂）。 */
  will_offer: boolean
  message: string
}

export interface DraftServiceOrderData {
  ok: boolean
  form?: 'service_menu' | 'service_requirements'
  approval_item_id?: string
  message: string
}

export function findServiceDataOf(data: unknown): FindServiceData | undefined {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return typeof o.ok === 'boolean' && Array.isArray(o.services)
    ? (o as unknown as FindServiceData)
    : undefined
}

const SERVICE_ASK = /(?:我想看看|看看)「([^」]{1,40})」[（(]工坊服务[)）]/u
const INTENT_WORDS =
  /找(?:个|一个)?(?:人|外包|机构|团队|专业)|找人(?:做|帮|建)|想要更多(?:评论|点赞)|没人互动|没有(?:谷歌|google)\s*账号/iu

/**
 * stub 的岔口：工具面里有 `find_service`——话里是「我想看看「X」（工坊服务）」（点了「看看」）就查一次再出卡；
 * 话里有找人代办的意向就查一次（推荐卡由宿主挂）。否则 undefined（stub 的其余路径一个字节不变）。
 */
export function workshopServiceBranch(
  req: RunRequest,
  text: string,
): { kind: 'start'; name: string } | { kind: 'intent'; intent: string } | undefined {
  if (!req.tools.allow.includes(FIND_SERVICE_TOOL)) return undefined
  const ask = SERVICE_ASK.exec(text)
  if (ask?.[1] !== undefined) return { kind: 'start', name: ask[1] }
  const hit = INTENT_WORDS.exec(text)
  if (hit !== null) {
    const line = text.split(/\n/u).find((l) => INTENT_WORDS.test(l)) ?? text
    return { kind: 'intent', intent: line.trim().slice(0, 30) }
  }
  return undefined
}

/** stub 回话（短）。 */
export function renderWorkshopServiceAnswer(input: {
  found?: FindServiceData
  drafted?: DraftServiceOrderData
  failed?: string
}): string {
  if (input.failed !== undefined) return `这一步没走通：${input.failed}。`
  if (input.drafted !== undefined)
    return input.drafted.ok
      ? input.drafted.form === 'service_menu'
        ? '出了一张价目单：勾要的、填好数量，点「下单」才扣积分。'
        : '需求单整理好了：在下面这张卡上看一眼，没问题就提交。'
      : input.drafted.message
  const f = input.found
  if (f === undefined || f.services.length === 0)
    return '这件事我先照常帮你想办法；目前工坊服务里没有对应的一项。'
  return '可以这样做：先想清楚要什么、预算多少，再挑做过同类的团队看案例。也可以交给工坊来办。'
}
