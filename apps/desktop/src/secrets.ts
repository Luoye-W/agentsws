/**
 * 首次运行生成的三把密钥，用 Electron `safeStorage` 加密后存在用户数据目录
 * （macOS 钥匙串、Windows DPAPI 背书；08 §5 安装器策略要求 OpenConnector runtime
 * 必须有 `ENCRYPTION_KEY` 与 `ADMIN_TOKEN` 才允许启动）。
 *
 * 三条纪律：
 * 1. **不写明文文件**——safeStorage 不可用就直接抛，宁可起不来也不落明文；
 * 2. **不经模型、不经渲染进程**——只有主进程读得到，只以环境变量交给子进程；
 * 3. **不进日志**——`redact.ts` 把这三个值注册成字面量遮罩。
 */
import type { FileStore, RandomBytes, SafeStorageLike } from './ports.js'

export interface DesktopSecrets {
  /** `OOMOL_CONNECT_ENCRYPTION_KEY`：OpenConnector 凭据静态加密。 */
  connectEncryptionKey: string
  /** `OOMOL_CONNECT_ADMIN_TOKEN`：OpenConnector admin 面鉴权。 */
  connectAdminToken: string
  /** 服务进程会话密钥（浏览器会话 token → HttpOnly cookie，13 §5）。 */
  serverSessionKey: string
  /**
   * `AGENTSWS_SECRETS_KEY`：服务进程的本机加密秘密库（WP20）。
   *
   * 上游 OpenConnector 没有通用 IMAP / SMTP provider（08 §3 的覆盖缺口），
   * 所以邮箱的应用专用密码存在服务进程自己的 AES-256-GCM 库里，密钥由这里生成。
   * 没有它，工作台会明确拒绝保存邮箱凭据，而不是退化成明文。
   */
  serverSecretsKey: string
}

export const SECRET_BYTES = 32

export type SecretsErrorCode = 'encryption_unavailable' | 'corrupt'

export class SecretsError extends Error {
  readonly code: SecretsErrorCode
  constructor(code: SecretsErrorCode, message: string) {
    super(message)
    this.name = 'SecretsError'
    this.code = code
  }
}

/** 32 字节 → 64 位十六进制（`AGENTSWS_SECRETS_KEY` / `AGENTSWS_DATA_KEY` 都认这个形状）。 */
export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function generateSecrets(randomBytes: RandomBytes): DesktopSecrets {
  return {
    connectEncryptionKey: toHex(randomBytes(SECRET_BYTES)),
    connectAdminToken: toHex(randomBytes(SECRET_BYTES)),
    serverSessionKey: toHex(randomBytes(SECRET_BYTES)),
    serverSecretsKey: toHex(randomBytes(SECRET_BYTES)),
  }
}

function isSecrets(raw: unknown): raw is DesktopSecrets {
  if (typeof raw !== 'object' || raw === null) return false
  const obj = raw as Record<string, unknown>
  return (
    typeof obj.connectEncryptionKey === 'string' &&
    obj.connectEncryptionKey.length > 0 &&
    typeof obj.connectAdminToken === 'string' &&
    obj.connectAdminToken.length > 0 &&
    typeof obj.serverSessionKey === 'string' &&
    obj.serverSessionKey.length > 0 &&
    typeof obj.serverSecretsKey === 'string' &&
    obj.serverSecretsKey.length > 0
  )
}

export interface SecretVaultOptions {
  files: FileStore
  path: string
  safeStorage: SafeStorageLike
  randomBytes: RandomBytes
}

export interface SecretVault {
  /** 首次运行生成并落盘；之后只解密读回。 */
  loadOrCreate(): { secrets: DesktopSecrets; created: boolean }
  /** 换机 / 泄漏时重新生成**全部**四把（覆盖旧密文）。 */
  rotate(): DesktopSecrets
  /**
   * 只换其中一把时用（WP31「轮换本机密钥」：`AGENTSWS_SECRETS_KEY` 换新，
   * 另外三把不动——OpenConnector 的两把和会话密钥各有各的轮换时机）。
   * **必须先落盘再去改库**，反过来崩一次就再也解不开了。
   */
  write(secrets: DesktopSecrets): void
}

export function createSecretVault(options: SecretVaultOptions): SecretVault {
  const { files, path, safeStorage, randomBytes } = options

  const requireEncryption = (): void => {
    if (!safeStorage.isEncryptionAvailable())
      throw new SecretsError(
        'encryption_unavailable',
        '系统密钥库不可用（macOS 钥匙串 / Windows DPAPI / Linux libsecret）；' +
          '为避免明文落盘，桌面壳拒绝生成密钥。',
      )
  }

  const write = (secrets: DesktopSecrets): void => {
    files.writeBytes(path, safeStorage.encryptString(JSON.stringify(secrets)))
  }

  return {
    write(secrets) {
      requireEncryption()
      write(secrets)
    },
    loadOrCreate() {
      requireEncryption()
      const bytes = files.readBytes(path)
      if (bytes === undefined || bytes.byteLength === 0) {
        const secrets = generateSecrets(randomBytes)
        write(secrets)
        return { secrets, created: true }
      }
      let raw: unknown
      try {
        raw = JSON.parse(safeStorage.decryptString(bytes))
      } catch {
        throw new SecretsError('corrupt', `密钥文件无法解密：${path}（删除它会重新生成一套）`)
      }
      if (!isSecrets(raw))
        throw new SecretsError('corrupt', `密钥文件内容不完整：${path}（删除它会重新生成一套）`)
      return { secrets: raw, created: false }
    },
    rotate() {
      requireEncryption()
      const secrets = generateSecrets(randomBytes)
      write(secrets)
      return secrets
    },
  }
}

/** 密钥的全部出口：只有环境变量这一条路。 */
export function secretsToEnv(secrets: DesktopSecrets): Record<string, string> {
  return {
    OOMOL_CONNECT_ENCRYPTION_KEY: secrets.connectEncryptionKey,
    OOMOL_CONNECT_ADMIN_TOKEN: secrets.connectAdminToken,
    // 08 §5：安装器默认封死全部 provider proxy。
    OOMOL_CONNECT_BLOCKED_PROXIES: '*',
    AGENTSWS_SESSION_KEY: secrets.serverSessionKey,
    // WP20：服务进程的本机加密秘密库（邮箱应用专用密码）
    AGENTSWS_SECRETS_KEY: secrets.serverSecretsKey,
  }
}

/** 交给 `createRedactor()` 的字面量清单。 */
export function secretLiterals(secrets: DesktopSecrets): string[] {
  return [
    secrets.connectEncryptionKey,
    secrets.connectAdminToken,
    secrets.serverSessionKey,
    secrets.serverSecretsKey,
  ]
}
