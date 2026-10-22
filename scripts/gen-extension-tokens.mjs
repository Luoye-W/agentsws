#!/usr/bin/env node
/**
 * WP456-T7（WP456 §2 / §3.12，决策 1446）：**插件的令牌从工作台那一份生成**，不再手抄。
 *
 * 真源：`apps/workstation/src/index.css`——
 * - 顶层 `:root { … }` 与 `.dark { … }` 里所有 `--ws-*`（颜色、阴影、卡边、分段切换……浅 / 深两套）；
 * - `@layer base` 里的字体栈 `--font-stack-sans` / `--font-stack-mono`（带「微软雅黑」，Windows 上中文才不乱回退）；
 * - `@theme inline` 里的档位：字号七档 `--text-ws-*`（连行高）→ `--ws-text-*` / `--ws-lh-*`，
 *   圆角五档 `--radius-ws-*` → `--ws-radius-*`。插件的手写 CSS 只用这些变量，数字就落在同一组档位上。
 *
 * 产物：`apps/extension/src/ui/tokens.css`（进仓库；**别手改**）。
 * - 浅色挂在 `:root, :host`——侧边栏 / 设置页是普通页面（`:root`），红人面板活在 shadow root 里（`:host`）；
 * - 深色放在 `@media (prefers-color-scheme: dark)` 里：插件不知道工作台选了哪个主题，跟系统走（与原来侧边栏一致）。
 *
 * 什么时候跑：插件构建前自动跑（`apps/extension/wxt.config.ts` 的 `build:before`，`wxt build` / `wxt` 开发都会先出一遍）；
 * 守卫：`node scripts/gen-extension-tokens.mjs --check`——工作台 token 改了、插件这份没重出就红（`check-ui-tokens.mjs`
 * 里也调它，所以 CI 与 `verify-changed.sh` 不用另加一步）。
 *
 * 用法：node scripts/gen-extension-tokens.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SOURCE = 'apps/workstation/src/index.css'
export const TARGET = 'apps/extension/src/ui/tokens.css'

/** 去掉块注释（保留其余原样）。 */
function stripBlockComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '')
}

/**
 * 找到某个选择器后面那一整块的内容（按大括号配对）。`from` 是从哪儿开始找；
 * `anchor` 是一个正则，匹配到「选择器 + `{`」为止。找不到返回 `undefined`。
 */
export function blockAfter(css, anchor, from = 0) {
  anchor.lastIndex = from
  const m = anchor.exec(css)
  if (m === null) return undefined
  const open = m.index + m[0].length - 1
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return { body: css.slice(open + 1, i), end: i + 1 }
    }
  }
  return undefined
}

/** 一块里**直接**写着的自定义属性（不进嵌套块），按出现顺序：`[[name, value], …]`。 */
export function declarations(body) {
  let flat = ''
  let depth = 0
  for (const ch of body) {
    if (ch === '{') {
      // 嵌套块的选择器也不要：退回到上一个分号
      if (depth === 0) flat = flat.slice(0, flat.lastIndexOf(';') + 1)
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) flat += ';'
    } else if (depth === 0) flat += ch
  }
  const out = []
  for (const raw of flat.split(';')) {
    const at = raw.indexOf(':')
    if (at < 0) continue
    const name = raw.slice(0, at).trim()
    if (!name.startsWith('--')) continue
    const value = raw
      .slice(at + 1)
      .replace(/\s+/gu, ' ')
      .trim()
    if (value !== '') out.push([name, value])
  }
  return out
}

/** 从工作台的 index.css 里取出插件要的那几组。 */
export function extractTokens(source) {
  const css = stripBlockComments(source)
  const light = blockAfter(css, /^:root\s*\{/gmu)
  const dark = blockAfter(css, /^\.dark\s*\{/gmu)
  const theme = blockAfter(css, /^@theme inline\s*\{/gmu)
  const base = blockAfter(css, /^@layer base\s*\{/gmu)
  if (light === undefined || dark === undefined || theme === undefined || base === undefined)
    throw new Error(`${SOURCE} 里找不到 :root / .dark / @theme inline / @layer base 那几块`)
  const baseRoot = blockAfter(base.body, /:root\s*\{/gu)
  if (baseRoot === undefined) throw new Error(`${SOURCE} 的 @layer base 里找不到 :root`)

  const ws = (body) => declarations(body).filter(([n]) => n.startsWith('--ws-'))
  const fonts = declarations(baseRoot.body).filter(([n]) => n.startsWith('--font-stack-'))
  const scale = []
  for (const [n, v] of declarations(theme.body)) {
    const text = /^--text-ws-([a-z]+)(--line-height)?$/u.exec(n)
    if (text !== null) {
      scale.push([text[2] === undefined ? `--ws-text-${text[1]}` : `--ws-lh-${text[1]}`, v])
      continue
    }
    const radius = /^--radius-ws-([a-z]+)$/u.exec(n)
    // `--radius-ws-card` 指回 `--ws-radius-card`（本来就在 :root 里），不再出一遍
    if (radius !== null && radius[1] !== 'card') scale.push([`--ws-radius-${radius[1]}`, v])
  }
  if (fonts.length === 0 || scale.length === 0)
    throw new Error(`${SOURCE} 里没取到字体栈或档位（index.css 的结构变了？）`)
  return { light: ws(light.body), dark: ws(dark.body), fonts, scale }
}

const HEADER = `/*
 * ⚠️ 生成文件，别手改。真源：${SOURCE}（工作台的 --ws-* 令牌、字体栈、字号 / 圆角档位）。
 * 重出：node scripts/gen-extension-tokens.mjs（插件构建前会自动跑）；
 * 守卫：node scripts/gen-extension-tokens.mjs --check（工作台改了、这里没重出就红）。
 *
 * 浅色挂在 :root（侧边栏、设置页）和 :host（红人面板的 shadow root）上；深色跟系统走。
 */
`

const lines = (decls, indent) => decls.map(([n, v]) => `${indent}${n}: ${v};`).join('\n')

/** 生成 tokens.css 的全文。 */
export function renderTokens(source) {
  const t = extractTokens(source)
  return `${HEADER}
:root,
:host {
${lines(t.fonts, '  ')}

  /* 档位：字号（含行高）、圆角（WP456 §2.3 / §2.5） */
${lines(t.scale, '  ')}

  /* 浅色 */
${lines(t.light, '  ')}
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root,
  :host {
${lines(t.dark, '    ')}
    color-scheme: dark;
  }
}
`
}

/** 现在仓库里那份插件令牌和工作台对不对得上：`{ ok, want, have }`（`have` 读不到就是空串）。 */
export function checkExtensionTokens(root) {
  const want = renderTokens(readFileSync(join(root, SOURCE), 'utf8'))
  let have = ''
  try {
    have = readFileSync(join(root, TARGET), 'utf8')
  } catch {
    have = ''
  }
  return { ok: have === want, want, have }
}

export const DRIFT_MESSAGE =
  `${TARGET} 和工作台的 ${SOURCE} 对不上：工作台的 token 改了、插件这份没重出。\n` +
  '  跑 node scripts/gen-extension-tokens.mjs 重出，连同改动一起提交。'

function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const { ok, want } = checkExtensionTokens(root)
  if (process.argv.includes('--check')) {
    if (ok) {
      console.log('✓ 插件令牌与工作台一致')
      return 0
    }
    console.error(`✗ ${DRIFT_MESSAGE}`)
    return 1
  }
  if (!ok) {
    writeFileSync(join(root, TARGET), want)
    console.log(`已重出 ${TARGET}`)
  }
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
