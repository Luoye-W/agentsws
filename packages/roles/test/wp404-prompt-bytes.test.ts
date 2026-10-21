/**
 * WP404（docs/107 §12 一期 A）：**内容外置前后，喂给模型的字节一个都不许变**。
 *
 * 全部内置职责（58 条；WP446 加了 dtc.seo、WP447 加了六条投放新平台）× 中英：装出来的 persona 那几节（岗位 → 职责 → 回复语言 → 说话规矩，
 * 与 `assemblePrompt` 同一种拼法）逐字节取哈希，和外置之前记下的那一份比。另外三样一起钉：
 * 职责的「内容」字段、整份定义（骨架一个值都不许动）、岗位模板整份。
 *
 * 真要改提示词（不是挪地方）：`WP404_WRITE_FIXTURE=1 npx vitest run <本文件>` 重记，PR 里写明为什么。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  bundledPositionOfRole,
  houseRulesSection,
  loadBundledPositions,
  loadBundledRoles,
  type PersonaLang,
  personaSections,
  replyLanguageSection,
} from '../src/index.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/wp404-prompt-bytes.json', import.meta.url))

const hash = (v: unknown): string =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v), 'utf8')
    .digest('hex')
    .slice(0, 16)

type Role = ReturnType<typeof loadBundledRoles>[number]

function promptOf(role: Role, lang: PersonaLang): string {
  const position = bundledPositionOfRole(role.id)
  const sections = [
    ...personaSections({
      lang,
      ...(position === undefined
        ? {}
        : {
            position: {
              id: position.id,
              name: lang === 'zh' ? position.name.zh : position.name.en,
              persona: position.persona,
            },
          }),
      role: {
        id: role.id,
        name: lang === 'zh' ? role.name.zh : role.name.en,
        persona: role.persona,
      },
    }),
    replyLanguageSection(lang),
    houseRulesSection(lang),
  ]
  return sections
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((s) => `## ${s.id} ${s.name}\n${s.text}`)
    .join('\n\n')
}

function snapshot(): Record<string, unknown> {
  const roles: Record<string, unknown> = {}
  for (const r of loadBundledRoles()) {
    roles[r.id] = {
      zh: hash(promptOf(r, 'zh')),
      en: hash(promptOf(r, 'en')),
      content: hash({
        name: r.name,
        description: r.description,
        persona: r.persona,
        quick_prompts: r.quick_prompts ?? null,
        task_examples: r.task_examples ?? null,
        grounding: (r.grounding ?? []).map((g) => [g.name, g.intent_terms, g.cue_terms]),
      }),
      def: hash(r),
    }
  }
  const positions: Record<string, string> = {}
  for (const p of loadBundledPositions()) positions[p.id] = hash(p)
  return { roles, positions }
}

describe('WP404 喂给模型的字节（外置前后逐字节相同）', () => {
  it('全部职责 × 中英的 persona 段、内容字段、整份定义，以及全部岗位模板，与外置前一致', () => {
    const now = snapshot()
    if (process.env.WP404_WRITE_FIXTURE === '1' || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`, 'utf8')
    }
    const was = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
    expect(Object.keys(now.roles as object)).toHaveLength(58)
    expect(now).toEqual(was)
  })
})
