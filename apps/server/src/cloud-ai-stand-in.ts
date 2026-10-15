/**
 * WP188：demo 里「Agents 工坊（用积分）」那条模型来源的替身——**一个字节都不出网**。
 *
 * demo 的云地址是 {@link CLOUD_STAND_IN_BASE_URL}（`.invalid`，永远解析不出来）。关联账号走
 * `cloud-stand-in.ts`；关联之后在「设置 → 模型」里点「启用」，模型请求打的是
 * `<云地址>/v1/ai/...`——这里接住：
 *
 * - `GET /models`：两个模型；
 * - `POST /chat/completions`：带图的那一次（三步验证第 ③ 步）回约定的词；别的回一段固定的演示回答，
 *   `stream: true` 时一小段一小段地流（看得出"一个字一个字冒出来"，也停得下来）；
 *   手上有 `web_search` 工具、还没搜过时先搜一次（演示联网搜索那条路）；
 *   WP343「我的助理」：说「让 X …」时调一次派活工具，问「今天有什么要我处理」「各岗位在做什么」时
 *   调对应的只读工具，拿到结果照着说一句（演示派活与问全局那条路）。
 *
 * 别的地址原样交给真 fetch（用户在 demo 里填了自己的 key，照旧走他的）。生产路径从不调它。
 */
import type { FetchLike } from '@agentsws/model-gateway'
import { VISION_PROBE_WORD } from '@agentsws/model-gateway'
import { CLOUD_STAND_IN_BASE_URL } from './cloud-stand-in.js'

/** demo 里联网搜索的替身结果（不出网）。 */
export async function demoWebSearch(
  query: string,
): Promise<{ sources: { url: string; title: string; snippet: string }[] }> {
  return {
    sources: [
      {
        url: 'https://example.com/news/usb-c-chargers',
        title: `「${query}」相关报道（演示）`,
        snippet: '演示数据：氮化镓充电器今年出货继续增长，65W 是最常见的规格。',
      },
      {
        url: 'https://example.org/guide/gan-65w',
        title: '65W 氮化镓充电器选购指南（演示）',
        snippet: '演示数据：看协议支持、看多口分配、看发热。',
      },
    ],
  }
}

const ANSWER = [
  '这是**演示环境**里的回答（「Agents 工坊（用积分）」替身，不连真模型）。',
  '',
  '「我的助理」可以这样用：',
  '',
  '1. 问一个随手的问题，或者让它帮你起草一段文字；',
  '2. 问「各岗位在做什么」「今天有什么要我处理的」，它去查了再答；',
  '3. 直接交代一件事（「让客服把今天的工单过一遍」），它交给对应的岗位去做，做完在这里告诉你。',
].join('\n')

/** WP343：岗位那边做完时那半句（交过来的话里可能只有一个线程引用，那就不复述）。 */
function demoDoneOf(asked: string): string {
  const said = asked
    .replace(/\[thread:[^\]]*\]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return said === '' ? '' : `：${said.slice(0, 40)}`
}

/** WP343：演示里助理那几个工具怎么被点到（按用户那句话认）。 */
function assistantCall(
  asked: string,
  tools: readonly string[],
): { name: string; args: Record<string, unknown> } | undefined {
  if (tools.includes('hand_to_position') && /^(让|叫|请)/u.test(asked.trim()))
    return { name: 'hand_to_position', args: { text: asked.trim() } }
  if (tools.includes('my_pending_cards') && /要我处理|要我定|等我/u.test(asked))
    return { name: 'my_pending_cards', args: {} }
  if (tools.includes('work_overview') && /在做什么|做了什么|在忙什么/u.test(asked))
    return { name: 'work_overview', args: {} }
  if (tools.includes('recent_sent') && /发出去|发了什么/u.test(asked))
    return { name: 'recent_sent', args: {} }
  return undefined
}

/** WP343：演示里拿到助理工具的结果后说的那一句（照结果说，不编）。 */
function assistantSay(name: string, content: string): string {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(content) as Record<string, unknown>
  } catch {
    return content
  }
  if (name === 'hand_to_position') {
    if (parsed.dispatched === true)
      return `好的，交给了${String(parsed.position)}${parsed.duty === undefined ? '' : ` · ${String(parsed.duty)}`}。做完或要你拍板时，我在这里告诉你。`
    const c = (parsed.candidates as string[] | undefined) ?? []
    return c.length === 0
      ? String(parsed.reason ?? '没交出去。')
      : `${String(parsed.reason ?? '拿不准')}——交给哪个？${c.join(' / ')}`
  }
  if (name === 'my_pending_cards') {
    const cards = (parsed.cards as { title: string; position?: string }[] | undefined) ?? []
    return cards.length === 0
      ? '今天没有要你处理的卡。'
      : [
          `有 ${cards.length} 张要你处理：`,
          '',
          ...cards
            .slice(0, 5)
            .map((c) => `- ${c.title}${c.position === undefined ? '' : `（${c.position}）`}`),
        ].join('\n')
  }
  if (name === 'work_overview') {
    const rows =
      (parsed.positions as { name: string; open: number; waiting_cards: number }[] | undefined) ??
      []
    return rows.length === 0
      ? '你还没有岗位。'
      : [
          '| 岗位 | 在办 | 等你定 |',
          '|---|---|---|',
          ...rows.map((r) => `| ${r.name} | ${r.open} | ${r.waiting_cards} |`),
        ].join('\n')
  }
  const sent = (parsed.sent as { channel: string; gist: string }[] | undefined) ?? []
  return sent.length === 0
    ? '最近没有发出去的。'
    : sent
        .slice(0, 5)
        .map((r) => `- ${r.channel}：${r.gist}`)
        .join('\n')
}

type Json = Record<string, unknown>

const reply = (body: unknown): Awaited<ReturnType<FetchLike>> => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

/** 把一段回答切成 SSE：每块几个字，块与块之间停一小会儿。 */
function sseOf(
  chunks: Json[],
  delayMs: number,
  signal?: AbortSignal,
): Awaited<ReturnType<FetchLike>> {
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n']
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const line of lines) {
        if (signal?.aborted === true) break
        controller.enqueue(encoder.encode(line))
        await new Promise((r) => setTimeout(r, delayMs))
      }
      controller.close()
    },
  })
  return { ok: true, status: 200, body, json: async () => ({}), text: async () => lines.join('') }
}

export function cloudAiStandInFetch(
  options: {
    next?: FetchLike
    delayMs?: number
    /**
     * WP194：对话之前先问一声「这个人本月额度还够不够」（demo 里接 `cloud-stand-in` 的 `aiGate`）。
     * 回一个 `{ status, body }` 就照它回（402 + 那句人话），不回就照常答。
     */
    gate?: (headers: Record<string, string>) => { status: number; body: unknown } | undefined
  } = {},
): FetchLike {
  const base = `${CLOUD_STAND_IN_BASE_URL}/v1/ai`
  const next = options.next ?? (globalThis.fetch as unknown as FetchLike)
  return async (url, init) => {
    if (!url.startsWith(base)) return next(url, init)
    const path = url.slice(base.length)
    if (path === '/models')
      return reply({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-pro' }] })
    if (path !== '/chat/completions')
      return { ...reply({ code: 'not_found' }), ok: false, status: 404 }
    const blocked = options.gate?.(init.headers ?? {})
    if (blocked !== undefined) return { ...reply(blocked.body), ok: false, status: blocked.status }
    const body = JSON.parse(String(init.body ?? '{}')) as Json
    const messages = (body.messages ?? []) as { role: string; content: unknown }[]
    const hasImage = JSON.stringify(messages).includes('"image_url"')
    const searched = messages.some((m) => m.role === 'tool')
    const tools = (body.tools ?? []) as { function?: { name?: string } }[]
    const toolNames = tools.map((t) => t.function?.name ?? '')
    const wantsSearch = !searched && toolNames.includes('web_search')
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const asked = typeof lastUser?.content === 'string' ? lastUser.content : '这个问题'
    // WP343：助理的工具（先点一次，拿到结果照着说）
    const lastTool = messages.at(-1) as
      | { role: string; content: unknown; name?: string }
      | undefined
    const assistantDone =
      lastTool?.role === 'tool' && lastTool.name !== undefined && lastTool.name !== 'web_search'
        ? assistantSay(lastTool.name, String(lastTool.content))
        : undefined
    const wantsAssistant =
      searched || hasImage || body.stream !== true ? undefined : assistantCall(asked, toolNames)
    if (wantsAssistant !== undefined)
      return sseOf(
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_demo_assistant',
                      function: {
                        name: wantsAssistant.name,
                        arguments: JSON.stringify(wantsAssistant.args),
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [], usage: { prompt_tokens: 80, completion_tokens: 12 } },
        ],
        0,
        init.signal,
      )
    // WP343：岗位那边的运行（不是助理对话）回一句「做完了」，别把助理的使用说明当成岗位的回答
    const system = messages.find((m) => m.role === 'system')
    const fromChat = typeof system?.content !== 'string' || /我的助理|随便聊/u.test(system.content)
    const text = hasImage
      ? VISION_PROBE_WORD
      : assistantDone !== undefined
        ? assistantDone
        : !fromChat && !searched
          ? `（演示）按岗位的规矩做好了${demoDoneOf(asked)}。没有要你拍板的。`
          : searched
            ? `${ANSWER}\n\n（演示）刚才搜了「${asked.slice(0, 20)}」，参考了 [第一条来源](https://example.com/news/usb-c-chargers)。`
            : ANSWER
    const usage = { prompt_tokens: 120, completion_tokens: Math.ceil(text.length / 2) }
    if (body.stream !== true) return reply({ choices: [{ message: { content: text } }], usage })
    if (wantsSearch && wantsAssistant === undefined) {
      return sseOf(
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_demo',
                      function: {
                        name: 'web_search',
                        arguments: JSON.stringify({ query: asked.slice(0, 40) }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [], usage: { prompt_tokens: 80, completion_tokens: 12 } },
        ],
        0,
        init.signal,
      )
    }
    const pieces = text.match(/[\s\S]{1,3}/g) ?? []
    return sseOf(
      [...pieces.map((p) => ({ choices: [{ delta: { content: p } }] })), { choices: [], usage }],
      options.delayMs ?? 25,
      init.signal,
    )
  }
}
