/**
 * WP179：规则脑的"去网上查一下"（direct 与 dsh 两档的模拟模型替身共用）。
 *
 * 与 stub 的剧本同一套判定（`@agentsws/stand-ins` 的 `web.ts`）：工具面里有 `web_search`、
 * 事项里那句话像"搜 / 查 / 调研"，就先搜一条查询 → 工具面里有 `web_fetch` 就抓第一条来源 →
 * 把来源网址列成一段话。工具面里没有网页工具的运行一个字节不变（回 `undefined`）。
 *
 * 它读的是**模型看得见的东西**：线程那一块的正文、工具结果的文字（direct 是我们围栏里的 JSON，
 * dsh 是官方 `dsh-tool-web` 渲染的那段）——两边都认得出网址，所以两档走出同一串调用。
 */
import type { ChatMessage, ToolDef } from '@agentsws/contracts'
import { chatContentText } from '@agentsws/contracts'
import {
  looksLikeResearch,
  renderWebAnswer,
  researchQueryOf,
  urlsIn,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
} from '@agentsws/stand-ins'
import type { ScriptedTurn } from './scripted.js'

const BLOCK = /^\[([a-z_]+):([^\]]*)\]\n?([\s\S]*)$/

function threadBody(messages: readonly ChatMessage[]): string {
  for (const m of messages) {
    if (m.role === 'tool' || m.role === 'assistant') continue
    const match = BLOCK.exec(chatContentText(m.content))
    if (match?.[1] === 'thread' && match[3] !== undefined) return match[3]
  }
  return ''
}

function toolTexts(messages: readonly ChatMessage[], name: string): string[] {
  return messages
    .filter((m) => m.role === 'tool' && (m.name === name || m.name?.endsWith(`.${name}`)))
    .map((m) => chatContentText(m.content))
}

/** 工具结果是不是一次失败（direct 的 `[error: …]` / `[blocked: …]`，官方的 `Error: …`）。 */
function failed(text: string): boolean {
  return /^\[(error|blocked)\b/.test(text) || /\bError:/.test(text)
}

/** 这一轮要不要走网页那一套；要就回这一轮说什么。 */
export function webBrainTurn(
  messages: readonly ChatMessage[],
  tools: readonly ToolDef[] | undefined,
): ScriptedTurn | undefined {
  const names = new Set((tools ?? []).map((t) => t.name))
  if (!names.has(WEB_SEARCH_TOOL)) return undefined
  const body = threadBody(messages)
  if (!looksLikeResearch(body)) return undefined
  const query = researchQueryOf(body)
  const searched = toolTexts(messages, WEB_SEARCH_TOOL)
  if (searched.length === 0) {
    return { tool_calls: [{ name: WEB_SEARCH_TOOL, input: { queries: [query] } }] }
  }
  const last = searched[searched.length - 1] ?? ''
  if (failed(last)) {
    return { text: renderWebAnswer({ query, sources: [], failed: '网页搜索没走通' }) }
  }
  const urls = urlsIn(last)
  const fetched = toolTexts(messages, WEB_FETCH_TOOL)
  const first = urls[0]
  if (names.has(WEB_FETCH_TOOL) && fetched.length === 0 && first !== undefined) {
    return { tool_calls: [{ name: WEB_FETCH_TOOL, input: { url: first } }] }
  }
  const fetchText = fetched[fetched.length - 1]
  return {
    text: renderWebAnswer({
      query,
      sources: urls.map((url) => ({ url })),
      ...(fetchText === undefined || first === undefined
        ? {}
        : { fetched: { url: first, status: failed(fetchText) ? 0 : 200 } }),
    }),
  }
}
