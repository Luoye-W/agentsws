import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_EXIT_CONFIG,
  HOST_READY_RE,
  HOST_SCRIPT,
  hostEnv,
  hostPackageJson,
  isVersionDir,
  localRuntimeLayout,
  lockedPackageCount,
  OPEN_CONNECTOR_LOCKFILE,
  OPEN_CONNECTOR_PIN,
  parseControlFile,
  parseCurrentFile,
  parseSupervisorFile,
} from '../src/index.js'

describe('钉死的版本与锁文件（WP247）', () => {
  it('锁文件里那一条与 pin 逐字相同：版本、sha512', () => {
    const entry = OPEN_CONNECTOR_LOCKFILE.packages[`node_modules/${OPEN_CONNECTOR_PIN.package}`]
    expect(entry?.version).toBe(OPEN_CONNECTOR_PIN.version)
    expect(entry?.integrity).toBe(OPEN_CONNECTOR_PIN.integrity)
    for (const [name, version] of Object.entries(OPEN_CONNECTOR_PIN.hostDeps))
      expect(OPEN_CONNECTOR_LOCKFILE.packages[`node_modules/${name}`]?.version).toBe(version)
  })

  it('每个要下载的包都有 sha512 与官方源地址；包数与 pin 一致', () => {
    const entries = Object.entries(OPEN_CONNECTOR_LOCKFILE.packages).filter(([p]) => p !== '')
    for (const [path, e] of entries) {
      expect(e.integrity, path).toMatch(/^sha512-/)
      expect(e.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//)
    }
    expect(lockedPackageCount()).toBe(OPEN_CONNECTOR_PIN.packages)
  })

  it('安装目录的 package.json 与锁文件根上那一条对得上（npm ci 会核对）', () => {
    const pkg = hostPackageJson()
    const root = OPEN_CONNECTOR_LOCKFILE.packages['']
    expect(root?.name).toBe(pkg.name)
    expect(root?.dependencies).toEqual(pkg.dependencies)
    expect(OPEN_CONNECTOR_LOCKFILE.lockfileVersion).toBe(3)
  })
})

describe('目录布局', () => {
  it('版本目录只认 x.y.z；数据目录与下载目录分开', () => {
    const l = localRuntimeLayout('/d')
    expect(l.versionDir('1.8.0')).toBe(join('/d', 'runtime', 'open-connector', '1.8.0'))
    expect(() => l.versionDir('../x')).toThrow()
    expect(l.data).toBe(join('/d', 'runtime', 'open-connector-data'))
    expect(l.data.startsWith(`${l.root}${sep}`)).toBe(false)
    expect(isVersionDir('1.8.0')).toBe(true)
    expect(isVersionDir('.npm-cache')).toBe(false)
  })
})

describe('三份小文件的解析：坏了就当没有', () => {
  it('current.json', () => {
    expect(parseCurrentFile({ version: '1.8.0', previous: '1.7.0', installed_at: 't' })).toEqual({
      version: '1.8.0',
      previous: '1.7.0',
      installed_at: 't',
    })
    expect(parseCurrentFile({ version: '1.8.0', previous: '1.8.0' })).toEqual({
      version: '1.8.0',
      installed_at: '',
    })
    expect(parseCurrentFile({ version: '../../etc' })).toBeUndefined()
    expect(parseCurrentFile('x')).toBeUndefined()
    expect(parseCurrentFile([])).toBeUndefined()
  })

  it('control.json', () => {
    expect(parseControlFile({ desired: 'stop', restart_seq: 3, updated_at: 't' })).toEqual({
      desired: 'stop',
      restart_seq: 3,
      updated_at: 't',
    })
    expect(parseControlFile({ desired: 'run', restart_seq: -1 })?.restart_seq).toBe(0)
    expect(parseControlFile({ desired: 'maybe' })).toBeUndefined()
    expect(parseControlFile(null)).toBeUndefined()
  })

  it('supervisor.json', () => {
    const full = parseSupervisorFile({
      state: 'backoff',
      port: 43170,
      pid: 9,
      attempts: 2,
      version: '1.8.0',
      started_at: 's',
      last_exit: { code: 1, signal: null, at: 'a' },
      retry_in_ms: 2000,
      last_error: 'x'.repeat(500),
      updated_at: 'u',
    })
    expect(full?.state).toBe('backoff')
    expect(full?.last_exit).toEqual({ code: 1, signal: null, at: 'a' })
    expect(full?.last_error).toHaveLength(300)
    expect(parseSupervisorFile({ state: 'running', port: 1, last_exit: {} })).toEqual({
      state: 'running',
      port: 1,
      attempts: 0,
      updated_at: '',
      last_exit: { code: null, signal: null, at: '' },
    })
    expect(parseSupervisorFile({ state: 'dancing', port: 1 })).toBeUndefined()
    expect(parseSupervisorFile({ state: 'running' })).toBeUndefined()
    expect(parseSupervisorFile(1)).toBeUndefined()
  })
})

describe('宿主脚本与它的环境', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const runHost = (env: Record<string, string>): { status: number | null; stderr: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-host-'))
    dirs.push(dir)
    const file = join(dir, 'host.mjs')
    writeFileSync(file, HOST_SCRIPT)
    const out = spawnSync(process.execPath, [file], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 20_000,
    })
    return { status: out.status, stderr: out.stderr }
  }

  it('环境变量：密钥只经 env；proxy 全封；信任名单有才给', () => {
    const env = hostEnv({ port: 43170, dataDir: '/d', encryptionKey: 'k', adminToken: 'a' })
    expect(env).toEqual({
      AGENTSWS_OC_PORT: '43170',
      OOMOL_CONNECT_DATA_DIR: '/d',
      OOMOL_CONNECT_ENCRYPTION_KEY: 'k',
      OOMOL_CONNECT_ADMIN_TOKEN: 'a',
      OOMOL_CONNECT_BLOCKED_PROXIES: '*',
      AGENTSWS_STOP_ON_STDIN_END: '1',
    })
    expect(
      hostEnv({ port: 1, dataDir: '/d', encryptionKey: 'k', adminToken: 'a', trustedHosts: ' .x ' })
        .OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS,
    ).toBe('.x')
  })

  it('缺加密主密钥 / 管理令牌 / proxy 没封：拒绝启动（退出码 78），不去 import 上游包', () => {
    const base = hostEnv({ port: 43170, dataDir: '/d', encryptionKey: 'k', adminToken: 'a' })
    const noKey = runHost({ ...base, OOMOL_CONNECT_ENCRYPTION_KEY: '' })
    expect(noKey.status).toBe(HOST_EXIT_CONFIG)
    expect(noKey.stderr).toContain('OOMOL_CONNECT_ENCRYPTION_KEY')
    const noAdmin = runHost({ ...base, OOMOL_CONNECT_ADMIN_TOKEN: ' ' })
    expect(noAdmin.status).toBe(HOST_EXIT_CONFIG)
    const open = runHost({ ...base, OOMOL_CONNECT_BLOCKED_PROXIES: 'shopify' })
    expect(open.status).toBe(HOST_EXIT_CONFIG)
    expect(runHost({ ...base, AGENTSWS_OC_PORT: '99999' }).status).toBe(HOST_EXIT_CONFIG)
  })

  it('密钥齐了才去 import 上游包（这里没装，所以是「找不到包」而不是拒绝）', () => {
    const base = hostEnv({ port: 43170, dataDir: '/d', encryptionKey: 'k', adminToken: 'a' })
    const out = runHost(base)
    expect(out.status).not.toBe(HOST_EXIT_CONFIG)
    expect(out.stderr).toMatch(/open-connector/)
  })

  it('「起来了」那一行', () => {
    expect(HOST_READY_RE.exec('[agentsws-oc] listening on http://127.0.0.1:43170')?.[1]).toBe(
      '43170',
    )
  })
})
