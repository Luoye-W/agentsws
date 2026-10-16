/**
 * WP350（决策 900）：「我的助理」输入框附上的文本类资料——会议记录、文档、聊天记录。
 *
 * 只认四种：.txt / .md（直接读字）、.docx / .pdf（零依赖读文字层，与品牌设计规范读手册同一份读法，
 * `@agentsws/brand-design` 的 `officePages` / `pdfPages`）。读不出字的（扫描件、加了密、改了名的二进制）
 * **照实说**，不假装读到了。
 *
 * 读出来的字先过一道口令识别（决策 814「只有密钥不经 AI」）：密钥形态的串、`密码：…` 这类一律抹掉再进模型，
 * 抹了几处记在附件上（界面上说一句）。存在本机会话里（`free-chat.sqlite`，和图片一样跟着会话走），
 * 列会话时不回给界面——界面只显示名字与字数。纯函数：不碰磁盘、不碰网络。
 */
import type { FreeChatAttachment } from '@agentsws/api'
import { officePages, pdfPages } from '@agentsws/brand-design'
import { scrub } from '@agentsws/core'

/** 认这四种（扩展名，小写）。 */
export const ASSISTANT_FILE_EXTENSIONS = ['txt', 'md', 'docx', 'pdf'] as const
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
    return no('这种文件读不了：换成 .txt / .md / .docx / .pdf，或者直接把字贴进来')
  const bytes = Buffer.from(file.data, 'base64')
  if (bytes.length === 0) return no('这份文件是空的')
  if (bytes.length > ASSISTANT_FILE_MAX_BYTES) return no('这份文件超过 5 MB，拆小一点再附')
  let raw = ''
  if (ext === 'txt' || ext === 'md') {
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
    ...(clipped ? { unreadable: `太长了，只读了前 ${ASSISTANT_FILE_MAX_CHARS} 字` } : {}),
  }
}

/** 这份资料是什么：名字或开头像会议记录 → `meeting`，否则 `document`。 */
export function sourceKindOf(a: FreeChatAttachment): 'meeting' | 'document' {
  const hay = `${a.name} ${(a.text ?? '').slice(0, 200)}`
  return /会议|纪要|周会|例会|晨会|复盘|meeting|minutes|standup/iu.test(hay)
    ? 'meeting'
    : 'document'
}

/** 界面上那一份不带正文（正文只在服务端会话里）。 */
export const publicAttachment = (a: FreeChatAttachment): FreeChatAttachment => {
  const { text: _t, ...rest } = a
  return rest
}
