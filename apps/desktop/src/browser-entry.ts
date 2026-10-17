/**
 * 决策 942（WP371）：托盘「在浏览器打开」直接进，不落到登录页。
 *
 * 系统浏览器里没有壳装的那张 cookie（也不该有），以前一打开就是「进入这个工作区」。现在壳先向
 * 本机服务要一张给主人的一次性登录 token（15 分钟、用一次就废），拼在地址的 `#` 后面交给浏览器：
 * `#` 后面的东西浏览器不发给服务端，所以不进访问日志；工作台落地后先把它从地址栏抹掉
 * （`history.replaceState`）再拿去换会话。
 *
 * 这是 13 §5「token 不进 URL」的**例外**（Luoye 10-17 同意）。所以收得很紧：
 * - 只在个人档（`remote` 档连的是公司服务器，那边走邀请链接）；
 * - 只对回环地址（127.0.0.1 / ::1 / localhost）；
 * - 要不到（服务是局域网档、旧版服务、连不上）就打开不带 token 的老地址，什么都不坏。
 */

/** 工作台认这个 `#` 键（`apps/workstation/src/lib/api.ts` 里同名）。 */
export const ENTRY_HASH_KEY = 'agentsws-enter'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

export interface BrowserEntryInput {
  /** 服务进程地址，形如 `http://127.0.0.1:4317`。 */
  base: string
  /** 要落到哪一页（`/`、`/?scenes=1`）。 */
  path?: string
  /** 连公司服务器的 `remote` 档：一律不要 token。 */
  remote: boolean
  /** 向本机服务要一次性 token；要不到回 `undefined`。 */
  issue: () => Promise<string | undefined>
}

/** 交给 `shell.openExternal` 的那个地址（带不带一次性 token 见文件头）。 */
export async function browserEntryUrl(input: BrowserEntryInput): Promise<string> {
  const plain = `${input.base.replace(/\/+$/, '')}${input.path ?? '/'}`
  if (input.remote || !isLoopbackUrl(input.base)) return plain
  let token: string | undefined
  try {
    token = await input.issue()
  } catch {
    token = undefined
  }
  if (token === undefined || token === '') return plain
  return `${plain}#${ENTRY_HASH_KEY}=${encodeURIComponent(token)}`
}
