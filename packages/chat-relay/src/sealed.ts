/**
 * 留言的封箱与开箱（WP124 §B）：转发器暂存的留言必须是**密文**——
 * 「转发器看得到过路内容但不落盘」，留言是唯一落下去的东西，落下去的
 * 必须是看不懂的。
 *
 * 密钥就是那把**配对密钥**（商家本机与转发器各持一份明文，转发器箱里只有哈希
 * ——所以转发器自己打不开自己存的留言，这件事由测试钉住）。
 *
 * 形态：AES-256-GCM。密文格式 `cr1:<iv>:<tag>:<ciphertext>`（全是 base64url）。
 * 版本前缀 `cr1` 是给将来换算法留的口——换算法不影响还没拉走的旧留言。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const SEALED_VERSION = 'cr1'

/**
 * 留言密钥（任意长度）→ 32 字节 AES 密钥。
 *
 * **与转发器侧同一条派生**：官方托管用 `sha256('chat-relay:' + 留言密钥)`
 * 封箱；本机拉走时用同一把开箱。派生串不一致的话，本机永远开不开自己
 * 的留言——契约测试在两包各钉一遍。
 */
export function sealedKeyOf(messageKey: string): Buffer {
  return createHash('sha256').update(`chat-relay:${messageKey}`).digest()
}

/** 封箱。输出 `cr1:<iv>:<tag>:<ciphertext>`（base64url 三段）。 */
export function sealWithKey(
  key: Buffer,
  plaintext: string,
  random: (n: number) => Buffer = (n) => randomBytes(n),
): string {
  const iv = random(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    SEALED_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':')
}

/** 开箱。密钥不对 / 密文被改过 → `undefined`（不抛，调用方按「不是给我的」处理）。 */
export function openSealed(key: Buffer, sealed: string): string | undefined {
  const parts = sealed.split(':')
  if (parts.length !== 4 || parts[0] !== SEALED_VERSION) return undefined
  try {
    const iv = Buffer.from(parts[1] as string, 'base64url')
    const tag = Buffer.from(parts[2] as string, 'base64url')
    const ciphertext = Buffer.from(parts[3] as string, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}
