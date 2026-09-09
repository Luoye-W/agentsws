/**
 * 主体密钥环（21 §4）：它同时是受控原始材料区（18 §2.1）的加密出处，
 * 所以这里测的既是「PII 字段加密」，也是 `@agentsws/core` 的 `RawCipher` 端口语义。
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DATA_KEY_ENV, parseDataKey } from '../src/crypto.js'
import { SubjectKeyring } from '../src/keyring.js'

const clock: Clock = { now: () => '2026-09-10T00:00:00.000Z', sleep: async () => undefined }
const SUBJECT = 'customer:cus_9'
const PLAIN = '柏林 Torstrasse 12'

const dbs: Database.Database[] = []
const dirs: string[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function open(path = ':memory:'): Database.Database {
  const db = new Database(path)
  dbs.push(db)
  return db
}

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-keyring-'))
  dirs.push(dir)
  return join(dir, 'data.db')
}

describe('SubjectKeyring 作为 RawCipher（跨包接线的那几个方法）', () => {
  it('seal / open 往返，AAD 绑主体', () => {
    const ring = new SubjectKeyring(open(), clock)
    const sealed = ring.seal(SUBJECT, new TextEncoder().encode(PLAIN))
    expect(new TextDecoder().decode(ring.open(SUBJECT, sealed) as Uint8Array)).toBe(PLAIN)
    // 搬到另一个主体名下：解不开，且不抛
    ring.ensure('customer:cus_other')
    expect(ring.open('customer:cus_other', sealed)).toBeUndefined()
  })

  it('open 对从没有过密钥的主体回 undefined，不抛', () => {
    const ring = new SubjectKeyring(open(), clock)
    expect(ring.open('nobody', new Uint8Array(64))).toBeUndefined()
  })

  it('shred 之后 open 回 undefined，且不再发新钥（删除不可被下一次写入撤销）', () => {
    const ring = new SubjectKeyring(open(), clock)
    const sealed = ring.seal(SUBJECT, new TextEncoder().encode(PLAIN))
    const at = ring.shred(SUBJECT)
    expect(at).toBe(clock.now())
    expect(ring.isShredded(SUBJECT)).toBe(true)
    expect(ring.open(SUBJECT, sealed)).toBeUndefined()
    expect(() => ring.seal(SUBJECT, new Uint8Array([1]))).toThrow()
  })

  it('shred 幂等：第二次回第一次的时间', () => {
    const ring = new SubjectKeyring(open(), clock)
    const first = ring.shred(SUBJECT, '2026-09-01T00:00:00.000Z')
    expect(ring.shred(SUBJECT)).toBe(first)
  })

  it('encryptFor / decryptFor 往返；销毁后回 undefined', () => {
    const ring = new SubjectKeyring(open(), clock)
    const field = ring.encryptFor(SUBJECT, { city: '柏林' })
    expect(ring.decryptFor(SUBJECT, field)).toEqual({ city: '柏林' })
    ring.shred(SUBJECT)
    expect(ring.decryptFor(SUBJECT, field)).toBeUndefined()
  })
})

describe('根密钥包裹（AGENTSWS_DATA_KEY）', () => {
  it('parseDataKey 认十六进制与 base64，长度不对就抛，空当没有', () => {
    const hex = randomBytes(32).toString('hex')
    expect(parseDataKey(hex)?.byteLength).toBe(32)
    expect(parseDataKey(randomBytes(32).toString('base64'))?.byteLength).toBe(32)
    expect(parseDataKey(undefined)).toBeUndefined()
    expect(parseDataKey('   ')).toBeUndefined()
    expect(() => parseDataKey('too-short')).toThrow(DATA_KEY_ENV)
  })

  it('有根密钥时，库文件里找不到主体密钥的明文字节', () => {
    const path = tmpFile()
    const rootKey = randomBytes(32)
    const db = open(path)
    const ring = new SubjectKeyring(db, clock, { rootKey })
    const key = ring.ensure(SUBJECT)
    const stored = db
      .prepare<[string], { key: Buffer; wrapped: number }>(
        'SELECT key, wrapped FROM _subject_keys WHERE subject_id = ?',
      )
      .get(SUBJECT)
    expect(stored?.wrapped).toBe(1)
    expect(Buffer.from(stored?.key as Buffer).includes(key)).toBe(false)
    const bytes = readFileSync(path)
    expect(bytes.includes(key)).toBe(false)
  })

  it('换个进程重开同一个库、同一把根密钥，照样解得开', () => {
    const path = tmpFile()
    const rootKey = randomBytes(32)
    const first = new SubjectKeyring(open(path), clock, { rootKey })
    const sealed = first.seal(SUBJECT, new TextEncoder().encode(PLAIN))
    dbs[dbs.length - 1]?.close()
    dbs.pop()

    const second = new SubjectKeyring(open(path), clock, { rootKey })
    expect(new TextDecoder().decode(second.open(SUBJECT, sealed) as Uint8Array)).toBe(PLAIN)
  })

  it('根密钥不对 → 解不开就是解不开（不猜、不返回半截）', () => {
    const path = tmpFile()
    const first = new SubjectKeyring(open(path), clock, { rootKey: randomBytes(32) })
    first.ensure(SUBJECT)
    dbs[dbs.length - 1]?.close()
    dbs.pop()
    const second = new SubjectKeyring(open(path), clock, { rootKey: randomBytes(32) })
    expect(() => second.get(SUBJECT)).toThrow()
  })

  it('老库（wrapped = 0）照旧直接读；补列是幂等的', () => {
    const path = tmpFile()
    const plainRing = new SubjectKeyring(open(path), clock)
    const sealed = plainRing.seal(SUBJECT, new TextEncoder().encode(PLAIN))
    dbs[dbs.length - 1]?.close()
    dbs.pop()

    // 这台机器后来配了根密钥：老行还是 wrapped = 0，仍然读得出来
    const later = new SubjectKeyring(open(path), clock, { rootKey: randomBytes(32) })
    expect(new TextDecoder().decode(later.open(SUBJECT, sealed) as Uint8Array)).toBe(PLAIN)
  })
})
