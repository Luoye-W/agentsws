/**
 * 上传表的指纹：审批时算好绑在卡上，执行前插件拿到的那份再算一次，对不上就拒（docs/101 §1.4）。
 *
 * 用 WebCrypto（`globalThis.crypto.subtle`）：Chrome 插件与 Node 20+ 都有，一份代码两边用。
 * 形状是 `sha256:<64 位小写十六进制>`。WP314 出的上传表是什么字节，就对什么字节算——
 * 文字表按 UTF-8 编码（不加 BOM、不改换行），这一条写进了与 WP314 的对接约定。
 */

const PREFIX = 'sha256:'

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content
}

export async function sheetFingerprint(content: string | Uint8Array): Promise<string> {
  const bytes = toBytes(content)
  // 拷一份成独立的 ArrayBuffer：subtle.digest 不收 SharedArrayBuffer 视图
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer)
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return `${PREFIX}${hex}`
}

export function isFingerprint(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value)
}

/** 执行前那一道：拿到的这份是不是批过的那一份。 */
export async function sheetMatches(
  content: string | Uint8Array,
  fingerprint: string,
): Promise<boolean> {
  if (!isFingerprint(fingerprint)) return false
  return (await sheetFingerprint(content)) === fingerprint
}

/** base64 ↔ 字节（插件与本机之间传上传表用；不依赖 Buffer）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}
