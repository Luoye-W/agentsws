/**
 * WP319 ②（Luoye 10-14 Windows 真机）：点「重启并更新」后窗口消失、要等好几分钟新版才起来，
 * 这期间点桌面图标还提示「应用不存在」，像被删了。
 *
 * 慢在安装程序那一段（CI 实测：N 退出 → N+1 起来 3 分 35 秒，下载只用了 2 秒）：NSIS 静默装时先把旧目录里的
 * 文件**一个一个**挪走再删（`atomicRMDir`），再把新版的上万个小文件一个个解出来（杀毒逐个扫），全程没有窗口。
 * 文件数在 `after-pack.mjs` 里减；这里管**看得见**：
 *
 * 1. 装之前在用户数据目录写一张「正在更新」单（`update-pending.json`：从哪版到哪版、几点开始）；
 * 2. 起一个**不在安装目录里**的小窗（系统自带的 PowerShell + WinForms，脚本放临时目录）：
 *    「正在更新到 x.y.z」+ 走动的进度条 + 「装好会自动打开」，置顶、任务栏里也有；
 * 3. 新版一启动就把那张单收掉（记一行「更新用时 N 秒」进日志），小窗看到单没了就自己关；
 *    装不上 / 新版起不来，小窗最多挂 15 分钟自己关。
 *
 * 小窗不碰安装目录（安装程序会结束安装目录里的所有进程）；PowerShell 的 `-ExecutionPolicy Bypass`
 * 只对这一个进程生效，不改系统设置。
 */
import type { Logger } from './logging.js'
import type { FileStore } from './ports.js'

export const UPDATE_PENDING_FILE = 'update-pending.json'
/** WP325：小窗的心跳（它自己写；CI 与新版启动时读它，知道小窗起没起来、画没画出来）。 */
export const UPDATE_SPLASH_FILE = 'update-splash.json'
/** 小窗最多挂多久（秒）：装不上 / 新版起不来时别一直挂着。 */
export const SPLASH_TIMEOUT_SECONDS = 15 * 60

export interface UpdatePending {
  from: string
  to: string
  started_at: string
}

export interface SplashText {
  title: string
  line: string
  hint: string
}

export function splashText(language: string | undefined, version: string): SplashText {
  if (language?.startsWith('en') === true)
    return {
      title: 'Agents Workshop',
      line: `Updating to ${version}`,
      hint: 'It will reopen by itself',
    }
  return { title: 'Agents 工坊', line: `正在更新到 ${version}`, hint: '装好会自动打开' }
}

/** PowerShell 单引号字符串：里面的单引号写两遍。 */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * 小窗的脚本（PowerShell 5.1 自带的 WinForms）。存盘时要带 UTF-8 BOM，否则 5.1 按本地码页读、中文乱码。
 * `pendingFile` 没了（新版起来收掉了）或超时就关。
 */
export function splashScript(input: {
  pendingFile: string
  /** WP325：心跳文件（小窗自己写：起来了 / 窗口画出来了 / 没有桌面只在后台等 / 关了）。 */
  heartbeatFile: string
  text: SplashText
  timeoutSeconds?: number
}): string {
  const timeout = input.timeoutSeconds ?? SPLASH_TIMEOUT_SECONDS
  return [
    // WP325：出错要进 catch（以前 SilentlyContinue 把 ShowDialog 的异常吞了，进程悄悄就退了）
    "$ErrorActionPreference = 'Stop'",
    `$pending = ${psQuote(input.pendingFile)}`,
    `$beat = ${psQuote(input.heartbeatFile)}`,
    `$timeout = ${String(Math.max(10, Math.round(timeout)))}`,
    '$start = Get-Date',
    'function Beat([string]$state, [string]$err) {',
    '  try {',
    "    $o = @{ pid = $PID; state = $state; error = $err; interactive = [Environment]::UserInteractive; session = (Get-Process -Id $PID).SessionId; at = (Get-Date).ToUniversalTime().ToString('o') }",
    '    [System.IO.File]::WriteAllText($beat, ($o | ConvertTo-Json -Compress))',
    '  } catch {}',
    '}',
    'function Done() {',
    '  return (-not (Test-Path -LiteralPath $pending)) -or (((Get-Date) - $start).TotalSeconds -gt $timeout)',
    '}',
    "Beat 'starting' ''",
    'try {',
    '  Add-Type -AssemblyName System.Windows.Forms',
    '  Add-Type -AssemblyName System.Drawing',
    '  [System.Windows.Forms.Application]::EnableVisualStyles()',
    '  $form = New-Object System.Windows.Forms.Form',
    `  $form.Text = ${psQuote(input.text.title)}`,
    "  $form.FormBorderStyle = 'FixedDialog'",
    '  $form.ControlBox = $false',
    "  $form.StartPosition = 'CenterScreen'",
    '  $form.TopMost = $true',
    '  $form.ShowInTaskbar = $true',
    '  $form.ClientSize = New-Object System.Drawing.Size(360, 112)',
    '  $line = New-Object System.Windows.Forms.Label',
    `  $line.Text = ${psQuote(input.text.line)}`,
    "  $line.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)",
    '  $line.Location = New-Object System.Drawing.Point(20, 16)',
    '  $line.Size = New-Object System.Drawing.Size(320, 26)',
    '  $bar = New-Object System.Windows.Forms.ProgressBar',
    "  $bar.Style = 'Marquee'",
    '  $bar.MarqueeAnimationSpeed = 30',
    '  $bar.Location = New-Object System.Drawing.Point(20, 50)',
    '  $bar.Size = New-Object System.Drawing.Size(320, 12)',
    '  $hint = New-Object System.Windows.Forms.Label',
    `  $hint.Text = ${psQuote(input.text.hint)}`,
    "  $hint.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)",
    '  $hint.ForeColor = [System.Drawing.Color]::Gray',
    '  $hint.Location = New-Object System.Drawing.Point(20, 74)',
    '  $hint.Size = New-Object System.Drawing.Size(320, 22)',
    '  $form.Controls.AddRange(@($line, $bar, $hint))',
    "  $form.Add_Shown({ Beat 'shown' '' })",
    '  $timer = New-Object System.Windows.Forms.Timer',
    '  $timer.Interval = 500',
    '  $timer.Add_Tick({',
    '    if (Done) { $timer.Stop(); $form.Close() }',
    "    elseif ($form.Visible) { Beat 'shown' '' }",
    '  })',
    '  $timer.Start()',
    // WP325：不用 ShowDialog——没有交互桌面时它直接抛「不在 UserInteractive 模式」；Application.Run 不查这个
    '  [System.Windows.Forms.Application]::Run($form)',
    '} catch {',
    "  Beat 'headless' $_.Exception.Message",
    '}',
    // 窗口画不出来（没有交互桌面 / WinForms 起不来）：照样等到单子收掉或超时，外面靠心跳知道我们在
    'while (-not (Done)) {',
    "  Beat 'headless' ''",
    '  Start-Sleep -Milliseconds 1000',
    '}',
    "Beat 'closed' ''",
    '',
  ].join('\r\n')
}

/** 起小窗要的那几样（注入，测试里不真起进程）。 */
export interface SplashLauncher {
  /** 写临时脚本（带 BOM）。 */
  writeScript(path: string, text: string): void
  /**
   * 脱离父进程起一个进程（父进程马上要退）。`args` 已经按 cmd 的规矩拼好引号，
   * 真起的时候要 `windowsVerbatimArguments: true`，别再让 Node 加一层引号。
   */
  spawnDetached(command: string, args: readonly string[]): void
}

/** cmd 的一个参数：带空格 / 引号的包一层双引号（路径里不会有双引号）。 */
const cmdArg = (a: string): string => (/[\s"&()^|<>]/.test(a) ? `"${a.replace(/"/g, '')}"` : a)

/**
 * WP325：经 `cmd /c start "" /min` 起 PowerShell。
 *
 * 真机 + CI 实测（10-14）：PowerShell 5.1 用 `DETACHED_PROCESS`（Node 的 `detached: true`）直接起，
 * **没有控制台就一行脚本都不跑、退出码 0、120–200 毫秒就退了**——WP319 的小窗就是这样「起了但没有」的。
 * 不脱离又会被桌面壳退出时连带结束（Node 把非脱离子进程放进退出即杀的 job）。所以让脱离的 cmd 用 `start`
 * 给 PowerShell 开一个**新的最小化控制台**（PowerShell 起来就按 `-WindowStyle Hidden` 把它藏起来），
 * 父进程退了它照样活着。
 */
export function viaCmdStart(
  comspec: string,
  powershell: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const line = ['start', '""', '/min', cmdArg(powershell), ...args.map(cmdArg)].join(' ')
  return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`] }
}

export interface BeginUpdateInput {
  files: FileStore
  userData: string
  tempDir: string
  from: string
  to: string
  language: string | undefined
  now: () => Date
  logger: Logger
  /** 只有 Windows 起小窗；别的平台只写单子（以后 mac 签名了也能复用）。 */
  platform: NodeJS.Platform
  launcher: SplashLauncher
  /** PowerShell 在哪（默认系统目录那一份）。 */
  powershell?: string
  /** cmd 在哪（默认 `%ComSpec%`）。 */
  comspec?: string
}

const joinPath = (dir: string, name: string, sep: string): string =>
  dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`

/** 装之前：写「正在更新」单、起小窗。**永不抛**：起不来就是没有小窗，不挡更新。 */
export function beginUpdate(input: BeginUpdateInput): { pendingFile: string; splash: boolean } {
  const sep = input.platform === 'win32' ? '\\' : '/'
  const pendingFile = joinPath(input.userData, UPDATE_PENDING_FILE, sep)
  const pending: UpdatePending = {
    from: input.from,
    to: input.to,
    started_at: input.now().toISOString(),
  }
  try {
    input.files.writeText(pendingFile, `${JSON.stringify(pending)}\n`)
  } catch (e) {
    input.logger.warn('写不了「正在更新」单（不挡更新）', { error: String(e) })
    return { pendingFile, splash: false }
  }
  if (input.platform !== 'win32') return { pendingFile, splash: false }
  try {
    const script = joinPath(input.tempDir, `agentsws-update-${input.to}.ps1`, sep)
    input.launcher.writeScript(
      script,
      splashScript({
        pendingFile,
        heartbeatFile: joinPath(input.userData, UPDATE_SPLASH_FILE, sep),
        text: splashText(input.language, input.to),
      }),
    )
    const launch = viaCmdStart(input.comspec ?? 'cmd.exe', input.powershell ?? 'powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      script,
    ])
    input.launcher.spawnDetached(launch.command, launch.args)
    input.logger.info('「正在更新」小窗起了', { to: input.to })
    return { pendingFile, splash: true }
  } catch (e) {
    input.logger.warn('「正在更新」小窗没起来（不挡更新）', { error: String(e) })
    return { pendingFile, splash: false }
  }
}

/**
 * 新版一启动：收掉「正在更新」单（小窗跟着关），记一行用了多久。
 * 回这次更新用了几秒（没有单 / 单坏了回 undefined）。**永不抛**。
 */
export function finishPendingUpdate(input: {
  files: FileStore
  userData: string
  version: string
  now: () => Date
  logger: Logger
  platform: NodeJS.Platform
}): number | undefined {
  const sep = input.platform === 'win32' ? '\\' : '/'
  const pendingFile = joinPath(input.userData, UPDATE_PENDING_FILE, sep)
  if (!input.files.exists(pendingFile)) return undefined
  let seconds: number | undefined
  try {
    const raw = JSON.parse(input.files.readText(pendingFile) ?? '{}') as Partial<UpdatePending>
    const started = Date.parse(raw.started_at ?? '')
    if (Number.isFinite(started))
      seconds = Math.max(0, Math.round((input.now().getTime() - started) / 1000))
    // WP325：小窗那边的心跳（画出来了 / 没有桌面只在后台等 / 起不来的原因）一起记下
    let splash: string | undefined
    try {
      const beat = JSON.parse(
        input.files.readText(joinPath(input.userData, UPDATE_SPLASH_FILE, sep)) ?? '{}',
      ) as { state?: string; error?: string }
      splash =
        beat.state === undefined
          ? undefined
          : `${beat.state}${beat.error ? `（${beat.error.slice(0, 120)}）` : ''}`
    } catch {
      splash = undefined
    }
    input.logger.info('更新用时', {
      from: raw.from,
      to: raw.to,
      now: input.version,
      seconds,
      ok: raw.to === input.version,
      splash: splash ?? 'none',
    })
  } catch {
    // 坏单子：照样收掉
  }
  try {
    input.files.remove(pendingFile)
  } catch (e) {
    input.logger.warn('收不掉「正在更新」单', { error: String(e) })
  }
  return seconds
}
