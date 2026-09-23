/**
 * 职责 preset = 一职责一目录（16 §1、55 §4 第三层）：
 * `<root>/<workspace>/<preset_id>/` 下三个文件。
 *
 * | 文件 | 谁读它 | 里面是什么 |
 * |---|---|---|
 * | `agent.cordis.yml` | 人与排障（WP132 起不再被上游读，见下） | **能挂的那一份**：这条职责的 `mcp-client` 行 |
 * | `host.cordis.yml` | 跨进程宿主（`dsh --profile agentsws-executor`） | 门禁与模型网关那两行（同进程时我们直接装，见 `gate.ts` / `llm.ts`） |
 * | `preset.yml` | 官方 roster 的显示元数据 | 名字与一句说明 |
 *
 * **为什么分两份**：`mount()` 会把组合里每一行**真的 import 起来**，一行起不来整份
 * preset 就是 broken。门禁与网关那两行是"这份组合在另一个进程里长什么样"的**描述**，
 * 同进程里它们是直接 `installGate` / `registerAdapter` 装的，没有也不需要一个可 import
 * 的模块名。把它们留在 `agent.cordis.yml` 里，preset 一挂就 broken。
 *
 * **preset 只多一层"这条职责有哪些连接"**：五个门禁、`tools.restrict`、persona 段
 * 一个都没搬家（55 §4 原话）。
 *
 * **凭据只放名字**（13 §4）：请求头与子进程环境变量的值在生成的文件里是
 * `!!js process.env.<REF>`——一个**引用**。值由 `ctx.credentials` 在挂载前解析，
 * 见 {@link presetCredentialRefs} 与 `harness.ts`。
 *
 * **生成是幂等的**：目录名与文件内容都只由 `RunRequest` 决定，内容没变就**一个字节都不写**。
 * 0.1.6 时这不是省 IO：上游 `agent-presets` 把"代不代"钉在组合文件的 mtime + size 上，
 * 而**被顶掉的那一代永远不回收**（上游 Known Limitations 原话）。
 *
 * **WP132（dsh 0.1.7-rc.1）：上游不再扫目录。** `dsh-agent-presets`（按 `roots` 扫
 * `<root>/<id>/agent.cordis.yml`）整包下线，换成 `dsh-agent-preset-registry`——
 * 「the registry neither scans directories nor accepts preset paths」，定义只能以
 * **插件行**或 `ctx.agentPresets.register(definition)` 交进去（上游 README「Minimal configuration」）。
 * 所以挂给 Agent 的那一份现在走 {@link presetDefinition}（同一份 `presetComposition(req).rows`，
 * 只是 `!!js` 标量换成 loader 的 `{ __jsExpr }` 形），三个文件照旧写、照旧幂等：
 * `host.cordis.yml` 仍是跨进程那一面的描述，另两份留给人看与排障。
 * 上游的"代"也换了回收办法：旧一代在最后一个引用释放时销毁（registry README
 * 「releasing the final reference disposes the retired tree」），所以"每次运行多挂一棵
 * 永不释放的子树"那个坑这一版已经不在了——我们一次运行一棵树、结束整树 dispose，本来也踩不到。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunConnection, RunRequest } from '@agentsws/contracts'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { mcpToolName } from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import { Document, Scalar, stringify } from 'yaml'
import { GATEWAY_PROVIDER } from './llm.js'

/** 门禁插件在跨进程 preset 里的模块名（由 profile 的 node_modules 解析）。 */
export const GATE_PLUGIN_MODULE = '@agentsws/dsh-adapter/preset-gate'

/** 官方 MCP 客户端插件的包名（preset 里一条连接一行）。 */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

export interface PresetPaths {
  /** `<root>/<workspace>/<preset_id>`。 */
  dir: string
  /** roster 的 `roots[].path`：`<root>/<workspace>`（它下面一层目录一个 preset）。 */
  root: string
  /** 官方 roster 认的 preset id（目录名）。 */
  id: string
  /** 能挂的那一份（`agent.cordis.yml`）。 */
  composition: string
  /** 跨进程宿主那一份（`host.cordis.yml`）。 */
  host: string
  manifest: string
  /** 这次真的写了文件吗（false = 内容没变、mtime 没动、上游不会起新一代）。 */
  written: boolean
}

export interface PresetComposition {
  /** 能挂的那一份的行（`mcp-client`，一条连接一行）。 */
  rows: unknown[]
  /** 跨进程宿主那一份的行（门禁 + 网关）。 */
  hostRows: unknown[]
  manifest: Record<string, unknown>
}

/**
 * preset id = 目录名，必须过上游的 `[a-z0-9][a-z0-9-]*`。
 *
 * 职责 id 是带点的（`dtc.support`），点与下划线一律换成短横线。换出来撞名的可能性
 * 存在（`a.b` 与 `a_b`），所以**凡是换过字符的**都在后面挂一段职责 id 的哈希——
 * 不让两条职责共用一个 preset：那等于把 A 的连接挂给 B。
 */
export function presetIdOf(roleId: string): string {
  const lower = roleId.toLowerCase()
  const mapped = lower.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const safe = mapped === '' ? 'role' : mapped
  return safe === lower ? safe : `${safe}-${sha256(roleId).slice(0, 8)}`
}

/** `!!js <expr>`：loader 求值的那种标量（上游 `mcp-client` README 的官方写法）。 */
function jsExpr(expr: string): Scalar {
  const node = new Scalar(expr)
  node.tag = '!!js'
  return node
}

/**
 * 一个凭据引用在 preset 文件里的样子。
 *
 * `?? ''` 那一段不是装饰：实测**解析不出来的引用会让整份 preset 挂不上**——
 * `process.env.X` 是 `undefined` 时上游 `mcp-client` 的 config 校验直接拒
 * （`env` 要 `{ [key: string]: string }`），`mount()` 随之抛，这次运行整个失败。
 * 补一个空串之后，没配凭据的后果退回到它该有的样子：这台服务器连不上、
 * 它的工具不出现，运行照常。
 */
function credentialExpr(ref: string): Scalar {
  return jsExpr(`process.env.${ref} ?? ''`)
}

/**
 * 一条连接 → 官方 `dsh-mcp-client` 的一行。
 *
 * `failOnStartupError` 故意**不开**（跟上游默认）：一台连不上的 MCP 服务器不该让整次
 * 运行起不来——它的工具不出现，模型看不见，门禁那边本来就只放行看得见的东西。
 */
function mcpRow(conn: RunConnection): Record<string, unknown> {
  const config: Record<string, unknown> = {
    serverName: conn.server_name,
    transport: conn.transport,
  }
  if (conn.transport === 'stdio') {
    config.command = conn.command ?? ''
    if (conn.args !== undefined && conn.args.length > 0) config.args = [...conn.args]
    const env = conn.env_refs ?? {}
    const names = Object.keys(env).sort()
    if (names.length > 0) {
      config.env = Object.fromEntries(names.map((n) => [n, credentialExpr(env[n] ?? '')]))
    }
  } else {
    config.url = conn.url ?? ''
    const headers = conn.header_refs ?? {}
    const names = Object.keys(headers).sort()
    if (names.length > 0) {
      config.headers = Object.fromEntries(names.map((n) => [n, credentialExpr(headers[n] ?? '')]))
    }
  }
  return { id: `mcp-${conn.server_name}`, name: MCP_CLIENT_MODULE, config }
}

/** 这次运行要挂的连接（按 `server_name` 排序，同一请求两次算出来逐字节相同）。 */
export function presetConnections(req: RunRequest): RunConnection[] {
  return [...(req.connections ?? [])].sort((a, b) => a.server_name.localeCompare(b.server_name))
}

/**
 * preset 挂上来的工具的**全名**（`mcp__<serverName>__<rawName>`）。
 *
 * 实测（`preset-seam.test.ts`）：preset 挂的工具**受** `ctx.tools.restrict({ allow })`
 * 管——这与官方浏览器 provider 正好相反（那一组 scoped registration 不受白名单影响，
 * 列进去还会抛）。所以这些名字必须进白名单，否则这台服务器的工具一个都到不了模型面前；
 * 而且 `restrict` 必须在 `mount()` **之后**调（它只认调用当刻已经注册的名字）。
 */
export function presetToolNames(req: RunRequest): string[] {
  const out: string[] = []
  for (const conn of presetConnections(req)) {
    for (const tool of conn.tools ?? []) out.push(mcpToolName(conn.server_name, tool))
  }
  return [...new Set(out)].sort()
}

/**
 * 生成的 preset 里出现的全部**凭据引用名**（环境变量名），去重后按名字排序。
 *
 * 宿主在 `mount()` 之前把它们逐个经 `ctx.credentials.resolve()` 解析出来放进
 * `process.env`，挂完就还原——文件里从头到尾只有名字。
 */
export function presetCredentialRefs(req: RunRequest): string[] {
  const refs: string[] = []
  for (const conn of presetConnections(req)) {
    refs.push(...Object.values(conn.env_refs ?? {}), ...Object.values(conn.header_refs ?? {}))
  }
  return [...new Set(refs)].sort()
}

/** 一次运行的 preset 组合（纯函数，契约测试直接断言它）。 */
export function presetComposition(req: RunRequest): PresetComposition {
  const conns = presetConnections(req)
  const hostRows = [
    {
      id: 'agentsws-gate',
      name: GATE_PLUGIN_MODULE,
      config: {
        role_id: req.actor.role_id,
        preset: req.runtime.preset,
        workspace_id: req.workspace_id,
        tools: {
          allow: [...req.tools.allow].sort(),
          side_effect_policy: req.tools.side_effect_policy,
        },
        // 16 §2：公司端 preset 的 systemPrompt 白名单——persona 是 complete 段
        system_prompt: { persona_complete: true },
      },
    },
    {
      id: 'agentsws-llm',
      name: '@agentsws/dsh-adapter/preset-llm',
      config: { provider: GATEWAY_PROVIDER, model: req.runtime.model.model },
    },
  ]
  return {
    rows: conns.map(mcpRow),
    hostRows,
    manifest: {
      name: `agentsws ${req.actor.role_id}`,
      description: `agentsws 职责 preset（${req.actor.role_id}），由 dsh-adapter 按职责模板生成`,
      // 显示元数据之外的几条事实，给排障的人看（上游 roster 只读 name / description）
      agentsws: {
        role_id: req.actor.role_id,
        workspace_id: req.workspace_id,
        connections: conns.map((c) => ({ kind: c.kind, server_name: c.server_name })),
        /*
         * WP82 的浏览器 provider **不在这份 preset 里**，这一行是说明它去哪了：
         * `browserUse` 是一棵树一个的独占 provider 槽，provider 自己挂在
         * `agent/created` 上、按 Agent 分配资源（AGENT-LAYER §8.1 / §9.1）。
         * 写成 preset 的一行会落进 mount 的子树里，既过不了 mount 那道
         * "不许往 root realm 发服务"的审计，也拿不到只有宿主知道的 CDP 地址。
         * 所以浏览器仍然按职责在 `setup` 里挂，与 WP82 一字不差。
         */
        browser: req.browser !== undefined,
      },
    },
  }
}

const HEADER = [
  '# 由 @agentsws/dsh-adapter 生成，请勿手改（55 §4：职责 preset 由职责模板生成）。',
  '# 一职责一 preset（16 §1）；这一份是**挂给 Agent 的**组合，只有这条职责的 MCP 服务器。',
  '# 凭据只有名字：`!!js process.env.<REF>` 是引用，值由 ctx.credentials 解析（13 §4）。',
  '',
].join('\n')

const HOST_HEADER = [
  '# 由 @agentsws/dsh-adapter 生成，请勿手改。',
  '# 跨进程宿主（dsh --profile）用的那一份：门禁与模型网关。',
  '# 同进程运行时这两样是直接装的（gate.ts / llm.ts），不经这个文件。',
  '',
].join('\n')

/** 内容没变就不写——不动 mtime，上游不会起新一代（见文件头那段）。 */
function writeIfChanged(file: string, text: string): boolean {
  try {
    if (readFileSync(file, 'utf8') === text) return false
  } catch {
    // 第一次写，或者文件被人删了：照写
  }
  writeFileSync(file, text, 'utf8')
  return true
}

/** `!!js` 标量要经 `Document` 才出得来；纯数据的那两份走 `stringify` 就够。 */
function renderRows(rows: unknown[]): string {
  return new Document(rows).toString()
}

/**
 * 把 preset 写到磁盘，返回路径与"这次动没动文件"。
 *
 * `root` 省略时写进程临时目录（测试与一次性任务）；生产路径由服务进程给
 * `AGENTSWS_DATA_DIR/presets`。目录布局 `<root>/<workspace>/<preset_id>/`：
 * roster 的一个 root 就是**一个品牌**那一层，preset id 在品牌内唯一（52 O1：
 * 品牌 A 的职责 preset 在 B 的任何运行里都看不见）。
 */
export function writePreset(req: RunRequest, root?: string): PresetPaths {
  const comp = presetComposition(req)
  const base = root ?? join(tmpdir(), 'agentsws-dsh-presets')
  const id = presetIdOf(req.actor.role_id)
  const presetRoot = join(base, req.workspace_id)
  const dir = join(presetRoot, id)
  mkdirSync(dir, { recursive: true })
  const composition = join(dir, 'agent.cordis.yml')
  const host = join(dir, 'host.cordis.yml')
  const manifest = join(dir, 'preset.yml')
  const written = [
    writeIfChanged(composition, HEADER + renderRows(comp.rows)),
    writeIfChanged(host, HOST_HEADER + stringify(comp.hostRows)),
    writeIfChanged(manifest, HEADER + stringify(comp.manifest)),
  ].some(Boolean)
  return { dir, root: presetRoot, id, composition, host, manifest, written }
}

/** 这份 preset 的内容指纹（事件里记它：内容没变 = 指纹没变 = 没起新一代）。 */
export function presetDigest(req: RunRequest): string {
  return sha256(canonicalJson(presetComposition(req))).slice(0, 16)
}

/**
 * `!!js` 标量 → loader 的序列化表达式 `{ __jsExpr }`（`cordis-plugin-loader` 的 `JsExpr`，
 * 也就是 include 的 YAML 标签解析出来的那个形）。其余值原样递归拷贝。
 */
function toLoaderValue(value: unknown): unknown {
  if (value instanceof Scalar) {
    return value.tag === '!!js' ? { __jsExpr: String(value.value) } : value.value
  }
  if (Array.isArray(value)) return value.map((v) => toLoaderValue(v))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toLoaderValue(v)]))
  }
  return value
}

/**
 * WP132：交给官方 `dsh-agent-preset-registry` 的那一份定义（`ctx.agentPresets.register()`）。
 *
 * 与 `agent.cordis.yml` 同源（都来自 {@link presetComposition} 的 `rows`），`plugins`
 * 逐行对应文件里的每一行；凭据仍然只有引用（`process.env.<REF> ?? ''` 的表达式），
 * 值在注册那一刻由 loader 求值——**0.1.7 起是注册时就激活**（registry README
 * 「Each declaration eagerly creates a registry-owned scope and an in-memory Loader tree」），
 * 所以宿主的 `withPresetCredentials` 包的是 `register()`，不再是 `mount()`。
 */
export function presetDefinition(req: RunRequest): PresetDefinition {
  const comp = presetComposition(req)
  const manifest = comp.manifest as { name: string; description: string }
  return {
    id: presetIdOf(req.actor.role_id),
    name: manifest.name,
    description: manifest.description,
    plugins: comp.rows.map((r) => toLoaderValue(r)) as PresetDefinition['plugins'],
  }
}
