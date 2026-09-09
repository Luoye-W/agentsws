/**
 * 会议内核的装配（37 §4）：存储两档、受控原始材料区、处理管线、`MeetingsPort`。
 *
 * 装配只做三件事：把网关的 `transcribe` 接成管线的 ASR 槽、把事件接进同一条事件日志、
 * 把 `MeetingStore` 的读写投影成 `@agentsws/api` 的端口。业务全在 `@agentsws/meetings` 里。
 */
import { join } from 'node:path'
import type {
  MeetingIngestInput,
  MeetingProcessOutcome,
  MeetingSendCardInput,
  MeetingsPort,
} from '@agentsws/api'
import type {
  ApprovalBus,
  ApprovalKind,
  Clock,
  EventEnvelope,
  MeetingStore,
  ObjectRef,
  PersonId,
} from '@agentsws/contracts'
import {
  approvalRequestsFor,
  createMeetingPipeline,
  createMemoryMeetingStore,
  createSqliteMeetingRawStore,
  createSqliteMeetingStore,
  MEETING_SAMPLES,
  type MeetingPipeline,
  type MeetingRawStore,
  MemoryMeetingRawStore,
  renderMinutes,
  type SqliteMeetingRawStore,
  type SqliteMeetingStore,
} from '@agentsws/meetings'
import type { ModelGatewayApi } from '@agentsws/model-gateway'

export interface MeetingsAssembly {
  store: MeetingStore
  raw: MeetingRawStore
  pipeline: MeetingPipeline
  port: MeetingsPort
  close(): void
}

export interface MeetingsOptions {
  dbDir?: string
  clock: Clock
  random: () => number
  models: ModelGatewayApi
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 产出发成审批项走同一条队列（14 §1「所有改变都以一条审批项进同一条队列」）。 */
  approvals: ApprovalBus
  /** 卡片挂在哪个职责下；默认 `common.member`（06 §2.1 秘书以本人权限运行）。 */
  role_id?: string
}

export function createMeetings(options: MeetingsOptions): MeetingsAssembly {
  const { dbDir, clock, random } = options
  const store: MeetingStore =
    dbDir === undefined
      ? createMemoryMeetingStore({ clock, random })
      : createSqliteMeetingStore({ dbPath: join(dbDir, 'meetings.sqlite'), clock, random })
  const raw: MeetingRawStore =
    dbDir === undefined
      ? new MemoryMeetingRawStore()
      : createSqliteMeetingRawStore({ dbPath: join(dbDir, 'meetings-raw.sqlite'), clock })

  const pipeline = createMeetingPipeline({
    store,
    raw,
    clock,
    random,
    // 22 ASR 槽；没装 ASR provider 的发行版这里会抛，管线转成一张系统卡
    transcribe: (audio, meta) => options.models.transcribe(audio, meta),
    eventSink: (e) => {
      options.appendEvent(e)
    },
  })

  const role_id = options.role_id ?? 'common.member'

  /**
   * 一条产出 → 一张审批项。payload 与去重键都由 `@agentsws/meetings` 的
   * `approvalRequestsFor` 给（14 §3 / §5），这里只补路由与证据这层信封。
   *
   * 认领卡的收件人：原文点到的人（明确指派）优先，否则是按下按钮的人——
   * **本人确认前不形成责任**（31 I13），所以发给谁只决定"问谁"，不决定"归谁"。
   */
  async function sendCard(input: MeetingSendCardInput) {
    const meeting = await store.getMeeting(input.meeting_id)
    if (meeting === undefined) throw new Error(`会议不存在：${input.meeting_id}`)
    const outputs = (await store.outputs(input.meeting_id)).find(
      (o) => o.record_id === input.record_id,
    )
    if (outputs === undefined) throw new Error('这份记录还没有产出，先处理一次')
    const requests = approvalRequestsFor(outputs, meeting)
    const pool =
      input.kind === 'claim'
        ? requests.claims
        : input.kind === 'knowledge_update'
          ? requests.knowledge
          : requests.boundaries
    const index =
      input.kind === 'claim'
        ? outputs.todos.findIndex((x) => x.id === input.item_id)
        : input.kind === 'knowledge_update'
          ? outputs.knowledge.findIndex((x) => x.id === input.item_id)
          : outputs.boundary_answers.findIndex((x) => x.id === input.item_id)
    const request = index < 0 ? undefined : pool[index]
    if (request === undefined) throw new Error(`产出里没有这一条：${input.item_id}`)

    const assignee = input.kind === 'claim' ? outputs.todos[index]?.assignee_person_id : undefined
    const recipient: PersonId = assignee ?? input.actor
    const subject: ObjectRef = request.subject
    const item = await options.approvals.create({
      workspace_id: meeting.workspace_id,
      schema_version: 1,
      kind: request.kind as ApprovalKind,
      role_id,
      subject: { object: subject },
      dedupe_key: request.dedupe_key,
      title: request.title,
      summary: request.summary,
      payload: request.payload,
      evidence: {
        source_events: [],
        // 14 §6：knowledge_update 空 diff 不建项——会上说的口径是"从无到有"的一条
        ...(request.kind === 'knowledge_update'
          ? {
              diff: {
                before: null,
                after: (request.payload as { statement: string }).statement,
                summary: '会上说的口径，采纳后进知识库',
              },
            }
          : {}),
        // 会议记录是这次运行"见过"的唯一对象；出处在 payload 里逐条带着
        provenance: { seen: [{ type: 'meeting_record', id: input.record_id }] },
        precheck: { fencing: 'ok', provenance: 'ok' },
      },
      proposer: { kind: 'agent', id: outputs.processor },
      // 契约说 automation 可以只给等级，但 txn 的预检直接读 mandate_check.within，
      // 所以这里给全（见报告 §4 的契约建议）。会议产出永远人审：L1、不自动通过。
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [
          { person: recipient, via: assignee === undefined ? 'role_holder' : 'explicit' },
        ],
        ...(assignee === undefined ? {} : { explicit: assignee }),
        rule: assignee === undefined ? 'role_holder' : 'explicit',
        escalation: {
          after_hours: 24,
          business_hours: true,
          chain: ['owner'],
          escalated_at: [],
        },
        separation_of_duties: false,
      },
      priority: request.priority,
    })
    return { approval_id: item.id, title: item.title }
  }

  const port: MeetingsPort = {
    list: (filter) => store.listMeetings(filter),
    get: (id) => store.getMeeting(id),
    create: (input) => store.createMeeting(input),
    update: (id, patch) => store.updateMeeting(id, patch),
    records: (meeting_id) => store.records(meeting_id),
    ingest: (input: MeetingIngestInput) => pipeline.ingest(input),
    process: (record_id): Promise<MeetingProcessOutcome> => pipeline.process(record_id),
    outputs: (meeting_id) => store.outputs(meeting_id),
    sendCard,
    minutes: async (meeting_id) => {
      const meeting = await store.getMeeting(meeting_id)
      if (meeting === undefined) return ''
      return renderMinutes({
        meeting,
        records: await store.records(meeting_id),
        outputs: await store.outputs(meeting_id),
      })
    },
  }

  return {
    store,
    raw,
    pipeline,
    port,
    close() {
      ;(store as Partial<SqliteMeetingStore>).close?.()
      ;(raw as Partial<SqliteMeetingRawStore>).close?.()
    },
  }
}

/**
 * demo 用的会议数据：从合成样本里挑三份，跑完整管线（粘贴 → 围栏 → 抽取 → 认领卡），
 * 所以工作台上看到的产出是真跑出来的，不是照着抄的。
 */
export async function seedDemoMeetings(
  assembly: MeetingsAssembly,
  ctx: { workspace_id: string; owner: string; position_id?: string; clock: Clock },
): Promise<void> {
  const picks = ['s01_weekly_zh', 's03_policy_srt', 's11_high_risk_assignment']
  const day = 86_400_000
  const base = Date.parse(ctx.clock.now())
  let i = 0
  for (const id of picks) {
    const sample = MEETING_SAMPLES.find((s) => s.id === id)
    if (sample === undefined) continue
    i += 1
    const start = new Date(base - i * day).toISOString()
    const meeting = await assembly.store.createMeeting({
      workspace_id: ctx.workspace_id,
      title: sample.title,
      start,
      end: new Date(Date.parse(start) + 3_600_000).toISOString(),
      participants: sample.participants,
      status: 'done',
      created_by: ctx.owner,
      ...(ctx.position_id === undefined ? {} : { position_id: ctx.position_id }),
    })
    const records = await assembly.pipeline.ingest({
      workspace_id: ctx.workspace_id,
      meeting_id: meeting.id,
      actor: ctx.owner,
      source: sample.source === 'in_app_recording' ? 'manual_notes' : sample.source,
      payload: {
        text: sample.text,
        mime: sample.mime,
        format: sample.format,
        notice_given: true,
      },
    })
    for (const record of records) await assembly.pipeline.process(record.id)
  }
}
