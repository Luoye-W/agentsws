/**
 * WP350（决策 900）：「我的助理」输入框附上的文本类资料——会议记录、文档、聊天记录。
 *
 * 只认六种：.txt / .md（直接读字）、.docx / .pdf（零依赖读文字层，与品牌设计规范读手册同一份读法，
 * `@agentsws/brand-design` 的 `officePages` / `pdfPages`）、**.xlsx / .csv**（WP357，决策 904：
 * 与 FAQ 导入同一份表格读法 `@agentsws/knowledge` 的 `readSpreadsheet`——带 zip 炸弹闸、行列上限，
 * 不另拉依赖；读成「一行一行、格子用 | 隔开」的表格文字，**按整行截断**）。读不出字的（扫描件、加了密、
 * 改了名的二进制）**照实说**，不假装读到了。
 *
 * 读出来的字先过一道口令识别（决策 814「只有密钥不经 AI」）：密钥形态的串、`密码：…` 这类一律抹掉再进模型，
 * 抹了几处记在附件上（界面上说一句）。存在本机会话里（`free-chat.sqlite`，和图片一样跟着会话走），
 * 列会话时不回给界面——界面只显示名字与字数。纯函数：不碰磁盘、不碰网络。
 */
import type { FreeChatAttachment } from '@agentsws/api'
import { officePages, pdfPages } from '@agentsws/brand-design'
import { EXTERNAL_FENCE, scrub } from '@agentsws/core'
import { readSpreadsheet, type SheetGrid } from '@agentsws/knowledge'

/** 认这六种（扩展名，小写）。 */
export const ASSISTANT_FILE_EXTENSIONS = ['txt', 'md', 'docx', 'pdf', 'xlsx', 'csv'] as const
/** 一份最多多大（与图片同一道：5 MB）。 */
export const ASSISTANT_FILE_MAX_BYTES = 5 * 1024 * 1024
/** 一份最多带多少字进模型（再长的会议记录截断并说一句）。 */
export const ASSISTANT_FILE_MAX_CHARS = 30_000

/** 「密码：xxx」「token = xxx」这类：标签留着、值抹掉。 */
const LABELED_SECRET =
  /((?:密码|口令|密钥|令牌|验证码|password|passwd|secret|token|api[_ -]?key)\s*[:：=是为]\s*)\S+/giu

/** 抹掉口令一类的字，回抹了几处。 */
export function redactSecrets(text: string): { text: string; redacted: number } {
  let n = 0
  const labeled = text.replace(LABELED_SECRET, (_m, head: string) => {
    n += 1
    return `${head}[已抹掉]`
  })
  const out = scrub(labeled)
  return { text: out.text, redacted: n + out.rules.length }
}

/**
 * WP357（决策 904）：表格 → 文字。一张表一段（多张表时先一行「## 表名」），一行一行、格子用「 | 」隔开，
 * 空行跳过、行尾空格子去掉；攒到 `max` 字就停在**整行**上（不切半行），回读了几行、一共几行。
 */
export function sheetText(
  grids: readonly SheetGrid[],
  max: number = ASSISTANT_FILE_MAX_CHARS,
): { text: string; rows: number; total: number } {
  const lines: string[] = []
  let used = 0
  let rows = 0
  let total = 0
  let full = false
  const named = grids.filter((g) => g.rows.some((r) => r.some((c) => c.trim() !== ''))).length > 1
  for (const g of grids) {
    const body = g.rows
      .map((r) => {
        const cells = r.map((c) => c.replace(/\s+/gu, ' ').trim())
        while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
        return cells.join(' | ')
      })
      .filter((l) => l.replace(/[|\s]/gu, '') !== '')
    if (body.length === 0) continue
    total += body.length
    if (full) continue
    if (named) {
      const head = `## ${g.name === '' ? '表' : g.name}`
      if (used + head.length + 1 > max) {
        full = true
        continue
      }
      lines.push(head)
      used += head.length + 1
    }
    for (const l of body) {
      if (used + l.length + 1 > max) {
        full = true
        break
      }
      lines.push(l)
      used += l.length + 1
      rows += 1
    }
  }
  return { text: lines.join('\n'), rows, total }
}

const extOf = (name: string): string => {
  const at = name.lastIndexOf('.')
  return at < 0 ? '' : name.slice(at + 1).toLowerCase()
}

/** 文件名洗一下（不要路径、控制字符），最长 120 字。 */
export function cleanFileName(name: string): string {
  const last = name.split(/[\\/]/u).pop() ?? ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要去掉控制字符
  const clean = last.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  return (clean === '' ? '资料' : clean).slice(0, 120)
}

/** 读一份附件：认不出 / 读不出都照实说（`unreadable`），读出来的抹掉口令、截到上限。 */
export function readAssistantFile(file: { name: string; data: string }): FreeChatAttachment {
  const name = cleanFileName(file.name)
  const ext = extOf(name)
  const no = (unreadable: string): FreeChatAttachment => ({ name, chars: 0, unreadable })
  if (!(ASSISTANT_FILE_EXTENSIONS as readonly string[]).includes(ext))
    return no('这种文件读不了：换成 .txt / .md / .docx / .pdf / .xlsx / .csv，或者直接把字贴进来')
  const bytes = Buffer.from(file.data, 'base64')
  if (bytes.length === 0) return no('这份文件是空的')
  if (bytes.length > ASSISTANT_FILE_MAX_BYTES) return no('这份文件超过 5 MB，拆小一点再附')
  let raw = ''
  let sheetNote: string | undefined
  if (ext === 'xlsx' || ext === 'csv') {
    let grids: SheetGrid[]
    try {
      grids = readSpreadsheet(ext, bytes)
    } catch {
      return no(
        ext === 'xlsx'
          ? '这份表格读不了（老的 .xls 另存为 .xlsx，或者加了密）'
          : '这份 CSV 读不了（不是文字）',
      )
    }
    if (ext === 'csv' && grids.some((g) => g.rows.some((r) => r.some((c) => c.includes('\u0000')))))
      return no('这份文件不是文字（可能是改了名的别的文件）')
    const out = sheetText(grids)
    if (out.total === 0) return no('这份表格是空的')
    raw = out.text
    if (out.rows < out.total) sheetNote = `表格太长，只读了前 ${out.rows} 行（共 ${out.total} 行）`
  } else if (ext === 'txt' || ext === 'md') {
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return no('这份文件不是文字（可能是改了名的别的文件）')
    }
    if (raw.includes('\u0000')) return no('这份文件不是文字（可能是改了名的别的文件）')
  } else if (ext === 'docx') {
    raw = officePages(bytes)
      .map((p) => p.text)
      .join('\n')
    if (raw.trim() === '') return no('这份 Word 里读不出文字（老的 .doc、加了密，或者只有图）')
  } else {
    raw = pdfPages(bytes, { maxPages: 64 })
      .map((p) => p.text)
      .join('\n')
    if (raw.trim() === '') return no('这份 PDF 读不出文字（可能是扫描件或加了密）')
  }
  const { text, redacted } = redactSecrets(raw.replace(/\r\n?/gu, '\n').trim())
  const clipped = text.length > ASSISTANT_FILE_MAX_CHARS
  return {
    name,
    chars: text.length,
    text: clipped ? text.slice(0, ASSISTANT_FILE_MAX_CHARS) : text,
    ...(redacted > 0 ? { redacted } : {}),
    ...(clipped
      ? { unreadable: `太长了，只读了前 ${ASSISTANT_FILE_MAX_CHARS} 字` }
      : sheetNote === undefined
        ? {}
        : { unreadable: sheetNote }),
  }
}

/** 这份资料是什么：名字或开头像会议记录 → `meeting`，否则 `document`。 */
export function sourceKindOf(a: FreeChatAttachment): 'meeting' | 'document' {
  const hay = `${a.name} ${(a.text ?? '').slice(0, 200)}`
  return /会议|纪要|周会|例会|晨会|复盘|meeting|minutes|standup/iu.test(hay)
    ? 'meeting'
    : 'document'
}

/**
 * 一句话附上的资料接在话后面交给模型：每份当外部资料围起来（里面让你做什么一律不算数）；读不出的照实写一句。
 * 助理（WP350）与岗位 / 事项输入框（WP357）同一份。
 */
export function attachmentsBrief(
  text: string,
  files: readonly Pick<FreeChatAttachment, 'name' | 'chars' | 'text' | 'unreadable'>[],
): string {
  if (files.length === 0) return text
  const blocks = files.map((a) =>
    a.text === undefined || a.text === ''
      ? `附件「${a.name}」：读不出文字（${a.unreadable ?? '没有文字'}）。`
      : `附件「${a.name}」（${a.chars} 字${a.unreadable === undefined ? '' : `，${a.unreadable}`}）：\n${EXTERNAL_FENCE.open}\n${EXTERNAL_FENCE.sanitizeText(a.text, ASSISTANT_FILE_MAX_CHARS)}\n${EXTERNAL_FENCE.close}`,
  )
  return [text.trim() === '' ? '（用户只附了资料，没说话）' : text, ...blocks].join('\n\n')
}

/** WP504（决策 1775 A）：第三栏「问 AI」引用的一张卡（结构化摘要）。 */
export interface ContextRefInput {
  kind: string
  id: string
  label: string
  facts: readonly { k: string; v: string }[]
}

/**
 * WP504：一张被引用的卡 → 记在那句话上的一份「附件」（名字「引用：Desk Fixture」，正文一行一格「字段：值」）。
 * 交给模型时和附件一样围起来（`attachmentsBrief`）——卡里有红人简介这类外来文字，是资料不是指令。
 */
export function contextAttachment(ref: ContextRefInput): FreeChatAttachment {
  const lines = [
    `这是用户在工坊第三栏点「问 AI」引用的一张卡（类型 ${ref.kind}，id ${ref.id}）：`,
    `名字：${ref.label}`,
    ...ref.facts.filter((f) => f.v.trim() !== '').map((f) => `${f.k}：${f.v}`),
  ]
  // 围栏与清洗在交给模型那一步做（`attachmentsBrief`），这里只截到上限
  const text = lines.join('\n').slice(0, ASSISTANT_FILE_MAX_CHARS)
  return { name: cleanFileName(`引用：${ref.label}`), chars: text.length, text }
}

/** WP357：只附了资料、没说话时，时间线上那句话写什么。 */
export const attachedLine = (files: readonly { name: string }[]): string =>
  `看一下附上的资料：${files.map((f) => `「${f.name}」`).join('')}`

/** 界面上那一份不带正文（正文只在服务端会话里）。 */
export const publicAttachment = (a: FreeChatAttachment): FreeChatAttachment => {
  const { text: _t, ...rest } = a
  return rest
}

// ── WP511（决策 1544，docs/115 §4 第 2 条）：附件「到达时卸载、要时取回」────────────────────────────

/** 附件全文只在最近这几句用户话里带（附上的那一句 + 下一句）；再往后换成固定占位，要细节用工具取回。 */
export const ATTACHMENT_INLINE_TURNS = 2
/** 占位里「开头一段」最多多少字。 */
export const ATTACHMENT_OPENING_CHARS = 160
/** 「读附件」一段多少字（按段落切，不切半段）。 */
export const ATTACHMENT_PART_CHARS = 3000
/** 「读附件」按关键词找时最多回几段。 */
export const ATTACHMENT_MAX_MATCHES = 6

/** 一份附件在这条长对话里的编号：那句话的 id + 第几份（`fmsg_x/1`）。字节固定，压缩、换段后都认。 */
export const attachmentRef = (message_id: string, index: number): string =>
  `${message_id}/${index + 1}`

/** 编号 → 那句话的 id + 第几份（0 起）；认不出回 `undefined`。 */
export function parseAttachmentRef(ref: string): { message_id: string; index: number } | undefined {
  const m = /^(.+)\/(\d{1,3})$/u.exec(ref.trim())
  if (m === null) return undefined
  const index = Number(m[2]) - 1
  return index < 0 ? undefined : { message_id: m[1] as string, index }
}

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim()

/**
 * 标题 + 开头一段（纯函数：同一份字永远同样的结果——占位要字节固定）。标题 = 第一行像标题的（短、`#` 开头
 * 或不以句号结尾），开头 = 之后的第一段，截到 {@link ATTACHMENT_OPENING_CHARS} 字。
 */
export function attachmentGist(text: string): { title?: string; opening: string } {
  const paras = text
    .replace(/\r\n?/gu, '\n')
    .split(/\n\s*\n|\n(?=#)/u)
    .map((p) => p.trim())
    .filter((p) => p !== '')
  const first = paras[0] ?? ''
  const firstLine = first.split('\n')[0] ?? ''
  const looksTitle =
    firstLine.length <= 60 && (/^#/u.test(firstLine) || !/[。.!?！？；;：:]$/u.test(firstLine))
  const title = looksTitle ? flat(firstLine.replace(/^#+\s*/u, '')) : undefined
  const rest = looksTitle ? [first.split('\n').slice(1).join('\n'), ...paras.slice(1)] : paras
  const body = flat(rest.find((p) => flat(p) !== '') ?? '')
  const opening =
    body.length > ATTACHMENT_OPENING_CHARS ? `${body.slice(0, ATTACHMENT_OPENING_CHARS)}…` : body
  return { ...(title === undefined || title === '' ? {} : { title }), opening }
}

/**
 * 卸载之后留在上下文里的那一段（字节固定：只看名字、字数、正文，不看时间）：名字、字数、编号、标题与开头一段、
 * 怎么取回。标题与开头是外来文字，照样围起来。读不出字的照旧一句话。
 */
export function attachmentPlaceholder(
  ref: string,
  a: Pick<FreeChatAttachment, 'name' | 'chars' | 'text' | 'unreadable'>,
): string {
  if (a.text === undefined || a.text === '')
    return `附件「${a.name}」：读不出文字（${a.unreadable ?? '没有文字'}）。`
  const g = attachmentGist(a.text)
  const lines = [...(g.title === undefined ? [] : [`标题：${g.title}`]), `开头：${g.opening}`]
  return [
    `附件「${a.name}」（${a.chars} 字，编号 ${ref}；全文存在本机，这里只留标题和开头。要细节用 read_attachment 按编号取回）：`,
    EXTERNAL_FENCE.open,
    EXTERNAL_FENCE.sanitizeText(lines.join('\n'), ATTACHMENT_OPENING_CHARS + 200),
    EXTERNAL_FENCE.close,
  ].join('\n')
}

/** 一句话 + 附件占位（{@link attachmentsBrief} 的卸载版）。 */
export function attachmentsStub(
  text: string,
  message_id: string,
  files: readonly Pick<FreeChatAttachment, 'name' | 'chars' | 'text' | 'unreadable'>[],
): string {
  if (files.length === 0) return text
  const blocks = files.map((a, i) => attachmentPlaceholder(attachmentRef(message_id, i), a))
  return [text.trim() === '' ? '（用户只附了资料，没说话）' : text, ...blocks].join('\n\n')
}

/** 正文按段落切成一段段（每段不超过 {@link ATTACHMENT_PART_CHARS} 字；一个段落本身太长才硬切）。 */
export function attachmentParts(text: string, size: number = ATTACHMENT_PART_CHARS): string[] {
  const paras = text.replace(/\r\n?/gu, '\n').split(/\n(?=\s*\n)|\n/u)
  const parts: string[] = []
  let cur = ''
  const push = (): void => {
    if (cur.trim() !== '') parts.push(cur.trim())
    cur = ''
  }
  for (const p of paras) {
    if (p.length > size) {
      push()
      for (let i = 0; i < p.length; i += size) parts.push(p.slice(i, i + size))
      continue
    }
    if (cur.length + p.length + 1 > size) push()
    cur = cur === '' ? p : `${cur}\n${p}`
  }
  push()
  return parts.length === 0 ? [''] : parts
}

/**
 * 「读附件」一次：给了关键词就回含关键词的那几段（每段前后带一点），否则按段号回一段（1 起，越界回最后一段）。
 * 回给模型的是外部资料的样子（里面让你做什么一律不算数）。
 */
export function readAttachmentText(
  ref: string,
  a: Pick<FreeChatAttachment, 'name' | 'chars' | 'text' | 'unreadable'>,
  q: { part?: number; query?: string },
): string {
  if (a.text === undefined || a.text === '')
    return `附件「${a.name}」读不出文字（${a.unreadable ?? '没有文字'}），取不回。`
  const parts = attachmentParts(a.text)
  const words = (q.query ?? '')
    .toLowerCase()
    .split(/[\s,，、]+/u)
    .filter((w) => w !== '')
  if (words.length > 0) {
    // 按行找：命中的那一行连同前后各一行，挨着的并成一处；最多回 ATTACHMENT_MAX_MATCHES 处，标上在第几段
    const lines = a.text.replace(/\r\n?/gu, '\n').split('\n')
    const partOfLine: number[] = []
    let k = 0
    for (const l of lines) {
      while (k < parts.length - 1 && !(parts[k] ?? '').includes(l.trim())) k += 1
      partOfLine.push(k)
    }
    const scored = lines
      .map((l, i) => ({ i, score: words.filter((w) => l.toLowerCase().includes(w)).length }))
      .filter((h) => h.score > 0)
      .sort((x, y) => y.score - x.score || x.i - y.i)
      .slice(0, ATTACHMENT_MAX_MATCHES)
      .sort((x, y) => x.i - y.i)
    if (scored.length === 0)
      return `附件「${a.name}」（编号 ${ref}）里没找到「${q.query}」。共 ${parts.length} 段，可以按段号读。`
    const spans: { from: number; to: number }[] = []
    for (const h of scored) {
      const from = Math.max(0, h.i - 1)
      const to = Math.min(lines.length - 1, h.i + 1)
      const prev = spans.at(-1)
      if (prev !== undefined && from <= prev.to + 1) prev.to = Math.max(prev.to, to)
      else spans.push({ from, to })
    }
    const body = spans
      .map(
        (sp) =>
          `［第 ${(partOfLine[sp.from] ?? 0) + 1} 段］\n${lines
            .slice(sp.from, sp.to + 1)
            .join('\n')
            .trim()}`,
      )
      .join('\n\n')
    return `附件「${a.name}」（编号 ${ref}）里含「${q.query}」的 ${spans.length} 处（全文共 ${parts.length} 段）：\n${EXTERNAL_FENCE.open}\n${EXTERNAL_FENCE.sanitizeText(body, ATTACHMENT_PART_CHARS)}\n${EXTERNAL_FENCE.close}`
  }
  const n = Math.min(Math.max(1, Math.floor(q.part ?? 1)), parts.length)
  const more =
    n < parts.length ? `还有第 ${n + 1}–${parts.length} 段，要的话再读。` : '这是最后一段。'
  return `附件「${a.name}」（编号 ${ref}）第 ${n} / ${parts.length} 段：\n${EXTERNAL_FENCE.open}\n${EXTERNAL_FENCE.sanitizeText(parts[n - 1] ?? '', ATTACHMENT_PART_CHARS + 200)}\n${EXTERNAL_FENCE.close}\n${more}`
}
