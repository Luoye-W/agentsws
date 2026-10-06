// WP239 设计稿装配：把 _src 里的外壳、令牌、各页正文拼成三个单文件 HTML（内联样式与脚本，不引外部资源）。
// 用法：node docs/design/position/_src/build.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = dirname(fileURLToPath(import.meta.url))
const out = join(src, '..')
const read = (f) => readFileSync(join(src, f), 'utf8')
const REDDIT = '../../../apps/workstation/src/assets/brand/reddit.png'
const di = (glyph) =>
  `<span class="di"><svg class="gl"><use href="#${glyph}"/></svg><img src="${REDDIT}" alt=""></span>`
const fill = (s) =>
  s
    .replaceAll('{{DI_MK}}', di('g-pr'))
    .replaceAll('{{DI_CM}}', di('g-social'))
    .replaceAll('{{REDDIT}}', REDDIT)

const pages = [
  {
    file: 'position-v2-list.html',
    title: 'Reddit 运营 · 岗位页 v2',
    css: ['pos.css', 'list.css', 'deck.css'],
    main: 'list.main.html',
    notes: 'list.notes.html',
    js: ['list.js', 'list2.js', 'list3.js', 'deck.js'],
    cnt: '<span class="cnt">4</span>',
  },
  {
    file: 'position-v2-settings.html',
    title: 'Reddit 运营 · 岗位设置 v2',
    css: ['pos.css', 'settings.css'],
    main: 'settings.main.html',
    notes: 'settings.notes.html',
    js: ['settings.js'],
    cnt: '<span class="cnt">4</span>',
  },
  {
    file: 'position-v2-empty.html',
    title: '新岗位 · 空的时候 v2',
    css: ['pos.css', 'list.css', 'deck.css', 'empty.css'],
    main: 'empty.main.html',
    notes: 'empty.notes.html',
    js: ['empty.js'],
    cnt: '',
  },
]

const shell = read('shell.html')
const base = read('base.css')
const icons = read('icons.svg')
for (const p of pages.filter((x) => { try { read(x.main); return true } catch { return false } })) {
  const html = shell
    .replace('{{TITLE}}', () => p.title)
    .replace('{{CSS}}', () => base)
    .replace('{{PAGE_CSS}}', () => p.css.map(read).join('\n'))
    .replace('{{ICONS}}', () => icons)
    .replace('{{HOME}}', () => 'position-v2-list.html')
    .replace('{{NAV_CNT}}', () => p.cnt)
    .replace('{{MAIN}}', () => fill(read(p.main)))
    .replace('{{NOTES}}', () => fill(read(p.notes)))
    .replace('{{JS}}', () => fill(p.js.map(read).join('\n')))
  writeFileSync(join(out, p.file), html)
  console.log('wrote', p.file, html.length)
}
