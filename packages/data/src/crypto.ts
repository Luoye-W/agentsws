import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** 21 §4：个人数据字段加密存储，每个主体一把独立随机主体密钥（不可从主密钥重派生）。 */
export const ALGO = 'aes-256-gcm'
export const KEY_BYTES = 32
const IV_BYTES = 12

/** 密钥销毁后 PII 字段读出来的占位值。 */
export const ERASED = '[erased]'

export interface EncryptedField {
  readonly __enc: typeof ALGO
  readonly key_id: string
  readonly iv: string
  readonly tag: string
  readonly ct: string
}

export function newSubjectKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export function isEncryptedField(v: unknown): v is EncryptedField {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __enc?: unknown }).__enc === ALGO &&
    typeof (v as { ct?: unknown }).ct === 'string'
  )
}

export function encryptValue(key: Buffer, keyId: string, value: unknown): EncryptedField {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(value ?? null), 'utf8'), cipher.final()])
  return {
    __enc: ALGO,
    key_id: keyId,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }
}

export function decryptValue(key: Buffer, field: EncryptedField): unknown {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(field.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(field.tag, 'base64'))
  const pt = Buffer.concat([decipher.update(Buffer.from(field.ct, 'base64')), decipher.final()])
  return JSON.parse(pt.toString('utf8'))
}

// ── 主体密钥的静态包裹（WP31）────────────────────────────────────────────

/** 根密钥的环境变量名。密钥只从环境变量读（35 §2），不接受直接传值。 */
export const DATA_KEY_ENV = 'AGENTSWS_DATA_KEY'

/**
 * 根密钥：64 位十六进制，或任何 32 字节的 base64。
 *
 * 长度不对就抛——不做 KDF 拉伸，免得一个弱口令看起来像一把 256 位密钥
 * （与 `apps/server/src/secret-store.ts` 的 `parseSecretsKey` 同一条纪律）。
 * 没设就返回 undefined：主体密钥仍然是每主体一把独立随机的，只是不再多包一层。
 */
export function parseDataKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')
  const b64 = Buffer.from(trimmed, 'base64')
  if (b64.byteLength === KEY_BYTES) return b64
  throw new Error(`${DATA_KEY_ENV} 必须是 32 字节密钥（64 位十六进制，或 base64）；当前长度不对`)
}

/**
 * 包裹一把主体密钥：`iv(12) | tag(16) | ct`，AAD 绑 subject_id
 * （把一行的密文搬到另一个主体名下会解不开）。
 */
export function wrapKey(rootKey: Buffer, subject: string, subjectKey: Buffer): Buffer {
  return sealBytes(rootKey, subject, subjectKey)
}

export function unwrapKey(rootKey: Buffer, subject: string, wrapped: Buffer): Buffer {
  const out = openBytes(rootKey, subject, wrapped)
  if (out === undefined) throw new Error(`主体密钥解不开：${subject}（根密钥换过，或文件被改动）`)
  return out
}

// ── 字节载荷的封装（受控原始材料区用；结构化字段仍走 encryptValue）─────────

const TAG_BYTES = 16

/**
 * AES-256-GCM 封装一段字节：`iv(12) | tag(16) | ct`。AAD 绑 `aad`（主体标识）。
 *
 * 与 {@link encryptValue} 的区别只有形态：那个产 JSON 字段（存进记录 body），
 * 这个产字节（存进原始材料区的 BLOB 列）。
 */
export function sealBytes(key: Buffer, aad: string, plaintext: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct])
}

/** 解不开（换过密钥 / 被改动 / AAD 不符）→ undefined，由调用方决定怎么表达。 */
export function openBytes(key: Buffer, aad: string, sealed: Uint8Array): Buffer | undefined {
  const buf = Buffer.from(sealed)
  if (buf.byteLength < IV_BYTES + TAG_BYTES) return undefined
  try {
    const iv = buf.subarray(0, IV_BYTES)
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const body = buf.subarray(IV_BYTES + TAG_BYTES)
    const decipher = createDecipheriv(ALGO, key, iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    return undefined
  }
}
