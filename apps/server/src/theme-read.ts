/**
 * WP260：`theme_read_file` 回给模型的那一份（分页 + CATALOG.json 目录页 / 按 ids 挑）。
 *
 * 10-07 真机（ci.16）：模型读 `CATALOG.json`（真主题 50 万字）、`sections/faq.liquid`（2.5 万字）——
 * 工具结果围栏只放 1.2 万字，它只看得见开头；分区的 `{% schema %}` 在文件尾巴上，于是一遍遍重读。
 * 这里只做「怎么切给模型看」，读文件本身仍是主题工坊（`site-theme.ts`）那一个 `readFile`（出不去、≤ 512 KB）。
 */
import { THEME_READ_PAGE_CHARS, type ThemeReadData } from '@agentsws/stand-ins'

/** 按 ids 挑的完整几项，一次最多回这么多字（放不下的写进 `more_ids`，另读一次）。 */
const CATALOG_ENTRIES_CHARS = 40_000
/** 目录页每项「什么时候用」截到这么长。 */
const USE_WHEN_CHARS = 90

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`

/** 这是不是 agentsws-theme 的 CATALOG.json（形状对上才按目录切；对不上就当普通文件分页）。 */
function catalogOf(path: string, content: string): { root: Rec; entries: Rec[] } | undefined {
  if (path !== 'CATALOG.json') return undefined
  try {
    const root = rec(JSON.parse(content))
    const entries = Array.isArray(root?.entries)
      ? (root.entries as unknown[]).flatMap((e) => {
          const r = rec(e)
          return r !== undefined && typeof r.id === 'string' ? [r] : []
        })
      : []
    return root === undefined || entries.length === 0 ? undefined : { root, entries }
  } catch {
    return undefined
  }
}

/** 一页目录：分区与块各一行（id + 什么时候用），片段只列 id，主题设置只列分组名。 */
function catalogIndex(root: Rec, entries: Rec[]): string {
  const of = (kind: string) => entries.filter((e) => e.kind === kind)
  const line = (e: Rec): string => {
    const when =
      [e.use_when, e.description, e.name]
        .map(str)
        .find((x) => x !== undefined && x.trim() !== '') ?? ''
    const custom = e.origin === 'custom' || String(e.id).startsWith('custom-') ? '（custom）' : ''
    return `- ${String(e.kind)} ${String(e.id)}${custom}: ${clip(when.replace(/\s+/g, ' '), USE_WHEN_CHARS)}`
  }
  const sections = of('section')
  const blocks = of('block')
  const snippets = of('snippet')
  const groups = Array.isArray(root.theme_settings)
    ? (root.theme_settings as unknown[]).flatMap((g) => {
        const name = str(rec(g)?.group)
        return name === undefined ? [] : [name]
      })
    : []
  const version = str(root.theme)
  return [
    `agentsws-theme${version === undefined ? '' : ` ${version}`} 目录：${sections.length} 个分区、${blocks.length} 个块、${snippets.length} 个片段。`,
    '要某几项的完整设置（settings 的 id / 类型 / 选项）：再读一次 CATALOG.json 并给 ids，例如 ids=["hero","faq","container"]；主题设置给 ids=["theme_settings"]。',
    '',
    '## 分区（sections，放进 templates/*.json 的 sections 里）',
    ...sections.map(line),
    '',
    '## 块（blocks，放进分区的 blocks 里）',
    ...blocks.map(line),
    '',
    `## 片段（snippets，Liquid 里 render 用，搭页面用不到）：${snippets.map((e) => String(e.id)).join(', ')}`,
    '',
    `## 主题设置分组（config/settings_data.json 的 current 里改）：${groups.join(', ')}`,
  ].join('\n')
}

/** 按 ids 挑出的完整几项（去掉搭页面用不到的 assets / elements / renders）。 */
function catalogEntries(root: Rec, entries: Rec[], ids: string[]): ThemeReadData {
  const picked: Rec[] = []
  const missing: string[] = []
  const more: string[] = []
  let size = 0
  for (const id of ids) {
    const found =
      id === 'theme_settings'
        ? Array.isArray(root.theme_settings)
          ? { id: 'theme_settings', kind: 'theme_settings', groups: root.theme_settings }
          : undefined
        : entries.find((e) => e.id === id)
    if (found === undefined) {
      missing.push(id)
      continue
    }
    const { assets: _a, elements: _e, renders: _r, ...slim } = found
    const bytes = JSON.stringify(slim).length
    if (picked.length > 0 && size + bytes > CATALOG_ENTRIES_CHARS) {
      more.push(id)
      continue
    }
    picked.push(slim)
    size += bytes
  }
  return {
    path: 'CATALOG.json',
    content: JSON.stringify({ entries: picked }),
    catalog: 'entries',
    ...(missing.length === 0 ? {} : { missing }),
    ...(more.length === 0 ? {} : { more_ids: more }),
  }
}

/**
 * 读到的整份文件 → 给模型的这一页。
 *
 * - `CATALOG.json`（形状对得上）：不给 ids、不给 offset → 目录页；给 ids → 那几项的完整设置；
 * - 其余：不超过一页（2.4 万字）原样回 `{ path, content }`（老形状不变）；超了按 offset 切一页，带上
 *   `total_chars` 与下一段的 `next_offset`。
 */
export function themeReadPage(
  file: { path: string; content: string },
  input: { offset?: unknown; ids?: unknown },
): ThemeReadData {
  const ids = Array.isArray(input.ids)
    ? [...new Set((input.ids as unknown[]).filter((x): x is string => typeof x === 'string'))]
    : []
  const offset =
    typeof input.offset === 'number' && Number.isFinite(input.offset) && input.offset > 0
      ? Math.floor(input.offset)
      : 0
  const catalog = catalogOf(file.path, file.content)
  if (catalog !== undefined && ids.length > 0)
    return catalogEntries(catalog.root, catalog.entries, ids)
  if (catalog !== undefined && offset === 0)
    return {
      path: file.path,
      content: catalogIndex(catalog.root, catalog.entries),
      catalog: 'index',
    }
  const total = file.content.length
  if (offset === 0 && total <= THEME_READ_PAGE_CHARS) return file
  const start = Math.min(offset, total)
  const end = Math.min(total, start + THEME_READ_PAGE_CHARS)
  return {
    path: file.path,
    content: file.content.slice(start, end),
    offset: start,
    total_chars: total,
    ...(end < total ? { next_offset: end } : {}),
  }
}
