#!/usr/bin/env node
/**
 * WP250（决策 103）：从 Shopify 官方主题公开仓库取「新店默认首页文字」的各语言官方文案，
 * 按 `src/text-hash.ts` 的规则切句、归一、算哈希，写成 `src/shopify-default-texts.ts`。
 *
 * **数据文件和本脚本里都不存原文**：原文只在运行时从钉死提交号的仓库文件里临时取，
 * 用完即丢；脚本里只有「哪个仓库、哪个提交、哪个文件、哪个 key」。
 *
 *   pnpm --filter @agentsws/brand-intake build   # 先编出 dist（切句 / 哈希规则从 dist 取，和运行时同一份）
 *   node packages/brand-intake/scripts/gen-shopify-default-texts.mjs
 *
 * 只读 raw.githubusercontent.com（不登录、不带凭据）。要跟进上游，改下面两个提交号再跑一遍，看 diff。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { textHashes } from '../dist/text-hash.js'

const THEMES = {
  dawn: { repo: 'Shopify/dawn', commit: '258f00f64365e2018ca4c62778a6bf55a5d3cd18' },
  horizon: { repo: 'Shopify/horizon', commit: '5acd1b6b66c02f61d3216e3adace5dd9e0404fc9' },
}
const LANGS = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es']

/**
 * 一个「概念」= 新店首页上的同一处默认文字；不同主题 / 不同 key / 不同语言的同一处算一个
 * （判空店时按概念计数，同一处的中英两版只算一次）。
 * 来源三种：`schema` = locales/<lang>.schema.json，`storefront` = locales/<lang>.json，
 * `template` = 模板文件里写死的值（模板不走语言包，只有英文）。
 */
const CONCEPTS = [
  {
    id: 'announcement_welcome',
    sources: [
      ['dawn', 'schema', 'sections.announcement-bar.blocks.announcement.settings.text.default'],
      ['horizon', 'schema', 'text_defaults.welcome_to_our_store'],
    ],
  },
  {
    id: 'rich_text_heading',
    sources: [['dawn', 'schema', 'sections.rich-text.blocks.heading.settings.heading.default']],
  },
  {
    id: 'rich_text_body',
    sources: [
      ['dawn', 'schema', 'sections.rich-text.blocks.text.settings.text.default'],
      ['horizon', 'schema', 'html_defaults.share_information_about_your'],
    ],
  },
  {
    id: 'image_banner_heading',
    sources: [['dawn', 'schema', 'sections.image-banner.blocks.heading.settings.heading.default']],
  },
  {
    id: 'image_banner_text',
    sources: [['dawn', 'schema', 'sections.image-banner.blocks.text.settings.text.default']],
  },
  {
    id: 'image_with_text_body',
    sources: [
      ['dawn', 'schema', 'sections.image-with-text.blocks.text.settings.text.default'],
      ['dawn', 'schema', 'sections.multirow.blocks.row.settings.text.default'],
      ['dawn', 'schema', 'sections.multicolumn.blocks.column.settings.text.default'],
    ],
  },
  {
    id: 'example_product_title',
    sources: [['dawn', 'storefront', 'onboarding.product_title']],
  },
  {
    // 默认首页模板里写死的那句英文（各语言新店上都是英文）
    id: 'home_banner_browse',
    sources: [
      [
        'dawn',
        'template',
        'templates/index.json#sections.image_banner.blocks.heading.settings.heading',
      ],
      [
        'horizon',
        'template',
        'templates/index.json#sections.hero_jVaWmY.blocks.text_YLPk4p.settings.text',
      ],
    ],
  },
]

/**
 * WP244 就有、现行 Dawn / Horizon 里已经没有的两句英文（老主题的默认文字，出处未核实）。
 * 原文不进仓库，这里只留按同一规则算出的哈希。
 */
const LEGACY = [
  { id: 'legacy_content_goes_here', sentences: ['6fe4c52e1351d423'] },
  { id: 'legacy_use_this_text', sentences: ['e15e85a5cd3da550'] },
]

const raw = async (theme, path) => {
  const { repo, commit } = THEMES[theme]
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`)
  if (!res.ok) throw new Error(`${repo}@${commit.slice(0, 10)} ${path}: HTTP ${res.status}`)
  return res.text()
}

/** 去掉 JSONC 的注释（Horizon 的文件带块注释与行注释），字符串里的不动。 */
function stripJsonComments(s) {
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      out += c
      if (c === '\\') out += s[++i]
      else if (c === '"') inStr = false
    } else if (c === '"') {
      inStr = true
      out += c
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2) + 1
    } else out += c
  }
  return out
}

const cache = new Map()
async function json(theme, path) {
  const k = `${theme}:${path}`
  if (!cache.has(k)) cache.set(k, JSON.parse(stripJsonComments(await raw(theme, path))))
  return cache.get(k)
}
const localeFile = (lang, kind) =>
  `locales/${lang === 'en' ? 'en.default' : lang}${kind === 'schema' ? '.schema' : ''}.json`
const pick = (obj, key) => key.split('.').reduce((o, p) => o?.[p], obj)

const entries = []
for (const c of CONCEPTS) {
  const texts = []
  const push = (lang, from, value) => {
    if (typeof value !== 'string') throw new Error(`${from}: 没有这一条`)
    const sentences = textHashes(value)
    if (sentences.length === 0) throw new Error(`${from}: 切不出句子`)
    const same = (t) => t.lang === lang && t.sentences.join() === sentences.join()
    if (!texts.some(same)) texts.push({ lang, from, sentences })
  }
  for (const [theme, kind, key] of c.sources) {
    const at = `${THEMES[theme].repo}@${THEMES[theme].commit.slice(0, 8)}`
    if (kind === 'template') {
      const [path, k] = key.split('#')
      push('en', `${at}:${key}`, pick(await json(theme, path), k))
      continue
    }
    for (const lang of LANGS) {
      const file = localeFile(lang, kind)
      push(lang, `${at}:${file}#${key}`, pick(await json(theme, file), key))
    }
  }
  texts.sort((a, b) => LANGS.indexOf(a.lang) - LANGS.indexOf(b.lang))
  entries.push({ id: c.id, texts })
}
for (const l of LEGACY)
  entries.push({
    id: l.id,
    texts: [{ lang: 'en', from: 'WP244（老主题英文，出处未核实）', sentences: l.sentences }],
  })

const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const lines = [
  '/**',
  ' * WP250（决策 103）：Shopify 新店默认首页文字的**哈希**（各语言官方文案，不存原文）。',
  ' * 生成的文件，别手改——改 `scripts/gen-shopify-default-texts.mjs` 再跑一遍。',
  ' *',
  ' * 来源（原文只在生成时临时取，用来认「这家店的首页是不是还没改过」）：',
  ...Object.values(THEMES).map((t) => ` * - github.com/${t.repo} @ ${t.commit}`),
  ' * 版权：Copyright (c) 2021-present Shopify Inc.（两个仓库的 LICENSE.md 是带用途限制的 MIT 式许可）。',
  ' *',
  ' * `id` 是「同一处默认文字」：判空店时按 id 计数（同一处的中英两版只算一次）。',
  ' * `sentences` 是这段文案逐句归一后的 SHA-256 前 16 位（规则见 `text-hash.ts`）。',
  ' */',
  'export interface ShopifyDefaultText {',
  '  id: string',
  '  texts: readonly { lang: string; from: string; sentences: readonly string[] }[]',
  '}',
  '',
  'export const SHOPIFY_DEFAULT_HOME_TEXTS: readonly ShopifyDefaultText[] = [',
]
for (const e of entries) {
  lines.push('  {', `    id: ${q(e.id)},`, '    texts: [')
  for (const t of e.texts)
    lines.push(
      `      { lang: ${q(t.lang)}, from: ${q(t.from)}, sentences: [${t.sentences.map(q).join(', ')}] },`,
    )
  lines.push('    ],', '  },')
}
lines.push(']', '')

const out = join(dirname(fileURLToPath(import.meta.url)), '../src/shopify-default-texts.ts')
writeFileSync(out, lines.join('\n'))
execFileSync('npx', ['biome', 'format', '--write', out], { stdio: 'ignore' })
console.log(
  `写好 ${out}：${entries.length} 处、${entries.reduce((n, e) => n + e.texts.length, 0)} 条`,
)
