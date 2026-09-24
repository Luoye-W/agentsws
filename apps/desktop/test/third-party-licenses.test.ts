/**
 * WP148：安装包里的第三方许可证说明（`scripts/third-party-licenses.mjs`）。
 *
 * 与 `after-pack.test.ts` 同一个理由值得测：它只在打包那一刻跑，错了不会红在别处。
 * 这里拿一份假的 `pnpm licenses list --json` + 真的临时目录跑一遍，**不调 pnpm、不联网**。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ELECTRON_DIST_LICENSES,
  stashDirOf,
  stashElectronLicenses,
} from '../scripts/after-extract.mjs'
import { copyElectronLicenses, LICENSES_DIR } from '../scripts/after-pack.mjs'
import {
  findNativeBinaries,
  flattenLicenses,
  licenseTextOf,
  NOTICE_FILE,
  readmeLicenseSection,
  renderNotice,
  uncoveredNatives,
  writeNotice,
} from '../scripts/third-party-licenses.mjs'

const root = mkdtempSync(join(tmpdir(), 'agentsws-licenses-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function pkg(dir: string, meta: Record<string, unknown>, files: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(meta))
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  return dir
}

const LIBVIPS_README = `# \`@img/sharp-libvips-darwin-arm64\`

Prebuilt libvips.

## Licensing

| Library | Used under the terms of |
|---|---|
| libvips | LGPLv3 |

## Something else

not this
`

const store = join(root, 'store')
const MIT = pkg(join(store, 'left-pad'), { name: 'left-pad' }, { LICENSE: 'MIT License\nleft-pad' })
const VIPS = pkg(
  join(store, 'libvips'),
  { name: '@img/sharp-libvips-darwin-arm64' },
  { 'README.md': LIBVIPS_README, 'versions.json': JSON.stringify({ vips: '8.18.6' }) },
)
const BARE = pkg(join(store, 'bare'), { name: 'bare' })

/** `pnpm licenses list --json` 的形状：许可证 → 包[]。 */
const PNPM_JSON = {
  MIT: [
    {
      name: 'left-pad',
      versions: ['1.0.0', '1.3.0'],
      paths: [MIT, MIT],
      license: 'MIT',
      homepage: 'https://example.invalid/left-pad',
    },
    { name: 'bare', versions: ['0.1.0'], paths: [BARE], license: 'MIT', author: 'Someone' },
  ],
  'LGPL-3.0-or-later': [
    {
      name: '@img/sharp-libvips-darwin-arm64',
      versions: ['1.3.3'],
      paths: [VIPS],
      license: 'LGPL-3.0-or-later',
    },
  ],
  'Apache-2.0': [
    { name: '@agentsws/server', versions: ['0.0.0'], paths: [store], license: 'Apache-2.0' },
    { name: 'sharp', versions: ['0.35.4'], paths: [BARE], license: 'Apache-2.0' },
  ],
}

describe('清单：来自 pnpm licenses list，自己的包不列', () => {
  it('摊平成一版一条、按名字排序；@agentsws/* 不进第三方清单', () => {
    const rows = flattenLicenses(PNPM_JSON)
    expect(rows.map((r) => `${r.name}@${r.version}`)).toEqual([
      '@img/sharp-libvips-darwin-arm64@1.3.3',
      'bare@0.1.0',
      'left-pad@1.0.0',
      'left-pad@1.3.0',
      'sharp@0.35.4',
    ])
    expect(rows.find((r) => r.name === 'bare')?.author).toBe('Someone')
  })
})

describe('许可证原文', () => {
  it('有 LICENSE 就用 LICENSE', () => {
    expect(licenseTextOf(MIT)).toBe('MIT License\nleft-pad')
  })

  it('没有 LICENSE 退到 README 的 Licensing 一节（libvips 的预编译包就是这样）', () => {
    const text = licenseTextOf(VIPS)
    expect(text).toContain('## Licensing')
    expect(text).toContain('LGPLv3')
    expect(text).not.toContain('Something else')
    expect(readmeLicenseSection('# x\n\nno section')).toBeUndefined()
  })

  it('两样都没有：undefined（正文里按 package.json 标的许可证名称说一句）', () => {
    expect(licenseTextOf(BARE)).toBeUndefined()
    expect(licenseTextOf(undefined)).toBeUndefined()
    expect(licenseTextOf(join(root, 'nope'))).toBeUndefined()
  })
})

describe('成文', () => {
  const text = renderNotice(flattenLicenses(PNPM_JSON), { node: '22.23.2', electron: '44.3.0' })

  it('第一节把 libvips（LGPL，动态库形态）、Chromium / Electron、捆绑的 Node 说清楚', () => {
    expect(text).toContain('LGPL-3.0-or-later')
    expect(text).toContain('动态链接库')
    expect(text).toContain('@img/sharp-libvips-darwin-arm64@1.3.3（libvips 8.18.6）')
    expect(text).toContain('https://www.gnu.org/licenses/lgpl-3.0.txt')
    expect(text).toContain('https://github.com/libvips/libvips')
    expect(text).toContain('Electron 44.3.0')
    expect(text).toContain('LICENSES.chromium.html')
    expect(text).toContain('Node.js v22.23.2')
    expect(text).toContain('https://github.com/nodejs/node/blob/v22.23.2/LICENSE')
  })

  it('第二节按许可证汇总；第三节逐个包，同名同文只印一次', () => {
    expect(text).toContain('MIT（2）：bare, left-pad')
    expect(text).toContain('LGPL-3.0-or-later（1）：@img/sharp-libvips-darwin-arm64')
    expect(text).toContain('left-pad@1.0.0  —  MIT  —  https://example.invalid/left-pad')
    expect(text).toContain('（同上）')
    expect(text).toContain('按它 package.json 标的 MIT 使用；作者：Someone')
    expect(text).not.toContain('@agentsws/server')
  })

  it('没有 libvips 的那一次也照实说', () => {
    expect(renderNotice([], {})).toContain('这一次打包的依赖里没有 libvips')
  })
})

describe('打包后的 app 里真带着的原生二进制', () => {
  const app = join(root, 'app', 'node_modules')
  pkg(
    join(app, '@img', 'sharp-libvips-darwin-arm64'),
    { name: '@img/sharp-libvips-darwin-arm64' },
    {
      'lib/libvips-cpp.8.18.6.dylib': 'x',
    },
  )
  pkg(
    join(app, 'better-sqlite3'),
    { name: 'better-sqlite3' },
    {
      'build/Release/better_sqlite3.node': 'x',
      'lib/index.js': '',
    },
  )
  pkg(join(app, 'mystery'), { name: 'mystery' }, { 'bin/libfoo.so.1': 'x' })
  pkg(join(app, 'plain'), { name: 'plain' }, { 'index.js': '' })
  // pnpm 那种软链不跟（打包后的目录里是实拷贝；软链会把同一个包数两遍）
  symlinkSync(join(app, 'mystery'), join(app, 'linked'))

  it('按包列出 .node / 动态库；认包按最近的 package.json', () => {
    expect(findNativeBinaries(app)).toEqual([
      {
        pkg: '@img/sharp-libvips-darwin-arm64',
        files: ['@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.6.dylib'],
      },
      { pkg: 'better-sqlite3', files: ['better-sqlite3/build/Release/better_sqlite3.node'] },
      { pkg: 'mystery', files: ['mystery/bin/libfoo.so.1'] },
    ])
  })

  it('带原生二进制却不在清单里的包会被点名（打包时据此失败）', () => {
    const rows = flattenLicenses(PNPM_JSON)
    expect(uncoveredNatives(findNativeBinaries(app), rows)).toEqual(['better-sqlite3', 'mystery'])
  })

  it('写盘：第一节多出「原生二进制」那一段，回报漏掉的包', () => {
    const out = join(root, 'out', 'licenses', NOTICE_FILE)
    const natives = findNativeBinaries(app)
    const r = writeNotice(out, { json: PNPM_JSON, versions: {}, natives })
    const body = readFileSync(out, 'utf8')
    expect(body).toContain('5. 安装包里带原生二进制')
    expect(body).toContain(
      'app/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.6.dylib',
    )
    expect(r).toMatchObject({
      packages: 4,
      libvips: ['@img/sharp-libvips-darwin-arm64'],
      uncovered: ['better-sqlite3', 'mystery'],
    })
  })
})

describe('Electron / Chromium 自带的两份许可证', () => {
  it('afterExtract 存一份（mac 上之后会被丢掉），afterPack 拷进 licenses/，LICENSE 改名', () => {
    const out = join(root, 'release', 'mac-arm64')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'LICENSE'), 'Copyright (c) Electron contributors')
    writeFileSync(join(out, 'LICENSES.chromium.html'), '<html>chromium</html>')
    expect(stashElectronLicenses(out)).toEqual(ELECTRON_DIST_LICENSES)
    const stash = stashDirOf(out)
    expect(stash).toBe(join(root, 'release', '.electron-licenses', 'mac-arm64'))
    // electron-builder 在 mac 上把根目录那两份丢掉之后
    rmSync(join(out, 'LICENSE'))
    rmSync(join(out, 'LICENSES.chromium.html'))
    const licenses = join(out, 'agentsws.app', 'Contents', 'Resources', LICENSES_DIR)
    expect(copyElectronLicenses([stash, out], licenses)).toEqual([
      'LICENSE.electron.txt',
      'LICENSES.chromium.html',
    ])
    expect(readFileSync(join(licenses, 'LICENSE.electron.txt'), 'utf8')).toContain('Electron')
  })

  it('win / linux：electron-builder 留在根目录的 LICENSE.electron.txt 直接用；哪儿都没有就回空', () => {
    const out = join(root, 'release', 'win-unpacked')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'LICENSE.electron.txt'), 'electron')
    expect(stashElectronLicenses(out)).toEqual([])
    const licenses = join(out, 'resources', LICENSES_DIR)
    expect(copyElectronLicenses([stashDirOf(out), out], licenses)).toEqual(['LICENSE.electron.txt'])
    expect(copyElectronLicenses([join(root, 'nowhere')], join(root, 'empty'))).toEqual([])
  })
})
