/**
 * 受控原始材料区的第一条纪律：**加密**（18 §2.1 + 21 §4 + 31 §4）。
 *
 * 两档跑同一批断言。密钥环用一个本地假实现（形状与 `@agentsws/data` 的
 * `SubjectKeyring` 一致）——真密钥环的 `seal / open / shred` 语义在 data 包自己测，
 * 这里测的是「渠道包接上端口之后，库文件里到底还有没有明文」。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import type { RawCipher } from '@agentsws/core'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRawStore, type RawStore } from '../src/raw-store.js'
import { SqliteRawStore } from '../src/sqlite-raw-store.js'

/** 与 `@agentsws/data` 的主体密钥环同形：每主体一把随机密钥，销毁 = 置空且不再发新钥。 */
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
const SUBJECT = 'anna@example.com'
const SECRET_BODY = 'From: anna@example.com\r\n\r\n订单 #1042 收货地址：柏林 Torstrasse 12'

const dirs: string[] = []
const stores: { close?: () => void }[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close?.()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-raw-enc-'))
  dirs.push(dir)
  return join(dir, 'raw.sqlite')
}

const archives: { name: string; make(cipher?: RawCipher): RawStore }[] = [
  {
    name: 'MemoryRawStore',
    make: (cipher) => new MemoryRawStore({ clock, ...(cipher === undefined ? {} : { cipher }) }),
  },
  {
    name: 'SqliteRawStore',
    make: (cipher) => {
      const s = new SqliteRawStore({ clock, ...(cipher === undefined ? {} : { cipher }) })
      stores.push(s)
      return s
    },
  },
]

describe.each(archives)('原始材料区加密 · $name', ({ make }) => {
  const put = async (store: RawStore, over: Record<string, unknown> = {}): Promise<string> =>
    await store.put({
      channel: 'email',
      kind: 'message',
      stored_at: clock.now(),
      payload: SECRET_BODY,
      subject_ref: SUBJECT,
      ...over,
    } as Parameters<RawStore['put']>[0])

  it('带 subject_ref 的材料存进去、读回来一模一样', async () => {
    const store = make(new TestKeyring())
    const ref = await put(store)
    expect((await store.get(ref))?.payload).toBe(SECRET_BODY)
    expect((await store.get(ref))?.subject_ref).toBe(SUBJECT)
  })

  it('字节载荷也加密，读回来逐字节相等', async () => {
    const store = make(new TestKeyring())
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    const ref = await put(store, { kind: 'attachment', payload: bytes, mime: 'image/png' })
    const got = await store.get(ref)
    expect(got?.payload).toBeInstanceOf(Uint8Array)
    expect(Array.from(got?.payload as Uint8Array)).toEqual([0, 1, 2, 250, 255])
  })

  it('销毁主体密钥之后读不出内容（行还在，标 erased）', async () => {
    const keyring = new TestKeyring()
    const store = make(keyring)
    const ref = await put(store)
    keyring.shred(SUBJECT)
    const got = await store.get(ref)
    expect(got?.erased).toBe(true)
    expect(got?.payload).toBe('')
    expect(JSON.stringify(got)).not.toContain('Torstrasse')
  })

  it('eraseSubject：销毁密钥 + 删行，别的主体不受影响', async () => {
    const keyring = new TestKeyring()
    const store = make(keyring)
    const mine = await put(store)
    const other = await put(store, { subject_ref: 'bob@example.com' })
    const out = await store.eraseSubject(SUBJECT)
    expect(out.rows).toBe(1)
    expect(out.shredded_at).toBeTruthy()
    expect(keyring.isShredded(SUBJECT)).toBe(true)
    expect(await store.get(mine)).toBeUndefined()
    expect((await store.get(other))?.payload).toBe(SECRET_BODY)
  })

  it('scrub 之后仍然是密文形态，且脱敏结果读得回来', async () => {
    const store = make(new TestKeyring())
    const ref = await put(store, { payload: 'card 4111 1111 1111 1111' })
    await store.scrub?.(ref, (t) => t.replace(/\d/g, '#'))
    const got = await store.get(ref)
    expect(got?.payload).toBe('card #### #### #### ####')
    expect(got?.secrets_scrubbed).toBe(true)
  })

  it('没有 subject_ref 的材料照旧明文存（没有主体可绑，不是漏洞）', async () => {
    const store = make(new TestKeyring())
    const ref = await put(store, { subject_ref: undefined })
    expect((await store.get(ref))?.payload).toBe(SECRET_BODY)
  })

  it('保留期 prune 两档同语义：过了保留期的丢掉，窗口内的留着（18 §2.1 / 39 待办 H）', async () => {
    const store = make(new TestKeyring())
    const old = await put(store, { stored_at: '2026-01-01T00:00:00.000Z' })
    const fresh = await put(store, { subject_ref: 'bob@example.com' })
    // 保留 30 天：一月那条早过期了，今天这条还在
    expect(await store.prune(30 * 86_400_000, clock)).toBe(1)
    expect(await store.get(old)).toBeUndefined()
    expect((await store.get(fresh))?.payload).toBe(SECRET_BODY)
  })

  it('没接密钥环时也能跑，只是不加密', async () => {
    const store = make()
    const ref = await put(store)
    expect((await store.get(ref))?.payload).toBe(SECRET_BODY)
    expect((await store.eraseSubject(SUBJECT)).shredded_at).toBeUndefined()
  })
})

describe('SqliteRawStore：库文件字节里找不到明文', () => {
  it('接了密钥环之后，落盘的每一个字节都不含正文', () => {
    const path = tmpDb()
    const store = new SqliteRawStore({ dbPath: path, clock, cipher: new TestKeyring() })
    stores.push(store)
    store.put({
      channel: 'email',
      kind: 'message',
      stored_at: clock.now(),
      payload: SECRET_BODY,
      subject_ref: SUBJECT,
    })
    // WAL 模式：内容可能还在 -wal 里，两个文件一起看
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
    expect(bytes).not.toContain('订单 #1042')
    expect(store.encrypted).toBe(true)
  })

  it('不接密钥环就是明文落盘——这条断言是给装配当哨兵的', () => {
    const path = tmpDb()
    const store = new SqliteRawStore({ dbPath: path, clock })
    stores.push(store)
    store.put({
      channel: 'email',
      kind: 'message',
      stored_at: clock.now(),
      payload: SECRET_BODY,
      subject_ref: SUBJECT,
    })
    const bytes = readFileSync(`${path}-wal`).toString('latin1')
    expect(bytes).toContain('Torstrasse')
    expect(store.encrypted).toBe(false)
  })
})

describe('迁移：旧明文行标 legacy_plain，下次 prune 清掉', () => {
  it('v1 的库升到 v2 之后，老行标上 legacy_plain；prune 不看年龄一律清掉', () => {
    const path = tmpDb()
    // 手工建一个 **v1** 的库并塞一条明文（模拟 WP18 时代落的行）——
    // 不能用 SqliteRawStore 建，它一上来就把 v2 也跑了。
    const v1 = new Database(path)
    v1.exec(`
CREATE TABLE _migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL) STRICT;
INSERT INTO _migrations (version, applied_at) VALUES (1, '2026-09-09T00:00:00.000Z');
CREATE TABLE raw (
  ref TEXT PRIMARY KEY NOT NULL, channel TEXT NOT NULL, kind TEXT NOT NULL,
  stored_at TEXT NOT NULL, stored_ms INTEGER NOT NULL, is_binary INTEGER NOT NULL,
  payload_text TEXT, payload_blob BLOB, mime TEXT, name TEXT, secrets_scrubbed INTEGER NOT NULL
);
CREATE TABLE raw_counter (name TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL) STRICT;
INSERT INTO raw_counter (name, value) VALUES ('ref', 1);
`)
    v1.prepare(
      `INSERT INTO raw (ref, channel, kind, stored_at, stored_ms, is_binary,
                        payload_text, secrets_scrubbed)
       VALUES (?,?,?,?,?,0,?,0)`,
    ).run(
      'raw://inbound/email/message/1',
      'email',
      'message',
      clock.now(),
      Date.parse(clock.now()),
      SECRET_BODY,
    )
    v1.close()

    const after = new SqliteRawStore({ dbPath: path, clock, cipher: new TestKeyring() })
    stores.push(after)
    expect(after.schemaVersion).toBe(2)
    expect(after.legacyPlainCount).toBe(1)

    // 新落的行不算 legacy
    after.put({
      channel: 'email',
      kind: 'message',
      stored_at: clock.now(),
      payload: SECRET_BODY,
      subject_ref: SUBJECT,
    })
    expect(after.legacyPlainCount).toBe(1)
    expect(after.size).toBe(2)

    // 保留期极长也照样清 legacy 行
    expect(after.prune(10 * 365 * 86_400_000)).toBe(1)
    expect(after.legacyPlainCount).toBe(0)
    expect(after.size).toBe(1)
  })
})
