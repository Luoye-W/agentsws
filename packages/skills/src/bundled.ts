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
import { splitFrontmatter } from './frontmatter.js'
import type { MemorySkillRegistry } from './registry.js'

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

// ---------- WP162：自带技能入库 ----------

/**
 * 自带技能的版本：frontmatter 里的 `version`。没写就是 `1.0`——`customer-care`
 * 那一份从 WP29 起一直按 `1.0` 入库，正文一个字没改，版本也不改（改了会让已有的
 * overlay 的 `base_version` 对不上）。
 */
export const BUNDLED_DEFAULT_VERSION = '1.0'

export function bundledSkillVersion(markdown: string): string {
  const v = splitFrontmatter(markdown).frontmatter.extra.version?.trim()
  return v === undefined || v === '' ? BUNDLED_DEFAULT_VERSION : v
}

/**
 * 两个版本号比大小（`1.0` / `1.0.0` / `1.2.10`，按点切开逐段比数字；缺的段当 0）。
 * 不是数字的段按字符串比——自带技能只会写数字版本，这一支只是不让它抛。
 */
export function compareSkillVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'
    const y = pb[i] ?? '0'
    const nx = Number(x)
    const ny = Number(y)
    const d = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x < y ? -1 : x > y ? 1 : 0
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export interface SeedBundledResult {
  /** 头一回入库的。 */
  seeded: string[]
  /** 包里的版本新了、换掉了包层的。 */
  replaced: string[]
  /** 包层已经是这个版本（或更新）的，没动。 */
  skipped: string[]
}

/**
 * 把 `bundled/<name>/SKILL.md` 按**包基础层**（`tier: 'package'`、`owner: 'package'`）种进技能库。
 *
 * - 包层里还没有 → 入库；
 * - 包层里有、版本相同（或库里的更新）→ 跳过；
 * - 包里的版本新了 → **只换包层**。公司 / 部门 / 岗位 / 职责 / 个人那几层的记录与覆盖
 *   一律不碰——它们叠在包层上面，`resolve` 时照旧压上去（段 id 按标题对齐，见 `putFromMarkdown`）。
 *
 * 包层不分工作区：`resolve` 取包层时本来就不看工作区（`#lookup` 对 `package` 按名字兜底扫），
 * 所以种一次，这个进程里每个工作区都读得到。之前按工作区种过的那一份（WP29 的 `customer-care`）
 * 原样认得：版本新了就在它原来的位置上换。
 */
export async function seedBundledSkills(
  registry: MemorySkillRegistry,
  options: { dir?: string } = {},
): Promise<SeedBundledResult> {
  const dir = options.dir ?? BUNDLED_SKILLS_DIR
  const out: SeedBundledResult = { seeded: [], replaced: [], skipped: [] }
  for (const name of listBundledSkills(dir)) {
    const skill = readBundledSkill(name, dir)
    const version = bundledSkillVersion(skill.markdown)
    const existing = registry.peek(name, 'package')
    if (existing !== undefined && compareSkillVersions(version, existing.version) <= 0) {
      out.skipped.push(name)
      continue
    }
    await registry.putFromMarkdown({
      markdown: skill.markdown,
      tier: 'package',
      owner: 'package',
      version,
      evals: skill.evals.map((e) => e.id),
      source: { package: '@agentsws/skills', version },
      ...(existing?.workspace_id === undefined ? {} : { workspace_id: existing.workspace_id }),
    })
    ;(existing === undefined ? out.seeded : out.replaced).push(name)
  }
  return out
}

/**
 * WP162：职责 YAML 登记了、但**包里故意不带正文**的技能——正文从别处来。
 *
 * 规矩是「登记即要有正文」：职责 YAML 的 `skills:` 里每个名字，要么在 `bundled/` 里有一份，
 * 要么在这张表里写明正文从哪来、为什么包里不给（测试逐个扫，见
 * `packages/learning/test/skills-registered.test.ts`）。
 */
export const DYNAMIC_SKILL_SOURCES: Readonly<Record<string, string>> = {
  'brand-system':
    '公司层技能，由店主在设计岗那张「先设品牌系统」卡上写' +
    '（卡在 `packages/design-core/src/brand.ts` 的 `brandSystemMissingCard`；' +
    '服务端 `apps/server/src/server.ts` 的 `brandCards` 读 `listSections("brand-system")`）。' +
    '包里故意不给默认正文：有了默认正文，设计岗会以为这家店已经设过品牌系统，那张卡就不出了，' +
    '出图每张换一个风格。',
}
