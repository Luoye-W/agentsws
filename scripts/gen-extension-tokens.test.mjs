/**
 * WP456-T7：插件令牌从工作台生成——取得全、浅深两套都在、和仓库里那份一字不差、工作台改了就对不上；
 * 视觉档位守卫里插件那两道（令牌没重出、CSS 不在档位里）。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkExtension, scanCss } from './check-ui-tokens.mjs'
import {
  blockAfter,
  checkExtensionTokens,
  declarations,
  extractTokens,
  renderTokens,
  SOURCE,
  TARGET,
} from './gen-extension-tokens.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(ROOT, SOURCE), 'utf8')

describe('从工作台 index.css 取令牌', () => {
  const t = extractTokens(source)
  const names = (d) => d.map(([n]) => n)

  it('浅色带上规范 v1 新补的那几个（WP461）', () => {
    for (const n of [
      '--ws-paper',
      '--ws-card',
      '--ws-faint',
      '--ws-secondary',
      '--ws-line-strong',
      '--ws-hover',
      '--ws-pop',
      '--ws-card-edge',
      '--ws-seg-on',
      '--ws-seg-on-shadow',
      '--ws-shadow-pop',
      '--ws-display',
    ])
      expect(names(t.light)).toContain(n)
  })

  it('深色一套：深色写了的每一个浅色里都有；深色卡有细边', () => {
    expect(t.dark.length).toBeGreaterThan(30)
    for (const n of names(t.dark)) expect(names(t.light)).toContain(n)
    expect(Object.fromEntries(t.dark)['--ws-card-edge']).toMatch(/inset/u)
    expect(Object.fromEntries(t.light)['--ws-card-edge']).toBe('0 0 #0000')
  })

  it('只取 --ws-*（shadcn 那层 --background / --primary 不进插件）', () => {
    for (const [n] of [...t.light, ...t.dark]) expect(n.startsWith('--ws-')).toBe(true)
  })

  it('字体栈带微软雅黑；字号七档、圆角档位换成 --ws-text-* / --ws-lh-* / --ws-radius-*', () => {
    const fonts = Object.fromEntries(t.fonts)
    expect(fonts['--font-stack-sans']).toContain('"Microsoft YaHei"')
    const scale = Object.fromEntries(t.scale)
    expect(scale).toMatchObject({
      '--ws-text-page': '22px',
      '--ws-text-title': '16px',
      '--ws-text-read': '14px',
      '--ws-text-ui': '13px',
      '--ws-text-note': '12px',
      '--ws-text-tiny': '11px',
      '--ws-text-big': '28px',
      '--ws-lh-ui': '20px',
      '--ws-radius-tag': '6px',
      '--ws-radius-ctl': '8px',
      '--ws-radius-block': '12px',
      '--ws-radius-dialog': '20px',
    })
    expect(scale['--ws-radius-card']).toBeUndefined()
  })

  it('块按大括号配对、嵌套块里的不算', () => {
    const css = ':root {\n  --a: 1;\n  .x { --b: 2; }\n  --c: rgba(0, 0, 0, 0.1);\n}\n'
    const b = blockAfter(css, /^:root\s*\{/gmu)
    expect(declarations(b?.body ?? '')).toEqual([
      ['--a', '1'],
      ['--c', 'rgba(0, 0, 0, 0.1)'],
    ])
  })

  it('index.css 结构变了（找不到 .dark）就直说，不出半份', () => {
    expect(() => renderTokens(':root { --ws-paper: #fff; }')).toThrow(/找不到/u)
  })
})

describe('生成的 tokens.css', () => {
  const out = renderTokens(source)

  it('浅色挂 :root 和 :host，深色跟系统走', () => {
    expect(out).toContain(':root,\n:host {')
    expect(out).toContain('@media (prefers-color-scheme: dark) {\n  :root,\n  :host {')
    expect(out).toContain('color-scheme: dark;')
    expect(out).toMatch(/生成文件，别手改/u)
  })

  it('仓库里那份就是现在生成出来的（工作台改了要重出）', () => {
    expect(checkExtensionTokens(ROOT).ok).toBe(true)
    expect(readFileSync(join(ROOT, TARGET), 'utf8')).toBe(out)
  })

  it('工作台改了一个色、插件没重出 → 守卫红', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wp456t7-'))
    mkdirSync(join(tmp, dirname(SOURCE)), { recursive: true })
    mkdirSync(join(tmp, dirname(TARGET)), { recursive: true })
    writeFileSync(join(tmp, TARGET), out)
    writeFileSync(join(tmp, SOURCE), source.replace('--ws-brand: #007b67;', '--ws-brand: #007b68;'))
    expect(checkExtensionTokens(tmp).ok).toBe(false)
    expect(checkExtension(tmp).join('\n')).toMatch(/没重出/u)
    writeFileSync(join(tmp, SOURCE), source)
    expect(checkExtensionTokens(tmp).ok).toBe(true)
  })
})

describe('插件 CSS 只用档位', () => {
  const kinds = (css) => scanCss(css).map((h) => `${h.kind}:${h.token}`)

  it('档位上的数、var(--ws-*)、全圆都认', () => {
    expect(
      kinds(
        '.a { font-size: 12px; border-radius: 8px; }\n.b { font-size: var(--ws-text-ui); border-radius: 999px; }\n.c { border-radius: 0 8px 8px 0; border-top-left-radius: 50%; }',
      ),
    ).toEqual([])
  })

  it('半档字号、不在档位里的圆角、写死的颜色都挡', () => {
    expect(
      kinds('.a { font-size: 12.5px; }\n.b { border-radius: 10px; }\n.c { color: #fff; }'),
    ).toEqual(['font-size:font-size: 12.5px', 'radius:border-radius: 10px', 'color:#fff'])
  })

  it('注释里的不算', () => {
    expect(kinds('/* font-size: 15px; #abc */\n.a { font-size: 13px; }')).toEqual([])
  })

  it('仓库里插件的 CSS 现在全过', () => {
    expect(checkExtension(ROOT)).toEqual([])
  })
})
