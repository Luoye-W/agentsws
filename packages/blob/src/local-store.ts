/**
 * 本地目录档（41 §2.1 第一档）。默认 `AGENTSWS_DATA_DIR/blobs`；
 * NAS 档就是把这个目录指到群晖 / 威联通的共享目录上——代码一个字不用改。
 *
 * 两件事必须做对：
 * - **原子写**：先写同目录下的临时文件、fsync、再 `rename` 覆盖。半截文件不会被读到。
 *   （不能写去 `/tmp` 再 rename：跨文件系统的 rename 不是原子的。）
 * - **key 不能逃出根目录**：`assertKey` 已经挡了 `..` 与绝对路径，
 *   这里再用 `resolve` 复核一次——两道门，因为这一层出事就是任意文件写入。
 */
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { existsSync } from 'node:fs'
import {
  mkdir,
  open as openFile,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Clock } from '@agentsws/contracts'
import type { RawCipher } from '@agentsws/core'
import { isSealed, seal, open as unseal } from './envelope.js'
import {
  assertKey,
  BlobError,
  type BlobMeta,
  type BlobRef,
  type BlobStat,
  type BlobStore,
  blobUri,
} from './types.js'

export interface LocalBlobStoreOptions {
  /** 根目录；不存在就建。 */
  root: string
  clock: Clock
  /** 给了就加密（有 `subject_ref` 的对象）；不给就一律明文。 */
  cipher?: RawCipher
}

interface Sidecar {
  size: number
  content_type?: string
  filename?: string
  subject_ref?: string
  workspace_id?: string
  stored_at: string
  encrypted: boolean
  extra: Record<string, string>
}

export class LocalBlobStore implements BlobStore {
  readonly kind = 'local' as const
  readonly #root: string
  readonly #clock: Clock
  readonly #cipher: RawCipher | undefined

  private constructor(options: LocalBlobStoreOptions) {
    this.#root = resolve(options.root)
    this.#clock = options.clock
    this.#cipher = options.cipher
  }

  static async open(options: LocalBlobStoreOptions): Promise<LocalBlobStore> {
    const store = new LocalBlobStore(options)
    await mkdir(resolve(options.root), { recursive: true })
    return store
  }

  describe(): { kind: 'local'; display: string; encrypted: boolean } {
    return { kind: 'local', display: this.#root, encrypted: this.#cipher !== undefined }
  }

  /** 两道门里的第二道：算出来的路径必须还在根目录里。 */
  #path(key: string): string {
    const path = resolve(this.#root, assertKey(key))
    const rel = relative(this.#root, path)
    if (rel.startsWith('..') || rel.startsWith(sep) || rel === '') {
      throw new BlobError('invalid_input', `blob key escapes the root: ${key}`)
    }
    return path
  }

  async put(key: string, body: Uint8Array, meta: BlobMeta = {}): Promise<BlobRef> {
    const path = this.#path(key)
    const subject = meta.subject_ref
    const encrypt = this.#cipher !== undefined && subject !== undefined && subject.length > 0
    const bytes = encrypt
      ? seal(this.#cipher as RawCipher, subject as string, key, body)
      : Buffer.from(body)

    const sidecar: Sidecar = {
      size: body.length,
      ...(meta.content_type === undefined ? {} : { content_type: meta.content_type }),
      ...(meta.filename === undefined ? {} : { filename: meta.filename }),
      ...(subject === undefined ? {} : { subject_ref: subject }),
      ...(meta.workspace_id === undefined ? {} : { workspace_id: meta.workspace_id }),
      stored_at: this.#clock.now(),
      encrypted: encrypt,
      extra: { ...(meta.extra ?? {}) },
    }

    await mkdir(dirname(path), { recursive: true })
    await atomicWrite(path, bytes)
    await atomicWrite(`${path}.meta.json`, Buffer.from(JSON.stringify(sidecar), 'utf8'))
    return {
      uri: blobUri(key),
      key,
      size: body.length,
      ...(meta.content_type === undefined ? {} : { content_type: meta.content_type }),
    }
  }

  async #sidecar(path: string): Promise<Sidecar | undefined> {
    try {
      return JSON.parse(await readFile(`${path}.meta.json`, 'utf8')) as Sidecar
    } catch {
      // 没有 sidecar（手工拷进来的文件）也认：当成明文，大小取实际大小
      try {
        const s = await stat(path)
        return {
          size: s.size,
          stored_at: new Date(s.mtimeMs).toISOString(),
          encrypted: false,
          extra: {},
        }
      } catch {
        return undefined
      }
    }
  }

  #stat(key: string, sidecar: Sidecar): BlobStat {
    return {
      key,
      uri: blobUri(key),
      size: sidecar.size,
      ...(sidecar.content_type === undefined ? {} : { content_type: sidecar.content_type }),
      ...(sidecar.filename === undefined ? {} : { filename: sidecar.filename }),
      ...(sidecar.subject_ref === undefined ? {} : { subject_ref: sidecar.subject_ref }),
      ...(sidecar.workspace_id === undefined ? {} : { workspace_id: sidecar.workspace_id }),
      stored_at: sidecar.stored_at,
      encrypted: sidecar.encrypted,
      extra: sidecar.extra ?? {},
    }
  }

  async head(key: string): Promise<BlobStat | undefined> {
    const path = this.#path(key)
    if (!existsSync(path)) return undefined
    const sidecar = await this.#sidecar(path)
    return sidecar === undefined ? undefined : this.#stat(key, sidecar)
  }

  async get(key: string): Promise<{ bytes?: Uint8Array; stat: BlobStat } | undefined> {
    const path = this.#path(key)
    if (!existsSync(path)) return undefined
    const sidecar = await this.#sidecar(path)
    if (sidecar === undefined) return undefined
    const raw = await readFile(path)
    const stat = this.#stat(key, sidecar)
    if (!isSealed(raw)) return { bytes: raw, stat }
    const subject = sidecar.subject_ref
    if (this.#cipher === undefined || subject === undefined) return { stat }
    const plain = unseal(this.#cipher, subject, key, raw)
    // 主体密钥已销毁 → 行还在、内容读不出来（21 §4）
    return plain === undefined ? { stat } : { bytes: plain, stat }
  }

  async delete(key: string): Promise<void> {
    const path = this.#path(key)
    await rm(path, { force: true })
    await rm(`${path}.meta.json`, { force: true })
  }

  async list(prefix = ''): Promise<BlobStat[]> {
    const out: BlobStat[] = []
    for (const key of await this.#walk('')) {
      if (!key.startsWith(prefix)) continue
      const sidecar = await this.#sidecar(this.#path(key))
      if (sidecar !== undefined) out.push(this.#stat(key, sidecar))
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  async usage(prefix = ''): Promise<{ objects: number; bytes: number }> {
    let objects = 0
    let bytes = 0
    for (const key of await this.#walk('')) {
      if (!key.startsWith(prefix)) continue
      objects += 1
      try {
        bytes += (await stat(this.#path(key))).size
      } catch {
        // 列的时候被删掉了，跳过
      }
    }
    return { objects, bytes }
  }

  async #walk(rel: string): Promise<string[]> {
    const dir = rel === '' ? this.#root : join(this.#root, rel)
    let entries: Dirent[]
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[]
    } catch {
      return []
    }
    const out: string[] = []
    for (const entry of entries) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        out.push(...(await this.#walk(next)))
        continue
      }
      if (entry.name.endsWith('.meta.json')) continue
      out.push(next)
    }
    return out
  }
}

/** 同目录临时文件 → fsync → rename。半截文件永远不会以正式名字出现。 */
async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.${createHash('sha1').update(`${path}:${process.pid}:${Date.now()}`).digest('hex').slice(0, 12)}.tmp`
  await writeFile(tmp, bytes, { mode: 0o600 })
  const handle = await openFile(tmp, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, path)
}
