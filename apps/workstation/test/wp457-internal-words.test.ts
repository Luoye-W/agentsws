/**
 * WP457（WP456 §3.3 P0）：用户看得见的字里不出内部词。
 *
 * 改前事项页的退款卡上写着「由 stub 运行时按政策提出」——那是运行时自己往卡里塞的一句备注。
 * 这里挡两处：
 *
 * 1. 工作台的中英文案表（`tableOf`）：中文里不许有 stub / runtime / 运行时 / policy / assignment /
 *    `xxx_id` / 操作层；英文里不许有 stub / runtime / `xxx_id`（policy、assignment 在英文里是正常词）；
 * 2. 会上卡、上界面的服务端字串：按名字说运行时（「stub 运行时」「dsh 运行时」「运行时按…」）、
 *    「操作层的…」「连接器 runtime」这几种写法，在源码的字串里一处都不许再出现（注释里不管）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tableOf } from '@/lib/i18n'

const ZH_BANNED =
  /\bstub\b|runtime|运行时(?!长)|\bpolic(y|ies)\b|\bassignments?\b|\b(role|workspace|person|scope|assignment)_id\b|操作层/i
const EN_BANNED = /\bstub\b|\bruntime\b|\b(role|workspace|person|scope|assignment)_id\b/i

describe('WP457 文案表里没有内部词', () => {
  it('中文表', () => {
    const bad = Object.entries(tableOf('zh')).filter(([, v]) => ZH_BANNED.test(v))
    expect(bad).toEqual([])
  })

  it('英文表', () => {
    const bad = Object.entries(tableOf('en')).filter(([, v]) => EN_BANNED.test(v))
    expect(bad).toEqual([])
  })
})

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
/** 会把字串送上界面的那几处源码（服务端出卡、本机进程、工作台、两个插件壳、托盘）。 */
const SOURCE_DIRS = [
  'packages',
  'apps/server/src',
  'apps/cli/src',
  'apps/workstation/src',
  'apps/extension/src',
  'apps/desktop/src',
]
const SOURCE_BANNED = /(stub|dsh|direct-llm|direct)\s*运行时|运行时按|操作层的|连接器 runtime/

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test' || name.startsWith('.'))
      continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) yield path
  }
}

/** 一行里引号括起来的那几段（注释行不算）。 */
function literalsOf(line: string): string[] {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return []
  return line.match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g) ?? []
}

describe('WP457 会上界面的源码字串里没有按名字说的运行时', () => {
  it('stub / dsh / direct-llm 运行时、运行时按…、操作层的…、连接器 runtime 都不出现', () => {
    const hits: string[] = []
    for (const top of SOURCE_DIRS) {
      const base = join(ROOT, top)
      const dirs =
        top === 'packages'
          ? readdirSync(base)
              .map((p) => join(base, p, 'src'))
              .filter((p) => {
                try {
                  return statSync(p).isDirectory()
                } catch {
                  return false
                }
              })
          : [base]
      for (const dir of dirs)
        for (const file of sourceFiles(dir)) {
          const lines = readFileSync(file, 'utf8').split('\n')
          lines.forEach((line, i) => {
            for (const lit of literalsOf(line))
              if (SOURCE_BANNED.test(lit)) hits.push(`${relative(ROOT, file)}:${i + 1} ${lit}`)
          })
        }
    }
    expect(hits).toEqual([])
  })
})

describe('WP457 范围只写名字', () => {
  const t = (key: string) => (key === 'range.kind.brand' ? '整个品牌' : key)
  it('内部键不写、给了名字写名字、市场只写站点、人填的店名照写', async () => {
    const { rangeText, rangesText } = await import('@/lib/ranges')
    expect(rangeText({ kind: 'store', id: 'store_main' }, t)).toBeUndefined()
    expect(rangeText({ kind: 'product_line', id: 'pl_kitchen' }, t)).toBeUndefined()
    expect(
      rangeText(
        { kind: 'product_line', id: 'pl_kitchen' },
        t,
        new Map([['product_line:pl_kitchen', '厨房线']]),
      ),
    ).toBe('厨房线')
    expect(rangeText({ kind: 'market', id: 'amz_na:US' }, t)).toBe('US')
    expect(rangeText({ kind: 'store', id: 'NordVolt US' }, t)).toBe('NordVolt US')
    expect(rangeText({ kind: 'brand', id: 'ws_123' }, t)).toBe('整个品牌')
    expect(
      rangesText(
        [
          { kind: 'store', id: 'store_main' },
          { kind: 'store', id: 'store_eu' },
        ],
        t,
      ),
    ).toBe('')
  })
})
