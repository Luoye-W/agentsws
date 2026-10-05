#!/usr/bin/env node
/**
 * WP218：Windows 安装包**装起来真跑一遍**（CI `windows-latest` 上跑；本机 mac 上只跑得了单测里的纯函数）。
 *
 *   静默安装（装到带中文和空格的目录）→ 看最长路径 → Playwright 起装好的 exe（用户数据目录也带中文）
 *   → 等服务 /v1/health 200 → 打开工作台首页（真的是工作台，不是 404）→ 再起一次验单实例
 *   → 查我们的进程只听 127.0.0.1（不会弹防火墙）→ 退出 → 查没有留下孤儿 node.exe → 静默卸载
 *
 * 任何一步不过就非 0 退出；日志、截图、桌面壳与服务进程的日志都放进 `--out` 目录，CI 作为 artifact 上传。
 *
 * 用法：node apps/desktop/scripts/win-install-smoke.mjs --installer <Setup.exe> --out <目录>
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * `Get-NetTCPConnection … | ConvertTo-Json` 的输出 → 不在本机回环上的监听（空 = 没问题）。
 * PowerShell 只有一条时回对象、多条时回数组、没有时回空串。
 */
export function exposedListeners(json) {
  const text = json.trim()
  if (text === '') return []
  const parsed = JSON.parse(text)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .filter((r) => !isLoopback(String(r.LocalAddress)))
    .map((r) => `${r.LocalAddress}:${r.LocalPort}（pid ${r.OwningProcess}）`)
}

/** `Get-CimInstance Win32_Process` 的输出 → 跑在安装目录里的进程（不分大小写）。 */
export function processesUnder(json, dir) {
  const text = json.trim()
  if (text === '') return []
  const parsed = JSON.parse(text)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const prefix = dir.toLowerCase()
  return rows.filter(
    (r) =>
      typeof r.ExecutablePath === 'string' && r.ExecutablePath.toLowerCase().startsWith(prefix),
  )
}

/** NSIS 静默安装的参数：`/D=` 必须在最后、不能带引号（所以调用时用 windowsVerbatimArguments）。 */
export function installerArgs(dir) {
  return ['/S', `/D=${dir}`]
}

// ── 真跑（只在 Windows 上）─────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}

function powershell(command) {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return out.stdout ?? ''
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      s.close(() => res(typeof a === 'object' && a !== null ? a.port : 0))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const installer = arg('--installer')
  const out = resolve(arg('--out') ?? 'win-smoke')
  if (installer === undefined || !existsSync(installer)) throw new Error(`没有安装包：${installer}`)
  if (process.platform !== 'win32') throw new Error('这个脚本只在 Windows 上跑')
  mkdirSync(out, { recursive: true })
  const report = []
  const step = (line) => {
    report.push(line)
    process.stdout.write(`▶ ${line}\n`)
  }

  // 1. 静默安装到带中文和空格的目录（模拟中文用户名 / 用户自己挑的目录）
  const local = process.env.LOCALAPPDATA ?? tmpdir()
  const dir = join(local, 'Programs', '智能体 工坊 测试')
  const inst = spawnSync(installer, installerArgs(dir), {
    windowsVerbatimArguments: true,
    timeout: 300_000,
  })
  const exe = join(dir, 'agentsws.exe')
  if (inst.status !== 0 || !existsSync(exe))
    throw new Error(`静默安装失败（退出码 ${inst.status}），${exe} 不在`)
  step(`装好了：${exe}`)

  // 2. 最长路径
  const longest = longestPaths(dir)
  writeFileSync(
    join(out, 'longest-paths.txt'),
    longest.map((l) => `${l.length}\t${l.path}`).join('\n'),
  )
  step(`最长路径 ${longest[0]?.length ?? 0} 个字符（老上限 260）`)
  if ((longest[0]?.length ?? 0) >= 260) throw new Error('安装目录里有超过 260 个字符的路径')

  // 3. 起装好的 exe（用户数据目录也带中文；不查更新；端口随机）
  const userData = join(local, 'agentsws-smoke-数据')
  mkdirSync(userData, { recursive: true })
  const port = await freePort()
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({ port, openInBrowser: false, launchAtLogin: false, language: 'zh-CN' }),
  )
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
  const handle = (fn, a) => app.evaluate(fn, a)
  try {
    let healthy = false
    for (let i = 0; i < 240 && !healthy; i += 1) {
      healthy = await handle(() => globalThis.__agentsws__?.health()?.ok === true)
      if (!healthy) await sleep(500)
    }
    if (!healthy) throw new Error('2 分钟内服务进程没有健康（看 server.log）')
    const base = await handle(() => globalThis.__agentsws__?.serverUrl() ?? '')
    const res = await fetch(`${base}/v1/health`)
    step(`服务健康：${base}/v1/health → ${res.status}`)
    if (res.status !== 200) throw new Error(`/v1/health 回 ${res.status}`)

    // 4. 打开工作台首页：真的是工作台（有 #root 且渲染出东西），不是 404
    await handle((_e, p) => globalThis.__agentsws__?.openWorkstation(p), '/')
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(
      () => (document.querySelector('#root')?.childElementCount ?? 0) > 0,
      null,
      {
        timeout: 60_000,
      },
    )
    await sleep(3000)
    await page.screenshot({ path: join(out, 'workstation-home.png') })
    step(`工作台首页打开了：${page.url()}（截图 workstation-home.png）`)

    // 5. 单实例：再起一次应该立刻退出，并把已有的那个窗口端出来
    const second = spawnSync(exe, [], {
      timeout: 30_000,
      env: { ...process.env, AGENTSWS_DESKTOP_USER_DATA: userData },
    })
    step(`单实例：第二个进程退出码 ${second.status}`)
    if (second.status === null) throw new Error('第二个实例 30 秒没退出（单实例锁没生效？）')

    // 6. 只听 127.0.0.1（不弹防火墙）
    const procs = processesUnder(
      powershell(
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress',
      ),
      dir,
    )
    const pids = procs.map((p) => p.ProcessId)
    step(`安装目录里在跑的进程：${pids.length} 个`)
    const exposed =
      pids.length === 0
        ? []
        : exposedListeners(
            powershell(
              `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${pids.join(',')}) -contains $_.OwningProcess } | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`,
            ),
          )
    if (exposed.length > 0)
      throw new Error(`有监听不在本机回环上（会弹防火墙）：${exposed.join('、')}`)
    step('监听都在 127.0.0.1 / ::1')
  } finally {
    // 7. 退出（跳过「官方场景还开着」的确认）
    await handle(({ app: a }) => {
      globalThis.__agentsws__?.skipQuitConfirmation()
      a.quit()
    }).catch(() => undefined)
    await app.close().catch(() => undefined)
    cpSync(join(userData, 'logs'), join(out, 'logs'), { recursive: true, force: true })
  }

  // 8. 退出后不留孤儿（不然下一次更新 / 卸载「文件被占用」）
  let left = []
  for (let i = 0; i < 30; i += 1) {
    left = processesUnder(
      powershell(
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress',
      ),
      dir,
    )
    if (left.length === 0) break
    await sleep(1000)
  }
  if (left.length > 0)
    throw new Error(`退出 30 秒后还有进程在跑：${left.map((p) => p.ExecutablePath).join('、')}`)
  step('退出干净：没有留下进程')

  // 9. 静默卸载：文件没被占用、用户数据还在
  const uninstaller = readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f))
  if (uninstaller === undefined) throw new Error('安装目录里没有卸载程序')
  spawn(join(dir, uninstaller), ['/S'], { detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 60 && existsSync(exe); i += 1) await sleep(1000)
  if (existsSync(exe)) throw new Error('静默卸载 60 秒后程序还在')
  if (!existsSync(join(userData, 'config.json'))) throw new Error('卸载把用户数据也删了')
  step('卸载干净，用户数据保留')

  writeFileSync(join(out, 'report.txt'), `${report.join('\n')}\n`)
}

const self = fileURLToPath(import.meta.url).toLowerCase()
if (process.argv[1] !== undefined && resolve(process.argv[1]).toLowerCase() === self) {
  main().catch((err) => {
    process.stderr.write(`✗ ${err instanceof Error ? err.stack : String(err)}\n`)
    process.exit(1)
  })
}
