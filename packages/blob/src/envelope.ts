/**
 * 对象信封：**每对象一把密钥**，密钥用主体密钥包一层，一起写进对象自己。
 *
 * 为什么不是「直接用主体密钥加密内容」：一个主体可能有上万个对象（一年的邮件附件），
 * 同一把密钥加密上万段内容会把 GCM 的 nonce 空间压得很紧；而且换钥要重写全部对象。
 * 每对象一把随机密钥 + 主体密钥只包那 32 字节，两个问题一起没了，
 * 销毁语义还是同一个：**主体密钥一销毁，这个主体的每一个对象当场读不出来**（21 §4）。
 *
 * 落盘布局（一个对象一段字节，后端只是搬运工）：
 *
 * ```
 * "ASWB1"  5 字节魔数
 * u16      包裹后的对象密钥长度
 * bytes    包裹后的对象密钥（RawCipher.seal(subject, objectKey)）
 * 12 字节  IV
 * bytes    密文
 * 16 字节  GCM tag
 * ```
 *
 * AAD 绑 `key`（对象路径）：把一段密文搬到另一个 key 名下必须解不开。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { RawCipher } from '@agentsws/core'
import { BlobError } from './types.js'

const MAGIC = Buffer.from('ASWB1', 'ascii')
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

export function isSealed(bytes: Uint8Array): boolean {
  return bytes.length > MAGIC.length && Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC)
}

/**
 * 加密。`cipher.seal` 对已销毁的主体会抛——销毁过的主体不能又收新内容，
 * 否则「删除」可被下一次写入撤销（18 §2.1 的第一条实现约束）。
 */
export function seal(
  cipher: RawCipher,
  subject: string,
  key: string,
  plaintext: Uint8Array,
): Uint8Array {
  const objectKey = randomBytes(KEY_LEN)
  const wrapped = Buffer.from(cipher.seal(subject, objectKey))
  if (wrapped.length > 0xffff) {
    throw new BlobError('backend_error', 'wrapped object key is too large')
  }
  const iv = randomBytes(IV_LEN)
  const aes = createCipheriv('aes-256-gcm', objectKey, iv)
  aes.setAAD(Buffer.from(key, 'utf8'))
  const body = Buffer.concat([aes.update(Buffer.from(plaintext)), aes.final()])
  const tag = aes.getAuthTag()
  const len = Buffer.alloc(2)
  len.writeUInt16BE(wrapped.length, 0)
  objectKey.fill(0)
  return Buffer.concat([MAGIC, len, wrapped, iv, body, tag])
}

/**
 * 解密。解不开一律 `undefined`（密钥已销毁 / 从没有过 / 密文被改动）——
 * 不抛、不返回半截（18 §2.1 的第二条实现约束）。
 */
export function open(
  cipher: RawCipher,
  subject: string,
  key: string,
  sealed: Uint8Array,
): Uint8Array | undefined {
  try {
    const buf = Buffer.from(sealed)
    if (!isSealed(buf)) return undefined
    let at = MAGIC.length
    const wrappedLen = buf.readUInt16BE(at)
    at += 2
    const wrapped = buf.subarray(at, at + wrappedLen)
    at += wrappedLen
    const iv = buf.subarray(at, at + IV_LEN)
    at += IV_LEN
    const tag = buf.subarray(buf.length - TAG_LEN)
    const body = buf.subarray(at, buf.length - TAG_LEN)

    const objectKey = cipher.open(subject, wrapped)
    if (objectKey === undefined || objectKey.length !== KEY_LEN) return undefined
    const aes = createDecipheriv('aes-256-gcm', Buffer.from(objectKey), iv)
    aes.setAAD(Buffer.from(key, 'utf8'))
    aes.setAuthTag(tag)
    const out = Buffer.concat([aes.update(body), aes.final()])
    Buffer.from(objectKey).fill(0)
    return out
  } catch {
    return undefined
  }
}
