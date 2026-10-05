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
