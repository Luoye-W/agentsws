#!/usr/bin/env node
/**
 * WP482：数据库与大文件分开放——**真服务进程**上把两格分别搬一遍 + 截图，可重跑。全部在临时目录（路径带中文和空格），
 * 不碰本机的应用数据目录、不碰 4317。
 *
 * 1. 起服务进程（「应用 数据/data」，大文件默认在 data/blobs），建一条待办、往知识库传一个文件（进大文件）；
 * 2. **只搬大文件**到「NAS 盘/工坊 大文件」（桌面壳同一套 `runDataMove`，kind = blobs，服务进程经
 *    `AGENTSWS_BLOB_DIR` 指过去）：不做备份、数据库目录不动、指针记 blob_dir、旧的 blobs 改名留 7 天；文件拉得回来；
 * 3. **大文件位置断开**（把 NAS 那个目录挪走 = 拔盘 / 断网）后重起服务进程：照常起来、待办照常、
 *    `GET /v1/storage` 说连不上、拉那个文件回 503 + 位置；目录放回来，同一个进程「再试一次」就通了；
 * 4. **只搬数据库**到「新 盘」：大文件仍在 NAS 上、留着的旧 blobs 不跟着搬、两边都还在；
 * 5. **大文件恢复默认位置**：搬回新数据库目录下的 blobs，指针里不再记 blob_dir；
 * 6. 截图（浅 / 深）：设置 → 数据与隐私两格（假桥只管界面；真搬家上面已经走过）、
 *    大文件确认框（网络盘只说附件打不开）、数据库确认框（1647 那半句 + 大文件会一起搬）、大文件搬家进度、搬完、
 *    大文件那一格连不上；会议页上传录音时大文件位置连不上（真服务进程回的那句 + 再试一次）。
 *
 * ```
 * pnpm exec tsc -b apps/server apps/desktop && pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp482-shots.mjs [--port 4904] [--out <目录>]
 * ```
 * 审稿截图放私有仓，别提交进公开仓。不通过就退出码 1。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'out/wp482'))
const PORT = Number(argOf('--port') ?? '4904') || 4904
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'owner@localhost'

const { runDataMove } = await import(join(ROOT, 'apps/desktop/dist/data-move.js'))
const {
  checkTarget,
  checkDefaultBlobTarget,
  readPointer,
  latestRetired,
  retiredInside,
  defaultBlobDir,
  currentBlobDir,
  RETIRED_MARK,
} = await import(join(ROOT, 'apps/desktop/dist/data-location.js'))

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 服务进程（只停自己起的这一个 PID）──────────────────────────────────
let child
/** 与桌面壳同一个规矩：大文件单独放了才给 `AGENTSWS_BLOB_DIR`。 */
function startServer(dataDir, blobDir) {
  child = spawn(process.execPath, [join(ROOT, 'apps/server/dist/index.js')], {
    env: {
      ...process.env,
      AGENTSWS_PORT: String(PORT),
      AGENTSWS_DATA_DIR: dataDir,
      ...(blobDir === undefined ? {} : { AGENTSWS_BLOB_DIR: blobDir }),
      AGENTSWS_STATIC_DIR: join(ROOT, 'apps/workstation/dist'),
      AGENTSWS_STOP_ON_STDIN_END: '1',
      AGENTSWS_TELEMETRY_HOST: 'off',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  return child
}
async function stopServer() {
  const c = child
  if (c === undefined || c.exitCode !== null) return
  const gone = new Promise((r) => c.once('exit', r))
  c.stdin.end()
  const t = setTimeout(() => c.kill('SIGTERM'), 15_000)
  await gone
  clearTimeout(t)
}
async function healthy(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) return false
    const ok = await fetch(`${BASE}/v1/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) return true
    await sleep(400)
  }
  return false
}

async function login() {
  const post = async (path, body) =>
    (
      await (
        await fetch(`${BASE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()
    ).data
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  const token = (await post('/v1/auth/verify', { token: link.token })).session_token
  const me = (
    await (await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).json()
  ).data
  return { token, assignment: me.assignments[0]?.id }
}
async function raw(auth, method, path, body) {
  const isForm = body instanceof FormData
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${auth.token}`,
      'x-assignment': auth.assignment,
    },
    ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
  })
}
async function api(auth, method, path, body) {
  const res = await raw(auth, method, path, body)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.message ?? json.error?.message ?? `HTTP ${res.status}`)
  return json.data
}

/** 桌面壳那一套，接到这个真服务进程上。 */
function moveDeps({ kind, userData, from, to, auth, start, copyOptions }) {
  const statuses = []
  return {
    statuses,
    deps: {
      userData,
      ...(kind === 'blobs' ? { kind } : {}),
      from,
      to,
      now: () => new Date().toISOString(),
      pause: async () => {
        await api(auth, 'POST', '/v1/update/pause', { to: 'data-move' })
      },
      resume: async () => {
        await api(auth, 'POST', '/v1/update/resume', {})
      },
      ...(kind === 'blobs'
        ? {}
        : {
            backup: async () => {
              const out = await api(auth, 'POST', '/v1/backup/export', {})
              console.log(`     备份：${out.out}`)
            },
          }),
      stopServices: stopServer,
      startServices: async (dir) => {
        start(dir)
      },
      waitHealthy: () => healthy(),
      onStatus: (s) => statuses.push(s),
      log: (m, f) => console.log(`     · ${m}${f === undefined ? '' : ` ${JSON.stringify(f)}`}`),
      ...(copyOptions === undefined ? {} : { copyOptions }),
    },
  }
}

function uploadForm(name, text) {
  const fd = new FormData()
  fd.set('file', new Blob([new TextEncoder().encode(text)]), name)
  return fd
}

// ── 截图用的假桥（只管界面；真搬家上面已经走过） ─────────────────────
const WIN_DEFAULT = 'C:\\Users\\admin\\AppData\\Roaming\\@agentsws\\desktop\\data'
const WIN_NAS = 'Z:\\工坊 大文件'
function fakeBridgeScript() {
  return ({ winDefault }) => {
    const GB = 1024 ** 3
    const state = {
      listeners: [],
      view: {
        path: winDefault,
        is_default: true,
        default_path: winDefault,
        bytes: 0.31 * GB,
        files: 412,
        status: { state: 'idle' },
        blobs: {
          path: `${winDefault}\\blobs`,
          is_default: true,
          default_path: `${winDefault}\\blobs`,
          bytes: 18.6 * GB,
          files: 23_408,
          reachable: true,
        },
      },
      next: null,
    }
    window.__wp482 = {
      state,
      emit: (s) => {
        for (const l of state.listeners) l(s)
      },
      setView: (v) => {
        state.view = { ...state.view, ...v }
      },
      setBlobs: (b) => {
        state.view = { ...state.view, blobs: { ...state.view.blobs, ...b } }
      },
      setNext: (c) => {
        state.next = c
      },
    }
    window.agentsws = {
      platform: 'win32',
      version: '0.2.1-beta.12',
      notify: async () => false,
      openExternal: async () => false,
      dataLocation: {
        get: async () => state.view,
        choose: async () => state.next,
        checkDefault: async (which) => ({
          ok: true,
          chosen: which === 'blobs' ? state.view.blobs.default_path : winDefault,
          target: which === 'blobs' ? state.view.blobs.default_path : winDefault,
          bytes: which === 'blobs' ? state.view.blobs.bytes : state.view.bytes,
          files: which === 'blobs' ? state.view.blobs.files : state.view.files,
          estimate_seconds: 50,
          problems: [],
          warnings: [],
          ...(which === 'blobs' ? { kind: 'blobs' } : {}),
        }),
        move: async (_to, which) => ({
          state: 'running',
          ...(which === 'blobs' ? { which } : {}),
          step: 'pause',
          to: 'Z:\\工坊 大文件',
          copied_bytes: 0,
          total_bytes: 0,
          files_done: 0,
          files_total: 0,
          started_at: new Date().toISOString(),
        }),
        onChange: (l) => {
          state.listeners.push(l)
          return () => {
            state.listeners = state.listeners.filter((x) => x !== l)
          }
        },
        deleteOld: async () => true,
        reveal: async () => true,
      },
    }
  }
}

async function go(page, path) {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await page.waitForTimeout(800)
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const base = mkdtempSync(join(tmpdir(), 'wp482-e2e-'))
  const userData = join(base, '应用 数据')
  let dataDir = join(userData, 'data')
  mkdirSync(dataDir, { recursive: true })
  /** 现在给服务进程的大文件位置（undefined = 跟着数据库）。 */
  let blobDir
  const start = (d, b) => startServer(d, b)
  try {
    // ── 1. 起服务、建一条待办、传一个文件
    console.log('── 1. 起服务进程，建待办、传文件')
    start(dataDir, blobDir)
    check(await healthy(), `服务进程起来了（${BASE}，数据在「${dataDir}」）`)
    let auth = await login()
    await api(auth, 'POST', '/v1/todos', { title: 'WP482 分开放之前记下的一件事' })
    const hasTodo = async () =>
      JSON.stringify((await api(auth, 'GET', '/v1/todos')) ?? '').includes('WP482 分开放之前')
    const src = await api(
      auth,
      'POST',
      '/v1/knowledge/sources/upload',
      uploadForm('会议 纪要.txt', '这份放在大文件里'),
    )
    const fileBack = async () => {
      const res = await raw(auth, 'GET', `/v1/knowledge/sources/${src.id}/file`)
      return { status: res.status, body: res.ok ? await res.text() : await res.json() }
    }
    check(existsSync(join(dataDir, 'blobs')), '大文件默认在数据目录的 blobs 里')
    check((await fileBack()).body === '这份放在大文件里', '传的文件拉得回来')

    // ── 2. 只搬大文件
    console.log('── 2. 只搬大文件到「NAS 盘/工坊 大文件」')
    const nas = join(base, 'NAS 盘', '工坊 大文件')
    mkdirSync(nas, { recursive: true })
    const dbFilesBefore = readdirSync(dataDir).filter((n) => n !== 'blobs')
    const blobCheck = checkTarget({
      chosen: nas,
      current: join(dataDir, 'blobs'),
      userData,
      systemDirs: [],
      kind: 'blobs',
      other: dataDir,
      network: true,
    })
    check(
      blobCheck.ok && blobCheck.target === nas && blobCheck.warnings.join() === 'network',
      `检查通过：放进 ${blobCheck.target}（网络盘只提示，不提网盘同步）`,
    )
    let move = moveDeps({
      kind: 'blobs',
      userData,
      from: join(dataDir, 'blobs'),
      to: nas,
      auth,
      start: (dir) => {
        blobDir = dir === defaultBlobDir(dataDir) ? undefined : dir
        start(dataDir, blobDir)
      },
    })
    let result = await runDataMove(move.deps)
    check(result.state === 'done' && result.which === 'blobs', '大文件搬完了')
    const steps = [
      ...new Set(move.statuses.filter((s) => s.state === 'running').map((s) => s.step)),
    ]
    check(!steps.includes('backup'), `只搬大文件不做备份：${steps.join(' → ')}`)
    check(readPointer(userData).blob_dir === nas, '指针记了 blob_dir')
    check(readPointer(userData).dir === undefined, '数据库还在默认位置')
    const oldBlobs = latestRetired(userData, 'blobs')
    check(
      oldBlobs !== undefined &&
        existsSync(join(oldBlobs.path, RETIRED_MARK)) &&
        !existsSync(join(dataDir, 'blobs')),
      `旧的 blobs 改名留着（${oldBlobs?.path}）`,
    )
    check(
      dbFilesBefore.every((n) => existsSync(join(dataDir, n))),
      '数据库目录里的东西一个没少',
    )
    auth = await login()
    check(await hasTodo(), '搬完：待办还在')
    const back = await fileBack()
    check(back.body === '这份放在大文件里', '搬完：文件从 NAS 拉得回来')

    // ── 3. 大文件位置断开：工坊照常开，用到时说连不上；接好就通
    console.log('── 3. 大文件位置断开（拔盘 / 断网）')
    await stopServer()
    const unplugged = `${nas}（拔掉了）`
    renameSync(nas, unplugged)
    start(dataDir, blobDir)
    check(await healthy(), '大文件位置连不上：服务进程照常起来')
    auth = await login()
    check(await hasTodo(), '大文件位置连不上：待办照常')
    check(!existsSync(nas), '没有替它建一个空目录')
    const storage = await api(auth, 'GET', '/v1/storage')
    check(storage.blobs.reachable === false, `GET /v1/storage 说连不上（${storage.blobs.display}）`)
    const gone = await fileBack()
    check(
      gone.status === 503 &&
        gone.body.details?.reason === 'blob_location_unreachable' &&
        String(gone.body.message).includes('大文件存放的位置现在连不上'),
      `拉文件：503 +「${gone.body.message}」`,
    )
    // 会议页截图要用：建一场会（等会儿上传录音时撞上「连不上」）
    const meeting = await api(auth, 'POST', '/v1/meetings', {
      title: '周会（大文件位置连不上）',
      start: new Date().toISOString(),
      end: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const meetingShots = await shoot({ auth, meetingId: meeting.id ?? meeting.meeting?.id })
    renameSync(unplugged, nas)
    const again = await fileBack()
    check(
      again.status === 200 && again.body === '这份放在大文件里',
      '接好了：同一个进程再试一次就通了',
    )
    check(meetingShots, '截图走完')

    // ── 4. 只搬数据库
    console.log('── 4. 只搬数据库到「新 盘」')
    mkdirSync(join(base, '新 盘'), { recursive: true })
    const dbCheck = checkTarget({
      chosen: join(base, '新 盘'),
      current: dataDir,
      userData,
      systemDirs: [],
      other: nas,
    })
    const newDb = dbCheck.target
    check(dbCheck.ok && !dbCheck.warnings.includes('network'), `数据库那一格的检查（${newDb}）`)
    const intoNas = checkTarget({
      chosen: nas,
      current: dataDir,
      userData,
      systemDirs: [],
      other: nas,
    })
    check(!intoNas.ok, `数据库不许放进大文件目录（${intoNas.problems.join(', ')}）`)
    move = moveDeps({
      userData,
      from: dataDir,
      to: newDb,
      auth,
      start: (dir) => {
        dataDir = dir
        start(dataDir, blobDir)
      },
      copyOptions: { skip: retiredInside(userData, dataDir) },
    })
    result = await runDataMove(move.deps)
    check(result.state === 'done', '数据库搬完了')
    check(readPointer(userData).dir === newDb, '指针：数据库指到新盘')
    check(currentBlobDir(userData) === nas, '大文件仍在 NAS 上')
    check(
      !readdirSync(newDb).some((n) => n.startsWith('blobs')),
      '新数据库目录里没有大文件、也没有留着的旧 blobs',
    )
    auth = await login()
    check(await hasTodo(), '数据库搬完：待办还在')
    check((await fileBack()).body === '这份放在大文件里', '数据库搬完：文件还拉得回来')

    // ── 5. 大文件恢复默认位置
    console.log('── 5. 大文件恢复默认位置')
    const def = checkDefaultBlobTarget({ userData, current: nas, dataDir })
    check(def.ok && def.target === join(newDb, 'blobs'), `恢复默认位置的检查（${def.target}）`)
    move = moveDeps({
      kind: 'blobs',
      userData,
      from: nas,
      to: def.target,
      auth,
      start: (dir) => {
        blobDir = dir === defaultBlobDir(dataDir) ? undefined : dir
        start(dataDir, blobDir)
      },
    })
    result = await runDataMove(move.deps)
    check(result.state === 'done', '大文件搬回默认位置')
    check(readPointer(userData).blob_dir === undefined, '指针里不再记 blob_dir')
    auth = await login()
    check((await fileBack()).body === '这份放在大文件里', '搬回来：文件还拉得回来')
  } finally {
    await stopServer()
    rmSync(base, { recursive: true, force: true })
  }
  console.log(failed ? '\n有没过的' : `\n全部通过，截图在 ${SHOTS}`)
  process.exit(failed ? 1 : 0)
}

/** 截图：设置页两格（假桥）+ 会议页上传录音撞上「连不上」（真服务进程）。 */
async function shoot({ auth, meetingId }) {
  console.log('── 截图')
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  const GB = 1024 ** 3
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
        deviceScaleFactor: 2,
      })
      await context.addInitScript(
        ([t, th]) => {
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', th)
          window.localStorage.setItem('agentsws.telemetry_notice_seen', '1')
        },
        [auth.token, theme],
      )
      await context.addInitScript(fakeBridgeScript(), { winDefault: WIN_DEFAULT })
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      if (page.url().includes('/onboarding')) {
        await page.getByText('先跳过').first().click()
        await page.waitForTimeout(1500)
      }
      await go(page, '/settings/privacy')
      const row = page.getByTestId('settings-data-location')
      await row.waitFor({ timeout: 30_000 }).catch(() => undefined)
      check((await row.count()) > 0, `${theme}：设置 → 数据与隐私里有「数据存放位置」`)
      if ((await row.count()) === 0) {
        await context.close()
        continue
      }
      await row.scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      check(
        (await page.getByTestId('blob-location-cell').count()) === 1 &&
          (await page.getByTestId('data-location-cell').count()) === 1,
        `${theme}：两格（数据库 / 大文件）`,
      )
      await row.screenshot({ path: join(SHOTS, `${theme}-1-two-cells.png`) })

      // 大文件确认框（NAS：只说附件打不开）
      await page.evaluate((nas) => {
        window.__wp482.setNext({
          ok: true,
          chosen: nas,
          target: nas,
          bytes: 18.6 * 1024 ** 3,
          files: 23_408,
          free_bytes: 3.2 * 1024 ** 4,
          estimate_seconds: 2900,
          problems: [],
          warnings: ['network'],
          kind: 'blobs',
        })
      }, WIN_NAS)
      await page.getByTestId('blob-location-change').click()
      let dialog = page.getByTestId('data-location-dialog')
      await dialog.waitFor({ timeout: 5000 })
      await page.waitForTimeout(300)
      let text = (await dialog.textContent()) ?? ''
      check(
        text.includes('把大文件搬到这里') &&
          text.includes('断网时附件打不开') &&
          !text.includes('工坊打不开'),
        `${theme}：大文件确认框（网络盘只说附件打不开）`,
      )
      await page.screenshot({ path: join(SHOTS, `${theme}-2-blobs-confirm.png`) })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)

      // 数据库确认框（网络盘：1647 那半句；大文件会一起搬）
      await page.evaluate(() => {
        window.__wp482.setNext({
          ok: true,
          chosen: 'Y:\\共享\\工坊',
          target: 'Y:\\共享\\工坊\\agentsws-data',
          bytes: 18.9 * 1024 ** 3,
          files: 23_820,
          free_bytes: 3.2 * 1024 ** 4,
          estimate_seconds: 2950,
          problems: [],
          warnings: ['network'],
          includes_blobs: true,
        })
      })
      await page.getByTestId('data-location-change').click()
      dialog = page.getByTestId('data-location-dialog')
      await dialog.waitFor({ timeout: 5000 })
      await page.waitForTimeout(300)
      text = (await dialog.textContent()) ?? ''
      check(
        text.includes('网络盘上的数据库更容易损坏') && text.includes('会一起搬过去'),
        `${theme}：数据库确认框（1647 那半句 + 大文件会一起搬）`,
      )
      await page.screenshot({ path: join(SHOTS, `${theme}-3-db-confirm.png`) })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)

      // 大文件搬家进度（只出在大文件那一格）
      await page.evaluate((s) => window.__wp482.emit(s), {
        state: 'running',
        which: 'blobs',
        step: 'copy',
        to: WIN_NAS,
        copied_bytes: 6.4 * GB,
        total_bytes: 18.6 * GB,
        files_done: 8100,
        files_total: 23_408,
        started_at: new Date().toISOString(),
      })
      await page.waitForTimeout(300)
      check(
        (await page.getByTestId('blob-location-progress').count()) === 1 &&
          (await page.getByTestId('data-location-progress').count()) === 0,
        `${theme}：进度只出在大文件那一格`,
      )
      await row.screenshot({ path: join(SHOTS, `${theme}-4-blobs-progress.png`) })

      // 搬完：大文件在 NAS 上，旧的留 7 天
      await page.evaluate(
        ({ nas, winDefault }) => {
          window.__wp482.setBlobs({
            path: nas,
            is_default: false,
            old: {
              path: `${winDefault}\\blobs-moved-20261023-1530`,
              until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
            },
          })
          window.__wp482.emit({
            state: 'done',
            which: 'blobs',
            to: nas,
            from: `${winDefault}\\blobs`,
            at: new Date().toISOString(),
          })
        },
        { nas: WIN_NAS, winDefault: WIN_DEFAULT },
      )
      await page.waitForTimeout(600)
      check(
        (await page.getByTestId('blob-location-done').count()) === 1 &&
          (await page.getByTestId('blob-location-old').count()) === 1,
        `${theme}：大文件搬完 + 旧的留到哪天`,
      )
      await row.screenshot({ path: join(SHOTS, `${theme}-5-blobs-done.png`) })

      // 大文件那一格连不上（NAS 断网）
      await page.evaluate(() => {
        window.__wp482.setBlobs({
          reachable: false,
          bytes: undefined,
          files: undefined,
          old: undefined,
        })
        window.__wp482.emit({ state: 'idle' })
      })
      // 下次打开设置页（重开一次这一节）就问到「连不上」
      await go(page, '/settings/general')
      await go(page, '/settings/privacy')
      const row2 = page.getByTestId('settings-data-location')
      await row2.waitFor({ timeout: 15_000 }).catch(() => undefined)
      await page
        .getByTestId('blob-location-retry')
        .waitFor({ timeout: 5000 })
        .catch(() => undefined)
      // 「再试一次」= 重新问壳（假桥这时还是连不上）
      await page
        .getByTestId('blob-location-retry')
        .click()
        .catch(() => undefined)
      await page.waitForTimeout(600)
      check(
        (await page.getByTestId('blob-location-unreachable').count()) === 1,
        `${theme}：大文件那一格说连不上 + 再试一次`,
      )
      await row2.scrollIntoViewIfNeeded().catch(() => undefined)
      await row2.screenshot({ path: join(SHOTS, `${theme}-6-blobs-unreachable.png`) })

      // 会议页：上传录音，真服务进程的大文件位置这时连不上
      if (meetingId !== undefined) {
        await go(page, `/meetings/${meetingId}`)
        const input = page.locator('input[type="file"]').first()
        await input.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => undefined)
        if ((await input.count()) > 0) {
          await input.setInputFiles({
            name: '周会 录音.mp3',
            mimeType: 'audio/mpeg',
            buffer: Buffer.from([
              0x49,
              0x44,
              0x33,
              0x03,
              0,
              0,
              0,
              0,
              0,
              0x21,
              ...Array(400).fill(0),
            ]),
          })
          const note = page.getByTestId('meeting-blob-unavailable')
          await note.waitFor({ timeout: 15_000 }).catch(() => undefined)
          const noteText = (await note.textContent().catch(() => '')) ?? ''
          check(
            noteText.includes('大文件存放的位置现在连不上') && noteText.includes('再试一次'),
            `${theme}：会议页上传录音——说连不上 + 位置 + 再试一次`,
          )
          await note.scrollIntoViewIfNeeded().catch(() => undefined)
          await page.waitForTimeout(300)
          await page.screenshot({ path: join(SHOTS, `${theme}-7-meeting-unreachable.png`) })
        } else check(false, `${theme}：会议页找不到上传按钮`)
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }
  return true
}

await main()
