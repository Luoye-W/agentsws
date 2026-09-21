/**
 * Docker 档的入口：环境变量 → `startNodeRelayHost`。
 *
 * 环境变量（都在 docker-compose.yml 里给了默认值，没有密钥）：
 * - `WORKSPACE`：工作区号（单租户部署）；
 * - `PORT`：监听端口；
 * - `DATA_DIR`：数据目录（挂卷；配对哈希 / 计数 / 留言密文 / 挂件外观）。
 *
 * 首启的配对密钥与留言密钥打到 stdout **一次**（`docker compose logs` 里看），
 * 之后卷里只有哈希。
 */
import { startNodeRelayHost } from './node-host.js'

const workspace = process.env.WORKSPACE?.trim() ?? ''
if (workspace === '') {
  process.stderr.write('WORKSPACE 没配：在 docker-compose.yml 里给它一个工作区号。\n')
  process.exit(1)
}

const dataDir = process.env.DATA_DIR
const host = startNodeRelayHost({
  workspace,
  port: Number(process.env.PORT ?? '8787'),
  ...(dataDir === undefined || dataDir === '' ? {} : { dataDir }),
})

process.stdout.write(`[relay] listening on :${host.port() ?? '?'} workspace=${workspace}\n`)

const shutdown = (): void => {
  void host.close().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
