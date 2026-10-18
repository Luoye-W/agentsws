/**
 * WP219（docs/90 §6.3）：**官方更新不冲掉你的改动**——新版基础层与上层改动的三方合并。
 *
 * 三方：旧基础层（你改的时候看到的那一版）、新基础层（这次更新来的）、你的改动（公司 / 岗位 / 职责 /
 * 个人层里对某一段的替换、追加、删除，含学习回路采纳的那些）。按**段**判（24 §1 段 id 对齐，改标题不改 id）：
 *
 * | 旧 → 新（上游） | 你 | 结果 |
 * |---|---|---|
 * | 没动 | 改了 | 保留你的（干净） |
 * | 改了 | 追加了 | 新版 + 你追加的（干净） |
 * | 改了 | 替换成和新版一样 | 干净 |
 * | 改了 | 替换成别的 / 删了 | **冲突**：出卡让人选「用新版 / 保留我的」 |
 * | 删了 / 改名到认不出 | 改了 | **冲突** |
 * | — | 你自己加的段 | 干净（上游没有这段） |
 *
 * 这里只**算**，不改任何东西；改由服务进程按人的选择去做。
 */
import type { ContentSectionChange } from '@agentsws/contracts'
import { splitFrontmatter } from './frontmatter.js'
import { splitSections } from './parse.js'
import { normalizeBody } from './text.js'

export interface MergeSection {
  id: string
  heading: string
  body: string
}

/** 上层里对某一段的一处改动。 */
export interface ContentUserEdit {
  /** 哪一层（company / position / role / personal …）。 */
  tier: string
  /** 那一层的主人（工作区 / 岗位 / 职责 / 人）。 */
  owner: string
  /** overlay 的一条 op，还是那一层自己的整段（layer）。 */
  source: 'overlay' | 'layer'
  op: 'replace' | 'append' | 'remove'
  section_id: string
  body?: string
}

export interface ContentMergeConflict extends ContentUserEdit {
  heading: string
  base_before: string
  /** 新版里这一段（上游删了就是空串）。 */
  base_after: string
  mine: string
}

export interface ContentMergePlan {
  clean: ContentUserEdit[]
  conflicts: ContentMergeConflict[]
}

const same = (a: string | undefined, b: string | undefined): boolean =>
  normalizeBody(a ?? '') === normalizeBody(b ?? '')

export function planContentMerge(
  before: readonly MergeSection[],
  after: readonly MergeSection[],
  edits: readonly ContentUserEdit[],
): ContentMergePlan {
  const old = new Map(before.map((s) => [s.id, s]))
  const now = new Map(after.map((s) => [s.id, s]))
  const plan: ContentMergePlan = { clean: [], conflicts: [] }
  for (const edit of edits) {
    const was = old.get(edit.section_id)
    // 你自己加的段：上游从来没有，谈不上冲突
    if (was === undefined) {
      plan.clean.push(edit)
      continue
    }
    const is = now.get(edit.section_id)
    const conflict = (): void => {
      plan.conflicts.push({
        ...edit,
        heading: is?.heading ?? was.heading,
        base_before: was.body,
        base_after: is?.body ?? '',
        mine: edit.op === 'remove' ? '' : (edit.body ?? ''),
      })
    }
    if (is === undefined) {
      // 上游把这段删了（或改到认不出）：你也删了就一致，否则要人选
      if (edit.op === 'remove') plan.clean.push(edit)
      else conflict()
      continue
    }
    if (same(was.body, is.body)) {
      plan.clean.push(edit)
      continue
    }
    if (edit.op === 'append') {
      plan.clean.push(edit)
      continue
    }
    if (edit.op === 'replace' && same(edit.body, is.body)) {
      plan.clean.push(edit)
      continue
    }
    conflict()
  }
  return plan
}

/** 冲突的稳定键（同一版、同一段、同一层同一主人只问一次）。 */
export function contentConflictKey(
  item_id: string,
  version: string,
  c: Pick<ContentUserEdit, 'tier' | 'owner' | 'section_id'>,
): string {
  return [item_id, version, c.tier, c.owner, c.section_id].join('|')
}

/** 「查看改动」：两版技能正文按段（`##` 标题）比，列出加了 / 改了 / 删了的段。 */
export function diffSkillMarkdown(
  before: string | undefined,
  after: string,
): ContentSectionChange[] {
  const sectionsOf = (md: string): { heading: string; body: string }[] => {
    let body = md
    try {
      body = splitFrontmatter(md).body
    } catch {
      /* 没有 frontmatter 的参考文件：整份当正文 */
    }
    return splitSections(body)
  }
  const a = before === undefined ? [] : sectionsOf(before)
  const b = sectionsOf(after)
  const out: ContentSectionChange[] = []
  const left = new Map(a.map((s) => [s.heading, s.body]))
  for (const s of b) {
    const was = left.get(s.heading)
    if (was === undefined) out.push({ heading: s.heading, change: 'added', after: s.body })
    else if (!same(was, s.body))
      out.push({ heading: s.heading, change: 'changed', before: was, after: s.body })
    left.delete(s.heading)
  }
  for (const [heading, body] of left) out.push({ heading, change: 'removed', before: body })
  return out
}

/* ── WP404（docs/107 §4）：按条的三方合并 ─────────────────────────────────── */

/**
 * 列表 / 规则表里的一条（快捷问题、示例任务、规则表的一行……）：稳定 id + 内容。
 * 值按规范化的 JSON 比（键的顺序不算）；两边都是字符串时还认「在后面追加了一句」。
 */
export interface MergeItem<V = unknown> {
  id: string
  value: V
}

/** 上层里对某一条的一处改动：隐藏、改、自己加。 */
export interface ItemUserEdit<V = unknown> {
  /** 哪一层（company / position / role / personal …）。 */
  tier: string
  /** 那一层的主人。 */
  owner: string
  op: 'hide' | 'edit' | 'add'
  item_id: string
  /** `edit` / `add` 的新内容。 */
  value?: V
}

/**
 * 干净的那一种，带一句「怎么落」：
 * - `keep`：照你的（上游没动这一条 / 你自己加的 / 你隐藏的那条上游也删了）；
 * - `same`：你改成的正好就是新版（这一处改动可以去掉，留着也一样）；
 * - `follow_new`：你只是照抄了旧版（没真改）——跟新版走，这一处改动作废，不问人；
 * - `rebase`：你在旧版后面追加了一句——新版 + 你追加的（`value_after`）。
 */
export interface ItemMergeClean<V = unknown> extends ItemUserEdit<V> {
  resolution: 'keep' | 'same' | 'follow_new' | 'rebase'
  /** `rebase` 时合好的那一版。 */
  value_after?: V
}

/** 要人选的那一种（「用新版 / 保留我的」）。没选之前**你的照旧生效**（与段合并同一条规矩）。 */
export interface ItemMergeConflict<V = unknown> extends ItemUserEdit<V> {
  /** 上游改了你也改了 / 上游删了你改了 / 你自己加的 id 和上游新加的撞了。 */
  reason: 'upstream_changed' | 'upstream_removed' | 'id_clash'
  base_before?: V
  base_after?: V
  /** 你的（隐藏 = 不写）。 */
  mine?: V
}

export interface ItemMergePlan<V = unknown> {
  clean: ItemMergeClean<V>[]
  conflicts: ItemMergeConflict<V>[]
  /** 上游这一版本身变了哪些条（卡上「+3 条 / 改 1 条」从这里数）。 */
  upstream: { added: string[]; changed: string[]; removed: string[] }
}

/** 规范化的 JSON（对象按键排序），值比较用。 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (typeof v === 'object' && v !== null)
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return typeof v === 'string' ? JSON.stringify(normalizeBody(v)) : JSON.stringify(v)
}

const sameValue = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

/**
 * 按条的三方合并：旧基础层、新基础层、上层的「隐藏 / 改 / 自己加」→ 干净的与冲突的。**只算，不改**。
 *
 * 与 `planContentMerge`（按段）同一张表（docs/90 §6.3），换成「条」：
 *
 * | 上游（旧 → 新） | 你 | 结果 |
 * |---|---|---|
 * | 没动 | 改了 / 隐藏了 | 保留你的（`keep`） |
 * | 改了 | 在后面追加了一句 | 新版 + 你追加的（`rebase`） |
 * | 改了 | 改成和新版一样 | 干净（`same`） |
 * | 改了 | 改成别的 / 隐藏了 | **冲突**（`upstream_changed`） |
 * | 删了 | 改了 | **冲突**（`upstream_removed`）；你也隐藏了 = 干净 |
 * | — | 你自己加的 | 干净（`keep`）；id 正好和上游新加的撞了 → 冲突（`id_clash`） |
 * | 改了 | 只是照抄了旧版（没真改） | 跟新版走，不问人（`follow_new`） |
 */
export function planItemMerge<V = unknown>(
  before: readonly MergeItem<V>[],
  after: readonly MergeItem<V>[],
  edits: readonly ItemUserEdit<V>[],
): ItemMergePlan<V> {
  const old = new Map(before.map((i) => [i.id, i]))
  const now = new Map(after.map((i) => [i.id, i]))
  const upstream = {
    added: after.filter((i) => !old.has(i.id)).map((i) => i.id),
    changed: after
      .filter((i) => {
        const was = old.get(i.id)
        return was !== undefined && !sameValue(was.value, i.value)
      })
      .map((i) => i.id),
    removed: before.filter((i) => !now.has(i.id)).map((i) => i.id),
  }
  const plan: ItemMergePlan<V> = { clean: [], conflicts: [], upstream }
  const clean = (
    edit: ItemUserEdit<V>,
    resolution: ItemMergeClean<V>['resolution'],
    value_after?: V,
  ) =>
    plan.clean.push({ ...edit, resolution, ...(value_after === undefined ? {} : { value_after }) })
  const conflict = (edit: ItemUserEdit<V>, reason: ItemMergeConflict<V>['reason']) => {
    const was = old.get(edit.item_id)
    const is = now.get(edit.item_id)
    plan.conflicts.push({
      ...edit,
      reason,
      ...(was === undefined ? {} : { base_before: was.value }),
      ...(is === undefined ? {} : { base_after: is.value }),
      ...(edit.op === 'hide' || edit.value === undefined ? {} : { mine: edit.value }),
    })
  }
  for (const edit of edits) {
    const was = old.get(edit.item_id)
    const is = now.get(edit.item_id)
    if (edit.op === 'add' || was === undefined) {
      // 你自己加的：上游从来没有这一条。只有上游这一版正好新加了同一个 id 才要人看
      if (is !== undefined && !sameValue(is.value, edit.value)) conflict(edit, 'id_clash')
      else clean(edit, 'keep')
      continue
    }
    if (is === undefined) {
      // 上游把这一条删了：你也隐藏了就一致，改过的要人选
      if (edit.op === 'hide') clean(edit, 'keep')
      else conflict(edit, 'upstream_removed')
      continue
    }
    if (sameValue(was.value, is.value)) {
      clean(edit, 'keep')
      continue
    }
    if (edit.op === 'hide') {
      conflict(edit, 'upstream_changed')
      continue
    }
    if (sameValue(edit.value, is.value)) {
      clean(edit, 'same')
      continue
    }
    if (sameValue(edit.value, was.value)) {
      clean(edit, 'follow_new')
      continue
    }
    if (
      typeof edit.value === 'string' &&
      typeof was.value === 'string' &&
      typeof is.value === 'string'
    ) {
      const base = was.value.trimEnd()
      if (edit.value.startsWith(base) && edit.value.length > base.length) {
        const appended = edit.value.slice(base.length)
        clean(edit, 'rebase', `${is.value.trimEnd()}${appended}` as V)
        continue
      }
    }
    conflict(edit, 'upstream_changed')
  }
  return plan
}

/** 按条冲突的稳定键（同一版、同一条、同一层同一主人只问一次）。 */
export function itemConflictKey(
  table: string,
  version: string,
  c: Pick<ItemUserEdit, 'tier' | 'owner' | 'item_id'>,
): string {
  return [table, version, c.tier, c.owner, c.item_id].join('|')
}
