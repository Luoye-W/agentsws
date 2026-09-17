/**
 * realistic 档的诊断设施（WP87）。
 *
 * 真模型跑回归题时，"没过"这件事本身没有信息量——要能回答**为什么没过**：
 * 模型这一轮拿到了哪些工具、回了什么形状、上游是不是 400、是不是一轮就没预算了。
 * 所以这一档额外落三样东西（都在 `--report` 目录里，都不含正文之外的凭据）：
 *
 * 1. `<场景>.events.jsonl`——每次运行的 `RunEvent` 序列（`tool.call` / `tool.result` /
 *    `progress` / `text.delta` / `turn.*`），第一行是这条场景的运行摘要。
 * 2. `<场景>.model.jsonl`——每次模型往返的**摘要**：请求消息条数与角色分布、工具清单、
 *    回来的 tool_calls 名字、停在哪一步、usage。**不含消息正文、不含凭据**。
 * 3. `diagnostics.json` / 报告末尾的汇总——每条通过 / 失败 / 原因、总 token 与 cost_base、
 *    真模型调用次数。
 *
 * 另一半是"不一错全停"：一条场景抛错只算**这条**失败（{@link errorReport}），
 * 后面的照跑。fast 档语义不动——抛出即整次失败仍然是 fast 档的行为。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, Iso8601, RunEvent } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { Evidence } from './evidence.js'
import type { ScenarioReport } from './report.js'
import type { RuntimeName } from './runtime-name.js'
import type { Scenario, Tier } from './scenario/types.js'

/**
 * 凭据遮罩。摘要里本来就不写消息正文，但上游 4xx 的错误体会被 provider 原样带回
 * （`provider http 400: {...}`）——万一它把 key 回显了，这里兜一道。
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
}

/** 一次模型往返的摘要。**只有形状与计数，没有消息正文、没有凭据**。 */
export interface ModelTraceRecord {
  seq: number
  /** 虚拟时钟上的时刻（与事件日志对得上）。 */
  at: Iso8601
  run_id: string
  purpose: string
  assignment_id: string
  model?: string
  request: {
    messages: number
    /** 角色分布：`{system:1,user:1,assistant:2,tool:2}` */
    roles: Record<string, number>
    /** 消息正文总字数（不含正文本身） */
    content_chars: number
    /** 这一轮模型手上有哪些工具（原名，不是出站的合规名） */
    tools: string[]
    tool_choice?: string
    /** 带回去的历史里有几条 assistant 工具调用 / 几条 reasoning（思考模型多轮的硬要求） */
    carried_tool_calls: number
    carried_reasoning: number
    max_cost_base?: number
  }
  response?: {
    text_chars: number
    reasoning_chars: number
    /** 模型这一轮点名要调的工具（名字，不含入参） */
    tool_calls: string[]
    /**
     * 这一轮停在哪儿。契约的 `Completion` 没有 `finish_reason`（见报告里的契约建议），
     * 所以按返回形状推：有 tool_calls / 只有文本 / 什么都没有。
     */
    stop: 'tool_calls' | 'text' | 'empty'
    usage: { input_tokens: number; output_tokens: number; cached_tokens: number; cost_base: number }
    duration_ms: number
  }
  /** 这一轮直接抛了（上游 400 / 超时 / 预算冻结）。message 已遮罩。 */
  error?: { code?: string; message: string }
}

export interface ModelTrace {
  records: ModelTraceRecord[]
}

const roleHistogram = (messages: readonly ChatMessage[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const m of messages) out[m.role] = (out[m.role] ?? 0) + 1
  return out
}

/**
 * 把一个网关包一层，记下每次 `complete` 的摘要。
 *
 * 为什么包在**网关**而不是 provider 上：只有网关这一层拿得到 `meta`
 * （run_id / purpose / assignment），没有它就没法把"模型为什么没调工具"
 * 对回到某一条运行上。包装是显式委托——网关是个 class，展开它会丢原型方法。
 */
export function traceGateway(inner: ModelGatewayApi, trace: ModelTrace): ModelGatewayApi {
  return {
    async complete(req) {
      const seq = trace.records.length + 1
      const started = Date.now()
      const base: Omit<ModelTraceRecord, 'response' | 'error'> = {
        seq,
        at: new Date().toISOString() as Iso8601,
        run_id: req.meta.run_id,
        purpose: req.meta.purpose,
        assignment_id: req.meta.assignment_id,
        ...(req.model === undefined ? {} : { model: `${req.model.provider}/${req.model.model}` }),
        request: {
          messages: req.messages.length,
          roles: roleHistogram(req.messages),
          content_chars: req.messages.reduce((n, m) => n + m.content.length, 0),
          tools: (req.tools ?? []).map((t) => t.name),
          ...(req.tool_choice === undefined
            ? {}
            : {
                tool_choice:
                  req.tool_choice.type === 'tool'
                    ? `tool:${req.tool_choice.name ?? ''}`
                    : req.tool_choice.type,
              }),
          carried_tool_calls: req.messages.filter((m) => (m.tool_calls ?? []).length > 0).length,
          carried_reasoning: req.messages.filter((m) => m.reasoning !== undefined).length,
          ...(req.max_cost_base === undefined ? {} : { max_cost_base: req.max_cost_base }),
        },
      }
      try {
        const res = await inner.complete(req)
        const calls = res.tool_calls ?? []
        trace.records.push({
          ...base,
          at: base.at,
          model: `${res.model.provider}/${res.model.model}`,
          response: {
            text_chars: res.text.length,
            reasoning_chars: res.reasoning?.length ?? 0,
            tool_calls: calls.map((c) => c.name),
            stop: calls.length > 0 ? 'tool_calls' : res.text.trim().length > 0 ? 'text' : 'empty',
            usage: { ...res.usage },
            duration_ms: Date.now() - started,
          },
        })
        return res
      } catch (err) {
        const e = err as { code?: string; message?: string }
        trace.records.push({
          ...base,
          error: {
            ...(typeof e.code === 'string' ? { code: e.code } : {}),
            message: maskSecrets(e.message ?? String(err)).slice(0, 600),
          },
        })
        throw err
      }
    },
    embed: (texts, meta, model) => inner.embed(texts, meta, model),
    transcribe: (req, meta, model) => inner.transcribe(req, meta, model),
    usage: (filter) => inner.usage(filter),
    budget: (scope) => inner.budget(scope),
    records: () => inner.records(),
    reconfigure: (next) => inner.reconfigure(next),
    providers: () => inner.providers(),
  }
}

/* ── 落盘 ──────────────────────────────────────────────────────────── */

/** 报告目录里一条场景的文件名前缀（`aftersales/x` → `aftersales__x`）。 */
export const fileStem = (scenarioId: string): string => scenarioId.replace(/[/\\]/g, '__')

const writeJsonl = (file: string, rows: readonly unknown[]): void => {
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : ''))
}

/**
 * `<场景>.events.jsonl`：第一行摘要，之后每行一条 `RunEvent`（带 run_id 与序号）。
 * 看"模型为什么没起草"就是从这里一行行往下读。
 */
export function writeEventsJsonl(dir: string, scenarioId: string, evidence: Evidence): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${fileStem(scenarioId)}.events.jsonl`)
  const rows: unknown[] = [
    {
      kind: 'summary',
      scenario: scenarioId,
      workspace_id: evidence.workspace_id,
      start: evidence.start,
      end: evidence.end,
      runs: evidence.runs.length,
      inbound: evidence.inbound.length,
      approvals: evidence.approvals.map((a) => ({ id: a.id, kind: a.kind, state: a.state })),
      emails_sent: evidence.emails.length,
      blocked: evidence.blocked.map((b) => b.rule),
    },
  ]
  for (const [i, run] of evidence.runs.entries()) {
    rows.push({
      kind: 'run',
      index: i,
      run_id: run.request.id,
      status: run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
      run_kind: run.request.kind,
      tools: [...run.request.tools.allow],
      budget: run.request.budget,
      ...(run.failure === undefined
        ? {}
        : { failure: { ...run.failure, message: maskSecrets(run.failure.message) } }),
      ...(run.result === undefined
        ? {}
        : {
            result: {
              status: run.result.status,
              summary: run.result.summary,
              outputs: run.result.outputs.map((o) => o.kind),
              usage: run.result.usage,
              ...(run.result.no_stage === undefined ? {} : { no_stage: run.result.no_stage }),
            },
          }),
    })
    for (const [seq, e] of run.events.entries()) {
      rows.push({ kind: 'event', run_id: run.request.id, seq, ...(e as RunEvent) })
    }
  }
  writeJsonl(file, rows)
  return file
}

/** `<场景>.model.jsonl`：这条场景里每一次模型往返的摘要。 */
export function writeModelJsonl(
  dir: string,
  scenarioId: string,
  records: readonly ModelTraceRecord[],
): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${fileStem(scenarioId)}.model.jsonl`)
  writeJsonl(file, records)
  return file
}

/** 追加一行到 jsonl（预算停在半路时也留下已跑的部分）。 */
export function appendJsonl(file: string, row: unknown): void {
  appendFileSync(file, `${JSON.stringify(row)}\n`)
}

/* ── 一条场景失败 ≠ 整次运行停 ────────────────────────────────────── */

/** 场景抛错时的最小报告：它算**这一条**失败，后面的照跑。 */
export function errorReport(input: {
  scenario: Scenario
  tier: Tier
  seed: number
  runtime: RuntimeName
  error: unknown
}): ScenarioReport {
  const e = input.error as { code?: string; message?: string }
  const code = typeof e.code === 'string' ? e.code : 'error'
  const message = maskSecrets(e.message ?? String(input.error))
  const at = input.scenario.clock.start
  return {
    id: input.scenario.id,
    pack: input.scenario.dataset.pack,
    tier: input.tier,
    seed: input.seed,
    runtime: input.runtime,
    passed: false,
    clock: { start: at, end: at, virtual_ms: 0 },
    counts: {
      events: 0,
      runs: 0,
      inbound: 0,
      approvals: 0,
      changes: 0,
      outbound_observations: 0,
      emails_sent: 0,
    },
    invariants: [],
    // 门禁把它当一条没过的断言，报告里能一眼看见原因
    expectations: [{ key: 'scenario_error', ok: false, detail: `[${code}] ${message}` }],
    metrics: {},
    notes: [`scenario_error[${code}] ${message}`],
  }
}

/* ── 汇总 ──────────────────────────────────────────────────────────── */

export interface ScenarioDiagnostic {
  id: string
  passed: boolean
  /** 没过的原因（不变量 / 断言 / 抛错），一条一句。 */
  reasons: string[]
  /** 这条场景打了多少次真模型、花了多少 */
  model_calls: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cost_base: number
  /** 真模型在这条场景里一共点名了哪些工具（去重） */
  tools_called: string[]
  /** 这条场景里模型往返的停法分布 */
  stops: Record<string, number>
  /** 上游报错的次数与第一条报错（已遮罩） */
  errors: number
  first_error?: string
  events_file?: string
  model_file?: string
}

export interface SuiteDiagnostics {
  scenarios: ScenarioDiagnostic[]
  total: {
    scenarios: number
    passed: number
    failed: number
    model_calls: number
    input_tokens: number
    output_tokens: number
    cached_tokens: number
    cost_base: number
  }
}

export function diagnoseScenario(input: {
  report: ScenarioReport
  records: readonly ModelTraceRecord[]
  events_file?: string
  model_file?: string
}): ScenarioDiagnostic {
  const { report, records } = input
  const reasons: string[] = []
  for (const inv of report.invariants) {
    if (inv.ok) continue
    reasons.push(`不变量 ${inv.name}：${inv.violations.map((v) => v.message).join(' | ')}`)
  }
  for (const exp of report.expectations) {
    if (!exp.ok) reasons.push(`断言 ${exp.key}：${exp.detail}`)
  }
  const stops: Record<string, number> = {}
  const tools = new Set<string>()
  let input_tokens = 0
  let output_tokens = 0
  let cached_tokens = 0
  let cost_base = 0
  let errors = 0
  let first_error: string | undefined
  for (const r of records) {
    if (r.response !== undefined) {
      stops[r.response.stop] = (stops[r.response.stop] ?? 0) + 1
      for (const t of r.response.tool_calls) tools.add(t)
      input_tokens += r.response.usage.input_tokens
      output_tokens += r.response.usage.output_tokens
      cached_tokens += r.response.usage.cached_tokens
      cost_base += r.response.usage.cost_base
    }
    if (r.error !== undefined) {
      errors += 1
      first_error ??= `[${r.error.code ?? 'error'}] ${r.error.message}`
    }
  }
  return {
    id: report.id,
    passed: report.passed,
    reasons,
    model_calls: records.length,
    input_tokens,
    output_tokens,
    cached_tokens,
    cost_base: Math.round(cost_base * 1e6) / 1e6,
    tools_called: [...tools].sort(),
    stops,
    errors,
    ...(first_error === undefined ? {} : { first_error }),
    ...(input.events_file === undefined ? {} : { events_file: input.events_file }),
    ...(input.model_file === undefined ? {} : { model_file: input.model_file }),
  }
}

export function summarizeDiagnostics(rows: readonly ScenarioDiagnostic[]): SuiteDiagnostics {
  const total = rows.reduce(
    (acc, r) => ({
      scenarios: acc.scenarios + 1,
      passed: acc.passed + (r.passed ? 1 : 0),
      failed: acc.failed + (r.passed ? 0 : 1),
      model_calls: acc.model_calls + r.model_calls,
      input_tokens: acc.input_tokens + r.input_tokens,
      output_tokens: acc.output_tokens + r.output_tokens,
      cached_tokens: acc.cached_tokens + r.cached_tokens,
      cost_base: acc.cost_base + r.cost_base,
    }),
    {
      scenarios: 0,
      passed: 0,
      failed: 0,
      model_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      cost_base: 0,
    },
  )
  return {
    scenarios: [...rows],
    total: { ...total, cost_base: Math.round(total.cost_base * 1e6) / 1e6 },
  }
}

/** 报告末尾那一段：每条通过 / 失败 / 原因、token 与花费、真模型调用次数。 */
export function diagnosticsMarkdown(d: SuiteDiagnostics): string {
  const lines: string[] = []
  lines.push('## realistic 诊断（每条为什么这样）')
  lines.push('')
  lines.push(
    `真模型调用 **${d.total.model_calls}** 次｜输入 ${d.total.input_tokens} token（命中缓存 ${d.total.cached_tokens}）｜` +
      `输出 ${d.total.output_tokens} token｜合计 cost_base ${d.total.cost_base}｜` +
      `${d.total.passed} 通过 / ${d.total.failed} 失败`,
  )
  lines.push('')
  lines.push('| 场景 | 结果 | 模型调用 | in/out token | cost_base | 模型点过的工具 | 停法 | 原因 |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const r of d.scenarios) {
    const stops = Object.entries(r.stops)
      .map(([k, v]) => `${k}×${v}`)
      .join(' ')
    const why =
      r.reasons.length === 0
        ? r.errors > 0
          ? `上游报错 ${r.errors} 次：${r.first_error ?? ''}`
          : '—'
        : r.reasons.join('；')
    lines.push(
      `| \`${r.id}\` | ${r.passed ? '✓' : '✗'} | ${r.model_calls} | ${r.input_tokens}/${r.output_tokens} | ` +
        `${r.cost_base} | ${r.tools_called.join(', ') || '—'} | ${stops || '—'} | ${why.replace(/\|/g, '\\|').slice(0, 400)} |`,
    )
  }
  lines.push('')
  lines.push(
    '每条场景的细节在同目录的 `<场景>.events.jsonl`（运行事件）与 `<场景>.model.jsonl`（模型往返摘要，不含正文）。',
  )
  return lines.join('\n')
}
