/**
 * soak 档（26 §4 第三行）：**同一个世界连续跑 N 天**。
 *
 * 它问的不是"这一条业务对不对"（那是 fast 档的事），而是"这套东西放着不管会不会烂"：
 * 队列会不会越堆越高、预占额度会不会漏、`unknown` 会不会一直挂着、
 * SQLite 会不会无限长、模型停机与连接器 429 之后能不能自己缓过来、
 * 关库再开还能不能接着写。
 *
 * 实现上不另起一套执行器：**把 N 天摊成一条场景**（例行公事 + 按到达率来的信 +
 * 按概率注入的故障 + 每天一次对账），交给 `runScenario` 跑，再把证据按天切片。
 * 好处是六条不变量、指标、judge 一个都不用重写，soak 与 fast 走的是同一条路。
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Iso8601 } from '@agentsws/contracts'
import { seededRandom } from '@agentsws/kernel'
import { SimulationError } from './errors.js'
import type { Evidence } from './evidence.js'
import { payloadOf } from './evidence.js'
import type { InvariantResult } from './invariants.js'
import type { Pack } from './pack.js'
import { loadPack } from './pack.js'
import type { ScenarioReport } from './report.js'
import { formatReport } from './report.js'
import { runScenario } from './runner.js'
import type { RuntimeName } from './runtime-name.js'
import type { Scenario, ScenarioEvent } from './scenario/types.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

export interface SoakOptions {
  packDir: string
  /** 连着跑几天。 */
  days: number
  seed?: number
  runtime?: RuntimeName
  /** 开钟时刻；缺省 pack anchor 当天早上 06:00（本地）。 */
  start?: Iso8601
  /** 报告目录；同时也是事件日志落盘的地方（soak 要能"关库再开"）。 */
  reportDir?: string
  /** 事件日志文件；不给就放 `<reportDir>/soak-<seed>.sqlite`。 */
  dbPath?: string
  /** 队列上界：超过这个数就算"队列在无限增长"。缺省 = 到达率 × 4 + 4。 */
  maxOpenApprovals?: number
  /** SQLite 上界（字节）。缺省 = 每天 2 MiB。 */
  maxDbBytesPerDay?: number
}

export interface SoakDayReport {
  day: number
  from: Iso8601
  to: Iso8601
  inbound: number
  runs: number
  runs_failed: number
  applied: number
  /** 这一天结束时还没人决定的卡（越堆越高就是队列在涨） */
  open_approvals: number
  escalations: number
  expired: number
  sampled: number
  /** 这一天结束时还挂着的 `unknown` 变更（对账之后应当是 0） */
  unknown_changes: number
  reconciled: number
  faults: string[]
  restarted: boolean
  problems: string[]
  ok: boolean
}

export interface SoakReport {
  pack: string
  tier: 'soak'
  seed: number
  runtime: RuntimeName
  days: number
  passed: boolean
  /** 一整段跑完的场景报告（六条不变量与指标都在里面） */
  scenario: ScenarioReport
  invariants: InvariantResult[]
  per_day: SoakDayReport[]
  /** 事件日志文件最终多大 */
  db_bytes: number
  db_bytes_cap: number
  problems: string[]
}

/** 06:00（本地 tz）——一天从早上开始，早上 08:00 出计划卡。 */
function dayStart(anchor: Iso8601, tzOffsetMinutes: number): Iso8601 {
  const local = new Date(Date.parse(anchor) + tzOffsetMinutes * 60_000)
  local.setUTCHours(6, 0, 0, 0)
  return new Date(local.getTime() - tzOffsetMinutes * 60_000).toISOString()
}

const ORDER_RE = /#(\d{3,})/

/**
 * 把 N 天摊成一条场景。
 *
 * 每天：一封到几封客户信（按 pack 的到达率）→ 上午的计划卡 → 傍晚的对账 →
 * 按概率注入的连接器故障 / 模型停机 / 进程重启 → 晚上的复盘卡。
 * 全部随机来自 `seed + day`，所以同 seed 的 30 天是同一段人生（26 原则 ①）。
 */
export function buildSoakScenario(input: {
  pack: Pack
  days: number
  seed: number
  start?: Iso8601
}): Scenario {
  const { pack, days, seed } = input
  if (days < 1) throw new SimulationError('invalid_input', `--days 至少 1（收到 ${days}）`)
  const tz = 480
  const start = input.start ?? dayStart(pack.manifest.anchor, tz)
  const startMs = Date.parse(start)
  const soak = pack.soak

  // 能写信的客户 = 有已签收订单的那些人（不然信里的订单号对不上任何东西）
  const candidates = pack.orders
    .filter((o) => o.delivered_at !== undefined)
    .map((o) => ({ order: o, customer: pack.customerByEmail(o.email) }))
    .filter(
      (c): c is { order: (typeof pack.orders)[number]; customer: NonNullable<typeof c.customer> } =>
        c.customer !== undefined,
    )
  if (candidates.length === 0) {
    throw new SimulationError('invalid_input', `pack ${pack.manifest.pack} 里没有已签收的订单`)
  }
  // 信的样子从 pack 的 fixtures 里来（毒样本不进 soak——那是 security 场景的活）
  const templates = [...pack.fixtures.entries()]
    .filter(([name]) => !name.includes('injected'))
    .map(([, body]) => body)
  if (templates.length === 0) {
    throw new SimulationError('invalid_input', `pack ${pack.manifest.pack} 里没有 fixtures`)
  }

  // 窗口内签收的订单会真的走到"提退款 → 人批 → 施行"，窗口外的走"解释为什么不能退"。
  // 两边都要有，soak 才既压到执行器也压到 guardrail。
  const withinWindow = candidates.filter(
    (c) => startMs - Date.parse(c.order.delivered_at ?? '') <= 14 * DAY,
  )

  const at = (ms: number): string => new Date(startMs + ms).toISOString()
  const events: ScenarioEvent[] = [{ at: at(0), type: 'routine.start', routine: {} }]

  // **一条随机序列贯穿 N 天**：`seededRandom` 是 xorshift，只播种一个字（相邻 seed 的
  // 前几个输出高度相关），按天各起一条会让"第 1 天和第 5 天做同样的决定"。
  const random = seededRandom(seed + 1000)
  let faults = 0
  let outages = 0
  let restarts = 0

  for (let day = 0; day < days; day += 1) {
    const base = day * DAY
    const count = Math.max(1, Math.round(soak.inbound_per_day * (0.5 + random())))
    for (let i = 0; i < count; i += 1) {
      const pool = withinWindow.length > 0 && random() < 0.6 ? withinWindow : candidates
      const pick = pool[Math.floor(random() * pool.length)]
      const template = templates[Math.floor(random() * templates.length)]
      if (pick === undefined || template === undefined) continue
      // 工作时间内来信（09:00–17:00）
      const hour = 3 + Math.floor(random() * 8)
      const minute = Math.floor(random() * 60)
      events.push({
        at: at(base + hour * HOUR + minute * 60_000),
        type: 'inbound.email',
        inbound: {
          from: pick.customer.email,
          thread: 'new',
          subject: `Question about ${pick.order.name}`,
          // 每封信一个 message_id：同一个客户第二天又来问同一单是**两件事**，
          // 不给 id 的话入站管线会按正文去重，第二天那封就被当成重复投递吃掉了（18 §2.2）
          message_id: `msg_soak_d${day + 1}_${i + 1}`,
          // 订单号换成这封信真正说的那一单
          body: template.replace(ORDER_RE, `#${pick.order.id.replace('ord_', '')}`),
        },
      })
    }
    if (random() < pack.soak.fault_rate) {
      faults += 1
      events.push({
        at: at(base + 11 * HOUR),
        type: 'inject.fault',
        fault: {
          action: 'shopify_admin.create_refund',
          code: random() < 0.5 ? 429 : 'timeout',
          times: 1,
        },
      })
    }
    if (random() < pack.soak.outage_rate) {
      outages += 1
      events.push({ at: at(base + 12 * HOUR), type: 'model.outage', outage: { duration: '2h' } })
    }
    // 傍晚对账：15 §5.8 的 unknown 收口，soak 要断言"下一次对账内清零"
    events.push({ at: at(base + 15 * HOUR), type: 'reconcile.run', reconcile: {} })
    if (random() < pack.soak.restart_rate) {
      restarts += 1
      events.push({ at: at(base + 16 * HOUR), type: 'process.restart', restart: {} })
    }
    // 走到第二天早上（复盘卡、接力任务都在这段里）
    events.push({ at: at(base + 23 * HOUR + 30 * 60_000), type: 'clock.advance', advance: {} })
  }

  // 三样演练至少各来一次。按概率抽是为了让不同 seed 有不同的一段人生，
  // 但"这一跑到底有没有练到重启"不能全凭运气——soak 的价值就在这三件事上。
  if (faults === 0) {
    events.push({
      at: at(11 * HOUR),
      type: 'inject.fault',
      // timeout 才会走出 `unknown`（15 §5.8），也才轮得到傍晚的对账收口
      fault: { action: 'shopify_admin.create_refund', code: 'timeout', times: 1 },
    })
  }
  if (outages === 0) {
    events.push({
      at: at((days - 1) * DAY + 12 * HOUR),
      type: 'model.outage',
      outage: { duration: '2h' },
    })
  }
  if (restarts === 0 && days >= 2) {
    events.push({ at: at(DAY + 16 * HOUR), type: 'process.restart', restart: {} })
  }

  const owner = pack.people.find((p) => p.owner === true)?.id ?? pack.people[0]?.id
  if (owner === undefined) throw new SimulationError('invalid_input', 'pack 里一个人都没有')

  // 一天里的信是按随机钟点抽的，先排好序再交出去——场景里的事件必须按虚拟时间递增
  // （合成时钟不回拨，25 §6.5）。`sort` 是稳定的，同一时刻的顺序照生成顺序。
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  return {
    id: `soak/${days}-days`,
    version: 1,
    dataset: { pack: pack.manifest.pack, seed },
    // 人每天都在，卡片按小时级的延迟处理（不是秒回，也不是永远不理）
    actors: {
      [owner]: { policy: 'edit_30pct', latency: '30m..6h', reject_rules: ['contains:补偿'] },
    },
    stand_ins: {
      provider: 'mock_open_connector',
      model: 'stub',
      clock: 'virtual',
      delivery: 'inbox',
    },
    clock: { start: new Date(startMs).toISOString() },
    events,
    expected: {},
    invariants: [
      'no_write_without_stage',
      'apply_only_after_approved',
      'provenance_respected',
      'fencing_covers_external',
      'prompt_replayable',
      'freeze_on_model_outage',
    ],
    tiers: ['soak'],
    source: `<soak:${pack.manifest.pack}:${days}d>`,
  }
}

/** 跑一段 soak，出按天的报告。 */
export async function runSoak(options: SoakOptions): Promise<SoakReport> {
  const packDir = resolve(options.packDir)
  const pack = loadPack(packDir)
  const seed = options.seed ?? pack.manifest.seed
  const runtime: RuntimeName = options.runtime ?? 'stub'
  const reportDir = options.reportDir === undefined ? undefined : resolve(options.reportDir)
  const dbPath =
    options.dbPath ??
    join(reportDir ?? resolve('out'), `soak-${pack.manifest.pack}-${seed}-${options.days}d.sqlite`)
  mkdirSync(resolve(dbPath, '..'), { recursive: true })
  // 每次 soak 都是一段新的公司生活：上一次的事件日志留在原地，同 seed 会生成同样的
  // 事件 id 撞上去（21 §1 append-only，id 唯一）。先清掉，再开新的一段。
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })

  const scenario = buildSoakScenario({
    pack,
    days: options.days,
    seed,
    ...(options.start === undefined ? {} : { start: options.start }),
  })

  let evidence: Evidence | undefined
  const report = await runScenario(scenario, {
    tier: 'soak',
    pack,
    packDir,
    seed,
    runtime,
    dbPath,
    captureEvidence: (e) => {
      evidence = e
    },
  })
  if (evidence === undefined) throw new SimulationError('conflict', 'soak 没拿到证据')

  const maxOpen = options.maxOpenApprovals ?? pack.soak.inbound_per_day * 4 + 4
  const per_day = sliceByDay(evidence, Date.parse(scenario.clock.start), options.days, maxOpen)

  const db_bytes = statSync(dbPath).size
  const db_bytes_cap = (options.maxDbBytesPerDay ?? 2 * 1024 * 1024) * options.days
  const problems: string[] = []
  if (db_bytes > db_bytes_cap) {
    problems.push(`事件日志 ${db_bytes} 字节 > 上界 ${db_bytes_cap}（${options.days} 天）`)
  }
  // 预占额度全部收口：终态的变更不许还占着名额（31 §3.2）
  const TERMINAL = ['applied', 'failed', 'expired', 'withdrawn', 'superseded', 'reversed']
  for (const change of evidence.changes) {
    if (!TERMINAL.includes(change.status)) continue
    const reservation = change.reservation
    if (reservation !== undefined && reservation.released !== true && change.status !== 'applied') {
      problems.push(`变更 ${change.id}（${change.status}）的预占没释放`)
    }
  }
  for (const day of per_day) problems.push(...day.problems.map((p) => `day ${day.day}：${p}`))
  const passed = report.passed && problems.length === 0

  if (reportDir !== undefined) {
    mkdirSync(reportDir, { recursive: true })
    const soakReport: SoakReport = {
      pack: pack.manifest.pack,
      tier: 'soak',
      seed,
      runtime,
      days: options.days,
      passed,
      scenario: report,
      invariants: report.invariants,
      per_day,
      db_bytes,
      db_bytes_cap,
      problems,
    }
    writeFileSync(join(reportDir, 'soak.json'), `${JSON.stringify(soakReport, null, 2)}\n`, 'utf8')
    writeFileSync(join(reportDir, 'soak.md'), soakMarkdown(soakReport), 'utf8')
    return soakReport
  }

  return {
    pack: pack.manifest.pack,
    tier: 'soak',
    seed,
    runtime,
    days: options.days,
    passed,
    scenario: report,
    invariants: report.invariants,
    per_day,
    db_bytes,
    db_bytes_cap,
    problems,
  }
}

function sliceByDay(
  evidence: Evidence,
  startMs: number,
  days: number,
  maxOpen: number,
): SoakDayReport[] {
  const out: SoakDayReport[] = []
  const created = new Map<string, number>()
  const closed = new Map<string, number>()
  for (const e of evidence.events) {
    const id = e.subject?.id
    if (id === undefined) continue
    if (e.type === 'approval.created' && !created.has(id)) created.set(id, Date.parse(e.at))
    if (
      ['approval.decided', 'approval.expired', 'approval.withdrawn', 'approval.applied'].includes(
        e.type,
      ) &&
      !closed.has(id)
    ) {
      closed.set(id, Date.parse(e.at))
    }
  }

  for (let day = 0; day < days; day += 1) {
    const from = startMs + day * DAY
    const to = from + DAY
    const inWindow = evidence.events.filter((e) => {
      const t = Date.parse(e.at)
      return t >= from && t < to
    })
    const count = (type: string): number => inWindow.filter((e) => e.type === type).length
    const open = [...created.entries()].filter(
      ([id, at]) => at < to && (closed.get(id) ?? Number.POSITIVE_INFINITY) >= to,
    ).length
    // 这一天结束时还挂着的 unknown（对账在傍晚跑，所以到日终应当是 0）
    const unknown = evidence.changes.filter((c) => {
      const applyAt = c.apply?.at === undefined ? undefined : Date.parse(c.apply.at)
      return c.status === 'unknown' && applyAt !== undefined && applyAt < to
    }).length

    const problems: string[] = []
    if (open > maxOpen) problems.push(`队列 ${open} 张 > 上界 ${maxOpen}（队列在无限增长）`)
    if (unknown > 0) problems.push(`日终还有 ${unknown} 条 unknown 变更没对账收口`)

    out.push({
      day: day + 1,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      inbound: count('inbound.received'),
      runs: count('run.started'),
      runs_failed: count('run.failed'),
      applied: count('change.applied'),
      open_approvals: open,
      escalations: count('approval.escalated'),
      expired: count('approval.expired'),
      sampled: count('simulation.sampling_review'),
      unknown_changes: unknown,
      reconciled: inWindow
        .filter((e) => e.type === 'simulation.reconciled')
        .reduce((n, e) => n + Number(payloadOf(e).reconciled ?? 0), 0),
      faults: inWindow
        .filter(
          (e) => e.type === 'simulation.fault_injected' || e.type === 'simulation.model_outage',
        )
        .map((e) =>
          e.type === 'simulation.model_outage'
            ? 'model_outage'
            : `${String(payloadOf(e).action)}:${String(payloadOf(e).code)}`,
        ),
      restarted: inWindow.some((e) => e.type === 'simulation.process_restarted'),
      problems,
      ok: problems.length === 0,
    })
  }
  return out
}

/** 按天的曲线（26 §4 报告：soak 要看得见趋势，不是只看总数）。 */
export function soakMarkdown(report: SoakReport): string {
  const lines: string[] = []
  lines.push(`# soak ${report.days} 天 —— ${report.pack}`)
  lines.push('')
  lines.push(
    `${report.passed ? '**通过**' : '**不通过**'}｜seed ${report.seed}｜运行时 ${report.runtime}｜` +
      `事件日志 ${(report.db_bytes / 1024).toFixed(1)} KiB / 上界 ${(report.db_bytes_cap / 1024).toFixed(0)} KiB`,
  )
  lines.push('')
  lines.push('## 不变量')
  lines.push('')
  for (const inv of report.invariants) {
    lines.push(
      `- ${inv.ok ? '✓' : '✗'} \`${inv.name}\`（查了 ${inv.checked} 处）` +
        (inv.ok ? '' : `：${inv.violations.map((v) => v.message).join('；')}`),
    )
  }
  lines.push('')
  lines.push('## 按天')
  lines.push('')
  lines.push(
    '| 天 | 来信 | 运行 | 失败 | 施行 | 日终队列 | 升级 | 过期 | 抽检 | unknown | 对账 | 故障 | 重启 |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const d of report.per_day) {
    lines.push(
      `| ${d.day} | ${d.inbound} | ${d.runs} | ${d.runs_failed} | ${d.applied} | ${d.open_approvals} | ` +
        `${d.escalations} | ${d.expired} | ${d.sampled} | ${d.unknown_changes} | ${d.reconciled} | ` +
        `${d.faults.join(' ') || '—'} | ${d.restarted ? '是' : '—'} |`,
    )
  }
  lines.push('')
  const curve = report.per_day.map((d) => d.open_approvals)
  lines.push(`日终队列曲线：${sparkline(curve)}（${curve.join(' → ')}）`)
  lines.push('')
  if (report.problems.length > 0) {
    lines.push('## 问题')
    lines.push('')
    for (const p of report.problems) lines.push(`- ${p}`)
    lines.push('')
  }
  lines.push('## 整段场景')
  lines.push('')
  lines.push('```')
  lines.push(formatReport(report.scenario))
  lines.push('```')
  lines.push('')
  return `${lines.join('\n')}\n`
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** 一行 ASCII 曲线：报告里看趋势不用开图表库。 */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return ''
  const max = Math.max(...values)
  if (max === 0) return BLOCKS[0]?.repeat(values.length) ?? ''
  return values
    .map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round((v / max) * (BLOCKS.length - 1)))])
    .join('')
}
