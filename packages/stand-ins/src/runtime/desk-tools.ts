/**
 * WP421（自查 general 组，决策 1266–1270）：公关 / 内容与搜索 / B2B / 设计这几条职责**手上的读数与起草工具**。
 *
 * 自查发现：这几条职责的 yml 与快捷按钮许诺了「起草新闻稿」「AI 搜索里有没有我们」「样品到哪了」
 * 「有哪些单等着我」，但三个运行时里 AI 手上一个能读数 / 能起草的工具都没有，只能凭空答。
 * 这里是这一组工具的名字、给模型看的描述、参数、回来的数据形状，以及 stub 运行时那一段剧本。
 * 真正干活在服务端（`apps/server/src/desk-tools.ts`），落到与界面同一份装配上。
 *
 * 三条纪律：
 *
 * 1. **只读或只出卡**：起草类（新闻稿 / 论坛帖 / 设计需求单 / 存联系人）只出卡，人批了才算数；
 * 2. **按职责给**：`deskToolsFor(role_id)` 是唯一一张表（`tools.allow` 与执行器都按它判）；
 * 3. 回来的数据一律带一句 `message`（人话结论）：读不到 / 还没接通就照实说，不当成 0。
 */
import type { RunRequest, ToolDef } from '@agentsws/contracts'

export const LIST_PRESS_RELEASES_TOOL = 'list_press_releases'
export const DRAFT_PRESS_RELEASE_TOOL = 'draft_press_release'
export const DRAFT_FORUM_POST_TOOL = 'draft_forum_post'
export const LIST_FORUM_POSTS_TOOL = 'list_forum_posts'
export const QUERY_SEO_TODAY_TOOL = 'query_seo_today'
export const QUERY_GEO_METRICS_TOOL = 'query_geo_metrics'
export const LIST_B2B_RECORDS_TOOL = 'list_b2b_records'
export const SAVE_B2B_CONTACTS_TOOL = 'save_b2b_contacts'
export const LIST_DESIGN_REQUESTS_TOOL = 'list_design_requests'
export const GET_BRAND_SYSTEM_TOOL = 'get_brand_system'
export const REQUEST_DESIGN_TOOL = 'request_design'

/** 全部名字（排好序：`tools.allow` 要字节稳定）。 */
export const DESK_TOOL_NAMES: readonly string[] = [
  DRAFT_FORUM_POST_TOOL,
  DRAFT_PRESS_RELEASE_TOOL,
  GET_BRAND_SYSTEM_TOOL,
  LIST_B2B_RECORDS_TOOL,
  LIST_DESIGN_REQUESTS_TOOL,
  LIST_FORUM_POSTS_TOOL,
  LIST_PRESS_RELEASES_TOOL,
  QUERY_GEO_METRICS_TOOL,
  QUERY_SEO_TODAY_TOOL,
  REQUEST_DESIGN_TOOL,
  SAVE_B2B_CONTACTS_TOOL,
].sort()

/** 职责 yml 里写了「向设计岗下需求单」（`request_design`）的那几条（与 `DESIGN_DUTIES.request_sources` 对得上）。 */
export const DESIGN_REQUESTER_ROLES: readonly string[] = [
  'ads.google',
  'ads.meta',
  'ads.tiktok',
  'ads.x',
  'amz.store',
  'b2b.exhibition',
  'dtc.content',
  'dtc.store',
  'kol.youtube',
  'social.facebook',
  'social.instagram',
  'social.meta',
  'social.tiktok',
  'social.youtube',
]

const B2B_READ_ROLES = ['b2b.sales', 'b2b.exhibition', 'b2b.fulfillment', 'b2b.outbound']
const B2B_CONTACT_ROLES = ['b2b.sales', 'b2b.exhibition', 'b2b.outbound']

/** 职责的基础 id：复制出来的副本（`b2b.sales-custom`）按原职责给工具。 */
export function baseRoleId(role_id: string): string {
  return role_id.replace(/-custom(?:-\d+)?$/u, '')
}

/** 这条职责摆哪几个（唯一一张表；排好序）。 */
export function deskToolsFor(role_id: string): string[] {
  const id = baseRoleId(role_id)
  const out: string[] = []
  if (id === 'pr.press') out.push(LIST_PRESS_RELEASES_TOOL, DRAFT_PRESS_RELEASE_TOOL)
  if (id === 'pr.forums') out.push(LIST_FORUM_POSTS_TOOL, DRAFT_FORUM_POST_TOOL)
  // WP446：搜索判断与 GEO 归「SEO 与 GEO」
  if (id === 'dtc.seo') out.push(QUERY_SEO_TODAY_TOOL, QUERY_GEO_METRICS_TOOL)
  if (B2B_READ_ROLES.includes(id)) out.push(LIST_B2B_RECORDS_TOOL)
  if (B2B_CONTACT_ROLES.includes(id)) out.push(SAVE_B2B_CONTACTS_TOOL)
  if (id.startsWith('design.')) out.push(LIST_DESIGN_REQUESTS_TOOL, GET_BRAND_SYSTEM_TOOL)
  if (DESIGN_REQUESTER_ROLES.includes(id)) out.push(REQUEST_DESIGN_TOOL)
  return out.sort()
}

export const B2B_RECORD_KINDS = [
  'inquiries',
  'quotes',
  'samples',
  'accounts',
  'contacts',
  'shows',
  'leads',
  'shipments',
] as const
export type B2bRecordKind = (typeof B2B_RECORD_KINDS)[number]

export const DESK_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: LIST_PRESS_RELEASES_TOOL,
    description:
      '列出这个品牌的新闻稿：标题、状态（草稿 / 已批 / 已发 / 撤回）、正文里几个数字、几个有出处、禁发到哪天。只读。',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'approved', 'distributed', 'withdrawn'],
          description: '只看哪一种（不给 = 全部）',
        },
      },
    },
  },
  {
    name: DRAFT_PRESS_RELEASE_TOOL,
    description:
      '起草一篇新闻稿并出卡（不直接发）。正文里每个数字都要在 facts_cited 里写明出自哪张事实卡（先用 search_facts 查）；' +
      '查不到出处的数字不要写。引语不要编：没有本人原话就留空，卡上会提示人补。联系人不给就用公司档案里的。',
    input_schema: {
      type: 'object',
      required: ['headline', 'body'],
      properties: {
        headline: { type: 'string', description: '标题' },
        dek: { type: 'string', description: '副标题 / 一句话导语' },
        body: { type: 'string', description: '正文（不含公司简介）' },
        boilerplate: { type: 'string', description: '公司简介（不给用公司档案）' },
        embargo_until: { type: 'string', description: '禁发到什么时候（ISO 时间；没有就不填）' },
        facts_cited: {
          type: 'array',
          description: '正文里的数字各出自哪张事实卡',
          items: {
            type: 'object',
            properties: {
              figure: { type: 'string', description: '正文里写的那个数（原样）' },
              fact_card_id: { type: 'string', description: 'search_facts 查到的那张卡的 id' },
            },
          },
        },
      },
    },
  },
  {
    name: LIST_FORUM_POSTS_TOOL,
    description:
      '列出我们在外部论坛 / 问答站（知乎、Quora、行业论坛）上提过、发过、被拦下的帖子：在哪个版、状态、被拦的原因。只读。',
    input_schema: {
      type: 'object',
      properties: { platform: { type: 'string', description: '只看哪个平台（不给 = 全部）' } },
    },
  },
  {
    name: DRAFT_FORUM_POST_TOOL,
    description:
      '在外部论坛 / 问答站起草一条帖子或回答并出卡（不直接发）。会先读这个版的版规；读不到就把「没读到版规」写在卡上让人判，' +
      '不替人下「能不能推广」的结论。批了以后由人自己复制去发（论坛发帖还没接自动执行）。',
    input_schema: {
      type: 'object',
      required: ['platform', 'venue', 'body'],
      properties: {
        platform: { type: 'string', description: '平台（zhihu / quora / 论坛名）' },
        venue: { type: 'string', description: '版块 / 问题的名字或网址' },
        kind: {
          type: 'string',
          enum: ['post', 'answer', 'comment'],
          description: '发帖 / 回答问题 / 回一条评论（默认回答）',
        },
        title: { type: 'string', description: '标题（发帖时）' },
        body: { type: 'string', description: '正文' },
      },
    },
  },
  {
    name: QUERY_SEO_TODAY_TOOL,
    description:
      '读今天早上的「值得动的 5 件事」（来自 Search Console：哪页、什么词、证据、建议怎么改、落成了什么卡），' +
      '以及最近一次每周 AI 可见度探测的缺位。只读，数字照抄；还没读过就照实说。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: QUERY_GEO_METRICS_TOOL,
    description:
      '读 AI 回答监测（GEO）的数：最新一周 AI 里提到我们的比例、和竞品的声量份额、比较胜率、说错我们的几句、' +
      '被引用最多的页面、关注词排名。回答「AI 搜索里有没有我们」时用。只读；还没跑过就照实说。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: LIST_B2B_RECORDS_TOOL,
    description:
      '读 B2B 库：inquiries 询盘、quotes 报价（含待审）、samples 样品、accounts 客户、contacts 联系人（没有邮箱）、' +
      'shows 展会、leads 展会线索、shipments 出运单。回答「样品到哪了」「这周要出什么货」「有哪些报价等批」时用。只读。',
    input_schema: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: [...B2B_RECORD_KINDS], description: '读哪一类' },
      },
    },
  },
  {
    name: SAVE_B2B_CONTACTS_TOOL,
    description:
      '把找到的客户 / 联系人存进 B2B 库：出一张「导入名单」卡，人批了才进库（批了才能给他们发开发信）。' +
      '每一条都要有来源网址（从哪看到的）；没有邮箱的也可以存。不编联系人。',
    input_schema: {
      type: 'object',
      required: ['list_name', 'contacts'],
      properties: {
        list_name: { type: 'string', description: '这一批叫什么（如「德国充电器分销商」）' },
        source_url: { type: 'string', description: '整批的来源网址（每条没写就用它）' },
        contacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              company: { type: 'string' },
              name: { type: 'string', description: '联系人姓名' },
              email: { type: 'string' },
              title: { type: 'string', description: '职位' },
              country: { type: 'string', description: '国家（两位代码，如 DE）' },
              domain: { type: 'string', description: '公司官网域名' },
            },
          },
        },
      },
    },
  },
  {
    name: LIST_DESIGN_REQUESTS_TOOL,
    description:
      '列出别的岗位下给设计岗的需求单：谁下的、要什么、规格、截止、走到哪（排队 / 出了 brief / 在出图 / 交付了 / 取消）。' +
      '回答「有哪些单等着我」时用。只读。',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['queued', 'briefed', 'generating', 'delivered', 'cancelled'],
          description: '只看哪一种（不给 = 没做完的）',
        },
      },
    },
  },
  {
    name: GET_BRAND_SYSTEM_TOOL,
    description:
      '读这个品牌的品牌系统（主色、字体、logo 规则、禁忌）。没设过就照实说「还没设品牌系统」，不要自己编配色。只读。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: REQUEST_DESIGN_TOOL,
    description:
      '给设计岗下一张需求单（要一张图 / 一组素材）。设计岗那边会收到、出图后结果回到这件事上。说清楚要什么、用在哪、什么尺寸、哪天要。',
    input_schema: {
      type: 'object',
      required: ['title', 'need'],
      properties: {
        title: { type: 'string', description: '一句话标题（如「新品首页主视觉」）' },
        need: { type: 'string', description: '要什么、用在哪、有什么要求' },
        due_at: { type: 'string', description: '哪天要（ISO 日期；没说就不填）' },
        variants: { type: 'number', description: '想要几版（1–6，不给按默认）' },
      },
    },
  },
]

export const DESK_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  DESK_TOOL_DEFS.map((d) => [d.name, d]),
)

/** 每个工具回的数据都至少有这两格（服务端拼；stub 按它回话）。 */
export interface DeskToolData {
  ok: boolean
  /** 一句话结论（人话，给模型转述）。 */
  message: string
  /** 几行明细（已经是人话）。 */
  lines?: string[]
  /** 出了卡就有。 */
  approval_item_id?: string
  [key: string]: unknown
}

export function deskToolDataOf(data: unknown): DeskToolData | undefined {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return typeof o.ok === 'boolean' && typeof o.message === 'string'
    ? (o as unknown as DeskToolData)
    : undefined
}

/* ── stub 剧本（演示用）──────────────────────────────────────────────────── */

const DRAFT = /起草|写一?篇|写一?条|帮我写|拟一?篇|draft|write/i
const PRESS = /新闻稿|通稿|press\s*release|发布稿/i
const FORUM_POST = /帖|回答|answer|post/i
const LIST_OURS = /发过|我们的帖|有哪些帖|被拦/i
const GEO = /AI\s*(?:搜索|回答|里)|GEO|ChatGPT|Perplexity|Gemini|可见度|提到我们/i
const TODAY = /今天|值得动|5\s*件事|五件事/i
const B2B_KIND: readonly [RegExp, B2bRecordKind][] = [
  [/样品|sample/i, 'samples'],
  [/报价|quote/i, 'quotes'],
  [/询盘|inquir/i, 'inquiries'],
  [/出货|出运|发货|订舱|shipment|信用证|尾款/i, 'shipments'],
  [/线索|lead/i, 'leads'],
  [/展会|trade\s*show/i, 'shows'],
  [/联系人|contact/i, 'contacts'],
  [/客户|老客|account/i, 'accounts'],
]
const DESIGN_QUEUE = /单|需求|等着我|排队|queue/i
const BRAND_SYSTEM = /品牌系统|配色|主色|字体|logo/i
const ASK_DESIGN = /设计岗|下(?:一张)?单|要一?张图|做一?张图|出一?张图|设计一?张/i
const FORUM_PLATFORMS: readonly [RegExp, string][] = [
  [/知乎|zhihu/i, 'zhihu'],
  [/quora/i, 'quora'],
]

const has = (req: RunRequest, tool: string): boolean => req.tools.allow.includes(tool)

/** 话里第一句（去掉换行，最多 40 字）——演示稿的标题。 */
const firstLine = (text: string): string =>
  (text.split(/\n/u).find((l) => l.trim() !== '') ?? '').trim().slice(0, 40)

/**
 * stub 的岔口（演示用剧本）：工具面里有对应工具、话又对得上才走；否则 undefined（stub 其余路径一个字节不变）。
 * 演示稿**不编数字、不编引语**：正文只有一句占位，卡上照实标「演示稿」。
 */
export function deskBranch(
  req: RunRequest,
  text: string,
): { tool: string; input: Record<string, unknown> } | undefined {
  if (has(req, DRAFT_PRESS_RELEASE_TOOL) && PRESS.test(text) && DRAFT.test(text))
    return {
      tool: DRAFT_PRESS_RELEASE_TOOL,
      input: {
        headline: `（演示稿）${firstLine(text)}`,
        body: '（演示稿：这里是新闻稿正文。真模型会按事实卡写；没有出处的数字不写，引语留给本人补。）',
      },
    }
  if (has(req, LIST_PRESS_RELEASES_TOOL) && PRESS.test(text))
    return { tool: LIST_PRESS_RELEASES_TOOL, input: {} }
  if (has(req, LIST_FORUM_POSTS_TOOL) && LIST_OURS.test(text))
    return { tool: LIST_FORUM_POSTS_TOOL, input: {} }
  if (has(req, DRAFT_FORUM_POST_TOOL) && FORUM_POST.test(text) && DRAFT.test(text)) {
    const platform = FORUM_PLATFORMS.find(([re]) => re.test(text))?.[1] ?? 'forum'
    return {
      tool: DRAFT_FORUM_POST_TOOL,
      input: {
        platform,
        venue: firstLine(text),
        kind: 'answer',
        body: '（演示稿：这里是回答正文。真模型会先读版规、再按事实卡写。）',
      },
    }
  }
  if (has(req, QUERY_GEO_METRICS_TOOL) && GEO.test(text))
    return { tool: QUERY_GEO_METRICS_TOOL, input: {} }
  if (has(req, QUERY_SEO_TODAY_TOOL) && TODAY.test(text))
    return { tool: QUERY_SEO_TODAY_TOOL, input: {} }
  if (has(req, LIST_B2B_RECORDS_TOOL)) {
    const kind = B2B_KIND.find(([re]) => re.test(text))?.[1]
    if (kind !== undefined) return { tool: LIST_B2B_RECORDS_TOOL, input: { kind } }
  }
  if (has(req, GET_BRAND_SYSTEM_TOOL) && BRAND_SYSTEM.test(text))
    return { tool: GET_BRAND_SYSTEM_TOOL, input: {} }
  if (has(req, LIST_DESIGN_REQUESTS_TOOL) && DESIGN_QUEUE.test(text))
    return { tool: LIST_DESIGN_REQUESTS_TOOL, input: {} }
  if (has(req, REQUEST_DESIGN_TOOL) && ASK_DESIGN.test(text))
    return {
      tool: REQUEST_DESIGN_TOOL,
      input: { title: firstLine(text), need: text.trim().slice(0, 500) },
    }
  return undefined
}

/** 回话（短）：结论一句 + 最多 8 行明细；读不到就照实说。 */
export function renderDeskAnswer(data: DeskToolData | undefined, failed = ''): string {
  if (data === undefined) return `这一步没做成：${failed || '工具没回话'}。`
  const lines = (data.lines ?? []).slice(0, 8).map((l) => `- ${l}`)
  return [data.message, ...lines].join('\n')
}
