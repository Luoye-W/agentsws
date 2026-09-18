/**
 * 诊断包（WP111）：出问题时**一键导出一个 zip 发回来**。
 *
 * 面向的是一位非技术的内测用户。她说不清"报了什么错"，但她能点一下菜单、
 * 把一个文件拖进聊天窗。所以这一层的全部难点不在收集，在**边界**。
 *
 * ## 白名单，不是黑名单
 *
 * 收什么写死在 {@link DIAGNOSTIC_ITEMS} 里，**一项一项列**；不在表上的一律不收。
 * 反过来做（"把 X 和 Y 去掉"）迟早会漏——将来某个模块往日志里多打一行，
 * 黑名单不会自己长出一条规则来挡它。
 *
 * | 收 | 不收 |
 * |---|---|
 * | 应用与服务版本、平台 / 架构、更新档位 | **任何凭据**（API key、邮箱口令、token、cookie） |
 * | 最近 2000 行日志（已经过脱敏器） | **邮件正文** |
 * | `GET /v1/health` 的响应 | **事件负载** |
 * | 各库的迁移版本表 | **知识库内容**（事实卡、文件、会议纪要） |
 * | 已连的连接器**名字**与状态 | 连接的 `alias` 与身份展示名（那多半就是她的邮箱地址） |
 * | 模块清单 | 数据目录里的任何 `.db` / `.sqlite` |
 *
 * ## 导出前先把清单端给她看
 *
 * {@link diagnosticsListing} 出的那张单子是**给用户读的**，不是给我们对账的：
 * 每项一行人话 + 多大。她点"导出"之前该知道自己在发什么出去。
 *
 * ## 第二道闸
 *
 * 每一份内容出门前再过一遍脱敏器（{@link scrubSecrets} + 注入的 `Redactor`）。
 * 日志那一路本来就脱过敏了；这一遍是为了 `/v1/health` 与将来新加的那几项——
 * 一道闸的东西，加第二道的成本是一行。
 */
import type { Language } from './config.js'
import type { Redactor } from './redact.js'
import { defaultRedactor } from './redact.js'

/** 包里的一份文件。 */
export interface DiagnosticsEntry {
  /** zip 里的文件名（平的，没有子目录）。 */
  name: string
  content: string
}

/** 清单上的一行（给用户看的那张单子）。 */
export interface DiagnosticsItem {
  /** 与 `DiagnosticsEntry.name` 对得上。 */
  name: string
  /** 一句人话：这是什么。 */
  zh: string
  en: string
  bytes: number
}

export interface DiagnosticsBundle {
  entries: DiagnosticsEntry[]
  items: DiagnosticsItem[]
  totalBytes: number
}

/** 日志最多带多少行（够看清最近一次出了什么事，又不至于把整本日志发出去）。 */
export const LOG_TAIL_LINES = 2000

/**
 * 白名单：包里只会有这几样。
 *
 * 加一项就在这里加一行，**并在 `collectDiagnostics` 里给它一个来源**——
 * 没有来源的项不会凭空出现在包里，反过来也一样。
 */
export const DIAGNOSTIC_ITEMS: readonly { name: string; zh: string; en: string }[] = [
  {
    name: 'about.txt',
    zh: '版本、平台、更新档位、服务进程用的是哪个 Node',
    en: 'versions, platform, update mode, which Node runs the service',
  },
  {
    name: 'health.json',
    zh: '服务进程的健康检查响应（GET /v1/health）',
    en: 'the service health response (GET /v1/health)',
  },
  {
    name: 'schema-versions.json',
    zh: '各个库的迁移版本；升级出过事的话还有那张纸条',
    en: 'per-database migration versions, plus the upgrade failure note if any',
  },
  {
    name: 'connectors.txt',
    zh: '已连的连接器**名字**与状态（没有账号、没有密码）',
    en: 'the names and status of connected connectors (no accounts, no passwords)',
  },
  { name: 'modules.txt', zh: '装了哪些模块', en: 'which modules are loaded' },
  {
    name: 'desktop.log',
    zh: `桌面壳最近 ${LOG_TAIL_LINES} 行日志`,
    en: `the last ${LOG_TAIL_LINES} lines of the shell log`,
  },
  {
    name: 'server.log',
    zh: `服务进程最近 ${LOG_TAIL_LINES} 行日志`,
    en: `the last ${LOG_TAIL_LINES} lines of the service log`,
  },
]

// ── 第二道脱敏 ──────────────────────────────────────────────────────────

/**
 * 形态兜底：看起来像密钥的东西一律遮掉。
 *
 * 这不是主防线（主防线是白名单 + 日志那边注册的字面量遮罩），是**万一**：
 * 某天有人往 health 里加了一个字段、或者某个库把 token 打进了日志。
 */
const SECRET_SHAPES: readonly { re: RegExp; to: string }[] = [
  // ① Bearer 排第一：`Authorization: Bearer <token>` 里 `Bearer` 本身会被下面那条
  //    键值对规则当成"值"吃掉，真正的 token 反而留在后面。顺序在这里是语义。
  { re: /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: '$1 [redacted]' },
  // ② 前缀式密钥（OpenAI / Shopify / OpenConnector / GitHub）
  { re: /\b(sk-|shpat_|shpca_|oct_|gh[pousr]_)[A-Za-z0-9_-]{8,}/g, to: '$1[redacted]' },
  // ③ `xxx_key: 值` / `"token": "值"` / `password=值` 这一类的键值对
  {
    re: /(["']?\b\w*(?:api[_-]?key|secret|token|password|passwd|credential|cookie|authorization)\w*\b["']?\s*[:=]\s*["']?)([^"'\s,}]{6,})/gi,
    to: '$1[redacted]',
  },
  // ④ 裸的长十六进制（我们那几把密钥就是 64 位十六进制）
  { re: /\b[0-9a-f]{48,}\b/gi, to: '[redacted]' },
]

export function scrubSecrets(text: string): string {
  let out = text
  for (const { re, to } of SECRET_SHAPES) out = out.replace(re, to)
  return out
}

/** 取最后 n 行（日志文件可能几十 MB，只要尾巴）。 */
export function tailLines(text: string | undefined, n = LOG_TAIL_LINES): string {
  if (text === undefined || text === '') return '（没有这份日志）\n'
  const lines = text.split('\n')
  // 末尾那个空串不算一行
  if (lines[lines.length - 1] === '') lines.pop()
  return `${lines.slice(-n).join('\n')}\n`
}

// ── 收集 ────────────────────────────────────────────────────────────────

/** 已连的一条连接器：**只有名字与状态**。 */
export interface ConnectorSummary {
  service: string
  label?: string
  status?: string
}

export interface DiagnosticsInput {
  appVersion: string
  platform: string
  arch: string
  /** 服务进程用的是哪个 node 可执行文件（装完之后应当指向 `<resources>/node/...`）。 */
  serverExec: string
  /** `updatePolicy()` 那一档与理由。 */
  updateMode: string
  updateReason: string
  /** 本机 / 连公司服务器。 */
  mode: string
  serverUrl: string
  at: string
  /** `GET /v1/health` 的原始响应文本；拿不到就 undefined。 */
  health: string | undefined
  /** 各库迁移版本（`upgrade-state.json` 的内容）。 */
  schemaState: string | undefined
  /** 升级失败那张纸条（有才有）。 */
  upgradeFailure: string | undefined
  /** 已连的连接器：**名字与状态，没有 alias / 身份展示名**。 */
  connectors: readonly ConnectorSummary[] | undefined
  /** 模块清单（`/v1/health` 的 `modules`）。 */
  modules: readonly string[] | undefined
  desktopLog: string | undefined
  serverLog: string | undefined
  /** 日志那边用的脱敏器（把三把密钥的字面量注册进去过）。 */
  redactor?: Redactor
}

const BYTES = (s: string): number => new TextEncoder().encode(s).length

/**
 * 按白名单收一遍。
 *
 * 每一项都**一定出现**（哪怕内容是"这次没有"）：一个缺席的文件与一个空文件，
 * 在排查的时候是两件事——前者会让人怀疑收集本身坏了。
 */
export function collectDiagnostics(input: DiagnosticsInput): DiagnosticsBundle {
  const redact = input.redactor ?? defaultRedactor
  const clean = (text: string): string => scrubSecrets(redact(text))

  const sources: Record<string, string> = {
    'about.txt': [
      `导出时间：${input.at}`,
      `应用版本：${input.appVersion}`,
      `平台：${input.platform} ${input.arch}`,
      `运行模式：${input.mode}`,
      `服务地址：${input.serverUrl}`,
      `服务进程跑在：${input.serverExec}`,
      `更新档位：${input.updateMode}（${input.updateReason}）`,
      '',
      '这个包里没有任何凭据、邮件正文、事件负载或知识库内容。',
      `收了哪几样见 apps/desktop/src/diagnostics.ts 的 DIAGNOSTIC_ITEMS。`,
      '',
    ].join('\n'),
    'health.json': input.health ?? '（服务进程没回话：/v1/health 打不通）\n',
    'schema-versions.json': JSON.stringify(
      {
        upgrade_state: parseOrRaw(input.schemaState),
        upgrade_failure: parseOrRaw(input.upgradeFailure),
      },
      null,
      2,
    ),
    'connectors.txt':
      input.connectors === undefined
        ? '（问不到：服务进程没起来，或者换不到会话）\n'
        : input.connectors.length === 0
          ? '（一条都还没连）\n'
          : `${input.connectors
              .map((c) => `${c.service}\t${c.label ?? ''}\t${c.status ?? ''}`.trimEnd())
              .join('\n')}\n`,
    'modules.txt':
      input.modules === undefined
        ? '（问不到）\n'
        : input.modules.length === 0
          ? '（一个都没有）\n'
          : `${[...input.modules].join('\n')}\n`,
    'desktop.log': tailLines(input.desktopLog),
    'server.log': tailLines(input.serverLog),
  }

  const entries: DiagnosticsEntry[] = []
  const items: DiagnosticsItem[] = []
  for (const item of DIAGNOSTIC_ITEMS) {
    const content = clean(sources[item.name] ?? '（没有这一项）\n')
    entries.push({ name: item.name, content })
    items.push({ name: item.name, zh: item.zh, en: item.en, bytes: BYTES(content) })
  }
  return { entries, items, totalBytes: items.reduce((n, i) => n + i.bytes, 0) }
}

function parseOrRaw(text: string | undefined): unknown {
  if (text === undefined) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// ── 给用户看的那张单子 ──────────────────────────────────────────────────

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 导出前端给用户的清单。
 *
 * 写法有意朴素：**一行一样东西 + 多大**。她要能一眼看完，
 * 并且看完之后有底气把这个文件发出去。
 */
export function diagnosticsListing(bundle: DiagnosticsBundle, language: Language): string {
  const zh = language !== 'en-US'
  const head = zh ? '这个包里有：' : 'This bundle contains:'
  const body = bundle.items.map((i) => `· ${zh ? i.zh : i.en}（${humanBytes(i.bytes)}）`).join('\n')
  const tail = zh
    ? '\n\n没有：任何密码或密钥、邮件正文、事件内容、知识库里的东西。'
    : '\n\nNot included: any password or key, email bodies, event payloads, anything from the knowledge base.'
  return `${head}\n${body}${tail}`
}

/** `agentsws-诊断-0.1.0-beta.2-20260918T100000Z.zip` —— 名字里就带着版本与时间。 */
export function diagnosticsFileName(version: string, at: string): string {
  const stamp = at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `agentsws-诊断-${version}-${stamp}.zip`
}
