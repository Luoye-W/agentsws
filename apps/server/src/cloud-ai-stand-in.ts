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
 *   手上有 `web_search` 工具、还没搜过时先搜一次（演示联网搜索那条路）。
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
  '随便聊可以这样用：',
  '',
  '1. 问一个随手的问题，或者让它帮你起草一段文字；',
  '2. 打开「联网搜索」查最新的公开信息，回答下面会列出来源；',
  '3. 打开「用公司资料回答」，它只按知识库里的事实卡回答，并标出处。',
  '',
  '想让某个岗位真的去做？点回复旁边的「交给岗位去做」。',
].join('\n')

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
  options: { next?: FetchLike; delayMs?: number } = {},
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
    const body = JSON.parse(String(init.body ?? '{}')) as Json
    const messages = (body.messages ?? []) as { role: string; content: unknown }[]
    const hasImage = JSON.stringify(messages).includes('"image_url"')
    const searched = messages.some((m) => m.role === 'tool')
    const tools = (body.tools ?? []) as { function?: { name?: string } }[]
    const wantsSearch = !searched && tools.some((t) => t.function?.name === 'web_search')
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const asked = typeof lastUser?.content === 'string' ? lastUser.content : '这个问题'
    const text = hasImage
      ? VISION_PROBE_WORD
      : searched
        ? `${ANSWER}\n\n（演示）刚才搜了「${asked.slice(0, 20)}」，参考了 [第一条来源](https://example.com/news/usb-c-chargers)。`
        : ANSWER
    const usage = { prompt_tokens: 120, completion_tokens: Math.ceil(text.length / 2) }
    if (body.stream !== true) return reply({ choices: [{ message: { content: text } }], usage })
    if (wantsSearch) {
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
