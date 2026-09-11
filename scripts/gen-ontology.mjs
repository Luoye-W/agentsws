#!/usr/bin/env node
/**
 * 由契约生成 47 J1 的本体登记表（`packages/ontology/ontology.json`）。
 *
 * **登记表不手写第二份**（47 J1 / J4）。这个脚本的输入全是别处已有的真源：
 *
 * | 登记表里的东西 | 从哪来 |
 * |---|---|
 * | 对象类型 | `packages/contracts/src/common.ts` 的 `ObjectType` 联合（TypeScript 编译器 API 解析） |
 * | 属性与敏感级 | 同名契约接口的成员（`FactCard` / `StagedChange` / `Matter` …） |
 * | 数据域与可读范围 | `packages/roles/roles/**.yml` 的 `scopes`（05 §1.1） |
 * | 动作（读 / 写） | `packages/connect-adapter/action-side-effects.yml`（18 §1）+ 同包的 Shopify 写动作对照表 |
 * | 变更种类与风险级 | `packages/contracts` 的 `ChangeKind` + `@agentsws/core` 的 `KIND_RISK`（15 §2） |
 * | 从哪查 | 29 的命名查询（`@agentsws/deck` 的注册表）+ 连接器读 Action |
 * | 新鲜度 | 活数据源的刷新周期（`apps/server` 的 `DEFAULT_REFRESH_SECONDS`） |
 *
 * 只有三样是**规则**而不是抄来的事实，规则写在下面并各带一条理由：
 * 对象 → 数据域的别名（`OBJECT_DOMAIN`）、属性名 → 敏感级（`SENSITIVITY_RULES`）、
 * 主键格式按真源分档（`KEY_FORMAT`）。它们不是"第二份对象定义"——加一个对象类型
 * 不需要改它们，改了它们也变不出新对象。
 *
 * 用法：`node scripts/gen-ontology.mjs`（先 `pnpm exec tsc -b`，要读几个包的 dist）
 *      `node scripts/gen-ontology.mjs --check` 只报差异，不写
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'packages/ontology/ontology.json')
const check = process.argv.includes('--check')

const require = createRequire(join(ROOT, 'packages/roles/package.json'))
/** @type {typeof import('typescript')} */
const ts = createRequire(join(ROOT, 'package.json'))('typescript')
const { parse: parseYaml } = require('yaml')

const need = (p) => {
  if (existsSync(join(ROOT, p))) return join(ROOT, p)
  process.stderr.write(`gen-ontology: 先跑 \`pnpm exec tsc -b\`（要读 ${p}）\n`)
  process.exit(70)
}

const CONTRACTS_DIR = join(ROOT, 'packages/contracts/src')
const INPUTS = [
  // 契约全量：对象类型、联合、接口成员都从这里读（加一个契约文件不用改这个脚本）
  ...readdirSync(CONTRACTS_DIR)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .sort()
    .map((f) => `packages/contracts/src/${f}`),
  'packages/connect-adapter/action-side-effects.yml',
  'packages/connect-adapter/src/shopify-actions.ts',
  'packages/core/src/guardrail.ts',
  'packages/deck/src/queries.ts',
  'apps/server/src/live-data.ts',
]

// ── 1. 契约：联合类型与接口成员（TypeScript 编译器 API）────────────────────

const program = ts.createProgram({
  rootNames: INPUTS.filter((p) => p.endsWith('.ts')).map((p) => join(ROOT, p)),
  options: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    noResolve: true,
    noLib: true,
  },
})

/** 字符串字面量联合 → 成员数组（`(string & {})` 这类开口不算成员）。 */
function unionMembers(name) {
  for (const file of program.getSourceFiles()) {
    for (const stmt of file.statements) {
      if (!ts.isTypeAliasDeclaration(stmt) || stmt.name.text !== name) continue
      const node = stmt.type
      const parts = ts.isUnionTypeNode(node) ? node.types : [node]
      return parts.flatMap((t) =>
        ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? [t.literal.text] : [],
      )
    }
  }
  throw new Error(`gen-ontology: 契约里找不到联合类型 ${name}`)
}

/** 接口名 → { 声明, 它所在的源文件 }（只收 `export interface`）。 */
const INTERFACES = new Map()
for (const file of program.getSourceFiles()) {
  for (const stmt of file.statements) {
    if (ts.isInterfaceDeclaration(stmt)) INTERFACES.set(stmt.name.text, { decl: stmt, file })
  }
}

/** 取一个节点的原文（`noResolve` 下节点的 `getSourceFile()` 不一定挂得上，显式传）。 */
const textOf = (file, node) => file.text.slice(node.getStart(file), node.end)

const OBJECT_TYPES = unionMembers('ObjectType')
const DATA_DOMAINS = new Set(unionMembers('DataDomain'))
const CHANGE_KINDS = new Set(unionMembers('ChangeKind'))

/**
 * 属性名 → 敏感级（05 §1.1）。**规则，不是清单**：按名字判，加字段不用改这里。
 * 顺序即优先级，最严的在前。
 */
const SENSITIVITY_RULES = [
  [/token|secret|credential|password|api_key|access_key/i, 'restricted'],
  [/email|phone|address|tax_id|id_card|bank/i, 'confidential'],
  [/^name$|customer_name|person|contact|owner/i, 'confidential'],
  [/public|label|title|kind|status|state|type/i, 'internal'],
]
const sensitivityOf = (name) => SENSITIVITY_RULES.find(([re]) => re.test(name))?.[1] ?? 'internal'

const MAX_PROPERTY_DEPTH = 2

/** 递归收接口成员（内嵌对象展开成 `subject.matter_id` 这样的点路径）。 */
function membersOf(file, node, prefix = '', depth = 0, out = []) {
  for (const m of node.members ?? []) {
    if (!ts.isPropertySignature(m) || m.name === undefined || m.type === undefined) continue
    const name = prefix + textOf(file, m.name)
    const type = textOf(file, m.type).replace(/\s+/g, ' ')
    if (ts.isTypeLiteralNode(m.type) && depth < MAX_PROPERTY_DEPTH) {
      membersOf(file, m.type, `${name}.`, depth + 1, out)
      continue
    }
    out.push({
      name,
      type: type.length > 80 ? `${type.slice(0, 77)}…` : type,
      sensitivity: sensitivityOf(name),
      optional: m.questionToken !== undefined,
    })
  }
  return out
}

const pascal = (id) =>
  id
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')

// ── 2. 对象 → 数据域 ───────────────────────────────────────────────────────

/**
 * 名字对不上 `DataDomain` 的那些对象，判权限时归哪个域。
 *
 * **不是我们新定的**：每一条都抄自 `/v1` 路由已经在用的 authz 声明
 * （`packages/api/src/routes/*.ts` 里的 `domain:`）——工作台读事项 / 会议 / 定时任务
 * 走的都是 `approval` 域，读岗位 / 品牌 / 人走的都是 `policy` 域。
 * 登记表只是把网关已经在执行的判断写下来。
 */
const OBJECT_DOMAIN = {
  contact: 'customer',
  company: 'customer',
  thread: 'customer',
  message: 'customer',
  variant: 'product',
  work_item: 'approval',
  matter: 'approval',
  goal: 'approval',
  todo: 'approval',
  meeting: 'meeting',
  meeting_record: 'meeting',
  fact_card: 'knowledge',
  package: 'skill',
  approval_item: 'approval',
  staged_change: 'approval',
  scheduled_task: 'approval',
  workflow_instance: 'approval',
  theme: 'content',
  repo_pr: 'content',
  ad_set: 'ad_account',
  social_post: 'social_account',
  email_campaign: 'campaign',
  connection: 'store_config',
  person: 'policy',
  assignment: 'policy',
  range_group: 'policy',
  product_line: 'policy',
  workspace: 'policy',
  membership_request: 'policy',
  policy: 'policy',
  shipment: 'shipment',
}
const domainOf = (id) => {
  const d = OBJECT_DOMAIN[id] ?? (DATA_DOMAINS.has(id) ? id : undefined)
  if (d === undefined)
    throw new Error(`gen-ontology: 对象 ${id} 归不到数据域，补一条 OBJECT_DOMAIN`)
  return d
}

/** 人写的那些域（19 知识、24 技能）：它们的真源是人，不是任何 API。 */
const AUTHORED_DOMAINS = new Set(['knowledge', 'skill'])

/**
 * 对象名 → 契约接口名的两条别名。
 * `work_item` 的正式形态就是 `Matter`（`ApprovalItem.subject` 的注释里写着）；
 * 应用包在本地的那一份是 `InstalledPackage`（23 §1）。
 */
const CONTRACT_ALIAS = { work_item: 'Matter', package: 'InstalledPackage' }

/** 主键格式按真源分档（规则，不是每个对象一条）。 */
const KEY_FORMAT = {
  platform_api: '平台给的 id，原样存、不解析',
  connector: '连接器给的 id，原样存、不解析',
  local_ledger: '`<前缀>_<哈希>`，本地生成，跨机唯一',
  human: '`<前缀>_<哈希>`，本地生成，跨机唯一',
}

// ── 3. 职责定义：scopes 与写动作 ───────────────────────────────────────────

const ROLES_DIR = join(ROOT, 'packages/roles/roles')
const roleFiles = readdirSync(ROLES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) =>
    readdirSync(join(ROLES_DIR, d.name))
      .filter((f) => f.endsWith('.yml'))
      .map((f) => join(ROLES_DIR, d.name, f)),
  )
  .sort()
const roles = roleFiles.map((f) => ({
  file: relative(ROOT, f),
  def: parseYaml(readFileSync(f, 'utf8')),
}))
for (const r of roles) INPUTS.push(r.file)

/** 域 → 这些职责给的可读范围（最宽的在前）。 */
const RANGE_WIDTH = { workspace: 2, assigned: 1, own: 0 }
const readRanges = new Map()
for (const { def } of roles) {
  for (const s of def.scopes ?? []) {
    if (!(s.ops ?? []).includes('read')) continue
    const set = readRanges.get(s.domain) ?? new Set()
    set.add(s.range)
    readRanges.set(s.domain, set)
  }
}
const rangesOf = (domain) =>
  [...(readRanges.get(domain) ?? [])].sort((a, b) => RANGE_WIDTH[b] - RANGE_WIDTH[a])

// ── 4. 连接器目录：读 / 写与它们落在哪类对象上 ─────────────────────────────

const sideEffects = parseYaml(
  readFileSync(join(ROOT, 'packages/connect-adapter/action-side-effects.yml'), 'utf8'),
)

const singular = (w) =>
  w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('s') ? w.slice(0, -1) : w

/**
 * 读 Action 的名字 → 它读的是哪类对象。
 * `get_order` / `list_orders` → `order`：去掉动词、单数化，对得上 `ObjectType` 才算。
 * 对不上的（`get_page` / `list_metafields`）不进登记表——宁可少一行，不能编一行。
 */
const READ_VERBS = ['get_', 'list_', 'search_', 'fetch_', 'detect_']
function objectOfReadAction(actionId) {
  const bare = actionId.slice(actionId.indexOf('.') + 1)
  const verb = READ_VERBS.find((v) => bare.startsWith(v))
  if (verb === undefined) return undefined
  const stem = singular(bare.slice(verb.length))
  return OBJECT_TYPES.includes(stem) ? stem : undefined
}

const shopifyDist = need('packages/connect-adapter/dist/index.js')
const { SHOPIFY_WRITE_ACTIONS } = await import(pathToFileURL(shopifyDist).href)
const { KIND_RISK } = await import(pathToFileURL(need('packages/core/dist/index.js')).href)
const { queryNames } = await import(pathToFileURL(need('packages/deck/dist/index.js')).href)
const { DEFAULT_REFRESH_SECONDS } = await import(
  pathToFileURL(need('apps/server/dist/live-data.js')).href
)

/** 命名查询前缀 → 对象。`orders.*` 自己对得上；另外两条抄自查询自己的 `source`。 */
const QUERY_OBJECT = {
  approvals: 'approval_item',
  changes: 'staged_change',
  records: 'approval_item',
}
function objectOfQuery(name) {
  const head = name.slice(0, name.indexOf('.'))
  const direct = singular(head)
  return OBJECT_TYPES.includes(direct) ? direct : QUERY_OBJECT[head]
}

// ── 5. 动作 ────────────────────────────────────────────────────────────────

const actions = []

// 5a. 连接器 Action（18 §1 的覆盖表就是全部已知的那些）
const writeByAction = new Map(SHOPIFY_WRITE_ACTIONS.map((a) => [a.action_id, a]))
for (const [id, effect] of Object.entries(sideEffects.actions ?? {})) {
  const write = writeByAction.get(id)
  const object = effect === 'read' ? objectOfReadAction(id) : write?.target
  if (object === undefined || !OBJECT_TYPES.includes(object)) continue
  const change_kind = write?.change_kind
  actions.push({
    id,
    object,
    source: 'connector',
    access: effect,
    ...(change_kind === undefined ? {} : { change_kind }),
    risk_class:
      change_kind === undefined ? (effect === 'read' ? 'low' : 'high') : KIND_RISK[change_kind],
    requires_approval: effect === 'write',
    what: write?.what ?? `读 ${object}`,
  })
}

/**
 * 职责动作 → 运行时把它摆成哪个工具（17 §1 的两个产出工具）。
 * 只有两个口，写死在这里而不是猜：`packages/runtime-direct/src/assemble.ts`
 * 与 `packages/dsh-adapter/src/tools.ts` 里就是这两个名字。
 */
const OUTPUT_TOOL = { staged_change: 'stage_refund', outbound_message: 'draft_reply' }

/** 动作 id → ChangeKind（与 `@agentsws/roles` 的 `changeKindOf` 同一条规则）。 */
const changeKindOf = (actionId) => {
  const base = actionId.replace(/^(stage|draft|propose|apply)_/, '')
  return CHANGE_KINDS.has(base) ? base : undefined
}

/** 一句人话：职责 YAML 里没有"这个动作干什么"这一格，按动作 id 给一句中文。 */
const WHAT = {
  reply_customer: '给客户回信（草稿，批了才发）',
  stage_refund: '提一笔退款',
  stage_reship: '提一次补发',
  stage_address_change: '改收件地址',
  draft_chargeback_evidence: '整理拒付证据',
  authorize_connector: '授权一个连接器',
  change_policy: '改工作区策略',
  grant_assignment: '给人派一条岗位',
  stage_dev_task: '提一条建站任务',
  stage_page_edit: '改一个页面',
  stage_publish_theme: '发布主题',
  stage_theme_preview: '出一份主题预览',
}

// 5b. 职责里的写动作（05 §1.4）——这才是模型真正能提的那些
const roleActions = new Map()
for (const { def } of roles) {
  for (const a of def.actions ?? []) {
    const change_kind = a.change_kind ?? changeKindOf(a.id)
    const object = objectOfDomain(a.target)
    if (object === undefined) continue
    const risk_class =
      a.risk_class ??
      (change_kind === undefined
        ? a.kind === 'outbound_message'
          ? 'low'
          : 'high'
        : KIND_RISK[change_kind])
    const prior = roleActions.get(a.id)
    if (prior !== undefined) {
      if (!prior.roles.includes(def.id)) prior.roles.push(def.id)
      continue
    }
    // 只有退款那一条有产出工具：`stage_refund` 是**退款**的口，别的 staged_change
    // 现在还没有模型可调的入口（要改地址得由人在卡上改）。
    const tool =
      a.kind === 'outbound_message'
        ? OUTPUT_TOOL.outbound_message
        : change_kind === 'refund'
          ? OUTPUT_TOOL.staged_change
          : undefined
    roleActions.set(a.id, {
      id: a.id,
      object,
      source: 'role',
      access: 'write',
      ...(change_kind === undefined ? {} : { change_kind }),
      risk_class,
      requires_approval: true,
      ...(typeof a.route_to === 'string' ? { route_to: a.route_to } : {}),
      roles: [def.id],
      ...(tool === undefined ? {} : { tool }),
      what: WHAT[a.id] ?? a.id.replace(/_/g, ' '),
    })
  }
}

/** 数据域 → 这个域里最有代表性的那类对象（动作的 `target` 是域，不是对象）。 */
function objectOfDomain(domain) {
  if (OBJECT_TYPES.includes(domain)) return domain
  return OBJECT_TYPES.find((o) => OBJECT_DOMAIN[o] === domain)
}

actions.push(...roleActions.values())
actions.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id))

// ── 6. 对象 ────────────────────────────────────────────────────────────────

/**
 * 05 §1.8 的 grounding 规则里点名的那些读工具（`get_order` / `search_policies`）。
 * 它们是模型真正会调到的名字，登记表里"从哪查"少了它们就等于没说。
 *
 * `search_policies` 按同一条规则化到 `policy`，但它返回的是**事实卡**
 * （19 §1：政策是事实卡的一层；`runtime-direct` 的 `inferRefs` 也把这些命中标成
 * `fact_card`）——所以这一条改指到 `fact_card`。
 */
const groundingTools = new Map()
for (const { def } of roles) {
  for (const g of def.grounding ?? []) {
    const direct = objectOfReadAction(g.tool)
    const object = direct === 'policy' ? 'fact_card' : direct
    if (object === undefined) continue
    const set = groundingTools.get(object) ?? new Set()
    set.add(g.tool)
    groundingTools.set(object, set)
  }
}

const readViaOf = (id) => {
  const fromActions = actions.filter((a) => a.object === id && a.access === 'read').map((a) => a.id)
  const fromQueries = queryNames().filter((q) => objectOfQuery(q) === id)
  const fromGrounding = [...(groundingTools.get(id) ?? [])]
  return [...new Set([...fromGrounding, ...fromQueries, ...fromActions])].sort()
}

const hasConnectorAction = (id) => actions.some((a) => a.object === id && a.source === 'connector')

/** 对象的人话名字：契约与职责 YAML 都没有这一格，中文名按 `ObjectType` 逐字翻一份。 */
const LABEL = {
  customer: '客户',
  contact: '联系人',
  company: '客户公司',
  thread: '会话',
  message: '消息',
  order: '订单',
  shipment: '物流',
  product: '商品',
  variant: '变体',
  discount: '折扣',
  campaign: '活动',
  creator: '达人',
  work_item: '工作项',
  matter: '事项',
  goal: '目标',
  todo: '待办',
  meeting: '会议',
  meeting_record: '会议记录',
  fact_card: '事实卡',
  skill: '技能',
  package: '应用包',
  approval_item: '审批项',
  staged_change: '待批变更',
  scheduled_task: '定时任务',
  workflow_instance: '流程实例',
  theme: '主题',
  repo_pr: '代码合并请求',
  ad_set: '广告组',
  social_post: '社媒帖子',
  email_campaign: '邮件营销',
  store_config: '店铺设置',
  connection: '连接',
  person: '人',
  assignment: '岗位',
  range_group: '品牌（范围组）',
  product_line: '产品线',
  workspace: '工作区',
  membership_request: '加入申请',
  policy: '策略',
}

const objects = []
for (const id of OBJECT_TYPES) {
  const domain = domainOf(id)
  const contract = CONTRACT_ALIAS[id] ?? pascal(id)
  const iface = INTERFACES.get(contract)
  // 顺序即优先级：人写的 → 我们自己的账本 → 平台的 → 只能经连接器看见的
  const source_of_truth = AUTHORED_DOMAINS.has(domain)
    ? 'human'
    : iface !== undefined
      ? 'local_ledger'
      : hasConnectorAction(id)
        ? 'platform_api'
        : domain === 'policy'
          ? 'human'
          : 'connector'
  objects.push({
    id,
    label: LABEL[id] ?? id,
    key_format: KEY_FORMAT[source_of_truth],
    domain,
    source_of_truth,
    freshness:
      source_of_truth === 'human'
        ? 'authored'
        : source_of_truth === 'local_ledger'
          ? 'realtime'
          : `cached:${DEFAULT_REFRESH_SECONDS}`,
    read_ranges: rangesOf(domain),
    properties: iface === undefined ? [] : membersOf(iface.file, iface.decl),
    read_via: readViaOf(id),
    ...(iface === undefined ? {} : { contract }),
  })
}
objects.sort((a, b) => a.id.localeCompare(b.id))

// ── 7. 链接 ────────────────────────────────────────────────────────────────

/** `<stem>_id` 的 stem 不是 `ObjectType` 时的别名（都在契约里能查到出处）。 */
const LINK_ALIAS = { change: 'staged_change', card: 'fact_card', item: 'approval_item' }
const linkTargetOf = (field) => {
  const m = /^(.*?)_ids?$/.exec(field)
  if (m === null) return undefined
  const stem = (m[1] ?? '').split('.').pop() ?? ''
  if (OBJECT_TYPES.includes(stem)) return stem
  return LINK_ALIAS[stem]
}

const byId = new Map(objects.map((o) => [o.id, o]))
const links = []
const seen = new Set()
const push = (link) => {
  const key = `${link.from}→${link.to}:${link.via}:${link.direction}`
  if (seen.has(key)) return
  seen.add(key)
  links.push(link)
}

/** 写动作的目标集合：`ObjectRef` 这种多态字段能指到的就是它们。 */
const actionTargets = [
  ...new Set(actions.filter((a) => a.access === 'write').map((a) => a.object)),
].sort()

/**
 * 多态引用的那几个字段名。写死一小张表而不是"凡是 `ObjectRef` 都算"：
 * `evidence.provenance.seen` 也是 `ObjectRef[]`，但它是"读过什么"的流水，不是一条链接。
 */
const POLY_FIELDS = new Set(['target', 'subject.object', 'apply.outcome_ref', 'subject'])

for (const object of objects) {
  for (const p of object.properties) {
    const many = p.type.includes('[]') || /_ids$/.test(p.name)
    const target = linkTargetOf(p.name)
    if (target !== undefined && byId.has(target) && target !== object.id) {
      push({
        from: object.id,
        to: target,
        direction: 'out',
        cardinality: many ? 'many' : 'one',
        via: p.name,
        lookup: byId.get(target)?.read_via.slice(0, 2) ?? [],
      })
      continue
    }
    // 多态引用（`target: ObjectRef` / `subject.object: ObjectRef`）：它指得到的
    // 就是"有写动作落在上面"的那些对象——这不是猜，是 15 §2 目录的定义域。
    if (POLY_FIELDS.has(p.name) && /^ObjectRef(\[\])?$/.test(p.type)) {
      for (const t of actionTargets) {
        if (t === object.id) continue
        push({
          from: object.id,
          to: t,
          direction: 'out',
          cardinality: 'one',
          via: p.name,
          lookup: byId.get(t)?.read_via.slice(0, 2) ?? [],
        })
      }
    }
  }
}

// 反向：A 指着 B，那么"B 的那些 A"就是一条按条件查的链接
for (const l of [...links]) {
  if (l.direction !== 'out') continue
  push({
    from: l.to,
    to: l.from,
    direction: 'in',
    cardinality: 'many',
    via: `${l.from}.${l.via}`,
    lookup: byId.get(l.from)?.read_via.slice(0, 2) ?? [],
  })
}
links.sort(
  (a, b) =>
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.direction.localeCompare(b.direction) ||
    a.via.localeCompare(b.via),
)

// ── 8. 落盘 / 比对 ─────────────────────────────────────────────────────────

const inputs = [...new Set(INPUTS)].sort()
const digest = createHash('sha256')
for (const p of inputs) digest.update(`${p}\n`).update(readFileSync(join(ROOT, p)))

const registry = {
  version: 1,
  generated_from: inputs,
  source_digest: digest.digest('hex').slice(0, 32),
  objects,
  links,
  actions,
}
/**
 * 生成物也要过仓库的格式化，否则 `biome check .` 会红。走 stdin 而不是"先写再格式化"：
 * `--check` 比的必须是**最终落盘的那一份**，中间态比了等于没比。
 */
const biome = join(ROOT, 'node_modules/.bin/biome')
const json = execFileSync(biome, ['check', '--write', '--stdin-file-path=ontology.json'], {
  cwd: ROOT,
  input: `${JSON.stringify(registry, null, 2)}\n`,
  encoding: 'utf8',
})
const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''

if (check) {
  if (before !== json) {
    process.stderr.write(
      'gen-ontology --check: ontology.json 与契约不一致——跑一次 `node scripts/gen-ontology.mjs`\n',
    )
    process.exit(1)
  }
  process.stdout.write('gen-ontology --check: 零漂移\n')
} else {
  writeFileSync(OUT, json)
  process.stdout.write(
    `gen-ontology: ${objects.length} 类对象 / ${links.length} 条链接 / ${actions.length} 个动作 → packages/ontology/ontology.json\n`,
  )
}
