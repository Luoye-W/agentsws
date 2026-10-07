/**
 * WP260 回放用的**假 agentsws-theme**：文件名、目录、长短照真主题 v0.9.1（AGENTS.md ≈ 1.2 万字、
 * CATALOG.json ≈ 50 万字 / 179 项、sections/faq.liquid ≈ 2.5 万字且 `{% schema %}` 在文件尾巴上），
 * 内容是这里现造的占位（不是真主题的拷贝）。每个文件尾巴上有一个 `END-OF-…` 记号：回放用的假模型据此判断
 * 「这份文件我是不是整份看见了」——看不全就会再读（10-07 真机 ci.16 那样）。
 */

const filler = (label: string, chars: number): string => {
  const line = `${label}: keep core files untouched, compose pages from existing sections and blocks. `
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars)
}

const setting = (id: string, type = 'text') => ({ id, type, label: `t:settings.${id}`, default: '' })

/** 一项目录条目（形状照 CATALOG.json 的 entries）。 */
const entry = (kind: 'section' | 'block' | 'snippet', id: string, settings: number) => ({
  id,
  kind,
  origin: 'core',
  file: `${kind}s/${id}.liquid`,
  name: id,
  description: filler(`${id} description`, 380),
  use_when: `${id}: ${filler('use when', 160)}`,
  accepts_blocks: kind === 'section' ? ['@theme', '@app'] : [],
  presets: [id],
  settings: Array.from({ length: settings }, (_, i) => ({
    ...setting(`${id.replace(/-/g, '_')}_setting_${i}`, i % 3 === 0 ? 'select' : 'text'),
    info: filler('info', 90),
    options: i % 3 === 0 ? ['a', 'b', 'c'] : undefined,
  })),
  renders: [],
  assets: [`assets/c-${id}.js`],
  elements: [`aw-${id}`],
})

const KEY_SECTIONS = ['hero', 'faq', 'container', 'newsletter', 'featured-product', 'rich-text']

function catalog(): string {
  const entries = [
    ...KEY_SECTIONS.map((id) => entry('section', id, 14)),
    ...Array.from({ length: 66 }, (_, i) => entry('section', `section-${i}`, 14)),
    ...['heading', 'text', 'button', 'image', 'group'].map((id) => entry('block', id, 8)),
    ...Array.from({ length: 52 }, (_, i) => entry('block', `block-${i}`, 8)),
    ...Array.from({ length: 50 }, (_, i) => entry('snippet', `snippet-${i}`, 0)),
  ].sort((a, b) => a.id.localeCompare(b.id))
  return JSON.stringify(
    {
      $comment: 'GENERATED (fixture)',
      theme: '0.9.1',
      counts: { sections: 72, blocks: 57, snippets: 50 },
      theme_settings: [{ group: 'Colors', settings: [setting('color_scheme_1')] }],
      entries,
    },
    null,
    1,
  )
}

const liquid = (name: string, body: number, marker: string): string =>
  [
    `{% comment %} @description ${name} section (fixture). Use when: ${name}. {% endcomment %}`,
    `<section class="${name}">`,
    filler(`<!-- ${name} markup -->`, body),
    '</section>',
    '{% schema %}',
    JSON.stringify({
      name: `t:sections.${name}.name`,
      settings: [setting('heading'), setting('text', 'richtext'), setting('color_scheme', 'color_scheme')],
      blocks: [{ type: '@theme' }, { type: '@app' }],
      presets: [{ name: `t:sections.${name}.name` }],
      marker,
    }),
    '{% endschema %}',
    '',
  ].join('\n')

/** 起底包里的那些文件（路径相对主题根）。 */
export function wp260ThemeFiles(): Record<string, string> {
  return {
    LICENSE: 'MIT License\n\nCopyright (c) 2026 agentsws (fixture)\n',
    'AGENTS.md': `# AGENTS.md — how to change this theme (fixture)\n\n## 1. Pick the lowest rung\n${filler('rules', 11_800)}\n\nEND-OF-AGENTS\n`,
    'CATALOG.json': catalog(),
    'recipes/README.md': '# Recipes\n\n| request | recipe |\n|---|---|\n| homepage section | compose-page.md |\n',
    'recipes/compose-page.md': `# Compose page content from existing blocks (L2)\n\n${filler('recipe', 2_300)}\n\nEND-OF-RECIPE\n`,
    'layout/theme.liquid':
      '<!doctype html><html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>\n',
    'templates/index.json': `${JSON.stringify(
      {
        sections: {
          hero: { type: 'hero', settings: { heading: 'Welcome', text: filler('hero text', 900) } },
          rich_text: { type: 'rich-text', settings: { heading: 'About us', text: filler('about', 900) } },
        },
        order: ['hero', 'rich_text'],
        _fixture: 'END-OF-INDEX',
      },
      null,
      2,
    )}\n`,
    'sections/hero.liquid': liquid('hero', 11_000, 'END-OF-HERO'),
    'sections/faq.liquid': liquid('faq', 25_000, 'END-OF-FAQ'),
    'config/settings_schema.json': '[{"name":"theme_info","theme_name":"agentsws-theme"}]\n',
    'config/settings_data.json': `${JSON.stringify({ current: { color_scheme: 'scheme-1', type_body_font: 'inter_n4', _fixture: 'END-OF-SETTINGS' } }, null, 2)}\n`,
    'locales/en.default.json': '{"general":{"hello":"Hello"}}\n',
    'assets/app.css': '/* build output */\n',
  }
}
