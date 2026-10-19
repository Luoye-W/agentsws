/**
 * WP422：安装程序用的入口（`build/installer.nsh` 切完 `current` 之后，用新版自带的 Node 跑）：
 *
 * ```
 * "<新版>\resources\node\node.exe" "<新版>\resources\app\dist\firewall-cli.js" --root "<安装目录>" --dir "<新版>" [--node "<安装目录>\node\node.exe"]
 * ```
 *
 * WP427：`--node` 是服务进程真正跑的那份（不随版本变）；给了就把允许落在它身上。
 *
 * 做的事见 `firewall.ts`。只印一行结果给安装日志，**永远以 0 退出**——防火墙没弄成不挡安装。
 * 本进程只读写防火墙规则，不监听任何端口（不会自己触发「要联网」）。
 */
import { existsSync } from 'node:fs'
import { carryFirewall, describeOutcome, nodePowerShell } from './firewall.js'

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  const value = at >= 0 ? process.argv[at + 1] : undefined
  return value === undefined || value === '' ? undefined : value
}

async function main(): Promise<void> {
  const root = arg('--root')
  const dir = arg('--dir')
  if (process.platform !== 'win32' || root === undefined || dir === undefined) {
    process.stdout.write('agentsws firewall: skipped (not Windows or missing --root / --dir)\n')
    return
  }
  const node = arg('--node')
  const outcome = await carryFirewall({
    root,
    dir,
    ...(node !== undefined && existsSync(node) ? { target: node } : {}),
    exists: existsSync,
    run: nodePowerShell(),
  })
  process.stdout.write(`agentsws firewall: ${outcome.kind} — ${describeOutcome(outcome)}\n`)
}

main()
  .catch((err: unknown) => {
    process.stdout.write(`agentsws firewall: error — ${String(err)}\n`)
  })
  .finally(() => {
    process.exitCode = 0
  })
