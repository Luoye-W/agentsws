/**
 * WP179（Luoye 09-29「官方功能优先」）：把**官方网页搜索与抓网页**接进模拟世界。
 *
 * 与 `design` / `positions` 一样是**惰性**的：场景里没有 `web.research` 事件就一个都不装，
 * 原有场景的事件序列与指标一个字节不变。
 *
 * 一件事 = 一次**真走运行时**的运行（三个运行时对着同一个请求）：
 * - 请求照服务端的样子组（`apps/server/src/runtime.ts` 的 `buildRequest` / `webFor`）：职责 YAML 的
 *   `web_tools` → `RunRequest.web` + `tools.allow` 里那两个名字；事项那句话进 `thread` 那一格；
 * - **dsh**：官方 `dsh-web` + `dsh-tool-web` 真挂，后端换成替身（`web.standIn`，world 装配时给了）；
 * - **stub**：剧本；**direct**：经工具桥（`executeTool` → 这里的 {@link WebResearchLoop.execute}）；
 * - 后端都是同一个确定性的替身（`@agentsws/stand-ins` 的 `standInWebSearch` / `standInWebFetch`），
 *   不连 DeepSeek、不真搜网页；
 * - 每次工具调用一条审计（`web.searched` / `web.fetched`：查询或网址、结果条数、成败，没有正文），
 *   三个运行时同一个口径（dsh 由门禁报、stub / direct 在工具桥这一跳报）。
 */
import type {
  ContextItem,
  ObjectRef,
  PersonId,
  RoleId,
  RunEvent,
  RunRequest,
  RunWeb,
} from '@agentsws/contracts'
import { canonicalJson, EXTERNAL_FENCE, timeContextItem } from '@agentsws/core'
import type { WebUse } from '@agentsws/dsh-adapter'
import type { ToolExecution } from '@agentsws/stand-ins'
import {
  standInWebFetch,
  standInWebSearch,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  webQueriesOf,
  webUrlOf,
} from '@agentsws/stand-ins'
import { SimulationError } from './errors.js'
import type { RunRecord } from './evidence.js'
import type { World } from './world.js'

export interface WebResearchRecord {
  who: PersonId
  role_id: RoleId
  run_id: string
  status: string
  answer?: string
}

export interface WebResearchLoop {
  /** 交给这个人的这条职责一件"去网上查一下"的事。 */
  research(input: { who: PersonId; role: RoleId; ask: string }): Promise<WebResearchRecord>
  /** stub / direct 的工具桥：网页工具走到这里（替身后端 + 审计）。 */
  execute(call: {
    name: string
    input: Record<string, unknown>
    request: RunRequest
  }): Promise<ToolExecution>
  /** dsh 的门禁报上来的一次网页使用（审计）。 */
  onUse(use: WebUse, request: RunRequest): void
  records: WebResearchRecord[]
}

export function installWebResearch(world: World): WebResearchLoop {
  const records: WebResearchRecord[] = []
  let seq = 0

  const assignmentFor = (who: PersonId, role_id: RoleId) => {
    const found = world.roles.assignments
      .listByPerson(who, { workspace_id: world.workspace_id })
      .find((a) => a.revoked_at === undefined && a.role_id === role_id)
    if (found === undefined)
      throw new SimulationError('invalid_input', `${who} 名下没有 ${role_id} 这条分配`)
    return found
  }

  /** 审计：与服务端 `web.searched` / `web.fetched` 同一个 payload 形状（没有正文）。 */
  const audit = (use: WebUse, request: RunRequest): void => {
    const who = { run_id: request.id, role_id: request.actor.role_id }
    if (use.kind === 'search_usage') return
    if (use.kind === 'search') {
      world.appendEvent(
        'web.searched',
        {
          ...who,
          queries: use.queries,
          results: use.results,
          ok: use.ok,
          ...(use.error === undefined ? {} : { error: use.error }),
        },
        { run_id: request.id },
      )
      return
    }
    world.appendEvent(
      'web.fetched',
      {
        ...who,
        url: use.url,
        ...(use.status === undefined ? {} : { status: use.status }),
        ok: use.ok,
        ...(use.error === undefined ? {} : { error: use.error }),
      },
      { run_id: request.id },
    )
  }

  const execute: WebResearchLoop['execute'] = async (call) => {
    const bare = call.name.slice(call.name.lastIndexOf('.') + 1)
    if (bare === WEB_SEARCH_TOOL) {
      const queries = webQueriesOf(call.input)
      const sources = queries.flatMap((q) => standInWebSearch(q).sources)
      const value = { sources, truncated: false }
      audit({ kind: 'search', queries, results: sources.length, ok: true }, call.request)
      return { status: 'ok', data: value }
    }
    if (bare === WEB_FETCH_TOOL) {
      const url = webUrlOf(call.input)
      if (url === '') {
        audit({ kind: 'fetch', url, ok: false, error: 'WEB_INVALID_URL' }, call.request)
        return { status: 'error', reason: 'url must be a non-empty string' }
      }
      const page = standInWebFetch(url)
      audit(
        { kind: 'fetch', url, status: page.statusCode, truncated: page.truncated, ok: true },
        call.request,
      )
      return { status: 'ok', data: page }
    }
    return { status: 'error', reason: `unknown_tool: ${call.name}` }
  }

  const research: WebResearchLoop['research'] = async ({ who, role, ask }) => {
    const asg = assignmentFor(who, role)
    const config = world.roles.effectiveConfig(asg.id)
    const roleWeb = config.web
    if (roleWeb === undefined) {
      throw new SimulationError('invalid_input', `${role} 没挂网页工具（职责 YAML 的 web_tools）`)
    }
    seq += 1
    const run_id = `run_web_${seq}`
    // 服务端 `webFor` 同一个判法（模拟里凭据由替身兜着：视作"账号登录了"）
    const web: RunWeb = {
      search: roleWeb.tools.includes('web_search'),
      fetch: roleWeb.tools.includes('web_fetch'),
      max_searches: roleWeb.max_searches,
      max_fetches: roleWeb.max_fetches,
      ...(roleWeb.tools.includes('web_search') ? { credential: 'deepseek_account' as const } : {}),
    }
    const allow = [
      ...(web.search ? [WEB_SEARCH_TOOL] : []),
      ...(web.fetch ? [WEB_FETCH_TOOL] : []),
    ].sort()
    // 线程文本进运行时之前包围栏（`fencing_covers_external`：thread 那一格一律有围栏，不管是谁说的）
    const text = EXTERNAL_FENCE.fencePayload(ask)
    const content = canonicalJson({ subject: ask, participants: [], text })
    const matterRef: ObjectRef = { type: 'matter', id: `mat_${run_id}` }
    const context: ContextItem[] = [
      {
        id: `brief_${run_id}`,
        kind: 'thread',
        source_ref: matterRef,
        sensitivity: 'internal',
        content: { subject: ask, participants: [], text },
        bytes: Buffer.byteLength(content, 'utf8'),
      },
      // WP180：「现在时间 + 公司时区」，与服务端 `buildRequest` 同一个函数（事项材料之后）
      timeContextItem({ now: world.clock.now(), companyTz: world.pack.workspace.tz }),
    ]
    const request: RunRequest = {
      id: run_id,
      schema_version: 1,
      workspace_id: world.workspace_id,
      kind: 'work_item',
      actor: { person_id: asg.person_id, assignment_id: asg.id, role_id: asg.role_id },
      work_item: { id: matterRef.id, conversation_id: matterRef.id, role_id: asg.role_id },
      // 人在工作台上交给岗位的一件事（服务端同款：`trigger.source = 'manual'`）
      trigger: { event_id: `manual_${run_id}`, source: 'manual' },
      context,
      grounding: [],
      tools: {
        allow,
        connect_token: '',
        side_effect_policy: 'executor',
      },
      skills: [],
      persona: { sections: [] },
      // 服务端挂了网页工具的运行放到 30（`runtime.ts` WP179 那一段）
      budget: { max_tokens: 60_000, max_tool_calls: 30, max_seconds: 120, max_cost_base: 5 },
      expectations: { outputs: ['answer'], must_stage_if_change_requested: false },
      runtime: {
        preset: asg.role_id,
        profile: 'simulation',
        plugins: [],
        model: world.modelRef,
      },
      web,
      idempotency_key: `idem_${run_id}`,
    }
    // 事件日志里留一份 RunRequest：回放与 prompt_replayable 都从这里重组
    world.appendEvent('simulation.run_request', { request }, { run_id })
    const events: RunEvent[] = []
    const started_at = world.clock.now()
    const result = await world.runtime.run(
      request,
      (e) => {
        events.push(e)
        world.appendRunEvent(request, e)
      },
      new AbortController().signal,
    )
    const run: RunRecord = {
      request,
      started_at,
      finished_at: world.clock.now(),
      status: result.status,
      events,
      result,
    }
    world.shopRuns.push(run)
    const answer = result.outputs.find((o) => o.kind === 'answer')
    const record: WebResearchRecord = {
      who,
      role_id: asg.role_id,
      run_id,
      status: result.status,
      ...(answer?.kind === 'answer' ? { answer: answer.text } : {}),
    }
    records.push(record)
    return record
  }

  return { research, execute, onUse: audit, records }
}
