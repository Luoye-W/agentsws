/**
 * WP92（55 §10）：装 `bsk`——**钉版本 + 校验 sha256**，以及 `bsk doctor` 那一步。
 *
 * 四件事各钉一条：
 * - **校验不过就什么都不装**（上游的 `install.sh` 在这种情况下只是警告，我们不接受）；
 * - 校验过了就装到数据目录下的 `bin/bsk`，**可执行**；
 * - 钉版本表与 `dsh-adapter` 里锁的插件版本**是一套**（升版本要一起升）；
 * - `bsk doctor --json` 的结果原样端出来（含"怎么修"那一句），一条 `fail` 就是没好。
 *
 * **不出网**：release 服务器是一个假 `fetch`，包是测试自己用 `tar` 打的。
 */
import { execFileSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserSkillInstallError,
  type BrowserSkillLock,
  browserSkillDoctor,
  bskPathIn,
  defaultLockPath,
  installBrowserSkillCli,
  platformKey,
  readLock,
  sha256Of,
} from '../src/browserskill-install.js'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-bsk-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 打一个真的 `.tar.gz`，里面是一个 `bsk` 脚本——假 release 服务器就发它。 */
function makeArchive(body = '#!/bin/sh\necho bsk 0.3.0\n'): { bytes: Uint8Array; sha256: string } {
  const dir = tempDir()
  writeFileSync(join(dir, 'bsk'), body, 'utf8')
  chmodSync(join(dir, 'bsk'), 0o755)
  const archive = join(dir, 'bsk.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', dir, 'bsk'])
  const bytes = new Uint8Array(readFileSync(archive))
  return { bytes, sha256: sha256Of(bytes) }
}

/** 假 release 服务器：任何 URL 都回这一份包。 */
const fetchOf = (bytes: Uint8Array, status = 200): typeof fetch =>
  (async () =>
    ({
      ok: status === 200,
      status,
      arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
    }) as unknown as Response) as unknown as typeof fetch

const lockOf = (sha256: string): BrowserSkillLock => ({
  cli: {
    version: '0.3.0',
    tag: 'cli-v0.3.0',
    assets: Object.fromEntries(
      ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'].map((k) => [
        k,
        { url: `https://example.invalid/${k}.tar.gz`, sha256 },
      ]),
    ),
  },
  plugin: { name: '@wxg-prc-cpg/browser-skill-dsh-plugin', version: '0.3.0' },
  extension: { chrome: 'https://example.invalid/chrome', edge: 'https://example.invalid/edge' },
})

describe('钉版本表', () => {
  it('仓库根那一份读得出来，五个平台都有 url + 64 位 sha256', () => {
    const path = defaultLockPath()
    expect(path).toBeDefined()
    const lock = readLock(path)
    expect(lock.cli.tag).toBe(`cli-v${lock.cli.version}`)
    for (const key of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'windows-x64']) {
      const asset = lock.cli.assets[key]
      expect(asset?.url, key).toMatch(/^https:\/\/github\.com\/Tencent\/BrowserSkill\//u)
      expect(asset?.sha256, key).toMatch(/^[0-9a-f]{64}$/u)
    }
  })

  it('CLI 与 dsh 插件是一套：lock 里的插件版本 = `dsh-adapter` 锁死的那一版', () => {
    const lock = readLock(defaultLockPath())
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(
      readFileSync(resolve(here, '../../../packages/dsh-adapter/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> }
    expect(pkg.dependencies[lock.plugin.name]).toBe(lock.plugin.version)
  })

  it('这台机器认得出自己是哪个平台（认不出就明说没有产物）', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(platformKey('linux', 'x64')).toBe('linux-x64')
    expect(platformKey('win32', 'x64')).toBe('windows-x64')
    expect(platformKey('freebsd', 'x64')).toBeUndefined()
  })
})

describe('装 bsk', () => {
  it('校验过了就装到数据目录下的 bin/bsk，而且可执行', async () => {
    const { bytes, sha256 } = makeArchive()
    const dataDir = tempDir()
    const res = await installBrowserSkillCli({
      dataDir,
      lock: lockOf(sha256),
      fetchImpl: fetchOf(bytes),
      tmpRoot: tempDir(),
    })
    expect(res.path).toBe(bskPathIn(dataDir))
    expect(res.version).toBe('0.3.0')
    expect(existsSync(res.path)).toBe(true)
    expect(() => accessSync(res.path, constants.X_OK)).not.toThrow()
    expect(readFileSync(res.path, 'utf8')).toContain('echo bsk 0.3.0')
  })

  it('**校验不过 = 一个文件都不装**（这是这个模块存在的理由）', async () => {
    const { bytes } = makeArchive()
    const dataDir = tempDir()
    const lock = lockOf('0'.repeat(64))
    await expect(
      installBrowserSkillCli({
        dataDir,
        lock,
        fetchImpl: fetchOf(bytes),
        tmpRoot: tempDir(),
      }),
    ).rejects.toThrow(/校验不过/u)
    expect(existsSync(bskPathIn(dataDir))).toBe(false)
  })

  it('下载失败就说下载失败（不装半份）', async () => {
    const { bytes, sha256 } = makeArchive()
    const dataDir = tempDir()
    await expect(
      installBrowserSkillCli({
        dataDir,
        lock: lockOf(sha256),
        fetchImpl: fetchOf(bytes, 502),
        tmpRoot: tempDir(),
      }),
    ).rejects.toBeInstanceOf(BrowserSkillInstallError)
    expect(existsSync(bskPathIn(dataDir))).toBe(false)
  })

  it('钉版本表里没有这个平台 → 明说没有产物，不去猜一个', async () => {
    const { bytes, sha256 } = makeArchive()
    const lock = lockOf(sha256)
    const key = platformKey()
    if (key !== undefined) delete lock.cli.assets[key]
    await expect(
      installBrowserSkillCli({
        dataDir: tempDir(),
        lock,
        fetchImpl: fetchOf(bytes),
        tmpRoot: tempDir(),
      }),
    ).rejects.toThrow(/平台/u)
  })
})

/** 假 `bsk`：`doctor --json` 回给定的那份 JSON，`--version` 回一行版本。 */
function fakeBsk(doctorJson: string, exitCode = 0): string {
  const dir = tempDir()
  const path = join(dir, 'bsk')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "bsk 0.3.0"; exit 0; fi',
      `cat <<'JSON'`,
      doctorJson,
      'JSON',
      `exit ${exitCode}`,
      '',
    ].join('\n'),
    'utf8',
  )
  chmodSync(path, 0o755)
  return path
}

describe('bsk doctor', () => {
  const ok = JSON.stringify([
    { name: 'bsk home writable', ok: true, status: 'ok', detail: '/home/.bsk' },
    { name: 'daemon running', ok: true, status: 'ok', detail: 'pid 1234' },
    { name: 'browser extension connected', ok: true, status: 'ok', detail: 'Chrome 152' },
  ])
  const bad = JSON.stringify([
    { name: 'daemon running', ok: true, status: 'ok', detail: 'pid 1234' },
    {
      name: 'browser extension connected',
      ok: false,
      status: 'fail',
      detail: '没有扩展连上来',
      hint: '在 Chrome 里装扩展，然后打开一个标签',
    },
  ])

  it('都过了 → ok，检查逐条端出来', async () => {
    const status = await browserSkillDoctor({ bskPath: fakeBsk(ok), allowed: true })
    expect(status.installed).toBe(true)
    expect(status.ok).toBe(true)
    expect(status.version).toBe('0.3.0')
    expect(status.checks).toHaveLength(3)
    expect(status.checks.map((c) => c.name)).toContain('browser extension connected')
  })

  it('有一条 fail → 没好，而且"怎么修"那一句照样带着（上游写的比我们编的准）', async () => {
    const status = await browserSkillDoctor({ bskPath: fakeBsk(bad, 1), allowed: true })
    expect(status.ok).toBe(false)
    expect(status.detail).toContain('没有扩展连上来')
    expect(status.checks.find((c) => c.status === 'fail')?.hint).toContain('装扩展')
  })

  it('没装 / 这一档不允许：都不去 spawn 任何东西，直接说人话', async () => {
    const missing = join(tempDir(), 'nope')
    const notInstalled = await browserSkillDoctor({ bskPath: missing, allowed: true })
    expect(notInstalled.installed).toBe(false)
    expect(notInstalled.detail).toContain('还没装')

    const blocked = await browserSkillDoctor({ bskPath: fakeBsk(ok), allowed: false })
    expect(blocked.ok).toBe(false)
    expect(blocked.detail).toContain('不在你自己的电脑上')
    expect(blocked.checks).toHaveLength(0)
  })
})
