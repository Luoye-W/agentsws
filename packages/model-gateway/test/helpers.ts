import type { Clock, ModelMeta, ModelProvider } from '@agentsws/contracts'
import type { ModelGatewayEvent, ModelGatewayPolicy } from '../src/index.js'

export const AT = '2026-09-09T10:00:00Z'

export const fixedClock = (at: string = AT): Clock => ({ now: () => at })

export const meta = (over: Partial<ModelMeta> = {}): ModelMeta => ({
  workspace_id: 'ws_1',
  assignment_id: 'asg_1',
  role_id: 'role_aftersales',
  run_id: 'run_1',
  purpose: 'run',
  ...over,
})

export const prices: ModelGatewayPolicy['prices'] = {
  'stub/stub-v1': { in: 1_000, out: 2_000, cached: 100 },
  'stub/stub-backup': { in: 1_000, out: 2_000, cached: 100 },
  'openai/gpt-x': { in: 5_000, out: 10_000, cached: 500 },
  'deepseek/deepseek-chat': { in: 1_000, out: 2_000, cached: 100 },
  'cloud_brain/stub-v1': { in: 1_000, out: 2_000, cached: 100 },
}

export const policy = (over: Partial<ModelGatewayPolicy> = {}): ModelGatewayPolicy => ({
  default: { provider: 'stub', model: 'stub-v1', region: 'cn' },
  data_residency: 'cn',
  prices,
  ...over,
})

export interface Recorder {
  events: ModelGatewayEvent[]
  sink: (e: ModelGatewayEvent) => void
  ofType: (type: string) => ModelGatewayEvent[]
}

export const recorder = (): Recorder => {
  const events: ModelGatewayEvent[] = []
  return {
    events,
    sink: (e) => {
      events.push(e)
    },
    ofType: (type) => events.filter((e) => e.type === type),
  }
}

/** 固定 usage 的替身 provider，用来精确控制花费。 */
export const fixedProvider = (args: {
  ref: ModelProvider['ref']
  input?: number
  output?: number
  cached?: number
  gate?: Promise<void>
  fail?: () => never
}): ModelProvider => ({
  ref: args.ref,
  async complete() {
    if (args.gate !== undefined) await args.gate
    if (args.fail !== undefined) args.fail()
    return {
      text: 'fixed',
      usage: {
        input_tokens: args.input ?? 0,
        output_tokens: args.output ?? 0,
        cached_tokens: args.cached ?? 0,
        cost_base: 0,
      },
    }
  },
})

export const systemPrompt = (text: string) => ({ role: 'system' as const, content: text })
export const userPrompt = (text: string) => ({ role: 'user' as const, content: text })
