/**
 * WP511（决策 1547，docs/115 §4 第 5 条）：助理小结 / 记忆的**离线评测**。
 *
 * 用合成的生意长对话（`assistant-eval-scenarios.ts`）走**真的**助理那一条路（`createFreeChatPort` 的四层：当前段原话、
 * 段内压缩、话题小结、记忆、翻旧账 / 读附件 / 打开那一段），在约定的时间点问探针，量：
 * - 召回：探针答对的比例；误记：说成了被改掉的旧口径 / 没定的假设（且没答对）；
 * - 每轮输入 / 命中 / 没命中 token、花费估算；
 * 并和「不压缩全量」（整段对话原文一次塞进去问）对照。
 *
 * 模型由调用方给：
 * - **替身**（{@link evalStubProvider}，默认）：不花钱、确定。它「读上下文找关键词」作答，找不到就像真模型那样先翻旧账 / 读附件；
 *   小结是抽取式的。替身量的是**管道**（信息有没有留在上下文里、取不取得回来），不是模型写小结的本事；
 * - **真模型**：只由 `scripts/eval-assistant-context.mjs` 在 Luoye 点头之后跑（先估费，见 {@link estimateCost}）。
 */
import type { FreeChatFrame } from '@agentsws/api'
import type { ChatMessage, ModelProvider } from '@agentsws/contracts'
import { createModelGateway } from '@agentsws/model-gateway'
import type { Assistant } from './assistant.js'
import type { EvalProbe, EvalScenario } from './assistant-eval-scenarios.js'
import { createFreeChatPort, TURN_TAIL_HEAD } from './free-chat.js'
import { createFreeChatStore } from './free-chat-store.js'

/** 一次模型调用记下的用量（替身按估算报，真模型照它报的）。 */
export interface EvalCall {
  kind: 'chat' | 'summary' | 'full'
  input_tokens: number
  cached_tokens: number
  output_tokens: number
}

export interface EvalProbeResult {
  id: string
  kind: EvalProbe['kind']
  answer: string
  correct: boolean
  /** 误记：说了不该记住的、而且没答对。 */
  wrong: boolean
}

export interface EvalRun {
  scenario: string
  mode: 'layers' | 'full'
  probes: EvalProbeResult[]
  calls: EvalCall[]
}

/** 比较时的归一：全角半角、空白都去掉。 */
const norm = (s: string): string => s.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()

export function scoreAnswer(
  probe: EvalProbe,
  answer: string,
): { correct: boolean; wrong: boolean } {
  const a = norm(answer)
  const correct = probe.expect.some((e) => a.includes(norm(e)))
  const wrong = !correct && (probe.forbid ?? []).some((f) => a.includes(norm(f)))
  return { correct, wrong }
}

/** 替身的 token 估算：汉字约 0.6、其余 4 个字符 1 个（与 DeepSeek 官方口径接近）。 */
export function evalTokens(text: string): number {
  let wide = 0
  for (const ch of text) if ((ch.codePointAt(0) ?? 0) > 0x2e7f) wide += 1
  return Math.ceil(wide * 0.6 + (text.length - wide) / 4)
}

const textOf = (m: ChatMessage): string =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')

const isSummaryCall = (messages: readonly ChatMessage[]): boolean => {
  const sys = messages[0] === undefined ? '' : textOf(messages[0])
  return sys.includes('话题小结') || sys.includes('压缩前半段')
}

/**
 * 替身模型：
 * - 写小结：把逐字稿里带数字 / 「定」「改」「交给」「喜欢」的句子抽出来（最多 12 句，保持先后）——有损，像真模型一样会丢；
 * - 回答探针：在它看得到的上下文里（系统提示、原话、工具结果；不含这一问本身与末尾附加）找含全部关键词的**最后**一行；
 *   找不到就照真模型的路数先读附件（上下文里有附件编号）、再翻旧账；还找不到说没找到；
 * - 其余的话回一句短的；
 * - 用量：输入按 {@link evalTokens} 估，命中缓存按和此前请求最长公共前缀估（DeepSeek 按前缀命中）。
 */
export function evalStubProvider(probes: readonly EvalProbe[], calls: EvalCall[]): ModelProvider {
  const byAsk = new Map(probes.map((p) => [p.ask, p]))
  const history: string[] = []
  const usage = (
    messages: readonly ChatMessage[],
    tools: unknown,
    out: string,
    kind: EvalCall['kind'],
  ) => {
    const flat = `${JSON.stringify(tools ?? [])}\n${messages.map(textOf).join('\n')}`
    let lcp = 0
    for (const h of history.slice(-30)) {
      let i = 0
      const n = Math.min(h.length, flat.length)
      while (i < n && h.charCodeAt(i) === flat.charCodeAt(i)) i += 1
      lcp = Math.max(lcp, i)
    }
    history.push(flat)
    const input = evalTokens(flat)
    const one: EvalCall = {
      kind,
      input_tokens: input,
      cached_tokens: Math.floor((input * lcp) / Math.max(1, flat.length)),
      output_tokens: evalTokens(out),
    }
    calls.push(one)
    return {
      input_tokens: one.input_tokens,
      output_tokens: one.output_tokens,
      cached_tokens: one.cached_tokens,
    }
  }
  return {
    ref: { provider: 'deepseek', model: 'deepseek-flash' },
    capabilities: { vision: false, image_generation: false },
    async complete(req) {
      const messages = req.messages
      const tools = (req.tools ?? []).map((t) => t.name)
      if (isSummaryCall(messages)) {
        const body = textOf(messages.at(-1) as ChatMessage)
        const keep = body
          .split('\n')
          .filter((l) => /\d|定|改|交给|喜欢|习惯|附件/u.test(l))
          .slice(-12)
          .map((l) => `- ${l.replace(/^[^：:]*[：:]/u, '').slice(0, 120)}`)
        const out = ['对话小结', '## 定了什么', ...(keep.length === 0 ? ['- 无'] : keep)].join('\n')
        return { text: out, usage: usage(messages, req.tools, out, 'summary') }
      }
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const asked =
        (lastUser === undefined ? '' : textOf(lastUser)).split(`\n\n${TURN_TAIL_HEAD}`)[0] ?? ''
      const probe = byAsk.get(asked.trim())
      const reply = (out: string, kind: EvalCall['kind'] = 'chat') => {
        req.on_delta?.(out)
        return { text: out, usage: usage(messages, req.tools, out, kind) }
      }
      if (probe === undefined) return reply('好的，记下了，按你说的办。')
      // 看得到的上下文：除这一问本身以外的全部（工具结果也算）
      const seen = messages
        .filter((m) => m !== lastUser)
        .map(textOf)
        .join('\n')
        .split(TURN_TAIL_HEAD)
        .join('\n')
      // 工具结果开头会回显查询词（「里含「交给 社媒」的…」），先去掉，免得把回显当成答案
      const echo = `「${probe.keys.join(' ')}」`
      const lines = seen
        .split(echo)
        .join('')
        .split(/\n|；|。/u)
        .filter((l) => probe.keys.every((k) => l.includes(k)))
      const found = lines.at(-1)
      if (found !== undefined) return reply(`根据记录：${found.trim()}`)
      const done = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.name))
      const ref = /编号 (fmsg_[^\s；，,）)]+)/u.exec(seen)?.[1]
      const call = (name: string, input: Record<string, unknown>) => {
        const out = { text: '', tool_calls: [{ id: `call_${calls.length}`, name, input }] }
        return { ...out, usage: usage(messages, req.tools, '', 'chat') }
      }
      if (ref !== undefined && tools.includes('read_attachment') && !done.has('read_attachment'))
        return call('read_attachment', { ref, query: probe.keys.join(' ') })
      if (tools.includes('recall_conversation') && !done.has('recall_conversation'))
        return call('recall_conversation', { query: probe.keys.join(' ') })
      return reply('没找到这件事的记录。')
    },
  }
}

const evalAssistant = {
  tools: () => [],
  promptLines: async () => ['用户的岗位：', '- 客服', '- 社媒运营', '- 网站运营'],
  call: async () => ({ content: '{}' }),
  fanout: {},
  direct: async () => ({ reason: '评测里不派活' }),
  state: async () => ({ suggestions: [], targets: [] }),
  progressOf: async () => [],
} as unknown as Assistant

export interface EvalOptions {
  /** 模型窗口（小一点才压得出来；默认 12K → 原话预算 6K）。 */
  window?: number
  /** 给真模型用：换掉替身。`calls` 由调用方在 provider 里记。 */
  provider?: (probes: readonly EvalProbe[], calls: EvalCall[]) => ModelProvider
}

/**
 * 「现在的四层」：照时间顺序一句句说给助理（真的那条路），到点问探针。每句说完等后台小结写完（结果确定）。
 */
export async function runLayers(scenario: EvalScenario, opts: EvalOptions = {}): Promise<EvalRun> {
  const calls: EvalCall[] = []
  const provider = (opts.provider ?? evalStubProvider)(scenario.probes, calls)
  let now = scenario.turns[0]?.at ?? '2026-10-12T00:00:00.000Z'
  const clock = { now: () => now }
  const ref = provider.ref
  const id = `${ref.provider}/${ref.model}`
  const gateway = createModelGateway({
    providers: [provider],
    policy: { default: ref, prices: { [id]: { in: 0, out: 0, cached: 0 } } },
    clock,
    eventSink: () => undefined,
    env: {},
  })
  let n = 0
  const port = createFreeChatPort({
    clock,
    store: createFreeChatStore(),
    assistant: evalAssistant,
    gateway: async () => gateway,
    models: async () => ({
      chatChoices: () => [{ id, label: ref.model, official: false, vision: 'no' }],
      defaultRef: () => ref,
      configured: () => true,
    }),
    roleOf: () => 'common.owner',
    humanize: (e) => (e instanceof Error ? e.message : String(e)),
    newId: (prefix) => {
      n += 1
      return `${prefix}_${String(n).padStart(4, '0')}`
    },
    tzOffsetMin: 480,
    timeZone: () => 'Asia/Shanghai',
    memory: { auto: () => true, changed: () => undefined },
    contextWindow: opts.window ?? 12_000,
  })
  const actor = { workspace_id: 'ws_eval', person_id: 'per_eval', assignment_id: 'asg_eval' }
  const sid = (await port.thread?.(actor))?.session.id ?? ''
  const say = async (text: string, files?: readonly { name: string; text: string }[]) => {
    const frames: FreeChatFrame[] = []
    await port.turn(
      actor,
      {
        session_id: sid,
        text,
        ...(files === undefined
          ? {}
          : {
              files: files.map((f) => ({
                name: f.name,
                data: Buffer.from(f.text).toString('base64'),
              })),
            }),
      },
      (f) => frames.push(f),
      new AbortController().signal,
    )
    await port.idle()
    const done = frames.find((f) => f.type === 'done')
    return done?.type === 'done' ? done.message.text : ''
  }
  const events = [
    ...scenario.turns.map((t) => ({ at: t.at, turn: t })),
    ...scenario.probes.map((p) => ({ at: p.at, probe: p })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  const probes: EvalProbeResult[] = []
  for (const e of events) {
    now = e.at
    if ('turn' in e && e.turn !== undefined) await say(e.turn.text, e.turn.files)
    else if ('probe' in e && e.probe !== undefined) {
      const answer = await say(e.probe.ask)
      probes.push({ id: e.probe.id, kind: e.probe.kind, answer, ...scoreAnswer(e.probe, answer) })
    }
  }
  return { scenario: scenario.id, mode: 'layers', probes, calls }
}

/**
 * 「不压缩全量」对照：每个探针一次调用，把到那一刻为止用户说过的每一句（附件带全文）和助理那边的回一句原样塞进去
 * （1M 窗口做得到）。上限参照：这里答不对的，是模型 / 探针本身的问题，不是压缩丢的。
 */
export async function runFull(scenario: EvalScenario, opts: EvalOptions = {}): Promise<EvalRun> {
  const calls: EvalCall[] = []
  const provider = (opts.provider ?? evalStubProvider)(scenario.probes, calls)
  const probes: EvalProbeResult[] = []
  for (const p of scenario.probes) {
    const before = scenario.turns.filter((t) => t.at < p.at)
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: '你是用户的助理。按下面完整的对话记录回答最后一问；记录里没有的就说没找到。',
      },
      ...before.flatMap((t): ChatMessage[] => [
        {
          role: 'user',
          content: [t.text, ...(t.files ?? []).map((f) => `附件「${f.name}」：\n${f.text}`)].join(
            '\n\n',
          ),
        },
        { role: 'assistant', content: '好的，记下了，按你说的办。' },
      ]),
      { role: 'user', content: p.ask },
    ]
    const out = await provider.complete({
      model: provider.ref,
      messages,
      meta: {
        workspace_id: 'ws_eval' as never,
        assignment_id: 'asg_eval' as never,
        role_id: 'common.owner' as never,
        run_id: `eval_full_${p.id}` as never,
        purpose: 'free_chat',
      },
    } as never)
    const last = calls.at(-1)
    if (last !== undefined) last.kind = 'full'
    probes.push({ id: p.id, kind: p.kind, answer: out.text, ...scoreAnswer(p, out.text) })
  }
  return { scenario: scenario.id, mode: 'full', probes, calls }
}

/** 一次跑的汇总：召回、误记、调用次数、输入 / 命中 / 输出 token。 */
export function summarizeRun(run: EvalRun) {
  const sum = (f: (c: EvalCall) => number) => run.calls.reduce((a, c) => a + f(c), 0)
  const input = sum((c) => c.input_tokens)
  return {
    scenario: run.scenario,
    mode: run.mode,
    probes: run.probes.length,
    recall:
      run.probes.length === 0 ? 0 : run.probes.filter((p) => p.correct).length / run.probes.length,
    wrong: run.probes.filter((p) => p.wrong).length,
    calls: run.calls.length,
    summary_calls: run.calls.filter((c) => c.kind === 'summary').length,
    input_tokens: input,
    cached_tokens: sum((c) => c.cached_tokens),
    output_tokens: sum((c) => c.output_tokens),
    cache_ratio: input === 0 ? 0 : Math.round((sum((c) => c.cached_tokens) / input) * 1000) / 1000,
  }
}

/**
 * 估费用的单价（美元 / 百万 token，DeepSeek 官方标准时段价，取自 `packages/model-gateway/src/pricing/catalog.json`
 * 2026-09-10 那一版；优惠时段是一半）。
 */
export const EVAL_PRICES: Readonly<Record<string, { in: number; cached: number; out: number }>> = {
  'deepseek-flash': { in: 0.3, cached: 0.006, out: 1.2 },
  'deepseek-v4-pro': { in: 1.32, cached: 0.044, out: 3.96 },
}

/**
 * 按替身跑出来的 token 量估真模型要花多少（美元）。替身的回答很短，真模型的回答长得多：每次对话调用的输出按
 * `outputPerCall`（默认 300）算、小结按 `outputPerSummary`（默认 400）算，取两者里大的；命中率照替身估的
 * （DeepSeek 只承诺尽力，真跑通常更低——`cacheDiscount` 给个打折，默认按替身的 0.8 倍算命中）。
 */
export function estimateCost(
  runs: readonly EvalRun[],
  model: keyof typeof EVAL_PRICES | string,
  opts: { outputPerCall?: number; outputPerSummary?: number; cacheDiscount?: number } = {},
): { usd: number; input_tokens: number; cached_tokens: number; output_tokens: number } {
  const price = EVAL_PRICES[model] ?? EVAL_PRICES['deepseek-flash'] ?? { in: 0, cached: 0, out: 0 }
  let input = 0
  let cached = 0
  let output = 0
  for (const r of runs)
    for (const c of r.calls) {
      input += c.input_tokens
      cached += Math.floor(c.cached_tokens * (opts.cacheDiscount ?? 0.8))
      output += Math.max(
        c.output_tokens,
        c.kind === 'summary' ? (opts.outputPerSummary ?? 400) : (opts.outputPerCall ?? 300),
      )
    }
  const usd = ((input - cached) * price.in + cached * price.cached + output * price.out) / 1_000_000
  return {
    usd: Math.round(usd * 10_000) / 10_000,
    input_tokens: input,
    cached_tokens: cached,
    output_tokens: output,
  }
}

/**
 * 「不压缩全量」如果**每一轮**都这么发（不只是问探针那几次）要多少 token：第 i 轮带前面全部原话（附件全文）+ 这一句；
 * 历史只往后加，所以命中按上一轮整段算。用来和四层的每轮输入比（`runFull` 只量答不答得对）。
 */
export function fullHistoryTokens(scenario: EvalScenario, reply = '好的，记下了，按你说的办。') {
  let history = 0
  let input = 0
  let cached = 0
  const turns = [
    ...scenario.turns,
    ...scenario.probes.map((p) => ({ at: p.at, text: p.ask })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  for (const t of turns) {
    const files = 'files' in t ? ((t as { files?: { text: string }[] }).files ?? []) : []
    const said = evalTokens(t.text) + files.reduce((n, f) => n + evalTokens(f.text), 0)
    cached += history
    input += history + said
    history += said + evalTokens(reply)
  }
  return {
    turns: turns.length,
    input_tokens: input,
    cached_tokens: cached,
    last_turn_tokens: history,
  }
}
