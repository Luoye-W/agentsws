/**
 * WP254（决策 99）：npm 随安装包带。
 *
 * 钉住四件事（不联网——npm 包用系统 tar 现造一份，不去 registry 下）：
 * 1. 锁里登记了与这版 Node 配套的 npm（版本 + sha512），缺一项就当场失败；
 * 2. 摆放的位置正是服务进程 `bundledNpmCandidates` 先找的那两处（官方发行包布局）；
 * 3. 解包认长路径、拒越界路径，版本对不上就失败；
 * 4. 打包钩子：包里没有 / 版本不对都会让打包红。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { bundledNpmCli, bundledNpmProblem } from '../scripts/after-pack.mjs'
import {
  checkIntegrity,
  installNpmFiles,
  nodeExecRelPath,
  npmPackageFiles,
  npmRelDir,
  npmTarballUrl,
  readLock,
  sha512Integrity,
  tarEntries,
} from '../scripts/fetch-node.mjs'
import { bundledVersions, specialSection } from '../scripts/third-party-licenses.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const LOCK = join(here, '..', 'node-runtime.lock.json')
const root = mkdtempSync(join(tmpdir(), 'agentsws-bundled-npm-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})
let seq = 0
const scratch = (): string => {
  seq += 1
  const dir = join(root, `s${seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 用系统 tar 造一份「npm 包」tgz（`package/` 打头，带一条超过 100 字节的长路径）。 */
function fakeNpmTgz(version: string): { tgz: Buffer; longRel: string } {
  const dir = scratch()
  const pkg = join(dir, 'package')
  const longRel = `node_modules/${'very-long-dependency-name-'.repeat(4)}x/lib/index.js`
  for (const [rel, body] of [
    ['package.json', JSON.stringify({ name: 'npm', version })],
    ['bin/npm-cli.js', "#!/usr/bin/env node\nconsole.log('npm')\n"],
    [longRel, 'module.exports = 1\n'],
  ] as const) {
    mkdirSync(dirname(join(pkg, rel)), { recursive: true })
    writeFileSync(join(pkg, rel), body)
  }
  execFileSync('tar', ['-czf', join(dir, 'npm.tgz'), '-C', dir, 'package'])
  return { tgz: readFileSync(join(dir, 'npm.tgz')), longRel }
}

describe('锁里的 npm', () => {
  const lock = readLock(LOCK)

  it('登记了与 Node 22.23.2 官方配套的 npm 10.9.8，sha512 是 registry 那种写法', () => {
    expect(lock.node.version).toBe('22.23.2')
    expect(lock.npm.version).toBe('10.9.8')
    expect(lock.npm.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
    expect(lock.npm.tarball).toBe(npmTarballUrl(lock.npm.version))
    // 报告里写的体积就来自这几格
    expect(lock.npm.tarball_bytes).toBeGreaterThan(1_000_000)
    expect(lock.npm.unpacked_bytes).toBeGreaterThan(lock.npm.tarball_bytes)
  })

  it('锁里没有 integrity 或对不上 → 当场失败（不将就）', () => {
    expect(() => checkIntegrity('npm', undefined, 'sha512-x')).toThrow('--write-lock')
    expect(() => checkIntegrity('npm', 'sha512-a', 'sha512-b')).toThrow(/sha512-a[\s\S]*sha512-b/)
    const bytes = Buffer.from('abc')
    expect(() =>
      checkIntegrity('npm', sha512Integrity(bytes), sha512Integrity(bytes)),
    ).not.toThrow()
  })

  it('许可证说明里写上随包的 npm', () => {
    const versions = bundledVersions(join(here, '..'))
    expect(versions.npm).toBe('10.9.8')
    expect(specialSection([], versions)).toContain('npm v10.9.8（Artistic-2.0')
  })
})

describe('摆放位置 = 服务进程先找的那两处', () => {
  it('mac / linux：<node>/lib/node_modules/npm；Windows：<node>/node_modules/npm', () => {
    expect(npmRelDir('darwin-arm64')).toBe(join('lib', 'node_modules', 'npm'))
    expect(npmRelDir('linux-x64')).toBe(join('lib', 'node_modules', 'npm'))
    expect(npmRelDir('win32-x64')).toBe(join('node_modules', 'npm'))
  })

  it('从捆绑 node 的位置倒推，正好是 apps/server 的 bundledNpmCandidates 第一条', () => {
    // 服务进程（npm-runtime.ts）：unix = dirname(node)/../lib/node_modules/npm；win = dirname(node)/node_modules/npm
    for (const target of ['darwin-arm64', 'win32-x64']) {
      const vendor = join('/v', 'node', target)
      const nodeDir = dirname(join(vendor, nodeExecRelPath(target)))
      const serverFirst = target.startsWith('win32-')
        ? join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      expect(join(vendor, npmRelDir(target), 'bin', 'npm-cli.js')).toBe(serverFirst)
    }
  })
})

describe('解包与落位', () => {
  it('系统 tar 打的包：长路径照样解出来，落位后版本对得上', () => {
    const { tgz, longRel } = fakeNpmTgz('10.9.8')
    const files = npmPackageFiles(tgz)
    expect(files.map((f) => f.rel)).toEqual(
      expect.arrayContaining(['package.json', 'bin/npm-cli.js', longRel]),
    )
    const dest = join(scratch(), 'node', 'darwin-arm64', npmRelDir('darwin-arm64'))
    expect(installNpmFiles(files, dest, '10.9.8')).toBe(dest)
    expect(readFileSync(join(dest, ...longRel.split('/')), 'utf8')).toBe('module.exports = 1\n')
  })

  it('版本与锁不一致 → 失败', () => {
    const { tgz } = fakeNpmTgz('10.9.7')
    const dest = join(scratch(), 'npm')
    expect(() => installNpmFiles(npmPackageFiles(tgz), dest, '10.9.8')).toThrow('10.9.7')
  })

  it('越界路径整包拒绝', () => {
    const h = Buffer.alloc(512)
    h.write('package/../../evil.js', 0)
    h.write('0000644\0', 100)
    h.write(`${'0'.padStart(11, '0')}\0`, 124)
    h.write('0', 156)
    const tar = Buffer.concat([h, Buffer.alloc(1024)])
    expect(() => tarEntries(tar)).toThrow('越界')
    expect(() => npmPackageFiles(gzipSync(tar))).toThrow('越界')
  })
})

describe('打包钩子（after-pack）', () => {
  it('包里没有随包的 npm → 打包失败；版本不对 → 失败；齐了 → 没问题', () => {
    const resources = scratch()
    expect(bundledNpmProblem(resources, 'darwin', '10.9.8')).toContain('没有随包的 npm')
    const cli = bundledNpmCli(resources, 'darwin')
    expect(cli).toBe(join(resources, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    mkdirSync(dirname(cli), { recursive: true })
    writeFileSync(cli, '')
    writeFileSync(join(dirname(dirname(cli)), 'package.json'), '{"version":"10.9.7"}')
    expect(bundledNpmProblem(resources, 'darwin', '10.9.8')).toContain('10.9.7')
    writeFileSync(join(dirname(dirname(cli)), 'package.json'), '{"version":"10.9.8"}')
    expect(bundledNpmProblem(resources, 'darwin', '10.9.8')).toBeUndefined()
    expect(bundledNpmCli(resources, 'win32')).toBe(
      join(resources, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    )
  })
})
