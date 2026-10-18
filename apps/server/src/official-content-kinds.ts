/**
 * WP406（私有 docs/107 §3 / §4）：官方岗位内容**每一种**怎么读、怎么验、怎么和「你的」比——纯函数，不碰盘、不碰时钟。
 *
 * | 种类 | 包里是什么 | 验什么（不过整包拒收） | 你的那一层在哪 |
 * |---|---|---|---|
 * | `role_content` | 一份 `RoleContentFile`（`agentsws.role-content/1`） | WP404 白名单 + 叠到骨架上再过一遍骨架那一关 | 公司改的角色定位（按段）；快捷问题 / 示例任务的「隐藏 / 改 / 自己加」 |
 * | `position_content` | 一份 `PositionContentFile` | 同上 | 公司改的岗位角色定位 |
 * | `rules` | 一份 `ContentTableFile`（每行带 id） | 表名对得上、每行有 id、不重名 | 规则表的「隐藏 / 改 / 自己加」 |
 * | `knowledge` | 知识包 v1 | `parseKnowledgePack` 读得懂 | 没有（官方知识进候选 / 激活，和你自己的知识各是各的） |
 * | `skill` | 技能目录 | docs/90 那一套 | 技能库上面几层（`planContentMerge`） |
 *
 * 角色定位只比中文（英文跟着中文走，WP226 的规矩）；拆不成六段的改写整段比（决策 1180）。
 */
import type {
  ContentItem,
  ContentPart,
  ContentPartChange,
  ContentTableRow,
  PersonaOverride,
  PersonaText,
  PositionContent,
  RoleContent,
} from '@agentsws/contracts'
import { contentTableProblem } from '@agentsws/core'
import { type PackFile, parseKnowledgePack } from '@agentsws/knowledge'
import { checkContentFile, personaTextIn, splitPersonaSections } from '@agentsws/roles'
import { ContentPackError, type ItemUserEdit, planItemMerge } from '@agentsws/skills'

/** 一项读出来的样子。 */
export type OfficialPayload =
  | { kind: 'role_content'; id: string; content: RoleContent }
  | { kind: 'position_content'; id: string; content: PositionContent }
  | { kind: 'rules'; table: string; rows: ContentTableRow[] }
  | { kind: 'knowledge'; files: PackFile[]; titles: string[] }
  | { kind: 'skill' }

/** 这一项里唯一的那份数据文件（`.json`；有好几份时取 `content.json`）。 */
function jsonFileOf(item: ContentItem, files: ReadonlyMap<string, Buffer>): unknown {
  const paths = [...files.keys()].filter((p) => p.endsWith('.json'))
  const path = paths.includes('content.json') ? 'content.json' : paths.length === 1 ? paths[0] : ''
  const bytes = path === undefined || path === '' ? undefined : files.get(path)
  if (bytes === undefined) throw new ContentPackError('bad_manifest', `${item.id} 里没有内容文件`)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ContentPackError('bad_manifest', `${item.id} 的内容文件不是 JSON`)
  }
}

/**
 * 读一项、验一项。**白名单外的字段、形状不对、表名对不上一律抛**——调用方据此整包拒收
 * （一个拼错的键被静默忽略，比报错危险得多，与 WP404 同一条纪律）。
 */
export function parseOfficialItem(
  item: ContentItem,
  files: ReadonlyMap<string, Buffer>,
): OfficialPayload {
  try {
    switch (item.kind) {
      case 'role_content':
      case 'position_content': {
        const expect = { kind: item.kind === 'role_content' ? 'role' : 'position', id: item.name }
        const content = checkContentFile(jsonFileOf(item, files), expect as never, item.id)
        return item.kind === 'role_content'
          ? { kind: 'role_content', id: item.name, content: content as RoleContent }
          : { kind: 'position_content', id: item.name, content: content as PositionContent }
      }
      case 'rules': {
        const raw = jsonFileOf(item, files) as { table?: unknown; rows?: unknown }
        if (typeof raw !== 'object' || raw === null || raw.table !== item.name)
          throw new ContentPackError('bad_manifest', `${item.id} 的表名对不上`)
        const bad = contentTableProblem(raw.rows)
        if (bad !== undefined) throw new ContentPackError('bad_manifest', `${item.id}：${bad}`)
        return { kind: 'rules', table: item.name, rows: raw.rows as ContentTableRow[] }
      }
      case 'knowledge': {
        const pack = [...files.entries()].map(([path, b]) => ({
          path,
          content: b.toString('utf8'),
        }))
        const parsed = parseKnowledgePack(pack)
        if (!parsed.ok)
          throw new ContentPackError('bad_manifest', `${item.id}：${parsed.code} ${parsed.message}`)
        return {
          kind: 'knowledge',
          files: pack,
          titles: parsed.entries.map((e) => e.title),
        }
      }
      case 'skill':
        return { kind: 'skill' }
      default:
        throw new ContentPackError('bad_manifest', `${item.id}：这一版不认 ${item.kind}`)
    }
  } catch (e) {
    if (e instanceof ContentPackError) throw e
    throw new ContentPackError('bad_manifest', `${item.id}：${e instanceof Error ? e.message : e}`)
  }
}

/* ── 按条：快捷问题、示例任务、规则表的一行 ─────────────────────────── */

/** 一条在界面上怎么念（快捷问题念按钮字 + 那句话；规则表念去掉 id 的那几格）。 */
export function rowText(row: unknown): string {
  if (typeof row !== 'object' || row === null) return String(row ?? '')
  const r = row as Record<string, unknown>
  const zh = (v: unknown): string | undefined =>
    typeof v === 'object' && v !== null && typeof (v as { zh?: unknown }).zh === 'string'
      ? (v as { zh: string }).zh
      : typeof v === 'string'
        ? v
        : undefined
  if (r.label !== undefined && typeof r.prompt === 'string')
    return `${zh(r.label) ?? ''}：${r.prompt}`
  if (r.title !== undefined && typeof r.description === 'string')
    return `${zh(r.title) ?? ''}：${r.description}${typeof r.expected_output === 'string' ? ` → ${r.expected_output}` : ''}`
  const { id: _id, notes: _notes, ...rest } = r
  return JSON.stringify(rest, null, 1)
}

/** 一条的短名（第三栏每一行左边那几个字）。 */
export function rowLabel(row: unknown, id: string): string {
  if (typeof row !== 'object' || row === null) return id
  const r = row as Record<string, unknown>
  for (const k of ['label', 'title']) {
    const v = r[k]
    if (typeof v === 'object' && v !== null && typeof (v as { zh?: unknown }).zh === 'string')
      return (v as { zh: string }).zh
  }
  return id
}

/** 一张表叠上「你的」（隐藏 / 改 / 自己加）。改的那一条上游删了 → 当成你自己加的留着。 */
export function applyItemEdits<R extends { id: string }>(
  rows: readonly R[],
  edits: readonly ItemUserEdit[],
): R[] {
  if (edits.length === 0) return [...rows]
  const hidden = new Set(edits.filter((e) => e.op === 'hide').map((e) => e.item_id))
  const changed = new Map(
    edits.filter((e) => e.op === 'edit' && e.value !== undefined).map((e) => [e.item_id, e]),
  )
  const out: R[] = []
  for (const row of rows) {
    if (hidden.has(row.id)) continue
    const e = changed.get(row.id)
    out.push(e === undefined ? row : ({ ...(e.value as object), id: row.id } as R))
    changed.delete(row.id)
  }
  for (const e of [...changed.values(), ...edits.filter((x) => x.op === 'add')])
    if (e.value !== undefined && !out.some((r) => r.id === e.item_id))
      out.push({ ...(e.value as object), id: e.item_id } as R)
  return out
}

/** 一张表从旧到新 + 你的改动 → 第三栏一条一条的样子。 */
export function rowParts(
  prefix: string,
  before: readonly { id: string }[],
  after: readonly { id: string }[],
  edits: readonly ItemUserEdit[],
): ContentPart[] {
  const plan = planItemMerge(
    before.map((r) => ({ id: r.id, value: r })),
    after.map((r) => ({ id: r.id, value: r })),
    edits,
  )
  const old = new Map(before.map((r) => [r.id, r]))
  const now = new Map(after.map((r) => [r.id, r]))
  const mineOf = new Map(edits.map((e) => [e.item_id, e]))
  const clash = new Set(plan.conflicts.map((c) => c.item_id))
  const parts: ContentPart[] = []
  const push = (id: string, change: ContentPartChange): void => {
    const was = old.get(id)
    const is = now.get(id)
    const mine = mineOf.get(id)
    parts.push({
      key: `${prefix}.${id}`,
      label: rowLabel(is ?? was, id),
      change,
      ...(was === undefined ? {} : { before: rowText(was) }),
      ...(is === undefined ? {} : { after: rowText(is) }),
      ...(mine === undefined
        ? {}
        : { edited: true, mine: mine.op === 'hide' ? '（你隐藏了这一条）' : rowText(mine.value) }),
      ...(clash.has(id) ? { clash: true } : {}),
    })
  }
  for (const id of plan.upstream.added) push(id, 'added')
  for (const id of plan.upstream.changed) push(id, 'changed')
  for (const id of plan.upstream.removed) push(id, 'removed')
  return parts
}

/* ── 角色定位：按段 ─────────────────────────────────────────────────── */

/**
 * 角色定位从旧到新 + 公司的改写 → 按段的样子（只比中文）。
 * 改写是按段存的：改过的那一段新版也改了 = 撞了；拆不开（整段改写 / 包里那份不是六段）→ 整段一格。
 */
export function personaParts(
  prefix: string,
  before: PersonaText | undefined,
  after: PersonaText | undefined,
  override: PersonaOverride | undefined,
): ContentPart[] {
  const a = personaTextIn(before, 'zh')
  const b = personaTextIn(after, 'zh')
  if (a === b) return []
  const sa = splitPersonaSections(a, 'zh')
  const sb = splitPersonaSections(b, 'zh')
  const mineSections = override?.sections?.zh
  if (
    sa === undefined ||
    sb === undefined ||
    (override !== undefined && mineSections === undefined)
  ) {
    const mine = override === undefined ? undefined : personaTextIn(override.text, 'zh')
    return [
      {
        key: prefix,
        label: '角色定位',
        change: a === '' ? 'added' : b === '' ? 'removed' : 'changed',
        ...(a === '' ? {} : { before: a }),
        ...(b === '' ? {} : { after: b }),
        ...(mine === undefined || mine === ''
          ? {}
          : { edited: true, mine, ...(mine === a || mine === b ? {} : { clash: true }) }),
        mergeable: true,
      },
    ]
  }
  const parts: ContentPart[] = []
  for (const [i, s] of sb.sections.entries()) {
    const was = sa.sections[i]
    if (was !== undefined && was.body === s.body) continue
    const mine = mineSections?.[s.id]
    parts.push({
      key: `${prefix}.${s.id}`,
      label: s.heading,
      change: 'changed',
      ...(was === undefined ? {} : { before: was.body }),
      after: s.body,
      // 你那一段只是照抄了旧版 / 正好就是新版：不算撞（应用时跟新版走）
      ...(mine === undefined
        ? {}
        : {
            edited: true,
            mine,
            ...(mine === was?.body || mine === s.body ? {} : { clash: true }),
          }),
      mergeable: true,
    })
  }
  return parts
}

/** 一格文字（名字、一句话说明）从旧到新。 */
export function fieldPart(
  key: string,
  label: string,
  before: string | undefined,
  after: string | undefined,
): ContentPart[] {
  if ((before ?? '') === (after ?? '') || after === undefined) return []
  return [
    {
      key,
      label,
      change: before === undefined ? 'added' : 'changed',
      ...(before === undefined ? {} : { before }),
      after,
    },
  ]
}

/** 名字（中英）念成一行。 */
export const nameText = (n: { zh: string; en: string } | undefined): string | undefined =>
  n === undefined ? undefined : n.en === '' || n.en === n.zh ? n.zh : `${n.zh} / ${n.en}`

/** 规范化 JSON 比较（键的顺序不算）：官方这一版和现在用的是不是一回事。 */
export function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
    if (typeof v === 'object' && v !== null)
      return `{${Object.keys(v)
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
        .join(',')}}`
    return JSON.stringify(v)
  }
  return canon(a) === canon(b)
}
