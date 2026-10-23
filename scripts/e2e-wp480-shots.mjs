#!/usr/bin/env node
/**
 * WP480：数据存放位置——**真服务进程**上把搬家走一遍 + 设置页截图，可重跑。全部在临时目录（路径带中文和空格），
 * 不碰本机的应用数据目录、不碰 4317。
 *
 * 1. 起一个服务进程（临时「应用 数据/data」），建一条待办；
 * 2. 用桌面壳那一套（`apps/desktop/dist/data-move.js`）搬到「新 位置 NAS/agentsws-data」：
 *    暂停（`/v1/update/pause`）→ 备份（`/v1/backup/export`）→ 停服务 → 复制 + 逐文件核对 → 用新位置起 → 健康 →
 *    记指针 → 旧目录改名留 7 天。核对：待办还在、备份包在新位置、指针指过去、旧目录带纸条；
 * 3. 再搬一次但中途「盘满了」：回到原位置照常起，待办还在，新位置抄了一半的清掉；
 * 4. 截图（浅 / 深）：设置 → 数据与隐私，桥用一个假的（只管界面；真搬家上面已经走过）——
 *    那一行、确认框（含网络盘提示）、不能用的文件夹、搬家进度、搬完、失败回滚。
 *
 * ```
 * pnpm exec tsc -b apps/server apps/desktop && pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp480-shots.mjs [--port 4884] [--out <目录>]
 * ```
 * 审稿截图放私有仓，别提交进公开仓。不通过就退出码 1。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'out/wp480'))
const PORT = Number(argOf('--port') ?? '4884') || 4884
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'owner@localhost'

const { runDataMove } = await import(join(ROOT, 'apps/desktop/dist/data-move.js'))
const { checkTarget, readPointer, latestRetired, RETIRED_MARK } = await import(
  join(ROOT, 'apps/desktop/dist/data-location.js')
)

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
function startServer(dataDir) {
  child = spawn(process.execPath, [join(ROOT, 'apps/server/dist/index.js')], {
    env: {
      ...process.env,
      AGENTSWS_PORT: String(PORT),
      AGENTSWS_DATA_DIR: dataDir,
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
async function api(auth, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${auth.token}`,
      'x-assignment': auth.assignment,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`)
  return json.data
}

/** 桌面壳那一套，接到这个真服务进程上。 */
function moveDeps({ userData, from, to, auth, copyOptions }) {
  const statuses = []
  return {
    statuses,
    deps: {
      userData,
      from,
      to,
      now: () => new Date().toISOString(),
      pause: async () => {
        await api(auth, 'POST', '/v1/update/pause', { to: 'data-move' })
      },
      resume: async () => {
        await api(auth, 'POST', '/v1/update/resume', {})
      },
      backup: async () => {
        const out = await api(auth, 'POST', '/v1/backup/export', {})
        console.log(`     备份：${out.out}（${out.bytes} 字节）`)
      },
      stopServices: stopServer,
      startServices: async (dir) => {
        startServer(dir)
      },
      waitHealthy: () => healthy(),
      onStatus: (s) => statuses.push(s),
      log: (m, f) => console.log(`     · ${m}${f === undefined ? '' : ` ${JSON.stringify(f)}`}`),
      ...(copyOptions === undefined ? {} : { copyOptions }),
    },
  }
}

// ── 截图用的假桥（只管界面；真搬家上面已经走过） ─────────────────────
const WIN_DEFAULT = 'C:\\Users\\admin\\AppData\\Roaming\\@agentsws\\desktop\\data'
function fakeBridgeScript() {
  return ({ winDefault }) => {
    const GB = 1024 ** 3
    const state = {
      listeners: [],
      view: {
        path: winDefault,
        is_default: true,
        default_path: winDefault,
        bytes: 1.24 * GB,
        files: 3412,
        status: { state: 'idle' },
      },
      next: null,
    }
    window.__wp480 = {
      state,
      emit: (s) => {
        for (const l of state.listeners) l(s)
      },
      setView: (v) => {
        state.view = { ...state.view, ...v }
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
        checkDefault: async () => ({
          ok: true,
          chosen: winDefault,
          target: winDefault,
          bytes: state.view.bytes,
          files: state.view.files,
          estimate_seconds: 50,
          problems: [],
          warnings: [],
        }),
        move: async () => ({
          state: 'running',
          step: 'backup',
          to: 'Z:\\工坊数据\\agentsws-data',
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
  const base = mkdtempSync(join(tmpdir(), 'wp480-e2e-'))
  const userData = join(base, '应用 数据')
  const oldDir = join(userData, 'data')
  mkdirSync(oldDir, { recursive: true })
  try {
    // ── 1. 起服务、建一条待办
    console.log('── 真服务进程上搬一次家')
    startServer(oldDir)
    check(await healthy(), `服务进程起来了（${BASE}，数据在「${oldDir}」）`)
    let auth = await login()
    await api(auth, 'POST', '/v1/todos', { title: 'WP480 搬家前记下的一件事' })
    const before = await api(auth, 'GET', '/v1/todos')
    const hasTodo = (list) => JSON.stringify(list ?? '').includes('WP480 搬家前记下的一件事')
    check(hasTodo(before), '搬之前：待办在')

    // ── 2. 搬到「新 位置 NAS」（选的文件夹里已有别的东西 → 放进 agentsws-data）
    const chosen = join(base, '新 位置 NAS')
    mkdirSync(chosen)
    writeFileSync(join(chosen, '别的文件.txt'), '用户自己的东西')
    const target = checkTarget({ chosen, current: oldDir, userData, systemDirs: [] })
    check(
      target.ok && target.target === join(chosen, 'agentsws-data'),
      `检查通过：放进 ${target.target}（${target.files} 个文件，约 ${target.estimate_seconds} 秒）`,
    )
    const move = moveDeps({ userData, from: oldDir, to: target.target, auth })
    const t0 = Date.now()
    const result = await runDataMove(move.deps)
    check(result.state === 'done', `搬完了（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`)
    const steps = [
      ...new Set(move.statuses.filter((s) => s.state === 'running').map((s) => s.step)),
    ]
    check(
      ['pause', 'backup', 'stop', 'copy', 'verify', 'start', 'check', 'finish'].every((s) =>
        steps.includes(s),
      ),
      `一步一步报了进度：${steps.join(' → ')}`,
    )
    check(
      readPointer(userData).dir === target.target,
      '指针指向新位置（在 userData 里，不在数据目录里）',
    )
    const old = latestRetired(userData)
    check(
      old !== undefined && existsSync(join(old.path, RETIRED_MARK)) && !existsSync(oldDir),
      `旧目录改名留着（${old?.path}，留到 ${old?.until}）`,
    )
    const backups = readdirSync(join(target.target, 'backups')).filter((f) => f.endsWith('.zip'))
    check(backups.length > 0, `搬之前的备份在新位置的 backups 里（${backups.join(', ')}）`)
    auth = await login()
    check(hasTodo(await api(auth, 'GET', '/v1/todos')), '新位置起来后：待办还在')
    check(existsSync(join(chosen, '别的文件.txt')), '选的文件夹里用户自己的东西没动')

    // ── 3. 再搬一次，中途「盘满了」→ 回原位置
    console.log('── 中途失败回滚')
    const bad = join(base, '小 U 盘')
    mkdirSync(bad)
    let n = 0
    const failMove = moveDeps({
      userData,
      from: target.target,
      to: bad,
      auth,
      copyOptions: {
        beforeFile: () => {
          n += 1
          if (n === 3) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })
        },
      },
    })
    const failedResult = await runDataMove(failMove.deps)
    check(
      failedResult.state === 'failed' &&
        failedResult.code === 'no_space' &&
        failedResult.recovered === true,
      `报「空间不够」、已回到原来的位置（${JSON.stringify(failedResult)}）`,
    )
    check(readdirSync(bad).length === 0, '新位置抄了一半的清掉了')
    check(readPointer(userData).dir === target.target, '指针没动')
    auth = await login()
    check(hasTodo(await api(auth, 'GET', '/v1/todos')), '回到原位置后：待办还在')

    // ── 4. 截图（服务进程这时跑在新位置上）
    console.log('── 截图')
    const { chromium } = require(
      join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
    )
    const browser = await chromium.launch({ headless: true })
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
        check((await row.count()) > 0, `${theme}：设置 → 数据与隐私里有「数据放在哪」`)
        if ((await row.count()) === 0) {
          await context.close()
          continue
        }
        await row.scrollIntoViewIfNeeded()
        await page.waitForTimeout(400)
        const last = page.getByTestId('storage-last-backup')
        if ((await last.count()) > 0) {
          const text = (await last.textContent()) ?? ''
          check(!/\d{4}-\d{2}-\d{2}T/.test(text), `${theme}：上次备份说人话（${text}）`)
        }
        await page.screenshot({ path: join(SHOTS, `${theme}-1-row.png`) })

        // 确认框（NAS 映射盘：多一句「断网时打不开」）
        await page.evaluate(() =>
          window.__wp480.setNext({
            ok: true,
            chosen: 'Z:\\工坊数据',
            target: 'Z:\\工坊数据\\agentsws-data',
            bytes: 1.24 * 1024 ** 3,
            files: 3412,
            free_bytes: 820 * 1024 ** 3,
            estimate_seconds: 200,
            problems: [],
            warnings: ['network'],
          }),
        )
        await page.getByTestId('data-location-change').click()
        const dialog = page.getByTestId('data-location-dialog')
        await dialog.waitFor({ timeout: 5000 })
        await page.waitForTimeout(300)
        const facts = (await dialog.textContent()) ?? ''
        check(
          facts.includes('要搬 1.2 GB') && facts.includes('暂停') && facts.includes('断网'),
          `${theme}：确认框说清要搬多少、多久、会暂停、网络盘风险`,
        )
        await page.screenshot({ path: join(SHOTS, `${theme}-2-confirm.png`) })
        await page.getByTestId('data-location-start').click()
        await page.waitForTimeout(300)

        // 进度
        const GB = 1024 ** 3
        const running = {
          state: 'running',
          to: 'Z:\\工坊数据\\agentsws-data',
          started_at: new Date().toISOString(),
          files_total: 3412,
        }
        await page.evaluate((s) => window.__wp480.emit(s), {
          ...running,
          step: 'copy',
          copied_bytes: 0.52 * GB,
          total_bytes: 1.24 * GB,
          files_done: 1400,
        })
        await page.waitForTimeout(300)
        const progress = page.getByTestId('data-location-progress')
        check(
          ((await progress.textContent()) ?? '').includes('正在复制'),
          `${theme}：搬家进度就地显示`,
        )
        await page.screenshot({ path: join(SHOTS, `${theme}-3-progress.png`) })

        // 搬完（旧位置留 7 天）
        await page.evaluate(
          ({ winDefault }) => {
            window.__wp480.setView({
              path: 'Z:\\工坊数据\\agentsws-data',
              is_default: false,
              old: {
                path: `${winDefault}-moved-20261023-1144`,
                until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
              },
            })
            window.__wp480.emit({
              state: 'done',
              to: 'Z:\\工坊数据\\agentsws-data',
              from: winDefault,
              at: new Date().toISOString(),
            })
          },
          { winDefault: WIN_DEFAULT },
        )
        await page.waitForTimeout(600)
        check((await page.getByTestId('data-location-done').count()) > 0, `${theme}：搬完的那一句`)
        check(
          (await page.getByTestId('data-location-old').count()) > 0,
          `${theme}：旧位置留到哪天 + 现在就删`,
        )
        await page.screenshot({ path: join(SHOTS, `${theme}-4-done.png`) })

        // 失败回滚
        await page.evaluate(() =>
          window.__wp480.emit({
            state: 'failed',
            code: 'copy_failed',
            step: 'copy',
            back_to: 'Z:\\工坊数据\\agentsws-data',
            recovered: true,
            at: new Date().toISOString(),
          }),
        )
        await page.waitForTimeout(400)
        const fail = (await page.getByTestId('data-location-failed').textContent()) ?? ''
        check(fail.includes('已回到原来的位置'), `${theme}：失败回滚那一句（${fail}）`)
        await page.screenshot({ path: join(SHOTS, `${theme}-5-failed.png`) })

        // 不能用的文件夹（空间不够 + 网盘同步盘这种不拦只提示的不在这里）
        await page.evaluate(() =>
          window.__wp480.setNext({
            ok: false,
            chosen: 'E:\\U盘',
            target: 'E:\\U盘\\agentsws-data',
            bytes: 1.24 * 1024 ** 3,
            files: 3412,
            free_bytes: 0.6 * 1024 ** 3,
            estimate_seconds: 200,
            problems: ['no_space'],
            warnings: [],
          }),
        )
        await page.getByTestId('data-location-change').click()
        await page.getByTestId('data-location-dialog-problems').waitFor({ timeout: 5000 })
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(SHOTS, `${theme}-6-problem.png`) })
        await page.keyboard.press('Escape')

        // 恢复默认位置的确认框
        await page.waitForTimeout(300)
        await page.getByTestId('data-location-reset').click()
        await page.getByTestId('data-location-dialog').waitFor({ timeout: 5000 })
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(SHOTS, `${theme}-7-reset.png`) })
        await context.close()
      }
    } finally {
      await browser.close()
    }
  } finally {
    await stopServer()
    rmSync(base, { recursive: true, force: true })
  }
  console.log(failed ? '\n有没过的' : `\n全部通过，截图在 ${SHOTS}`)
  process.exit(failed ? 1 : 0)
}

await main()
