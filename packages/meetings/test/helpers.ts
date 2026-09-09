import type { Clock, Meeting, MeetingParticipant, ModelMeta } from '@agentsws/contracts'
import { createModelGateway, stubAsrProvider } from '@agentsws/model-gateway'
import { createMeetingPipeline, type MeetingEvent, type MeetingPipeline } from '../src/pipeline.js'
import { MemoryMeetingRawStore } from '../src/raw-store.js'
import { MemoryMeetingStore } from '../src/store.js'

export const T0 = '2026-09-09T09:00:00.000Z'

export function makeClock(start = T0): Clock & { advance(ms: number): void } {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance(ms: number) {
      t += ms
    },
  }
}

/** 确定性伪随机（不用裸 Math.random）。 */
export function seeded(seed = 42): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const META: ModelMeta = {
  workspace_id: 'ws_1',
  assignment_id: 'as_1',
  role_id: 'common.member',
  run_id: 'run_1',
  purpose: 'transcription',
}

/** 一个装好 stub ASR 的模型网关（22 §5 的记账与预算照跑）。 */
export function makeGateway(clock: Clock, events: unknown[] = []) {
  return createModelGateway({
    providers: [stubAsrProvider({ seed: 7 })],
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
}

export interface Harness {
  clock: Clock & { advance(ms: number): void }
  store: MemoryMeetingStore
  raw: MemoryMeetingRawStore
  pipeline: MeetingPipeline
  events: MeetingEvent[]
  modelEvents: unknown[]
  meeting: Meeting
}

export interface HarnessOptions {
  participants?: MeetingParticipant[]
  /** 不装 ASR（发行版没有语音转写时的档）。 */
  withoutAsr?: boolean
  title?: string
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const clock = makeClock()
  const random = seeded()
  const store = new MemoryMeetingStore({ clock, random })
  const raw = new MemoryMeetingRawStore()
  const events: MeetingEvent[] = []
  const modelEvents: unknown[] = []
  const gateway = makeGateway(clock, modelEvents)
  const pipeline = createMeetingPipeline({
    store,
    raw,
    clock,
    random,
    ...(options.withoutAsr === true
      ? {}
      : { transcribe: (audio) => gateway.transcribe(audio, META) }),
    eventSink: (e) => {
      events.push(e)
    },
  })
  const meeting = store.createMeeting({
    workspace_id: 'ws_1',
    title: options.title ?? '周会',
    start: T0,
    end: '2026-09-09T10:00:00.000Z',
    participants: options.participants ?? [
      { person_id: 'per_luo', name: '罗野' },
      { person_id: 'per_zhang', name: '张三' },
    ],
    status: 'done',
    created_by: 'per_luo',
  })
  return { clock, store, raw, pipeline, events, modelEvents, meeting }
}
