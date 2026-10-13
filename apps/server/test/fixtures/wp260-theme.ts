/**
 * WP260 回放用的假主题（WP301 起是 **Horizon 形状**的占位：`theme_info` 写 Horizon，分区文件长短照真 Horizon，
 * `{% schema %}` 在文件尾巴上），内容是这里现造的占位（不是真主题的拷贝）。每个文件尾巴上有一个 `END-OF-…` 记号：回放用的假模型据此判断
 * 「这份文件我是不是整份看见了」——看不全就会再读（10-07 真机 ci.16 那样）。
 */

const filler = (label: string, chars: number): string => {
  const line = `${label}: keep core files untouched, compose pages from existing sections and blocks. `
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars)
}

const setting = (id: string, type = 'text') => ({ id, type, label: `t:settings.${id}`, default: '' })

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

/**
 * 店里线上那一份主题的文件（路径相对主题根）。WP301 起起底 = 在店里复制一份 Horizon：`theme_info` 写 Horizon，
 * 目录（CATALOG.index.json / CATALOG.json）由工坊按分区的 schema 现生成；分区文件的长短照真 Horizon 造
 * （`sections/section.liquid` ≈ 5.4 万字、`hero.liquid` ≈ 4.5 万字，`{% schema %}` 在文件尾巴上）。
 */
export function wp260ThemeFiles(): Record<string, string> {
  return {
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
    'sections/hero.liquid': liquid('hero', 45_000, 'END-OF-HERO'),
    'sections/faq.liquid': liquid('faq', 54_000, 'END-OF-FAQ'),
    ...Object.fromEntries(
      ['container', 'newsletter', 'featured-product', 'rich-text'].map((id) => [
        `sections/${id}.liquid`,
        liquid(id, 2_000, `END-OF-${id.toUpperCase()}`),
      ]),
    ),
    ...Object.fromEntries(
      ['heading', 'text', 'button', 'image', 'group'].map((id) => [
        `blocks/${id}.liquid`,
        liquid(id, 1_000, `END-OF-${id.toUpperCase()}`),
      ]),
    ),
    'config/settings_schema.json':
      '[{"name":"theme_info","theme_name":"Horizon","theme_version":"9.9.9-fixture","theme_author":"Shopify"}]\n',
    'config/settings_data.json': `${JSON.stringify({ current: { color_scheme: 'scheme-1', type_body_font: 'inter_n4', _fixture: 'END-OF-SETTINGS' } }, null, 2)}\n`,
    'locales/en.default.json': '{"general":{"hello":"Hello"}}\n',
    'locales/en.default.schema.json': '{"sections":{}}\n',
    'assets/base.css': '/* fixture */\n',
  }
}
