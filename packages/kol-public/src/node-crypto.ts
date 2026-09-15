/**
 * 真随机、真哈希、真加密。`node:crypto` 在整个包里**只在这个文件出现**——
 * 逻辑那几个文件要能在测试里全程不碰系统资源地跑完。
 *
 * 邮箱的两件事分得很清（21 §5）：
 *
 * | | 用来干什么 | 能不能还原 |
 * |---|---|---|
 * | `email_sha256` | 去重、"同一人只有共享邮箱自动合并"（48 §1.2） | 不能 |
 * | `email_cipher` | 付费 reveal 那一次解出来 | 能，但要服务密钥 |
 *
 * 密钥**只从环境变量读**（`AGENTSWS_KOL_EMAIL_KEY`），而且是回调——用到那一刻才取，
 * 不在配置对象里长住（与 22 §5「业务代码里没有 key」同一条纪律）。
 * 没有配密钥时 `encrypt` 回 `undefined`：**存不了密文就一个字节都不存**，
 * 绝不降级成明文。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { PLUGIN_TOKEN_PREFIX } from '@agentsws/contracts'
import { KOL_ENV, type KolSecrets } from './types.js'

/** AES-256-GCM：32 字节密钥、12 字节 iv、16 字节 tag。 */
const KEY_BYTES = 32
const IV_BYTES = 12

/** `hex`（64 个字符）或 `base64url` 的 32 字节。认不出来就当没配。 */
export function parseKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex')
  const buf = Buffer.from(value, 'base64url')
  return buf.length === KEY_BYTES ? buf : undefined
}

/** 生成一把新密钥（部署时用一次，写进环境变量；**不在代码里调**）。 */
export function newEmailKey(): string {
  return randomBytes(KEY_BYTES).toString('base64url')
}

export interface NodeKolSecretsOptions {
  /** 不给就读 `process.env`。 */
  env?: Record<string, string | undefined>
}

/**
 * 云侧那一份真实现。
 *
 * 密钥在构造时解析一次（解析失败 = 没配），密钥本身**不出现在任何返回值、
 * 日志与错误信息里**——`available` 只说"有没有"。
 */
export function nodeKolSecrets(options: NodeKolSecretsOptions = {}): KolSecrets {
  const env = options.env ?? process.env
  const key = parseKey(env[KOL_ENV.emailKey])
  return {
    newPluginToken: () => `${PLUGIN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`,
    sha256: (value: string) => createHash('sha256').update(value).digest('hex'),
    available: key !== undefined,
    encrypt(plaintext: string): string | undefined {
      if (key === undefined) return undefined
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return [
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        body.toString('base64url'),
      ].join('.')
    },
    decrypt(value: string): string | undefined {
      if (key === undefined) return undefined
      const parts = value.split('.')
      const [ivRaw, tagRaw, bodyRaw] = parts
      if (
        parts.length !== 3 ||
        ivRaw === undefined ||
        tagRaw === undefined ||
        bodyRaw === undefined
      )
        return undefined
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'))
        decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
        // tag 对不上 `final()` 会抛——密文被改过一个字节都过不去
        return Buffer.concat([
          decipher.update(Buffer.from(bodyRaw, 'base64url')),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        return undefined
      }
    },
  }
}
