/**
 * WP160：本包自带的技能正文（`bundled/<name>/SKILL.md`）。
 *
 * 职责 YAML 的 `skills:` 只登记名字；正文放在这里，谁要用就按名字读。
 * 这里只管**读**，不管叠加——叠加照旧走 {@link MemorySkillRegistry.putFromMarkdown}
 * 与 `resolve`（包基础层 → 公司 → 部门 → 岗位 → 职责 → 个人）。
 *
 * 附录不另放 `references/`：本包的解析器只读 SKILL.md 一个文件（按 `##` 切段），
 * 读不到的附录等于不存在，所以附录一律并进正文最后几段。
 *
 * 每个技能旁边有一份 `evals/evals.json`：考题 + 「技能正文里必须有的那句规矩」。
 * 不调模型，测试只查规矩在不在——没有那句规矩，模型答这道题就没有依据。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { invalidInput, notFound } from './errors.js'

/** 本包自带的技能目录（`bundled/<name>/SKILL.md`）。 */
export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../bundled/', import.meta.url))

/** 考题的种类：出卡 / 数字不编 / 合规 / 判断。 */
export type BundledSkillEvalKind = 'approval' | 'numbers' | 'compliance' | 'judgment'

export interface BundledSkillEval {
  id: string
  kind: BundledSkillEvalKind
  /** 改写自上游哪一道题（或哪一条规矩）。 */
  from?: string
  prompt: string
  expected: string
  /** 技能正文里必须逐字出现的片段。 */
  must_include: string[]
}

export interface BundledSkill {
  name: string
  markdown: string
  evals: BundledSkillEval[]
}

const NAME = /^[a-z0-9][a-z0-9-]*$/

/** 自带了哪些技能（目录名，排序）。 */
export function listBundledSkills(dir: string = BUNDLED_SKILLS_DIR): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && NAME.test(d.name) && existsSync(join(dir, d.name, 'SKILL.md')),
    )
    .map((d) => d.name)
    .sort()
}

/** 按名字读一份自带技能（正文 + 考题）。没有就抛 `not_found`。 */
export function readBundledSkill(name: string, dir: string = BUNDLED_SKILLS_DIR): BundledSkill {
  if (!NAME.test(name)) throw invalidInput(`非法技能名：${name}`)
  const path = join(dir, name, 'SKILL.md')
  if (!existsSync(path)) throw notFound(`没有自带技能：${name}`)
  const markdown = readFileSync(path, 'utf8')
  const evalsPath = join(dir, name, 'evals', 'evals.json')
  const evals = existsSync(evalsPath) ? parseEvals(readFileSync(evalsPath, 'utf8'), name) : []
  return { name, markdown, evals }
}

function parseEvals(text: string, name: string): BundledSkillEval[] {
  const raw: unknown = JSON.parse(text)
  const list = (raw as { evals?: unknown }).evals
  if (!Array.isArray(list)) throw invalidInput(`${name} 的 evals.json 缺少 evals 数组`)
  return list.map((e: unknown) => {
    const v = e as Partial<BundledSkillEval>
    if (
      typeof v.id !== 'string' ||
      typeof v.prompt !== 'string' ||
      typeof v.expected !== 'string' ||
      !Array.isArray(v.must_include) ||
      !['approval', 'numbers', 'compliance', 'judgment'].includes(String(v.kind))
    ) {
      throw invalidInput(`${name} 的 evals.json 有一条格式不对`, e)
    }
    return {
      id: v.id,
      kind: v.kind as BundledSkillEvalKind,
      ...(typeof v.from === 'string' ? { from: v.from } : {}),
      prompt: v.prompt,
      expected: v.expected,
      must_include: v.must_include.map(String),
    }
  })
}

/**
 * 技能文本里**不许**出现的授权字样（WP160 改写规矩第一条）。
 *
 * 发送 / 发布 / 花钱 / 上传一律出卡等人批；自动化能到哪一档只由职责 YAML 的
 * `automation` 说了算。技能是给模型读的，一句「授权后可自动执行」就足以让它越过卡片——
 * 所以连否定句也不写这些字样（「不许自动发送」照样会被断章取义），换一种说法。
 */
export const SKILL_AUTHORIZATION_PHRASES: readonly string[] = [
  '自动发送',
  '自动发布',
  '直接上传',
  '直接发送',
  '直接发布',
  '批量上传',
  '排期自动发',
  '授权后可自动',
  '无需审批',
  '不用审批',
  '免审批',
  'without approval',
  'auto-send',
  'auto-publish',
  'auto-post',
  'bulk upload',
  'upload directly',
]

/** 技能文本里命中了哪些授权字样（大小写不敏感）。 */
export function findAuthorizationPhrases(markdown: string): string[] {
  const lower = markdown.toLowerCase()
  return SKILL_AUTHORIZATION_PHRASES.filter((p) => lower.includes(p.toLowerCase()))
}
