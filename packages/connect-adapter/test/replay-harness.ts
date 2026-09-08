import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Connect } from '@agentsws/contracts'
import type { Cassette, ConnectAdapter, ConnectAdapterOptions } from '../src/index.js'
import { createConnectAdapter, createReplayFetch, MemoryEventSink } from '../src/index.js'
import type { FixtureMeta } from './helpers.js'
import { TestClock } from './helpers.js'
import type { ScenarioCtx } from './scenarios.js'

/**
 * 回放档的装配：磁带来自 `RECORD_FIXTURES=1` 对真 `ghcr.io/oomol-lab/open-connector`
 * 容器的一次录制（见 `record-fixtures.test.ts`）。这里不含用例，只提供装配。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

export function loadCassette(): Cassette {
  return JSON.parse(readFileSync(join(FIXTURES, 'runtime.cassette.json'), 'utf8')) as Cassette
}

export function loadMeta(): FixtureMeta {
  return JSON.parse(readFileSync(join(FIXTURES, 'runtime.meta.json'), 'utf8')) as FixtureMeta
}

export const cassette = loadCassette()
export const meta = loadMeta()

export const replayCtx: ScenarioCtx = {
  workspace_id: meta.workspace_id,
  assignment_id: meta.assignment_id,
  service: meta.service,
  read_action: meta.read_action,
  read_input: {},
  write_action: meta.write_action,
  write_input: { message: 'conformance' },
  unknown_action: meta.unknown_action,
  connection_id: meta.connection_id,
  other_connection_id: meta.other_connection_id,
  other_service_connection_id: meta.other_service_connection_id,
  api_key_service: meta.service,
  oauth_service: meta.oauth_service,
}

const sinks = new WeakMap<object, MemoryEventSink>()

export function makeReplayAdapter(extra: Partial<ConnectAdapterOptions> = {}): ConnectAdapter {
  const sink = new MemoryEventSink()
  const adapter = createConnectAdapter({
    baseUrl: meta.base_url,
    adminTokenEnv: meta.admin_token_env,
    clock: new TestClock(meta.clock_start),
    eventSink: sink,
    fetchImpl: createReplayFetch(cassette),
    // 秘密只从环境变量名读——回放档给的是磁带里的占位串，不是真 token
    env: { [meta.admin_token_env]: meta.admin_token_placeholder },
    workspaceId: meta.workspace_id,
    services: [meta.service],
    ...extra,
  })
  sinks.set(adapter, sink)
  return adapter
}

export function eventsOf(connect: Connect): MemoryEventSink {
  const sink = sinks.get(connect as unknown as object)
  if (sink === undefined) throw new Error('没有为这个适配器登记事件池')
  return sink
}
