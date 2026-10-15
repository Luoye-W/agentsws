#!/usr/bin/env node
/**
 * WP345 实测（派工单「要实测并写进报告的两点」）：用**这台电脑上装的品牌版 Chrome**、一个临时用户目录，
 * 不碰你自己的 Chrome 配置。
 *
 * ① 新版插件多要了权限：插件文件夹整体换成多要三条权限的新版 → 插件自己 `chrome.runtime.reload()` →
 *    看它还开着没有（`developerPrivate.getExtensionInfo` 的 state / disableReasons）、新权限给没给上。
 * ② 开发者模式插件在 Chrome 启动时会不会弹提示：
 *    - 关掉 Chrome，**不带任何调试开关**重开同一个用户目录（就是用户平常双击打开的样子），再带调试管道开一次
 *      读插件还在不在、开着没有；
 *    - 查这一版 Chrome 自带的界面文字里还有没有老的「停用开发者模式扩展程序」那句（没有这句就弹不出来）；
 *    - 顺手：把开发者模式关掉，插件会怎样（这一版 Chrome 有「开发者模式关了，部分扩展被停用」这句）。
 *
 * 弹窗本身是浏览器自己的界面，调试协议看不到；这台电脑没给「录屏」权限，截不了屏——所以弹窗只能用上面
 * 两种间接证据说话，报告里照实写。
 *
 * 装插件只能走调试协议的 `Extensions.loadUnpacked`（Chrome 137 起品牌版不认 `--load-extension`），
 * 开发者模式用 chrome://extensions 页面自己的 `developerPrivate` 开关（与人点右上角开关同一个调用）。
 *
 * 用法：node scripts/probe-ext-chrome.mjs [--chrome <可执行文件>] [--keep]
 * 先 `pnpm -F @agentsws/extension build`。结果是一份 JSON（标准输出）。
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChrome } from './lib/cdp-pipe.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(n)
  return i < 0 ? undefined : args[i + 1]
}
const CHROME =
  opt('--chrome') ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? join(
          process.env.PROGRAMFILES ?? 'C:\\Program Files',
          'Google/Chrome/Application/chrome.exe',
        )
      : '/usr/bin/google-chrome')
const BUILD = join(ROOT, 'apps/extension/build/chrome-mv3')
if (!existsSync(join(BUILD, 'manifest.json'))) {
  console.error('先 pnpm -F @agentsws/extension build')
  process.exit(2)
}
if (!existsSync(CHROME)) {
  console.error(`没找到 Chrome：${CHROME}`)
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'agentsws-wp345-probe-'))
const profile = join(work, 'profile')
const extDir = join(work, 'chrome-extension')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const result = { chrome: '', platform: process.platform }
const step = (name) => process.stderr.write(`· ${name}\n`)

/** 与工坊里一样的整体换：新版先写在旁边，旧的挪开、新的挪进来。 */
function writeVersion(version, extraPermissions = [], extraHosts = []) {
  const next = join(work, `chrome-extension.next-${version}`)
  cpSync(BUILD, next, { recursive: true })
  const m = JSON.parse(readFileSync(join(next, 'manifest.json'), 'utf8'))
  m.version = version
  m.version_name = `${version}-probe`
  m.permissions = [...m.permissions, ...extraPermissions]
  m.host_permissions = [...m.host_permissions, ...extraHosts]
  writeFileSync(join(next, 'manifest.json'), JSON.stringify(m))
  if (existsSync(extDir)) renameSync(extDir, `${extDir}.old-${version}`)
  renameSync(next, extDir)
}

/** 这一版 Chrome 的英文界面文字里有没有某几句（老的开发者模式气泡 / 新的「关了就停用」）。 */
function uiStrings() {
  const candidates =
    process.platform === 'darwin'
      ? [
          join(
            dirname(dirname(CHROME)),
            'Frameworks/Google Chrome Framework.framework/Versions/Current/Resources/en.lproj/locale.pak',
          ),
        ]
      : []
  if (process.platform === 'win32') {
    const appDir = dirname(CHROME)
    let entries = []
    try {
      entries = readdirSync(appDir)
    } catch {}
    for (const v of entries) candidates.push(join(appDir, v, 'Locales', 'en-US.pak'))
  }
  const pak = candidates.find((p) => existsSync(p))
  if (pak === undefined) return { checked: false, why: '没找到英文界面文字包' }
  const text = readFileSync(pak).toString('utf8')
  const has = (s) => text.includes(s)
  return {
    checked: true,
    old_startup_bubble: has('Disable developer mode extensions'),
    turn_on_developer_mode_to_use: has('Turn on developer mode to use this extension'),
    developer_mode_off_disables: has('Developer Mode Off. Some extensions were disabled.'),
  }
}

/** 在 chrome://extensions 页面里调 developerPrivate（与人在那一页上点的同一套）。 */
async function extensionsPage(c) {
  const { targetId } = await c.send('Target.createTarget', { url: 'chrome://extensions' })
  await sleep(1500)
  return { targetId, run: (expr) => c.evaluate(targetId, expr) }
}

const infoExpr = (id) =>
  `new Promise((r) => chrome.developerPrivate.getExtensionInfo(${JSON.stringify(id)}, (i) => r(i && {
     state: i.state, version: i.version, location: i.location,
     disabled_because: Object.entries(i.disableReasons ?? {}).filter(([, v]) => v).map(([k]) => k),
     warnings: (i.permissions?.simplePermissions ?? []).map((p) => p.message),
   })))`
const setDevMode = (on) =>
  `new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: ${on} }, r))`

const swOf = async (c, id) =>
  (await c.targets()).find(
    (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`),
  )

let code = 0
try {
  result.ui_strings = uiStrings()

  step('装 1.0.0')
  // ── 装 1.0.0（开发者模式 + 加载已解压）
  writeVersion('1.0.0')
  let c = await launchChrome({
    executable: CHROME,
    userDataDir: profile,
    args: ['--enable-unsafe-extension-debugging'],
  })
  result.chrome = (await c.send('Browser.getVersion')).product
  let page = await extensionsPage(c)
  await page.run(setDevMode(true))
  const { id } = await c.send('Extensions.loadUnpacked', { path: extDir })
  result.extension_id = id
  await sleep(1500)
  result.installed = await page.run(infoExpr(id))

  step('换 1.0.1 并重载')
  // ── ① 换成多要权限的 1.0.1，插件自己 reload
  writeVersion('1.0.1', ['tabs', 'bookmarks', 'history'], ['https://*.example.com/*'])
  const sw = await swOf(c, id)
  if (sw !== undefined)
    await c.evaluate(sw.targetId, 'setTimeout(() => chrome.runtime.reload(), 50); true')
  await sleep(4000)
  result.after_reload_with_more_permissions = await page.run(infoExpr(id))
  const sw2 = await swOf(c, id)
  result.service_worker_running_after_reload = sw2 !== undefined
  if (sw2 !== undefined)
    result.granted_after_reload = await c.evaluate(
      sw2.targetId,
      'chrome.permissions.getAll().then((p) => ({ permissions: p.permissions, origins: p.origins, version_name: chrome.runtime.getManifest().version_name }))',
    )

  step('打开扩展页')
  // ── 连接卡「打开 Chrome 扩展页」的做法：直接起 Chrome 可执行文件带 chrome://extensions。
  //    Chrome 已经开着（同一个用户目录）时，新起的进程把网址交给开着的那个就退出——看开着的那个多没多一页扩展页
  //    扩展页在 Chrome 里只开一个（再开就切过去），所以先把我们自己开的那一页关掉
  await c.send('Target.closeTarget', { targetId: page.targetId })
  await sleep(500)
  const pages = async () => (await c.targets()).filter((t) => t.type === 'page').map((t) => t.url)
  const before = await pages()
  const handoff = await launchChrome({
    executable: CHROME,
    userDataDir: profile,
    pipe: false,
    url: 'chrome://extensions',
  })
  const handoffExit = await Promise.race([
    handoff.exited,
    sleep(10_000).then(() => 'still-running'),
  ])
  await sleep(1500)
  const after = await pages()
  const added = after.filter((u, i) => after.indexOf(u) === i && !before.includes(u))
  result.open_extensions_page_when_running = {
    handed_over_and_exited: handoffExit !== 'still-running',
    pages_added:
      added.length > 0 ? added : after.length > before.length ? ['（多了一页，同名）'] : [],
    opened_extensions_page: after.some((u) => u.startsWith('chrome://extensions')),
  }
  if (handoffExit === 'still-running') await handoff.close()
  await c.close()

  step('关着时换 1.0.2')
  // ── Chrome 关着时工坊换了新版：下次打开直接读新文件
  writeVersion('1.0.2')

  step('不带调试开关重开')
  // ── ② 不带任何调试开关重开同一个用户目录（用户平常打开 Chrome 的样子），开 8 秒、正常关
  const plain = await launchChrome({ executable: CHROME, userDataDir: profile, pipe: false })
  await sleep(8000)
  await plain.close()
  await sleep(1500)
  step('带管道再开')
  // 再带管道开一次：插件还在不在、开着没有、开发者模式还开着没有
  c = await launchChrome({ executable: CHROME, userDataDir: profile })
  page = await extensionsPage(c)
  // 关着时换成的 1.0.2 应该直接生效
  result.after_restart = await page.run(infoExpr(id))
  result.developer_mode_after_restart = await page.run(
    'new Promise((r) => chrome.developerPrivate.getProfileConfiguration((p) => r(p.inDeveloperMode)))',
  )
  // 顺手：开发者模式关掉会怎样、再打开能不能自己回来
  await page.run(setDevMode(false))
  await sleep(1500)
  result.developer_mode_turned_off = await page.run(infoExpr(id))
  await page.run(setDevMode(true))
  await sleep(1500)
  result.developer_mode_turned_back_on = await page.run(infoExpr(id))
  await c.close()
} catch (err) {
  console.error(err)
  result.error = String(err)
  code = 2
} finally {
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true })
  else result.work = work
}
console.log(JSON.stringify(result, null, 1))
process.exit(code)
