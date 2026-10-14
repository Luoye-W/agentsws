/**
 * WP327：安装包里 npm 只带 tgz（`<resources>/node/npm-<版本>.tgz` + `npm.json`），不再带解开的 2009 个文件。
 * afterPack 的三件事：删掉漏进来的解开版、按锁校验 tgz、解到临时目录给冒烟用。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import {
  bundledNpmTarballProblem,
  removeUnpackedNpm,
  unpackNpmTarball,
} from '../scripts/after-pack.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'wp327-npm-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function tarOf(entries: { name: string; body: string }[]): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const body = Buffer.from(e.body, 'utf8')
    const h = Buffer.alloc(512)
    h.write(e.name, 0, 'utf8')
    h.write('0000644\0', 100)
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    h.write('0', 156)
    h.write('ustar\0', 257)
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

describe('afterPack：npm 只带 tgz', () => {
  const resources = join(tmp, 'resources')
  const tgz = gzipSync(
    tarOf([
      { name: 'package/package.json', body: '{"version":"10.9.8"}' },
      { name: 'package/bin/npm-cli.js', body: '// cli' },
    ]),
  )
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  const lock = { version: '10.9.8', integrity }

  it('没有 tgz / 版本不对 / sha512 不对都说得出来；对了回 undefined', () => {
    mkdirSync(join(resources, 'node'), { recursive: true })
    expect(bundledNpmTarballProblem(resources, lock)).toMatch(/没有 node\/npm.json/)
    writeFileSync(
      join(resources, 'node', 'npm.json'),
      JSON.stringify({ version: '10.9.7', integrity, file: 'npm-10.9.8.tgz' }),
    )
    expect(bundledNpmTarballProblem(resources, lock)).toMatch(/10\.9\.7/)
    writeFileSync(
      join(resources, 'node', 'npm.json'),
      JSON.stringify({ version: '10.9.8', integrity, file: 'npm-10.9.8.tgz' }),
    )
    expect(bundledNpmTarballProblem(resources, lock)).toMatch(/没有/)
    writeFileSync(join(resources, 'node', 'npm-10.9.8.tgz'), Buffer.from('tampered'))
    expect(bundledNpmTarballProblem(resources, lock)).toMatch(/校验不对/)
    writeFileSync(join(resources, 'node', 'npm-10.9.8.tgz'), tgz)
    expect(bundledNpmTarballProblem(resources, lock)).toBeUndefined()
  })

  it('解到临时目录：回 npm-cli.js 的路径', () => {
    const dest = join(tmp, 'unpacked')
    const cli = unpackNpmTarball(resources, dest)
    expect(cli).toBe(join(dest, 'package', 'bin', 'npm-cli.js'))
    expect(readFileSync(cli, 'utf8')).toBe('// cli')
  })

  it('漏进包里的解开版（两种布局）删掉，tgz 不动', () => {
    mkdirSync(join(resources, 'node', 'node_modules', 'npm', 'bin'), { recursive: true })
    writeFileSync(join(resources, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
    mkdirSync(join(resources, 'node', 'lib', 'node_modules', 'npm'), { recursive: true })
    writeFileSync(join(resources, 'node', 'lib', 'node_modules', 'npm', 'package.json'), '{}')
    expect(removeUnpackedNpm(resources)).toBe(2)
    expect(existsSync(join(resources, 'node', 'node_modules'))).toBe(false)
    expect(existsSync(join(resources, 'node', 'lib'))).toBe(false)
    expect(existsSync(join(resources, 'node', 'npm-10.9.8.tgz'))).toBe(true)
  })

  it('electron-builder.yml：npm 解开版不进包、tgz 进包、工作台的类型声明不进包', () => {
    const yml = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8')
    expect(yml).toContain("- '!node_modules/**'")
    expect(yml).toContain("- '!lib/node_modules/**'")
    expect(yml).toMatch(/from: vendor\/npm\s+to: node/)
    expect(yml).toContain("- '!types/**'")
  })
})
