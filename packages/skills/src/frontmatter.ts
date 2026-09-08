import { invalidInput } from './errors.js'

export interface Frontmatter {
  /** Agent Skills 必填 */
  name: string
  description?: string
  /** 其余键原样保留（allowed-tools、license、tags ……） */
  extra: Record<string, string>
  /** 原始键顺序，渲染时保持稳定 */
  order: string[]
}

export interface SplitDocument {
  frontmatter: Frontmatter
  body: string
}

const FENCE = /^---\s*$/

/**
 * Agent Skills 的 YAML frontmatter 子集：`key: value`、引号、`|` / `>` 块标量。
 * 自解析而非引入 yaml 依赖（派工约束：不引入未批准依赖）。
 */
export function splitFrontmatter(markdown: string): SplitDocument {
  const text = markdown.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  if (!FENCE.test(lines[i] ?? '')) {
    throw invalidInput('Agent Skills 文档缺少 YAML frontmatter（首个非空行必须是 ---）')
  }
  const start = i + 1
  let end = -1
  for (let j = start; j < lines.length; j++) {
    if (FENCE.test(lines[j] ?? '')) {
      end = j
      break
    }
  }
  if (end < 0) throw invalidInput('YAML frontmatter 没有闭合的 ---')

  const fm = parseScalarYaml(lines.slice(start, end))
  const name = fm.values.name
  if (name === undefined || name.trim() === '') {
    throw invalidInput('Agent Skills frontmatter 缺少 name')
  }
  const extra: Record<string, string> = {}
  for (const key of fm.order) {
    if (key === 'name' || key === 'description') continue
    const v = fm.values[key]
    if (v !== undefined) extra[key] = v
  }
  const description = fm.values.description
  const frontmatter: Frontmatter = {
    name: name.trim(),
    extra,
    order: fm.order,
    ...(description === undefined ? {} : { description }),
  }
  return { frontmatter, body: lines.slice(end + 1).join('\n') }
}

interface ScalarYaml {
  values: Record<string, string>
  order: string[]
}

function parseScalarYaml(lines: string[]): ScalarYaml {
  const values: Record<string, string> = {}
  const order: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw)
    if (!m) continue
    const key = m[1] ?? ''
    let value = (m[2] ?? '').trim()
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const folded = value.startsWith('>')
      const block: string[] = []
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? ''
        if (next.trim() !== '' && !/^\s/.test(next)) break
        block.push(next.replace(/^\s{1,8}/, ''))
        i++
      }
      while (block.length > 0 && (block[block.length - 1] ?? '').trim() === '') block.pop()
      value = folded ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n')
    } else {
      value = unquote(value)
    }
    if (!(key in values)) order.push(key)
    values[key] = value
  }
  return { values, order }
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

export function renderFrontmatter(fm: Frontmatter): string {
  const out: string[] = ['---', `name: ${fm.name}`]
  if (fm.description !== undefined) out.push(`description: ${fm.description}`)
  for (const key of fm.order) {
    if (key === 'name' || key === 'description') continue
    const v = fm.extra[key]
    if (v !== undefined) out.push(`${key}: ${v}`)
  }
  for (const [key, v] of Object.entries(fm.extra)) {
    if (!fm.order.includes(key)) out.push(`${key}: ${v}`)
  }
  out.push('---')
  return out.join('\n')
}
