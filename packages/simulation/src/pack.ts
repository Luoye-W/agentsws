/**
 * 合成公司数据集（pack）的加载（26 §2）。
 *
 * 一个 pack 就是一家公司的数字孪生：工作区、人、职责分配、策略层额度、店铺数据、
 * 邮件线程（含毒样本与对照）、三层知识、场景。**同一份数据既是 demo 也是回归基线**；
 * 验收另用隐藏场景集（31 §1 I9），所以 pack 里的 `scenarios/` 不含隐藏题。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Iso8601, PersonId, RangeRef, RoleId, WorkspaceId } from '@agentsws/contracts'
import type { MockOrder, MockProduct, MockState, MockThread } from '@agentsws/stand-ins'
import { parse as parseYaml } from 'yaml'
import { SimulationError } from './errors.js'

export interface PackManifest {
  schema_version: number
  pack: string
  seed: number
  anchor: Iso8601
  sizes: Record<string, number>
  /** WP32 soak 档：这家公司一天大概来几封信、故障多密（26 §4）。 */
  soak?: Partial<PackSoak>
}

/** soak 档的到达率与故障率（每天按 seed 抽，所以同 seed 的 30 天是同一段人生）。 */
export interface PackSoak {
  /** 每天新来几封客户信 */
  inbound_per_day: number
  /** 每天注入一次连接器故障的概率 */
  fault_rate: number
  /** 每天模型停机一段时间的概率 */
  outage_rate: number
  /** 每天"进程重启"（关库再开）的概率 */
  restart_rate: number
}

export const DEFAULT_SOAK: PackSoak = {
  inbound_per_day: 3,
  fault_rate: 0.34,
  outage_rate: 0.25,
  restart_rate: 0.34,
}

export interface PackWorkspace {
  id: WorkspaceId
  name: string
  tz: string
  base_currency: string
  locales: { customers: string; operators: string }
  markets: RangeRef[]
  company_md: string
}

export interface PackPerson {
  id: PersonId
  name: string
  email: string
  title: string
  owner?: boolean
  /** 14 §7 升级链的第一级；一个 pack 至多一个（没有就退回 owner）。 */
  scope_manager?: boolean
}

export interface PackAssignment {
  person_id: PersonId
  role_id: RoleId
  ranges: RangeRef[]
  granted_by: PersonId
  /** 入站工作项默认落到哪个分配（每个 role 一个 primary）。 */
  primary?: boolean
}

export interface PackPolicy {
  workspace_id: WorkspaceId
  mandates: Record<
    string,
    {
      caps?: Record<string, number | string | boolean>
      window?: { max_count: number; per: 'day' | 'week' }
    }
  >
  global_caps: Record<string, number>
  separation_of_duties?: string[]
}

export interface PackCustomer {
  id: string
  name: string
  email: string
  market: string
}

export interface PackShipment {
  id: string
  order_id: string
  carrier: string
  tracking: string
  status: string
  delivered_at?: Iso8601
}

export interface PackThreadMessage {
  id: string
  direction: 'inbound' | 'outbound'
  from: string
  to: string[]
  at: Iso8601
  body: string
}

export interface PackThread {
  id: string
  subject: string
  participants: string[]
  /** 26 §2：夹带指令的毒样本，必须配一条 should-serve 对照。 */
  poison?: boolean
  control_of?: string
  messages: PackThreadMessage[]
}

export interface PackKnowledgeDoc {
  /** pack 内相对路径 */
  path: string
  layer: 'fact' | 'phrasing' | 'policy'
  domain: string
  subject_key: string
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
  title: string
  body: string
}

/** pack 自带的技能（Agent Skills 格式）。WP29 的学习回路要有落脚的段落。 */
export interface PackSkillDoc {
  /** pack 内相对路径 */
  path: string
  /** frontmatter 里的 name */
  name: string
  markdown: string
}

/** pack 自带的 judge rubric（`judge/*.md`）：frontmatter 是规则 judge 的配置，正文是模型 judge 的 rubric。 */
export interface PackJudgeDoc {
  /** pack 内相对路径 */
  path: string
  name: string
  meta: Record<string, string>
  body: string
}

/**
 * pack 自带的职责定义（`roles/*.yml`）。
 *
 * 15 / 50 人 pack 要有投放、运营这些岗位，而 `packages/roles` 里目前只内置了
 * `dtc.aftersales` / `common.owner` / `common.member` 三份。让 pack 能自带职责定义，
 * 合成公司的规模就不再被内置职责的数量卡住；同 id 时 pack 里这份优先（它更具体）。
 */
export interface PackRoleFile {
  path: string
  id: RoleId
  yaml: string
}

export interface Pack {
  dir: string
  manifest: PackManifest
  workspace: PackWorkspace
  people: PackPerson[]
  assignments: PackAssignment[]
  policy: PackPolicy
  products: MockProduct[]
  orders: MockOrder[]
  customers: PackCustomer[]
  shipments: PackShipment[]
  threads: PackThread[]
  knowledge: PackKnowledgeDoc[]
  /** `skills/<name>.md`：只收带 frontmatter `name` 的（overlay 示例不算技能） */
  skills: PackSkillDoc[]
  /** `judge/*.md`：规则 judge 的配置 + 模型 judge 的 rubric（WP32） */
  judges: PackJudgeDoc[]
  /** `roles/*.yml`：pack 自带的职责定义，按 id 覆盖内置（WP32） */
  roles: PackRoleFile[]
  /** soak 档参数（manifest 里没写就用默认） */
  soak: PackSoak
  /** `fixtures/<name>` → 正文 */
  fixtures: Map<string, string>
  /** pack 自带的场景文件绝对路径（不含隐藏集） */
  scenarioFiles: string[]
  /** 交给 mock OpenConnector 的初始内存状态 */
  mockState(): MockState
  /** 邮箱 → 客户记录 id */
  customerByEmail(email: string): PackCustomer | undefined
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function readYaml<T>(file: string): T {
  if (!existsSync(file)) throw new SimulationError('not_found', `pack 缺文件：${file}`, { file })
  try {
    return parseYaml(readFileSync(file, 'utf8')) as T
  } catch (error) {
    throw new SimulationError(
      'invalid_input',
      `pack YAML 解析失败：${file}：${(error as Error).message}`,
    )
  }
}

function readList<T>(file: string): T[] {
  const v = readYaml<unknown>(file)
  if (!Array.isArray(v)) throw new SimulationError('invalid_input', `${file} 必须是列表`)
  return v as T[]
}

/** 递归列出目录下的文件（相对路径，`/` 分隔，字典序）。 */
export function listFiles(dir: string, suffix?: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (suffix === undefined || name.endsWith(suffix)) out.push(full)
    }
  }
  walk(dir)
  return out.sort()
}

/** 极简 frontmatter：`---` 包起来的 `key: value`，值不带引号也不嵌套。 */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: text }
  const head = text.slice(text.indexOf('\n') + 1, end)
  const meta: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const rest = text.slice(end + 4)
  return { meta, body: rest.startsWith('\n') ? rest.slice(1) : rest }
}

function knowledgeDoc(dir: string, file: string): PackKnowledgeDoc {
  const text = readFileSync(file, 'utf8')
  const { meta, body } = parseFrontmatter(text)
  const layer = meta.layer ?? 'fact'
  if (!['fact', 'phrasing', 'policy'].includes(layer)) {
    throw new SimulationError('invalid_input', `知识层非法：${file} → ${layer}`)
  }
  const titleLine = body.split('\n').find((l) => l.startsWith('# '))
  return {
    path: relative(dir, file).split(sep).join('/'),
    layer: layer as PackKnowledgeDoc['layer'],
    domain: meta.domain ?? 'company',
    subject_key: meta.subject_key ?? relative(dir, file).split(sep).join('/'),
    sensitivity: (meta.sensitivity ?? 'internal') as PackKnowledgeDoc['sensitivity'],
    title: titleLine === undefined ? (meta.subject_key ?? 'untitled') : titleLine.slice(2).trim(),
    body,
  }
}

/** 加载一个 pack 目录。 */
export function loadPack(dir: string): Pack {
  const root = resolve(dir)
  if (!existsSync(root)) throw new SimulationError('not_found', `pack 目录不存在：${root}`, { dir })

  const manifest = readYaml<PackManifest>(join(root, 'manifest.yml'))
  const workspace = readYaml<PackWorkspace>(join(root, 'workspace.yml'))
  const people = readList<PackPerson>(join(root, 'people.yml'))
  const assignments = readList<PackAssignment>(join(root, 'assignments.yml'))
  const policy = readYaml<PackPolicy>(join(root, 'policy.yml'))
  const products = readList<MockProduct>(join(root, 'store', 'products.yml'))
  const orders = readList<MockOrder>(join(root, 'store', 'orders.yml'))
  const customers = readList<PackCustomer>(join(root, 'store', 'customers.yml'))
  const shipments = readList<PackShipment>(join(root, 'store', 'shipments.yml'))

  const threads = listFiles(join(root, 'threads'), '.yml').map((f) => {
    const t = readYaml<PackThread>(f)
    if (!isRec(t) || typeof t.id !== 'string') {
      throw new SimulationError('invalid_input', `线程文件缺 id：${f}`)
    }
    return t
  })
  for (const t of threads) {
    if (t.poison === true && !threads.some((o) => o.control_of === t.id)) {
      throw new SimulationError(
        'invalid_input',
        `毒样本 ${t.id} 没有配 should-serve 对照线程（26 §2）`,
        { thread: t.id },
      )
    }
  }

  const knowledge = listFiles(join(root, 'knowledge'), '.md').map((f) => knowledgeDoc(root, f))

  const skills: PackSkillDoc[] = []
  for (const f of listFiles(join(root, 'skills'), '.md')) {
    const markdown = readFileSync(f, 'utf8')
    const name = /^\s*---[\s\S]*?\n[ \t]*name[ \t]*:[ \t]*(.+)$/m
      .exec(markdown)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '')
    // 没有 frontmatter 的是示例片段（比如 overlay 样例），不当技能装进去
    if (name === undefined || name === '') continue
    skills.push({ path: relative(root, f).split(sep).join('/'), name, markdown })
  }

  const judges: PackJudgeDoc[] = []
  for (const f of listFiles(join(root, 'judge'), '.md')) {
    const { meta, body } = parseFrontmatter(readFileSync(f, 'utf8'))
    const rel = relative(root, f).split(sep).join('/')
    judges.push({ path: rel, name: meta.name ?? rel, meta, body })
  }

  const roles: PackRoleFile[] = []
  for (const f of listFiles(join(root, 'roles'), '.yml')) {
    const yamlText = readFileSync(f, 'utf8')
    const parsed = parseYaml(yamlText) as { id?: unknown }
    if (!isRec(parsed) || typeof parsed.id !== 'string') {
      throw new SimulationError('invalid_input', `pack 的职责文件缺 id：${f}`)
    }
    roles.push({ path: relative(root, f).split(sep).join('/'), id: parsed.id, yaml: yamlText })
  }

  const fixtures = new Map<string, string>()
  for (const f of listFiles(join(root, 'fixtures'))) {
    fixtures.set(
      `fixtures/${relative(join(root, 'fixtures'), f).split(sep).join('/')}`,
      readFileSync(f, 'utf8'),
    )
  }

  const scenarioFiles = listFiles(join(root, 'scenarios'), '.yml')

  const byEmail = new Map(customers.map((c) => [c.email.toLowerCase(), c]))

  return {
    dir: root,
    manifest,
    workspace,
    people,
    assignments,
    policy,
    products,
    orders,
    customers,
    shipments,
    threads,
    knowledge,
    skills,
    judges,
    roles,
    soak: { ...DEFAULT_SOAK, ...(manifest.soak ?? {}) },
    fixtures,
    scenarioFiles,
    mockState(): MockState {
      const mockThreads: MockThread[] = threads.map((t) => ({
        id: t.id,
        subject: t.subject,
        participants: [...t.participants],
        message_ids: t.messages.map((m) => m.id),
      }))
      return {
        orders: orders.map((o) => ({ ...o, line_items: o.line_items.map((li) => ({ ...li })) })),
        products: products.map((p) => ({ ...p })),
        // WP44：每个 pack 都从"一份线上主题"开始。建站岗位干的第一件事是拉它下来，
        // 之后所有副本都是从它派生的（pack 里不生成主题文件，主题的内容不是这一层的事）
        themes: [
          {
            id: 'thm_live',
            name: 'Dawn（现行主题）',
            role: 'main' as const,
            updated_at: manifest.anchor,
          },
        ],
        discounts: [],
        threads: mockThreads,
        messages: threads.flatMap((t) =>
          t.messages.map((m) => ({
            id: m.id,
            thread_id: t.id,
            direction: m.direction,
            from: m.from,
            to: [...m.to],
            subject: t.subject,
            body: m.body,
            at: m.at,
          })),
        ),
        posts: [],
        segments: [],
        whatsapp: [],
      }
    },
    customerByEmail(email: string) {
      return byEmail.get(email.toLowerCase())
    },
  }
}
