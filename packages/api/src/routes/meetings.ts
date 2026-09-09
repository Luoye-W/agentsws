/**
 * 37 §4.3 会议 API：`/v1/meetings`、记录接入（上传 / 粘贴 / 导入，multipart 与 JSON）、
 * 处理、产出、纪要导出。
 *
 * 三条边界：
 * - **会议只属于一个工作区**：跨工作区一律 404（不泄露存在性）。
 * - **网关里不写业务**：抽取、围栏、认领卡全在 `@agentsws/meetings` 的管线里，这里只转发。
 * - **音频不经这条路回给前端**：录音上传是单向的；要回看只给受控区的引用与摘要。
 *
 * 准入沿工作台面的做法（`routes/workstation.ts`）：**能读自己的审批队列**就能用会议面。
 * 会议对象本身不写任何业务数据域——真正改公司东西的是它产出的审批项（`claim` /
 * `knowledge_update` / `policy_change`），那条路径由 14 判定。契约建议：`DataDomain`
 * 加一个 `meeting`，这里换成 `meeting.read` / `meeting.stage`（见报告 §4）。
 */
import type {
  MaybePromise,
  Meeting,
  MeetingCreateInput,
  MeetingFilter,
  MeetingOutputs,
  MeetingParticipant,
  MeetingPatch,
  MeetingRecord,
  MeetingRecordSourceKind,
  MeetingStatus,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const ACCESS = {
  domain: 'approval',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const

const SOURCES = [
  'online_meeting',
  'in_app_recording',
  'device',
  'third_party',
  'handed_over',
  'manual_notes',
] as const
const STATUSES = ['scheduled', 'in_progress', 'done', 'cancelled'] as const

/** 处理一条记录的结果；`approvals` / `system_card` 由 `@agentsws/meetings` 定形，网关只转发。 */
export interface MeetingProcessOutcome {
  record: MeetingRecord
  outputs?: MeetingOutputs
  approvals?: unknown
  system_card?: unknown
}

/** 一条产出 → 一张审批项（14）。已经发过（同 `dedupe_key`）就回同一条。 */
export interface MeetingSendCardInput {
  meeting_id: string
  record_id: string
  kind: 'claim' | 'knowledge_update' | 'policy_change'
  item_id: string
  actor: PersonId
}

export interface MeetingIngestInput {
  workspace_id: WorkspaceId
  meeting_id: string
  actor: PersonId
  source: MeetingRecordSourceKind
  payload: unknown
}

/** 37 §4 会议端口；没装配时这几条路由回 not_implemented。 */
export interface MeetingsPort {
  list(filter: MeetingFilter): MaybePromise<Meeting[]>
  get(id: string): MaybePromise<Meeting | undefined>
  create(input: MeetingCreateInput): MaybePromise<Meeting>
  update(id: string, patch: MeetingPatch): MaybePromise<Meeting>
  records(meeting_id: string): MaybePromise<MeetingRecord[]>
  ingest(input: MeetingIngestInput): MaybePromise<MeetingRecord[]>
  process(record_id: string): MaybePromise<MeetingProcessOutcome>
  outputs(meeting_id: string): MaybePromise<MeetingOutputs[]>
  /** markdown 纪要（37 §4.2 免费默认层）。 */
  minutes(meeting_id: string): MaybePromise<string>
  /** 把一条产出发成审批项（认领卡 / 知识确认 / 边界确认）。 */
  sendCard(input: MeetingSendCardInput): MaybePromise<{ approval_id: string; title: string }>
}

const Participant = z.object({
  person_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  external: z.boolean().optional(),
})

/** `exactOptionalPropertyTypes`：zod 的 optional 会带上 `| undefined`，落契约前先把空键去掉。 */
function participantsOf(rows: z.infer<typeof Participant>[]): MeetingParticipant[] {
  return rows.map((r) => ({
    ...(r.person_id === undefined ? {} : { person_id: r.person_id }),
    ...(r.name === undefined ? {} : { name: r.name }),
    ...(r.email === undefined ? {} : { email: r.email }),
    ...(r.external === undefined ? {} : { external: r.external }),
  }))
}

const Location = z.union([z.string().min(1), z.object({ online: z.string().min(1) })])

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  start: z.string().min(1),
  end: z.string().min(1),
  location: Location.optional(),
  participants: z.array(Participant).max(200).default([]),
  agenda: z.string().max(4000).optional(),
  status: z.enum(STATUSES).optional(),
  position_id: z.string().min(1).optional(),
  matter_id: z.string().min(1).optional(),
  calendar_ref: z
    .object({
      source: z.enum(['google', 'outlook', 'feishu', 'ics', 'local']),
      event_id: z.string().min(1),
    })
    .optional(),
})

const UpdateBody = z.object({
  title: z.string().min(1).max(200).optional(),
  start: z.string().min(1).optional(),
  end: z.string().min(1).optional(),
  location: Location.optional(),
  participants: z.array(Participant).max(200).optional(),
  agenda: z.string().max(4000).optional(),
  status: z.enum(STATUSES).optional(),
  matter_id: z.string().min(1).optional(),
})

const SendCardBody = z.object({
  record_id: z.string().min(1),
  kind: z.enum(['claim', 'knowledge_update', 'policy_change']),
  item_id: z.string().min(1),
})

const RecordBody = z.object({
  source: z.enum(SOURCES),
  text: z.string().optional(),
  /** 录音块按 base64 传（JSON 档）；multipart 档直接传文件。 */
  audio_base64: z.string().optional(),
  mime: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  format: z.enum(['srt', 'vtt', 'speaker_blocks', 'plain']).optional(),
  notice_given: z.boolean().optional(),
  chunk_index: z.number().int().nonnegative().optional(),
  final: z.boolean().optional(),
  note: z.string().max(500).optional(),
})

function portOf(deps: GatewayDeps): MeetingsPort {
  if (deps.meetings === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装会议内核')
  return deps.meetings
}

/** base64 → 字节。给的不是合法 base64 就当无效输入，不往下传。 */
function decodeBase64(value: string): Uint8Array {
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new ApiError('invalid_input', 'audio_base64 不是合法的 base64')
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

const asBool = (v: unknown): boolean | undefined =>
  v === undefined ? undefined : v === 'true' || v === true

const asInt = (v: unknown): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

interface RecordPayload {
  source: MeetingRecordSourceKind
  payload: Record<string, unknown>
}

/** multipart（一键录音、上传文件）与 JSON（粘贴、导入）两条路，归一成同一份载荷。 */
async function recordPayload(
  c: Parameters<Route['handler']>[0],
  meeting_id: string,
): Promise<RecordPayload> {
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.includes('multipart/form-data')) {
    const input = await body(c, RecordBody)
    const bytes = input.audio_base64 === undefined ? undefined : decodeBase64(input.audio_base64)
    return {
      source: input.source,
      payload: {
        meeting_id,
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(bytes === undefined ? {} : { bytes }),
        ...(input.mime === undefined ? {} : { mime: input.mime }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.language === undefined ? {} : { language: input.language }),
        ...(input.format === undefined ? {} : { format: input.format }),
        ...(input.notice_given === undefined ? {} : { notice_given: input.notice_given }),
        ...(input.chunk_index === undefined ? {} : { chunk_index: input.chunk_index }),
        ...(input.final === undefined ? {} : { final: input.final }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    }
  }

  const form = await c.req.parseBody()
  const source = String(form.source ?? '')
  if (!(SOURCES as readonly string[]).includes(source))
    throw new ApiError('invalid_input', 'source 不合法')
  const file = form.file
  const payload: Record<string, unknown> = { meeting_id }
  if (file instanceof File) {
    payload.bytes = new Uint8Array(await file.arrayBuffer())
    payload.mime =
      form.mime === undefined ? file.type || 'application/octet-stream' : String(form.mime)
    payload.name = file.name
  } else if (typeof form.text === 'string') {
    payload.text = form.text
  } else {
    throw new ApiError('invalid_input', 'multipart 里既没有 file 也没有 text')
  }
  for (const key of ['language', 'format', 'note'] as const) {
    if (typeof form[key] === 'string') payload[key] = form[key]
  }
  const notice = asBool(form.notice_given)
  if (notice !== undefined) payload.notice_given = notice
  const chunk = asInt(form.chunk_index)
  if (chunk !== undefined) payload.chunk_index = chunk
  const final = asBool(form.final)
  if (final !== undefined) payload.final = final
  return { source: source as MeetingRecordSourceKind, payload }
}

async function requireMeeting(
  deps: GatewayDeps,
  id: string,
  workspace_id: WorkspaceId,
): Promise<Meeting> {
  const meeting = await portOf(deps).get(id)
  // 跨工作区一律 404：不泄露"这个会议存在"
  if (meeting === undefined || meeting.workspace_id !== workspace_id)
    throw new ApiError('not_found', '会议不存在')
  return meeting
}

export function meetingRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/meetings',
        operationId: 'listMeetings',
        summary: '会议列表（按与会者 / 状态 / 时间窗筛）',
        tag: 'meetings',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [
          { name: 'participant', in: 'query', description: '与会者 person_id / 邮箱 / 姓名' },
          {
            name: 'status',
            in: 'query',
            description: 'scheduled | in_progress | done | cancelled',
          },
          { name: 'from', in: 'query', description: '起（ISO8601）' },
          { name: 'to', in: 'query', description: '止（ISO8601）' },
          { name: 'limit', in: 'query', description: '最多几条', schema: { type: 'integer' } },
        ],
        returns: 'Meeting[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const status = c.req.query('status')
        if (status !== undefined && !(STATUSES as readonly string[]).includes(status))
          throw new ApiError('invalid_input', 'status 不合法')
        const limitRaw = c.req.query('limit')
        const limit = limitRaw === undefined ? undefined : Number(limitRaw)
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0))
          throw new ApiError('invalid_input', 'limit 不合法')
        const filter: MeetingFilter = {
          workspace_id: p.workspace_id,
          ...(c.req.query('participant') === undefined
            ? {}
            : { participant: c.req.query('participant') as string }),
          ...(status === undefined ? {} : { status: [status as MeetingStatus] }),
          ...(c.req.query('from') === undefined ? {} : { from: c.req.query('from') as string }),
          ...(c.req.query('to') === undefined ? {} : { to: c.req.query('to') as string }),
          ...(limit === undefined ? {} : { limit }),
        }
        return ok(c, await portOf(deps).list(filter))
      },
    ),

    route(
      {
        method: 'post',
        path: '/v1/meetings',
        operationId: 'createMeeting',
        summary: '新建会议（有外部参与者时默认 restricted）',
        tag: 'meetings',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        body: CreateBody,
        returns: 'Meeting',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const input = await body(c, CreateBody)
        return ok(
          c,
          await portOf(deps).create({
            workspace_id: p.workspace_id,
            title: input.title,
            start: input.start,
            end: input.end,
            participants: participantsOf(input.participants),
            status: input.status ?? 'scheduled',
            created_by: p.person_id,
            position_id: input.position_id ?? a.id,
            ...(input.location === undefined ? {} : { location: input.location }),
            ...(input.agenda === undefined ? {} : { agenda: input.agenda }),
            ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id }),
            ...(input.calendar_ref === undefined ? {} : { calendar_ref: input.calendar_ref }),
          }),
        )
      },
    ),

    route(
      {
        method: 'get',
        path: '/v1/meetings/:id',
        operationId: 'getMeeting',
        summary: '会议详情（含记录清单与最近一次产出）',
        tag: 'meetings',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [{ name: 'id', in: 'path', required: true, description: '会议 id' }],
        returns: '{ meeting, records }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const meeting = await requireMeeting(deps, param(c, 'id'), p.workspace_id)
        return ok(c, { meeting, records: await portOf(deps).records(meeting.id) })
      },
    ),

    route(
      {
        method: 'put',
        path: '/v1/meetings/:id',
        operationId: 'updateMeeting',
        summary: '改会议（改与会者会重算敏感级）',
        tag: 'meetings',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [{ name: 'id', in: 'path', required: true, description: '会议 id' }],
        body: UpdateBody,
        returns: 'Meeting',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const meeting = await requireMeeting(deps, param(c, 'id'), p.workspace_id)
        const input = await body(c, UpdateBody)
        const patch: MeetingPatch = {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.start === undefined ? {} : { start: input.start }),
          ...(input.end === undefined ? {} : { end: input.end }),
          ...(input.location === undefined ? {} : { location: input.location }),
          ...(input.participants === undefined
            ? {}
            : { participants: participantsOf(input.participants) }),
          ...(input.agenda === undefined ? {} : { agenda: input.agenda }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id }),
        }
        return ok(c, await portOf(deps).update(meeting.id, patch))
      },
    ),

    route(
      {
        method: 'get',
        path: '/v1/meetings/:id/records',
        operationId: 'listMeetingRecords',
        summary: '这个会议的记录（六种来源）',
        tag: 'meetings',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [{ name: 'id', in: 'path', required: true, description: '会议 id' }],
        returns: 'MeetingRecord[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const meeting = await requireMeeting(deps, param(c, 'id'), p.workspace_id)
        return ok(c, await portOf(deps).records(meeting.id))
      },
    ),

    route(
      {
        method: 'post',
        path: '/v1/meetings/:id/records',
        operationId: 'addMeetingRecord',
        summary: '加一份记录：粘贴 / 上传 / 导入（multipart 与 JSON 都收）',
        tag: 'meetings',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [{ name: 'id', in: 'path', required: true, description: '会议 id' }],
        body: RecordBody,
        returns: 'MeetingRecord[]（录音分块时未收满会是空数组）',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const meeting = await requireMeeting(deps, param(c, 'id'), p.workspace_id)
        const { source, payload } = await recordPayload(c, meeting.id)
        return ok(
          c,
          await portOf(deps).ingest({
            workspace_id: p.workspace_id,
            meeting_id: meeting.id,
            actor: p.person_id,
            source,
            payload,
          }),
        )
      },
    ),

    route(
      {
        method: 'post',
        path: '/v1/meetings/:id/records/:rid/process',
        operationId: 'processMeetingRecord',
        summary: '处理一份记录：转写 → 围栏 → 抽取 → 认领卡',
        tag: 'meetings',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [
          { name: 'id', in: 'path', required: true, description: '会议 id' },
          { name: 'rid', in: 'path', required: true, description: '记录 id' },
        ],
        returns: '{ record, outputs?, approvals?, system_card? }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const meeting = await requireMeeting(deps, param(c, 'id'), p.workspace_id)
        const rid = param(c, 'rid')
        const records = await portOf(deps).records(meeting.id)
        if (!records.some((r) => r.id === rid))
          throw new ApiError('not_found', '这份记录不在这个会议里')
        return ok(c, await portOf(deps).process(rid))
      },
    ),

    route(
      {
        method: 'get',
        path: '/v1/meetings/:id/outputs',
        operationId: 'getMeetingOutputs',
        summary: '产出四栏：决定 / 待办提案 / 边界答案 / 知识候选',
        tag: 'meetings',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [{ name: 'id', in: 'path', required: true, description: '会议 id' }],
        returns: 'MeetingOutputs[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const meeting = await requireMeeting(deps, param(c, 'id'), p.workspace_id)
        return ok(c, await portOf(deps).outputs(meeting.id))
      },
    ),

    route(
      {
        method: 'post',
        path: '/v1/meetings/:id/outputs/send',
        operationId: 'sendMeetingCard',
        summary: '把一条产出发成审批项：认领卡 / 知识确认 / 边界确认',
        tag: 'meetings',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [{ name: 'id', in: 'path', required: true, description: '会议 id' }],
        body: SendCardBody,
        returns: '{ approval_id, title }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const meeting = await requireMeeting(deps, param(c, 'id'), p.workspace_id)
        const input = await body(c, SendCardBody)
        const records = await portOf(deps).records(meeting.id)
        if (!records.some((r) => r.id === input.record_id))
          throw new ApiError('not_found', '这份记录不在这个会议里')
        return ok(
          c,
          await portOf(deps).sendCard({
            meeting_id: meeting.id,
            record_id: input.record_id,
            kind: input.kind,
            item_id: input.item_id,
            actor: p.person_id,
          }),
        )
      },
    ),

    route(
      {
        method: 'get',
        path: '/v1/meetings/:id/export',
        operationId: 'exportMeetingMinutes',
        summary: '导出会议纪要（markdown）',
        tag: 'meetings',
        auth: 'bearer',
        assignment: true,
        authz: ACCESS,
        params: [{ name: 'id', in: 'path', required: true, description: '会议 id' }],
        returns: '{ format: "markdown", content }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const meeting = await requireMeeting(deps, param(c, 'id'), p.workspace_id)
        return ok(c, {
          format: 'markdown' as const,
          filename: `${meeting.title}.md`,
          content: await portOf(deps).minutes(meeting.id),
        })
      },
    ),
  ]
}
