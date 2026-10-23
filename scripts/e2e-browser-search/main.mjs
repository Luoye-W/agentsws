/**
 * WP353 真机端到端的 Electron 主进程（由 `scripts/e2e-browser-search.mjs` 起，临时用户数据目录）。
 *
 * 用的就是桌面壳里那一份代码：`apps/desktop/dist/search-browser-electron.js`（隐藏 WebContentsView、
 * 每品牌持久 partition、UA 去掉 Electron、不开调试口、isolatedWorld 只读 DOM 提取）+ 本机通道
 * `search-browser.js`；服务进程那一半是 `apps/server/dist/web-browser`（回退链、语言、节流、认拦截）。
 * 两边经真的本机通道（127.0.0.1 + 随机口令）说话——与桌面壳 → sidecar 同一条路，只是不起整个工坊。
 *
 * 只搜几条、只读结果页；被拦就照实记下（不点、不绕）。跑完退出，用户数据目录由外面那个脚本删。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app } from 'electron'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = process.env.WP353_OUT
const queries = JSON.parse(process.env.WP353_QUERIES ?? '[]')
// WP454：给了就落盘（每个品牌一个目录，`web-search.json` 里有每一步的留痕）；被拦就停；不读正文
const stateDir = process.env.WP353_STATE_DIR
const stopOnBlock = process.env.WP353_STOP_ON_BLOCK === '1'
const noFetch = process.env.WP353_NO_FETCH === '1'
app.setPath('userData', process.env.WP353_USER_DATA)
app.disableHardwareAcceleration()
// WP484：读页用的离屏窗口读完就关——没有别的窗口时 Electron 默认「窗口全关 = 退出」，这里像桌面壳一样不退
app.on('window-all-closed', () => {})

const imp = (p) => import(pathToFileURL(join(ROOT, p)).href)

app.whenReady().then(async () => {
  const { createElectronSearchBrowser } = await imp('apps/desktop/dist/search-browser-electron.js')
  const { startSearchBrowserChannel, newChannelToken } = await imp(
    'apps/desktop/dist/search-browser.js',
  )
  const web = await imp('apps/server/dist/web-browser/index.js')
  const log = []
  const driver = createElectronSearchBrowser({
    mainWindow: () => undefined,
    onChange: (h) => log.push({ handover: h ?? null }),
    log: (m, f) => log.push({ m, ...(f ?? {}) }),
  })
  const token = newChannelToken()
  const ch = await startSearchBrowserChannel({ driver, token })
  const channel = web.searchBrowserChannelFromEnv({
    AGENTSWS_SEARCH_BROWSER_URL: ch.url,
    AGENTSWS_SEARCH_BROWSER_TOKEN: token,
  })
  const throttle = web.createSearchThrottle({
    now: () => Date.now(),
    random: Math.random,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  })
  // 兜底那一路：公开搜索服务（社区插件的两家免 key 匿名口；不读环境变量）
  const { keylessWebSearch } = await imp('packages/dsh-adapter/dist/keyless-search.js')
  const keyless = keylessWebSearch()
  // 每个品牌一份（暂停 / 缓存跟品牌走——被拦一次之后同一品牌不再去碰 Google）
  const brands = new Map()
  const brandSearch = (q) => {
    let s = brands.get(q.brand)
    if (s === undefined) {
      s = web.createBrowserWebSearch({
        workspace_id: q.brand,
        ...(stateDir === undefined ? {} : { dir: join(stateDir, q.brand) }),
        channel,
        throttle,
        profile: () => ({ markets: q.markets }),
        keyless: () => keyless,
        now: () => Date.now(),
        log: (line) => log.push({ line }),
      })
      brands.set(q.brand, s)
    }
    return s
  }
  const results = []
  const stateOf = (brand) => {
    const f = stateDir === undefined ? undefined : join(stateDir, brand, 'web-search.json')
    return f !== undefined && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined
  }
  for (const q of queries) {
    const search = brandSearch(q)
    const t = Date.now()
    try {
      const r = await search.search(q.query, 10)
      results.push({
        query: q.query,
        markets: q.markets,
        locale: r.locale,
        via: r.via ?? null,
        content: r.content,
        ms: Date.now() - t,
        sources: r.sources.map((s) => ({ url: s.url, title: s.title ?? '' })),
      })
    } catch (err) {
      results.push({
        query: q.query,
        markets: q.markets,
        error: String(err?.message ?? err),
        ms: Date.now() - t,
      })
    }
    if (stopOnBlock) {
      const last = stateOf(q.brand)?.trace?.at(-1)
      if (last?.steps.some((s) => s.via.startsWith('google') && s.result === 'blocked')) {
        results.push({ stopped: 'Google 出了人机验证：记下、停（不点、不绕）' })
        break
      }
    }
  }
  // 读正文一页（Reddit 走内置浏览器）
  let fetched
  const firstReddit = results
    .flatMap((r) => r.sources ?? [])
    .find((s) => /reddit\.com\/r\/.+\/comments\//.test(s.url))
  if (firstReddit !== undefined && !noFetch) {
    const search = brandSearch({ brand: 'brand_us', markets: ['US'] })
    try {
      const page = await search.fetch(firstReddit.url)
      fetched = {
        url: page.url,
        status: page.statusCode,
        chars: page.body.content.length,
        head: page.body.content.slice(0, 200),
      }
    } catch (err) {
      fetched = { url: firstReddit.url, error: String(err?.message ?? err) }
    }
  }
  writeFileSync(
    out,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        electron: process.versions.electron,
        results,
        fetched,
        log,
        state: Object.fromEntries([...brands.keys()].map((b) => [b, stateOf(b)])),
      },
      null,
      2,
    ),
  )
  driver.close()
  await ch.close()
  app.quit()
})
