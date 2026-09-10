/**
 * 邮件附件走对象存储（WP40 §3）。
 *
 * 与会议那一层同一份纪律：**字节进对象存储，库里只留一句 `blob://…`**；
 * 邮件原文（文本）照旧留在库里加密——它要检索、要脱敏。
 */
import type { RawBlobPort } from '@agentsws/core'
import { describe, expect, it } from 'vitest'
import { BlobBackedRawStore } from '../src/blob-raw-store.js'
import { MemoryRawStore } from '../src/raw-store.js'

const T0 = '2026-09-10T00:00:00.000Z'
const clock = { now: () => T0 }

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

function make(): { store: BlobBackedRawStore; inner: MemoryRawStore; blobs: FakeBlobs } {
  const inner = new MemoryRawStore({ clock })
  const blobs = new FakeBlobs()
  let n = 0
  const newId = (): string => {
    n += 1
    return `id${n}`
  }
  return { store: new BlobBackedRawStore({ inner, blobs, newId }), inner, blobs }
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2])

describe('邮件附件走 blob', () => {
  it('附件字节进对象存储；邮件原文（文本）留在库里', async () => {
    const { store, inner, blobs } = make()
    const messageRef = await store.put({
      channel: 'email',
      kind: 'message',
      stored_at: T0,
      payload: 'From: a@b.com\r\n\r\n正文',
      mime: 'message/rfc822',
      subject_ref: 'a@b.com',
    })
    const attachmentRef = await store.put({
      channel: 'email',
      kind: 'attachment',
      stored_at: T0,
      payload: PDF,
      mime: 'application/pdf',
      name: '发票.pdf',
      subject_ref: 'a@b.com',
    })

    expect((await inner.get(messageRef))?.payload).toContain('From: a@b.com')
    expect((await inner.get(attachmentRef))?.payload).toBe('blob://channels/email/id1')
    expect(blobs.objects.get('channels/email/id1')).toEqual(PDF)

    const read = await store.get(attachmentRef)
    expect(read?.payload).toEqual(PDF)
    expect(read?.name).toBe('发票.pdf')
  })

  it('随主体删（21 §4）：这个发件人的附件对象一起删', async () => {
    const { store, blobs } = make()
    await store.put({
      channel: 'email',
      kind: 'attachment',
      stored_at: T0,
      payload: PDF,
      subject_ref: 'a@b.com',
    })
    await store.put({
      channel: 'email',
      kind: 'attachment',
      stored_at: T0,
      payload: PDF,
      subject_ref: 'c@d.com',
    })
    expect(blobs.objects.size).toBe(2)
    const result = await store.eraseSubject('a@b.com')
    expect(result.rows).toBe(1)
    expect([...blobs.objects.keys()]).toEqual(['channels/email/id2'])
  })

  it('保留期：过期的附件对象一起清', async () => {
    const { store, blobs } = make()
    await store.put({
      channel: 'email',
      kind: 'attachment',
      stored_at: '2026-01-01T00:00:00.000Z',
      payload: PDF,
    })
    await store.put({ channel: 'email', kind: 'attachment', stored_at: T0, payload: PDF })
    expect(await store.prune(30 * 24 * 3600 * 1000, clock)).toBe(1)
    expect([...blobs.objects.keys()]).toEqual(['channels/email/id2'])
  })

  it('对象没了 → 行还在、内容读不出来', async () => {
    const { store, blobs } = make()
    const ref = await store.put({
      channel: 'email',
      kind: 'attachment',
      stored_at: T0,
      payload: PDF,
    })
    blobs.objects.clear()
    const read = await store.get(ref)
    expect(read?.erased).toBe(true)
    expect(read?.payload).toEqual(new Uint8Array(0))
  })

  it('脱敏只对文本做：附件不动', async () => {
    const { store } = make()
    const ref = await store.put({
      channel: 'email',
      kind: 'attachment',
      stored_at: T0,
      payload: PDF,
    })
    await store.scrub(ref, () => 'REDACTED')
    expect((await store.get(ref))?.payload).toEqual(PDF)
  })
})
