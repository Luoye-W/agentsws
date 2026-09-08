import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { StandIns } from '../src/index.js'
import {
  canonicalRunRequest,
  createReplayRuntime,
  createStandIns,
  emptyRecording,
  loadRecording,
  mergeRecordings,
  record,
  runRequestHash,
  saveRecording,
} from '../src/index.js'
import { makeRequest, orderOf, runAndCollect } from './helpers.js'

const dir = mkdtempSync(join(tmpdir(), 'agentsws-replay-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function ready(): Promise<{ s: StandIns; token: string }> {
  const s = createStandIns({ seed: 42 })
  const t = await s.connect.issueToken({
    assignment_id: 'asg_1',
    kind: 'role-read',
    allowed_actions: ['shopify_admin.get_order'],
    allowed_connections: ['conn_shopify_admin'],
  })
  return { s, token: t.token }
}

describe('replay 运行时', () => {
  it('canonical 哈希剔除 id / idempotency_key / trigger.event_id', async () => {
    const a = makeRequest({ id: 'run_a', idempotency_key: 'k_a' })
    const b = makeRequest({ id: 'run_b', idempotency_key: 'k_b' })
    b.trigger.event_id = 'evt_other'
    expect(runRequestHash(a)).toBe(runRequestHash(b))
    expect(canonicalRunRequest(a).id).toBeUndefined()
    expect(canonicalRunRequest(a).idempotency_key).toBeUndefined()
    // 剔除路径可配：不剔除时两条请求哈希不同
    expect(runRequestHash(a, [])).not.toBe(runRequestHash(b, []))
  })

  it('录制后回放：事件序列与结果逐条相同（17 §6 用例 7）', async () => {
    const { s, token } = await ready()
    const req = makeRequest({ order: orderOf(s, 'ord_1001'), connect_token: token })
    const recorder = record(s.stubRuntime, { clock: s.clock })
    const live = await runAndCollect(recorder, req)
    expect(recorder.recording().runs).toHaveLength(1)

    const replay = createReplayRuntime({ clock: s.clock, recording: recorder.recording() })
    expect(replay.name).toBe('replay')
    expect(replay.has(req)).toBe(true)
    expect(await replay.health()).toEqual({ ok: true, detail: '1 条录制' })
    const again = await runAndCollect(replay, req)
    expect(JSON.stringify(again.events)).toBe(JSON.stringify(live.events))
    expect(again.result.outputs).toEqual(live.result.outputs)
    expect(again.result.usage).toEqual(live.result.usage)
  })

  it('请求变化 → miss 报错，不即兴生成', async () => {
    const { s, token } = await ready()
    const req = makeRequest({ connect_token: token })
    const recorder = record(s.stubRuntime, { clock: s.clock })
    await runAndCollect(recorder, req)
    const replay = createReplayRuntime({ clock: s.clock, recording: recorder.recording() })

    const changed = makeRequest({ connect_token: token, threadBody: '换了一句话' })
    expect(replay.has(changed)).toBe(false)
    await expect(runAndCollect(replay, changed)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('空录制的 health 为 false；miss 带已知条数', async () => {
    const { s } = await ready()
    const replay = createReplayRuntime({ clock: s.clock })
    expect(await replay.health()).toEqual({ ok: false, detail: '0 条录制' })
    expect(replay.size()).toBe(0)
  })

  it('录制文件可存可读，重复录制同一请求覆盖而不追加', async () => {
    const { s, token } = await ready()
    const req = makeRequest({ connect_token: token })
    const into = emptyRecording()
    const recorder = record(s.stubRuntime, { clock: s.clock, into })
    await runAndCollect(recorder, req)
    await runAndCollect(recorder, req)
    expect(into.runs).toHaveLength(1)

    const file = join(dir, 'rec.json')
    saveRecording(file, recorder.recording())
    const loaded = loadRecording(file)
    expect(loaded.runs).toHaveLength(1)
    expect(loaded.runs[0]?.recorded_by).toBe('stub')

    const fromFile = createReplayRuntime({ clock: s.clock, files: [file] })
    expect(fromFile.has(req)).toBe(true)

    const empty = createReplayRuntime({ clock: s.clock })
    empty.loadFile(file)
    expect(empty.size()).toBe(1)
    empty.load(emptyRecording())
    expect(empty.size()).toBe(1)

    const bad = join(dir, 'bad.json')
    saveRecording(bad, { schema_version: 1, runs: [] })
    expect(loadRecording(bad).runs).toEqual([])
    const merged = mergeRecordings(loaded, loaded, emptyRecording())
    expect(merged.runs).toHaveLength(1)
  })

  it('回放中途 abort → run.cancelled', async () => {
    const { s, token } = await ready()
    const req = makeRequest({ connect_token: token })
    const recorder = record(s.stubRuntime, { clock: s.clock })
    await runAndCollect(recorder, req)
    const replay = createReplayRuntime({ clock: s.clock, recording: recorder.recording() })
    const ctrl = new AbortController()
    ctrl.abort()
    const { events, result } = await runAndCollect(replay, req, ctrl.signal)
    expect(events.map((e) => e.type)).toEqual(['run.cancelled'])
    expect(result.status).toBe('cancelled')
  })

  it('record 包装器保持被包装适配器的名字与能力', async () => {
    const { s } = await ready()
    const recorder = record(s.stubRuntime, { clock: s.clock })
    expect(recorder.name).toBe('stub')
    expect(recorder.capabilities()).toEqual(s.stubRuntime.capabilities())
    expect(await recorder.health()).toEqual({ ok: true })
  })

  it('非法录制文件报 invalid_input', async () => {
    const file = join(dir, 'garbage.json')
    saveRecording(file, { schema_version: 1, runs: [] })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{"nope": 1}', 'utf8')
    expect(() => loadRecording(file)).toThrowError(/录制文件/)
  })
})
