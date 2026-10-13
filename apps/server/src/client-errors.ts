/**
 * WP298：前端报错落服务日志的那一行。
 *
 * 网关（`@agentsws/api` 的 `POST /v1/client-errors`）已经洗过、截过长、限过流；这里只把它
 * 排成一行写到 stderr——桌面壳把服务进程的 stderr 收进 `logs/server.log`，
 * 下一个装到 Windows 的版本一打开出错的页就能在那里看到真错误。
 */
import type { ClientErrorEntry, ClientErrorPort } from '@agentsws/api'

export function formatClientErrorLine(entry: ClientErrorEntry): string {
  const fields: [string, string | undefined][] = [
    ['kind', entry.kind],
    ['route', entry.route],
    ['scope', entry.scope],
    ['app', entry.app_version],
    ['ua', entry.user_agent],
    ['stack', entry.stack],
  ]
  const tail = fields
    .filter((f): f is [string, string] => f[1] !== undefined && f[1] !== '')
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')
  return `[client-error] ${entry.name}: ${entry.message} ${tail}`
}

export function stderrClientErrors(
  write: (line: string) => void = (line) => {
    process.stderr.write(line)
  },
): ClientErrorPort {
  return {
    record: (entry) => {
      write(`${formatClientErrorLine(entry)}\n`)
    },
  }
}
