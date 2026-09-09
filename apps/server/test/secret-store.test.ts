/**
 * 本机加密秘密库（13 §4.3）。
 *
 * 断言的是四件事：没密钥不落明文、落盘的是密文、AAD 绑连接 id、换密钥解不开。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  createSecretStore,
  parseSecretsKey,
  SECRETS_KEY_ENV,
  SecretStoreError,
  sameKey,
} from '../src/secret-store.js'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const T0 = '2026-09-09T09:00:00.000Z'
const clock = { now: () => T0 }
const PASSWORD = 'hunter2-app-specific-Zx9'

const store = (key: string | undefined, dbPath = ':memory:') =>
  createSecretStore({
    dbPath,
    clock,
    env: key === undefined ? {} : { [SECRETS_KEY_ENV]: key },
  })

describe('秘密库：密钥', () => {
  it('64 位十六进制与 base64 都认，长度不对就拒', () => {
    expect(parseSecretsKey(KEY_A)?.byteLength).toBe(32)
    expect(parseSecretsKey(Buffer.alloc(32, 7).toString('base64'))?.byteLength).toBe(32)
    expect(parseSecretsKey(undefined)).toBeUndefined()
    expect(parseSecretsKey('   ')).toBeUndefined()
    expect(() => parseSecretsKey('too-short')).toThrow(SecretStoreError)
  })

  it('sameKey 只在同一把时为真', () => {
    expect(sameKey(parseSecretsKey(KEY_A), parseSecretsKey(KEY_A))).toBe(true)
    expect(sameKey(parseSecretsKey(KEY_A), parseSecretsKey(KEY_B))).toBe(false)
    expect(sameKey(undefined, parseSecretsKey(KEY_A))).toBe(false)
  })

  it('没有密钥就拒绝保存，而不是退化成明文', () => {
    const s = store(undefined)
    expect(s.available).toBe(false)
    try {
      s.put('conn_1', { password: PASSWORD })
      expect.unreachable('没有密钥时不该写进去')
    } catch (e) {
      expect(e).toBeInstanceOf(SecretStoreError)
      expect((e as SecretStoreError).code).toBe('key_missing')
      // 报错里也不许出现口令
      expect((e as Error).message).not.toContain(PASSWORD)
    }
    s.close()
  })
})

describe('秘密库：读写', () => {
  it('存进去读得回来，列出来的只有字段名', () => {
    const s = store(KEY_A)
    const rec = s.put('conn_1', { email: 'a@b.com', password: PASSWORD })
    expect(rec.field_names).toEqual(['email', 'password'])
    expect(JSON.stringify(rec)).not.toContain(PASSWORD)
    expect(s.get('conn_1')).toEqual({ email: 'a@b.com', password: PASSWORD })
    expect(s.list().map((r) => r.connection_id)).toEqual(['conn_1'])
    expect(JSON.stringify(s.list())).not.toContain(PASSWORD)
    expect(s.get('conn_missing')).toBeUndefined()
    expect(s.remove('conn_1')).toBe(true)
    expect(s.remove('conn_1')).toBe(false)
    expect(s.get('conn_1')).toBeUndefined()
    s.close()
  })

  it('重复写同一条连接就地更新，created_at 不变', () => {
    const s = store(KEY_A)
    const first = s.put('conn_1', { password: 'one' })
    const second = s.put('conn_1', { password: 'two', email: 'x@y.z' })
    expect(second.created_at).toBe(first.created_at)
    expect(s.get('conn_1')?.password).toBe('two')
    expect(s.record('conn_1')?.field_names).toEqual(['password', 'email'])
    s.close()
  })

  it('落盘的文件里没有口令原文（AES-256-GCM）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-secrets-'))
    const file = join(dir, 'secrets.sqlite')
    const s = store(KEY_A, file)
    s.put('conn_1', { password: PASSWORD, email: 'a@b.com' })
    s.close()
    const bytes = readFileSync(file)
    expect(bytes.includes(Buffer.from(PASSWORD, 'utf8'))).toBe(false)
    // 字段名可以出现（不是秘密），口令不行
    expect(bytes.includes(Buffer.from('password', 'utf8'))).toBe(true)
  })

  it('换一把密钥就解不开，且明确报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-secrets-'))
    const file = join(dir, 'secrets.sqlite')
    const a = store(KEY_A, file)
    a.put('conn_1', { password: PASSWORD })
    a.close()
    const b = store(KEY_B, file)
    expect(() => b.get('conn_1')).toThrow(SecretStoreError)
    try {
      b.get('conn_1')
    } catch (e) {
      expect((e as SecretStoreError).code).toBe('decrypt_failed')
    }
    b.close()
  })

  it('AAD 绑连接 id：密文搬到别的 id 下解不开', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-secrets-'))
    const file = join(dir, 'secrets.sqlite')
    const s = store(KEY_A, file)
    s.put('conn_1', { password: PASSWORD })
    s.close()
    // 直接改库：把 conn_1 的密文搬到 conn_2 名下
    const db = new Database(file)
    const row = db.prepare('SELECT * FROM secrets WHERE connection_id = ?').get('conn_1') as {
      field_names: string
      nonce: Buffer
      ciphertext: Buffer
      created_at: string
      updated_at: string
    }
    db.prepare(
      'INSERT INTO secrets (connection_id, field_names, nonce, ciphertext, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('conn_2', row.field_names, row.nonce, row.ciphertext, row.created_at, row.updated_at)
    db.close()
    const again = store(KEY_A, file)
    expect(again.get('conn_1')?.password).toBe(PASSWORD)
    expect(() => again.get('conn_2')).toThrow(SecretStoreError)
    again.close()
  })

  it('空字段表拒绝写入', () => {
    const s = store(KEY_A)
    expect(() => s.put('conn_1', {})).toThrow(SecretStoreError)
    s.close()
  })
})

describe('WP31 密钥轮换（WP20 / WP25 的「秘密库无密钥轮换」遗留）', () => {
  const KEY_C = 'c'.repeat(64)

  it('轮换后旧密钥的库用新密钥读得出来，内容一字不差', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-rotate-'))
    const dbPath = join(dir, 'secrets.sqlite')
    const before = store(KEY_A, dbPath)
    before.put('conn_mail', { username: 'anna@example.com', password: PASSWORD })
    before.put('conn_smtp', { password: 'another-one-1234' })
    const out = before.rotate(KEY_B)
    expect(out.rotated).toBe(2)
    expect(out.at).toBe(T0)
    // 同一个实例里立刻就是新密钥了
    expect(before.get('conn_mail')?.password).toBe(PASSWORD)
    before.close()

    // 换个进程用新密钥开：读得出来
    const after = store(KEY_B, dbPath)
    expect(after.get('conn_mail')).toEqual({ username: 'anna@example.com', password: PASSWORD })
    expect(after.get('conn_smtp')?.password).toBe('another-one-1234')
    after.close()

    // 旧密钥再也读不出来了
    const stale = store(KEY_A, dbPath)
    expect(() => stale.get('conn_mail')).toThrow(SecretStoreError)
    stale.close()
  })

  it('轮换之后库文件里既没有明文，也没有用旧密钥加密的那份密文', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-rotate-bytes-'))
    const dbPath = join(dir, 'secrets.sqlite')
    const s = store(KEY_A, dbPath)
    s.put('conn_mail', { password: PASSWORD })
    const oldCipher = new Database(dbPath)
      .prepare<[string], { ciphertext: Buffer }>(
        'SELECT ciphertext FROM secrets WHERE connection_id = ?',
      )
      .get('conn_mail')?.ciphertext as Buffer
    s.rotate(KEY_B)
    s.close()

    const bytes = readFileSync(dbPath)
    expect(bytes.includes(PASSWORD)).toBe(false)
    expect(bytes.includes(Buffer.from(oldCipher))).toBe(false)
  })

  it('没有密钥 → key_missing；新密钥不合法 → key_invalid；换成同一把 → key_invalid', () => {
    const none = store(undefined)
    expect(() => none.rotate(KEY_B)).toThrow(
      expect.objectContaining({ code: 'key_missing' }) as Error,
    )
    none.close()

    const s = store(KEY_A)
    expect(() => s.rotate('too-short-but-long-enough-to-pass-zod-min')).toThrow(
      expect.objectContaining({ code: 'key_invalid' }) as Error,
    )
    expect(() => s.rotate(KEY_A)).toThrow(expect.objectContaining({ code: 'key_invalid' }) as Error)
    s.close()
  })

  it('空库也能换（换的是密钥本身，不是内容）', () => {
    const s = store(KEY_A)
    expect(s.rotate(KEY_C).rotated).toBe(0)
    s.put('conn_mail', { password: PASSWORD })
    expect(s.get('conn_mail')?.password).toBe(PASSWORD)
    s.close()
  })

  it('有一条解不开就整体不动——绝不留下一半旧钥一半新钥的库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-rotate-partial-'))
    const dbPath = join(dir, 'secrets.sqlite')
    const s = store(KEY_A, dbPath)
    s.put('conn_ok', { password: PASSWORD })
    s.put('conn_broken', { password: 'x'.repeat(20) })
    s.close()

    // 手工把一条的密文改坏（模拟「库里混着更早的密钥」）
    const raw = new Database(dbPath)
    raw
      .prepare('UPDATE secrets SET ciphertext = ? WHERE connection_id = ?')
      .run(Buffer.alloc(40, 9), 'conn_broken')
    raw.close()

    const s2 = store(KEY_A, dbPath)
    expect(() => s2.rotate(KEY_B)).toThrow(
      expect.objectContaining({ code: 'decrypt_failed' }) as Error,
    )
    // 好的那条还是旧密钥加密的：换个新密钥的进程读不出来，老密钥读得出来
    expect(s2.get('conn_ok')?.password).toBe(PASSWORD)
    s2.close()
    const withNew = store(KEY_B, dbPath)
    expect(() => withNew.get('conn_ok')).toThrow(SecretStoreError)
    withNew.close()
  })
})
