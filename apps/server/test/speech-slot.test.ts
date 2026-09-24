/**
 * WP145：会议转写前面的「识别器选择层」。
 *
 * - 注册一个替身识别器并选中：会议转写走它，不经模型网关、不扣积分（没有 `model.usage`）。
 * - 没注册：与 WP145 以前的接法（管线直连 `models.transcribe`）逐字相同——
 *   会议事件、网关账目与事件、失败时的错误话术和系统卡都一样。
 */
import type { ApprovalBus, EventEnvelope, ModelProvider } from '@agentsws/contracts'
import {
  createMeetingPipeline,
  createMemoryMeetingStore,
  type MeetingPipeline,
  MemoryMeetingRawStore,
} from '@agentsws/meetings'
import {
  createModelGateway,
  createSpeechToText,
  localTranscription,
  type ModelGatewayEvent,
  type SpeechProvider,
  stubAsrProvider,
} from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import { createMeetings } from '../src/meetings.js'

const AT = '2026-09-24T09:00:00.000Z'
const clock = { now: () => AT }
const seeded = () => {
  let a = 42
  return () => {
    a = (a * 16807) % 2147483647
    return a / 2147483647
  }
}
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

const failingAsr: ModelProvider = {
  ref: { provider: 'stub', model: 'stub-asr-v1', region: 'cn' },
  complete: () => Promise.reject(new Error('not used')),
  transcribe: () => Promise.reject(new Error('上游 503')),
}

function gateway(provider: ModelProvider = stubAsrProvider({ seed: 7 })) {
  const events: ModelGatewayEvent[] = []
  const g = createModelGateway({
    providers: [provider],
    policy: {
      default: { provider: 'stub', model: 'stub-asr-v1', region: 'cn' },
      data_residency: 'cn',
      prices: { 'stub/stub-asr-v1': { in: 0.5, out: 0, cached: 0 } },
    },
    clock,
    env: {},
    eventSink: (e) => {
      events.push(e)
    },
    trace: { newTraceId: () => 'trace_test', child: () => 'trace_test' },
  })
  return { g, events }
}

/** 录一段音、处理一次；回会议事件与处理结果。 */
async function runOnce(pipeline: Pick<MeetingPipeline, 'ingest' | 'process'>, meeting_id: string) {
  const [record] = await pipeline.ingest({
    workspace_id: 'ws_1',
    meeting_id,
    actor: 'per_luo',
    source: 'in_app_recording',
    payload: { bytes: enc('罗野：我们决定上线。\n张三：我来跟进。'), mime: 'audio/webm' },
  })
  return pipeline.process((record as { id: string }).id)
}

const MEETING = {
  workspace_id: 'ws_1',
  title: '周会',
  start: AT,
  end: '2026-09-24T10:00:00.000Z',
  participants: [
    { person_id: 'per_luo', name: '罗野' },
    { person_id: 'per_zhang', name: '张三' },
  ],
  status: 'done' as const,
  created_by: 'per_luo',
}

/** WP145 以前的接法：管线直连网关。 */
async function before(provider?: ModelProvider) {
  const { g, events: modelEvents } = gateway(provider)
  const events: unknown[] = []
  const random = seeded()
  const store = createMemoryMeetingStore({ clock, random })
  const pipeline = createMeetingPipeline({
    store,
    raw: new MemoryMeetingRawStore({}),
    clock,
    random,
    transcribe: (audio, meta) => g.transcribe(audio, meta),
    eventSink: (e) => {
      events.push(e)
    },
  })
  const meeting = await store.createMeeting(MEETING)
  const result = await runOnce(pipeline, meeting.id)
  return { result, events, modelEvents, records: g.records() }
}

/** 现在的装配（可选带一个识别器选择层）。 */
async function now(provider?: ModelProvider, register?: SpeechProvider) {
  const { g, events: modelEvents } = gateway(provider)
  const events: EventEnvelope[] = []
  const speech = createSpeechToText({ gateway: g })
  if (register !== undefined) {
    speech.register(register)
    speech.configure({ providerId: register.info.id })
  }
  const assembly = createMeetings({
    clock,
    random: seeded(),
    models: g,
    appendEvent: (e) => {
      events.push(e as EventEnvelope)
    },
    approvals: {} as ApprovalBus,
    ...(register === undefined ? {} : { speech }),
  })
  const meeting = await assembly.store.createMeeting(MEETING)
  const result = await runOnce(assembly.pipeline, meeting.id)
  return { result, events, modelEvents, records: g.records(), speech: assembly.speech }
}

describe('WP145 会议转写的识别器选择层', () => {
  it('注册替身识别器并选中：会议转写走它，不经网关、不扣积分', async () => {
    const heard: string[] = []
    const standIn: SpeechProvider = {
      info: {
        id: 'local-stand-in',
        name: '本机替身',
        location: 'host-local',
        billing: 'none',
        languages: [],
      },
      async transcribe(input) {
        heard.push(input.mime)
        return localTranscription('local-stand-in', input, {
          text: '罗野：本机听到我们决定上线。',
          segments: [
            { start_ms: 0, end_ms: 2000, speaker: '罗野', text: '本机听到我们决定上线。' },
          ],
          speakers: ['罗野'],
        })
      },
    }
    const out = await now(undefined, standIn)
    expect(heard).toEqual(['audio/webm'])
    expect(out.result.record.status).toBe('processed')
    expect(out.result.record.transcript?.text).toBe('罗野：本机听到我们决定上线。')
    expect(out.records).toEqual([])
    expect(out.modelEvents.filter((e) => e.type === 'model.usage')).toEqual([])
  })

  it('没注册：只有网关一个识别器，会议事件、网关账目与事件与以前逐字相同', async () => {
    const a = await before()
    const b = await now()
    expect(b.speech.providers().map((p) => p.id)).toEqual(['model-gateway'])
    expect(b.result).toEqual(a.result)
    expect(b.events).toEqual(a.events)
    expect(b.records).toEqual(a.records)
    expect(b.records.length).toBe(1) // 照旧记一笔账
    expect(b.modelEvents).toEqual(a.modelEvents)
  })

  it('没注册、网关转写失败：错误话术、失败事件、系统卡与以前逐字相同', async () => {
    const a = await before(failingAsr)
    const b = await now(failingAsr)
    expect(b.result.system_card?.reason).toBe('transcribe_failed')
    expect(b.result).toEqual(a.result)
    expect(b.result.record.error).toBe('transcribe provider failed')
    expect(b.events).toEqual(a.events)
    expect(b.modelEvents).toEqual(a.modelEvents)
  })
})
