/**
 * 后台在 **Compose / 自建形态**下的那一半：静态产物与装配（65 §8）。
 *
 * 两页网页与它们的路由在 `pages.ts`（那个文件没有一样 Node 专有的东西，
 * 两个形态共用）；这里只剩下 Node 才做得到的事：**从磁盘上读 `dist`**。
 *
 * Workers 形态没有这个文件——`/admin/*` 的静态资产由 wrangler 的 `[assets]`
 * 直接服务（`apps/cloud-worker/wrangler.toml`），无会话时由 Worker 在进门那一跳
 * 判成 404（`worker.ts` 的 `isAdminAssetPath`）。
 *
 * 静态目录是**可配置**的（`AGENTSWS_CLOUD_ADMIN_DIST`），默认由部署方给绝对路径——
 * 这个文件不假设仓库结构，也不 `import.meta.url` 往上爬。
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { ADMIN_SESSION_COOKIE, type Clock } from '@agentsws/contracts'
import type { CloudServer } from './../server.js'
import { parseCookies } from './guard.js'
import { mountAdminWebRoutes } from './pages.js'
import { AdminStore } from './store.js'

/** 静态产物目录的环境变量名。 */
export const ADMIN_DIST_ENV = 'AGENTSWS_CLOUD_ADMIN_DIST'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

export interface MountAdminPagesOptions {
  admin: () => AdminStore
  clock: Clock
  baseUrl: string
  /** 静态产物目录；不给按 `AGENTSWS_CLOUD_ADMIN_DIST` 取，再不给就不挂静态。 */
  distDir?: string | undefined
  env?: Record<string, string | undefined>
}

export interface MountedAdminPages {
  /** 静态产物在哪（没挂就是 `undefined`）。 */
  distDir?: string
}

/**
 * 建一个 `AdminStore`（借用账号库那张同步 SQL 口）。
 *
 * 之所以是一个函数而不是在 `createCloudServer` 里建：后台是可选的，
 * 一台只跑服务入口的机器不该因为"后台没配"而多出一层对象。
 */
export function createAdminStore(
  server: CloudServer,
  clock: Clock,
  randomBytes: (n: number) => Buffer = nodeRandomBytes,
): AdminStore {
  return new AdminStore({ db: server.store.db, clock, randomBytes })
}

export function mountAdminPages(
  server: CloudServer,
  options: MountAdminPagesOptions,
): MountedAdminPages {
  const env = options.env ?? process.env
  const dist = options.distDir ?? env[ADMIN_DIST_ENV]

  // 两页网页：与 Workers 形态**同一份**
  mountAdminWebRoutes({
    app: server.app,
    store: server.store,
    admin: options.admin,
    baseUrl: options.baseUrl,
    fetch: (request) => server.fetch(request),
  })

  if (dist === undefined || dist.trim() === '') {
    // 没有构建产物也要能跑（服务端测试、只跑 API 的节点）——那时 `/admin/` 回 404
    return {}
  }
  const root = resolve(dist)
  const app = server.app

  const staffOnly = (c: { req: { header: (n: string) => string | undefined } }): boolean => {
    const token = parseCookies(c.req.header('Cookie')).get(ADMIN_SESSION_COOKIE)
    if (token === undefined || token === '') return false
    return options.admin().session(token) !== undefined
  }

  const serve = (relative: string): Response | undefined => {
    /*
     * 路径穿越：`normalize` 之后必须还在 `root` 里面。`..%2f..%2fetc%2fpasswd`
     * 这类东西在 Hono 里已经被解码成真的 `../..`，所以判必须在解码**之后**做。
     */
    const target = resolve(join(root, normalize(`/${relative}`)))
    if (target !== root && !target.startsWith(`${root}/`)) return undefined
    try {
      if (!statSync(target).isFile()) return undefined
    } catch {
      return undefined
    }
    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
    // 带哈希的产物可以长缓存；index.html 永远 no-store（不然发版之后旧壳还在）
    const immutable = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\./.test(target)
    return new Response(readFileSync(target), {
      status: 200,
      headers: {
        'content-type': type,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
        'x-frame-options': 'DENY',
        'referrer-policy': 'same-origin',
      },
    })
  }

  const spa = (c: {
    req: { header: (n: string) => string | undefined; path: string }
  }): Response => {
    // 无会话：连 index.html 都不给。扫描的人看到的与"这台机器没有后台"一样
    if (!staffOnly(c)) return new Response('Not Found', { status: 404 })
    const rest = c.req.path.replace(/^\/admin\/?/, '')
    const file = rest === '' ? undefined : serve(rest)
    return file ?? serve('index.html') ?? new Response('Not Found', { status: 404 })
  }

  app.get('/admin', spa)
  app.get('/admin/', spa)
  app.get('/admin/*', spa)
  return { distDir: root }
}
