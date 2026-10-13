/**
 * WP298：工作台窗口（渲染进程）的报错记进 `desktop.log`。
 *
 * Luoye 10-13 在 Windows 上点「消息渠道」主区一片空白，`desktop.log` 里什么也没有——
 * 渲染进程里的错误只进了 DevTools 的控制台。现在主窗口的四样事都落一行：
 * - `console-message` 里 level=error 的（React 接住的错误、未捕获异常都会打到这里）；
 * - `render-process-gone`（渲染进程崩了 / 被杀了 / 内存爆了）；
 * - `did-fail-load`（主框架没加载出来；用户自己取消的 -3 不记）；
 * - `unresponsive`（页面卡死）。
 *
 * 每一行出门前：去网址查询串、换掉邮箱、截到 500 字、一条一行；一分钟最多 30 行
 * （页面死循环刷错也写不爆日志）。密钥字面量另有 logger 自己的脱敏器兜着。
 *
 * 这里**不 import electron**（README：只有 main.ts / preload 碰它），收的是一个只会 `on` 的对象。
 */
import type { Logger } from './logging.js'

/** `webContents` 里用得到的那一点。 */
export interface RendererEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

const MAX_TEXT = 500
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 30

/** 去查询串 / 片段（行列号留着）、换掉邮箱、去控制字符、截长。 */
export function scrubRendererText(text: string): string {
  const cleaned = text
    .replace(/\b(?:https?|wss?|file):\/\/[^\s)'"]+/g, (raw) => {
      const pos = /(?::\d+){1,2}$/.exec(raw)?.[0] ?? ''
      return `${raw.slice(0, raw.length - pos.length).replace(/[?#].*$/, '')}${pos}`
    })
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 一条日志一行
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
  return cleaned.length <= MAX_TEXT ? cleaned : `${cleaned.slice(0, MAX_TEXT - 1)}…`
}

const LEVEL_BY_NUMBER: Record<number, string> = { 0: 'debug', 1: 'info', 2: 'warning', 3: 'error' }

/**
 * Electron 新旧两种 `console-message` 形状都认：
 * 新（≥ 35）：`(event)`，`event.level` 是字符串、`event.message` / `lineNumber` / `sourceId` 在事件上；
 * 旧：`(event, level: number, message, line, sourceId)`。
 */
export function readConsoleMessage(
  args: readonly unknown[],
): { level: string; message: string; source?: string } | undefined {
  const [first, level, message, line, sourceId] = args
  const e = first as {
    level?: unknown
    message?: unknown
    lineNumber?: unknown
    sourceId?: unknown
  }
  if (typeof e?.level === 'string' && typeof e.message === 'string') {
    const src = typeof e.sourceId === 'string' && e.sourceId !== '' ? e.sourceId : undefined
    return {
      level: e.level,
      message: e.message,
      ...(src === undefined ? {} : { source: `${src}:${String(e.lineNumber ?? '')}` }),
    }
  }
  if (typeof level === 'number' && typeof message === 'string') {
    const src = typeof sourceId === 'string' && sourceId !== '' ? sourceId : undefined
    return {
      level: LEVEL_BY_NUMBER[level] ?? String(level),
      message,
      ...(src === undefined ? {} : { source: `${src}:${String(line ?? '')}` }),
    }
  }
  return undefined
}

export function attachRendererLogging(
  contents: RendererEvents,
  logger: Logger,
  now: () => number = () => Date.now(),
): void {
  const log = logger.child('renderer')
  let windowStart = 0
  let count = 0
  let dropped = 0
  const allow = (): boolean => {
    const t = now()
    if (t - windowStart >= WINDOW_MS) {
      if (dropped > 0) log.warn('上一分钟渲染进程报错太多，后面的没记', { dropped })
      windowStart = t
      count = 0
      dropped = 0
    }
    if (count >= MAX_PER_WINDOW) {
      dropped += 1
      return false
    }
    count += 1
    return true
  }

  contents.on('console-message', (...args: unknown[]) => {
    const msg = readConsoleMessage(args)
    if (msg === undefined || msg.level !== 'error') return
    if (!allow()) return
    log.error('页面报错', {
      message: scrubRendererText(msg.message),
      ...(msg.source === undefined ? {} : { at: scrubRendererText(msg.source) }),
    })
  })
  contents.on('render-process-gone', (_event: unknown, details: unknown) => {
    const d = details as { reason?: unknown; exitCode?: unknown } | undefined
    log.error('渲染进程没了', { reason: String(d?.reason ?? ''), exitCode: d?.exitCode ?? '' })
  })
  contents.on('did-fail-load', (...args: unknown[]) => {
    const [, code, description, url, isMainFrame] = args
    // -3 = ERR_ABORTED（换页 / 用户取消），不是故障
    if (code === -3 || isMainFrame === false) return
    if (!allow()) return
    log.error('页面没加载出来', {
      code: typeof code === 'number' ? code : String(code),
      description: scrubRendererText(String(description ?? '')),
      url: scrubRendererText(String(url ?? '')),
    })
  })
  contents.on('unresponsive', () => {
    log.warn('页面没有响应')
  })
}
