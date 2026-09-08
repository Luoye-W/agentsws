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
