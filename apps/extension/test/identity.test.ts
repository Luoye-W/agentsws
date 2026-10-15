/** WP345：manifest 的 `key` 算出来的扩展 id 就是 {@link EXTENSION_ID}（Chrome 的算法：sha256 前 16 字节、半字节换 a–p）。 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { EXTENSION_ID, EXTENSION_PUBLIC_KEY } from '../src/lib/identity'

function chromeIdOf(keyBase64: string): string {
  const hex = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('')
}

describe('固定扩展 id（WP345）', () => {
  it('公钥算出来的 id 与常量一致', () => {
    expect(chromeIdOf(EXTENSION_PUBLIC_KEY)).toBe(EXTENSION_ID)
  })

  it('是一把 2048 位 RSA 公钥（SubjectPublicKeyInfo），不是私钥', () => {
    const der = Buffer.from(EXTENSION_PUBLIC_KEY, 'base64')
    expect(der.length).toBe(294)
    expect(EXTENSION_PUBLIC_KEY).not.toMatch(/PRIVATE/)
  })
})
