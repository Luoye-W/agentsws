/**
 * WP298：前端报错记进本机日志。
 *
 * 真机上（Windows 桌面壳）页面出错时人只看到一片空白，日志里什么也没有。现在：
 * 错误边界接住的、`window.onerror`、没人接的 Promise 拒绝，都整理成一小条发给
 * 本机服务的 `POST /v1/client-errors`，由服务写进它自己的日志（桌面壳里就是 server.log）。
 *
 * 只发**错误名 + 第一行 + 栈的前几行 + 当时的路径**，并且出门前先洗一遍：
 * - 去掉网址里的查询串与 `#…`（`?service=`、`?token=` 这类都不出门）、去掉本机源（`http://127.0.0.1:4317`）；
 * - 像邮箱、长串数字、长串令牌的字样换成占位；
 * - 每段截长度；同一条一分钟内只发一次，一次打开最多发 20 条（死循环也刷不爆日志）。
 *
 * 发不出去就算了（`fetch` 失败吞掉）——记日志这件事本身绝不能再抛错。
 */

import { track } from './telemetry/client'

export type ClientErrorKind = 'boundary' | 'panel' | 'error' | 'rejection' | 'preload'

export interface ClientErrorReport {
  kind: ClientErrorKind
  name: string
  message: string
  stack?: string
  /** 当时的路径（只有 pathname，没有查询串）。 */
  route: string
  /** 哪一层边界接住的（`page` / `shell` / `panel:<id>`）。 */
  scope?: string
  /** 桌面壳版本（有桥才有）。 */
  app_version?: string
}

export const CLIENT_ERRORS_PATH = '/v1/client-errors'

const LIMITS = { name: 80, message: 300, stack: 1500, stackLines: 8, route: 200, scope: 60 }
const DEDUP_MS = 60_000
const MAX_PER_PAGE = 20

/** 去查询串 / 片段、去本机源（`http://127.0.0.1:4317/assets/x.js?v=1` → `/assets/x.js`）。 */
export function stripUrls(text: string): string {
  return text
    .replace(/\b(?:https?|wss?|file):\/\/[^\s)'"]+/g, (raw) => {
      // 栈里的 `…/x.js?v=1:12:5`：行列号留着，查询串去掉
      const pos = /(?::\d+){1,2}$/.exec(raw)?.[0] ?? ''
      const url = raw.slice(0, raw.length - pos.length)
      const bare = url.replace(/[?#].*$/, '')
      try {
        const u = new URL(bare)
        const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
        return `${local ? u.pathname : `${u.protocol}//${u.host}${u.pathname}`}${pos}`
      } catch {
        return `${bare}${pos}`
      }
    })
    .replace(/([/\w.-])\?[^\s)'":]*((?::\d+){0,2})/g, '$1$2')
}

/** 可能是个人数据的字样换成占位（邮箱、长串数字、长令牌）。 */
export function scrubPersonal(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/\b\d{6,}\b/g, '<num>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>')
}

const clean = (text: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 换掉控制字符，日志一条一行
  scrubPersonal(stripUrls(text)).replace(/[\u0000-\u001f\u007f]+/g, ' ')

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0] ?? ''

/** 任意抛出物 → 错误名 + 第一行 + 栈（都还没洗）。 */
export function describeThrown(thrown: unknown): { name: string; message: string; stack?: string } {
  if (thrown instanceof Error) {
    return {
      name: thrown.name || 'Error',
      message: thrown.message,
      ...(typeof thrown.stack === 'string' ? { stack: thrown.stack } : {}),
    }
  }
  if (typeof thrown === 'string') return { name: 'string', message: thrown }
  return { name: typeof thrown, message: thrown === null ? 'null' : String(thrown) }
}

/** 出门前的那一遍：截长、去网址查询串、去个人数据。 */
export function sanitizeReport(input: ClientErrorReport): ClientErrorReport {
  const stack =
    input.stack === undefined
      ? undefined
      : cut(
          input.stack
            .split(/\r?\n/)
            .slice(0, LIMITS.stackLines)
            .map((l) => clean(l).trim())
            .filter((l) => l !== '')
            .join('\n'),
          LIMITS.stack,
        )
  return {
    kind: input.kind,
    name: cut(clean(input.name), LIMITS.name),
    message: cut(clean(firstLine(input.message)), LIMITS.message),
    ...(stack === undefined || stack === '' ? {} : { stack }),
    route: cut(clean(input.route.replace(/[?#].*$/, '')), LIMITS.route),
    ...(input.scope === undefined ? {} : { scope: cut(clean(input.scope), LIMITS.scope) }),
    ...(input.app_version === undefined
      ? {}
      : { app_version: cut(clean(input.app_version), LIMITS.name) }),
  }
}

/** 错误边界上那一行「技术信息」：错误名 + 第一行（洗过、不含用户数据）。 */
export function technicalLine(thrown: unknown): string {
  const d = describeThrown(thrown)
  const name = cut(clean(d.name), LIMITS.name)
  const message = cut(clean(firstLine(d.message)), LIMITS.message)
  return message === '' ? name : `${name}: ${message}`
}

type Sender = (body: string) => void

const defaultSender: Sender = (body) => {
  try {
    void fetch(CLIENT_ERRORS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => undefined)
  } catch {
    // 记日志本身不能再抛
  }
}

let sender: Sender = defaultSender
const seen = new Map<string, number>()
let sent = 0

/** 测试用：换掉发送口并清掉去重 / 计数。 */
export function _setClientErrorSender(next?: Sender): void {
  sender = next ?? defaultSender
  seen.clear()
  sent = 0
}

function currentRoute(): string {
  try {
    return globalThis.location?.pathname ?? ''
  } catch {
    return ''
  }
}

function desktopVersion(): string | undefined {
  const w = globalThis as { agentsws?: { version?: unknown } }
  return typeof w.agentsws?.version === 'string' ? w.agentsws.version : undefined
}

/** 报一条。去重、限量、洗干净之后发出去；返回发没发（测试看）。 */
export function reportClientError(
  kind: ClientErrorKind,
  thrown: unknown,
  extra: { scope?: string; stack?: string; now?: number } = {},
): boolean {
  try {
    const d = describeThrown(thrown)
    const version = desktopVersion()
    const report = sanitizeReport({
      kind,
      name: d.name,
      message: d.message,
      ...(extra.stack !== undefined
        ? { stack: extra.stack }
        : d.stack === undefined
          ? {}
          : { stack: d.stack }),
      route: currentRoute(),
      ...(extra.scope === undefined ? {} : { scope: extra.scope }),
      ...(version === undefined ? {} : { app_version: version }),
    })
    const key = `${report.kind}|${report.name}|${report.message}|${report.route}`
    const now = extra.now ?? Date.now()
    const last = seen.get(key)
    if (last !== undefined && now - last < DEDUP_MS) return false
    if (sent >= MAX_PER_PAGE) return false
    seen.set(key, now)
    sent += 1
    sender(JSON.stringify(report))
    // WP476：匿名使用数据里也记一条——只有错误类名、哪一层接住的（报错文字不出门；没配置是空操作）
    track('client_error', {
      error_kind: report.kind,
      error_name: report.name,
      ...(report.scope === undefined ? {} : { scope: report.scope }),
    })
    return true
  } catch {
    return false
  }
}

/** 全局的两条：`error` 与 `unhandledrejection`。返回拆掉的函数。 */
export function installGlobalErrorReporting(target: Window = window): () => void {
  const onError = (event: ErrorEvent): void => {
    // 跨源脚本只给一句 "Script error."，没有信息也照记一条（至少知道出过事）
    reportClientError('error', event.error ?? event.message)
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    reportClientError('rejection', event.reason)
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
