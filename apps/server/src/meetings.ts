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
  CalendarItem,
  Clock,
  EventEnvelope,
  Matter,
  Meeting,
  MeetingOutputs,
  MeetingStore,
  ObjectRef,
  PersonId,
} from '@agentsws/contracts'
import type { RawCipher } from '@agentsws/core'
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
import type { Work } from '@agentsws/work'

export interface MeetingsAssembly {
  store: MeetingStore
  raw: MeetingRawStore
  pipeline: MeetingPipeline
  port: MeetingsPort
  /** 37 §2.2b：会议跟进的事项由工作模型开；装配完成后由 server 注入。 */
  bind(work: Work): void
  /** 会议 → 日历（37 §2 表第三行「会议一定有时间，一定上日历」）。 */
  calendarItems(range: { from: string; to: string }, workspace_id: string): Promise<CalendarItem[]>
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
  /**
   * 21 §4 / 18 §2.1：受控原始材料区的加密。传 `data.keyring`（`@agentsws/data`
   * 的主体密钥环）——录音与会议文档就以密文落盘，销毁密钥即不可读。
   * 不传就是明文落盘（只有 `dbDir` 为空的内存档才该这样）。
   */
  cipher?: RawCipher
}

export function createMeetings(options: MeetingsOptions): MeetingsAssembly {
  const { dbDir, clock, random } = options
  const store: MeetingStore =
    dbDir === undefined
      ? createMemoryMeetingStore({ clock, random })
      : createSqliteMeetingStore({ dbPath: join(dbDir, 'meetings.sqlite'), clock, random })
  const cipherOpt = options.cipher === undefined ? {} : { cipher: options.cipher }
  const raw: MeetingRawStore =
    dbDir === undefined
      ? new MemoryMeetingRawStore(cipherOpt)
      : createSqliteMeetingRawStore({
          dbPath: join(dbDir, 'meetings-raw.sqlite'),
          clock,
          ...cipherOpt,
        })

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
    /**
     * 40 §3.4：认领卡上写一句「可能与 X 重复」。
     * 只加在**卡面**上（`summary`），不动 payload——`ClaimPayload` 是契约形状。
     */
    const collision =
      input.kind === 'claim' && work !== undefined
        ? work.findSimilar({
            title: (request.payload as { text?: string }).text ?? request.title,
            at: options.clock.now(),
            item_kind: 'meeting',
            ...(meeting.position_id === undefined ? {} : { position_id: meeting.position_id }),
          })
        : []
    const summary =
      collision[0] === undefined
        ? request.summary
        : `${request.summary}｜可能与「${collision[0].title}」重复（${collision[0].owner} 正在做）`
    const item = await options.approvals.create({
      workspace_id: meeting.workspace_id,
      schema_version: 1,
      kind: request.kind as ApprovalKind,
      role_id,
      subject: { object: subject },
      dedupe_key: request.dedupe_key,
      title: request.title,
      summary,
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
    /**
     * 40 §3.2：会议产出的待办**先进待认领池**（`Todo` 没有主人），谁点「我来」谁是主人。
     * 卡还是那张卡——批准它就是认领（见 `createWorkPort().acceptClaim`）；
     * 池子让**其他人**也看得见这条活，并在有人认下之后立刻看到「已认领」。
     */
    if (input.kind === 'claim' && work !== undefined) {
      const already = work
        .listTodos({})
        .some((t) => t.origin?.card_id === item.id || t.origin?.meeting_id === item.id)
      if (!already) {
        const payload = request.payload as { text?: string; due?: string }
        const anchor =
          meeting.matter_id === undefined
            ? undefined
            : work.store
                .listMatterEvents(meeting.matter_id, { limit: 500 })
                .find((e) => e.text === payload.text)
        work.poolTodo({
          title: payload.text ?? request.title,
          source: 'meeting',
          origin: { card_id: item.id, meeting_id: meeting.id },
          ...(meeting.position_id === undefined ? {} : { position_id: meeting.position_id }),
          ...(meeting.matter_id === undefined ? {} : { matter_id: meeting.matter_id }),
          ...(anchor === undefined ? {} : { anchor: { matter_event_id: anchor.id } }),
          ...(payload.due === undefined ? {} : { due: payload.due }),
          similar_to: collision.map((c) => c.id),
        })
      }
    }
    return { approval_id: item.id, title: item.title }
  }

  let work: Work | undefined

  /**
   * 37 §2.2b / §4.1：会议记录一处理完就开一个 `meeting` 类事项，把 `Meeting.matter_id`
   * 回填回去，产出（决定 / 待办提案 / 边界答案 / 知识候选）挂在它的时间线上。
   *
   * 事项是**上下文的家**：认领卡认下来之后建的待办 `anchor` 就指向这里的某一条，
   * 点待办标题回到这个会议现场。会议本身固定在 `pinned` 里。
   */
  async function openMatter(
    meeting: Meeting,
    outputs: MeetingOutputs,
  ): Promise<Matter | undefined> {
    if (work === undefined) return undefined
    let matter_id = meeting.matter_id
    if (matter_id === undefined || work.getMatter(matter_id) === undefined) {
      const matter = work.createMatter({
        kind: 'meeting',
        title: meeting.title,
        participants: meeting.participants
          .map((p) => p.person_id)
          .filter((id): id is PersonId => id !== undefined),
        summary: `会议「${meeting.title}」的跟进：${outputs.decisions.length} 条决定、${outputs.todos.length} 条待办提案。`,
        pinned: [{ type: 'meeting', id: meeting.id }],
        ...(meeting.position_id === undefined ? {} : { position_id: meeting.position_id }),
      })
      matter_id = matter.id
      await store.updateMeeting(meeting.id, { matter_id })
    }
    const existing = new Set(
      work.store.listMatterEvents(matter_id, { limit: 500 }).map((e) => e.text),
    )
    const note = (text: string): void => {
      if (text === '' || existing.has(text)) return
      existing.add(text)
      work?.appendEvent(matter_id as string, {
        kind: 'meeting',
        text,
        actor: { kind: 'agent', id: outputs.processor },
        ref: { type: 'meeting_record', id: outputs.record_id },
      })
    }
    for (const d of outputs.decisions) note(`决定：${d.text}`)
    // 待办提案的时间线文本就是提案原文——认领卡认下来时按它找回锚点
    for (const t of outputs.todos) note(t.text)
    for (const b of outputs.boundary_answers) note(`口径：${b.question} → ${b.answer}`)
    for (const k of outputs.knowledge) note(`知识候选：${k.statement}`)
    return work.getMatter(matter_id)
  }

  const port: MeetingsPort = {
    list: (filter) => store.listMeetings(filter),
    get: (id) => store.getMeeting(id),
    create: (input) => store.createMeeting(input),
    update: (id, patch) => store.updateMeeting(id, patch),
    records: (meeting_id) => store.records(meeting_id),
    ingest: (input: MeetingIngestInput) => pipeline.ingest(input),
    process: async (record_id): Promise<MeetingProcessOutcome> => {
      const outcome = await pipeline.process(record_id)
      if (outcome.outputs !== undefined) {
        const meeting = await store.getMeeting(outcome.outputs.meeting_id)
        if (meeting !== undefined) await openMatter(meeting, outcome.outputs)
      }
      return outcome
    },
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
    bind(w) {
      work = w
    },
    async calendarItems(range, workspace_id) {
      const meetings = await store.listMeetings({
        workspace_id,
        from: range.from,
        to: range.to,
      })
      return meetings
        .filter((m) => m.status !== 'cancelled')
        .map((m) => ({
          id: `cal_meeting_${m.id}`,
          source: 'meeting' as const,
          title: m.title,
          start: m.start,
          end: m.end,
          all_day: false,
          ref: { type: 'meeting', id: m.id },
          status: m.status,
          ...(m.position_id === undefined ? {} : { position_id: m.position_id }),
          ...(m.matter_id === undefined ? {} : { matter_id: m.matter_id }),
        }))
    },
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
    // 走端口而不是管线：这样会议事项与时间线也一起开出来（37 §2.2b）
    for (const record of records) await assembly.port.process(record.id)
  }
}
