/**
 * 10-07 Windows CI：electron-builder 的 extraResources 跳过了 `vendor/node/<target>/node_modules`，
 * 随包的 npm 没进安装包。afterPack 从 vendor 补进来（`placeBundledNpm`）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bundledNpmCli, bundledNpmProblem, placeBundledNpm } from '../scripts/after-pack.mjs'

const root = mkdtempSync(join(tmpdir(), 'agentsws-npm-fallback-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function fakeNpm(dir: string, version: string): void {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'npm-cli.js'), '')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'npm', version }))
}

describe.each([
  ['win32', ['node_modules', 'npm']],
  ['darwin', ['lib', 'node_modules', 'npm']],
] as const)('placeBundledNpm（%s）', (platform, rel) => {
  it('包里没有 npm、vendor 里有：补进来，检查通过', () => {
    const resources = join(root, platform, 'missing', 'resources')
    const vendor = join(root, platform, 'missing', 'vendor')
    mkdirSync(join(resources, 'node'), { recursive: true })
    fakeNpm(join(vendor, ...rel), '10.9.8')
    expect(bundledNpmProblem(resources, platform, '10.9.8')).toMatch(/没有随包的 npm/)
    expect(placeBundledNpm(resources, platform, vendor)).toBe(true)
    expect(existsSync(bundledNpmCli(resources, platform))).toBe(true)
    expect(bundledNpmProblem(resources, platform, '10.9.8')).toBeUndefined()
  })

  it('包里已经有：不动', () => {
    const resources = join(root, platform, 'present', 'resources')
    fakeNpm(join(resources, 'node', ...rel), '10.9.8')
    expect(placeBundledNpm(resources, platform, join(root, 'nowhere'))).toBe(false)
  })

  it('vendor 里也没有：不补，留给检查报错', () => {
    const resources = join(root, platform, 'absent', 'resources')
    mkdirSync(join(resources, 'node'), { recursive: true })
    expect(placeBundledNpm(resources, platform, join(root, 'nowhere'))).toBe(false)
    expect(bundledNpmProblem(resources, platform, '10.9.8')).toMatch(/没有随包的 npm/)
  })
})
