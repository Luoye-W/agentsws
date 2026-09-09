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

/** persona 段里技能正文的起始 order：排在公司（10）/ 职责（20）/ 围栏（30）之后。 */
export const SKILL_SECTION_ORDER = 40

export interface SkillResolver {
  resolve(
    name: string,
    actor: { person_id: PersonId; workspace_id: WorkspaceId; department_id?: string },
  ): Promise<{ name: string; markdown: string } | undefined>
}

export interface SkillPromptInput {
  skills: readonly SkillRef[]
  actor: { person_id: PersonId; workspace_id: WorkspaceId; department_id?: string }
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
