#!/usr/bin/env node
/**
 * WP225（WP218 遗留）：**两个真实版本之间点一次「更新」**，在 CI 的 windows-latest 上跑。
 *
 *   本机起一个更新源（http://127.0.0.1:<端口>/<渠道>/，只喂 N+1 的 latest.yml / 安装包 / blockmap）
 *   → 静默装 N（装到带中文和空格的目录）→ 用**默认的**用户数据目录起 N（真用户就是这样；
 *     更新后安装程序重开的那一个拿不到我们给的环境变量）→ 等左下角那颗按钮的状态变「有新版」
 *   → 点「下载」→ 等「重启并更新」→ 点它 → N 自己退出、安装程序静默装 N+1、自动重开
 *   → 新版本起来（/v1/health 报的版本 = N+1、安装目录里的 package.json 也是 N+1）
 *   → 数据还在（N 跑着时放的记号文件、config.json、服务进程的数据目录都在）
 *
 * 装 N 的那个包打包时把更新源指到了这个本机端口（`AGENTSWS_UPDATE_BASE_URL=http://127.0.0.1:<端口>`，
 * 回环 http 只为这个测试放行，见 src/update-feed.ts）。
 *
 * 用法：node apps/desktop/scripts/win-update-e2e.mjs --old <N 的 Setup.exe> --new-dir <N+1 的 release 目录>
 *        --port <端口> --out <目录>
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
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
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  describeExit,
  dirAliases,
  freePort,
  normalizeWinPath,
  processesUnder,
  processTable,
  reporter,
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

function arg(name) {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}

/** 本机更新源：记下每一次请求（报告里看得见「真的下了 N+1」）。 */
function startFeed(dir, port, log) {
  const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile())
  const server = createServer((req, res) => {
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

/** 在工作台页面里读 / 点左下角那颗按钮背后的桥（`window.agentsws.update`）。 */
async function waitUpdate(page, want, seconds, step) {
  let last
  for (let i = 0; i < seconds; i += 1) {
    const s = await page.evaluate(() => window.agentsws?.update?.status())
    const text = JSON.stringify(s)
    if (text !== last) step(`更新状态：${text}`)
    last = text
    if (s?.state === 'error') throw new Error(`更新出错：${text}`)
    if (want.includes(s?.state)) return s
    await sleep(1000)
  }
  throw new Error(`${seconds} 秒内没等到 ${want.join(' / ')}（最后是 ${last}）`)
}

async function healthVersion(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`)
    if (!res.ok) return undefined
    const body = await res.json()
    return body?.data?.version ?? body?.version
  } catch {
    return undefined
  }
}

async function main() {
  const oldInstaller = arg('--old')
  const newDir = resolve(arg('--new-dir') ?? '')
  const feedPort = Number(arg('--port'))
  const out = resolve(arg('--out') ?? 'win-update')
  if (process.platform !== 'win32') throw new Error('这个脚本只在 Windows 上跑')
  if (oldInstaller === undefined || !existsSync(oldInstaller))
    throw new Error(`没有 N：${oldInstaller}`)
  const step = reporter(out)
  const toVersion = versionOfLatestYml(readFileSync(join(newDir, 'latest.yml'), 'utf8'))
  if (toVersion === undefined) throw new Error(`${newDir}\\latest.yml 里没有 version`)

  const feed = await startFeed(newDir, feedPort, step)
  step(`本机更新源起来了：http://127.0.0.1:${feedPort}/（喂 ${toVersion}）`)

  // 1. 静默装 N
  const local = process.env.LOCALAPPDATA ?? tmpdir()
  const dir = join(local, 'Programs', '智能体 工坊 更新测试')
  const exe = silentInstall(oldInstaller, dir)
  const pkgOf = () =>
    JSON.parse(readFileSync(join(dir, 'resources', 'app', 'package.json'), 'utf8'))
  const fromVersion = pkgOf().version
  step(`装好了 N=${fromVersion}：${exe}`)

  // 2. 默认用户数据目录里放配置与记号（端口随机；GitHub 备用源关掉，只认本机这一个源）
  const userData = defaultUserData(process.env.APPDATA ?? tmpdir(), pkgOf().name)
  mkdirSync(userData, { recursive: true })
  const port = await freePort()
  const config = {
    port,
    openInBrowser: false,
    launchAtLogin: false,
    language: 'zh-CN',
    updateGithubFallback: false,
  }
  writeFileSync(join(userData, 'config.json'), JSON.stringify(config))
  const marker = join(userData, 'wp225-e2e-marker.txt')
  writeFileSync(marker, `N=${fromVersion}\n`)

  // 3. 起 N（不给用户数据目录的环境变量：更新后重开的那一个也拿不到）
  const { _electron: electron } = await import('@playwright/test')
  const app = await electron.launch({ executablePath: exe, timeout: 120_000 })
  const actualUserData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  if (normalizeWinPath(actualUserData) !== normalizeWinPath(userData))
    throw new Error(`默认用户数据目录不是 ${userData}，而是 ${actualUserData}`)
  step(`N 起来了，用户数据目录：${actualUserData}`)
  await waitHealthy(app)
  const v1 = await healthVersion(port)
  step(`N 的服务健康，版本 ${v1}`)
  if (v1 !== fromVersion) throw new Error(`服务报的版本 ${v1} ≠ N ${fromVersion}`)
  const dataBefore = readdirSync(join(userData, 'data'))
  step(`服务进程数据目录里有：${dataBefore.join('、')}`)

  // 4. 工作台里那颗按钮：等「有新版」→ 下载 → 等「重启并更新」→ 点
  await app.evaluate((_e, p) => globalThis.__agentsws__?.openWorkstation(p), '/')
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.agentsws?.update !== undefined, null, { timeout: 60_000 })
  await waitUpdate(page, ['available'], 180, step)
  await page.evaluate(() => window.agentsws.update.download())
  await waitUpdate(page, ['ready'], 600, step)
  const proc = app.process()
  const exited = new Promise((r) => proc.once('exit', (code) => r(code)))
  const outcome = await page
    .evaluate(() => window.agentsws.update.install())
    .catch((e) => `（连接断开：${e.message.split('\n')[0]}）`)
  step(`点了「重启并更新」：${outcome}`)
  const code = await Promise.race([exited, sleep(90_000).then(() => 'timeout')])
  step(`N 退出：${code === 'timeout' ? '90 秒没退' : `退出码 ${describeExit(code, null)}`}`)
  await app.close().catch(() => undefined)
  if (code === 'timeout') throw new Error('点了「重启并更新」90 秒 N 还没退')

  // 5. 安装程序静默装 N+1、自动重开：等服务报 N+1
  let v2
  for (let i = 0; i < 300 && v2 !== toVersion; i += 1) {
    v2 = await healthVersion(port)
    if (v2 !== toVersion) await sleep(1000)
  }
  if (v2 !== toVersion) throw new Error(`5 分钟内新版本没起来（服务报 ${v2 ?? '连不上'}）`)
  step(`新版本起来了：服务报 ${v2}`)
  if (pkgOf().version !== toVersion)
    throw new Error(`安装目录里的版本是 ${pkgOf().version}，不是 ${toVersion}`)
  step(`安装目录里也是 ${toVersion}`)

  // 6. 数据还在
  if (!existsSync(marker)) throw new Error('更新之后 N 时放的记号文件没了')
  const cfg = JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8'))
  if (cfg.port !== port) throw new Error('更新之后 config.json 被换掉了')
  const dataAfter = readdirSync(join(userData, 'data'))
  const lost = dataBefore.filter((f) => !dataAfter.includes(f))
  if (lost.length > 0) throw new Error(`更新之后数据目录少了：${lost.join('、')}`)
  step('数据还在：记号文件、config.json、服务进程数据目录都在')

  // 7. 收拾：新版本是安装程序起的（没有 Playwright 的把手），按目录结束进程
  for (const p of processesUnder(processTable(), dirAliases(dir)))
    spawnSync('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'])
  cpSync(join(userData, 'logs'), join(out, 'logs'), { recursive: true, force: true })
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
      if (existsSync(ud)) cpSync(ud, join(out, 'logs'), { recursive: true, force: true })
    } catch {
      // 尽力而为
    }
    process.exitCode = 1
    setTimeout(() => process.exit(1), 2000).unref()
  })
}
