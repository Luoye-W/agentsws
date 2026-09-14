/**
 * 48 v2 L2 的第二条纪律，做成一条 lint 式测试：
 * **业务代码里禁止 `vertical === 'digital'` 这种字面比较。**
 *
 * 为什么值得一条测试：这种写法不会报错、不会红、看着还挺直白，
 * 但它会让"加第三个垂直"变成一次全仓搜索，也会让两个垂直的差异散落在几十个 if 里
 * 而不是集中在一个能被 parity guard 盯住的包里。一切差异只能走
 * `getVerticalPack(...)` 的字段。
 *
 * 扫的是**真源**（`src/**`），不是 dist；扫的范围包含消费垂直包的那几个包。
 * 唯一的豁免是 `verticals/types.ts` 与 `verticals/index.ts` ——
 * 值域校验与 registry 表本来就要写出这两个字面量。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/** 扫这几个包的 `src/`：客服共享包本身，以及三个消费它的地方。 */
const ROOTS = [
  'packages/support-core/src',
  'packages/stand-ins/src',
  'packages/runtime-direct/src',
  'apps/server/src',
]

/** 值域与 registry 本来就要写出这两个字面量。 */
const EXEMPT = ['packages/support-core/src/verticals/types.ts']

/**
 * 违规形态：拿 `goods` / `digital` 这两个字面量去做等值 / 不等值比较，
 * 或者拿它们去 switch。`getVerticalPack('goods')` 这种**取包**不算
 * （它就是在说"我要实物那一份"，不是在分支）。
 */
const PATTERNS: { re: RegExp; why: string }[] = [
  { re: /[=!]==?\s*['"`](?:goods|digital)['"`]/, why: '与垂直字面量做等值比较' },
  { re: /['"`](?:goods|digital)['"`]\s*[=!]==?/, why: '与垂直字面量做等值比较' },
  { re: /case\s+['"`](?:goods|digital)['"`]\s*:/, why: '按垂直字面量 switch' },
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

describe('lint：业务代码里不许有垂直的字面比较（48 v2 L2）', () => {
  it('src 里一处都没有', () => {
    const hits: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(join(REPO, root))) {
        const rel = relative(REPO, file)
        if (EXEMPT.includes(rel)) continue
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          // 注释里提到这条纪律本身是允许的（这个文件的文档就在这么写）
          const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
          for (const { re, why } of PATTERNS)
            if (re.test(code)) hits.push(`${rel}:${i + 1} ${why} → ${line.trim()}`)
        })
      }
    }
    expect(hits, hits.join('\n')).toEqual([])
  })

  it('扫描器本身是有效的（给它一段真违规的代码，它要认出来）', () => {
    const bad = [
      "if (vertical === 'digital') return 1",
      "const x = 'goods' === v",
      "switch (v) { case 'digital': break }",
    ]
    for (const line of bad)
      expect(
        PATTERNS.some((p) => p.re.test(line)),
        line,
      ).toBe(true)
    // 取包不算违规
    for (const ok of ["getVerticalPack('goods')", "const V = ['goods', 'digital']"])
      expect(
        PATTERNS.some((p) => p.re.test(ok)),
        ok,
      ).toBe(false)
  })
})
