/**
 * WP427：在一台电脑上起团队通道的云端替身（开发期手动走一遍「不在同一个网络」那条路用）。
 *
 * ```
 * node apps/server/dist/team-relay-cli.js --port 4593
 * ```
 *
 * 然后两个服务进程都带上 `AGENTSWS_TEAM_CLOUD_URL=http://127.0.0.1:4593` 与
 * `AGENTSWS_TEAM_DEV_TOKEN=<随便一串>`（替身认任何令牌；两台「电脑」的串要不一样）。
 * 只听本机回环口，不碰网卡。
 */
import { startTeamRelayStandIn } from './team-relay.js'

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  const value = at >= 0 ? process.argv[at + 1] : undefined
  return value === undefined || value === '' ? undefined : value
}

const port = Number(arg('--port') ?? '4593')
const relay = await startTeamRelayStandIn({ port })
process.stdout.write(
  `团队通道替身起来了：${relay.base}（同事打开的是 http://<通道 id>.localhost:${relay.port}/）\n`,
)
const stop = (): void => {
  void relay.close().then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
