/**
 * WP253 → WP301：主题工坊的**替身**（demo 与测试用）——不联网、不碰任何真店、不跑这台机器上的 `shopify`。
 *
 * - {@link FAKE_HORIZON_FILES}：一份**手写的、照 Horizon 形状造的**最小主题（十几个文件：`theme_info` 写 Horizon、
 *   分区 / 块的 schema 用 `@theme` / `@app` / `_` 私有块 / 预设里的静态块，模板开头带 Shopify 的那段注释头）。
 *   **不是** Horizon 的拷贝：Horizon 的许可不允许把它（或由它衍生的主题）拿去分发，开源仓里只放这几行占位。
 * - {@link FAKE_LEGACY_THEME_FILES}：旧的自带主题（agentsws-theme）起底的工作目录长什么样（造「v0.10 留下来的那一份」）。
 * - {@link themeCliStandIn}：进程内的假 `shopify theme …`（列 / 拉（含 `--only` / `--path`）/ 复制 / 改名 / 检查 /
 *   推未发布 / 发布），店里的主题只活在内存里；预览链接是店铺域名 + `?preview_theme_id=`（与 Shopify 的形状一样）。
 *   WP258：给了 `orgs` 就也认 `organization list --json` / `store list --json`（形状照 4.8.5 发行包）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { CliResult, RunCli } from './shopify-theme.js'

const schema = (body: string, json: unknown): string =>
  `${body}\n{% schema %}\n${JSON.stringify(json, null, 2)}\n{% endschema %}\n`

/** Shopify 自动生成的 JSON 模板开头那段注释（我们的读法要能跳过它）。 */
const TEMPLATE_HEADER = '/*\n * fixture: auto-generated header, like the theme editor writes\n */\n'

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`

/** 手写的 Horizon 形状的假主题（路径相对主题根）。 */
export const FAKE_HORIZON_FILES: Readonly<Record<string, string>> = {
  'config/settings_schema.json': json([
    {
      name: 'theme_info',
      theme_name: 'Horizon',
      theme_version: '9.9.9-fixture',
      theme_author: 'Shopify',
    },
    {
      name: 't:names.colors',
      settings: [
        { type: 'color', id: 'color_accent', label: 't:settings.accent', default: '#000000' },
      ],
    },
    {
      name: 't:names.typography',
      settings: [
        {
          type: 'font_picker',
          id: 'type_heading_font',
          label: 't:settings.heading_font',
          default: 'inter_n7',
        },
      ],
    },
  ]),
  'config/settings_data.json': '{"current":{"color_accent":"#000000"}}\n',
  'locales/en.default.json': '{"general":{"cart":"Cart"}}\n',
  'locales/en.default.schema.json': json({
    names: {
      hero: 'Hero',
      section: 'Section',
      text: 'Text',
      button: 'Button',
      group: 'Group',
      divider: 'Divider',
      heading: 'Heading',
      colors: 'Colors',
      typography: 'Typography',
      header: 'Header',
      footer: 'Footer',
      product_grid: 'Product grid',
    },
    categories: { banners: 'Banners', layout: 'Layout', basic: 'Basic', products: 'Products' },
    settings: {
      accent: 'Accent',
      heading_font: 'Heading font',
      text: 'Text',
      label: 'Label',
      link: 'Link',
      height: 'Height',
      small: 'Small',
      large: 'Large',
      collection: 'Collection',
      direction: 'Direction',
      thickness: 'Thickness',
    },
  }),
  'layout/theme.liquid':
    '<!doctype html><html><head>{{ content_for_header }}</head><body>{% sections "header-group" %}{{ content_for_layout }}{% sections "footer-group" %}</body></html>\n',
  'assets/base.css': ':root { --fixture: 1; }\n',
  'sections/hero.liquid': schema(
    '<section class="hero">{% content_for "block", type: "_heading", id: "heading" %}{% content_for "blocks" %}</section>',
    {
      name: 't:names.hero',
      tag: 'section',
      blocks: [{ type: '@theme' }, { type: '_heading' }],
      settings: [
        {
          type: 'select',
          id: 'height',
          label: 't:settings.height',
          options: [
            { value: 'small', label: 't:settings.small' },
            { value: 'large', label: 't:settings.large' },
          ],
          default: 'large',
        },
        { type: 'image_picker', id: 'image', label: 'Image' },
      ],
      presets: [
        {
          name: 't:names.hero',
          category: 't:categories.banners',
          blocks: {
            heading: { type: '_heading', static: true, settings: { text: 'Welcome' } },
            text_1: { type: 'text', settings: { text: '<p>Hello</p>' } },
          },
          block_order: ['text_1'],
        },
      ],
    },
  ),
  'sections/section.liquid': schema('<div class="section">{% content_for "blocks" %}</div>', {
    name: 't:names.section',
    blocks: [{ type: '@theme' }, { type: '@app' }, { type: '_divider' }],
    settings: [
      { type: 'header', content: 'Layout' },
      {
        type: 'select',
        id: 'section_height',
        label: 't:settings.height',
        options: [{ value: 'small' }, { value: 'large' }],
        default: 'small',
      },
    ],
    presets: [{ name: 't:names.section', category: 't:categories.layout' }],
  }),
  'sections/product-list.liquid': schema('<div class="products">{% content_for "blocks" %}</div>', {
    name: 't:names.product_grid',
    blocks: [{ type: '@theme' }],
    settings: [{ type: 'collection', id: 'collection', label: 't:settings.collection' }],
    presets: [{ name: 't:names.product_grid', category: 't:categories.products' }],
  }),
  'sections/header.liquid': schema('<header>{{ shop.name }}</header>', {
    name: 't:names.header',
    enabled_on: { groups: ['header'] },
    settings: [],
  }),
  'sections/footer.liquid': schema('<footer>{{ shop.name }}</footer>', {
    name: 't:names.footer',
    enabled_on: { groups: ['footer'] },
    settings: [],
  }),
  'sections/header-group.json': `${TEMPLATE_HEADER}{"type":"header","name":"Header group","sections":{"header":{"type":"header","settings":{}}},"order":["header"]}\n`,
  'sections/footer-group.json': `${TEMPLATE_HEADER}{"type":"footer","name":"Footer group","sections":{"footer":{"type":"footer","settings":{}}},"order":["footer"]}\n`,
  'blocks/text.liquid': schema('<div class="text">{{ block.settings.text }}</div>', {
    name: 't:names.text',
    settings: [{ type: 'richtext', id: 'text', label: 't:settings.text' }],
    presets: [{ name: 't:names.text', category: 't:categories.basic' }],
  }),
  'blocks/button.liquid': schema(
    '<a href="{{ block.settings.link }}">{{ block.settings.label }}</a>',
    {
      name: 't:names.button',
      settings: [
        { type: 'text', id: 'label', label: 't:settings.label' },
        { type: 'url', id: 'link', label: 't:settings.link' },
      ],
      presets: [{ name: 't:names.button', category: 't:categories.basic' }],
    },
  ),
  'blocks/group.liquid': schema('<div class="group">{% content_for "blocks" %}</div>', {
    name: 't:names.group',
    blocks: [{ type: '@theme' }, { type: '@app' }, { type: '_divider' }],
    settings: [
      {
        type: 'select',
        id: 'content_direction',
        label: 't:settings.direction',
        options: [{ value: 'row' }, { value: 'column' }],
        default: 'column',
      },
    ],
    presets: [{ name: 't:names.group', category: 't:categories.layout' }],
  }),
  'blocks/_divider.liquid': schema('<hr>', {
    name: 't:names.divider',
    settings: [
      {
        type: 'range',
        id: 'thickness',
        label: 't:settings.thickness',
        min: 1,
        max: 8,
        step: 1,
        unit: 'px',
        default: 1,
      },
    ],
  }),
  'blocks/_heading.liquid': schema('<h1>{{ block.settings.text }}</h1>', {
    name: 't:names.heading',
    settings: [{ type: 'text', id: 'text', label: 't:settings.text' }],
  }),
  'templates/index.json': `${TEMPLATE_HEADER}${json({
    sections: {
      hero: {
        type: 'hero',
        blocks: {
          heading: { type: '_heading', static: true, settings: { text: 'Welcome' } },
          text_1: { type: 'text', settings: { text: '<p>Hello</p>' } },
        },
        block_order: ['text_1'],
        settings: { height: 'large' },
      },
    },
    order: ['hero'],
  })}`,
  'templates/product.json': `${TEMPLATE_HEADER}{"sections":{"main":{"type":"section","settings":{}}},"order":["main"]}\n`,
}

/** 旧的自带主题（agentsws-theme v0.10）起底的工作目录（只造认得出它的那几个文件）。 */
export const FAKE_LEGACY_THEME_FILES: Readonly<Record<string, string>> = {
  'AGENTS.md': '# AGENTS.md (legacy fixture)\n',
  'CATALOG.json':
    '{"theme":"agentsws-theme 0.10.0","entries":[{"id":"hero","kind":"section","use_when":"hero"}]}\n',
  'config/settings_schema.json':
    '[{"name":"theme_info","theme_name":"agentsws-theme","theme_version":"0.10.0"}]\n',
  'config/settings_data.json': '{"current":{}}\n',
  'templates/index.json': '{"sections":{"hero":{"type":"hero","settings":{}}},"order":["hero"]}\n',
  'sections/hero.liquid': '<section>legacy</section>\n',
  'sections/custom-banner.liquid': '<section>custom</section>\n',
}

/** 把一组相对路径的文件写进目录（测试 / demo 造工作目录用）。 */
export function writeThemeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
}

export interface FakeTheme {
  id: string
  name: string
  role: 'main' | 'unpublished' | 'development'
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

/** `--only` 的 glob（只认 `*` / `**`，够测试用）。 */
const globMatch = (glob: string, rel: string): boolean =>
  new RegExp(
    `^${glob
      .split('**')
      .map((p) =>
        p
          .split('*')
          .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*')}$`,
  ).test(rel)

/** WP258：替身账号下的一个组织与它的店。 */
export interface StandInOrg {
  id: string
  name: string
  stores: { store: string; name: string; plan: string }[]
}

/**
 * 进程内的假 `shopify theme …`。新店本来就有一份线上主题：默认是 Horizon（Shopify 新开的店就是它），
 * `live: 'other'` 造一家线上不是 Horizon 的店（`themes` 可再加几份未发布的）。
 * `calls` 记每条命令与参数（测试断言「没登录 / 没批之前一次 publish 都没跑」用）。
 */
export function themeCliStandIn(
  options: {
    shop?: string
    orgs?: StandInOrg[]
    live?: 'horizon' | 'other'
    /** 线上那一份的文件（不给 = {@link FAKE_HORIZON_FILES}；回放测试换成长短照真主题造的占位）。 */
    liveFiles?: Readonly<Record<string, string>>
    themes?: FakeTheme[]
    /** 店里最多几份主题（Shopify 是 20；测「满了」用）。 */
    maxThemes?: number
  } = {},
): {
  run: RunCli
  calls: string[][]
  themes: FakeTheme[]
} {
  const themes: FakeTheme[] = [
    {
      id: '100001',
      name: options.live === 'other' ? 'Dawn' : 'Horizon',
      role: 'main',
      files:
        options.live === 'other'
          ? {
              'config/settings_schema.json':
                '[{"name":"theme_info","theme_name":"Dawn","theme_version":"15.0.0"}]\n',
              'layout/theme.liquid': '<html>{{ content_for_layout }}</html>\n',
            }
          : { ...(options.liveFiles ?? FAKE_HORIZON_FILES) },
    },
    ...(options.themes ?? []),
  ]
  const calls: string[][] = []
  let seq = 100001 + themes.length
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
  const flags = (args: readonly string[], name: string): string[] =>
    args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1] as string] : []))
  const full = (): boolean => themes.length >= (options.maxThemes ?? 20)
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
    const byId = (id: string | undefined): FakeTheme | undefined =>
      themes.find((x) => x.id === id || x.name === id)
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
      const t = id === undefined ? themes.find((x) => x.role === 'main') : byId(id)
      if (t === undefined) return out('Theme not found (404)', 1)
      const dest = flag(args, '--path') ?? opts.cwd
      if (!existsSync(dest)) return out(`Path ${dest} does not exist`, 1)
      const only = flags(args, '--only')
      for (const [rel, body] of Object.entries(t.files)) {
        if (only.length > 0 && !only.some((g) => globMatch(g, rel))) continue
        mkdirSync(dirname(join(dest, rel)), { recursive: true })
        writeFileSync(join(dest, rel), body)
      }
      return out('Pulled\n')
    }
    if (sub === 'duplicate') {
      const t = byId(flag(args, '--theme'))
      if (t === undefined) return out('Theme not found (404)', 1)
      if (full())
        return out(
          {
            message: `The theme '${t.name}' could not be duplicated due to errors`,
            errors: ['Maximum number of themes reached'],
          },
          1,
        )
      seq += 1
      const copy: FakeTheme = {
        id: String(seq),
        name: flag(args, '--name') ?? `Copy of ${t.name}`,
        role: 'unpublished',
        files: { ...t.files },
      }
      themes.push(copy)
      return out({ theme: { id: Number(copy.id), name: copy.name, role: copy.role, shop } })
    }
    if (sub === 'rename') {
      const t = byId(flag(args, '--theme'))
      const name = flag(args, '--name')
      if (t === undefined || name === undefined) return out('Theme not found (404)', 1)
      t.name = name
      return out(`Renamed to ${name}\n`)
    }
    if (sub === 'push') {
      const files = readThemeDir(opts.cwd)
      if (args.includes('--unpublished')) {
        if (full()) return out('Maximum number of themes reached', 1)
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
      const t = byId(flag(args, '--theme'))
      if (t === undefined) return out('Theme not found (404)', 1)
      t.files = files
      return out({ theme: view(t) })
    }
    if (sub === 'publish') {
      const t = byId(flag(args, '--theme'))
      if (t === undefined) return out('Theme not found (404)', 1)
      for (const x of themes) if (x.role === 'main') x.role = 'unpublished'
      t.role = 'main'
      return out(`${t.name} is now live\n`)
    }
    return out(`unsupported theme ${sub ?? ''}`, 1)
  }
  return { run, calls, themes }
}
