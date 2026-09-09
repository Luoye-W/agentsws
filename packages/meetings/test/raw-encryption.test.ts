/**
 * 受控原始材料区的第一条纪律：**加密**（18 §2.1 + 21 §4）——会议档。
 *
 * 两档跑同一批断言。密钥环用一个本地假实现（形状与 `@agentsws/data` 的
 * `SubjectKeyring` 一致）；真密钥环的语义在 data 包自己测。
 *
 * 会议档的主体是**一场会**（`meeting:<id>`）：一段录音里有好几个人，
 * 没法给每个与会者各一把密钥。删一个人 = 删他的转写行（`eraseParticipant`），
 * 删整场会 = 销毁这把密钥 + 删行（`eraseMeeting`）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import type { RawCipher } from '@agentsws/core'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { eraseMeeting, meetingSubjectRef } from '../src/erase.js'
import { type MeetingRawStore, MemoryMeetingRawStore } from '../src/raw-store.js'
import { SqliteMeetingRawStore } from '../src/sqlite-raw-store.js'

/** 与 `@agentsws/data` 的主体密钥环同形。 */
class TestKeyring implements RawCipher {
  private readonly keys = new Map<string, Buffer | null>()

  #ensure(subject: string): Buffer {
    const existing = this.keys.get(subject)
    if (existing === null) throw new Error(`主体密钥已销毁：${subject}`)
    if (existing !== undefined) return existing
    const key = randomBytes(32)
    this.keys.set(subject, key)
    return key
  }

  seal(subject: string, plaintext: Uint8Array): Uint8Array {
    const key = this.#ensure(subject)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(subject, 'utf8'))
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ct])
  }

  open(subject: string, sealed: Uint8Array): Uint8Array | undefined {
    const key = this.keys.get(subject)
    if (key === undefined || key === null) return undefined
    const buf = Buffer.from(sealed)
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
      decipher.setAAD(Buffer.from(subject, 'utf8'))
      decipher.setAuthTag(buf.subarray(12, 28))
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()])
    } catch {
      return undefined
    }
  }

  shred(subject: string, at = '2026-09-10T00:00:00.000Z'): string {
    this.keys.set(subject, null)
    return at
  }

  isShredded(subject: string): boolean {
    return this.keys.get(subject) === null
  }
}

const clock: Clock = { now: () => '2026-09-10T00:00:00.000Z', sleep: async () => undefined }
const MEETING = 'mt_1042'
const SUBJECT = meetingSubjectRef(MEETING)
const TRANSCRIPT = '王工：这批货的收货地址是柏林 Torstrasse 12，客户电话 +49 30 1234567'

const dirs: string[] = []
const stores: { close?: () => void }[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close?.()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-mraw-enc-'))
  dirs.push(dir)
  return join(dir, 'meetings-raw.sqlite')
}

const archives: { name: string; make(cipher?: RawCipher): MeetingRawStore }[] = [
  {
    name: 'MemoryMeetingRawStore',
    make: (cipher) => new MemoryMeetingRawStore(cipher === undefined ? {} : { cipher }),
  },
  {
    name: 'SqliteMeetingRawStore',
    make: (cipher) => {
      const s = new SqliteMeetingRawStore({ clock, ...(cipher === undefined ? {} : { cipher }) })
      stores.push(s)
      return s
    },
  },
]

describe.each(archives)('会议原始材料区加密 · $name', ({ make }) => {
  const put = async (store: MeetingRawStore, over: Record<string, unknown> = {}): Promise<string> =>
    await store.put({
      workspace_id: 'ws_1',
      kind: 'transcript',
      stored_at: clock.now(),
      payload: TRANSCRIPT,
      subject_ref: SUBJECT,
      ...over,
    } as Parameters<MeetingRawStore['put']>[0])

  it('带 subject_ref 的材料存进去、读回来一模一样', async () => {
    const store = make(new TestKeyring())
    const ref = await put(store)
    expect((await store.get(ref))?.payload).toBe(TRANSCRIPT)
    expect((await store.get(ref))?.subject_ref).toBe(SUBJECT)
  })

  it('录音字节也加密，读回来逐字节相等', async () => {
    const store = make(new TestKeyring())
    const bytes = new Uint8Array([0, 17, 200, 255])
    const ref = await put(store, { kind: 'audio', payload: bytes, mime: 'audio/mp4' })
    const got = await store.get(ref)
    expect(Array.from(got?.payload as Uint8Array)).toEqual([0, 17, 200, 255])
  })

  it('销毁这场会的密钥之后读不出内容（行还在，标 erased）', async () => {
    const keyring = new TestKeyring()
    const store = make(keyring)
    const ref = await put(store)
    keyring.shred(SUBJECT)
    const got = await store.get(ref)
    expect(got?.erased).toBe(true)
    expect(JSON.stringify(got)).not.toContain('Torstrasse')
  })

  it('eraseMeeting：销毁密钥 + 删行，别场会不受影响', async () => {
    const keyring = new TestKeyring()
    const store = make(keyring)
    const mine = await put(store)
    const other = await put(store, { subject_ref: meetingSubjectRef('mt_other') })
    const out = await eraseMeeting(store, MEETING)
    expect(out.rows).toBe(1)
    expect(out.shredded_at).toBeTruthy()
    expect(keyring.isShredded(SUBJECT)).toBe(true)
    expect(await store.get(mine)).toBeUndefined()
    expect((await store.get(other))?.payload).toBe(TRANSCRIPT)
  })

  it('scrub 之后仍然是密文形态，且脱敏结果读得回来', async () => {
    const store = make(new TestKeyring())
    const ref = await put(store, { payload: '卡号 4111 1111 1111 1111' })
    await store.scrub?.(ref, (t) => t.replace(/\d/g, '#'))
    expect((await store.get(ref))?.payload).toBe('卡号 #### #### #### ####')
  })

  it('没接密钥环时也能跑，只是不加密', async () => {
    const store = make()
    const ref = await put(store)
    expect((await store.get(ref))?.payload).toBe(TRANSCRIPT)
    expect((await store.eraseSubject(SUBJECT)).shredded_at).toBeUndefined()
  })
})

describe('SqliteMeetingRawStore：库文件字节里找不到明文', () => {
  it('接了密钥环之后，落盘的每一个字节都不含转写正文', () => {
    const path = tmpDb()
    const store = new SqliteMeetingRawStore({ dbPath: path, clock, cipher: new TestKeyring() })
    stores.push(store)
    store.put({
      workspace_id: 'ws_1',
      kind: 'transcript',
      stored_at: clock.now(),
      payload: TRANSCRIPT,
      subject_ref: SUBJECT,
    })
    const bytes = Buffer.concat(
      ['', '-wal', '-shm'].flatMap((suffix) => {
        try {
          return [readFileSync(`${path}${suffix}`)]
        } catch {
          return []
        }
      }),
    ).toString('latin1')
    expect(bytes).not.toContain('Torstrasse')
    expect(bytes).not.toContain('1234567')
    expect(store.encrypted).toBe(true)
  })
})

describe('迁移：旧明文行标 legacy_plain，下次 prune 清掉', () => {
  it('v1 的库升到 v2 之后老行标 legacy_plain；prune 不看年龄一律清掉', () => {
    const path = tmpDb()
    const v1 = new Database(path)
    v1.exec(`
CREATE TABLE _migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL) STRICT;
INSERT INTO _migrations (version, applied_at) VALUES (1, '2026-09-09T00:00:00.000Z');
CREATE TABLE meeting_raw (
  ref TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, kind TEXT NOT NULL,
  stored_at TEXT NOT NULL, stored_ms INTEGER NOT NULL, is_binary INTEGER NOT NULL,
  payload_text TEXT, payload_blob BLOB, mime TEXT, name TEXT, secrets_scrubbed INTEGER NOT NULL
);
CREATE TABLE meeting_raw_counter (name TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL) STRICT;
INSERT INTO meeting_raw_counter (name, value) VALUES ('ref', 1);
`)
    v1.prepare(
      `INSERT INTO meeting_raw (ref, workspace_id, kind, stored_at, stored_ms, is_binary,
                                payload_text, secrets_scrubbed)
       VALUES (?,?,?,?,?,0,?,0)`,
    ).run(
      'raw://meetings/ws_1/transcript/1',
      'ws_1',
      'transcript',
      clock.now(),
      Date.parse(clock.now()),
      TRANSCRIPT,
    )
    v1.close()

    const after = new SqliteMeetingRawStore({ dbPath: path, clock, cipher: new TestKeyring() })
    stores.push(after)
    expect(after.schemaVersion).toBe(2)
    expect(after.legacyPlainCount).toBe(1)
    after.put({
      workspace_id: 'ws_1',
      kind: 'transcript',
      stored_at: clock.now(),
      payload: TRANSCRIPT,
      subject_ref: SUBJECT,
    })
    expect(after.prune(10 * 365 * 86_400_000, clock.now())).toBe(1)
    expect(after.legacyPlainCount).toBe(0)
    expect(after.size).toBe(1)
  })
})
