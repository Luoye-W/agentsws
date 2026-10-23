// @vitest-environment node
/**
 * WP496（决策 1739 A）守卫：这个包里**只有采集器与算法**——没有插件框架、没有界面、没有浏览器存储、没有发请求；
 * 移植来的每个文件第一行写着出处。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src')
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const files = walk(SRC).filter((f) => f.endsWith('.ts'))

describe('creator-capture 只放采集器与算法', () => {
  it('没有插件框架 / 界面 / 浏览器存储 / 发请求', () => {
    const banned = [
      /plasmo/i,
      /\bwxt\b/,
      /from ['"]react/,
      /\.tsx\b/,
      /\bchrome\.(storage|runtime|tabs)/,
      /\bfetch\(/,
      /XMLHttpRequest/,
      /localStorage|sessionStorage/,
      /kolagents\.com/,
    ]
    const offenders: string[] = []
    for (const f of files) {
      // 只查代码：注释里讲「移植时把插件存储换成了注入式」这种话不算
      const body = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      for (const re of banned) if (re.test(body)) offenders.push(`${f}（${re}）`)
    }
    expect(offenders).toEqual([])
  })

  it('移植来的文件第一行写着出处', () => {
    const ported = files.filter(
      (f) => /[/\\](kol|collectors)[/\\]/.test(f) && !f.endsWith('platformStrings.ts'),
    )
    expect(ported.length).toBeGreaterThan(30)
    for (const f of ported)
      expect(readFileSync(f, 'utf8').split('\n')[0], f).toMatch(
        /^\/\*\* 移植自 agentsws-extension `src\/[^`]+` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）/,
      )
  })
})
