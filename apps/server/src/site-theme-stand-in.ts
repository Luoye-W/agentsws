/**
 * WP253：主题工坊的**替身**（demo 与测试用）——不联网、不碰任何真店、不跑这台机器上的 `shopify`。
 *
 * - {@link fakeThemeBase}：在内存里造一份**最小的假 agentsws-theme 包**（十来个文件，形状照真仓库：
 *   `agentsws-theme-<commit>/` 一层目录、开头一条 pax 全局头，与 codeload 的 tar.gz 一样），连同它的钉子与 fetch。
 *   **不是**真主题的拷贝——开源仓里只放这几行占位。
 * - {@link themeCliStandIn}：进程内的假 `shopify theme …`（列 / 拉 / 检查 / 推未发布 / 发布），
 *   店里的主题只活在内存里；预览链接是店铺域名 + `?preview_theme_id=`（与 Shopify 的形状一样）。
 *   WP258：给了 `orgs` 就也认 `organization list --json` / `store list --json`（形状照 4.8.5 发行包）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { CliResult, RunCli } from './shopify-theme.js'
import type { ThemeBasePin, ThemeFetch } from './site-theme.js'

/** 假包的那几个文件（路径相对主题根）。 */
export const FAKE_THEME_FILES: Readonly<Record<string, string>> = {
  LICENSE: 'MIT License\n\nCopyright (c) 2026 agentsws (demo fixture)\n',
  'AGENTS.md':
    '# AGENTS.md (fixture)\n\nOnly edit custom-* files, templates, locales and config/settings_data.json.\n',
  'CATALOG.json': '{"sections":["hero"],"blocks":[]}\n',
  '.shopifyignore': 'docs/**\n',
  'layout/theme.liquid':
    '<!doctype html><html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>\n',
  'templates/index.json': '{"sections":{"hero":{"type":"hero","settings":{}}},"order":["hero"]}\n',
  'sections/hero.liquid':
    '<section class="hero">{{ section.settings.heading }}</section>\n{% schema %}{"name":"Hero","settings":[{"type":"text","id":"heading","label":"Heading"}]}{% endschema %}\n',
  'sections/header-group.json': '{"type":"header","name":"Header","sections":{},"order":[]}\n',
  'config/settings_schema.json': '[{"name":"theme_info","theme_name":"agentsws-theme"}]\n',
  'config/settings_data.json': '{"current":{}}\n',
  'locales/en.default.json': '{"general":{"hello":"Hello"}}\n',
  'assets/app.css': '/* build output */\n',
  'docs/README.md': 'not pushed\n',
}

/** 造一份 ustar（只够我们的解包器读：普通文件 + pax 全局头）。 */
function tarOf(entries: { name: string; body: Buffer; type?: string }[]): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const h = Buffer.alloc(512)
    h.write(e.name.slice(0, 100), 0, 'utf8')
    h.write('0000644\0', 100)
    h.write(`${e.body.length.toString(8).padStart(11, '0')}\0`, 124)
    h.write(e.type ?? '0', 156)
    h.write('ustar\0', 257)
    blocks.push(h, e.body, Buffer.alloc((512 - (e.body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/** 一份最小的假 agentsws-theme 包 + 它的钉子 + 一个只认这个网址的 fetch。 */
export function fakeThemeBase(files: Readonly<Record<string, string>> = FAKE_THEME_FILES): {
  pin: ThemeBasePin
  tgz: Buffer
  fetch: ThemeFetch
  urls: string[]
} {
  const commit = `${'0'.repeat(39)}1`
  const top = `agentsws-theme-${commit}`
  const tgz = gzipSync(
    tarOf([
      // codeload 的包开头就是一条 pax 全局头（里面写着 commit）
      { name: 'pax_global_header', body: Buffer.from(`52 comment=${commit}\n`), type: 'g' },
      ...Object.entries(files).map(([rel, body]) => ({
        name: `${top}/${rel}`,
        body: Buffer.from(body, 'utf8'),
      })),
    ]),
  )
  const pin: ThemeBasePin = {
    repo: 'Luoye-W/agentsws-theme',
    version: '0.0.0-fixture',
    commit,
    sha256: createHash('sha256').update(tgz).digest('hex'),
    license: 'MIT',
  }
  const urls: string[] = []
  const fetch: ThemeFetch = async (url) => {
    urls.push(url)
    const ok = url.endsWith(`/tar.gz/${commit}`)
    return {
      ok,
      status: ok ? 200 : 404,
      arrayBuffer: async () =>
        tgz.buffer.slice(tgz.byteOffset, tgz.byteOffset + tgz.byteLength) as ArrayBuffer,
    }
  }
  return { pin, tgz, fetch, urls }
}

interface FakeTheme {
  id: string
  name: string
  role: 'main' | 'unpublished'
  files: Record<string, string>
}

const THEME_DIRS = [
  'assets',
  'blocks',
  'config',
  'layout',
  'locales',
  'sections',
  'snippets',
  'templates',
]

function readThemeDir(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const top of THEME_DIRS) {
    const dir = join(root, top)
    if (!existsSync(dir)) continue
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const full = join(d, name)
        if (statSync(full).isDirectory()) walk(full)
        else out[relative(root, full).split(sep).join('/')] = readFileSync(full, 'utf8')
      }
    }
    walk(dir)
  }
  return out
}

/**
 * 进程内的假 `shopify theme …`。新店本来就有一份线上主题（Shopify 开店自带的那一份）。
 * `calls` 记每条命令的前两个词与参数（测试断言「没登录 / 没批之前一次 publish 都没跑」用）。
 */
/** WP258：替身账号下的一个组织与它的店。 */
export interface StandInOrg {
  id: string
  name: string
  stores: { store: string; name: string; plan: string }[]
}

export function themeCliStandIn(options: { shop?: string; orgs?: StandInOrg[] } = {}): {
  run: RunCli
  calls: string[][]
  themes: FakeTheme[]
} {
  const themes: FakeTheme[] = [
    {
      id: '100001',
      name: 'Horizon',
      role: 'main',
      files: { 'layout/theme.liquid': '<html>{{ content_for_layout }}</html>\n' },
    },
  ]
  const calls: string[][] = []
  let seq = 100001
  const shopOf = (env: Record<string, string>): string =>
    env.SHOPIFY_FLAG_STORE ?? options.shop ?? 'demo.myshopify.com'
  const out = (stdout: unknown, code = 0): CliResult => ({
    code,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr: '',
  })
  const flag = (args: readonly string[], name: string): string | undefined => {
    const i = args.indexOf(name)
    return i < 0 ? undefined : args[i + 1]
  }
  const run: RunCli = async (args, opts) => {
    calls.push([...args])
    const [top, sub] = args
    if (top === 'version') return out('4.8.5\n')
    const orgs = options.orgs
    if (top === 'organization' && sub === 'list' && orgs !== undefined)
      return out({ organizations: orgs.map((o) => ({ id: o.id, name: o.name })) })
    if (top === 'store' && sub === 'list' && orgs !== undefined) {
      const id = flag(args, '--organization-id')
      if (orgs.length === 0) return out({ stores: [] })
      const org =
        id !== undefined
          ? orgs.find((o) => o.id === id)
          : orgs.length === 1 || opts.env.CI === undefined
            ? orgs[0]
            : undefined
      if (org === undefined)
        return out('An organization ID is required to list stores non-interactively.', 1)
      return out({
        stores: org.stores.map((s) => ({
          store: s.store,
          organizationId: org.id,
          organizationName: org.name,
          name: s.name,
          plan: s.plan,
        })),
        organization: { id: org.id, name: org.name },
      })
    }
    if (top !== 'theme') return out('unknown command', 1)
    const shop = shopOf(opts.env)
    const view = (t: FakeTheme): Record<string, unknown> => ({
      id: Number(t.id),
      name: t.name,
      role: t.role,
      preview_url: `https://${shop}?preview_theme_id=${t.id}`,
    })
    if (sub === 'list')
      return out(themes.map((t) => ({ id: Number(t.id), name: t.name, role: t.role })))
    if (sub === 'check') {
      const files = readThemeDir(opts.cwd)
      const offenses = Object.entries(files)
        .filter(([, body]) => body.includes('{% broken'))
        .map(([path]) => ({
          path,
          offenses: [
            {
              check: 'LiquidHTMLSyntaxError',
              message: 'Unknown tag broken',
              severity: 0,
              start: { line: 0 },
            },
          ],
        }))
      return out(offenses, offenses.length > 0 ? 1 : 0)
    }
    if (sub === 'pull') {
      const id = flag(args, '--theme')
      const t =
        id === undefined ? themes.find((x) => x.role === 'main') : themes.find((x) => x.id === id)
      if (t === undefined) return out('Theme not found (404)', 1)
      for (const [rel, body] of Object.entries(t.files)) {
        mkdirSync(join(opts.cwd, rel, '..'), { recursive: true })
        writeFileSync(join(opts.cwd, rel), body)
      }
      return out('Pulled\n')
    }
    if (sub === 'push') {
      const files = readThemeDir(opts.cwd)
      if (args.includes('--unpublished')) {
        seq += 1
        const t: FakeTheme = {
          id: String(seq),
          name: flag(args, '--theme') ?? `Copy ${seq}`,
          role: 'unpublished',
          files,
        }
        themes.push(t)
        return out({ theme: view(t) })
      }
      const t = themes.find((x) => x.id === flag(args, '--theme'))
      if (t === undefined) return out('Theme not found (404)', 1)
      t.files = files
      return out({ theme: view(t) })
    }
    if (sub === 'publish') {
      const t = themes.find((x) => x.id === flag(args, '--theme'))
      if (t === undefined) return out('Theme not found (404)', 1)
      for (const x of themes) if (x.role === 'main') x.role = 'unpublished'
      t.role = 'main'
      return out(`${t.name} is now live\n`)
    }
    return out(`unsupported theme ${sub ?? ''}`, 1)
  }
  return { run, calls, themes }
}
