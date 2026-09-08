import { createHash } from 'node:crypto'

/**
 * 13 §4.3：凭据永远不进日志、不进事件、不进返回值。任何需要"指认某个 token"的地方
 * 只允许出现 sha256 的**前 12 位十六进制**，原文不落任何一处。
 */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12)
}

/** token 在本地表里的主键：整串 sha256，原文不存。 */
export function secretKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** 从环境变量名读秘密；秘密只从环境变量名读，不接受直接传值。 */
export function readSecretFromEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const v = env[name]
  return v === undefined || v.length === 0 ? undefined : v
}
