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
  text: SplashText
  timeoutSeconds?: number
}): string {
  const timeout = input.timeoutSeconds ?? SPLASH_TIMEOUT_SECONDS
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$pending = ${psQuote(input.pendingFile)}`,
    `$timeout = ${String(Math.max(10, Math.round(timeout)))}`,
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$form = New-Object System.Windows.Forms.Form',
    `$form.Text = ${psQuote(input.text.title)}`,
    "$form.FormBorderStyle = 'FixedDialog'",
    '$form.ControlBox = $false',
    "$form.StartPosition = 'CenterScreen'",
    '$form.TopMost = $true',
    '$form.ShowInTaskbar = $true',
    '$form.ClientSize = New-Object System.Drawing.Size(360, 112)',
    '$line = New-Object System.Windows.Forms.Label',
    `$line.Text = ${psQuote(input.text.line)}`,
    "$line.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)",
    '$line.Location = New-Object System.Drawing.Point(20, 16)',
    '$line.Size = New-Object System.Drawing.Size(320, 26)',
    '$bar = New-Object System.Windows.Forms.ProgressBar',
    "$bar.Style = 'Marquee'",
    '$bar.MarqueeAnimationSpeed = 30',
    '$bar.Location = New-Object System.Drawing.Point(20, 50)',
    '$bar.Size = New-Object System.Drawing.Size(320, 12)',
    '$hint = New-Object System.Windows.Forms.Label',
    `$hint.Text = ${psQuote(input.text.hint)}`,
    "$hint.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)",
    '$hint.ForeColor = [System.Drawing.Color]::Gray',
    '$hint.Location = New-Object System.Drawing.Point(20, 74)',
    '$hint.Size = New-Object System.Drawing.Size(320, 22)',
    '$form.Controls.AddRange(@($line, $bar, $hint))',
    '$start = Get-Date',
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 500',
    '$timer.Add_Tick({',
    '  if (-not (Test-Path -LiteralPath $pending) -or ((Get-Date) - $start).TotalSeconds -gt $timeout) {',
    '    $timer.Stop()',
    '    $form.Close()',
    '  }',
    '})',
    '$timer.Start()',
    '[void]$form.ShowDialog()',
    '',
  ].join('\r\n')
}

/** 起小窗要的那几样（注入，测试里不真起进程）。 */
export interface SplashLauncher {
  /** 写临时脚本（带 BOM）。 */
  writeScript(path: string, text: string): void
  /** 脱离父进程起 PowerShell（父进程马上要退）。 */
  spawnDetached(command: string, args: readonly string[]): void
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
      splashScript({ pendingFile, text: splashText(input.language, input.to) }),
    )
    input.launcher.spawnDetached(input.powershell ?? 'powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      script,
    ])
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
    input.logger.info('更新用时', {
      from: raw.from,
      to: raw.to,
      now: input.version,
      seconds,
      ok: raw.to === input.version,
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
