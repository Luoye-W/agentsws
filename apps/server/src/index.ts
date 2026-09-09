/**
 * `@agentsws/server` —— 协同服务进程。
 *
 * `createServer()` 装配内核与全部已合并模块并返回一个可 listen 的句柄；
 * 直接 `node dist/index.js` 时启动并监听，SIGTERM / SIGINT 优雅关闭。
 */
export { type BackendCall, MemoryBackend } from './backend.js'
export {
  type Bootstrap,
  BUNDLED_ROLES,
  createServer,
  DEFAULT_PORT,
  HOST,
  type MountedWorld,
  type Server,
  type ServerOptions,
} from './server.js'
export { mountStatic, resolveAsset, type StaticOptions } from './static.js'
export {
  createWorkstationPort,
  emptyDataSource,
  type WorkstationDataSource,
  type WorkstationPortOptions,
} from './workstation.js'

import { pathToFileURL } from 'node:url'
import { createServer } from './server.js'

/** 进程入口：启动、打印 /v1/health、挂优雅关闭。 */
export async function main(): Promise<void> {
  const dbDir = process.env.AGENTSWS_DB_DIR
  const server = await createServer(dbDir === undefined ? {} : { dbDir })
  await server.listen()
  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    process.stdout.write(`\n${signal} received, closing…\n`)
    server
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`shutdown failed: ${String(err)}\n`)
        process.exit(1)
      })
  }
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })
}

// 只有被当作进程入口执行时才监听；被 import（测试、CLI 内嵌）时什么都不做。
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
