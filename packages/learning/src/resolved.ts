/**
 * 「下次运行用新版本」这一步（38 §2 WP29 的最后一环）。
 *
 * 技能的正文要真的进 prompt，回路才算闭上：否则采纳只是改了一份没人读的文档。
 * 契约的 `RunRequest.skills` 只有名字（`SkillRef`），正文没有落脚点——本函数把
 * `SkillRegistry.resolve` 出来的每个技能变成一段 `PromptSection`，由宿主拼进
 * `persona.sections`。**不改契约**：persona 段本来就是"静态前缀里的说明文字"。
 *
 * 排序固定（`order` 40 起、按技能名排），所以静态前缀字节稳定，
 * `prompt_replayable` 不变量照样过。
 */
import type { PersonId, PromptSection, SkillRef, WorkspaceId } from '@agentsws/contracts'
import { splitFrontmatter } from '@agentsws/skills'

/** persona 段里技能正文的起始 order：排在公司（10）/ 职责（20）/ 围栏（30）之后。 */
export const SKILL_SECTION_ORDER = 40

/**
 * 解析技能时的"我是谁"。
 *
 * WP69（54 §1）多了两格：`position_id` / `role_id`——六层叠加里中间那两层按它们取。
 * 两个都可选：不给就是那一层没有东西可叠（老调用方一个字不用改）。
 */
export interface SkillPromptActor {
  person_id: PersonId
  workspace_id: WorkspaceId
  department_id?: string
  position_id?: string
  role_id?: string
}

export interface SkillResolver {
  resolve(
    name: string,
    actor: SkillPromptActor,
  ): Promise<{ name: string; markdown: string } | undefined>
}

export interface SkillPromptInput {
  skills: readonly SkillRef[]
  actor: SkillPromptActor
  registry: SkillResolver
}

/**
 * 解析每个 `load: 'always'` 的技能，产出 persona 段。
 * 被本人排除的技能（`resolve` 回 undefined）自然就不进 prompt（24 §6.7）。
 */
export async function skillPromptSections(input: SkillPromptInput): Promise<PromptSection[]> {
  const names = [...new Set(input.skills.filter((s) => s.load !== 'on_demand').map((s) => s.name))]
  names.sort()
  const out: PromptSection[] = []
  let i = 0
  for (const name of names) {
    let resolved: { name: string; markdown: string } | undefined
    try {
      resolved = await input.registry.resolve(name, input.actor)
    } catch {
      // 技能不在库里不该让整次运行失败：没有就当没有（prompt 里少一段）
      resolved = undefined
    }
    if (resolved === undefined || resolved.markdown.trim() === '') continue
    out.push({
      id: `skill_${name}`,
      name,
      order: SKILL_SECTION_ORDER + i,
      text: resolved.markdown.trim(),
    })
    i += 1
  }
  return out
}

// ---------- WP162：按需技能 ----------

/**
 * persona 里「可用技能索引」那一段的 order：排在全部 always 技能正文（40 起）之后。
 * 索引说的是「还有哪几本没放进来」，读完正文再看它，顺序上最自然。
 */
export const SKILL_INDEX_ORDER = 90

/** 索引里的一行：技能名 + frontmatter 的 `description`（压成一行）。 */
export interface SkillIndexEntry {
  name: string
  description: string
}

/** 这次运行登记了的技能名（`always` 与 `on_demand` 都算，去重、排序）。 */
export function registeredSkillNames(skills: readonly SkillRef[]): string[] {
  return [...new Set(skills.map((s) => s.name))].sort()
}

async function resolveQuietly(
  registry: SkillResolver,
  name: string,
  actor: SkillPromptActor,
): Promise<{ name: string; markdown: string } | undefined> {
  try {
    const r = await registry.resolve(name, actor)
    return r === undefined || r.markdown.trim() === '' ? undefined : r
  } catch {
    // 库里没有这一本：当没有（索引里不列，读也读不到），不让整次运行失败
    return undefined
  }
}

function descriptionOf(markdown: string): string {
  try {
    const d = splitFrontmatter(markdown).frontmatter.description ?? ''
    return d.replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

/**
 * 本次运行这条职责登记的**按需**技能：名字 + 一句说明。
 *
 * 只列 `resolve` 得出正文的那几本——库里没有的、被本人排除的，列出来也读不到，
 * 就不列（模型不该看见调不动的东西）。排序按名字，字节稳定（`prompt_replayable`）。
 *
 * 以后「这条职责这家店多挂一个技能」只需要往 `skills` 里多加一个名字：这里与
 * {@link readSkillForRun} 读的是同一份清单，不另有登记处。
 */
export async function onDemandSkillIndex(input: SkillPromptInput): Promise<SkillIndexEntry[]> {
  const names = [
    ...new Set(input.skills.filter((s) => s.load === 'on_demand').map((s) => s.name)),
  ].sort()
  const out: SkillIndexEntry[] = []
  for (const name of names) {
    const resolved = await resolveQuietly(input.registry, name, input.actor)
    if (resolved === undefined) continue
    out.push({ name, description: descriptionOf(resolved.markdown) })
  }
  return out
}

/**
 * 索引 → persona 段。没有一本可读就回 `undefined`（整段不出，不注一个空节）。
 *
 * `tool` 是读技能那个工具的名字（`@agentsws/stand-ins` 的 `READ_SKILL_TOOL`），由调用方传进来：
 * 本包不认识运行时的工具面。
 */
export function skillIndexSection(
  entries: readonly SkillIndexEntry[],
  tool: string,
): PromptSection | undefined {
  if (entries.length === 0) return undefined
  const lines = entries.map((e) =>
    e.description === '' ? `- ${e.name}` : `- ${e.name}：${e.description}`,
  )
  return {
    id: 'skill_index',
    name: '可用技能',
    order: SKILL_INDEX_ORDER,
    text: [
      `这条职责还有下面几本技能手册，这次没有整本放进来。碰到对应的事，先用 ${tool} 按名字读那一本，再动手；读到的是这家公司现在用的版本。`,
      ...lines,
    ].join('\n'),
  }
}

/** {@link readSkillForRun} 的结果。 */
export type ReadSkillResult =
  | { status: 'ok'; name: string; markdown: string }
  /** 这条职责没登记这个名字。 */
  | { status: 'not_registered'; name: string }
  /** 登记了，但读不到：库里没有正文，或者被本人排除了。 */
  | { status: 'unavailable'; name: string }

/**
 * `read_skill(name)` 的判定与取正文（纯逻辑，三个运行时共用服务端那一个执行器）。
 *
 * 1. 名字必须是**本次运行登记了的**（`skills` 就是这次 RunRequest 的 `skills`，
 *    即这条职责——岗位入口的话是被路由到的那一条——的 effective skills）；
 * 2. 正文是六层叠加完的那一份（`resolve`，与 always 技能进 persona 是同一个口）；
 * 3. 被本人排除的照旧读不到（`resolve` 回 `undefined`）。
 */
export async function readSkillForRun(input: {
  name: string
  skills: readonly SkillRef[]
  actor: SkillPromptActor
  registry: SkillResolver
}): Promise<ReadSkillResult> {
  const name = input.name.trim()
  if (!registeredSkillNames(input.skills).includes(name)) return { status: 'not_registered', name }
  const resolved = await resolveQuietly(input.registry, name, input.actor)
  if (resolved === undefined) return { status: 'unavailable', name }
  return { status: 'ok', name, markdown: resolved.markdown.trim() }
}
