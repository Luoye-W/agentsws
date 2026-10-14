#!/usr/bin/env node
/**
 * WP225 → WP327：**真实版本之间点「更新」**，在 CI 的 windows-latest 上跑三段：
 *
 * A. **迁移**：静默装一个**发布过的老版本**（平铺布局，`--old`）→ 把它的更新源改指本机 → 应用内点更新到 V1
 *    （老版本走安装程序）→ V1 起来，安装目录变成 `current` 联接 + `app-<V1>`，快捷方式（含模拟的任务栏固定）
 *    改指 `current\agentsws.exe`，数据都在。
 * B. **回滚演练**：用户数据目录放 `update-drill.json`（V2 看到就假装起不来）→ V1 点更新：后台下载 + 在旁边
 *    摆好 `app-<V2>` → 点「重启并更新」只切换 → V2 60 秒没报起来 → V1 切回、重开自己 → V1 重新健康。
 * C. **只切换**：再点一次更新到 V2 → 量「点了 → 新版桌面壳启动」「点了 → 新版服务健康」秒数；上一版目录留着、
 *    卸载登记的版本号改了、单实例照常、数据都在。
 *
 * 用法：node apps/desktop/scripts/win-update-e2e.mjs --old <老版本 Setup.exe> --v1-dir <V1 的 release 目录>
 *        --v2-dir <V2 的 release 目录> --port <端口> --out <目录>
 * （V1 / V2 打包时把更新源指到本机这个端口：`AGENTSWS_UPDATE_BASE_URL=http://127.0.0.1:<端口>`，回环 http 只为测试放行。）
 */
import { spawnSync } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkVersionedLayout,
  copyDirSync,
  describeExit,
  dirAliases,
  freePort,
  installFootprint,
  installLayout,
  normalizeWinPath,
  powershell,
  processesUnder,
  processTable,
  reporter,
  shortcutPaths,
  shortcutTarget,
  silentInstall,
  sleep,
  waitHealthy,
} from './win-install-smoke.mjs'

// ── 纯函数（单测覆盖）──────────────────────────────────────────────────

/** `latest.yml` 里的 `version:`。 */
export function versionOfLatestYml(text) {
  const m = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)
  return m?.[1]
}

/**
 * 更新源上的一个请求 → 发 `dir` 里的哪个文件（只认 `/<渠道>/<文件名>`，文件名不许带路径）。
 * 回 undefined = 404。
 */
export function feedFileFor(urlPath, dir, files) {
  let path
  try {
    path = decodeURIComponent(urlPath.split('?')[0] ?? '')
  } catch {
    return undefined
  }
  const m = /^\/(stable|beta)\/([^/\\]+)$/.exec(path)
  if (m === null) return undefined
  const name = m[2]
  if (name === '.' || name === '..' || !files.includes(name)) return undefined
  return join(dir, name)
}

/** Windows 上 Electron 的默认用户数据目录（`%APPDATA%\<包名>`；包名带 scope 就是两层）。 */
export function defaultUserData(appData, packageName) {
  return join(appData, ...packageName.split('/'))
}

// ── 真跑（只在 Windows 上）─────────────────────────────────────────────

/** WP325：读小窗的心跳（它自己写的 JSON；没有 / 坏的回 undefined）。 */
export function readBeat(file) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    return typeof j?.state === 'string' && typeof j?.at === 'string' ? j : undefined
  } catch {
    return undefined
  }
}

/** 心跳给人看的那几个字。 */
export function describeBeat(beat) {
  const what =
    beat.state === 'shown'
      ? '窗口画出来了'
      : beat.state === 'headless'
        ? `没有交互桌面，后台在等${beat.error ? `：${String(beat.error).slice(0, 80)}` : ''}`
        : beat.state === 'closed'
          ? '关了'
          : beat.state
  const env =
    beat.interactive === undefined
      ? ''
      : `，${beat.interactive ? '交互会话' : '非交互会话'} ${beat.session ?? '?'}`
  return `${what}，pid ${beat.pid ?? '?'}${env}`
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}

/** 本机更新源：记下每一次请求（报告里看得见「真的下了新版」）。`dirOf()` 回这一刻要喂的目录（分阶段换）。 */
function startFeed(dirOf, port, log) {
  const server = createServer((req, res) => {
    const dir = dirOf()
    const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile())
    const file = feedFileFor(req.url ?? '/', dir, files)
    log(`更新源：${req.method} ${req.url} → ${file === undefined ? 404 : 200}`)
    if (file === undefined) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-length': statSync(file).size })
    if (req.method === 'HEAD') res.end()
    else createReadStream(file).pipe(res)
  })
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res(server)))
}

/** WP327：把老版本安装包里的更新源（`resources\app-update.yml` 的 `url:`）改指本机更新源。 */
export function patchAppUpdateYml(text, url) {
  const lines = text.split(/\r?\n/)
  let found = false
  const out = lines.map((line) => {
    if (/^url:/.test(line)) {
      found = true
      return `url: ${url}`
    }
    return line
  })
  return found ? out.join('\n') : `${text.replace(/\s*$/, '')}\nurl: ${url}\n`
}

/** 在工作台页面里读 / 点左下角那颗按钮背后的桥（`window.agentsws.update`）。 */
async function waitUpdate(page, want, seconds, step) {
  let last
  for (let i = 0; i < seconds; i += 1) {
    const s = await page.evaluate(() => window.agentsws?.update?.status())
    const text = JSON.stringify(s)
    if (text !== last && !(s?.state === 'downloading' && i % 10 !== 0)) step(`更新状态：${text}`)
    last = text
    if (s?.state === 'error') throw new Error(`更新出错：${text}`)
    if (want.includes(s?.state)) return s
    await sleep(1000)
  }
  throw new Error(`${seconds} 秒内没等到 ${want.join(' / ')}（最后是 ${last}）`)
}

async function healthVersion(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return undefined
    const body = await res.json()
    return body?.data?.version ?? body?.version
  } catch {
    return undefined
  }
}

/** 等服务报某个版本；回用了多少毫秒（等不到抛）。 */
async function waitVersion(port, want, seconds, what) {
  const t0 = Date.now()
  let v
  for (let i = 0; i < seconds * 2; i += 1) {
    v = await healthVersion(port)
    if (v === want) return Date.now() - t0
    await sleep(500)
  }
  throw new Error(`${seconds} 秒内${what}没起来（服务报 ${v ?? '连不上'}，应是 ${want}）`)
}

/** 结束安装目录里的全部进程（新版是旧版起的，没有 Playwright 的把手）。 */
async function killInstalled(dir) {
  for (let round = 0; round < 10; round += 1) {
    const left = processesUnder(processTable(), dirAliases(dir))
    if (left.length === 0) return
    for (const p of left) spawnSync('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'])
    await sleep(1000)
  }
}

/** Playwright 起装好的 exe（默认用户数据目录）→ 服务健康 → 打开工作台；回 app 与页面。 */
async function launchInstalled(exe, userData, port, wantVersion, step) {
  const { _electron: electron } = await import('@playwright/test')
  const app = await electron.launch({ executablePath: exe, timeout: 120_000 })
  const actual = await app.evaluate(({ app: a }) => a.getPath('userData'))
  if (normalizeWinPath(actual) !== normalizeWinPath(userData))
    throw new Error(`默认用户数据目录不是 ${userData}，而是 ${actual}`)
  await waitHealthy(app)
  const v = await healthVersion(port)
  if (v !== wantVersion) throw new Error(`服务报的版本 ${v} ≠ ${wantVersion}`)
  step(`起来了：${exe}（服务 ${v}）`)
  await app.evaluate((_e, p) => globalThis.__agentsws__?.openWorkstation(p), '/')
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.agentsws?.update !== undefined, null, { timeout: 60_000 })
  return { app, page }
}

/** 等「有新版」→ 点「下载」→ 等「重启并更新」；回从点下载到可以重启用了几秒。 */
async function downloadUpdate(page, step) {
  await waitUpdate(page, ['available'], 180, step)
  const t0 = Date.now()
  await page.evaluate(() => window.agentsws.update.download())
  await waitUpdate(page, ['ready'], 900, step)
  return Math.round((Date.now() - t0) / 1000)
}

/** 点「重启并更新」；回点的那一刻与「旧版主进程退了」的 Promise。 */
async function clickInstall(app, page, step) {
  const proc = app.process()
  const exited = new Promise((r) => proc.once('exit', (code) => r({ code, at: Date.now() })))
  const clicked = Date.now()
  const outcome = await page
    .evaluate(() => window.agentsws.update.install())
    .catch((e) => `（连接断开：${e.message.split('\n')[0]}）`)
  step(`点了「重启并更新」：${outcome}`)
  return { clicked, exited }
}

function dataStillThere(userData, marker, port, dataBefore) {
  if (!existsSync(marker)) throw new Error('更新之后记号文件没了')
  const cfg = JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8'))
  if (cfg.port !== port) throw new Error('更新之后 config.json 被换掉了')
  const dataAfter = readdirSync(join(userData, 'data'))
  const lost = dataBefore.filter((f) => !dataAfter.includes(f))
  if (lost.length > 0) throw new Error(`更新之后数据目录少了：${lost.join('、')}`)
}

function logHas(userData, text) {
  const file = join(userData, 'logs', 'desktop.log')
  return existsSync(file) && readFileSync(file, 'utf8').includes(text)
}

/** 卸载登记里的「已安装版本」（HKCU 下按显示名找）。 */
function registeredVersion() {
  return powershell(
    "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Agents*' } | Select-Object -First 1 -ExpandProperty DisplayVersion",
  ).trim()
}

/** 模拟一个任务栏固定（老的平铺布局下它指 `<安装目录>\agentsws.exe`），迁移后要被改指 current。 */
function fakePin(lnk, target) {
  mkdirSync(dirname(lnk), { recursive: true })
  powershell(
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:AGENTSWS_LNK); $s.TargetPath = $env:AGENTSWS_TARGET; $s.Save()',
    { ...process.env, AGENTSWS_LNK: lnk, AGENTSWS_TARGET: target },
  )
}

async function main() {
  const oldInstaller = arg('--old')
  const v1Dir = resolve(arg('--v1-dir') ?? '')
  const v2Dir = resolve(arg('--v2-dir') ?? '')
  const feedPort = Number(arg('--port'))
  const out = resolve(arg('--out') ?? 'win-update')
  if (process.platform !== 'win32') throw new Error('这个脚本只在 Windows 上跑')
  if (oldInstaller === undefined || !existsSync(oldInstaller))
    throw new Error(`没有老版本安装包：${oldInstaller}`)
  const step = reporter(out)
  const v1 = versionOfLatestYml(readFileSync(join(v1Dir, 'latest.yml'), 'utf8'))
  const v2 = versionOfLatestYml(readFileSync(join(v2Dir, 'latest.yml'), 'utf8'))
  if (v1 === undefined || v2 === undefined) throw new Error('latest.yml 里没有 version')
  let feedDir = v1Dir
  const feed = await startFeed(() => feedDir, feedPort, step)
  const feedUrl = `http://127.0.0.1:${feedPort}`
  step(`本机更新源：${feedUrl}/（先喂 ${v1}，后喂 ${v2}）`)
  const summary = []

  // ── A. 迁移：装发布过的老版本（平铺）→ 应用内更新到 V1（走安装程序）→ 变成版本目录布局 ─────────
  const local = process.env.LOCALAPPDATA ?? tmpdir()
  const dir = join(local, 'Programs', '智能体 工坊 更新测试')
  const t0 = Date.now()
  const oldExe = silentInstall(oldInstaller, dir)
  const pkgOf = (exe) =>
    JSON.parse(readFileSync(join(dirname(exe), 'resources', 'app', 'package.json'), 'utf8'))
  const fromVersion = pkgOf(oldExe).version
  const footOld = installFootprint(dir)
  step(
    `A 装好了老版本 ${fromVersion}（平铺）：${oldExe}；静默装 ${Math.round((Date.now() - t0) / 1000)} 秒，${footOld.files} 个文件、${footOld.mb} MB`,
  )
  if (installLayout(dir).link) throw new Error('老版本不该是版本目录布局')
  const yml = join(dirname(oldExe), 'resources', 'app-update.yml')
  writeFileSync(yml, patchAppUpdateYml(readFileSync(yml, 'utf8'), `${feedUrl}/beta`))
  const pins = shortcutPaths()
  fakePin(pins.pinned, oldExe)
  step(`A 模拟了一个任务栏固定 → ${shortcutTarget(pins.pinned)}`)

  const userData = defaultUserData(process.env.APPDATA ?? tmpdir(), pkgOf(oldExe).name)
  mkdirSync(userData, { recursive: true })
  const port = await freePort()
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({
      port,
      openInBrowser: false,
      launchAtLogin: false,
      language: 'zh-CN',
      updateGithubFallback: false,
    }),
  )
  const marker = join(userData, 'wp327-e2e-marker.txt')
  writeFileSync(marker, `from=${fromVersion}\n`)

  let h = await launchInstalled(oldExe, userData, port, fromVersion, step)
  const dataBefore = readdirSync(join(userData, 'data'))
  step(`A 下载用了 ${await downloadUpdate(h.page, step)} 秒`)
  let click = await clickInstall(h.app, h.page, step)
  const exitA = await Promise.race([click.exited, sleep(120_000).then(() => undefined)])
  void h.app.close().catch(() => undefined)
  if (exitA === undefined) throw new Error('A 点了「重启并更新」120 秒老版本还没退')
  const msA = await waitVersion(port, v1, 420, 'V1（迁移）')
  const secA = Math.round((Date.now() - click.clicked) / 1000)
  step(`A 迁移完成：从点「重启并更新」到 V1 服务健康 ${secA} 秒`)
  void msA
  const layoutA = checkVersionedLayout(dir, v1)
  for (const line of layoutA.lines) step(`A ${line}`)
  if (layoutA.problems.length > 0)
    throw new Error(`A 迁移后布局不对：${layoutA.problems.join('；')}`)
  dataStillThere(userData, marker, port, dataBefore)
  const footV1 = installFootprint(dir)
  step(
    `A 数据都在；安装目录 ${footV1.files} 个文件、${footV1.mb} MB（老版本 ${footOld.files} 个、${footOld.mb} MB）`,
  )
  summary.push(`迁移（平铺 ${fromVersion} → 版本目录 ${v1}，走安装程序）：${secA} 秒`)

  // ── B. 回滚演练：V1 → V2，V2 假装起不来 → 60 秒后切回 V1 ─────────────────────────
  await killInstalled(dir)
  feedDir = v2Dir
  const currentExe = join(dir, 'current', 'agentsws.exe')
  writeFileSync(join(userData, 'update-drill.json'), JSON.stringify({ break: v2 }))
  h = await launchInstalled(currentExe, userData, port, v1, step)
  const stageSec = await downloadUpdate(h.page, step)
  const staged = installLayout(dir)
  step(`B 下载 + 在旁边摆好 V2 用了 ${stageSec} 秒；版本目录：${staged.apps.join('、')}`)
  if (!staged.apps.includes(`app-${v2}`)) throw new Error(`B 没在旁边摆好 app-${v2}`)
  click = await clickInstall(h.app, h.page, step)
  const exitB = await Promise.race([click.exited, sleep(180_000).then(() => undefined)])
  void h.app.close().catch(() => undefined)
  if (exitB === undefined) throw new Error('B 180 秒旧版还没退（回滚没做完？）')
  step(`B 旧版（看门的那一个）在点了之后 ${Math.round((exitB.at - click.clicked) / 1000)} 秒退出`)
  await waitVersion(port, v1, 180, '回滚后的 V1')
  const secB = Math.round((Date.now() - click.clicked) / 1000)
  const layoutB = installLayout(dir)
  step(`B 回滚完成：从点「重启并更新」到 V1 重新健康 ${secB} 秒；current → ${layoutB.target}`)
  if (normalizeWinPath(layoutB.target ?? '') !== normalizeWinPath(join(dir, `app-${v1}`)))
    throw new Error('B 回滚后 current 没指回 V1')
  if (!logHas(userData, '回滚演练：这一版假装起不来'))
    throw new Error('B 日志里没有 V2 的演练记录（V2 没起过？）')
  if (!logHas(userData, '上次更新新版没起来')) throw new Error('B 重开的 V1 没认出回滚记录')
  if (existsSync(join(userData, 'update-drill.json'))) throw new Error('B 演练文件没被 V2 用掉')
  dataStillThere(userData, marker, port, dataBefore)
  summary.push(`回滚演练（${v2} 假装起不来）：${secB} 秒回到 ${v1}`)

  // ── C. 真更新：V1 → V2，只切换 ───────────────────────────────────────────────
  await killInstalled(dir)
  h = await launchInstalled(currentExe, userData, port, v1, step)
  step(`C 下载 + 准备用了 ${await downloadUpdate(h.page, step)} 秒（已摆好的不再解）`)
  const pendingFile = join(userData, 'update-pending.json')
  click = await clickInstall(h.app, h.page, step)
  let bootMs
  for (let i = 0; i < 240 && bootMs === undefined; i += 1) {
    if (!existsSync(pendingFile)) bootMs = Date.now() - click.clicked
    else await sleep(250)
  }
  await waitVersion(port, v2, 180, 'V2')
  const secC = (Date.now() - click.clicked) / 1000
  const exitC = await Promise.race([click.exited, sleep(60_000).then(() => undefined)])
  void h.app.close().catch(() => undefined)
  step(
    `C 只切换：从点「重启并更新」到新版桌面壳启动 ${bootMs === undefined ? '（没等到）' : `${(bootMs / 1000).toFixed(1)} 秒`}、` +
      `到新版服务健康 ${secC.toFixed(1)} 秒；旧版 ${exitC === undefined ? '60 秒内没退' : `在 ${((exitC.at - click.clicked) / 1000).toFixed(1)} 秒退出`}`,
  )
  if (exitC === undefined) throw new Error('C 新版起来了旧版还没退')
  const layoutC = checkVersionedLayout(dir, v2)
  for (const line of layoutC.lines) step(`C ${line}`)
  if (layoutC.problems.length > 0)
    throw new Error(`C 切换后布局不对：${layoutC.problems.join('；')}`)
  if (!layoutC.layout.apps.includes(`app-${v1}`)) throw new Error('C 上一版（V1）的目录没留着')
  dataStillThere(userData, marker, port, dataBefore)
  const reg = registeredVersion()
  step(`C 卸载登记里的版本：${reg || '（读不到）'}`)
  if (reg !== '' && reg !== v2) throw new Error(`C 卸载登记里的版本还是 ${reg}`)
  const second = spawnSync(currentExe, [], { timeout: 30_000 })
  step(`C 单实例：再起一次退出码 ${describeExit(second.status, second.signal)}`)
  if (second.status === null) throw new Error('C 第二个实例 30 秒没退出（单实例锁没生效？）')
  summary.push(
    `只切换（${v1} → ${v2}）：点了到新版桌面壳 ${bootMs === undefined ? '?' : (bootMs / 1000).toFixed(1)} 秒，到新版服务健康 ${secC.toFixed(1)} 秒`,
  )

  // ── 收拾 ────────────────────────────────────────────────────────────────
  await killInstalled(dir)
  copyDirSync(join(userData, 'logs'), join(out, 'logs'))
  writeFileSync(join(out, 'summary.txt'), `${summary.join('\n')}\n`)
  for (const line of summary) step(`小结：${line}`)
  feed.close()
  step('全部通过')
}

const self = fileURLToPath(import.meta.url).toLowerCase()
if (process.argv[1] !== undefined && resolve(process.argv[1]).toLowerCase() === self) {
  main().catch((err) => {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`✗ ${text}\n`)
    try {
      const out = resolve(arg('--out') ?? 'win-update')
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, 'error.txt'), `${text}\n`)
      // 失败也把日志带出来（N 或 N+1 写的都在默认用户数据目录里）
      const ud = join(process.env.APPDATA ?? tmpdir(), '@agentsws', 'desktop', 'logs')
      copyDirSync(ud, join(out, 'logs'))
    } catch {
      // 尽力而为
    }
    process.exitCode = 1
    setTimeout(() => process.exit(1), 2000).unref()
  })
}
