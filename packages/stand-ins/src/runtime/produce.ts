/**
 * WP260：**要产出东西的运行**（`RunRequest.produce`，现在只有网页模板）三个运行时共用的几样判定。
 *
 * 10-07 真机（ci.16）：网页模板读了一堆文件，以一句「现在读首页模板、FAQ/容器分区……」收工，一个字没改。
 * 停的原因是回合上限（8 回合，见报告），但「说了要做却停下」本身也要兜：这类运行没产出时，模型只回文本、
 * 文本又明显是「我接下来要…」，就不算完成——追加 {@link UNFINISHED_NUDGE} 再跑一回合（有上限）。
 *
 * 另有压缩那一半：压掉一条工具结果时换成「读过哪个文件 + 要点」（{@link compactSummary}），不是空占位。
 */
import type { RunProduce } from '@agentsws/contracts'
import {
  THEME_CHECK_TOOL,
  THEME_FILES_TOOL,
  THEME_READ_FILE_TOOL,
  THEME_WRITE_FILE_TOOL,
  themeReadOf,
} from './theme.js'

/** `progress` 事件的 step（续跑那一跳留痕，Model-visible ⟺ logged）。 */
export const UNFINISHED_STEP = 'continue_unfinished'

/** 续跑那一回合追加给模型的话（三个运行时同一句）。 */
export const UNFINISHED_NUDGE =
  '（系统提示）这件事还没做完：你刚才说了接下来要做什么，就直接调用工具去做，不要停下来汇报进度。' +
  '做完（推出未发布预览、或出了卡）再用一段话交代结果；真的卡住了（缺登录、缺店铺地址等）就照实说卡在哪。' +
  '如果这件事本来就只要回答、不用改东西，直接给出答案。'

/** 被压掉的那条工具结果开头的记号（再压一遍时认得出、跳过）。 */
export const COMPACTED_MARK = '[compacted]'

const bareOf = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name

/** 这个工具成功调过一次，这次运行就算产出了。 */
export function deliversWith(produce: RunProduce | undefined, tool: string): boolean {
  if (produce === undefined) return false
  const bare = bareOf(tool)
  return produce.deliver_tools.some((t) => bareOf(t) === bare)
}

/** 开头就是「现在 / 接下来 / 我先……」+ 一个动作。 */
const START =
  /^(?:好的?|好|ok(?:ay)?|明白了?|收到)?[，,。.!！\s]*(?:现在|接下来|下一步|然后|随后|下面|先|我先|我再|我来|我将|我会|我要|我这就|我马上|马上|让我|开始|继续)[^。！？!?\n]{0,12}?(?:读|看|查|写|改|检查|推|做|生成|创建|调整|整理|补|拉|起底|列|确认|搭|加|更新|修|核对)/i
/** 收尾那一句是「接下来我去……」。 */
const TAIL =
  /(?:接下来|下一步|现在|马上|这就|随后|然后)[^。！？!?\n]{0,8}?(?:读|看|查|写|改|检查|推|做|生成|创建|调整|整理|补|拉|起底|搭|加|更新|修)[^。！？!?\n]*[。.…：:]?\s*$/
const EN =
  /^(?:ok(?:ay)?[,.]?\s*)?(?:now|next|first|then|let me|let's|i(?:'ll| will| am going to| need to))\b/i
const EN_TAIL = /\b(?:let me|i(?:'ll| will| am going to)|next,? i)\b[^.!?\n]*[.:…]?\s*$/i

/**
 * 模型这一句是不是「我接下来要…」（还没干完就停下来汇报）。空话也算（什么都没交代）。
 * 只看开头那句与收尾那句——长篇的结果交代里顺口一句「接下来你可以…」不算（主语不是它自己）。
 */
export function looksUnfinished(text: string): boolean {
  const t = text.trim()
  if (t === '') return true
  if (START.test(t) || EN.test(t)) return true
  const lines = t.split(/\n+/).filter((l) => l.trim() !== '')
  const last = (lines[lines.length - 1] ?? '').trim()
  const lastSentence = last.split(/(?<=[。！？!?])/).pop() ?? last
  if (/[？?]\s*$/.test(lastSentence)) return false
  if (/[：:…]\s*$/.test(last) && t.length < 400) return true
  return TAIL.test(lastSentence) || EN_TAIL.test(lastSentence)
}

// ── 压缩时的摘要 ────────────────────────────────────────────────────────

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)
const list = (xs: readonly string[], n: number): string =>
  xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} 等 ${xs.length} 个`

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
const idsOf = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap((x) => {
        const id = rec(x)?.id ?? rec(x)?.type
        return typeof id === 'string' ? [id] : []
      })
    : []

/** 一个 Liquid 文件的要点：`{% schema %}` 里的名字、设置 id、能放的块。 */
function liquidPoints(content: string): string | undefined {
  const m = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(content)
  const schema = m === null ? undefined : rec(parse(m[1] ?? ''))
  if (schema === undefined) {
    const doc = /@description\s+([^\n]+)/.exec(content)?.[1]
    return doc === undefined ? undefined : `说明：${clip(doc.trim(), 160)}`
  }
  const parts: string[] = []
  if (typeof schema.name === 'string') parts.push(schema.name)
  const settings = idsOf(schema.settings)
  if (settings.length > 0) parts.push(`设置 ${list(settings, 24)}`)
  const blocks = idsOf(schema.blocks)
  if (blocks.length > 0) parts.push(`块 ${list(blocks, 12)}`)
  return parts.join('；')
}

/** 一个 JSON 文件的要点：模板的分区与顺序 / settings_data 的键 / 目录的项数。 */
function jsonPoints(content: string): string | undefined {
  const o = rec(parse(content))
  if (o === undefined) return undefined
  const sections = rec(o.sections)
  if (sections !== undefined) {
    const rows = Object.entries(sections).map(([k, v]) => {
      const type = rec(v)?.type
      return typeof type === 'string' && type !== k ? `${k}(${type})` : k
    })
    const order = Array.isArray(o.order) ? (o.order as unknown[]).map(String) : []
    return `分区 ${list(rows, 16)}${order.length > 0 ? `；顺序 ${list(order, 16)}` : ''}`
  }
  const current = rec(o.current)
  if (current !== undefined) return `current 里的设置 ${list(Object.keys(current), 20)}`
  if (Array.isArray(o.entries)) return `目录 ${(o.entries as unknown[]).length} 项`
  return `顶层 ${list(Object.keys(o), 16)}`
}

function markdownPoints(content: string): string | undefined {
  const heads = content
    .split('\n')
    .filter((l) => /^#{1,3}\s/.test(l))
    .map((l) => l.replace(/^#+\s*/, '').trim())
  return heads.length === 0 ? undefined : `小节 ${list(heads, 10)}`
}

/**
 * 压掉一条工具结果时换成的那一行（不是空占位）：读过哪个文件、多长、要点；要再看原文就再读一次。
 * 认不出来的工具回一句通用的（仍比空占位多一个工具名）。
 */
export function compactSummary(name: string, input: Record<string, unknown>, data: unknown): string {
  const bare = bareOf(name)
  if (bare === THEME_READ_FILE_TOOL) {
    const r = themeReadOf(data)
    const path = r?.path ?? (typeof input.path === 'string' ? input.path : '?')
    if (r === undefined) return `${COMPACTED_MARK} 读过 ${path}（结果已从历史里拿掉；要用就再读一次）`
    const whole = r.total_chars ?? r.content.length
    const part =
      r.catalog === 'index'
        ? `目录页，${r.content.split('\n').filter((l) => l.startsWith('- ')).length} 项`
        : r.catalog === 'entries'
          ? `完整几项：${list(
              idsOf(rec(parse(r.content))?.entries ?? parse(r.content)),
              12,
            )}`
          : r.total_chars === undefined
            ? `全文 ${whole.toLocaleString('en-US')} 字`
            : `第 ${(r.offset ?? 0) + 1} 字起的一段，共 ${whole.toLocaleString('en-US')} 字`
    const points = path.endsWith('.liquid')
      ? liquidPoints(r.content)
      : path.endsWith('.json') && r.catalog === undefined
        ? jsonPoints(r.content)
        : path.endsWith('.md')
          ? markdownPoints(r.content)
          : undefined
    return clip(
      `${COMPACTED_MARK} 读过 ${path}（${part}）${points === undefined ? '' : `。要点：${points}`}。原文已从历史里拿掉以省 token；要照着改就再读一次。`,
      700,
    )
  }
  if (bare === THEME_FILES_TOOL) {
    const files = rec(data)?.files
    return `${COMPACTED_MARK} 列过主题文件（${Array.isArray(files) ? files.length : '?'} 个；要再看就再列一次）`
  }
  if (bare === THEME_CHECK_TOOL) {
    const d = rec(data)
    return `${COMPACTED_MARK} 跑过官方检查：${String(d?.errors ?? '?')} 个错误、${String(d?.warnings ?? '?')} 个提醒（改完要再跑一次）`
  }
  if (bare === THEME_WRITE_FILE_TOOL) {
    const path = rec(data)?.path ?? input.path
    return `${COMPACTED_MARK} 写过 ${String(path)}`
  }
  return `${COMPACTED_MARK} ${bare} 的结果已从历史里拿掉以省 token（要用就再调一次）`
}

/**
 * 这条工具调用读 / 写的是哪个文件（压缩时「被后来的读 / 写顶替了」的那条先压）。
 * 读：同一个路径 + 同一段（offset / ids）；写：同一个路径的所有读都过时了。
 */
export function fileTouch(
  name: string,
  input: Record<string, unknown>,
): { op: 'read' | 'write'; path: string; key: string } | undefined {
  const bare = bareOf(name)
  const path = typeof input.path === 'string' ? input.path.trim().replace(/^\.\//, '') : undefined
  if (path === undefined || path === '') return undefined
  if (bare === THEME_READ_FILE_TOOL) {
    const ids = Array.isArray(input.ids) ? (input.ids as unknown[]).map(String).sort().join(',') : ''
    const offset = typeof input.offset === 'number' ? input.offset : 0
    return { op: 'read', path, key: `${path}|${offset}|${ids}` }
  }
  if (bare === THEME_WRITE_FILE_TOOL) return { op: 'write', path, key: path }
  return undefined
}
