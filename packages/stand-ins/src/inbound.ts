/**
 * 入站替身（18 §2.2 管线的替身实现，WP9 补 WP8 的遗留项）。
 *
 * 接收 → 去重（dedupe_key，24h 窗口）→ 围栏 + 秘密检测（命中即脱敏并记 `secrets_scrubbed`）
 * → 解析（发件人 / 线程 / 订单引用）→ 路由（职责）→ 产出 `InboundEvent`。
 *
 * 两条纪律在这里落地，别处不再重复：
 * 1. **fencing 在入口**（17 §5.2）：`parts.text` 出管线时已经是围栏内的清洗文本，
 *    运行时与执行器都不再信任任何外部文本；原文只留在 `raw_ref`。
 * 2. **秘密不进事件**（21 §1）：卡号 / key 形态在这里就被替换成占位符。
 */
import type {
  ChannelName,
  Clock,
  InboundEvent,
  InboundPipeline,
  Iso8601,
  MessagePart,
  ObjectRef,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { canonicalJson, EXTERNAL_FENCE, sha256 } from '@agentsws/core'
import { StandInError } from './errors.js'

/** 一封原始邮件（mock 渠道适配器的 `raw`）。 */
export interface RawEmail {
  message_id?: string
  from: string
  to?: string[]
  subject?: string
  body: string
  at?: Iso8601
  /** 已知线程；不给或 `new` 就按参与者 + 主题归并。 */
  thread_id?: string
}

/** 发件人 / 线程 / 订单的解析出口：由宿主（pack 数据集）提供。 */
export interface InboundResolver {
  /** 邮箱 → 客户记录 */
  customer?(email: string): ObjectRef | undefined
  /** 线程外部 id → 线程记录 */
  thread?(external_id: string): ObjectRef | undefined
  /** 正文里认得出的订单（`#1001`） */
  order?(text: string): ObjectRef | undefined
  /** 路由：给哪个职责（06 §2.4 同一路由器的替身） */
  route?(input: {
    channel: ChannelName
    from: string
    subject: string
    text: string
  }): { role_id?: RoleId; work_item_id?: string; confidence: number } | undefined
}

export interface InboundPipelineOptions {
  clock: Clock
  workspace_id?: WorkspaceId
  resolver?: InboundResolver
  /** 去重窗口，默认 24h（18 §2.2）。 */
  dedupeWindowMs?: number
  /** 命中即进死信（解析失败 / 缺发件人）。 */
  onDeadLetter?: (e: InboundEvent) => void
}

/** 一条入站事件的落库记录（含未围栏原文，只在 raw 区，不进事件日志）。 */
export interface RawRecord {
  ref: string
  channel: ChannelName
  received_at: Iso8601
  raw: unknown
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 与 14 §6 密钥扫描同一张表（本包不依赖 txn，模式表在两处对齐）。 */
const SECRET_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: 'api_key', re: /\b(?:sk|pk|rk)[-_][A-Za-z0-9]{16,}\b/g },
  { rule: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: 'bearer', re: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}/gi },
  { rule: 'card_number', re: /\b(?:\d[ -]?){13,19}\b/g },
]

export interface ScrubResult {
  text: string
  rules: string[]
}

/** 18 §5 用例 3：入站含卡号 → 脱敏并标 `secrets_scrubbed`，原文只在 `raw_ref`。 */
export function scrubSecrets(text: string): ScrubResult {
  let out = text
  const rules: string[] = []
  for (const { rule, re } of SECRET_PATTERNS) {
    const pattern = new RegExp(re.source, re.flags)
    if (pattern.test(out)) {
      rules.push(rule)
      out = out.replace(new RegExp(re.source, re.flags), `[redacted:${rule}]`)
    }
  }
  return { text: out, rules }
}

/**
 * 18 §5 用例 2：外部正文一律经 `EXTERNAL_FENCE`——先清洗（去伪造 turn 边界与工具标记），
 * 再包进 `<external_data>`。返回值是模型唯一会看到的形态。
 */
export function fenceInbound(text: string): string {
  return EXTERNAL_FENCE.fencePayload(text)
}

/** 18 §2.2 去重键：渠道 + 平台消息 id（没有就取内容哈希）。 */
export function inboundDedupeKey(channel: ChannelName, raw: RawEmail): string {
  const id = raw.message_id
  if (id !== undefined && id.length > 0) return `${channel}:${id}`
  return `${channel}:${sha256(canonicalJson({ from: raw.from, subject: raw.subject, body: raw.body })).slice(0, 32)}`
}

interface Seen {
  key: string
  at_ms: number
  event: InboundEvent
}

/**
 * 内存入站管线（fast 档）。`ingest` 是幂等的：同一 `dedupe_key` 在窗口内重复投递
 * 只产出一条 `InboundEvent`（18 §5 用例 1）。
 */
export class MemoryInboundPipeline implements InboundPipeline {
  readonly raws: RawRecord[] = []
  private readonly clock: Clock
  private readonly workspace: WorkspaceId
  private readonly resolver: InboundResolver
  private readonly windowMs: number
  private readonly onDeadLetter: ((e: InboundEvent) => void) | undefined
  private readonly seen = new Map<string, Seen>()
  private readonly events: InboundEvent[] = []
  private readonly dead: InboundEvent[] = []
  private seq = 0

  constructor(opts: InboundPipelineOptions) {
    this.clock = opts.clock
    this.workspace = opts.workspace_id ?? 'ws_stand_in'
    this.resolver = opts.resolver ?? {}
    this.windowMs = opts.dedupeWindowMs ?? DAY_MS
    this.onDeadLetter = opts.onDeadLetter
  }

  async ingest(
    channel: ChannelName,
    raw: unknown,
    workspace_id: WorkspaceId,
  ): Promise<{ event?: InboundEvent; deduped: boolean }> {
    if (channel !== 'email') {
      throw new StandInError('invalid_input', `入站替身只实现了 email 渠道：${channel}`, {
        channel,
      })
    }
    const mail = asEmail(raw)
    const at = this.clock.now()
    const key = inboundDedupeKey(channel, mail)

    const prior = this.seen.get(key)
    if (prior !== undefined && Date.parse(at) - prior.at_ms < this.windowMs) {
      return { event: prior.event, deduped: true }
    }

    this.seq += 1
    const raw_ref = `raw://inbound/${channel}/${this.seq}`
    this.raws.push({ ref: raw_ref, channel, received_at: at, raw })

    const scrubbedBody = scrubSecrets(mail.body)
    const scrubbedSubject = scrubSecrets(mail.subject ?? '')
    const secrets_scrubbed = scrubbedBody.rules.length + scrubbedSubject.rules.length > 0
    const fencedText = fenceInbound(scrubbedBody.text)

    const parts: MessagePart[] = [{ type: 'text', text: fencedText }]
    const customer = this.resolver.customer?.(mail.from)
    const threadExternal =
      mail.thread_id === undefined || mail.thread_id === 'new' ? undefined : mail.thread_id
    const routed = this.resolver.route?.({
      channel,
      from: mail.from,
      subject: scrubbedSubject.text,
      text: scrubbedBody.text,
    })

    const event: InboundEvent = {
      id: `in_${this.seq}_${sha256(key).slice(0, 8)}`,
      schema_version: 1,
      workspace_id: workspace_id.length > 0 ? workspace_id : this.workspace,
      channel,
      kind: 'message',
      received_at: at,
      occurred_at: mail.at ?? at,
      dedupe_key: key,
      parts,
      raw_ref,
      routing: routed ?? { confidence: 0 },
      secrets_scrubbed,
      actor: {
        external_id: mail.from,
        ...(mail.from.length > 0 ? { display: mail.from.split('@')[0] ?? mail.from } : {}),
        ...(customer === undefined ? {} : { resolved: customer }),
      },
      ...(threadExternal === undefined
        ? {}
        : {
            thread: {
              external_id: threadExternal,
              ...(this.resolver.thread?.(threadExternal) === undefined
                ? {}
                : { resolved: this.resolver.thread(threadExternal) as ObjectRef }),
            },
          }),
    }

    this.seen.set(key, { key, at_ms: Date.parse(at), event })

    // 解析不到发件人身份或路由不到职责 → 死信进 owner 车道（18 §2.2）
    if (customer === undefined || event.routing.role_id === undefined) {
      this.dead.push(event)
      this.onDeadLetter?.(event)
      return { event, deduped: false }
    }
    this.events.push(event)
    return { event, deduped: false }
  }

  /** 替身无退避队列：无事可推进 */

  async pump(): Promise<number> {
    return 0
  }

  async deadLetters(workspace_id: WorkspaceId): Promise<InboundEvent[]> {
    return this.dead.filter((e) => e.workspace_id === workspace_id)
  }

  /** 已受理的入站事件（不含死信）。 */
  accepted(): InboundEvent[] {
    return [...this.events]
  }

  /** 某条入站事件的未围栏原文（只给审计与人看，永不进 prompt）。 */
  rawOf(event: InboundEvent): RawRecord | undefined {
    return this.raws.find((r) => r.ref === event.raw_ref)
  }

  /** `parts` 里的文本（已围栏）。 */
  static textOf(event: InboundEvent): string {
    return event.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
  }
}

function asEmail(raw: unknown): RawEmail {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StandInError('invalid_input', '入站原始载荷必须是对象')
  }
  const o = raw as Record<string, unknown>
  const from = o.from
  const body = o.body
  if (typeof from !== 'string' || from.length === 0) {
    throw new StandInError('invalid_input', '入站邮件缺 from')
  }
  if (typeof body !== 'string') {
    throw new StandInError('invalid_input', '入站邮件缺 body')
  }
  return {
    from,
    body,
    ...(typeof o.message_id === 'string' ? { message_id: o.message_id } : {}),
    ...(Array.isArray(o.to) ? { to: o.to.filter((x): x is string => typeof x === 'string') } : {}),
    ...(typeof o.subject === 'string' ? { subject: o.subject } : {}),
    ...(typeof o.at === 'string' ? { at: o.at } : {}),
    ...(typeof o.thread_id === 'string' ? { thread_id: o.thread_id } : {}),
  }
}
