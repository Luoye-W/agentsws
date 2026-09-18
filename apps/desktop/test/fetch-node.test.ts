/**
 * WP111：`scripts/fetch-node.mjs` 的纯部分——地址怎么拼、sha256 怎么对、tar 怎么读。
 *
 * 不联网：下载那一层留给发版流水线。这里钉住的是三件会悄悄出错的事——
 * Windows 取的是 `win-x64/node.exe` 而不是 zip、锁里缺一项要当场失败（而不是放过）、
 * 锁里登记的四个平台与 `node-runtime.lock.json` 真的对得上。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkSha,
  NODE_DIST_NAME,
  nodeDownloadUrl,
  nodeExecRelPath,
  parseArgs,
  parseShasums,
  prebuildUrl,
  readLock,
  sha256,
  tarExtract,
} from '../scripts/fetch-node.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const LOCK = join(here, '..', 'node-runtime.lock.json')

describe('nodeDownloadUrl', () => {
  it('Windows 只取一个 node.exe（`SHASUMS256.txt` 里就有这一行）', () => {
    const spec = nodeDownloadUrl('22.23.2', 'win32-x64')
    expect(spec.url).toBe('https://nodejs.org/dist/v22.23.2/win-x64/node.exe')
    expect(spec.kind).toBe('exe')
    expect(spec.shasumKey).toBe('win-x64/node.exe')
  })

  it('其余平台取 tar.gz，只抽里头的 bin/node', () => {
    const spec = nodeDownloadUrl('22.23.2', 'darwin-arm64')
    expect(spec.url).toBe('https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz')
    expect(spec.member).toBe('node-v22.23.2-darwin-arm64/bin/node')
  })

  it('不认识的平台当场抛', () => {
    expect(() => nodeDownloadUrl('22.23.2', 'win32-arm64')).toThrow('不认识的平台')
  })
})

describe('nodeExecRelPath', () => {
  it('Windows 平铺 node.exe，其余在 bin/ 下', () => {
    expect(nodeExecRelPath('win32-x64')).toBe('node.exe')
    expect(nodeExecRelPath('darwin-arm64')).toBe(join('bin', 'node'))
  })
})

describe('prebuildUrl', () => {
  it('按 ABI 取 prebuild —— 捆绑 Node 22 就必须是 v127 那一份', () => {
    const pkg = { name: 'better-sqlite3', repo: 'WiseLibs/better-sqlite3' }
    expect(prebuildUrl(pkg, '12.11.1', 127, 'win32-x64')).toBe(
      'https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/' +
        'better-sqlite3-v12.11.1-node-v127-win32-x64.tar.gz',
    )
  })
})

describe('parseShasums', () => {
  it('`<sha>  <文件>` 与 `<sha>  *<文件>` 两种写法都认', () => {
    const table = parseShasums(
      `${'a'.repeat(64)}  node-v22.0.0-linux-x64.tar.gz\n${'b'.repeat(64)}  *win-x64/node.exe\n垃圾行\n`,
    )
    expect(table['node-v22.0.0-linux-x64.tar.gz']).toBe('a'.repeat(64))
    expect(table['win-x64/node.exe']).toBe('b'.repeat(64))
    expect(Object.keys(table)).toHaveLength(2)
  })
})

describe('checkSha', () => {
  it('对得上就过', () => {
    expect(() => checkSha('x', 'abc', 'abc')).not.toThrow()
  })

  it('对不上当场失败，两个值都端出来', () => {
    expect(() => checkSha('x', 'abc', 'def')).toThrow(/abc[\s\S]*def/)
  })

  it('**锁里没有这一项也是失败**——「没登记就放过」等于没有锁', () => {
    expect(() => checkSha('x', undefined, 'def')).toThrow('--write-lock')
  })
})

const scratch = mkdtempSync(join(tmpdir(), 'agentsws-fetch-node-'))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('tarExtract', () => {
  it('从**系统 tar 打出来的**包里按名字取文件（不拿自己写的头验自己写的读）', () => {
    mkdirSync(join(scratch, 'node-v1', 'bin'), { recursive: true })
    writeFileSync(join(scratch, 'node-v1', 'bin', 'node'), 'hello')
    execFileSync('tar', ['-czf', join(scratch, 't.tgz'), '-C', scratch, 'node-v1'])
    const buf = gunzipSync(readFileSync(join(scratch, 't.tgz')))
    expect(tarExtract(buf, (name) => name === 'node-v1/bin/node')?.data.toString('utf8')).toBe(
      'hello',
    )
    expect(tarExtract(buf, (name) => name === '不存在')).toBeUndefined()
  })

  it('空 / 半截的字节流不炸', () => {
    expect(tarExtract(Buffer.alloc(0), () => true)).toBeUndefined()
    expect(tarExtract(Buffer.alloc(511), () => true)).toBeUndefined()
    expect(tarExtract(Buffer.alloc(1024), () => true)).toBeUndefined()
  })
})

describe('parseArgs', () => {
  it('三个开关', () => {
    expect(parseArgs([])).toEqual({ targets: [], all: false, writeLock: false })
    expect(parseArgs(['--all', '--write-lock'])).toEqual({
      targets: [],
      all: true,
      writeLock: true,
    })
    expect(parseArgs(['--target', 'win32-x64'])).toMatchObject({ targets: ['win32-x64'] })
  })

  it('手抖的参数当场说出来，不猜', () => {
    expect(() => parseArgs(['--target'])).toThrow('--target 后面要跟平台')
    expect(() => parseArgs(['--什么'])).toThrow('不认识的参数')
  })
})

describe('node-runtime.lock.json', () => {
  const lock = readLock(LOCK)

  it('捆绑的是 Node 22 / ABI 127', () => {
    expect(lock.node.version.startsWith('22.')).toBe(true)
    expect(lock.node.abi).toBe(127)
  })

  it('四个目标平台都有 sha256（Windows x64 是第一优先）', () => {
    expect(Object.keys(lock.node.targets).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-x64',
    ])
    for (const [target, entry] of Object.entries(lock.node.targets)) {
      expect(NODE_DIST_NAME[target], target).toBeDefined()
      expect(entry.sha256, target).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('每个原生模块 × 每个版本 × 每个平台都登记了 sha256', () => {
    for (const pkg of lock.natives) {
      for (const version of pkg.versions) {
        for (const target of Object.keys(lock.node.targets)) {
          expect(pkg.sha256[`${version}/${target}`], `${pkg.name} ${version} ${target}`).toMatch(
            /^[0-9a-f]{64}$/,
          )
        }
      }
    }
  })

  it('仓库里装着的 better-sqlite3 版本，锁里都有对应的 prebuild', () => {
    const declared = new Set(
      lock.natives.flatMap((p: { name: string; versions: string[] }) =>
        p.versions.map((v) => `${p.name}@${v}`),
      ),
    )
    // 服务进程真会 dlopen 的那两份（根 12.x 与 kernel 里的 11.x）
    for (const spec of ['better-sqlite3@12.11.1', 'better-sqlite3@11.10.0'])
      expect(declared.has(spec), spec).toBe(true)
  })
})

describe('sha256', () => {
  it('就是 sha256', () => {
    expect(sha256(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
