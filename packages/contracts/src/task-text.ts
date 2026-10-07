/**
 * WP259：「交给它」那一段话怎么拆成事项标题 + 完整原文。
 *
 * 事项标题有上限（`MATTER_TITLE_MAX`，`POST /v1/matters` 一直是 120）。人一口气写 170 字、
 * 分好几行交给 AI 是常事——原来整段塞进标题，超了就 400，界面还不吭声。现在一条规矩，
 * 工作台与服务端共用（服务端兜底：直接调接口传超长标题的也照这条拆，不再 400）：
 *
 * - 一行、不超过上限：原样当标题，没有描述；
 * - 超过上限或多行：标题取第一句（不超过 `TASK_TITLE_HEAD` 字）或前 `TASK_TITLE_HEAD` 字，
 *   后面加「…」；**完整原文**进事项描述，也是首轮运行收到的任务文本、路由判的那段话。
 *
 * 拆出来的标题永远是原文的开头（去掉「…」与句末标点后），所以服务端拿到
 * `title + summary` 时能认出「标题是从描述里摘的」——这时交给运行的就是描述本身，
 * 不再把开头重复一遍（`taskTextOf`）。
 */

/** 事项标题上限（与 `POST /v1/matters` 的 `title` 校验同一个数）。 */
export const MATTER_TITLE_MAX = 120

/** 拆长文本时标题最多取多少字（第一句更短就用第一句）。 */
export const TASK_TITLE_HEAD = 40

/** 「交给它」一段话的上限（与事项里说一句话 `MessageBody.text` 同一个数）。 */
export const TASK_TEXT_MAX = 4000

const ELLIPSIS = '…'
/** 句末标点：中英文句号、问号、叹号、分号。 */
const SENTENCE_END = /[。！？!?；;]|\.(?=\s|$)/u

/** 标题去掉末尾的「…」——拿来比「原文是不是以它开头」。 */
const stemOf = (title: string): string =>
  title.endsWith(ELLIPSIS) ? title.slice(0, -ELLIPSIS.length).trimEnd() : title

/** 按字（码点）截，不把表情 / 生僻字切成半个。 */
const headChars = (text: string, n: number): string => Array.from(text).slice(0, n).join('')
const charCount = (text: string): number => Array.from(text).length

/** 这段话要不要拆（超过标题上限，或者不止一行）。 */
export function needsTaskSplit(text: string): boolean {
  const trimmed = text.trim()
  return charCount(trimmed) > MATTER_TITLE_MAX || /[\r\n]/.test(trimmed)
}

/**
 * 一段话 → `{ title, summary? }`。空白返回 `title: ''`（调用方自己拦，别交出去）。
 * 不用拆时没有 `summary`；拆了 `summary` 就是去掉首尾空白的完整原文。
 */
export function splitTaskText(text: string): { title: string; summary?: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { title: '' }
  if (!needsTaskSplit(trimmed)) return { title: trimmed }
  const firstLine = (trimmed.split(/\r?\n/u)[0] ?? '').trim()
  const end = firstLine.search(SENTENCE_END)
  const sentence = (end === -1 ? firstLine : firstLine.slice(0, end)).trimEnd()
  const head =
    sentence !== '' && charCount(sentence) <= TASK_TITLE_HEAD
      ? sentence
      : headChars(firstLine, TASK_TITLE_HEAD).trimEnd()
  return { title: `${head}${ELLIPSIS}`, summary: trimmed }
}

/**
 * 服务端兜底：标题超长 / 多行就按 `splitTaskText` 拆，原文放进描述（描述本来就有的接在原文后面）。
 * 标题本来就合规的原样返回（老调用一个字不变）。
 */
export function fitTaskTitle<T extends { title: string; summary?: string | undefined }>(
  input: T,
): T {
  if (!needsTaskSplit(input.title)) return input
  const split = splitTaskText(input.title)
  const full = split.summary ?? split.title
  const extra = input.summary?.trim() ?? ''
  return { ...input, title: split.title, summary: extra === '' ? full : `${full}\n\n${extra}` }
}

/** 标题是不是从这段描述的开头摘出来的（拆长文本时的样子）。 */
export function titleFromSummary(title: string, summary: string | undefined): boolean {
  if (summary === undefined || !title.endsWith(ELLIPSIS)) return false
  const stem = stemOf(title)
  return stem !== '' && summary.trimStart().startsWith(stem)
}

/**
 * 交给路由与首轮运行的那段话：标题是从描述里摘的 → 就是描述（完整原文）；
 * 否则照老规矩「标题 + 空格 + 描述」（随便聊带过来的上下文就是这么接的）。
 */
export function taskTextOf(title: string, summary: string | undefined): string {
  if (summary === undefined || summary.trim() === '') return title
  return titleFromSummary(title, summary) ? summary.trim() : `${title} ${summary}`
}

/** 这条人话是不是这件事的原话（以标题开头；拆过的标题去掉「…」再比）。 */
export function isTaskBrief(title: string, text: string): boolean {
  const stem = stemOf(title)
  return stem !== '' && text.startsWith(stem)
}
