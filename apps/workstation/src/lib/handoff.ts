/**
 * WP259：「交给它」那几个入口共用的两件事。
 *
 * 1. **长文本照收**：一段话按 `splitTaskText` 拆——超过事项标题上限或多行时，标题取第一句 /
 *    前 40 字加「…」，完整原文进描述；服务端认得出拆过的标题，路由与首轮运行都用完整原文。
 * 2. **出错说人话**：没交出去时框下一句「没交出去：<服务端那句话>」，不再静默。
 */
import { splitTaskText, TASK_TEXT_MAX } from '@agentsws/contracts'
import { apiErrorText, type Translate } from './error-text'

export { TASK_TEXT_MAX }

/** 一段话 → 交给接口的 `{ title, summary? }`（空白回 `title: ''`，调用方拦下别交）。 */
export function handoffInput(text: string): { title: string; summary?: string } {
  return splitTaskText(text)
}

/** 没交出去的那一句（含服务端给的 `message`；连不上 / 没权限等由 `apiErrorText` 换成人话）。 */
export function handoffErrorText(err: unknown, t: Translate): string {
  return t('handoff.failed', { message: apiErrorText(err, t) })
}
