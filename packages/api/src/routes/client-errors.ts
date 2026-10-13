/**
 * WP298：前端报错进服务日志（`POST /v1/client-errors`）。
 *
 * 桌面壳里页面出错时人只看到一片空白，日志里什么也没有。工作台的错误边界、
 * `window.onerror`、没人接的 Promise 拒绝都发到这里，宿主写进服务日志（桌面壳里是 server.log）。
 *
 * - **不要求登录**：登录页、会话还没取到时的错误也要记得下来；
 * - **自己一只限流桶**（整个服务共用，突发 20 条、之后 5 秒 1 条），不吃各人正常请求的配额；
 *   死循环刷不爆日志；
 * - **请求体最多 16 KiB**，每段再截一次长度、去控制字符（一条一行）、去网址查询串、
 *   换掉邮箱 / 长数字 / 长令牌——前端洗过一遍，这里不信它，再洗一遍；
 * - 没装配日志口（嵌入式 / 云端）照收照答，只是不落。
 */
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { ok } from '../helpers.js'
import { TokenBucketLimiter } from '../rate-limit.js'
import { type Route, route } from '../route-spec.js'
import type { ClientErrorEntry } from '../types.js'

export const CLIENT_ERROR_MAX_BODY = 16 * 1024
export const CLIENT_ERROR_RATE = { burst: 20, per_second: 0.2 }

const KINDS = ['boundary', 'panel', 'error', 'rejection', 'preload'] as const

const LIMITS = {
  name: 80,
  message: 300,
  stack: 1500,
  stackLines: 8,
  route: 200,
  short: 80,
  ua: 200,
}

const ClientErrorBody = z.object({
  kind: z.string(),
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  route: z.string(),
  scope: z.string().optional(),
  app_version: z.string().optional(),
})

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

/** 去网址查询串与片段（行列号留着）、换掉个人数据、去控制字符。 */
export function scrubClientText(text: string): string {
  return (
    text
      .replace(/\b(?:https?|wss?|file):\/\/[^\s)'"]+/g, (raw) => {
        const pos = /(?::\d+){1,2}$/.exec(raw)?.[0] ?? ''
        return `${raw.slice(0, raw.length - pos.length).replace(/[?#].*$/, '')}${pos}`
      })
      .replace(/([/\w.-])\?[^\s)'":]*((?::\d+){0,2})/g, '$1$2')
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
      .replace(/\b\d{6,}\b/g, '<num>')
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 一条日志一行
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
  )
}

const line = (text: string, max: number): string =>
  cut(scrubClientText(text.split(/\r?\n/, 1)[0] ?? ''), max)

/** 原样收到的 → 能落日志的那一条。 */
export function sanitizeClientError(
  input: z.infer<typeof ClientErrorBody>,
  userAgent?: string,
): ClientErrorEntry {
  const kind = (KINDS as readonly string[]).includes(input.kind)
    ? (input.kind as ClientErrorEntry['kind'])
    : 'other'
  const stack =
    input.stack === undefined
      ? ''
      : cut(
          input.stack
            .split(/\r?\n/)
            .slice(0, LIMITS.stackLines)
            .map((l) => scrubClientText(l))
            .filter((l) => l !== '')
            .join(' | '),
          LIMITS.stack,
        )
  const ua = userAgent === undefined ? '' : line(userAgent, LIMITS.ua)
  return {
    kind,
    name: line(input.name, LIMITS.name),
    message: line(input.message, LIMITS.message),
    ...(stack === '' ? {} : { stack }),
    route: line(input.route.replace(/[?#].*$/, ''), LIMITS.route),
    ...(input.scope === undefined ? {} : { scope: line(input.scope, LIMITS.short) }),
    ...(input.app_version === undefined
      ? {}
      : { app_version: line(input.app_version, LIMITS.short) }),
    ...(ua === '' ? {} : { user_agent: ua }),
  }
}

export function clientErrorRoutes(): Route[] {
  // 每个网关一只桶（`collectRoutes()` 每建一次网关调一次）
  const limiter = new TokenBucketLimiter({ client_errors: CLIENT_ERROR_RATE })
  return [
    route(
      {
        method: 'post',
        path: '/v1/client-errors',
        operationId: 'reportClientError',
        summary: '前端报错记进服务日志（WP298；限流、截长、去个人数据）',
        tag: 'kernel',
        auth: 'public',
        body: ClientErrorBody,
        returns: '{ logged }',
      },
      async (c, deps) => {
        const declared = Number(c.req.header('content-length') ?? '0')
        if (Number.isFinite(declared) && declared > CLIENT_ERROR_MAX_BODY)
          throw new ApiError('invalid_input', '报错内容太长')
        const wall = deps.options?.wallClockMs ?? ((): number => Date.now())
        const verdict = limiter.take('local', 'client_errors', wall())
        if (!verdict.allowed)
          throw new ApiError('rate_limited', '前端报错太频繁，先不记了', {
            headers: { 'Retry-After': String(verdict.retry_after) },
          })
        const text = await c.req.text()
        if (text.length > CLIENT_ERROR_MAX_BODY) throw new ApiError('invalid_input', '报错内容太长')
        let raw: unknown
        try {
          raw = JSON.parse(text)
        } catch {
          throw new ApiError('invalid_input', '请求体不是合法 JSON')
        }
        const parsed = ClientErrorBody.safeParse(raw)
        if (!parsed.success) throw new ApiError('invalid_input', '请求体校验失败')
        const entry = sanitizeClientError(parsed.data, c.req.header('user-agent'))
        if (deps.clientErrors === undefined) return ok(c, { logged: false })
        try {
          deps.clientErrors.record(entry)
        } catch {
          return ok(c, { logged: false })
        }
        return ok(c, { logged: true })
      },
    ),
  ]
}
