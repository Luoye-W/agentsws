import type {
  Overlay,
  OverlayOp,
  PersonId,
  ResolvedSkill,
  Skill,
  SkillRegistry,
  SkillSection,
  SkillTier,
  WorkspaceId,
} from '@agentsws/contracts'
import { invalidInput, notFound } from './errors.js'
import type { Frontmatter } from './frontmatter.js'
import type { IdFactory } from './ids.js'
import { type KnownSection, type ParsedSection, parseSkill, renderSkill, toKnown } from './parse.js'
import { mergeKnown, type Sidecar, type SidecarStore, sidecarToKnown } from './sidecar.js'
import { bodyHash } from './text.js'

export const TIER_ORDER: readonly SkillTier[] = ['package', 'company', 'department', 'personal']

export interface SkillScopeRef {
  workspace_id?: WorkspaceId
  scope_id?: string
  owner?: PersonId
}

export interface Actor {
  person_id: PersonId
  workspace_id: WorkspaceId
  department_id?: string
}

/** 契约 OverlayOp 已带 origin / learned_from（06 §3.4）；保留别名以免改动调用处。 */
export type OverlayOpEx = OverlayOp
export interface OverlayEx extends Overlay {
  ops: OverlayOpEx[]
}

/** 契约 conflicts 的扩展：两版正文都留着，人二选一（24 §1 不自动合）。 */
export interface SkillConflict {
  section_id: string
  tiers: SkillTier[]
  heading?: string
  versions: { tier: SkillTier; base_version: string; body: string }[]
}

export interface ResolvedSkillEx extends ResolvedSkill {
  sections: ParsedSection[]
  conflicts: SkillConflict[]
  /** 指向不存在段的 overlay 操作（上游删了段）——跳过但要能看见 */
  unresolved_ops: { tier: SkillTier; op: OverlayOpEx }[]
  base: { tier: SkillTier; version: string }
}

export interface PutFromMarkdownInput {
  markdown: string
  tier: SkillTier
  owner: PersonId | 'package'
  version: string
  base?: { tier: SkillTier; version: string }
  evals?: string[]
  source?: { package: string; version: string }
  workspace_id?: WorkspaceId
  scope_id?: string
}

export interface RebaseResult {
  rebased: OverlayEx[]
  conflicts: SkillConflict[]
}

const SEP = '::'

export class MemorySkillRegistry {
  readonly #skills = new Map<string, Skill>()
  readonly #history = new Map<string, Skill[]>()
  readonly #frontmatter = new Map<string, Frontmatter>()
  readonly #overlays = new Map<string, OverlayEx>()
  readonly #excluded = new Map<PersonId, Set<string>>()
  readonly #sidecar: SidecarStore
  readonly #nextId: IdFactory

  constructor(sidecar: SidecarStore, nextId: IdFactory) {
    this.#sidecar = sidecar
    this.#nextId = nextId
  }

  // ---------- 存取 ----------

  async put(skill: Skill): Promise<void> {
    const key = this.#keyOf(skill.name, skill.tier, skill)
    const known = this.#knownFor(skill.name, key)
    const sections: SkillSection[] = skill.sections.map((s) => {
      if (s.id !== undefined && s.id !== '') return { ...s }
      const hash = bodyHash(s.body)
      const hit =
        known.find((k) => k.heading.trim() === s.heading.trim()) ??
        known.find((k) => k.body_hash === hash)
      return { ...s, id: hit?.id ?? this.#nextId() }
    })
    const stored: Skill = { ...skill, sections }
    this.#skills.set(key, stored)
    const hist = this.#history.get(key) ?? []
    hist.push(stored)
    this.#history.set(key, hist)
    this.#writeSidecar(skill.name, sections)
  }

  /** 解析 markdown 并入库；段 id 与该 skill 已有各层 + sidecar 对齐。 */
  async putFromMarkdown(input: PutFromMarkdownInput): Promise<{ skill: Skill; splits: string[] }> {
    const probe: SkillScopeRef = {
      ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
      ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
      ...(input.owner === 'package' ? {} : { owner: input.owner }),
    }
    const declared = /^\s*---[\s\S]*?\n[ \t]*name[ \t]*:[ \t]*(.+)$/m
      .exec(input.markdown)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '')
    if (declared === undefined || declared === '') {
      throw invalidInput('Agent Skills frontmatter 缺少 name')
    }
    const known = this.#knownFor(declared, this.#keyOf(declared, input.tier, probe))
    const result = parseSkill(input.markdown, known, this.#nextId)
    const skill: Skill = {
      name: result.frontmatter.name,
      tier: input.tier,
      owner: input.owner,
      version: input.version,
      sections: result.sections,
      evals: input.evals ?? [],
      ...(input.base === undefined ? {} : { base: input.base }),
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
      ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
    }
    await this.put(skill)
    this.#frontmatter.set(this.#keyOf(skill.name, skill.tier, skill), result.frontmatter)
    return { skill, splits: result.splits.map((s) => s.from) }
  }

  async get(name: string, tier: SkillTier, scope?: SkillScopeRef): Promise<Skill | undefined> {
    return this.#lookup(name, tier, scope ?? {})
  }

  /** 契约 parse()：段 id 由系统分配（隐藏 ULID），按标题切段。 */
  parse(markdown: string, existing?: SkillSection[]): ParsedSection[] {
    return this.parseDocument(markdown, existing).sections
  }

  parseDocument(markdown: string, existing?: SkillSection[]): ReturnType<typeof parseSkill> {
    const known = existing === undefined ? undefined : toKnown(existing)
    return parseSkill(markdown, known, this.#nextId)
  }

  // ---------- overlay ----------

  async setOverlay(overlay: OverlayEx): Promise<OverlayEx> {
    const key = this.#overlayKey(overlay.skill, overlay.tier, overlay.owner)
    const prev = this.#overlays.get(key)
    const next: OverlayEx = {
      ...overlay,
      ops: overlay.ops.map((op) => ({ ...op })),
      version: (prev?.version ?? 0) + 1,
    }
    this.#overlays.set(key, next)
    return next
  }

  getOverlay(skill: string, tier: SkillTier, owner: string): OverlayEx | undefined {
    const o = this.#overlays.get(this.#overlayKey(skill, tier, owner))
    return o === undefined ? undefined : { ...o, ops: o.ops.map((op) => ({ ...op })) }
  }

  listOverlays(skill: string): OverlayEx[] {
    return [...this.#overlays.values()].filter((o) => o.skill === skill)
  }

  /** 下沉：上游出新版 → overlay 的 base_version 更新到上游当前版本，冲突段收集。 */
  async rebase(
    name: string,
    tier: SkillTier,
    opts: { owner?: string; scope?: SkillScopeRef } = {},
  ): Promise<RebaseResult> {
    const upstream = this.#upstreamOf(name, tier, opts.scope ?? {})
    if (upstream === undefined) throw notFound(`没有 ${name} 的上游版本可 rebase`)
    const owner = opts.owner
    const targets = [...this.#overlays.values()].filter(
      (o) => o.skill === name && o.tier === tier && (owner === undefined || o.owner === owner),
    )
    const history = this.#history.get(this.#keyOf(name, upstream.tier, upstream)) ?? []
    const rebased: OverlayEx[] = []
    const conflicts: SkillConflict[] = []
    for (const overlay of targets) {
      const old = history.find((h) => h.version === overlay.base_version)
      for (const op of overlay.ops) {
        if (op.op === 'append') continue
        const now = upstream.sections.find((s) => s.id === op.section_id)
        const before = old?.sections.find((s) => s.id === op.section_id)
        const changedUpstream = old === undefined || before?.body !== now?.body
        if (!changedUpstream) continue
        conflicts.push({
          section_id: op.section_id,
          tiers: [upstream.tier, overlay.tier],
          ...(now === undefined ? {} : { heading: now.heading }),
          versions: [
            { tier: upstream.tier, base_version: upstream.version, body: now?.body ?? '' },
            { tier: overlay.tier, base_version: overlay.base_version, body: op.body ?? '' },
          ],
        })
      }
      const next: OverlayEx = {
        ...overlay,
        base_version: upstream.version,
        version: overlay.version + 1,
        ops: overlay.ops.map((op) => ({ ...op })),
      }
      this.#overlays.set(this.#overlayKey(next.skill, next.tier, next.owner), next)
      rebased.push(next)
    }
    return { rebased, conflicts }
  }

  // ---------- 排除 ----------

  async exclude(name: string, person_id: PersonId, excluded: boolean): Promise<void> {
    const set = this.#excluded.get(person_id) ?? new Set<string>()
    if (excluded) set.add(name)
    else set.delete(name)
    this.#excluded.set(person_id, set)
  }

  isExcluded(name: string, person_id: PersonId): boolean {
    return this.#excluded.get(person_id)?.has(name) ?? false
  }

  // ---------- 叠加解析 ----------

  /** 包基础版 → 公司 → 部门 → 个人；被本人排除的 skill 返回 undefined（24 §6.7）。 */
  async resolve(name: string, actor: Actor): Promise<ResolvedSkillEx | undefined> {
    if (this.isExcluded(name, actor.person_id)) return undefined

    const layers = TIER_ORDER.map((tier) => ({
      tier,
      skill: this.#lookup(name, tier, this.#scopeFor(tier, actor)),
      overlay: this.getOverlay(name, tier, this.#ownerFor(tier, actor)),
    }))
    const baseLayer = layers.find((l) => l.skill !== undefined)
    const baseSkill = baseLayer?.skill
    if (baseLayer === undefined || baseSkill === undefined) throw notFound(`未找到 skill：${name}`)
    const baseIdx = layers.indexOf(baseLayer)

    const sections: ParsedSection[] = baseSkill.sections.map((s) => ({ ...s }))
    const layersApplied: SkillTier[] = [baseLayer.tier]
    const unresolved: ResolvedSkillEx['unresolved_ops'] = []
    const replaced = new Map<string, SkillConflict['versions']>()
    const upstreamVersion = baseSkill.version

    for (let i = baseIdx + 1; i < layers.length; i++) {
      const layer = layers[i]
      if (layer === undefined) continue
      let touched = false
      if (layer.skill !== undefined) {
        const layerBase = layer.skill.base?.version ?? layer.skill.version
        for (const s of layer.skill.sections) {
          const idx = sections.findIndex((x) => x.id === s.id)
          if (idx < 0) {
            sections.push({ ...s })
            touched = true
            continue
          }
          const cur = sections[idx]
          if (cur !== undefined && cur.body !== s.body) {
            record(replaced, s.id, { tier: layer.tier, base_version: layerBase, body: s.body })
            sections[idx] = { ...cur, ...s }
            touched = true
          }
        }
      }
      if (layer.overlay !== undefined) {
        for (const op of layer.overlay.ops) {
          const idx = sections.findIndex((x) => x.id === op.section_id)
          const cur = idx < 0 ? undefined : sections[idx]
          if (cur === undefined) {
            unresolved.push({ tier: layer.tier, op })
            continue
          }
          if (op.op === 'remove') {
            sections.splice(idx, 1)
            touched = true
            continue
          }
          const body =
            op.op === 'replace' ? (op.body ?? '') : `${cur.body}\n\n${op.body ?? ''}`.trim()
          if (op.op === 'replace') {
            record(replaced, op.section_id, {
              tier: layer.tier,
              base_version: layer.overlay.base_version,
              body,
            })
          }
          const next: ParsedSection = { ...cur, body, origin: op.origin ?? cur.origin }
          if (op.learned_from !== undefined) next.learned_from = op.learned_from
          sections[idx] = next
          touched = true
        }
      }
      if (touched) layersApplied.push(layer.tier)
    }

    const conflicts: SkillConflict[] = []
    for (const [section_id, versions] of replaced) {
      const tiers = [...new Set(versions.map((v) => v.tier))]
      if (tiers.length < 2) continue
      if (versions.every((v) => v.base_version === upstreamVersion)) continue
      const heading = sections.find((s) => s.id === section_id)?.heading
      conflicts.push({
        section_id,
        tiers,
        ...(heading === undefined ? {} : { heading }),
        versions,
      })
    }

    const fm: Frontmatter = this.#frontmatter.get(this.#keyOf(name, baseLayer.tier, baseSkill)) ?? {
      name: baseSkill.name,
      extra: {},
      order: [],
    }

    return {
      name,
      markdown: renderSkill(fm, sections),
      sections,
      layers_applied: layersApplied,
      conflicts,
      unresolved_ops: unresolved,
      base: { tier: baseLayer.tier, version: baseSkill.version },
    }
  }

  /** 学习回路的策略层过滤要用：按段 id 反查标题。 */
  sectionHeading(name: string, section_id: string): string | undefined {
    for (const skill of this.#skills.values()) {
      if (skill.name !== name) continue
      const hit = skill.sections.find((s) => s.id === section_id)
      if (hit !== undefined) return hit.heading
    }
    return this.#sidecar.read(name)?.sections.find((s) => s.id === section_id)?.heading
  }

  // ---------- 内部 ----------

  #scopeFor(tier: SkillTier, actor: Actor): SkillScopeRef {
    switch (tier) {
      case 'package':
        return {}
      case 'company':
        return { workspace_id: actor.workspace_id }
      case 'department':
        return {
          workspace_id: actor.workspace_id,
          ...(actor.department_id === undefined ? {} : { scope_id: actor.department_id }),
        }
      default:
        return { workspace_id: actor.workspace_id, owner: actor.person_id }
    }
  }

  #ownerFor(tier: SkillTier, actor: Actor): string {
    switch (tier) {
      case 'package':
        return 'package'
      case 'company':
        return actor.workspace_id
      case 'department':
        return actor.department_id ?? actor.workspace_id
      default:
        return actor.person_id
    }
  }

  #keyOf(name: string, tier: SkillTier, scope: SkillScopeRef): string {
    const ws = scope.workspace_id ?? ''
    const sc = tier === 'department' ? (scope.scope_id ?? '') : ''
    const ow = tier === 'personal' ? (scope.owner ?? '') : ''
    return [name, tier, ws, sc, ow].join(SEP)
  }

  #lookup(name: string, tier: SkillTier, scope: SkillScopeRef): Skill | undefined {
    const exact = this.#skills.get(this.#keyOf(name, tier, scope))
    if (exact !== undefined) return exact
    if (tier === 'package') {
      for (const s of this.#skills.values()) if (s.name === name && s.tier === tier) return s
      return undefined
    }
    const { workspace_id: _drop, ...rest } = scope
    return this.#skills.get(this.#keyOf(name, tier, rest))
  }

  /**
   * 最近的上游层。overlay 不带 workspace / scope，所以精确查不到时按 name 兜底扫描
   * （给定 scope 时仍按 workspace 收窄，避免跨工作区取错版本）。
   */
  #upstreamOf(name: string, tier: SkillTier, scope: SkillScopeRef): Skill | undefined {
    const target = TIER_ORDER.indexOf(tier)
    for (let i = target - 1; i >= 0; i--) {
      const t = TIER_ORDER[i]
      if (t === undefined) continue
      const hit = this.#lookup(name, t, scope)
      if (hit !== undefined) return hit
    }
    for (let i = target - 1; i >= 0; i--) {
      const t = TIER_ORDER[i]
      if (t === undefined) continue
      for (const s of this.#skills.values()) {
        if (s.name !== name || s.tier !== t) continue
        if (scope.workspace_id !== undefined && s.workspace_id !== scope.workspace_id) continue
        return s
      }
    }
    return undefined
  }

  #overlayKey(skill: string, tier: SkillTier, owner: string): string {
    return [skill, tier, owner].join(SEP)
  }

  #knownFor(name: string, preferredKey: string): KnownSection[] {
    const ordered: Skill[] = []
    const self = this.#skills.get(preferredKey)
    if (self !== undefined) ordered.push(self)
    for (const t of TIER_ORDER) {
      for (const [key, skill] of this.#skills) {
        if (skill.name !== name || skill.tier !== t || key === preferredKey) continue
        ordered.push(skill)
      }
    }
    let known: KnownSection[] = []
    for (const skill of ordered) known = mergeKnown(known, toKnown(skill.sections))
    return mergeKnown(known, sidecarToKnown(this.#sidecar.read(name)))
  }

  #writeSidecar(name: string, sections: readonly SkillSection[]): void {
    const prev = this.#sidecar.read(name)
    const entries = new Map((prev?.sections ?? []).map((e) => [e.id, { ...e }]))
    for (const s of sections) {
      entries.set(s.id, { id: s.id, heading: s.heading, body_hash: bodyHash(s.body) })
    }
    const sidecar: Sidecar = { skill: name, sections: [...entries.values()] }
    this.#sidecar.write(sidecar)
  }
}

function record(
  map: Map<string, SkillConflict['versions']>,
  section_id: string,
  entry: { tier: SkillTier; base_version: string; body: string },
): void {
  const list = map.get(section_id) ?? []
  list.push(entry)
  map.set(section_id, list)
}

/**
 * 契约一致性：除 resolve（本包允许返回 undefined 以支持"排除"，见报告）
 * 之外与 SkillRegistry 同形。
 */
export type RegistryConformsToContract =
  MemorySkillRegistry extends Omit<SkillRegistry, 'resolve'> ? true : false
