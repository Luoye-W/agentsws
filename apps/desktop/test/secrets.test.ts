import { describe, expect, it } from 'vitest'
import { memoryFileStore } from '../src/node-files.js'
import {
  createSecretVault,
  generateSecrets,
  SECRET_BYTES,
  SecretsError,
  secretLiterals,
  secretsToEnv,
} from '../src/secrets.js'
import { fakeSafeStorage, seqRandomBytes } from './fakes.js'

describe('generateSecrets', () => {
  it('三把密钥都是 32 字节的十六进制', () => {
    const secrets = generateSecrets(seqRandomBytes())
    for (const value of secretLiterals(secrets)) {
      expect(value).toMatch(/^[0-9a-f]+$/)
      expect(value).toHaveLength(SECRET_BYTES * 2)
    }
    // 三把互不相同（连续 seed 保证）
    expect(new Set(secretLiterals(secrets)).size).toBe(3)
  })
})

describe('secretsToEnv', () => {
  it('是密钥的唯一出口，并默认封死全部 proxy（08 §5）', () => {
    const secrets = generateSecrets(seqRandomBytes())
    const env = secretsToEnv(secrets)
    expect(env.OOMOL_CONNECT_ENCRYPTION_KEY).toBe(secrets.connectEncryptionKey)
    expect(env.OOMOL_CONNECT_ADMIN_TOKEN).toBe(secrets.connectAdminToken)
    expect(env.OOMOL_CONNECT_BLOCKED_PROXIES).toBe('*')
    expect(env.AGENTSWS_SESSION_KEY).toBe(secrets.serverSessionKey)
  })
})

describe('createSecretVault', () => {
  const vaultOf = (files = memoryFileStore(), available = true) => ({
    files,
    vault: createSecretVault({
      files,
      path: '/secrets.bin',
      safeStorage: fakeSafeStorage(available),
      randomBytes: seqRandomBytes(),
    }),
  })

  it('首次运行生成并加密落盘——文件里没有明文', () => {
    const { files, vault } = vaultOf()
    const { secrets, created } = vault.loadOrCreate()
    expect(created).toBe(true)
    const bytes = files.readBytes('/secrets.bin')
    expect(bytes).toBeDefined()
    const asText = new TextDecoder().decode(bytes ?? new Uint8Array())
    for (const literal of secretLiterals(secrets)) expect(asText).not.toContain(literal)
  })

  it('第二次只读回，不重新生成', () => {
    const { files, vault } = vaultOf()
    const first = vault.loadOrCreate()
    const second = createSecretVault({
      files,
      path: '/secrets.bin',
      safeStorage: fakeSafeStorage(),
      randomBytes: seqRandomBytes(99),
    }).loadOrCreate()
    expect(second.created).toBe(false)
    expect(second.secrets).toEqual(first.secrets)
  })

  it('空文件当没有', () => {
    const files = memoryFileStore()
    files.writeBytes('/secrets.bin', new Uint8Array())
    expect(vaultOf(files).vault.loadOrCreate().created).toBe(true)
  })

  it('系统密钥库不可用时拒绝启动，绝不落明文', () => {
    const { files, vault } = vaultOf(memoryFileStore(), false)
    expect(() => vault.loadOrCreate()).toThrowError(SecretsError)
    expect(() => vault.rotate()).toThrowError(/密钥库不可用/)
    expect(files.exists('/secrets.bin')).toBe(false)
    try {
      vault.loadOrCreate()
    } catch (err) {
      expect((err as SecretsError).code).toBe('encryption_unavailable')
      expect((err as SecretsError).name).toBe('SecretsError')
    }
  })

  it('密文坏了 / 字段缺了都报 corrupt', () => {
    const files = memoryFileStore()
    files.writeBytes('/secrets.bin', new Uint8Array([1, 2, 3]))
    expect(() => vaultOf(files).vault.loadOrCreate()).toThrowError(/无法解密/)

    const partial = memoryFileStore()
    partial.writeBytes(
      '/secrets.bin',
      fakeSafeStorage().encryptString(JSON.stringify({ connectAdminToken: 'x' })),
    )
    expect(() => vaultOf(partial).vault.loadOrCreate()).toThrowError(/内容不完整/)

    const wrongShape = memoryFileStore()
    wrongShape.writeBytes('/secrets.bin', fakeSafeStorage().encryptString('"a string"'))
    expect(() => vaultOf(wrongShape).vault.loadOrCreate()).toThrowError(/内容不完整/)
  })

  it('rotate 换一套新的并覆盖旧密文', () => {
    const { files, vault } = vaultOf()
    const first = vault.loadOrCreate().secrets
    const rotated = vault.rotate()
    expect(rotated).not.toEqual(first)
    expect(
      createSecretVault({
        files,
        path: '/secrets.bin',
        safeStorage: fakeSafeStorage(),
        randomBytes: seqRandomBytes(),
      }).loadOrCreate().secrets,
    ).toEqual(rotated)
  })
})
