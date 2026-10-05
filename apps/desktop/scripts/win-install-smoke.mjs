#!/usr/bin/env node
/**
 * WP218：Windows 安装包**装起来真跑一遍**（CI `windows-latest` 上跑；本机 mac 上只跑得了单测里的纯函数）。
 *
 *   静默安装（装到带中文和空格的目录）→ 看最长路径 → Playwright 起装好的 exe（用户数据目录也带中文）
 *   → 等服务 /v1/health 200 → 打开工作台首页（真的是工作台，不是 404）→ 再起一次验单实例
 *   → 查我们的进程只听 127.0.0.1（不会弹防火墙）→ 退出 → 查没有留下孤儿进程 → 静默卸载
 *
 * WP225 改了两处（CI 第一次真跑：「安装目录里在跑的进程：0 个」、之后 exit 127 没有任何报错）：
 * - **认进程**：PowerShell 5.1 往管道写的是系统代码页（不是 UTF-8），中文安装目录变成问号，
 *   按路径一个都对不上——「退出干净」那条形同虚设。现在 ① 强制 UTF-8 输出；② 路径比较前统一
 *   （去 `\\?\` 前缀、斜杠方向、大小写；目录的真实路径与 8.3 短名都算）；③ 另按进程树认
 *   （Electron 主进程的子孙）；④ 应用开着时一个都没认到 = 认法坏了，直接失败。
 * - **Playwright 那一段放进子进程跑**（`--phase app`）：exit 127 是 Git Bash 把它不认识的
 *   Windows 异常退出码（NTSTATUS，例如 0xC0000409）一律报成 127——跑 Playwright 的 node 在收尾时
 *   崩了、什么都没来得及写。拆开后父进程记下子进程的**原始退出码**（十六进制），照样把「退出干净」
 *   「卸载」查完，最后再按子进程的结果定输赢；每一步都边走边写进 `report.txt`。
 *
 * 用法：node apps/desktop/scripts/win-install-smoke.mjs --installer <Setup.exe> --out <目录>
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 纯函数（单测覆盖，mac 上也能跑）─────────────────────────────────────

/** 目录里最长的几条路径（Windows 的老上限是 260 个字符，NSIS 解包超了会失败）。 */
export function longestPaths(root, top = 5, list = listFiles) {
  return list(root)
    .map((p) => ({ path: p, length: p.length }))
    .sort((a, b) => b.length - a.length)
    .slice(0, top)
}

function listFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(root)
  return out
}

/** 监听地址是不是只在本机（127.0.0.0/8、::1）。 */
export function isLoopback(address) {
  return address === '::1' || /^127\./.test(address)
}

/** PowerShell `ConvertTo-Json` 的输出 → 数组（一条时回对象、多条时回数组、没有时回空串）。 */
export function psRows(json) {
  const text = json.replace(/^﻿/, '').trim()
  if (text === '') return []
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** `Get-NetTCPConnection … | ConvertTo-Json` 的输出 → 不在本机回环上的监听（空 = 没问题）。 */
export function exposedListeners(json) {
  return psRows(json)
    .filter((r) => !isLoopback(String(r.LocalAddress)))
    .map((r) => `${r.LocalAddress}:${r.LocalPort}（pid ${r.OwningProcess}）`)
}

/** Windows 路径统一成可比的样子：去 `\\?\` 前缀、斜杠一律反斜杠、去尾斜杠、小写。 */
export function normalizeWinPath(p) {
  return String(p)
    .replace(/^\\\\\?\\/, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

/**
 * `Get-CimInstance Win32_Process` 的输出 → 跑在安装目录里的进程。
 * `dirs` 可以给几种写法（长路径、真实路径、8.3 短名）；不分大小写，按「目录 + 反斜杠」比，
 * 免得 `…\智能体 工坊` 把 `…\智能体 工坊2` 也算进来。
 */
export function processesUnder(json, dirs) {
  const prefixes = [...new Set((Array.isArray(dirs) ? dirs : [dirs]).map(normalizeWinPath))]
    .filter((d) => d !== '')
    .map((d) => `${d}\\`)
  return psRows(json).filter(
    (r) =>
      typeof r.ExecutablePath === 'string' &&
      prefixes.some((prefix) => normalizeWinPath(r.ExecutablePath).startsWith(prefix)),
  )
}

/** 进程表里 `root` 的所有子孙（按 ParentProcessId 往下找；不含 root 自己）。 */
export function descendantsOf(rows, root) {
  const out = []
  const seen = new Set([root])
  let frontier = [root]
  while (frontier.length > 0) {
    const next = []
    for (const r of rows) {
      if (frontier.includes(r.ParentProcessId) && !seen.has(r.ProcessId)) {
        seen.add(r.ProcessId)
        out.push(r)
        next.push(r.ProcessId)
      }
    }
    frontier = next
  }
  return out
}

/** NSIS 静默安装的参数：`/D=` 必须在最后、不能带引号（所以调用时用 windowsVerbatimArguments）。 */
export function installerArgs(dir) {
  return ['/S', `/D=${dir}`]
}

/**
 * 进程退出码的人话：Windows 上崩溃是一个 NTSTATUS（`spawnSync` 回的是无符号数，例如 3221226505），
 * 按十六进制写出来才查得到是什么（0xC0000409 = 栈缓冲区溢出 / fast-fail，0xC0000005 = 访问冲突）。
 */
export function describeExit(status, signal) {
  if (signal !== null && signal !== undefined) return `被信号 ${signal} 结束`
  if (status === null || status === undefined) return '没有退出码'
  const u = status >>> 0
  return u >= 0x80000000 ? `${status}（0x${u.toString(16).toUpperCase()}）` : String(status)
}

// ── Windows 上用的小工具（e2e 脚本 `win-update-e2e.mjs` 也用）──────────────

function arg(name) {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}

/** 跑一段 PowerShell；**强制 UTF-8 输出**（5.1 默认按系统代码页写，中文路径成了问号）。 */
export function powershell(command, env = process.env) {
  const out = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`,
    ],
    { encoding: 'utf8', windowsHide: true, env, maxBuffer: 64 * 1024 * 1024 },
  )
  return out.stdout ?? ''
}

/** 整张进程表（JSON 文本）。 */
export function processTable() {
  return powershell(
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress',
  )
}

/** 安装目录的几种写法：给的那个、真实路径、8.3 短名（目录名经环境变量传，不进命令行）。 */
export function dirAliases(dir) {
  const out = [dir]
  try {
    out.push(realpathSync.native(dir))
  } catch {
    // 不在：只用给的那个
  }
  const short = powershell(
    '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:AGENTSWS_SMOKE_DIR).ShortPath',
    { ...process.env, AGENTSWS_SMOKE_DIR: dir },
  ).trim()
  if (short !== '') out.push(short)
  return [...new Set(out)]
}

/** 我们的进程：跑在安装目录里的，加上 `rootPid`（Electron 主进程）的子孙。 */
export function ourProcesses(aliases, rootPid) {
  const table = processTable()
  const rows = psRows(table)
  const byPid = new Map()
  for (const r of processesUnder(table, aliases)) byPid.set(r.ProcessId, r)
  if (rootPid !== undefined) {
    const root = rows.find((r) => r.ProcessId === rootPid)
    if (root !== undefined) byPid.set(root.ProcessId, root)
    for (const r of descendantsOf(rows, rootPid)) byPid.set(r.ProcessId, r)
  }
  return [...byPid.values()]
}

export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      s.close(() => res(typeof a === 'object' && a !== null ? a.port : 0))
    })
  })
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 边走边写的报告：每一步立刻落盘（进程中途崩了也看得到走到哪一步）。 */
export function reporter(out, name = 'report.txt') {
  mkdirSync(out, { recursive: true })
  const file = join(out, name)
  return (line) => {
    appendFileSync(file, `${line}\n`)
    process.stdout.write(`▶ ${line}\n`)
  }
}

/** 静默安装到 `dir`，回装好的 exe。 */
export function silentInstall(installer, dir) {
  const inst = spawnSync(installer, installerArgs(dir), {
    windowsVerbatimArguments: true,
    timeout: 300_000,
  })
  const exe = join(dir, 'agentsws.exe')
  if (inst.status !== 0 || !existsSync(exe))
    throw new Error(`静默安装失败（退出码 ${describeExit(inst.status, inst.signal)}），${exe} 不在`)
  return exe
}

/** 等服务健康（壳的测试把手 `__agentsws__`），回服务地址。 */
export async function waitHealthy(app, seconds = 120) {
  for (let i = 0; i < seconds * 2; i += 1) {
    const ok = await app.evaluate(() => globalThis.__agentsws__?.health()?.ok === true)
    if (ok) return app.evaluate(() => globalThis.__agentsws__?.serverUrl() ?? '')
    await sleep(500)
  }
  throw new Error(`${seconds} 秒内服务进程没有健康（看 server.log）`)
}

/**
 * 让壳自己退（跳过「官方场景还开着」的确认），等 Electron 主进程真的没了再回。
 * 退出放进 setTimeout：evaluate 先回来，不和 Playwright 的连接断开抢。
 */
export async function quitApp(app, seconds = 45) {
  const proc = app.process()
  const exited = new Promise((res) => {
    if (proc.exitCode !== null) res(proc.exitCode)
    else proc.once('exit', (code) => res(code))
  })
  await app
    .evaluate(({ app: a }) => {
      globalThis.__agentsws__?.skipQuitConfirmation()
      setTimeout(() => a.quit(), 100)
    })
    .catch(() => undefined)
  const code = await Promise.race([exited, sleep(seconds * 1000).then(() => 'timeout')])
  await app.close().catch(() => undefined)
  return code
}

// ── 子进程：Playwright 那一段（--phase app）───────────────────────────────

/** 起装好的 exe → 健康 → 工作台首页 → 单实例 → 认进程 → 只听回环 → 退出。结果写 `app-phase.json`。 */
async function appPhase() {
  const exe = arg('--exe')
  const dir = arg('--dir')
  const userData = arg('--user-data')
  const out = resolve(arg('--out') ?? 'win-smoke')
  const step = reporter(out)
  const result = { ok: false, pids: [] }
  const save = () => writeFileSync(join(out, 'app-phase.json'), JSON.stringify(result, null, 2))
  const { _electron: electron } = await import('@playwright/test')
  const app = await electron.launch({
    executablePath: exe,
    env: {
      ...process.env,
      AGENTSWS_DESKTOP_USER_DATA: userData,
      AGENTSWS_DESKTOP_UPDATES: '0',
      AGENTSWS_DESKTOP_BROWSER_EXECUTABLE: join(userData, 'no-such-chrome.exe'),
    },
    timeout: 120_000,
  })
  const rootPid = app.process().pid
  step(`起来了：Electron 主进程 pid ${rootPid}`)
  try {
    const base = await waitHealthy(app)
    const res = await fetch(`${base}/v1/health`)
    step(`服务健康：${base}/v1/health → ${res.status}`)
    if (res.status !== 200) throw new Error(`/v1/health 回 ${res.status}`)

    // 打开工作台首页：真的是工作台（有 #root 且渲染出东西），不是 404
    await app.evaluate((_e, p) => globalThis.__agentsws__?.openWorkstation(p), '/')
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(
      () => (document.querySelector('#root')?.childElementCount ?? 0) > 0,
      null,
      { timeout: 60_000 },
    )
    await sleep(3000)
    await page.screenshot({ path: join(out, 'workstation-home.png') })
    step(`工作台首页打开了：${page.url()}（截图 workstation-home.png）`)

    // 单实例：再起一次应该立刻退出，并把已有的那个窗口端出来
    const second = spawnSync(exe, [], {
      timeout: 30_000,
      env: { ...process.env, AGENTSWS_DESKTOP_USER_DATA: userData },
    })
    step(`单实例：第二个进程退出码 ${describeExit(second.status, second.signal)}`)
    if (second.status === null) throw new Error('第二个实例 30 秒没退出（单实例锁没生效？）')

    // 认进程：一个都没认到 = 认法坏了（应用明明开着）；至少要有壳与服务进程（捆绑的 node.exe）
    const aliases = dirAliases(dir)
    step(`安装目录的写法：${aliases.join(' | ')}`)
    const procs = ourProcesses(aliases, rootPid)
    result.pids = procs.map((p) => p.ProcessId)
    save()
    step(
      `我们在跑的进程：${procs.length} 个（${procs.map((p) => `${p.Name}#${p.ProcessId}`).join('、')}）`,
    )
    if (!procs.some((p) => /^agentsws\.exe$/i.test(String(p.Name))))
      throw new Error('应用开着却没认到 agentsws.exe（进程匹配坏了，「退出干净」那条会形同虚设）')
    if (!procs.some((p) => /^node\.exe$/i.test(String(p.Name))))
      throw new Error('没认到服务进程（捆绑的 node.exe）')

    // 只听 127.0.0.1（不弹防火墙）
    const exposed = exposedListeners(
      powershell(
        `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${result.pids.join(',')}) -contains $_.OwningProcess } | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`,
      ),
    )
    if (exposed.length > 0)
      throw new Error(`有监听不在本机回环上（会弹防火墙）：${exposed.join('、')}`)
    step('监听都在 127.0.0.1 / ::1')
    result.ok = true
    save()
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    save()
    step(`✗ ${result.error}`)
  } finally {
    const code = await quitApp(app)
    result.quit = String(code)
    save()
    step(`退出：Electron 主进程${code === 'timeout' ? ' 45 秒没退' : `退出码 ${code}`}`)
  }
  process.exit(result.ok ? 0 : 1)
}

// ── 父进程：装、交给子进程、查孤儿、卸载 ───────────────────────────────────

async function main() {
  const installer = arg('--installer')
  const out = resolve(arg('--out') ?? 'win-smoke')
  if (installer === undefined || !existsSync(installer)) throw new Error(`没有安装包：${installer}`)
  if (process.platform !== 'win32') throw new Error('这个脚本只在 Windows 上跑')
  const step = reporter(out)

  // 1. 静默安装到带中文和空格的目录（模拟中文用户名 / 用户自己挑的目录）
  const local = process.env.LOCALAPPDATA ?? tmpdir()
  const dir = join(local, 'Programs', '智能体 工坊 测试')
  const exe = silentInstall(installer, dir)
  step(`装好了：${exe}`)

  // 2. 最长路径
  const longest = longestPaths(dir)
  writeFileSync(
    join(out, 'longest-paths.txt'),
    longest.map((l) => `${l.length}\t${l.path}`).join('\n'),
  )
  step(`最长路径 ${longest[0]?.length ?? 0} 个字符（老上限 260）`)
  if ((longest[0]?.length ?? 0) >= 260) throw new Error('安装目录里有超过 260 个字符的路径')

  // 3. 起装好的 exe 那一段放进子进程（用户数据目录也带中文；不查更新；端口随机）
  const userData = join(local, 'agentsws-smoke-数据')
  mkdirSync(userData, { recursive: true })
  const port = await freePort()
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({ port, openInBrowser: false, launchAtLogin: false, language: 'zh-CN' }),
  )
  const self = fileURLToPath(import.meta.url)
  const child = spawnSync(
    process.execPath,
    [self, '--phase', 'app', '--exe', exe, '--dir', dir, '--user-data', userData, '--out', out],
    { stdio: 'inherit', timeout: 15 * 60_000 },
  )
  const childExit = describeExit(child.status, child.signal)
  step(`Playwright 那一段（子进程）退出码：${childExit}`)
  let phase = { ok: false, pids: [] }
  try {
    phase = JSON.parse(readFileSync(join(out, 'app-phase.json'), 'utf8'))
  } catch {
    // 子进程没来得及写：按没过算
  }

  // 4. 退出后不留孤儿（不然下一次更新 / 卸载「文件被占用」）：按目录认 + 按跑着时记下的 pid 认
  const aliases = dirAliases(dir)
  const leftovers = () => {
    const table = processTable()
    const mine = new Map(processesUnder(table, aliases).map((r) => [r.ProcessId, r]))
    for (const r of psRows(table)) if (phase.pids.includes(r.ProcessId)) mine.set(r.ProcessId, r)
    return [...mine.values()]
  }
  let left = []
  for (let i = 0; i < 30; i += 1) {
    left = leftovers()
    if (left.length === 0) break
    await sleep(1000)
  }
  const orphanError =
    left.length > 0
      ? `退出 30 秒后还有进程在跑：${left.map((p) => `${p.Name}#${p.ProcessId} ${p.ExecutablePath ?? ''}`).join('、')}`
      : undefined
  if (orphanError === undefined) step('退出干净：没有留下进程')
  else {
    step(`✗ ${orphanError}`)
    // 收拾掉，后面的卸载才查得下去（结果照样算失败）
    for (const p of left) spawnSync('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'])
  }
  cpSync(join(userData, 'logs'), join(out, 'logs'), { recursive: true, force: true })

  // 5. 静默卸载：文件没被占用、用户数据还在
  const uninstaller = readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f))
  if (uninstaller === undefined) throw new Error('安装目录里没有卸载程序')
  spawn(join(dir, uninstaller), ['/S'], { detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 60 && existsSync(exe); i += 1) await sleep(1000)
  if (existsSync(exe)) throw new Error('静默卸载 60 秒后程序还在')
  if (!existsSync(join(userData, 'config.json'))) throw new Error('卸载把用户数据也删了')
  step('卸载干净，用户数据保留')

  // 6. 输赢：子进程那一段 + 孤儿
  if (child.status !== 0 || phase.ok !== true)
    throw new Error(
      `Playwright 那一段没过（${phase.error ?? '没写结果'}；子进程退出码 ${childExit}）`,
    )
  if (orphanError !== undefined) throw new Error(orphanError)
  step('全部通过')
}

const selfPath = fileURLToPath(import.meta.url).toLowerCase()
if (process.argv[1] !== undefined && resolve(process.argv[1]).toLowerCase() === selfPath) {
  const run = arg('--phase') === 'app' ? appPhase : main
  run().catch((err) => {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
    try {
      appendFileSync(join(resolve(arg('--out') ?? 'win-smoke'), 'report.txt'), `✗ ${text}\n`)
    } catch {
      // 报告写不进去也照样退出
    }
    process.stderr.write(`✗ ${text}\n`)
    process.exitCode = 1
  })
}
