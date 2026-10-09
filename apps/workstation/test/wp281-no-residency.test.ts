/**
 * 决策 291（WP281）：「数据不出境」整套删了——工作台上不许再出现「不出境 / 出境 / 数据驻留」。
 *
 * 工作台每一页的文字都出自 `src/`（词条、组件里的字面量）与 `docs/help/`（右栏教程文章，
 * `lib/help.ts` 打包进来），所以扫一遍这两处就覆盖了所有页面能渲染出来的静态文字；模型面板与 DeepSeek 账号卡另有渲染断言
 * （`models.test.tsx`「WP281」、`deepseek-account.test.tsx`）。
 * 服务端会端给界面的话（模型模板的步骤、报错人话）在 `apps/server/test/wp281-no-residency.test.ts`。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { translate } from '@/lib/i18n'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const HELP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'help')
const WORDS = /不出境|出境|数据驻留|data residency|residency/i

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (/\.(tsx?|css|md|json)$/.test(name)) yield path
  }
}

describe('WP281 工作台不再出现数据驻留', () => {
  it('src 下每个文件（词条、组件）与 docs/help 的教程文章都没有这几个字', () => {
    const hits: string[] = []
    for (const path of [...files(SRC), ...files(HELP)]) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (WORDS.test(line)) hits.push(`${relative(SRC, path)}:${String(i + 1)}: ${line.trim()}`)
        })
    }
    expect(hits).toEqual([])
  })

  it('原来那几条词条都删了（中英两份）', () => {
    for (const key of [
      'models.residency',
      'models.residency.cn',
      'models.residency.any',
      'models.field.region',
      'models.field.region.hint',
      'models.region.cn',
      'models.region.global',
      'dsa.region',
    ]) {
      expect(translate('zh', key)).toBe(key)
      expect(translate('en', key)).toBe(key)
    }
  })
})
