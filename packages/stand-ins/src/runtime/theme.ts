/**
 * WP253：建站岗位「网页模板」那条职责的**受限主题工具**（不是任意终端）。
 *
 * 用户没有 IT 知识：不开终端、不敲命令。AI 这一侧也不给它一个能跑任意命令的口子——
 * 只给下面这九个名字，每个都落在服务端 `apps/server/src/theme-tools.ts` → `site-theme.ts`：
 *
 * | 工具 | 干什么 | 动线上吗 |
 * |---|---|---|
 * | `theme_init_from_base` | 从开源主题 agentsws-theme（钉死的版本）拉一份到本品牌的主题工作目录 | 不动 |
 * | `theme_list` | 列店里的主题（线上那一份 / 副本） | 只读 |
 * | `theme_pull` | 把线上（或指定那一份）拉到工作目录 | 只读 |
 * | `theme_check` | 官方 `theme check` 本地检查 | 不动 |
 * | `theme_files` / `theme_read_file` / `theme_write_file` | 看 / 改工作目录里的文件（只限这个目录） | 不动 |
 * | `theme_push_unpublished` | 推成一份**未发布**主题，回预览链接 | 线上一个字节不动 |
 * | `theme_publish` | **不发布**：出一张「换线上主题」的审批卡，人批了服务端才发 | 批了才动 |
 *
 * `theme dev`（长驻）不给 AI。名字、给模型看的描述在这里；stub 运行时的那一段剧本也在这里。
 */
import type { PromptSection, RunRequest, ToolDef } from '@agentsws/contracts'

export const THEME_INIT_TOOL = 'theme_init_from_base'
export const THEME_LIST_TOOL = 'theme_list'
export const THEME_PULL_TOOL = 'theme_pull'
export const THEME_CHECK_TOOL = 'theme_check'
export const THEME_FILES_TOOL = 'theme_files'
export const THEME_READ_FILE_TOOL = 'theme_read_file'
export const THEME_WRITE_FILE_TOOL = 'theme_write_file'
export const THEME_PUSH_TOOL = 'theme_push_unpublished'
export const THEME_PUBLISH_TOOL = 'theme_publish'

/** 九个主题工具（排好序：`tools.allow` 要字节稳定）。 */
export const THEME_TOOL_NAMES: readonly string[] = [
  THEME_CHECK_TOOL,
  THEME_FILES_TOOL,
  THEME_INIT_TOOL,
  THEME_LIST_TOOL,
  THEME_PUBLISH_TOOL,
  THEME_PULL_TOOL,
  THEME_PUSH_TOOL,
  THEME_READ_FILE_TOOL,
  THEME_WRITE_FILE_TOOL,
].sort()

/**
 * 有主题工具的职责：网页模板（`site.builder` 是它的旧名，旧回放里还是这个）。
 * 与 `dsh-adapter` 的 `SHELL_ROLE_IDS` 同一张表——**别往这里加别的职责**。
 */
export const THEME_ROLE_IDS: readonly string[] = ['site.shopify-theme', 'site.builder']

export const isThemeRole = (role_id: string): boolean => THEME_ROLE_IDS.includes(role_id)

const PATH_PARAM = {
  type: 'string',
  description: '主题工作目录里的相对路径，例如 templates/index.json、sections/custom-hero.liquid',
}

/** 给模型看的定义（描述写人话：它是在挑工具的那一刻读描述的）。 */
export const THEME_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: THEME_INIT_TOOL,
    description:
      '从开源主题 agentsws-theme（钉死的版本，MIT 许可，LICENSE 原样带上）拉一份到这个品牌的主题工作目录，' +
      '作为搭店的起点。线上一个字节不动。目录里已经有东西时不覆盖；replace=true 会先把旧的挪到一边（不删）再拉。' +
      '拉好之后先用 theme_read_file 读 AGENTS.md 与 CATALOG.json，照里面的规矩改。',
    input_schema: {
      type: 'object',
      properties: {
        replace: { type: 'boolean', description: '目录里已有东西时，先挪到一边再拉（默认 false）' },
      },
    },
  },
  {
    name: THEME_LIST_TOOL,
    description:
      '列出店里的主题：哪一份是线上的（main）、哪些是未发布副本。只读。要先装好 Shopify CLI、登录、知道店铺地址。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: THEME_PULL_TOOL,
    description:
      '把店里线上那一份主题（或给了 theme_id 的那一份）拉到这个品牌的主题工作目录（同名文件会被覆盖）。只读店铺。',
    input_schema: {
      type: 'object',
      properties: { theme_id: { type: 'string', description: '要拉哪一份；不给 = 线上那一份' } },
    },
  },
  {
    name: THEME_CHECK_TOOL,
    description:
      '用 Shopify 官方的 theme check 检查工作目录里的主题（Liquid 语法、缺翻译、不存在的设置等），回错误与警告。' +
      '推送前跑一遍，有 error 先改掉。只在本机跑，不动店铺。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: THEME_FILES_TOOL,
    description:
      '列出主题工作目录里的文件（只列这个目录）。dir 可选，只看某个子目录（如 sections）。',
    input_schema: {
      type: 'object',
      properties: { dir: { type: 'string', description: '子目录（相对路径），不给 = 全部' } },
    },
  },
  {
    name: THEME_READ_FILE_TOOL,
    description:
      '读主题工作目录里的一个文件（只限这个目录）。一次最多回 2.4 万字，长文件回「后面还有」和下一段的 offset。' +
      'CATALOG.json 很大：不给 ids 时回一页目录（每个分区 / 块一行：id + 什么时候用）；' +
      '要某几项的完整设置就给 ids（如 ["hero","faq","container"]）。同一个文件读过一次就别再读。',
    input_schema: {
      type: 'object',
      properties: {
        path: PATH_PARAM,
        offset: {
          type: 'integer',
          description: '从第几个字开始读（上一次回的 next_offset）；不给 = 从头',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: '只对 CATALOG.json：要看哪几项的完整设置（分区 / 块的 id）',
        },
      },
      required: ['path'],
    },
  },
  {
    name: THEME_WRITE_FILE_TOOL,
    description:
      '写主题工作目录里的一个文件（整份内容覆盖；只限这个目录，出不去）。' +
      '用 agentsws-theme 做底时只改 custom-* 文件、templates、section 组、locales 与 config/settings_data.json，' +
      '别动核心文件；assets/app.css 是构建产物不能手改。写完不会动店铺——要看效果用 theme_push_unpublished。',
    input_schema: {
      type: 'object',
      properties: {
        path: PATH_PARAM,
        content: { type: 'string', description: '文件的完整新内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: THEME_PUSH_TOOL,
    description:
      '把工作目录推成店里一份**未发布**主题（线上一个字节不动），回预览链接——预览链接就是给人看的材料。' +
      '同一个名字再推一次会更新那一份副本。name 写人认得出的名字，如「Rollout 首页 v1」。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '这份副本叫什么（店铺后台主题列表里显示）' },
      },
      required: ['name'],
    },
  },
  {
    name: THEME_PUBLISH_TOOL,
    description:
      '**不会直接发布。** 出一张「把这份副本设成线上主题」的审批卡（写清从哪一份换到哪一份、改了哪些文件、预览链接），' +
      '人批了才由工坊换上去。只能对已经推上去的未发布副本提。',
    input_schema: {
      type: 'object',
      properties: {
        theme_id: {
          type: 'string',
          description: '要发布的那份副本的 id（theme_push_unpublished 回的）',
        },
      },
      required: ['theme_id'],
    },
  },
]

export const THEME_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  THEME_TOOL_DEFS.map((d) => [d.name, d]),
)

/**
 * WP260：**网页模板的做法**——带主题工具的运行才进系统提示（服务端 `runtime.ts` 加；order 26：紧跟公共段
 * 「说话规矩」之后、技能正文之前）。persona 有 260 字上限、英文由脚本翻译，放不下一整套工作法，所以单写一节。
 *
 * 10-07 真机（ci.16）：模型把同一批文件读了两三遍、去查店里的商品（店铺没连）、读完说一句「现在读…」就停——
 * 这一节把顺序写死：读一次 → 改模板与设置 → 检查 → 推未发布 → 一段话交代，中途不汇报。
 */
export const THEME_WORK_ORDER = 26

export const THEME_WORK_RULES = [
  '网页模板的做法（一口气做到出预览，中途不停下来汇报；做完再用一段话交代）：',
  '1. 主题工作目录是空的就先起底（agentsws-theme）；起过底就别再起。',
  '2. AGENTS.md 读一次；先读瘦目录 CATALOG.index.json（每项 id / 类型 / 文件 / 什么时候用，v0.9.2 起有），没有它就读 CATALOG.json 的目录页；要用的分区 / 块（如 hero、faq、container、newsletter）再给 ids 读一次 CATALOG.json 的完整设置；recipes/compose-page.md 是搭页面的现成做法。不必读 .liquid 源码，同一个文件读过就别再读。',
  '3. 照 recipes 改 templates/index.json（放哪些分区、什么顺序、每块的设置）和 config/settings_data.json（颜色、字体等主题设置）；新东西只写 custom-* 文件，核心文件不动。',
  '4. 跑官方检查，有错误就改，改到 0 个错误。',
  '5. 推成未发布主题；最后给预览链接、改了哪几块、怎么退回。发布只出卡，等人点。',
  '店铺数据：主推商品、合集先留空占位（人在主题编辑器里挑），不去查店里的商品。店面文案用顾客的语言（照 AGENTS.md）。',
].join('\n')

export function themeWorkSection(): PromptSection {
  return {
    id: 'theme_work',
    name: '网页模板的做法',
    order: THEME_WORK_ORDER,
    text: THEME_WORK_RULES,
  }
}

// ── 回来的数据形状（服务端 `theme-tools.ts` 拼，stub 剧本读） ─────────────

/**
 * WP260：`theme_read_file` 一次最多回这么多字（长文件分页）。工具结果围栏缺省只放 1.2 万字，
 * 10-07 真机读 `sections/faq.liquid`（2.5 万字）只看得见前一半——`{% schema %}` 恰好在文件尾巴上，
 * 模型于是一遍遍重读。主题文件这一路按页给、围栏也按这一页放宽（{@link renderThemeRead}）。
 */
export const THEME_READ_PAGE_CHARS = 24_000

/** `theme_read_file` 回的数据（长文件、目录页才有后面几格）。 */
export interface ThemeReadData {
  path: string
  content: string
  /** 这一页从第几个字开始（分页时才有）。 */
  offset?: number
  /** 整个文件多少字（分页时才有）。 */
  total_chars?: number
  /** 后面还有：下一段从这里读。 */
  next_offset?: number
  /** CATALOG.json：`index` = 一页目录；`entries` = 按 ids 挑出来的完整几项。 */
  catalog?: 'index' | 'entries'
  /** 按 ids 挑时没找到的那几个。 */
  missing?: string[]
  /** 按 ids 挑时这一页放不下、要另读一次的那几个。 */
  more_ids?: string[]
}

export function themeReadOf(data: unknown): ThemeReadData | undefined {
  const o = obj(data)
  return typeof o.path === 'string' && typeof o.content === 'string'
    ? (o as unknown as ThemeReadData)
    : undefined
}

/**
 * WP260：`theme_read_file` 的结果给模型看的那一段（direct / dsh 同一份）：先一行「哪个文件、第几段、
 * 后面还有没有」，再是原文（不转义成 JSON 字符串——换行、引号原样，模型读得懂、也省 token）。
 * 仍然包外部围栏（主题文件可能是从店里拉下来的），围栏的长度上限按一页放宽。
 */
export function renderThemeRead(
  name: string,
  data: unknown,
): { text: string; max_chars: number } | undefined {
  const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  if (bare !== THEME_READ_FILE_TOOL) return undefined
  const r = themeReadOf(data)
  if (r === undefined) return undefined
  const n = (x: number): string => x.toLocaleString('en-US')
  const head =
    r.catalog === 'index'
      ? `主题文件 ${r.path}（目录页：每项一行；要某几项的完整设置再读一次并给 ids）`
      : r.catalog === 'entries'
        ? `主题文件 ${r.path}（按 ids 挑出的完整几项${r.missing !== undefined && r.missing.length > 0 ? `；没有：${r.missing.join(', ')}` : ''}${r.more_ids !== undefined && r.more_ids.length > 0 ? `；这一页放不下，另读一次给 ids=${JSON.stringify(r.more_ids)}` : ''}）`
        : r.total_chars !== undefined
          ? `主题文件 ${r.path}（第 ${n((r.offset ?? 0) + 1)}–${n((r.offset ?? 0) + r.content.length)} 字，共 ${n(r.total_chars)} 字${r.next_offset === undefined ? '，到底了' : `；后面还有，接着读给 offset=${r.next_offset}`}）`
          : `主题文件 ${r.path}（全文，${n(r.content.length)} 字）`
  return { text: `${head}\n\n${r.content}`, max_chars: THEME_READ_PAGE_CHARS + 2_000 }
}

/** 还差哪一步才能动店铺（工具回 error 时一并带上，岗位页同一套话）。 */
export type ThemeNeed = 'install_cli' | 'node' | 'login' | 'store'

export interface ThemeInitData {
  ok: true
  base: { repo: string; version: string; commit: string; license: string }
  files: number
  /** 原来的目录挪去了哪（replace 时才有；人话里不报路径）。 */
  moved_aside?: boolean
}

export interface ThemePushData {
  theme_id: string
  theme_name: string
  preview_url?: string
  /** 相对上一次拉 / 起底的那一份，改了哪些文件。 */
  changed_files: string[]
}

export interface ThemePublishData {
  status: 'staged' | 'blocked'
  message: string
  change_id?: string
  approval_item_id?: string
  kind: 'publish_theme'
}

export interface ThemeCheckData {
  errors: number
  warnings: number
  offenses: { path: string; severity: string; message: string; line?: number }[]
}

// ── stub 剧本 ───────────────────────────────────────────────────────────

const PUBLISH = /发布|上线|换上|设为线上|publish|go live/i
const BUILD = /搭|做|建|改|首页|主题|模板|预览|agentsws-theme|homepage|theme|preview|build/i
const BASE = /agentsws-theme|开源主题|从头|新主题|起底/i

export interface ThemeStep {
  tool: string
  input: Record<string, unknown>
}

/**
 * stub 的岔口：网页模板职责、工具面里有主题工具、而且说的是主题，才走这一边；否则照旧。
 * 回的是要调的第一批工具（发布那一步要先知道推上去的 id，由剧本在推完之后接着调）。
 *
 * - 说「发布 / 上线」→ 先列一次，再对最新那份副本提发布卡；
 * - 说「用 agentsws-theme 搭」→ 起底 → 检查 → 推未发布副本；
 * - 别的主题活 → 检查 → 推未发布副本（stub 不会写 Liquid，改文件那一步留给真模型）。
 */
export function themeBranch(req: RunRequest, text: string): ThemeStep[] | undefined {
  if (!isThemeRole(req.actor.role_id)) return undefined
  const has = (n: string): boolean => req.tools.allow.includes(n)
  if (!has(THEME_PUSH_TOOL)) return undefined
  if (PUBLISH.test(text) && has(THEME_LIST_TOOL)) return [{ tool: THEME_LIST_TOOL, input: {} }]
  if (!BUILD.test(text)) return undefined
  const name = BASE.test(text) ? '首页草稿（agentsws-theme）' : '主题改动草稿'
  return [
    ...(BASE.test(text) ? [{ tool: THEME_INIT_TOOL, input: {} }] : []),
    { tool: THEME_CHECK_TOOL, input: {} },
    { tool: THEME_PUSH_TOOL, input: { name } },
  ]
}

const obj = (data: unknown): Record<string, unknown> =>
  data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}

export function pushedOf(data: unknown): ThemePushData | undefined {
  const o = obj(data)
  return typeof o.theme_id === 'string' && typeof o.theme_name === 'string'
    ? (o as unknown as ThemePushData)
    : undefined
}

export function checkOf(data: unknown): ThemeCheckData | undefined {
  const o = obj(data)
  return typeof o.errors === 'number' ? (o as unknown as ThemeCheckData) : undefined
}

export function publishOf(data: unknown): ThemePublishData | undefined {
  const o = obj(data)
  return o.kind === 'publish_theme' && typeof o.message === 'string'
    ? (o as unknown as ThemePublishData)
    : undefined
}

/** 列主题回的数据里挑最新的那份未发布副本（发布那一步要它）。 */
export function latestCopyOf(data: unknown): { id: string; name: string } | undefined {
  const rows = Array.isArray(obj(data).themes) ? (obj(data).themes as unknown[]) : []
  const copies = rows
    .map(obj)
    .filter((r) => typeof r.id === 'string' && r.role !== 'main' && r.role !== 'development')
  const last = copies[copies.length - 1]
  return last === undefined
    ? undefined
    : { id: String(last.id), name: String(last.name ?? last.id) }
}

/** stub 给网页模板的那段回话（markdown）。没走通的那一步照实说，不编。 */
export function renderThemeAnswer(input: {
  initialized?: boolean
  check?: ThemeCheckData
  pushed?: ThemePushData
  published?: ThemePublishData
  failed: Readonly<Record<string, string>>
}): string {
  const lines: string[] = []
  if (input.initialized === true)
    lines.push('从开源主题 agentsws-theme 起了底（钉死的版本，LICENSE 原样带着）。')
  else if (input.failed[THEME_INIT_TOOL] !== undefined)
    lines.push(`没起成底：${input.failed[THEME_INIT_TOOL]}`)
  if (input.check !== undefined)
    lines.push(
      input.check.errors === 0
        ? `官方检查过了：0 个错误${input.check.warnings > 0 ? `、${input.check.warnings} 个提醒` : ''}。`
        : `官方检查有 ${input.check.errors} 个错误，先没推。`,
    )
  const p = input.pushed
  if (p !== undefined) {
    lines.push(
      `**预览好了**：推成了一份未发布主题「${p.theme_name}」，线上没动。`,
      p.preview_url === undefined
        ? '预览链接没拿到，去店铺后台主题列表里点开它。'
        : `预览：${p.preview_url}`,
    )
    if (p.changed_files.length > 0) lines.push(`这次改了 ${p.changed_files.length} 个文件。`)
    lines.push('看着满意，跟我说「发布」，我出一张换线上主题的卡，你批了才换。')
  } else if (input.failed[THEME_PUSH_TOOL] !== undefined) {
    lines.push(`没推成预览：${input.failed[THEME_PUSH_TOOL]}`)
  }
  const pub = input.published
  if (pub !== undefined) lines.push(pub.message)
  else if (input.failed[THEME_PUBLISH_TOOL] !== undefined)
    lines.push(`没出成发布卡：${input.failed[THEME_PUBLISH_TOOL]}`)
  else if (input.failed[THEME_LIST_TOOL] !== undefined)
    lines.push(`没读到店里的主题：${input.failed[THEME_LIST_TOOL]}`)
  return lines.length === 0 ? '这次没动主题。' : lines.join('\n')
}
