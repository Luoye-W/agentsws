/**
 * 会议音视频走对象存储（WP40 §3）。
 *
 * 断言的是四件事：
 * 1. 字节不再落库——库里那一行是 `blob://…`，对象在对象存储里
 * 2. 读回来还是原来的字节，调用方一无所知
 * 3. 转写 / 文档这类**文本**照旧留在库里（要检索、要脱敏）
 * 4. 删除三条路（按 ref、随主体、保留期）都把对象一起删掉——
 *    不然 21 §4 的「随主体删除」会漏掉最大的那一块
 */

import type { RawBlobPort } from '@agentsws/core'
import { describe, expect, it } from 'vitest'
import { BlobBackedMeetingRawStore } from '../src/blob-raw-store.js'
import { MemoryMeetingRawStore } from '../src/raw-store.js'

const T0 = '2026-09-10T00:00:00.000Z'

/** 最小的对象存储替身；只要三个动作（`@agentsws/blob` 的 BlobStore 结构上满足同一个端口）。 */
class FakeBlobs implements RawBlobPort {
  readonly objects = new Map<string, Uint8Array>()

  async put(key: string, body: Uint8Array): Promise<{ uri: string; key: string; size: number }> {
    this.objects.set(key, body)
    return { uri: `blob://${key}`, key, size: body.length }
  }

  async get(key: string): Promise<{ bytes?: Uint8Array } | undefined> {
    const bytes = this.objects.get(key)
    return bytes === undefined ? undefined : { bytes }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }
}

function make(): {
  store: BlobBackedMeetingRawStore
  inner: MemoryMeetingRawStore
  blobs: FakeBlobs
} {
  const inner = new MemoryMeetingRawStore()
  const blobs = new FakeBlobs()
  let n = 0
  const newId = (): string => {
    n += 1
    return `id${n}`
  }
  const store = new BlobBackedMeetingRawStore({ inner, blobs, newId })
  return { store, inner, blobs }
}

const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])

describe('会议音视频走 blob', () => {
  it('字节进对象存储，库里只留一句 blob://', async () => {
    const { store, inner, blobs } = make()
    const ref = await store.put({
      workspace_id: 'ws_1',
      kind: 'audio',
      stored_at: T0,
      payload: AUDIO,
      mime: 'audio/webm',
      name: '周会.webm',
      subject_ref: 'meeting:m1',
    })
    const stored = await inner.get(ref)
    expect(stored?.payload).toBe('blob://meetings/ws_1/audio/id1')
    expect(blobs.objects.get('meetings/ws_1/audio/id1')).toEqual(AUDIO)

    const read = await store.get(ref)
    expect(read?.payload).toEqual(AUDIO)
    expect(read?.mime).toBe('audio/webm')
    expect(read?.name).toBe('周会.webm')
  })

  it('转写与文档是文本，照旧留在库里', async () => {
    const { store, inner, blobs } = make()
    const ref = await store.put({
      workspace_id: 'ws_1',
      kind: 'transcript',
      stored_at: T0,
      payload: '张三：这一批先不发',
    })
    expect((await inner.get(ref))?.payload).toBe('张三：这一批先不发')
    expect(blobs.objects.size).toBe(0)
    expect((await store.get(ref))?.payload).toBe('张三：这一批先不发')
  })

  it('对象没了（或密钥被销毁）→ 行还在、内容读不出来', async () => {
    const { store, blobs } = make()
    const ref = await store.put({
      workspace_id: 'ws_1',
      kind: 'audio',
      stored_at: T0,
      payload: AUDIO,
      subject_ref: 'meeting:m1',
    })
    blobs.objects.clear()
    const read = await store.get(ref)
    expect(read).toBeDefined()
    expect(read?.erased).toBe(true)
    expect(read?.payload).toEqual(new Uint8Array(0))
  })

  it('按 ref 删：对象一起删', async () => {
    const { store, blobs } = make()
    const ref = await store.put({
      workspace_id: 'ws_1',
      kind: 'video',
      stored_at: T0,
      payload: AUDIO,
    })
    expect(blobs.objects.size).toBe(1)
    expect(await store.erase(ref)).toBe(1)
    expect(blobs.objects.size).toBe(0)
    expect(await store.get(ref)).toBeUndefined()
  })

  it('随主体删（21 §4）：这场会的对象全删掉', async () => {
    const { store, blobs } = make()
    await store.put({
      workspace_id: 'ws_1',
      kind: 'audio',
      stored_at: T0,
      payload: AUDIO,
      subject_ref: 'meeting:m1',
    })
    await store.put({
      workspace_id: 'ws_1',
      kind: 'audio',
      stored_at: T0,
      payload: AUDIO,
      subject_ref: 'meeting:m2',
    })
    expect(blobs.objects.size).toBe(2)
    const result = await store.eraseSubject('meeting:m1')
    expect(result.rows).toBe(1)
    expect([...blobs.objects.keys()]).toEqual(['meetings/ws_1/audio/id2'])
  })

  it('保留期（18 §2.1）：过期的对象也一起清', async () => {
    const { store, blobs } = make()
    await store.put({
      workspace_id: 'ws_1',
      kind: 'audio',
      stored_at: '2026-01-01T00:00:00.000Z',
      payload: AUDIO,
    })
    await store.put({ workspace_id: 'ws_1', kind: 'audio', stored_at: T0, payload: AUDIO })
    const removed = await store.prune(30 * 24 * 3600 * 1000, T0)
    expect(removed).toBe(1)
    expect([...blobs.objects.keys()]).toEqual(['meetings/ws_1/audio/id2'])
  })
})
