/**
 * WP461（WP456 §2，决策 1446）：视觉规范 v1 的 token 与基础样式。
 *
 * - index.css 里新补的 token 浅 / 深两套都在，数和 WP456 §2.4 的表一致；
 * - 深色卡有一圈 3.5% 白细边，浅色没有；`.ws-card` 和 `shadow-ws` 都带上；
 * - 字号七档、圆角五档、阴影三层进了 Tailwind；
 * - `cn` 认得这些档位名（不把 `text-ws-tiny` 当成文字颜色扔掉）——shadcn 组件 `import { cn } from 'cn'`
 *   走的是同一份（vite alias）；
 * - Windows 上换细滚动条要看的 `<html data-os>`。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cn as bareCn } from 'cn'
import { describe, expect, it } from 'vitest'
import { applyOsAttr, osOf } from '@/lib/os-attr'
import { cn } from '@/lib/utils'

/** 直接读真 CSS（`?raw` 在 vitest 里是空串，见 brand-mark.test.tsx 的说明）。 */
const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.css'),
  'utf8',
)

/** 取 `:root {` 或 `.dark {` 那一整块。 */
function block(selector: ':root' | '.dark'): string {
  const start = CSS.indexOf(`\n${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return CSS.slice(start, CSS.indexOf('\n}', start))
}

const tokenValue = (css: string, name: string): string | undefined =>
  new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(css)?.[1]?.trim()

describe('index.css：WP456 §2.4 新补的 token，浅 / 深两套', () => {
  const light = block(':root')
  const dark = block('.dark')
  it.each([
    ['--ws-faint', '#9aa29d', '#6c756f'],
    ['--ws-line-strong', '#e1e6df', '#2e332f'],
    ['--ws-pop', '#ffffff', '#1d211e'],
    ['--ws-chart-1', '#008a6c', '#34a96a'],
    ['--ws-chart-2', '#2a78d6', '#3987e5'],
    ['--ws-chart-3', '#eb6834', '#d95926'],
    ['--ws-chart-4', '#6250d6', '#9085e9'],
  ])('%s', (name, l, d) => {
    expect(tokenValue(light, name)).toBe(l)
    expect(tokenValue(dark, name)).toBe(d)
  })
  it('悬停底色 = ink 5%（浅）/ 6%（深）', () => {
    expect(tokenValue(light, '--ws-hover')).toMatch(/var\(--ws-ink\) 5%/u)
    expect(tokenValue(dark, '--ws-hover')).toMatch(/var\(--ws-ink\) 6%/u)
  })
  it('弹层 / 弹窗阴影两套都有；弹层底色接到 shadcn 的 --popover', () => {
    for (const css of [light, dark]) {
      expect(tokenValue(css, '--ws-shadow-pop')).toBeDefined()
      expect(tokenValue(css, '--ws-shadow-dialog')).toBeDefined()
      expect(tokenValue(css, '--popover')).toBe('var(--ws-pop)')
      expect(tokenValue(css, '--input')).toBe('var(--ws-line-strong)')
    }
  })
  it('深色卡一圈 3.5% 白细边，浅色没有', () => {
    expect(tokenValue(light, '--ws-card-edge')).toBe('0 0 #0000')
    expect(tokenValue(dark, '--ws-card-edge')).toBe('inset 0 0 0 1px rgba(255, 255, 255, 0.035)')
    expect(CSS).toMatch(/\.ws-card \{[^}]*box-shadow: var\(--ws-card-edge\), var\(--ws-shadow\);/u)
    expect(CSS).toContain('--shadow-ws: var(--ws-card-edge), var(--ws-shadow);')
  })
})

describe('index.css：档位进了 Tailwind', () => {
  it('字号七档（中文最小 12，11 只给数字和英文）', () => {
    const tiers: [string, string, string][] = [
      ['ws-page', '22px', '30px'],
      ['ws-title', '16px', '24px'],
      ['ws-read', '14px', '22px'],
      ['ws-ui', '13px', '20px'],
      ['ws-note', '12px', '18px'],
      ['ws-tiny', '11px', '16px'],
      ['ws-big', '28px', '34px'],
    ]
    for (const [name, size, lh] of tiers) {
      expect(tokenValue(CSS, `--text-${name}`)).toBe(size)
      expect(tokenValue(CSS, `--text-${name}--line-height`)).toBe(lh)
    }
  })
  it('圆角五档：sm 6 / md 8 / lg 12 / xl 16，另有语义名；对话框 20', () => {
    expect(tokenValue(CSS, '--radius-sm')).toBe('6px')
    expect(tokenValue(CSS, '--radius-md')).toBe('8px')
    expect(tokenValue(CSS, '--radius-lg')).toBe('12px')
    expect(tokenValue(CSS, '--radius-xl')).toBe('16px')
    expect(tokenValue(CSS, '--radius-ws-tag')).toBe('6px')
    expect(tokenValue(CSS, '--radius-ws-ctl')).toBe('8px')
    expect(tokenValue(CSS, '--radius-ws-block')).toBe('12px')
    expect(tokenValue(CSS, '--radius-ws-dialog')).toBe('20px')
  })
  it('按钮四级的基础类都在，不能点的是 40% 透明度', () => {
    for (const c of [
      '.ws-btn',
      '.ws-btn-sm',
      '.ws-btn-primary',
      '.ws-btn-secondary',
      '.ws-btn-ghost',
      '.ws-link',
    ])
      expect(CSS).toContain(`${c} {`)
    expect(CSS).toMatch(/\.ws-btn:disabled,[^{]*\{[^}]*opacity: 0\.4;/u)
  })
  it('Windows 上细滚动条只挂在 data-os="windows" 下', () => {
    expect(CSS).toMatch(/html\[data-os="windows"\]\) \* \{[^}]*scrollbar-width: thin;/u)
  })
})

describe('cn 认得档位名', () => {
  it('字号档位和文字颜色不互相覆盖', () => {
    expect(cn('text-ws-tiny text-ws-muted-fg')).toBe('text-ws-tiny text-ws-muted-fg')
    expect(cn('text-ws-note', 'text-ws-faint')).toBe('text-ws-note text-ws-faint')
    expect(cn('text-xs', 'text-ws-title')).toBe('text-ws-title')
  })
  it('圆角、阴影档位能覆盖 Tailwind 自带的', () => {
    expect(cn('rounded-lg', 'rounded-ws-ctl')).toBe('rounded-ws-ctl')
    expect(cn('shadow-ws', 'shadow-ws-pop')).toBe('shadow-ws-pop')
  })
  it("shadcn 组件里 import { cn } from 'cn' 拿到的是同一份", () => {
    expect(bareCn('text-ws-tiny text-ws-muted-fg')).toBe('text-ws-tiny text-ws-muted-fg')
  })
})

describe('<html data-os>', () => {
  it('按 userAgent 认 Windows / Mac', () => {
    expect(osOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('windows')
    expect(osOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac')
    expect(osOf('Mozilla/5.0 (X11; Linux x86_64)')).toBe('other')
  })
  it('挂到 <html> 上', () => {
    applyOsAttr(document)
    expect(document.documentElement.dataset.os).toMatch(/^(windows|mac|other)$/u)
  })
})
