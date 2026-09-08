import type { SkillSection } from '@agentsws/contracts'
import { type Frontmatter, renderFrontmatter, splitFrontmatter } from './frontmatter.js'
import type { IdFactory } from './ids.js'
import { bodyHash, headingSimilarity, normalizeBody } from './text.js'

/** 06 §5.1：拆段是唯一需要人确认的结构变化，用 split_from 标出来。 */
export interface ParsedSection extends SkillSection {
  split_from?: string
}

/** 对齐用的“已知段”。sidecar 只有 heading + hash；内存里的 Skill 还带 body。 */
export interface KnownSection {
  id: string
  heading: string
  body_hash: string
  body?: string
  origin?: SkillSection['origin']
  learned_from?: SkillSection['learned_from']
}

export interface ParseResult {
  frontmatter: Frontmatter
  sections: ParsedSection[]
  /** 结构变化：一段被拆成多段（旧 id 归第一段） */
  splits: { from: string; sections: string[] }[]
}

/** 标题相似度阈值（24 §1 三级对齐的第三级）。 */
export const HEADING_SIMILARITY_THRESHOLD = 0.8

interface RawSection {
  heading: string
  body: string
}

const HEADING = /^##(?!#)\s*(.*)$/

/** 按 `##` 切段；代码围栏内的 `##` 不算标题。 */
export function splitSections(body: string): RawSection[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const out: RawSection[] = []
  let current: { heading: string; lines: string[] } = { heading: '', lines: [] }
  let fence: string | undefined
  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? ''
      if (fence === undefined) fence = marker[0]
      else if (marker[0] === fence) fence = undefined
      current.lines.push(line)
      continue
    }
    const m = fence === undefined ? HEADING.exec(line) : null
    if (m) {
      pushSection(out, current)
      current = { heading: (m[1] ?? '').trim(), lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  pushSection(out, current)
  return out
}

function pushSection(out: RawSection[], current: { heading: string; lines: string[] }): void {
  const text = normalizeBody(current.lines.join('\n'))
  if (current.heading === '' && text === '') return
  out.push({ heading: current.heading, body: text })
}

/**
 * 24 §1 段对齐：(a) 标题精确 → (b) 正文哈希 → (c) 标题相似度 > 0.8。
 * 保证改标题不改 id；一段拆两段时旧 id 给第一段，全组标 split_from。
 */
export function parseSkill(
  markdown: string,
  known: readonly KnownSection[] | undefined,
  nextId: IdFactory,
): ParseResult {
  const { frontmatter, body } = splitFrontmatter(markdown)
  const raws = splitSections(body)
  const pool = (known ?? []).map((k) => ({ ...k }))
  const used = new Set<string>()
  const claim = new Array<KnownSection | undefined>(raws.length)

  const norm = (h: string): string => h.trim().replace(/\s+/g, ' ')

  // (a) 标题精确匹配
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i]
    if (!raw) continue
    const hit = pool.find((k) => !used.has(k.id) && norm(k.heading) === norm(raw.heading))
    if (hit) {
      claim[i] = hit
      used.add(hit.id)
    }
  }
  // (b) 正文哈希匹配
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i]
    if (!raw || claim[i]) continue
    const h = bodyHash(raw.body)
    const hit = pool.find((k) => !used.has(k.id) && k.body_hash === h)
    if (hit) {
      claim[i] = hit
      used.add(hit.id)
    }
  }
  // (c) 标题相似度
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i]
    if (!raw || claim[i]) continue
    let best: KnownSection | undefined
    let bestScore = HEADING_SIMILARITY_THRESHOLD
    for (const k of pool) {
      if (used.has(k.id)) continue
      const score = headingSimilarity(k.heading, raw.heading)
      if (score > bestScore) {
        best = k
        bestScore = score
      }
    }
    if (best) {
      claim[i] = best
      used.add(best.id)
    }
  }

  const splitGroups = detectSplits(raws, claim, pool)

  const sections: ParsedSection[] = raws.map((raw, i) => {
    const k = claim[i]
    const section: ParsedSection = {
      id: k?.id ?? nextId(),
      heading: raw.heading,
      body: raw.body,
      origin: k?.origin ?? 'authored',
    }
    if (k?.learned_from) section.learned_from = k.learned_from
    return section
  })

  const splits: ParseResult['splits'] = []
  for (const [fromId, indices] of splitGroups) {
    const ordered = [...indices].sort((a, b) => a - b)
    for (let n = 0; n < ordered.length; n++) {
      const idx = ordered[n]
      if (idx === undefined) continue
      const section = sections[idx]
      if (!section) continue
      section.id = n === 0 ? fromId : section.id === fromId ? nextId() : section.id
      section.split_from = fromId
    }
    splits.push({
      from: fromId,
      sections: ordered.map((idx) => sections[idx]?.id ?? '').filter((s) => s !== ''),
    })
  }

  return { frontmatter, sections, splits }
}

/**
 * 拆段识别：某个已知段 K 被一段 S 认领，但 S 的正文只是 K 正文的一部分，
 * 而另一段没认领到 id 的正文也在 K 的正文里 → 认为 K 被拆开了。
 */
function detectSplits(
  raws: readonly RawSection[],
  claim: readonly (KnownSection | undefined)[],
  pool: readonly KnownSection[],
): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  const claimedIndex = new Map<string, number>()
  for (let i = 0; i < claim.length; i++) {
    const k = claim[i]
    if (k) claimedIndex.set(k.id, i)
  }
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i]
    if (!raw || claim[i]) continue
    const piece = normalizeBody(raw.body)
    if (piece === '') continue
    for (const k of pool) {
      const parent = k.body === undefined ? undefined : normalizeBody(k.body)
      if (parent === undefined || parent === '' || !parent.includes(piece)) continue
      const anchor = claimedIndex.get(k.id)
      if (anchor === undefined) continue
      const anchorBody = normalizeBody(raws[anchor]?.body ?? '')
      if (anchorBody === parent || anchorBody === '' || !parent.includes(anchorBody)) continue
      const group = groups.get(k.id) ?? [anchor]
      if (!group.includes(i)) group.push(i)
      groups.set(k.id, group)
      break
    }
  }
  return groups
}

/** 渲染回 Agent Skills markdown。 */
export function renderSkill(frontmatter: Frontmatter, sections: readonly SkillSection[]): string {
  const parts = [renderFrontmatter(frontmatter)]
  for (const s of sections) {
    parts.push(s.heading === '' ? s.body : `## ${s.heading}\n\n${s.body}`)
  }
  return `${parts.filter((p) => p.trim() !== '').join('\n\n')}\n`
}

export function toKnown(sections: readonly SkillSection[]): KnownSection[] {
  return sections.map((s) => {
    const k: KnownSection = {
      id: s.id,
      heading: s.heading,
      body_hash: bodyHash(s.body),
      body: s.body,
      origin: s.origin,
    }
    if (s.learned_from) k.learned_from = s.learned_from
    return k
  })
}
