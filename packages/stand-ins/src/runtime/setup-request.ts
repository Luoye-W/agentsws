/**
 * WP334（决策 724，Luoye 10-15）：**AI 自己要连接卡 / 配置卡**的通用工具 `request_setup`——给模型看的名字、
 * 描述、参数，回来的数据形状，以及 stub 运行时那一段剧本。真正干活在服务端（`apps/server/src/setup-request-tool.ts`）。
 *
 * 所有职责都有：AI 做到一半发现「要先连上 X / 要先设好 Y」时调它，给服务名或设置目标 + 一句为什么（+ 建议值）。
 * 工具本身**不出卡**：它回一格结构化的缺项（`needs_connection` / `needs_setup`），运行时在这一轮收尾时照 WP324 的
 * 规则出卡、去重（同一缺项只有一张）、人补完按原话接着做。所以 AI 要卡与工具撞上缺项走的是同一条路。
 *
 * 纪律：参数里**没有一格收凭据**。口令 / 密钥只在卡上的本机原生表单里填；「为什么」「建议值」里像秘密的整条拒收。
 */
import type { RunRequest, ToolDef } from '@agentsws/contracts'
import {
  AMAZON_COMPETITOR_ASK,
  AMAZON_COMPETITOR_SETTING,
  AMAZON_COMPETITOR_SITE,
  AMAZON_COMPETITOR_WORDS,
} from './amazon-competitor.js'

export const REQUEST_SETUP_TOOL = 'request_setup'

/** 一个工具（`tools.allow` 要字节稳定）。 */
export const SETUP_REQUEST_TOOL_NAMES: readonly string[] = [REQUEST_SETUP_TOOL]

export const SETUP_REQUEST_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: REQUEST_SETUP_TOOL,
    description:
      '这件事要先连上一样东西、或先设好一步才做得下去时调它：会在这件事下面出一张卡，用户在卡上就地连好 / 填好，' +
      '这件事就按原话自动接着做（同一样缺的只出一张卡）。调完就停下，跟用户说一声「在下面这张卡上连好 / 填好我就接着做」，' +
      '不要叫用户去设置页或连接页。' +
      'connect 填要连的：连接页里的服务（如 imap_smtp 发信邮箱、ga4、gsc、meta_ads、shopify_admin），' +
      '或 model（AI 模型）、deepseek_account（DeepSeek 账号）、workshop_account（Agents 工坊账号）、' +
      'im:wecom（企业微信）、im:wechat（微信）、im:feishu（飞书）、im:dingtalk（钉钉）、extension（浏览器插件）。' +
      'setting 填要设的：company.profile（公司档案）、company.address（公司实体地址）、site.store（哪家店）等。' +
      '两个给一个。要设的：卡上是「我打算这样设」的方案——工坊出卡前会自己先查一遍（档案、已连的账号、联网），' +
      '你在 suggestions 里给的值（每个带一句 why）会压过它查到的，用户点「就这样」就存。' +
      '已经设好的也能改：setting + suggestions 给新值，出一张「我打算改成这样」的卡（现值 → 新值），用户确认才生效。' +
      '要人选的账号（如品牌号、广告账户）不要猜，留给卡上标「需要你填」。' +
      '绝不要在任何参数里写密码、密钥、令牌——那些用户在卡上的本机表单里自己填。',
    input_schema: {
      type: 'object',
      properties: {
        connect: { type: 'string', description: '要连的服务（见上）' },
        setting: { type: 'string', description: '要设的设置目标（见上）' },
        why: { type: 'string', description: '一句为什么（给用户看，人话，不超过 60 个字）' },
        suggestions: {
          type: 'array',
          description: '配置卡上的建议值（只对 setting 有用；不是秘密的设置）',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '设置项的键' },
              value: { type: 'string', description: '建议值' },
              why: { type: 'string', description: '一句理由（给用户看，20 个字以内）' },
            },
            required: ['key', 'value'],
          },
        },
      },
      required: ['why'],
    },
  },
]

export const SETUP_REQUEST_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  SETUP_REQUEST_TOOL_DEFS.map((d) => [d.name, d]),
)

/** 工具回的数据（服务端白名单出参；没有任何凭据的值）。 */
export interface SetupRequestData {
  /** `true` = 已经连上 / 设好了，不用卡，直接接着做。 */
  ok: boolean
  /** 已经连上 / 设好了。 */
  already?: boolean
  /** 缺的那一样（连接卡）：服务名与人话名。 */
  needs_connection?: string
  connection_name?: string
  /** 缺的那一步（配置卡）：设置目标。 */
  needs_setup?: string
  setup_name?: string
  /** 卡面那一句为什么（运行时出卡用）。 */
  setup_why?: string
  /** 配置卡的建议值（运行时出卡用；只认登记过的格子）。 */
  suggestions?: Record<string, string>
  /** WP348：每个建议值的一句理由（按格子）。 */
  suggestion_why?: Record<string, string>
  /** WP348：目标已经设好了，这是「改成这样」（出改设置方案卡，人确认才生效）。 */
  change?: boolean
  /** 给模型的那一句（照实转告用户）。 */
  message: string
}

/** 话里点名要连 / 要设的那几种说法 → 服务名 / 设置目标（stub 剧本用）。 */
const CONNECT_WORDS: readonly [RegExp, string][] = [
  [/企业微信|企微/i, 'im:wecom'],
  [/(?<!企业)微信/i, 'im:wechat'],
  [/飞书|lark/i, 'im:feishu'],
  [/钉钉/i, 'im:dingtalk'],
  [/deepseek\s*账号/i, 'deepseek_account'],
  [/(?:agents\s*)?工坊账号/i, 'workshop_account'],
  [/发信邮箱|邮箱/i, 'imap_smtp'],
  [/浏览器插件|插件/i, 'extension'],
  [/模型/i, 'model'],
]
const CONNECT_ASK =
  /(?:先|得|要|帮我|给我|请)\s*(?:连上|接上|连一下|接一下|关联|登录|登上|扫码|绑上|绑定)/
const SETTING_WORDS: readonly [RegExp, string][] = [
  [/公司(?:实体)?地址/, 'company.address'],
  [/公司档案|品牌档案/, 'company.profile'],
  // WP348：Reddit 巡查（方案卡演示）
  [/reddit\s*巡查/i, 'reddit.watch'],
]
/** WP348：「把 X 的〈格子〉改成 …」里那一格（stub 剧本：已设好再改的演示）。 */
const CHANGE_FIELDS: readonly [RegExp, string][] = [
  [/重点版块/, 'watch_subreddits'],
  [/自家版块/, 'own_subreddits'],
  [/告警词/, 'alert_words'],
  [/标签词/, 'tag_words'],
  [/关键词/, 'keywords'],
]
const CHANGE_ASK = /改成|改为/
const SETTING_ASK = /(?:先|得|要|帮我|请)\s*(?:填|设|补)(?:好|上|一下)?/

/**
 * stub 的岔口：工具面里有 `request_setup`、话里明说「先连上 X / 先填好 Y」，就要一张卡。
 * 回的是要调的那一步；否则 undefined（stub 的其余路径一个字节不变）。
 */
export function setupRequestBranch(
  req: RunRequest,
  text: string,
): { tool: string; input: Record<string, unknown> } | undefined {
  if (!req.tools.allow.includes(REQUEST_SETUP_TOOL)) return undefined
  // WP394：「帮我盯 Amazon 上的竞品」→ 亚马逊店铺运营「竞品动向」的方案卡（要在独立站那条之前认：话里也有「价格」）
  if (
    AMAZON_COMPETITOR_SITE.test(text) &&
    AMAZON_COMPETITOR_ASK.test(text) &&
    AMAZON_COMPETITOR_WORDS.test(text)
  )
    return {
      tool: REQUEST_SETUP_TOOL,
      input: {
        setting: AMAZON_COMPETITOR_SETTING,
        why: '盯哪几款、各对标你哪一款、什么算重要，我先在 Amazon 上查了一遍定了个方案。',
      },
    }
  if (CONNECT_ASK.test(text)) {
    const hit = CONNECT_WORDS.find(([re]) => re.test(text))
    if (hit !== undefined)
      return {
        tool: REQUEST_SETUP_TOOL,
        input: { connect: hit[1], why: '这件事要先连上它才做得下去。' },
      }
  }
  // WP348：「把 Reddit 巡查的重点版块改成 …」→ 带新值要卡（已设好就是「我打算改成这样」）
  const change = CHANGE_ASK.test(text) ? SETTING_WORDS.find(([re]) => re.test(text)) : undefined
  const field = change === undefined ? undefined : CHANGE_FIELDS.find(([re]) => re.test(text))
  const value = /(?:改成|改为)\s*[「"“]?([^」"”。\n]+)/.exec(text)?.[1]?.trim()
  if (change !== undefined && field !== undefined && value !== undefined && value !== '')
    return {
      tool: REQUEST_SETUP_TOOL,
      input: {
        setting: change[1],
        why: '按你说的改。',
        suggestions: [{ key: field[1], value, why: '你刚才说的' }],
      },
    }
  if (SETTING_ASK.test(text)) {
    const hit = SETTING_WORDS.find(([re]) => re.test(text))
    if (hit !== undefined)
      return {
        tool: REQUEST_SETUP_TOOL,
        input: { setting: hit[1], why: '这件事要先设好这一步才做得下去。' },
      }
  }
  return undefined
}

export function setupRequestDataOf(data: unknown): SetupRequestData | undefined {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return typeof o.ok === 'boolean' && typeof o.message === 'string'
    ? (o as unknown as SetupRequestData)
    : undefined
}

/** 回话（短）：要了卡 → 「在下面这张卡上…」；已经好了 → 接着做；没成 → 照实说。 */
export function renderSetupRequestAnswer(input: {
  data?: SetupRequestData
  failed?: string
}): string {
  const d = input.data
  if (d === undefined) return `这一步没走通：${input.failed || '工具没回话'}。`
  if (d.already === true) return d.message
  if (d.needs_connection !== undefined)
    return `要先连上${d.connection_name ?? d.needs_connection}：在下面这张卡上连好，我就接着做。`
  if (d.needs_setup !== undefined && d.change === true)
    return `${d.setup_name ?? d.needs_setup}我打算这样改：在下面这张卡上点头就生效。`
  if (d.needs_setup !== undefined)
    return `${d.setup_name ?? d.needs_setup}我先定了个方案：在下面这张卡上点头，我就接着做。`
  return d.message
}
