/**
 * `BlobStore` 一致性套件（WP40 §3）：本地目录档与 S3 兼容档各跑一遍。
 *
 * S3 那一遍打的是本机 docker 起的 **MinIO**（`AGENTSWS_TEST_S3_ENDPOINT`）。
 * 起不来就整段跳过并打一行为什么——「全绿」不能是「一半没跑」。
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import type { RawCipher } from '@agentsws/core'
import { afterAll, describe, expect, it } from 'vitest'
import { LocalBlobStore } from '../src/local-store.js'
import { S3BlobStore } from '../src/s3-store.js'
import { assertKey, BlobError, type BlobStore } from '../src/types.js'

const clock: Clock = { now: () => '2026-09-10T00:00:00.000Z' }

/** 测试用密钥环：每个主体一把随机密钥，`shred` 就是删掉它（真实实现是 data 的 SubjectKeyring）。 */
class TestCipher implements RawCipher {
  readonly #keys = new Map<string, Buffer>()
  readonly #dead = new Set<string>()

  seal(subject: string, plaintext: Uint8Array): Uint8Array {
    if (this.#dead.has(subject)) throw new Error(`subject key destroyed: ${subject}`)
    let key = this.#keys.get(subject)
    if (key === undefined) {
      key = randomBytes(32)
      this.#keys.set(subject, key)
    }
    // 玩具「包裹」：异或 + 前缀，够测「换主体解不开」与「销毁读不出来」
    const out = Buffer.alloc(plaintext.length)
    for (let i = 0; i < plaintext.length; i += 1) {
      out[i] = (plaintext[i] as number) ^ (key[i % key.length] as number)
    }
    return out
  }

  open(subject: string, sealed: Uint8Array): Uint8Array | undefined {
    const key = this.#keys.get(subject)
    if (key === undefined || this.#dead.has(subject)) return undefined
    const out = Buffer.alloc(sealed.length)
    for (let i = 0; i < sealed.length; i += 1) {
      out[i] = (sealed[i] as number) ^ (key[i % key.length] as number)
    }
    return out
  }

  shred(subject: string, at = '2026-09-10T00:00:00.000Z'): string {
    this.#dead.add(subject)
    this.#keys.delete(subject)
    return at
  }

  isShredded(subject: string): boolean {
    return this.#dead.has(subject)
  }
}

const s3Endpoint = process.env.AGENTSWS_TEST_S3_ENDPOINT
const s3Ok = await probeMinio(s3Endpoint)
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

async function probeMinio(endpoint: string | undefined): Promise<boolean> {
  if (endpoint === undefined) return false
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/minio/health/live`)
    return response.ok
  } catch {
    return false
  }
}

interface Backend {
  name: string
  skip: boolean
  open(cipher?: RawCipher): Promise<BlobStore>
}

const BACKENDS: Backend[] = [
  {
    name: 'local',
    skip: false,
    open: async (cipher) => {
      const dir = mkdtempSync(join(tmpdir(), 'agentsws-blob-'))
      dirs.push(dir)
      return LocalBlobStore.open({ root: dir, clock, ...(cipher === undefined ? {} : { cipher }) })
    },
  },
  {
    name: 's3 (minio)',
    skip: !s3Ok,
    open: async (cipher) => {
      const bucket = `agentsws-test-${randomBytes(4).toString('hex')}`
      const store = new S3BlobStore({
        endpoint: s3Endpoint as string,
        bucket,
        region: 'us-east-1',
        credentials: {
          accessKeyId: process.env.AGENTSWS_TEST_S3_ACCESS_KEY ?? 'agentsws',
          secretAccessKey: process.env.AGENTSWS_TEST_S3_SECRET_KEY ?? 'agentsws-secret',
        },
        clock: { now: () => new Date().toISOString() },
        ...(cipher === undefined ? {} : { cipher }),
      })
      await createBucket(bucket)
      return store
    },
  },
]

async function createBucket(bucket: string): Promise<void> {
  const { signRequest } = await import('../src/sigv4.js')
  const url = new URL(`${(s3Endpoint as string).replace(/\/$/, '')}/${bucket}`)
  const headers = signRequest({
    method: 'PUT',
    url,
    headers: {},
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.AGENTSWS_TEST_S3_ACCESS_KEY ?? 'agentsws',
      secretAccessKey: process.env.AGENTSWS_TEST_S3_SECRET_KEY ?? 'agentsws-secret',
    },
    now: new Date(),
  })
  const response = await fetch(url.toString(), { method: 'PUT', headers })
  if (!response.ok && response.status !== 409) {
    throw new Error(`cannot create bucket: ${response.status} ${await response.text()}`)
  }
}

const HELLO = Buffer.from('会议录音的头几个字节', 'utf8')

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(`BlobStore 一致性 · ${backend.name}`, () => {
    it('put / get / head / delete 一圈', async () => {
      const store = await backend.open()
      const ref = await store.put('meetings/m1/audio.webm', HELLO, {
        content_type: 'audio/webm',
        filename: '周会录音.webm',
        workspace_id: 'ws_1',
      })
      expect(ref.uri).toBe('blob://meetings/m1/audio.webm')
      expect(ref.size).toBe(HELLO.length)

      const got = await store.get('meetings/m1/audio.webm')
      expect(Buffer.from(got?.bytes ?? []).toString('utf8')).toBe(HELLO.toString('utf8'))
      expect(got?.stat.content_type).toBe('audio/webm')
      expect(got?.stat.filename).toBe('周会录音.webm')
      expect(got?.stat.encrypted).toBe(false)

      const head = await store.head('meetings/m1/audio.webm')
      expect(head?.size).toBe(HELLO.length)

      await store.delete('meetings/m1/audio.webm')
      expect(await store.head('meetings/m1/audio.webm')).toBeUndefined()
      expect(await store.get('meetings/m1/audio.webm')).toBeUndefined()
    })

    it('list(prefix) 只出这个前缀，按 key 排序', async () => {
      const store = await backend.open()
      await store.put('channels/a/1.eml', Buffer.from('a'))
      await store.put('channels/a/2.eml', Buffer.from('bb'))
      await store.put('meetings/x/1.webm', Buffer.from('ccc'))
      const listed = await store.list('channels/')
      expect(listed.map((s) => s.key)).toEqual(['channels/a/1.eml', 'channels/a/2.eml'])
      const usage = await store.usage('channels/')
      expect(usage.objects).toBe(2)
      expect(usage.bytes).toBeGreaterThanOrEqual(3)
    })

    it('覆盖写：同一个 key 再 put 一次读到的是新内容', async () => {
      const store = await backend.open()
      await store.put('a/b.txt', Buffer.from('v1'))
      await store.put('a/b.txt', Buffer.from('v2-longer'))
      const got = await store.get('a/b.txt')
      expect(Buffer.from(got?.bytes ?? []).toString()).toBe('v2-longer')
      expect(got?.stat.size).toBe('v2-longer'.length)
    })

    it('加密：有 subject_ref 就加密；销毁主体密钥后行还在、内容读不出来（21 §4）', async () => {
      const cipher = new TestCipher()
      const store = await backend.open(cipher)
      await store.put('meetings/m2/audio.webm', HELLO, {
        subject_ref: 'person:p_1',
        content_type: 'audio/webm',
      })
      const before = await store.get('meetings/m2/audio.webm')
      expect(before?.stat.encrypted).toBe(true)
      expect(before?.stat.subject_ref).toBe('person:p_1')
      expect(Buffer.from(before?.bytes ?? []).toString('utf8')).toBe(HELLO.toString('utf8'))
      // 明文大小按调用方给的那个数，不是信封大小
      expect(before?.stat.size).toBe(HELLO.length)

      cipher.shred('person:p_1')
      const after = await store.get('meetings/m2/audio.webm')
      expect(after).toBeDefined()
      expect(after?.stat.encrypted).toBe(true)
      expect(after?.bytes).toBeUndefined()
    })

    it('加密：已销毁的主体拒绝再写（删除不能被下一次写入撤销）', async () => {
      const cipher = new TestCipher()
      const store = await backend.open(cipher)
      cipher.shred('person:p_2')
      await expect(store.put('x/y.bin', HELLO, { subject_ref: 'person:p_2' })).rejects.toThrow(
        /destroyed/,
      )
    })

    it('没有 subject_ref 就是明文——这不是漏洞，是「没有主体可绑」', async () => {
      const store = await backend.open(new TestCipher())
      await store.put('system/log.txt', Buffer.from('系统日志'))
      const got = await store.get('system/log.txt')
      expect(got?.stat.encrypted).toBe(false)
      expect(Buffer.from(got?.bytes ?? []).toString('utf8')).toBe('系统日志')
    })

    it('describe() 不含凭据', async () => {
      const store = await backend.open()
      const described = store.describe()
      expect(described.display).not.toMatch(/agentsws-secret|AKIA|secret/i)
    })
  })
}

describe('key 合法性（两个档共用的那道门）', () => {
  it('挡住 ..、绝对路径、反斜杠与空 key', () => {
    expect(() => assertKey('a/../../etc/passwd')).toThrow(BlobError)
    expect(() => assertKey('/etc/passwd')).toThrow(BlobError)
    expect(() => assertKey('a\\b')).toThrow(BlobError)
    expect(() => assertKey('')).toThrow(BlobError)
    expect(assertKey('meetings/m1/audio.webm')).toBe('meetings/m1/audio.webm')
  })

  it('本地档第二道门：算出来的路径必须还在根目录里', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-blob-'))
    dirs.push(dir)
    const store = await LocalBlobStore.open({ root: dir, clock })
    await expect(store.put('../escape.txt', Buffer.from('x'))).rejects.toThrow(BlobError)
  })
})

if (!s3Ok) {
  console.warn(
    '[WP40] S3 一致性用例已跳过：MinIO 连不上（设 AGENTSWS_TEST_S3_ENDPOINT，或 docker compose --profile s3 up -d）。',
  )
}
