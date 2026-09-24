/**
 * WP144（docs/80 §6）：装电脑操控的驱动——**钉版本 + 校验 sha256**，以及自检那一步。
 *
 * 钉住的几件事：
 * - 钉版本表与 `dsh-adapter` 里锁的两个提供方包**同一个 dsh 版本**，驱动版本是 dsh 文档引用的那一版；
 * - **校验不过就什么都不装**（目标目录一个文件都不留）；
 * - 校验过了才解到数据目录（不进 PATH），可执行文件**可执行**；
 * - 自检只调一次 `check_permissions {prompt:false}`，结果原样列出 + 怎么修；
 *   驱动起不来 / 不答话都说人话、不挂住。
 *
 * **不出网、不启动真驱动**：release 服务器是一个假 `fetch`，包是测试自己用 `tar` 打的；
 * 驱动是一个讲 MCP stdio 的 node 脚本。
 */
import { execFileSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ComputerUseInstallError,
  type ComputerUseLock,
  defaultLockPath,
  driverArgs,
  driverDirIn,
  driverPathIn,
  installCuaDriver,
  permissionRows,
  platformKey,
  readLock,
  runSelfCheck,
  selfCheckEnv,
  sha256Of,
} from '../src/computer-use-install.js'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-cua-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 打一个真的 `.tar.gz`（扁平：可执行文件在包根上，与上游 `*-binary` 包同形）。 */
function makeArchive(name = 'cua-driver', format: 'tgz' | 'zip' = 'tgz') {
  const dir = tempDir()
  const src = join(dir, 'src')
  mkdirSync(src)
  writeFileSync(join(src, name), '#!/bin/sh\necho cua-driver 0.28.0\n', 'utf8')
  chmodSync(join(src, name), 0o755)
  writeFileSync(join(src, 'cua_driver_abi.h'), '/* header */\n', 'utf8')
  const archive = join(dir, format === 'zip' ? 'd.zip' : 'd.tar.gz')
  execFileSync(
    'tar',
    format === 'zip'
      ? ['-cf', archive, '--format', 'zip', '-C', src, '.']
      : ['-czf', archive, '-C', src, '.'],
  )
  const bytes = new Uint8Array(readFileSync(archive))
  return { bytes, sha256: sha256Of(bytes) }
}

function lockFor(
  key: string,
  asset: { url: string; sha256: string; binary: string },
): ComputerUseLock {
  return {
    cli: {
      name: 'cua-driver',
      version: '0.28.0',
      tag: 'cua-driver-rs-v0.28.0',
      assets: { [key]: asset },
    },
    providers: {},
  }
}

function fakeFetch(bytes: Uint8Array, status = 200): typeof fetch {
  return (async () => new Response(status === 200 ? bytes : 'nope', { status })) as typeof fetch
}

describe('钉版本表（computer-use.lock.json）', () => {
  it('在仓库根上，驱动是 dsh 文档引用的 0.28.0，六个平台都有 sha256', () => {
    const path = defaultLockPath()
    expect(path).toBeDefined()
    const lock = readLock(path)
    expect(lock.cli.version).toBe('0.28.0')
    expect(lock.cli.tag).toBe('cua-driver-rs-v0.28.0')
    expect(Object.keys(lock.cli.assets).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'windows-arm64',
      'windows-x64',
    ])
    for (const [key, a] of Object.entries(lock.cli.assets)) {
      expect(a.sha256, key).toMatch(/^[0-9a-f]{64}$/u)
      expect(a.url, key).toContain(`/releases/download/${lock.cli.tag}/`)
      // 不是 nightly，也不是装 .app 的那种包（我们只要扁平的 -binary 包）
      expect(a.url, key).not.toContain('nightly')
      expect(a.url, key).toMatch(/-binary\.(tar\.gz|zip)$/u)
    }
  })

  it('两个提供方包与 dsh-adapter 锁的版本逐字相同（同 dsh 版本一起升）', () => {
    const lock = readLock()
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../packages/dsh-adapter/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> }
    const dsh = pkg.dependencies['@deepseek-ai/dsh']
    for (const [name, version] of Object.entries(lock.providers)) {
      expect(pkg.dependencies[name], name).toBe(version)
      expect(version, name).toBe(dsh)
    }
    // native 提供方与驱动的 npm 包**不进**依赖树
    expect(
      pkg.dependencies['@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'],
    ).toBeUndefined()
    expect(pkg.dependencies['@trycua/cua-driver']).toBeUndefined()
  })

  it('平台键与驱动参数：macOS 用 mcp --direct（权限记在启动它的应用上）', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(platformKey('win32', 'x64')).toBe('windows-x64')
    expect(platformKey('freebsd', 'x64')).toBeUndefined()
    expect(driverArgs('darwin')).toEqual(['mcp', '--direct'])
    expect(driverArgs('win32')).toEqual(['mcp'])
  })
})

describe('安装：校验不过就什么都不装', () => {
  it('sha256 对得上 → 解到数据目录，可执行', async () => {
    const data = tempDir()
    const { bytes, sha256 } = makeArchive()
    const lock = lockFor('darwin-arm64', {
      url: 'https://x.invalid/a-binary.tar.gz',
      sha256,
      binary: 'cua-driver',
    })
    const res = await installCuaDriver({
      dataDir: data,
      lock,
      fetchImpl: fakeFetch(bytes),
      platformKey: 'darwin-arm64',
    })
    expect(res.path).toBe(driverPathIn(data, lock, 'darwin-arm64'))
    expect(res.path).toBe(join(driverDirIn(data, '0.28.0'), 'cua-driver'))
    expect(() => accessSync(res.path, constants.X_OK)).not.toThrow()
    // 包里别的文件一起放着（不挑）；临时目录收干净
    expect(existsSync(join(driverDirIn(data, '0.28.0'), 'cua_driver_abi.h'))).toBe(true)
    expect(
      readdirSync(join(data, 'computer-use')).filter((n) => n.startsWith('.install-')),
    ).toEqual([])
  })

  it('sha256 对不上 → 抛错，数据目录里一个驱动文件都没有', async () => {
    const data = tempDir()
    const { bytes } = makeArchive()
    const lock = lockFor('darwin-arm64', {
      url: 'https://x.invalid/a-binary.tar.gz',
      sha256: 'a'.repeat(64),
      binary: 'cua-driver',
    })
    await expect(
      installCuaDriver({
        dataDir: data,
        lock,
        fetchImpl: fakeFetch(bytes),
        platformKey: 'darwin-arm64',
      }),
    ).rejects.toThrow(/校验不过.*没有装任何东西/u)
    expect(existsSync(driverDirIn(data, '0.28.0'))).toBe(false)
  })

  it('下载失败 / 平台不在表里 / 包里没有那个文件：都说人话，不装', async () => {
    const data = tempDir()
    const { bytes, sha256 } = makeArchive('something-else')
    const lock = lockFor('darwin-arm64', {
      url: 'https://x.invalid/a.tar.gz',
      sha256,
      binary: 'cua-driver',
    })
    await expect(
      installCuaDriver({
        dataDir: data,
        lock,
        fetchImpl: fakeFetch(bytes, 404),
        platformKey: 'darwin-arm64',
      }),
    ).rejects.toThrow(/HTTP 404/u)
    await expect(
      installCuaDriver({
        dataDir: data,
        lock,
        fetchImpl: fakeFetch(bytes),
        platformKey: 'linux-x64',
      }),
    ).rejects.toBeInstanceOf(ComputerUseInstallError)
    await expect(
      installCuaDriver({
        dataDir: data,
        lock,
        fetchImpl: fakeFetch(bytes),
        platformKey: 'darwin-arm64',
      }),
    ).rejects.toThrow(/包里没有 cua-driver/u)
    expect(existsSync(driverDirIn(data, '0.28.0'))).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('Windows 的 .zip 也用系统 tar 解（bsdtar）', async () => {
    const data = tempDir()
    const { bytes, sha256 } = makeArchive('cua-driver.exe', 'zip')
    const lock = lockFor('windows-x64', {
      url: 'https://x.invalid/w-binary.zip',
      sha256,
      binary: 'cua-driver.exe',
    })
    const res = await installCuaDriver({
      dataDir: data,
      lock,
      fetchImpl: fakeFetch(bytes),
      platformKey: 'windows-x64',
    })
    expect(existsSync(res.path)).toBe(true)
  })
})

/** 假驱动：讲 MCP stdio，只认 initialize / check_permissions；把收到的参数与环境记下来。 */
function fakeDriver(mode: 'ok' | 'exit' | 'silent'): { path: string; log: string } {
  const dir = tempDir()
  const log = join(dir, 'log.jsonl')
  const path = join(dir, 'cua-driver')
  const body =
    mode === 'exit'
      ? '#!/bin/sh\necho "boom" >&2\nexit 7\n'
      : `#!${process.execPath}
const { appendFileSync } = require('node:fs')
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), telemetry: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, update: process.env.CUA_DRIVER_RS_UPDATE_CHECK }) + '\\n')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (${JSON.stringify(mode)} === 'silent' || msg.id === undefined) continue
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
    if (msg.method === 'initialize') reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0.28.0' } })
    else if (msg.method === 'tools/call') {
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ call: msg.params.name, args: msg.params.arguments }) + '\\n')
      reply({ content: [{ type: 'text', text: '✅ Accessibility: granted.\\n❌ Screen Recording: NOT granted.' }], structuredContent: { accessibility: true, screen_recording: false, screen_recording_capturable: null, source: { attribution: 'caller' } } })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o755)
  return { path, log }
}

const logOf = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

describe('自检：check_permissions {prompt:false}，原样列出 + 怎么修', () => {
  it('只调一次 check_permissions、prompt 是 false；两个开关在驱动环境里是关的', async () => {
    const d = fakeDriver('ok')
    const out = await runSelfCheck({ driverPath: d.path, platform: 'darwin', env: selfCheckEnv() })
    const log = logOf(d.log)
    expect(log[0]).toMatchObject({ argv: ['mcp', '--direct'], telemetry: 'false', update: 'false' })
    expect(log.filter((l) => l.call !== undefined)).toEqual([
      { call: 'check_permissions', args: { prompt: false } },
    ])
    expect(out.ok).toBe(false)
    expect(out.raw).toContain('Screen Recording: NOT granted')
    expect(out.checks).toEqual([
      { name: 'accessibility', ok: true, detail: '✅ Accessibility: granted.' },
      {
        name: 'screen_recording',
        ok: false,
        detail: '❌ Screen Recording: NOT granted.',
        fix: expect.stringContaining('录屏与系统录音'),
      },
    ])
  })

  it('驱动起来就退 → ok:false，说它退了（带退出码与它的原话）', async () => {
    const d = fakeDriver('exit')
    const out = await runSelfCheck({ driverPath: d.path, platform: 'darwin' })
    expect(out.ok).toBe(false)
    expect(out.detail).toMatch(/驱动退出了/u)
  })

  it('驱动不答话 → 到点就停、ok:false，不挂住', async () => {
    const d = fakeDriver('silent')
    const out = await runSelfCheck({ driverPath: d.path, platform: 'darwin', timeoutMs: 800 })
    expect(out.ok).toBe(false)
    expect(out.detail).toMatch(/没回应/u)
  })

  it('解析：只列布尔值那几格；Windows 不补 macOS 的修法', () => {
    const rows = permissionRows(
      { accessibility: false, note: 'x' },
      'Accessibility: NOT granted',
      'win32',
    )
    expect(rows).toEqual([
      { name: 'accessibility', ok: false, detail: 'Accessibility: NOT granted' },
    ])
  })
})
