/**
 * 场景文件解析与 schema 校验（26 §1）。
 *
 * 校验是"只认声明过的键"：多写一个键就报错，少写必填键也报错——
 * 场景文件是回归基线，静默忽略一个拼错的键等于静默关掉一条断言。
 */
import { readFileSync } from 'node:fs'
import type { ChangeKind } from '@agentsws/contracts'
import { parse as parseYaml } from 'yaml'
import { ScenarioSchemaError } from '../errors.js'
import { parseDuration, parseRange } from './duration.js'
import type {
  InvariantName,
  Scenario,
  ScenarioActor,
  ScenarioEvent,
  ScenarioExpected,
  ScenarioStandIns,
} from './types.js'
import { INVARIANT_NAMES } from './types.js'

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)

function fail(source: string, path: string, message: string): never {
  throw new ScenarioSchemaError(source, path, message)
}

function known(source: string, path: string, o: Rec, keys: readonly string[]): void {
  const extra = Object.keys(o).filter((k) => !keys.includes(k))
  if (extra.length > 0) fail(source, path, `未知字段：${extra.join(', ')}（只认已声明的键）`)
}

function str(source: string, path: string, v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) fail(source, path, '必须是非空字符串')
  return v
}

function optStr(source: string, path: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') fail(source, path, '必须是字符串')
  return v
}

function num(source: string, path: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(source, path, '必须是数值')
  return v
}

function strList(source: string, path: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    fail(source, path, '必须是字符串数组')
  }
  return v as string[]
}

function optStrList(source: string, path: string, v: unknown): string[] | undefined {
  return v === undefined || v === null ? undefined : strList(source, path, v)
}

const NUMERIC_RE = /^(>=|<=|==|>|<)\s*-?\d+(\.\d+)?$/

function numeric(source: string, path: string, v: unknown): number | string {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && NUMERIC_RE.test(v.trim())) return v.trim()
  fail(source, path, '必须是数值或比较式（>=0.6 / <=20000 / ==0）')
}

const EVENT_KEYS = [
  'inbound.email',
  'actor.decide',
  'clock.advance',
  'inject.fault',
  'model.outage',
  'inject.budget',
  'routine.start',
] as const

const EXPECTED_KEYS = [
  'calls_tool',
  'first_tool',
  'never_calls',
  'staged_change_kinds',
  'no_applied_changes_before',
  'approval_items',
  'reply_omits',
  'reply_includes_any',
  'memory_contains',
  'max_tool_calls',
  'metrics',
  'run_failed_codes',
  'notifications_to',
  'blocked_rules',
  'event_types',
  'approval_kinds',
  'scheduled_handlers',
] as const

function parseActor(source: string, name: string, raw: unknown): ScenarioActor {
  if (!isRec(raw)) fail(source, `actors.${name}`, '必须是对象')
  known(source, `actors.${name}`, raw, ['approve'])
  const approve = raw.approve
  if (!isRec(approve)) fail(source, `actors.${name}.approve`, '必须是对象')
  known(source, `actors.${name}.approve`, approve, ['policy', 'latency', 'reject_rules', 'lane'])
  const policy = str(source, `actors.${name}.approve.policy`, approve.policy)
  const latency = optStr(source, `actors.${name}.approve.latency`, approve.latency)
  if (latency !== undefined) parseRange(latency)
  const lane = optStr(source, `actors.${name}.approve.lane`, approve.lane)
  if (lane !== undefined && !['mine', 'scope', 'unclaimed'].includes(lane)) {
    fail(source, `actors.${name}.approve.lane`, 'lane 只能是 mine / scope / unclaimed')
  }
  return {
    policy,
    ...(latency === undefined ? {} : { latency }),
    ...(approve.reject_rules === undefined
      ? {}
      : {
          reject_rules: strList(
            source,
            `actors.${name}.approve.reject_rules`,
            approve.reject_rules,
          ),
        }),
    ...(lane === undefined ? {} : { lane: lane as 'mine' | 'scope' | 'unclaimed' }),
  }
}

function parseEvent(source: string, index: number, raw: unknown): ScenarioEvent {
  const path = `events[${index}]`
  if (!isRec(raw)) fail(source, path, '必须是对象')
  known(source, path, raw, ['at', ...EVENT_KEYS])
  const at = str(source, `${path}.at`, raw.at)
  const present = EVENT_KEYS.filter((k) => raw[k] !== undefined)
  if (present.length !== 1 || present[0] === undefined) {
    fail(source, path, `每条事件必须且只能带一个动作键（${EVENT_KEYS.join(' / ')}）`)
  }
  const key = present[0]
  const body = raw[key]
  if (!isRec(body)) fail(source, `${path}.${key}`, '必须是对象')

  switch (key) {
    case 'inbound.email': {
      known(source, `${path}.${key}`, body, [
        'from',
        'thread',
        'subject',
        'body_ref',
        'body',
        'message_id',
      ])
      if (body.body_ref === undefined && body.body === undefined) {
        fail(source, `${path}.${key}`, 'body_ref 与 body 至少给一个')
      }
      return {
        at,
        type: 'inbound.email',
        inbound: {
          from: str(source, `${path}.${key}.from`, body.from),
          thread: str(source, `${path}.${key}.thread`, body.thread),
          ...(body.subject === undefined
            ? {}
            : { subject: str(source, `${path}.${key}.subject`, body.subject) }),
          ...(body.body_ref === undefined
            ? {}
            : { body_ref: str(source, `${path}.${key}.body_ref`, body.body_ref) }),
          ...(body.body === undefined
            ? {}
            : { body: str(source, `${path}.${key}.body`, body.body) }),
          ...(body.message_id === undefined
            ? {}
            : { message_id: str(source, `${path}.${key}.message_id`, body.message_id) }),
        },
      }
    }
    case 'actor.decide': {
      known(source, `${path}.${key}`, body, ['who', 'item', 'action', 'reason'])
      const action = str(source, `${path}.${key}.action`, body.action)
      if (!['approve', 'approve_edited', 'reject'].includes(action)) {
        fail(source, `${path}.${key}.action`, 'action 只能是 approve / approve_edited / reject')
      }
      return {
        at,
        type: 'actor.decide',
        decide: {
          who: str(source, `${path}.${key}.who`, body.who),
          item: str(source, `${path}.${key}.item`, body.item),
          action: action as 'approve' | 'approve_edited' | 'reject',
          ...(body.reason === undefined
            ? {}
            : { reason: str(source, `${path}.${key}.reason`, body.reason) }),
        },
      }
    }
    case 'clock.advance': {
      known(source, `${path}.${key}`, body, [])
      return { at, type: 'clock.advance', advance: {} }
    }
    case 'inject.fault': {
      known(source, `${path}.${key}`, body, ['action', 'code', 'times'])
      const code = body.code
      if (code !== 429 && code !== 500 && code !== 'timeout') {
        fail(source, `${path}.${key}.code`, 'code 只能是 429 / 500 / timeout')
      }
      return {
        at,
        type: 'inject.fault',
        fault: {
          action: str(source, `${path}.${key}.action`, body.action),
          code,
          times: num(source, `${path}.${key}.times`, body.times),
        },
      }
    }
    case 'routine.start': {
      known(source, `${path}.${key}`, body, ['plan_hour', 'review_hour'])
      return {
        at,
        type: 'routine.start',
        routine: {
          ...(body.plan_hour === undefined
            ? {}
            : { plan_hour: num(source, `${path}.${key}.plan_hour`, body.plan_hour) }),
          ...(body.review_hour === undefined
            ? {}
            : { review_hour: num(source, `${path}.${key}.review_hour`, body.review_hour) }),
        },
      }
    }
    case 'model.outage': {
      known(source, `${path}.${key}`, body, ['duration'])
      const duration = optStr(source, `${path}.${key}.duration`, body.duration)
      if (duration !== undefined) parseDuration(duration)
      return { at, type: 'model.outage', outage: duration === undefined ? {} : { duration } }
    }
    default: {
      known(source, `${path}.${key}`, body, [
        'workspace_daily_base',
        'workspace_monthly_base',
        'assignment_daily_base',
      ])
      return {
        at,
        type: 'inject.budget',
        budget: {
          ...(body.workspace_daily_base === undefined
            ? {}
            : {
                workspace_daily_base: num(
                  source,
                  `${path}.${key}.workspace_daily_base`,
                  body.workspace_daily_base,
                ),
              }),
          ...(body.workspace_monthly_base === undefined
            ? {}
            : {
                workspace_monthly_base: num(
                  source,
                  `${path}.${key}.workspace_monthly_base`,
                  body.workspace_monthly_base,
                ),
              }),
          ...(body.assignment_daily_base === undefined
            ? {}
            : {
                assignment_daily_base: num(
                  source,
                  `${path}.${key}.assignment_daily_base`,
                  body.assignment_daily_base,
                ),
              }),
        },
      }
    }
  }
}

function parseExpected(source: string, raw: unknown): ScenarioExpected {
  if (raw === undefined || raw === null) return {}
  if (!isRec(raw)) fail(source, 'expected', '必须是对象')
  known(source, 'expected', raw, EXPECTED_KEYS)
  const out: ScenarioExpected = {}
  const calls = optStrList(source, 'expected.calls_tool', raw.calls_tool)
  if (calls !== undefined) out.calls_tool = calls
  const first = optStr(source, 'expected.first_tool', raw.first_tool)
  if (first !== undefined) out.first_tool = first
  const never = optStrList(source, 'expected.never_calls', raw.never_calls)
  if (never !== undefined) out.never_calls = never
  const kinds = optStrList(source, 'expected.staged_change_kinds', raw.staged_change_kinds)
  if (kinds !== undefined) out.staged_change_kinds = kinds as ChangeKind[]
  const before = optStr(source, 'expected.no_applied_changes_before', raw.no_applied_changes_before)
  if (before !== undefined) out.no_applied_changes_before = before
  if (raw.approval_items !== undefined) {
    const ai = raw.approval_items
    if (!isRec(ai)) fail(source, 'expected.approval_items', '必须是对象')
    known(source, 'expected.approval_items', ai, ['kind', 'count', 'children'])
    out.approval_items = {
      kind: str(source, 'expected.approval_items.kind', ai.kind),
      ...(ai.count === undefined
        ? {}
        : { count: numeric(source, 'expected.approval_items.count', ai.count) }),
      ...(ai.children === undefined
        ? {}
        : { children: strList(source, 'expected.approval_items.children', ai.children) }),
    }
  }
  const omits = optStrList(source, 'expected.reply_omits', raw.reply_omits)
  if (omits !== undefined) out.reply_omits = omits
  const includes = optStrList(source, 'expected.reply_includes_any', raw.reply_includes_any)
  if (includes !== undefined) out.reply_includes_any = includes
  const mem = optStrList(source, 'expected.memory_contains', raw.memory_contains)
  if (mem !== undefined) out.memory_contains = mem
  if (raw.max_tool_calls !== undefined) {
    out.max_tool_calls = num(source, 'expected.max_tool_calls', raw.max_tool_calls)
  }
  if (raw.metrics !== undefined) {
    const m = raw.metrics
    if (!isRec(m)) fail(source, 'expected.metrics', '必须是对象')
    const metrics: Record<string, number | string> = {}
    for (const [k, v] of Object.entries(m)) metrics[k] = numeric(source, `expected.metrics.${k}`, v)
    out.metrics = metrics
  }
  const codes = optStrList(source, 'expected.run_failed_codes', raw.run_failed_codes)
  if (codes !== undefined) out.run_failed_codes = codes
  const notified = optStrList(source, 'expected.notifications_to', raw.notifications_to)
  if (notified !== undefined) out.notifications_to = notified
  const blocked = optStrList(source, 'expected.blocked_rules', raw.blocked_rules)
  if (blocked !== undefined) out.blocked_rules = blocked
  const eventTypes = optStrList(source, 'expected.event_types', raw.event_types)
  if (eventTypes !== undefined) out.event_types = eventTypes
  if (raw.approval_kinds !== undefined) {
    const k = raw.approval_kinds
    if (!isRec(k)) fail(source, 'expected.approval_kinds', '必须是对象')
    const kinds: Record<string, number | string> = {}
    for (const [name, v] of Object.entries(k)) {
      kinds[name] = numeric(source, `expected.approval_kinds.${name}`, v)
    }
    out.approval_kinds = kinds
  }
  const handlers = optStrList(source, 'expected.scheduled_handlers', raw.scheduled_handlers)
  if (handlers !== undefined) out.scheduled_handlers = handlers
  return out
}

/** 从 YAML 文本解析一条场景。 */
export function parseScenario(text: string, source = '<string>'): Scenario {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    fail(source, '', `YAML 解析失败：${(error as Error).message}`)
  }
  if (!isRec(doc)) fail(source, '', '场景文件必须是一个对象')
  known(source, '', doc, [
    'id',
    'version',
    'dataset',
    'actors',
    'stand_ins',
    'clock',
    'events',
    'expected',
    'invariants',
    'rubric',
    'hidden',
    'control_for',
  ])

  const id = str(source, 'id', doc.id)
  if (doc.version !== 1) fail(source, 'version', '目前只支持 version: 1')

  if (!isRec(doc.dataset)) fail(source, 'dataset', '必须是对象')
  known(source, 'dataset', doc.dataset, ['pack', 'seed'])
  const dataset = {
    pack: str(source, 'dataset.pack', doc.dataset.pack),
    seed: num(source, 'dataset.seed', doc.dataset.seed),
  }

  const actors: Record<string, ScenarioActor> = {}
  if (doc.actors !== undefined && doc.actors !== null) {
    if (!isRec(doc.actors)) fail(source, 'actors', '必须是对象')
    for (const [name, raw] of Object.entries(doc.actors))
      actors[name] = parseActor(source, name, raw)
  }

  if (!isRec(doc.stand_ins)) fail(source, 'stand_ins', '必须是对象')
  known(source, 'stand_ins', doc.stand_ins, ['provider', 'model', 'clock', 'delivery'])
  const model = str(source, 'stand_ins.model', doc.stand_ins.model)
  if (!['stub', 'replay', 'real'].includes(model)) {
    fail(source, 'stand_ins.model', 'model 只能是 stub / replay / real')
  }
  const stand_ins: ScenarioStandIns = {
    provider: str(source, 'stand_ins.provider', doc.stand_ins.provider) as 'mock_open_connector',
    model: model as ScenarioStandIns['model'],
    clock: str(source, 'stand_ins.clock', doc.stand_ins.clock) as 'virtual',
    delivery: str(source, 'stand_ins.delivery', doc.stand_ins.delivery) as 'inbox',
  }
  if (stand_ins.provider !== 'mock_open_connector') {
    fail(source, 'stand_ins.provider', 'v1 只有 mock_open_connector')
  }
  if (stand_ins.clock !== 'virtual') fail(source, 'stand_ins.clock', 'v1 只有 virtual')
  if (stand_ins.delivery !== 'inbox') fail(source, 'stand_ins.delivery', 'v1 只有 inbox')

  if (!isRec(doc.clock)) fail(source, 'clock', '必须是对象')
  known(source, 'clock', doc.clock, ['start'])
  const start = str(source, 'clock.start', doc.clock.start)
  if (!Number.isFinite(Date.parse(start))) fail(source, 'clock.start', '不是合法的 ISO-8601 时刻')

  if (!Array.isArray(doc.events)) fail(source, 'events', '必须是数组')
  const events = doc.events.map((e, i) => parseEvent(source, i, e))

  const invariantsRaw =
    doc.invariants === undefined ? [] : strList(source, 'invariants', doc.invariants)
  for (const name of invariantsRaw) {
    if (!(INVARIANT_NAMES as readonly string[]).includes(name)) {
      fail(source, 'invariants', `未知不变量：${name}（只有 ${INVARIANT_NAMES.join(' / ')}）`)
    }
  }

  const rubric = optStr(source, 'rubric', doc.rubric)
  const control_for = optStr(source, 'control_for', doc.control_for)
  if (doc.hidden !== undefined && typeof doc.hidden !== 'boolean') {
    fail(source, 'hidden', '必须是布尔值')
  }

  return {
    id,
    version: 1,
    dataset,
    actors,
    stand_ins,
    clock: { start: new Date(Date.parse(start)).toISOString() },
    events,
    expected: parseExpected(source, doc.expected),
    invariants: invariantsRaw as InvariantName[],
    ...(rubric === undefined ? {} : { rubric }),
    ...(doc.hidden === true ? { hidden: true } : {}),
    ...(control_for === undefined ? {} : { control_for }),
    source,
  }
}

/** 从文件读一条场景。 */
export function loadScenario(file: string): Scenario {
  return parseScenario(readFileSync(file, 'utf8'), file)
}
