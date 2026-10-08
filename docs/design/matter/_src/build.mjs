// WP262 事项页设计稿装配：外壳 + 令牌（借 position/_src 的 base.css 与图标，同一份真 token）+ 本页正文，
// 拼成单文件 HTML（内联样式与脚本，不引外部资源；字体与品牌角标走仓里相对路径）。
// 用法：node docs/design/matter/_src/build.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = dirname(fileURLToPath(import.meta.url))
const out = join(src, '..')
const pos = join(src, '..', '..', 'position', '_src')
const read = (f) => readFileSync(join(src, f), 'utf8')
const readPos = (f) => readFileSync(join(pos, f), 'utf8')
const SHOPIFY = '../../../apps/workstation/src/assets/brand/shopify_admin.png'
const fill = (s) => s.replaceAll('{{SHOPIFY}}', SHOPIFY)

const pages = [
  {
    file: 'matter-v2-chat.html',
    title: 'Rollout 英文首页 · 事项页 v2',
    main: 'chat.main.html',
    notes: 'chat.notes.html',
    js: ['parts.js', 'chat.js'],
  },
  {
    file: 'matter-v2-states.html',
    title: '事项页 v2 · 四个状态与输入框',
    main: 'states.main.html',
    notes: 'states.notes.html',
    js: ['parts.js', 'states.js'],
  },
]

const shell = read('shell.html')
const base = readPos('base.css')
const icons = readPos('icons.svg').replace('</svg>', `${read('icons-extra.svg')}\n</svg>`)
for (const p of pages) {
  const html = shell
    .replace('{{TITLE}}', () => p.title)
    .replace('{{CSS}}', () => base)
    .replace('{{PAGE_CSS}}', () => read('matter.css') + read('composer.css'))
    .replace('{{ICONS}}', () => icons)
    .replace('{{MAIN}}', () => fill(read(p.main)))
    .replace('{{NOTES}}', () => fill(read(p.notes)))
    .replace('{{JS}}', () => fill(p.js.map(read).join('\n')))
  writeFileSync(join(out, p.file), fill(html))
  console.log('wrote', p.file, html.length)
}
