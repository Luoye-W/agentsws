/**
 * WP153（真账号冒烟 09-26）：**给人看的话里不露工具名**，以及「这件事」的一句话摘要。
 *
 * 冒烟里真模型回的是「我用 `search_policies` 查了三轮」，事项顶部的摘要是「查了退货政策。」
 * ——人问的是岗位和连接，摘要却在说这次调了哪些工具。两件事同一个病根：工具名是给模型看的，
 * 给人看的是它干了什么、这件事是什么。
 *
 * 这个文件是**唯一的一张「工具名 → 人话」表**（服务端兜底、三个运行时的摘要都读它），
 * 思路照 WP141 的 `KOL_TOOL_ZH`：名词，不是动词——替换进句子里读得通
 * （「我用「规矩与政策库」查了三轮」）。表里没有、但这次运行摆出来过的工具名，
 * 一律说「一个工具」，也不露名字。
 *
 * 纯函数：不碰时钟、不碰随机，回放算得出同一句。
 */
import { KOL_TOOL_ZH } from '@agentsws/kol-core'

/** 工具名（裸名或全名）→ 人话名词。 */
export const TOOL_WORDS_ZH: Readonly<Record<string, string>> = {
  // 红人：WP141 那张表（放最前面——`search_policies` 在那张表里叫「合作规矩」，下面按全局口径覆盖）
  ...KOL_TOOL_ZH,
  score_creator: '红人打分',
  advance_collaboration: '合作阶段',
  register_deliverable: '交付物登记',
  // 客服默认那四个 + 会话
  get_order: '订单查询',
  list_orders: '订单列表',
  get_product: '商品资料',
  search_policies: '规矩与政策库',
  list_threads: '会话记录',
  // 两个产出工具（宿主回调）
  draft_reply: '起草回复',
  stage_refund: '退款提议',
  // WP153：店主的两个只读工具
  list_positions: '岗位清单',
  list_connections: '连接清单',
  // Dev MCP（WP44）
  'shopify.docs.search': 'Shopify 官方文档',
  'shopify.schema.introspect': 'Shopify 接口说明',
  'shopify.graphql.validate': 'Shopify 接口校验',
  // 电脑操控 / 浏览器（WP144 / WP148）
  request_computer_use: '操作电脑的授权',
  computer_handoff: '请人接手',
}

/** 去掉 `service.` 前缀（`shopify.get_order` → `get_order`）；点在中间的 MCP 全名原样。 */
function bare(name: string): string {
  if (TOOL_WORDS_ZH[name] !== undefined) return name
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
}

/** 一个工具名的人话；认不出回「一个工具」（也不露名字）。 */
export function toolWordZh(name: string): string {
  return TOOL_WORDS_ZH[name] ?? TOOL_WORDS_ZH[bare(name)] ?? '一个工具'
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 把一段给人看的话里的工具名换成人话。
 *
 * 认的是：表里的全部名字 + 这次运行摆出来的 `known`（`tools.allow`）。写法上认
 * 反引号包着的（`` `search_policies` ``）、带 `()` 的（`search_policies()`）、带服务前缀的
 * （`shopify.search_policies`），都换成「人话」。只按**整词**换：`list_orders_by` 这种
 * 更长的词不动（那不是这个工具）。
 */
export function humanizeToolNames(text: string, known: readonly string[] = []): string {
  const names = [...new Set([...Object.keys(TOOL_WORDS_ZH), ...known])]
    .filter((n) => n.length > 0 && (n.includes('_') || n.includes('.')))
    // 长的先换：`shopify.docs.search` 先于别的，免得被短名切碎
    .sort((a, b) => b.length - a.length)
  if (names.length === 0) return text
  const alt = names.map(escapeRe).join('|')
  // 可选的服务前缀 + 名字 + 可选的 `()`；两边可以有反引号，再各带一个可选的空格
  const re = new RegExp(
    `( ?)\`?(?<![\\w.])(?:[a-z][a-z0-9]*\\.)?(${alt})(?:\\(\\))?(?![\\w])\`?( ?)`,
    'g',
  )
  return text.replace(re, (_m, pre: string, name: string, post: string, at: number) => {
    // 中文里夹英文时才有的那两个空格：换成「」之后两边挨着的是中文，空格就多余了
    const before = text.slice(0, at).at(-1) ?? ''
    const after = text.slice(at + _m.length).at(0) ?? ''
    const keepPre = pre !== '' && !CJK.test(before)
    const keepPost = post !== '' && !CJK.test(after)
    return `${keepPre ? ' ' : ''}「${toolWordZh(name)}」${keepPost ? ' ' : ''}`
  })
}

/** 中文字与中文标点（判断工具名两边的空格要不要留）。 */
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/

/**
 * 一段 markdown 去掉记号，剩下能直接当一行字看的正文（摘要用）。
 *
 * 只处理回复里真会出现的几种：粗体 / 斜体、行内代码、链接、图片、标题、列表记号、引用。
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .trim(),
    )
    .join('\n')
}

/** 摘要一行最多多少字（事项顶部一行放得下；再长就截，尾巴一个省略号）。 */
export const HEADLINE_MAX = 60

/**
 * Agent 这一轮给人的回复 → 事项摘要的那一句（WP153 §2）。
 *
 * 先把工具名换成人话、去掉 markdown，取第一行有字的，再取这一行的第一句
 * （句号 / 问号 / 叹号，中英都认），超过 {@link HEADLINE_MAX} 就截。回复是空的回 `undefined`
 * ——调用方退回「做了什么」那种拼法。
 */
export function replyHeadline(
  reply: string | undefined,
  known: readonly string[] = [],
): string | undefined {
  if (reply === undefined) return undefined
  const plain = stripMarkdown(humanizeToolNames(reply, known))
  const line = plain
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (line === undefined) return undefined
  const end = /[。！？!?]|\.(?=\s|$)/.exec(line)
  // 第一行是「我做了这几件事：」这种引子时，去掉结尾的冒号（摘要不该悬着半句）
  const sentence = (end === null ? line : line.slice(0, end.index + 1)).trim().replace(/[：:]$/, '')
  const chars = [...sentence]
  if (chars.length <= HEADLINE_MAX) return sentence
  return `${chars.slice(0, HEADLINE_MAX - 1).join('')}…`
}
