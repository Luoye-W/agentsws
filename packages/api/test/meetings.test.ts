/**
 * 37 §4.3 会议路由的一致性用例。只测网关本身（信封 / 鉴权 / 工作区边界 / multipart 与 JSON 两条路），
 * 抽取与围栏在 `@agentsws/meetings` 里测。
 */
import type {
  Meeting,
  MeetingCreateInput,
  MeetingFilter,
  MeetingOutputs,
  MeetingPatch,
  MeetingRecord,
} from '@agentsws/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeetingIngestInput, MeetingProcessOutcome, MeetingsPort } from '../src/index.js'
import { type Harness, harness, T0 } from './helpers.js'

class MemoryMeetings implements MeetingsPort {
  readonly meetings = new Map<string, Meeting>()
  readonly recordsByMeeting = new Map<string, MeetingRecord[]>()
  readonly outputsByMeeting = new Map<string, MeetingOutputs[]>()
  readonly ingests: MeetingIngestInput[] = []
  readonly processed: string[] = []
  #seq = 0

  constructor(readonly workspace_id: string) {}

  list(filter: MeetingFilter): Meeting[] {
    return [...this.meetings.values()].filter((m) => {
      if (m.workspace_id !== filter.workspace_id) return false
      if (filter.status !== undefined && !filter.status.includes(m.status)) return false
      if (
        filter.participant !== undefined &&
        !m.participants.some((p) => p.name === filter.participant)
      )
        return false
      return true
    })
  }
  get(id: string): Meeting | undefined {
    return this.meetings.get(id)
  }
  create(input: MeetingCreateInput): Meeting {
    this.#seq += 1
    const id = `mtg_${this.#seq}`
    const meeting: Meeting = {
      ...input,
      id,
      schema_version: 1,
      records: [],
      sensitivity: input.participants.some((p) => p.external === true) ? 'restricted' : 'internal',
      created_at: T0,
      updated_at: T0,
    }
    this.meetings.set(id, meeting)
    return meeting
  }
  update(id: string, patch: MeetingPatch): Meeting {
    const next = { ...(this.meetings.get(id) as Meeting), ...patch, updated_at: T0 }
    this.meetings.set(id, next)
    return next
  }
  records(meeting_id: string): MeetingRecord[] {
    return this.recordsByMeeting.get(meeting_id) ?? []
  }
  ingest(input: MeetingIngestInput): MeetingRecord[] {
    this.ingests.push(input)
    this.#seq += 1
    const record: MeetingRecord = {
      id: `mrec_${this.#seq}`,
      schema_version: 1,
      workspace_id: input.workspace_id,
      meeting_id: input.meeting_id,
      source: input.source,
      consent: { recorded_by: input.actor, notice_given: true },
      status: 'ingested',
      sensitivity: 'internal',
      ingested_by: { kind: 'person', id: input.actor },
      created_at: T0,
      updated_at: T0,
    }
    const list = this.recordsByMeeting.get(input.meeting_id) ?? []
    list.push(record)
    this.recordsByMeeting.set(input.meeting_id, list)
    return [record]
  }
  process(record_id: string): MeetingProcessOutcome {
    this.processed.push(record_id)
    const record = [...this.recordsByMeeting.values()]
      .flat()
      .find((r) => r.id === record_id) as MeetingRecord
    const outputs: MeetingOutputs = {
      meeting_id: record.meeting_id,
      record_id,
      decisions: [],
      todos: [],
      boundary_answers: [],
      knowledge: [],
      processor: 'agentsws/default-meeting-assistant',
      produced_at: T0,
    }
    this.outputsByMeeting.set(record.meeting_id, [outputs])
    return { record: { ...record, status: 'processed' }, outputs, approvals: { claims: [] } }
  }
  outputs(meeting_id: string): MeetingOutputs[] {
    return this.outputsByMeeting.get(meeting_id) ?? []
  }
  minutes(meeting_id: string): string {
    return `# ${this.meetings.get(meeting_id)?.title ?? ''}\n`
  }
}

interface Env {
  h: Harness
  port: MemoryMeetings
  meetingId: string
}

async function setup(): Promise<Env> {
  const h = await harness()
  const port = new MemoryMeetings(h.workspace_id)
  h.deps.meetings = port
  const created = await h.post('/v1/meetings', {
    title: '周会',
    start: T0,
    end: '2026-09-07T10:00:00.000Z',
    participants: [{ person_id: 'per_luo', name: '罗野' }],
  })
  const { data } = (await created.json()) as { data: Meeting }
  return { h, port, meetingId: data.id }
}

describe('/v1/meetings', () => {
  let env: Env
  beforeEach(async () => {
    env = await setup()
  })

  it('新建：workspace 与 created_by 由凭据决定，不从请求体取；position 默认取当前岗位', async () => {
    const meeting = env.port.get(env.meetingId) as Meeting
    expect(meeting.workspace_id).toBe(env.h.workspace_id)
    expect(meeting.created_by).toBe(env.h.person_id)
    expect(meeting.position_id).toBe(env.h.assignment.id)
    expect(meeting.status).toBe('scheduled')
  })

  it('新建：有外部参与者 → restricted', async () => {
    const res = await env.h.post('/v1/meetings', {
      title: '客户会',
      start: T0,
      end: T0,
      participants: [{ name: '客户', external: true }],
    })
    const { data } = (await res.json()) as { data: Meeting }
    expect(data.sensitivity).toBe('restricted')
  })

  it('新建：缺字段 → 400 invalid_input', async () => {
    const res = await env.h.post('/v1/meetings', { title: '' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_input')
  })

  it('列表：按状态与与会者筛；status / limit 不合法 → 400', async () => {
    expect(
      ((await (await env.h.get('/v1/meetings')).json()) as { data: Meeting[] }).data,
    ).toHaveLength(1)
    const filtered = await env.h.get('/v1/meetings?status=done&participant=罗野&limit=5')
    expect(((await filtered.json()) as { data: Meeting[] }).data).toEqual([])
    expect((await env.h.get('/v1/meetings?status=nope')).status).toBe(400)
    expect((await env.h.get('/v1/meetings?limit=0')).status).toBe(400)
    expect((await env.h.get('/v1/meetings?from=2026-01-01&to=2026-12-31')).status).toBe(200)
  })

  it('详情：带记录清单；不存在 / 跨工作区一律 404', async () => {
    const res = await env.h.get(`/v1/meetings/${env.meetingId}`)
    const { data } = (await res.json()) as { data: { meeting: Meeting; records: unknown[] } }
    expect(data.meeting.id).toBe(env.meetingId)
    expect(data.records).toEqual([])
    expect((await env.h.get('/v1/meetings/nope')).status).toBe(404)

    env.port.meetings.set('mtg_other', {
      ...(env.port.get(env.meetingId) as Meeting),
      id: 'mtg_other',
      workspace_id: 'ws_someone_else',
    })
    expect((await env.h.get('/v1/meetings/mtg_other')).status).toBe(404)
  })

  it('改会议：只认白名单字段', async () => {
    const res = await env.h.put(`/v1/meetings/${env.meetingId}`, {
      title: '周会（改）',
      status: 'done',
      participants: [{ name: '客户', external: true }],
      agenda: '看数据',
      matter_id: 'mat_1',
      location: { online: 'https://meet.example/x' },
    })
    const { data } = (await res.json()) as { data: Meeting }
    expect(data.title).toBe('周会（改）')
    expect(data.status).toBe('done')
    expect(data.matter_id).toBe('mat_1')
    expect((await env.h.put('/v1/meetings/nope', { title: 'x' })).status).toBe(404)
  })

  it('加记录（JSON 粘贴）：source 与文本原样传给会议内核，actor 来自凭据', async () => {
    const res = await env.h.post(`/v1/meetings/${env.meetingId}/records`, {
      source: 'handed_over',
      text: '罗野：我们决定上线。',
      notice_given: true,
      format: 'plain',
    })
    expect(res.status).toBe(200)
    const call = env.port.ingests[0]
    expect(call?.source).toBe('handed_over')
    expect(call?.actor).toBe(env.h.person_id)
    expect(call?.payload).toMatchObject({
      meeting_id: env.meetingId,
      text: '罗野：我们决定上线。',
      notice_given: true,
      format: 'plain',
    })
  })

  it('加记录（JSON 录音块）：base64 解成字节；不是合法 base64 → 400', async () => {
    const bytes = new TextEncoder().encode('audio-bytes')
    const b64 = Buffer.from(bytes).toString('base64')
    await env.h.post(`/v1/meetings/${env.meetingId}/records`, {
      source: 'in_app_recording',
      audio_base64: b64,
      mime: 'audio/webm',
      chunk_index: 0,
      final: true,
      name: 'clip.webm',
      note: '一键录音',
      language: 'zh',
    })
    const payload = env.port.ingests[0]?.payload as { bytes: Uint8Array; final: boolean }
    expect(new TextDecoder().decode(payload.bytes)).toBe('audio-bytes')
    expect(payload.final).toBe(true)

    const bad = await env.h.post(`/v1/meetings/${env.meetingId}/records`, {
      source: 'in_app_recording',
      audio_base64: '这不是 base64 ###',
    })
    expect(bad.status).toBe(400)
  })

  it('加记录（multipart 上传文件）：文件名与 mime 跟着走', async () => {
    const form = new FormData()
    form.set('source', 'device')
    form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), 'REC001.mp3')
    form.set('notice_given', 'true')
    form.set('chunk_index', '2')
    form.set('final', 'false')
    form.set('language', 'zh')
    const res = await env.h.gateway.fetch(
      new Request(`http://x/v1/meetings/${env.meetingId}/records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.h.token}`, 'X-Assignment': env.h.assignment.id },
        body: form,
      }),
    )
    expect(res.status).toBe(200)
    const payload = env.port.ingests[0]?.payload as {
      bytes: Uint8Array
      mime: string
      name: string
      notice_given: boolean
      chunk_index: number
      final: boolean
      language: string
    }
    expect(payload.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(payload.mime).toBe('audio/mpeg')
    expect(payload.name).toBe('REC001.mp3')
    expect(payload.notice_given).toBe(true)
    expect(payload.chunk_index).toBe(2)
    expect(payload.final).toBe(false)
    expect(payload.language).toBe('zh')
  })

  it('加记录（multipart 粘贴文本）：没有 file 就用 text；两个都没有 / source 不合法 → 400', async () => {
    const post = async (fill: (f: FormData) => void): Promise<Response> => {
      const form = new FormData()
      fill(form)
      return env.h.gateway.fetch(
        new Request(`http://x/v1/meetings/${env.meetingId}/records`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.h.token}`, 'X-Assignment': env.h.assignment.id },
          body: form,
        }),
      )
    }
    const okRes = await post((f) => {
      f.set('source', 'manual_notes')
      f.set('text', '手写笔记')
    })
    expect(okRes.status).toBe(200)
    expect(env.port.ingests[0]?.payload).toMatchObject({ text: '手写笔记' })

    expect((await post((f) => f.set('source', 'manual_notes'))).status).toBe(400)
    expect((await post((f) => f.set('source', 'nope'))).status).toBe(400)
  })

  it('处理：记录必须属于这个会议，否则 404', async () => {
    await env.h.post(`/v1/meetings/${env.meetingId}/records`, {
      source: 'manual_notes',
      text: '笔记',
    })
    const rid = env.port.records(env.meetingId)[0]?.id as string
    const res = await env.h.post(`/v1/meetings/${env.meetingId}/records/${rid}/process`)
    const { data } = (await res.json()) as { data: MeetingProcessOutcome }
    expect(data.record.status).toBe('processed')
    expect(data.outputs?.processor).toBe('agentsws/default-meeting-assistant')
    expect(env.port.processed).toEqual([rid])
    expect(
      (await env.h.post(`/v1/meetings/${env.meetingId}/records/mrec_nope/process`)).status,
    ).toBe(404)
  })

  it('产出与纪要导出', async () => {
    await env.h.post(`/v1/meetings/${env.meetingId}/records`, {
      source: 'manual_notes',
      text: '笔记',
    })
    const rid = env.port.records(env.meetingId)[0]?.id as string
    await env.h.post(`/v1/meetings/${env.meetingId}/records/${rid}/process`)

    const outputs = await env.h.get(`/v1/meetings/${env.meetingId}/outputs`)
    expect(((await outputs.json()) as { data: MeetingOutputs[] }).data).toHaveLength(1)

    const exported = await env.h.get(`/v1/meetings/${env.meetingId}/export`)
    const { data } = (await exported.json()) as {
      data: { format: string; filename: string; content: string }
    }
    expect(data.format).toBe('markdown')
    expect(data.filename).toBe('周会.md')
    expect(data.content).toContain('# 周会')

    const records = await env.h.get(`/v1/meetings/${env.meetingId}/records`)
    expect(((await records.json()) as { data: MeetingRecord[] }).data).toHaveLength(1)
  })

  it('没有装会议内核 → not_implemented', async () => {
    const h = await harness()
    const res = await h.get('/v1/meetings')
    expect(res.status).toBe(501)
    expect(((await res.json()) as { code: string }).code).toBe('not_implemented')
  })

  it('鉴权：无凭据 401、缺 X-Assignment 400、权限不够 403', async () => {
    const anon = await env.h.gateway.fetch(new Request('http://x/v1/meetings'))
    expect(anon.status).toBe(401)
    const noAssignment = await env.h.gateway.fetch(
      new Request('http://x/v1/meetings', {
        headers: { Authorization: `Bearer ${env.h.token}` },
      }),
    )
    expect(noAssignment.status).toBe(400)
    // 弱 Assignment 只有 approval.read own/internal —— 会议面的准入正是这一条，所以它能进
    expect((await env.h.get('/v1/meetings', { assignment: 'asg_weak' })).status).toBe(200)
    // 别人的 Assignment 一律 403
    expect((await env.h.get('/v1/meetings', { assignment: 'asg_foreign' })).status).toBe(403)
  })

  it('路由全在 /v1 之下，且都进了 openapi', () => {
    const paths = env.h.gateway
      .paths()
      .map((p) => p.path)
      .filter((p) => p.includes('/meetings'))
    expect(paths.every((p) => p.startsWith('/v1/'))).toBe(true)
    const ops = Object.keys(env.h.gateway.openapi.paths).filter((p) => p.includes('/meetings'))
    expect(ops).toContain('/v1/meetings')
    expect(ops).toContain('/v1/meetings/{id}/records/{rid}/process')
    expect(ops).toContain('/v1/meetings/{id}/export')
  })
})
