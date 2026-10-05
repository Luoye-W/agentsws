/**
 * WP225：Windows 上起命令行工具的两处坑（WP218 报告「没修」那两条）。
 *
 * 1. **npm 装的命令是 `.cmd` 批处理壳**（`shopify.cmd`、`npx.cmd`、`pnpm.cmd`）。Node 的 `execFile` /
 *    `spawn` 不经 shell 起不了它：写 `shopify` 是 ENOENT（只认 `.exe`），写 `shopify.cmd` 是 EINVAL
 *    （Node 为 CVE-2024-27980 起直接拒）。于是装了 Shopify CLI 也报「没装」。这里自己按 PATH + PATHEXT
 *    找到它：是 `.exe` / `.com` 就直接起；是 `.cmd` / `.bat` 就交给 `cmd.exe /d /s /c "…"`，
 *    每个参数加双引号，**含 `"` 或 `%` 的参数直接拒**（这两个在双引号里也会被 cmd 解释，转义不可靠）。
 *    找不到就原样起——照旧得到 ENOENT，调用方「没装」那条路不变。
 * 2. **控制台程序的输出不是 UTF-8**。`reg.exe` 这类往管道写的是系统 OEM 代码页（简体中文系统是 936 / GBK），
 *    按 UTF-8 读，中文安装路径成了乱码。这里先按 UTF-8 严格解，不合法再按 OEM 代码页解。
 */
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

/** Windows 的环境变量名不分大小写（`Path` / `PATH`）。 */
export function envValue(env: Env, name: string): string | undefined {
  const direct = env[name]
  if (direct !== undefined) return direct
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === lower) return v
  return undefined
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** 按 PATH + PATHEXT 找命令（就是 `where.exe` 的找法）；带了目录的只看那一处。找不到回 undefined。 */
export function findWindowsCommand(
  bin: string,
  env: Env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const exts = (envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e !== '')
  const hasExt = /\.[^\\/.]+$/.test(bin)
  const candidates = (base: string): string[] =>
    hasExt ? [base] : exts.map((ext) => `${base}${ext.toLowerCase()}`)
  if (/[\\/]/.test(bin)) return candidates(bin).find((p) => exists(p))
  for (const raw of (envValue(env, 'PATH') ?? '').split(';')) {
    const dir = raw.trim().replace(/^"|"$/g, '')
    if (dir === '') continue
    const hit = candidates(win32.join(dir, bin)).find((p) => exists(p))
    if (hit !== undefined) return hit
  }
  return undefined
}

export class CliArgumentError extends Error {
  constructor(readonly argument: string) {
    super(`参数里有 Windows 命令行转不准的字符（" 或 %）：${argument}`)
    this.name = 'CliArgumentError'
  }
}

/** 给 `cmd.exe` 的一个参数：加双引号；尾巴上的反斜杠翻倍（不然 `\"` 会被下一个程序当成转义的引号）。 */
function cmdQuote(arg: string): string {
  if (/["%\r\n\0]/.test(arg)) throw new CliArgumentError(arg)
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`
}

export interface CliSpawnSpec {
  command: string
  args: string[]
  /** 交给 `cmd.exe` 时要原样传（不让 Node 再给整串加一层引号）。 */
  windowsVerbatimArguments?: true
}

/**
 * 起一个命令行工具该用的 `command` / `args`。非 Windows 原样；Windows 见文件头第 1 条。
 * `env` 是**子进程**的环境（PATH 按它找）。参数转不准时抛 {@link CliArgumentError}。
 */
export function cliSpawnSpec(
  bin: string,
  args: readonly string[],
  options: {
    platform?: string
    env?: Env
    exists?: (path: string) => boolean
  } = {},
): CliSpawnSpec {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { command: bin, args: [...args] }
  const env = options.env ?? process.env
  const found = findWindowsCommand(bin, env, options.exists)
  if (found === undefined) return { command: bin, args: [...args] }
  if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args: [...args] }
  const line = [found, ...args].map(cmdQuote).join(' ')
  const root = envValue(env, 'SystemRoot') ?? 'C:\\Windows'
  return {
    command: envValue(env, 'ComSpec') ?? win32.join(root, 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  }
}

// ── 控制台输出的编码 ─────────────────────────────────────────────────────

/** Windows 代码页 → WHATWG TextDecoder 的名字（认不出回 undefined）。 */
export function decoderLabel(codePage: number): string | undefined {
  const known: Record<number, string> = {
    936: 'gbk',
    54936: 'gb18030',
    950: 'big5',
    932: 'shift_jis',
    949: 'euc-kr',
    866: 'ibm866',
    65001: 'utf-8',
  }
  if (known[codePage] !== undefined) return known[codePage]
  if (codePage >= 1250 && codePage <= 1258) return `windows-${codePage}`
  return undefined
}

/** `reg query HKLM\…\Nls\CodePage /v OEMCP` 的输出 → 代码页号。 */
export function oemCodePageOf(regOutput: string): number | undefined {
  const m = /OEMCP\s+REG_SZ\s+(\d+)/i.exec(regOutput)
  return m?.[1] === undefined ? undefined : Number(m[1])
}

/** 控制台程序的输出：先按 UTF-8 严格解，不合法再按 OEM 代码页解，再不行按 latin1（至少不抛）。 */
export function decodeConsoleText(bytes: Uint8Array, codePage: number | undefined): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // 不是 UTF-8：往下按代码页
  }
  const label = codePage === undefined ? undefined : decoderLabel(codePage)
  if (label !== undefined) {
    try {
      return new TextDecoder(label).decode(bytes)
    } catch {
      // 这份 Node 没带这个编码（不是 full-icu）：往下
    }
  }
  return new TextDecoder('latin1').decode(bytes)
}
