/** WP218：发版收拢——latest-mac.yml 合并、官网 downloads.json、产物结构自检、tag 规则。WP326：Mac 只出 Apple 芯片版。 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  artifactNames,
  buildDownloads,
  checkArtifacts,
  mergeUpdateInfo,
  parseTag,
  parseUpdateInfo,
  serializeUpdateInfo,
} from '../scripts/release-manifest.mjs'

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'release-manifest.mjs',
)
const root = mkdtempSync(join(tmpdir(), 'agentsws-release-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const macYml = (arch: string, date: string, version = '0.2.0-beta.1') => `version: ${version}
files:
  - url: Agents-Workshop-${version}-${arch}.dmg
    sha512: ${arch}sha==
    size: 123456
    blockMapSize: 789
path: Agents-Workshop-${version}-${arch}.dmg
sha512: ${arch}sha==
releaseDate: '${date}'
`

describe('tag 规则', () => {
  it('v1.2.3 → stable；v1.2.3-beta.4 → beta；别的拒', () => {
    expect(parseTag('v0.2.0')).toEqual({ version: '0.2.0', channel: 'stable' })
    expect(parseTag('v0.2.0-beta.3')).toEqual({ version: '0.2.0-beta.3', channel: 'beta' })
    for (const bad of ['0.2.0', 'v0.2', 'v0.2.0-rc.1', 'v0.2.0-beta', 'v0.2.0-beta.1-x'])
      expect(() => parseTag(bad), bad).toThrow(/只认/)
  })
})

describe('latest*.yml', () => {
  it('读写来回不走样', () => {
    const text = macYml('arm64', '2026-10-05T01:00:00.000Z')
    expect(serializeUpdateInfo(parseUpdateInfo(text))).toBe(text)
    expect(parseUpdateInfo(text).files[0]).toEqual({
      url: 'Agents-Workshop-0.2.0-beta.1-arm64.dmg',
      sha512: 'arm64sha==',
      size: 123456,
      blockMapSize: 789,
    })
  })

  it('几份合成一份：文件并集、顶层取第一份、日期取最晚（合并逻辑留着备用）', () => {
    const merged = mergeUpdateInfo([
      macYml('arm64', '2026-10-05T01:00:00.000Z'),
      macYml('x64', '2026-10-05T02:00:00.000Z'),
      macYml('x64', '2026-10-05T00:00:00.000Z'),
    ])
    expect(merged.files.map((f: { url: string }) => f.url)).toEqual([
      'Agents-Workshop-0.2.0-beta.1-arm64.dmg',
      'Agents-Workshop-0.2.0-beta.1-x64.dmg',
    ])
    expect(merged.path).toBe('Agents-Workshop-0.2.0-beta.1-arm64.dmg')
    expect(merged.releaseDate).toBe('2026-10-05T02:00:00.000Z')
  })

  it('版本不一致 / 一份都没有：拒', () => {
    expect(() => mergeUpdateInfo([macYml('arm64', 'x'), macYml('x64', 'y', '0.2.0')])).toThrow(
      /不一致/,
    )
    expect(() => mergeUpdateInfo([])).toThrow(/没有/)
  })

  it('没有日期的也能写', () => {
    expect(serializeUpdateInfo({ version: '1.0.0', files: [] })).toBe('version: 1.0.0\nfiles:\n')
  })
})

describe('downloads.json', () => {
  it('形状与官网那份一致；网址在渠道目录下；缺的平台 url 为 null', () => {
    const names = artifactNames('0.2.0-beta.1')
    const m = buildDownloads({
      version: '0.2.0-beta.1',
      channel: 'beta',
      base: 'https://dl.agentsws.com/',
      released: '2026-10-05',
      files: {
        [names['win-x64']]: { sha256: 'a'.repeat(64), size: 100 },
        [names['mac-arm64']]: { sha256: 'b'.repeat(64), size: 200 },
        'agents-workshop-extension-0.2.0-beta.1.zip': { sha256: 'c'.repeat(64), size: 3 },
      },
      extension: 'agents-workshop-extension-0.2.0-beta.1.zip',
    })
    expect(m.desktop.find((d: { id: string }) => d.id === 'win-x64')).toEqual({
      id: 'win-x64',
      os: 'win',
      arch: 'x64',
      file: 'Agents-Workshop-Setup-0.2.0-beta.1-x64.exe',
      url: 'https://dl.agentsws.com/beta/Agents-Workshop-Setup-0.2.0-beta.1-x64.exe',
      sha256: 'a'.repeat(64),
      size: 100,
    })
    // WP326（决策 731）：不再列 Intel
    expect(m.desktop.map((d: { id: string }) => d.id)).toEqual(['mac-arm64', 'win-x64'])
    expect(m.extension.url).toBe(
      'https://dl.agentsws.com/beta/agents-workshop-extension-0.2.0-beta.1.zip',
    )
    const site = JSON.parse(
      readFileSync(
        join(dirname(script), '..', '..', 'site', 'src', 'data', 'downloads.json'),
        'utf8',
      ),
    )
    expect(
      Object.keys(m)
        .filter((k) => k !== '$comment')
        .sort(),
    ).toEqual(
      Object.keys(site)
        .filter((k) => k !== '$comment')
        .sort(),
    )
    expect(Object.keys(m.desktop[0]).sort()).toEqual(Object.keys(site.desktop[0]).sort())
    expect(Object.keys(m.extension).sort()).toEqual(Object.keys(site.extension).sort())
  })

  it('没有插件 zip：插件那一项 url 为 null', () => {
    const m = buildDownloads({ version: '1.0.0', channel: 'stable', base: 'https://x', files: {} })
    expect(m.extension).toMatchObject({ url: null, file: 'agents-workshop-extension-1.0.0.zip' })
    expect(m.released).toBeNull()
  })
})

describe('产物结构自检', () => {
  const v = '0.2.0-beta.1'
  const names = artifactNames(v)
  const winYml = `version: ${v}\nfiles:\n  - url: ${names['win-x64']}\n    sha512: x\n    size: 1\n`
  const files: Record<string, string> = {
    [names['win-x64']]: '',
    [`${names['win-x64']}.blockmap`]: '',
    [names['mac-arm64']]: '',
    'latest.yml': winYml,
    'latest-mac.yml': serializeUpdateInfo(mergeUpdateInfo([macYml('arm64', 'a')])),
  }
  const read = (n: string) => files[n] ?? ''

  it('齐了就没问题', () => {
    expect(checkArtifacts(Object.keys(files), v, read)).toEqual([])
  })

  it('缺东西、版本对不上、latest-mac.yml 里没有 Apple 芯片包：都报出来', () => {
    expect(checkArtifacts([], v, read)).toEqual([
      `缺 Windows 安装包 ${names['win-x64']}`,
      '缺 Windows 安装包的 .blockmap（差分更新用）',
      '缺 latest.yml（Windows 应用内更新查的就是它）',
      `缺 mac-arm64 的 ${names['mac-arm64']}`,
      '缺 latest-mac.yml',
    ])
    const wrong = {
      ...files,
      'latest.yml': 'version: 9.9.9\nfiles:\n',
      'latest-mac.yml': macYml('x64', 'a', '9.9.9'),
    }
    const problems = checkArtifacts(Object.keys(wrong), v, (n) => wrong[n] ?? '')
    expect(problems).toContain('latest.yml 的版本是 9.9.9，不是 0.2.0-beta.1')
    expect(problems).toContain(`latest.yml 里没有 ${names['win-x64']}`)
    expect(problems).toContain('latest-mac.yml 的版本是 9.9.9，不是 0.2.0-beta.1')
    expect(problems).toContain(`latest-mac.yml 里没有 ${names['mac-arm64']}`)
  })

  it('WP326：Intel 包不再要求；latest-mac.yml 里混进 Intel 包算毛病', () => {
    expect(Object.keys(names)).toEqual(['mac-arm64', 'win-x64'])
    const mixed = {
      ...files,
      'latest-mac.yml': serializeUpdateInfo(
        mergeUpdateInfo([macYml('arm64', 'a'), macYml('x64', 'b')]),
      ),
    }
    expect(checkArtifacts(Object.keys(mixed), v, (n) => mixed[n] ?? '')).toEqual([
      'latest-mac.yml 里有不是 Apple 芯片的包（Mac 只出 Apple 芯片版）：Agents-Workshop-0.2.0-beta.1-x64.dmg',
    ])
  })
})

describe('命令行（真跑脚本）', () => {
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' })

  it('merge-mac / check / downloads / tag 一条龙', () => {
    const v = '0.2.0-beta.1'
    const names = artifactNames(v)
    const dir = join(root, 'out')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(root, 'a.yml'), macYml('arm64', 'a'))
    run('merge-mac', '--out', join(dir, 'latest-mac.yml'), join(root, 'a.yml'))
    for (const n of [names['win-x64'], `${names['win-x64']}.blockmap`, names['mac-arm64']])
      writeFileSync(join(dir, n), 'bin')
    writeFileSync(
      join(dir, 'latest.yml'),
      `version: ${v}\nfiles:\n  - url: ${names['win-x64']}\n    sha512: x\n    size: 3\n`,
    )
    expect(run('check', '--dir', dir, '--version', v)).toContain('没问题')
    run(
      'downloads',
      '--dir',
      dir,
      '--version',
      v,
      '--base',
      'https://dl.agentsws.com',
      '--out',
      join(root, 'downloads.json'),
    )
    const m = JSON.parse(readFileSync(join(root, 'downloads.json'), 'utf8'))
    expect(m.channel).toBe('beta')
    expect(m.desktop[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(m.desktop[0].size).toBe(3)
    expect(run('tag', 'v1.0.0')).toBe('version=1.0.0\nchannel=stable\n')
    expect(() => run('check', '--dir', root, '--version', v)).toThrow()
    expect(() => run('nope')).toThrow()
  })
})

describe('WP326（决策 731）：发版流水线不再打 Intel 版', () => {
  it('release.yml 里没有 Intel mac 作业；收拢只认 arm64 那一份 latest-mac', () => {
    const yml = readFileSync(
      join(dirname(script), '..', '..', '..', '.github', 'workflows', 'release.yml'),
      'utf8',
    )
    expect(yml).not.toMatch(/macos-15-intel|--mac --x64|target: darwin-x64/)
    expect(yml).toContain('target: darwin-arm64')
    expect(yml).toContain(
      'merge-mac --out artifacts/latest-mac.yml artifacts/latest-mac-darwin-arm64.yml',
    )
  })
})
