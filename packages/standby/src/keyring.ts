/**
 * 每个值守租户一把库密钥（21「按租户加密」）。
 *
 * 密钥的去处只有两个：
 * 1. 租户自己数据目录下的一个 0600 文件（`<dataDir>/tenant.key`）；
 * 2. 拉子进程时的环境变量，传一次。
 *
 * **不进编排层的库、不进日志、不进事件、不进导出包。**
 *
 * 为什么落一个文件而不是"只在内存里"：只在内存里的话，云进程重启一次
 * （发版、机器重启、OOM）这个租户的数据就永久读不出来了——那不是"更安全"，
 * 那是把客户的数据烧了。落在租户自己的目录里，删这个租户 = 删这个目录 =
 * 密钥与数据一起没，这正是 21 §4「销毁即全不可读」要的形状。
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceId } from '@agentsws/contracts'
import type { StandbyKeyring } from './types.js'

/** 密钥文件名。放在租户目录里，跟着租户一起生、一起死。 */
export const TENANT_KEY_FILE = 'tenant.key'

/** 32 字节 → base64。`AGENTSWS_DATA_KEY` / `AGENTSWS_SECRETS_KEY` 都吃这个形状。 */
export function newTenantKey(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString('base64')
}

/** 真 fs 档：第一次要就生成一把，之后每次都是同一把。 */
export function createFileKeyring(
  random: (n: number) => Buffer = randomBytes,
): StandbyKeyring & { path(dataDir: string): string } {
  return {
    path: (dataDir: string) => join(dataDir, TENANT_KEY_FILE),
    keyFor(_workspace_id: WorkspaceId, dataDir: string): string {
      const path = join(dataDir, TENANT_KEY_FILE)
      if (existsSync(path)) return readFileSync(path, 'utf8').trim()
      mkdirSync(dataDir, { recursive: true })
      const key = newTenantKey(random)
      writeFileSync(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 })
      // mkdir 之后再 chmod 一次：有些 umask 会把 mode 吃掉
      chmodSync(path, 0o600)
      return key
    },
  }
}

/** 内存档（测试）：不落盘，同一个工作区每次同一把。 */
export function createMemoryKeyring(seed = 'test'): StandbyKeyring {
  const keys = new Map<string, string>()
  let n = 0
  return {
    keyFor(workspace_id: WorkspaceId): string {
      const existing = keys.get(workspace_id)
      if (existing !== undefined) return existing
      n += 1
      const key = Buffer.from(`${seed}:${workspace_id}:${String(n)}`.padEnd(32, '.')).toString(
        'base64',
      )
      keys.set(workspace_id, key)
      return key
    },
  }
}
