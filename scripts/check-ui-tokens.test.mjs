/**
 * WP461：视觉档位守卫——字号 / 圆角 / 原色哪些算在档位里、注释不算、豁免清单只挡新出现的、`--update` 只减不增。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  compare,
  countAll,
  radiusOk,
  readBaseline,
  scanSource,
  stripComments,
  textSizeOk,
  tighten,
} from './check-ui-tokens.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const tokens = (src, c) => scanSource(src)[c].map((h) => h.token)

describe('字号', () => {
  it('七档里的写法都认', () => {
    for (const v of [
      'xs',
      'sm',
      'base',
      'ws-page',
      'ws-title',
      'ws-read',
      'ws-ui',
      'ws-note',
      'ws-tiny',
      'ws-big',
    ])
      expect(textSizeOk(v)).toBe(true)
    for (const v of ['[12px]', '[13px]', '[14px]', '[16px]', '[22px]', '[28px]', '[0.8125rem]'])
      expect(textSizeOk(v)).toBe(true)
  })
  it('不在档位里的：11px 中文那种、半档、lg / 2xl', () => {
    for (const v of ['[11px]', '[12.5px]', '[10.5px]', '[15px]', 'lg', 'xl', '2xl', '[0.92em]'])
      expect(textSizeOk(v)).toBe(false)
  })
  it('文字颜色、对齐这些 text-* 不是字号，不管', () => {
    for (const v of [
      'ws-muted-fg',
      'ws-warn',
      'center',
      'muted-foreground',
      '[var(--ws-ink)]',
      '[#fff]',
    ])
      expect(textSizeOk(v)).toBeUndefined()
  })
  it('带前缀的变体也查', () => {
    expect(tokens('<p className="md:text-[11px] hover:text-lg text-xs">', 'font-size')).toEqual([
      'text-[11px]',
      'text-lg',
    ])
  })
})

describe('圆角', () => {
  it('五档 + 全圆都认', () => {
    for (const [parts, arb] of [
      ['-sm'],
      ['-md'],
      ['-lg'],
      ['-xl'],
      ['-2xl'],
      ['-full'],
      ['-none'],
      ['-ws-card'],
      ['-ws-dialog'],
      ['-t-xl'],
      ['', '[8px]'],
      ['-b', '[16px]'],
    ])
      expect(radiusOk(parts, arb)).toBe(true)
  })
  it('光写 rounded（4px）、10px、3xl 不在档位里', () => {
    expect(radiusOk('', undefined)).toBe(false)
    expect(radiusOk('-t', undefined)).toBe(false)
    expect(radiusOk('', '[10px]')).toBe(false)
    expect(radiusOk('-3xl', undefined)).toBe(false)
    expect(tokens('<i className="rounded px-1 rounded-[10px] rounded-md">', 'radius')).toEqual([
      'rounded',
      'rounded-[10px]',
    ])
  })
})

describe('原色', () => {
  it('Tailwind 色板与写死的十六进制都算', () => {
    expect(
      tokens(
        "cn('bg-amber-500/10 text-emerald-700 dark:text-amber-400', 'border-l-red-300 bg-[#1a1e24]')",
        'color',
      ),
    ).toEqual([
      'bg-amber-500/10',
      'text-emerald-700',
      'text-amber-400',
      'border-l-red-300',
      'bg-[#1a1e24]',
    ])
  })
  it('token 写法不算', () => {
    expect(tokens('"bg-ws-warn-bg text-ws-good border-ws-warn/40 bg-primary"', 'color')).toEqual([])
  })
})

describe('注释不查', () => {
  it('块注释、JSX 注释、行注释里的写法都不算；网址里的 // 不当注释', () => {
    const src = [
      '/** 别再写 `bg-emerald-50` */',
      '{/* text-[11px] 旧写法 */}',
      'const a = 1 // rounded-[10px]',
      "const u = 'https://x.example/rounded'",
      '<b className="text-[11px]" />',
    ].join('\n')
    expect(stripComments(src).split('\n')).toHaveLength(5)
    const found = scanSource(src)
    expect(found.color).toEqual([])
    expect(found.radius).toEqual([])
    expect(found['font-size']).toEqual([{ line: 5, token: 'text-[11px]' }])
  })
})

describe('豁免清单', () => {
  it('只挡比清单多出来的；少了只提示能收紧', () => {
    const baseline = { 'a.tsx': { radius: 2 }, 'b.tsx': { 'font-size': 1 } }
    const counts = { 'a.tsx': { radius: 3 }, 'c.tsx': { color: 1 } }
    const { over, under } = compare(baseline, counts)
    expect(over).toEqual([
      { file: 'a.tsx', category: 'radius', allowed: 2, now: 3 },
      { file: 'c.tsx', category: 'color', allowed: 0, now: 1 },
    ])
    expect(under).toEqual([{ file: 'b.tsx', category: 'font-size', allowed: 1, now: 0 }])
  })
  it('--update 只减不增：不放宽、不收新文件', () => {
    const baseline = { 'a.tsx': { radius: 2, color: 1 }, 'b.tsx': { 'font-size': 1 } }
    const counts = { 'a.tsx': { radius: 5 }, 'c.tsx': { color: 4 } }
    expect(tighten(baseline, counts)).toEqual({ 'a.tsx': { radius: 2 } })
  })
  it('仓库现状和清单对得上（没有新出现的），而且没有 Tailwind 色板原色', () => {
    const baseline = readBaseline(join(ROOT, 'scripts/ui-tokens-baseline.json'))
    const { counts, hits } = countAll(ROOT)
    expect(compare(baseline, counts).over).toEqual([])
    const palette = Object.values(hits).flatMap((h) =>
      h.color.filter((x) => !x.token.includes('[#')).map((x) => x.token),
    )
    expect(palette).toEqual([])
  })
  it('清单文件是排好序的 JSON，带说明', () => {
    const raw = JSON.parse(readFileSync(join(ROOT, 'scripts/ui-tokens-baseline.json'), 'utf8'))
    expect(raw.$comment).toMatch(/只减不增/u)
    const keys = Object.keys(raw.files)
    expect(keys).toEqual([...keys].sort())
  })
})
