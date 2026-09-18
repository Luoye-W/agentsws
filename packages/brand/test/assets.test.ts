/**
 * 仓库门面上的那几张 SVG 有没有跟这个包走散。
 *
 * `docs/assets/brand/*.svg` 与 README 顶上那一张都是
 * `scripts/gen-brand-assets.py` 从这个包出的。只重跑一半、或者有人手改了其中一张，
 * 门面上挂的就是上一版的标记——而门面恰恰是最不容易有人去核的地方。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BRAND_MARK_SVG_DARK, BRAND_MARK_SVG_LIGHT, BRAND_MARK_SVG_MONO } from '../src/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('docs/assets/brand', () => {
  it('三张 SVG 与包里那三个常量逐字节相同（尾一个换行）', () => {
    expect(read('docs/assets/brand/mark-dark.svg')).toBe(`${BRAND_MARK_SVG_DARK}\n`)
    expect(read('docs/assets/brand/mark-light.svg')).toBe(`${BRAND_MARK_SVG_LIGHT}\n`)
    expect(read('docs/assets/brand/mark-mono.svg')).toBe(`${BRAND_MARK_SVG_MONO}\n`)
  })

  it('说明文件把真源指回母品牌规范', () => {
    const doc = read('docs/assets/brand/README.md')
    expect(doc).toContain('品牌设计规范-v2.md')
    expect(doc).toContain('几何改动回那边改')
    expect(doc).toContain('scripts/gen-brand-assets.py')
  })
})

describe('README 顶上那一张', () => {
  it('深浅两版走 `<picture>`：GitHub 两种主题下各取各的', () => {
    const readme = read('README.md')
    expect(readme).toContain('<picture>')
    expect(readme).toContain('media="(prefers-color-scheme: dark)"')
    expect(readme).toContain('docs/assets/brand/mark-dark.svg')
    expect(readme).toContain('docs/assets/brand/mark-light.svg')
    // 标记出现在第一行之前——它是门面，不是正文里的插图
    expect(readme.indexOf('<picture>')).toBeLessThan(readme.indexOf('# agentsws'))
  })
})

describe('scripts/gen-brand-assets.py', () => {
  it('几何一个数字都不在脚本里定义：它从这个包的 dist 里读', () => {
    const script = read('scripts/gen-brand-assets.py')
    expect(script).toContain('packages/brand/dist/index.js')
    // 六块的坐标不许在脚本里再抄一遍
    expect(script).not.toMatch(/\(\s*14\s*,\s*44\s*\)/)
    expect(script).not.toMatch(/\(\s*62\s*,\s*12\s*\)/)
  })

  it('托盘那两张走单色：22 / 44 都在规范的 28px 线以下', () => {
    const script = read('scripts/gen-brand-assets.py')
    expect(script).toContain('trayTemplate.png')
    expect(script).toMatch(/trayTemplate\.png"?,\s*22,.*solid=\(0, 0, 0\)/s)
  })
})
