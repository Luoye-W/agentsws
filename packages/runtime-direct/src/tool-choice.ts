import type { ChatMessage, Completion, ModelGateway, ModelMeta, ToolDef } from '@agentsws/contracts'

/** 22 的 `ModelGateway.complete` 还没有 `tool_choice`（见报告"需要契约改动"）。 */
export interface ForcedCompleteRequest {
  messages: ChatMessage[]
  tools?: ToolDef[]
  meta: ModelMeta
  seed?: number
  max_cost_base?: number
  tool_choice: { type: 'tool'; name: string }
}

/** 支持强制工具选择的网关：多这一个方法。 */
export interface ToolChoiceGateway {
  completeWithToolChoice(req: ForcedCompleteRequest): Promise<Completion>
}

export type DirectGateway = ModelGateway | (ModelGateway & ToolChoiceGateway)

export function supportsToolChoice(g: DirectGateway): g is ModelGateway & ToolChoiceGateway {
  return typeof (g as Partial<ToolChoiceGateway>).completeWithToolChoice === 'function'
}

/**
 * 在网关外面把 `tool_choice` 补上（宿主侧模拟）：强制轮拿模型的输出，
 * 若它没有调被强制的那个工具，就把这一轮**替换**成对该工具的一次调用——
 * 这正是 provider 侧 `tool_choice` 的语义（模型这一轮只能调它）。
 *
 * `inputFor` 给强制调用补参数（模型自己给了同名调用时优先用模型的）。
 * 网关原生支持 `tool_choice` 后，这个包装器可以整体删掉。
 */
export function withToolChoice(
  gateway: ModelGateway,
  inputFor?: (tool: string, messages: ChatMessage[]) => Record<string, unknown>,
): ModelGateway & ToolChoiceGateway {
  const wrapped: ModelGateway & ToolChoiceGateway = {
    complete: (req) => gateway.complete(req),
    embed: (texts, meta, model) => gateway.embed(texts, meta, model),
    usage: (filter) => gateway.usage(filter),
    budget: (scope) => gateway.budget(scope),
    async completeWithToolChoice(req) {
      const { tool_choice, ...rest } = req
      const completion = await gateway.complete(rest)
      const forced = completion.tool_calls?.find((c) => c.name === tool_choice.name)
      if (forced !== undefined) {
        return { ...completion, text: '', tool_calls: [forced] }
      }
      return {
        ...completion,
        text: '',
        tool_calls: [
          {
            id: `forced_${tool_choice.name}`,
            name: tool_choice.name,
            input: inputFor?.(tool_choice.name, req.messages) ?? {},
          },
        ],
      }
    },
  }
  return wrapped
}
