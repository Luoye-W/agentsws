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
import { type Frontmatter, renderFrontmatter, splitFrontmatter } from './frontmatter.js'
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
  const meta = readOfficialSkillMeta(name, dir)
  const markdown =
    meta === undefined ? readFileSync(path, 'utf8') : composeOfficialSkill(name, meta, dir)
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
 * 自带技能的版本：frontmatter 里的 `version`。没写就是 `1.0`——与 WP29 起服务端那份
 * 三段 `customer-care`（没写版本、按 `1.0` 入库）同一个口径，新版只要写得比它高就会替换。
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
    '公司层技能，由负责人在设计岗那张「先设品牌系统」卡上写' +
    '（卡在 `packages/design-core/src/brand.ts` 的 `brandSystemMissingCard`；' +
    '服务端 `apps/server/src/server.ts` 的 `brandCards` 读 `listSections("brand-system")`）。' +
    '包里故意不给默认正文：有了默认正文，设计岗会以为这家店已经设过品牌系统，那张卡就不出了，' +
    '出图每张换一个风格。',
}

// ---------- WP216：平台官方技能（原样收录 + 旁注） ----------

/** 旁注文件名：有它的目录就是「官方原样收录」的技能。 */
export const OFFICIAL_META_FILE = 'agentsws.json'

/**
 * 官方技能的旁注（`bundled/<name>/agentsws.json`）。
 *
 * 官方文件（`SKILL.md`、`references/*.md`、`LICENSE`）**一个字节都不改**——上游哈希写在这里，
 * 测试逐个比；我们要加的东西（中文显示名、一句话、归哪个岗位、Agents 工坊的规矩）全在旁注与
 * `preamble` 那份文件里，入库时拼在一起（{@link composeOfficialSkill}）。
 */
export interface OfficialSkillMeta {
  kind: 'official'
  upstream: {
    publisher: string
    repo: string
    tag: string
    commit: string
    path: string
    license: string
  }
  /** 拼进 frontmatter 的我们这一侧的键（license / tier / version / display_name …）。 */
  frontmatter: Record<string, string>
  /** Agents 工坊规矩那一段的文件（相对技能目录）。 */
  preamble: string
  /** 收进来的官方参考（相对技能目录），按这个顺序拼在正文后面。 */
  references: string[]
  /** 每个原样收录的文件 → 上游 sha256。 */
  sha256: Record<string, string>
}

/** 这个技能有没有官方旁注；有就读出来（格式不对抛 `invalid_input`）。 */
export function readOfficialSkillMeta(
  name: string,
  dir: string = BUNDLED_SKILLS_DIR,
): OfficialSkillMeta | undefined {
  const path = join(dir, name, OFFICIAL_META_FILE)
  if (!existsSync(path)) return undefined
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<OfficialSkillMeta>
  if (
    raw.kind !== 'official' ||
    raw.upstream === undefined ||
    raw.frontmatter === undefined ||
    typeof raw.preamble !== 'string' ||
    !Array.isArray(raw.references) ||
    raw.sha256 === undefined
  ) {
    throw invalidInput(`${name} 的 ${OFFICIAL_META_FILE} 格式不对`)
  }
  return raw as OfficialSkillMeta
}

/** 官方技能拼进来时用的 frontmatter 键：官方的 name / description + 旁注里我们的键；官方的 hooks / metadata 不要。 */
const OFFICIAL_KEPT_KEYS = new Set(['name', 'description'])

/**
 * 把收进来的 Markdown 的标题降两级（`#` → `###`，`##` → `####`，最多到 `######`）。
 *
 * 为什么：本包按 `##` 切段，官方参考里自己的 `##` 会把一份参考切成十几段、段名还互相重复。
 * 降级之后每份参考是**一段**，段名是我们给的「官方参考：liquid」。代码块里的 `#`（TOML 注释、
 * shell 注释）不动——只在围栏外面降。文件本身不改，这只是拼的时候的排版。
 */
export function demoteHeadings(markdown: string): string {
  let fence: string | undefined
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const f = /^\s*(```+|~~~+)/.exec(line)
      if (f) {
        const marker = (f[1] ?? '')[0]
        if (fence === undefined) fence = marker
        else if (marker === fence) fence = undefined
        return line
      }
      if (fence !== undefined) return line
      const h = /^(#{1,6})(\s.*)?$/.exec(line)
      if (h === null) return line
      const level = Math.min(6, (h[1] ?? '').length + 2)
      return `${'#'.repeat(level)}${h[2] ?? ''}`
    })
    .join('\n')
}

/**
 * 官方技能入库的那一份：frontmatter（官方 name / description + 我们的键）→ 「Agents 工坊里怎么用」
 * → 官方正文（原样，标题降两级）→ 每份官方参考一段（原样，标题降两级）。
 */
export function composeOfficialSkill(
  name: string,
  meta: OfficialSkillMeta,
  dir: string = BUNDLED_SKILLS_DIR,
): string {
  const root = join(dir, name)
  const official = splitFrontmatter(readFileSync(join(root, 'SKILL.md'), 'utf8'))
  const extra: Record<string, string> = { ...meta.frontmatter }
  const fm: Frontmatter = {
    name: official.frontmatter.name,
    ...(official.frontmatter.description === undefined
      ? {}
      : { description: official.frontmatter.description }),
    extra,
    order: [
      ...official.frontmatter.order.filter((k) => OFFICIAL_KEPT_KEYS.has(k)),
      ...Object.keys(extra),
    ],
  }
  const preamble = readFileSync(join(root, meta.preamble), 'utf8').trim()
  const parts = [
    renderFrontmatter(fm),
    '',
    '## Agents 工坊里怎么用这本（以本段为准）',
    '',
    preamble,
    '',
    `## ${meta.upstream.publisher} 官方正文（${meta.upstream.repo} ${meta.upstream.tag}，原样收录）`,
    '',
    demoteHeadings(official.body.trim()),
  ]
  for (const ref of meta.references) {
    const topic = ref.replace(/^references\//, '').replace(/\.md$/, '')
    parts.push(
      '',
      `## 官方参考：${topic}（${ref}，原样收录）`,
      '',
      demoteHeadings(readFileSync(join(root, ref), 'utf8').trim()),
    )
  }
  return `${parts.join('\n')}\n`
}
