/**
 * 托管工作台的构建产物（36 §5.1「Hono 托管 dist/」）。
 *
 * 规矩：`/v1` 与 `/openapi.json` 归网关，这里一律不碰；其余走静态文件，
 * 找不到且看着像页面路径（没有后缀）就回 `index.html`（SPA fallback）。
 * 只读 `dir` 下的文件，路径穿越（`..`）一律拒。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { Env, Hono } from 'hono'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

export interface StaticOptions {
  /** 工作台的 `dist` 目录 */
  dir: string
  /** `/app/bootstrap.json`：demo 用它自动登录（不要求用户填任何东西） */
  bootstrap?: Record<string, unknown>
}

/** `dir` 之下的真实文件路径；越界或不存在返回 undefined。 */
export function resolveAsset(dir: string, pathname: string): string | undefined {
  const root = resolve(dir)
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, '')
  const target = resolve(join(root, clean))
  if (target !== root && !target.startsWith(root + sep)) return undefined
  if (!existsSync(target)) return undefined
  const stat = statSync(target)
  if (stat.isDirectory()) return resolveAsset(dir, join(clean, 'index.html'))
  return target
}

/**
 * 把静态托管挂到网关的 Hono 应用上。
 *
 * 必须在网关建好之后调用：Hono 按注册顺序匹配，`*` 放最后才不会盖住 `/v1`。
 */
export function mountStatic<E extends Env>(app: Hono<E>, options: StaticOptions): void {
  const bootstrap = options.bootstrap ?? {}

  app.get('/app/bootstrap.json', (c) => c.json(bootstrap))

  app.get('*', async (c, next) => {
    const path = c.req.path
    // 网关的地盘：让它自己出 404 信封
    if (path.startsWith('/v1') || path === '/openapi.json') return next()
    if (c.req.method !== 'GET') return next()

    const file = resolveAsset(options.dir, path)
    if (file !== undefined) {
      const type = TYPES[extname(file)] ?? 'application/octet-stream'
      return c.body(new Uint8Array(readFileSync(file)), 200, { 'content-type': type })
    }
    // SPA fallback：没有后缀的路径都交给前端路由
    if (extname(path) === '') {
      const index = resolveAsset(options.dir, 'index.html')
      if (index !== undefined) {
        return c.html(readFileSync(index, 'utf8'))
      }
    }
    return next()
  })
}
