/**
 * WP327：`scripts/bundle-app.mjs`——把打好的 `<resources>/app` 打成 bundle、写桩、删减。
 *
 * 用一棵真的临时目录（假的 node_modules：我们自己的包、dsh 那一串的包、纯第三方包、按位置读文件的包、
 * 被 `await import()` 的 CommonJS 包、带 `.node` 的原生包）跑一遍真 esbuild，再用 node 真跑打完的入口：
 * 按位置读的数据还读得到、按名字动态加载的包与静态 import 的是同一份实例、CommonJS 的具名导出还在、
 * `import.meta.main` 判断还对。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as esbuild from 'esbuild'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BANNER,
  bundleApp,
  checkSyntax,
  computedImports,
  entryNameFor,
  exportTargets,
  isBrowserFile,
  isCommonJsFile,
  literalRequires,
  packageEntryFiles,
  rewriteLocation,
  runtimeRequiredNames,
  scanSource,
  stubSource,
} from '../scripts/bundle-app.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'wp327-bundle-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function put(root: string, rel: string, text: string): void {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

describe('纯函数', () => {
  it('exports 里挑具体的 JS 目标：不要 types / 通配；./client（给浏览器的）不做入口', () => {
    expect(exportTargets({ types: './a.d.ts', default: './lib/a.js' })).toEqual(['./lib/a.js'])
    expect(exportTargets('./lib/*')).toEqual([])
    const dir = join(tmp, 'exp')
    put(dir, 'lib/index.js', 'export const a = 1\n')
    put(dir, 'lib/client.js', 'window.__ModuleLoader__.load({})\n')
    put(dir, 'lib/bin.js', '#!/usr/bin/env node\n')
    const files = packageEntryFiles(dir, {
      exports: {
        '.': { types: './x.d.ts', default: './lib/index.js' },
        './client': { default: './lib/client.js' },
        './src/*': './src/*',
      },
      bin: { x: 'lib/bin.js' },
    })
    expect(files.map((f: string) => f.slice(dir.length + 1))).toEqual([
      'lib/bin.js',
      'lib/index.js',
    ])
    expect(isBrowserFile(join(dir, 'lib/client.js'))).toBe(true)
  })

  it('改写位置：import.meta.* 换成按原位置算的常量；CJS 的 __dirname 声明一份；#! 去掉', () => {
    const esm = rewriteLocation(
      '#!/usr/bin/env node\nconst u = new URL("../x.yml", import.meta.url)\nif (import.meta.main) go()\n',
      '../node_modules/p/lib/a.js',
    )
    expect(esm).not.toContain('#!')
    expect(esm).toContain('__aw_url("../node_modules/p/lib/a.js")')
    expect(esm).toContain('new URL("../x.yml", __aw_m_url)')
    expect(esm).toContain('if (__aw_m_main)')
    const cjs = rewriteLocation(
      "const p = require('path').join(__dirname, 'w.js')\n",
      '../node_modules/q/i.js',
    )
    expect(cjs.split('\n')[0]).toBe(
      'var __dirname = __aw_dir("../node_modules/q/i.js"), __filename = __aw_file("../node_modules/q/i.js");',
    )
    // ESM 自己声明了 __dirname 的不再加一份（不然重复声明）
    const own = 'import x from "y"\nconst __dirname = dirname(fileURLToPath(import.meta.url))\n'
    expect(rewriteLocation(own, 'r.js')).not.toContain('var __dirname')
  })

  it('算出来的 import：同文件常量当字面量；方法定义不算；其余换成按原位置解析', () => {
    expect(computedImports("const SDK = '@lark/sdk'\nm = import(SDK)")).toEqual({
      computedImport: false,
      constSpecs: ['@lark/sdk'],
    })
    expect(computedImports('class A { async import(a, b) { return 1 } }').computedImport).toBe(
      false,
    )
    expect(computedImports('await import(rewrite(name))').computedImport).toBe(true)
    expect(computedImports("await import('./a.js')").computedImport).toBe(false)
    const out = rewriteLocation('class A { async import(a) { return import(a) } }', 'r.js')
    expect(out).toContain('async import(a)')
    expect(out).toContain('return __aw_import(__aw_m_url, a)')
  })

  it('运行时按名字 require 的包、CJS 文件里的字面量 require', () => {
    const code =
      "const req = createRequire(import.meta.url)\nreq('better-sqlite3')\nreq.resolve('@x/y/package.json')\nrequire.resolve('z')"
    expect(runtimeRequiredNames(code).sort()).toEqual(['@x/y', 'better-sqlite3', 'z'])
    expect(literalRequires("require('a/b'); require('./c'); require('node:fs')")).toEqual(['a'])
    expect(scanSource(code).locationAware).toBe(false)
    expect(scanSource('new URL("./w.js", import.meta.url)').urlRefs).toEqual(['./w.js'])
  })

  it('入口名、桩、banner 里没有会和被打进来的代码撞的名字', () => {
    expect(entryNameFor('/a', '/a/node_modules/@deepseek-ai/dsh/lib/bin.js')).toBe(
      'deepseek-ai__dsh__lib__bin',
    )
    expect(
      stubSource('/a/node_modules/p/lib/i.js', '/a/bundle/p.js', {
        hasDefault: true,
        hashbang: '#!/usr/bin/env node',
      }),
    ).toBe(
      '#!/usr/bin/env node\n// WP327：已打进 <resources>/app/bundle（scripts/bundle-app.mjs），这里只转过去。\nexport * from "../../../bundle/p.js";\nexport { default } from "../../../bundle/p.js";\n',
    )
    for (const line of BANNER.split('\n'))
      expect(line).toMatch(/^(import \{ \w+ as __aw_\w+ \}|const (require|__aw_\w+) =)/)
  })
})

describe('真打一遍', () => {
  const app = join(tmp, 'app')
  const nm = join(app, 'node_modules')
  const json = (o: unknown): string => `${JSON.stringify(o)}\n`

  // 服务进程：按位置读数据、静态 import 我们的 / dsh 的 / 纯第三方 / 读自己位置的 CJS 包，
  // 按名字动态加载 dsh 的包（像 cordis loader 那样），await import 一个 CJS 包拿具名导出
  put(
    nm,
    '@agentsws/server/package.json',
    json({ name: '@agentsws/server', type: 'module', exports: { '.': './dist/index.js' } }),
  )
  put(nm, '@agentsws/server/data/hello.txt', 'hello from data\n')
  put(
    nm,
    '@agentsws/server/dist/index.js',
    [
      "import { readFileSync } from 'node:fs'",
      "import { Thing } from '@deepseek-ai/thing'",
      "import pad from 'pure-pad'",
      "import { motto } from 'aware-cjs'",
      'export async function report() {',
      "  const data = readFileSync(new URL('../data/hello.txt', import.meta.url), 'utf8').trim()",
      "  const name = ['@deepseek-ai', 'thing'].join('/')",
      '  const byName = await import(name)',
      "  const { shout } = await import('dyn-cjs')",
      '  return [data, byName.Thing === Thing, pad("x"), motto(), shout("ok")].join("|")',
      '}',
      "if (import.meta.main) report().then((r) => process.stdout.write(r + '\\n'))",
      '',
    ].join('\n'),
  )
  put(
    nm,
    '@deepseek-ai/thing/package.json',
    json({
      name: '@deepseek-ai/thing',
      type: 'module',
      exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' } },
    }),
  )
  put(nm, '@deepseek-ai/thing/lib/index.js', 'export class Thing {}\n')
  put(nm, 'pure-pad/package.json', json({ name: 'pure-pad', main: 'index.js' }))
  put(nm, 'pure-pad/index.js', "module.exports = (s) => '[' + s + ']'\n")
  put(nm, 'aware-cjs/package.json', json({ name: 'aware-cjs', main: 'index.js' }))
  put(nm, 'aware-cjs/motto.txt', 'stay put')
  put(
    nm,
    'aware-cjs/index.js',
    "const fs = require('fs'); const path = require('path')\nexports.motto = () => fs.readFileSync(path.join(__dirname, 'motto.txt'), 'utf8')\n",
  )
  put(nm, 'dyn-cjs/package.json', json({ name: 'dyn-cjs', main: 'index.js' }))
  put(nm, 'dyn-cjs/index.js', 'exports.shout = (s) => s.toUpperCase()\n')
  put(nm, 'native-thing/package.json', json({ name: 'native-thing', main: 'index.js' }))
  put(nm, 'native-thing/build/Release/x.node', 'binary')
  put(nm, 'native-thing/index.js', 'module.exports = 1\n')
  put(
    app,
    'package.json',
    json({ name: '@agentsws/desktop', type: 'module', main: './dist/main.js' }),
  )

  it('打完：入口换桩、纯第三方整包删、按位置读的留着、原生包不动；跑起来结果与打包前一样', async () => {
    const before = execFileSync(process.execPath, [join(nm, '@agentsws/server/dist/index.js')], {
      encoding: 'utf8',
    })
    expect(before.trim()).toBe('hello from data|true|[x]|stay put|OK')
    const lines: string[] = []
    const out = await bundleApp({ esbuild, appDir: app, log: (l: string) => lines.push(l) })
    expect(out.plan.externals.has('native-thing')).toBe(true)
    expect(out.plan.externals.has('dyn-cjs')).toBe(true)
    expect(readFileSync(join(nm, '@agentsws/server/dist/index.js'), 'utf8')).toContain(
      'export * from "../../../../bundle/agentsws__server__dist__index.js"',
    )
    expect(existsSync(join(nm, 'pure-pad'))).toBe(false)
    expect(existsSync(join(nm, 'aware-cjs/motto.txt'))).toBe(true)
    expect(existsSync(join(nm, 'native-thing/build/Release/x.node'))).toBe(true)
    expect(existsSync(join(nm, '@agentsws/server/data/hello.txt'))).toBe(true)
    expect(checkSyntax(process.execPath, join(app, 'bundle'))).toBeGreaterThan(0)
    const after = execFileSync(process.execPath, [join(nm, '@agentsws/server/dist/index.js')], {
      encoding: 'utf8',
    })
    expect(after.trim()).toBe('hello from data|true|[x]|stay put|OK')
    expect(lines.join('\n')).toContain('bundle：')
  }, 120_000)

  it('CommonJS 判定按最近的 package.json', () => {
    expect(isCommonJsFile(join(nm, 'dyn-cjs/index.js'))).toBe(true)
    expect(isCommonJsFile(join(nm, '@deepseek-ai/thing/lib/index.js'))).toBe(false)
  })
})
