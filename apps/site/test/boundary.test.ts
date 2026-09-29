/**
 * 官网只放公开页面（Luoye 09-29）：登录、账号、充值、用量、后台的页面与代码一律不进开源仓。
 * 这里钉住三件事：路由只有白名单里那几页；源码里没有表单、输入框、密码框；
 * 连 cloud.agentsws.com 的只有「链接」和构建时那一次公开价目读取。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

const files = [...walk(SRC)]
const code = files.filter((f) => /\.(astro|ts|mjs|js)$/u.test(f))

describe('只有公开页面', () => {
  it('路由白名单', () => {
    const routes = files
      .filter((f) => f.startsWith(join(SRC, 'pages')))
      .map((f) => relative(join(SRC, 'pages'), f).split('\\').join('/'))
      .sort()
    expect(routes).toEqual(
      [
        '404.astro',
        '[...locale]/changelog.astro',
        '[...locale]/docs/[slug].astro',
        '[...locale]/docs/index.astro',
        '[...locale]/download.astro',
        '[...locale]/index.astro',
        '[...locale]/pricing.astro',
        '[...locale]/privacy.astro',
        '[...locale]/refund.astro',
        '[...locale]/roles.astro',
        '[...locale]/terms.astro',
        'favicon.svg.ts',
        'robots.txt.ts',
        'sitemap.xml.ts',
      ].sort(),
    )
  })

  it('没有表单、输入框、密码框、Cookie 读写', () => {
    for (const f of code) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(
        /<form\b|<input\b|<textarea\b|type=["']password|document\.cookie/iu,
      )
    }
  })

  it('碰 cloud.agentsws.com 的只有 config.ts（链接常量）；运行时脚本不打任何网', () => {
    for (const f of code) {
      if (f.endsWith('config.ts')) continue
      expect(readFileSync(f, 'utf8'), f).not.toContain('cloud.agentsws.com')
    }
    const client = readFileSync(join(SRC, 'scripts/site.ts'), 'utf8')
    expect(client).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/u)
  })
})
