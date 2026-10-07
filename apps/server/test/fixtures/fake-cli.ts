/**
 * WP245 测试用的**假 npm / 假 Shopify CLI**（真脚本、真子进程，跑在测试自己的 node 上；不联网）。
 *
 * 子进程的环境是白名单（传不进 `FAKE_*`），所以「演哪一出」写在脚本旁边的 `mode` 文件里：
 * 假 npm：`ok` = 打几行取包进度、在 `--prefix` 下造一个假 `@shopify/cli`（入口抄自旁边的 `run.js`）；
 * `enotfound` = 打 npm 10 的网络错误行退出 1；`hang` = 一直不退。
 * 假 shopify 的 `auth login`：`ok` / `presskey` / `denied` / `hang`（`bin/mode` 文件，默认 ok）；
 * 带着 `CI` 就照真 CLI 那样拒绝交互登录（退出 3）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FAKE_SHOPIFY_RUN = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'version') { console.log('Current Shopify CLI version: 4.8.5'); process.exit(0) }
if (args[0] === 'auth' && args[1] === 'login') {
  const fs = require('node:fs')
  const path = require('node:path')
  if ('CI' in process.env) { console.error('Authorization is required to continue, but the current environment does not support interactive prompts.'); process.exit(3) }
  // WP253：照 4.8.5——非交互环境下不带 --alias 一开头就报错退出（Fable 10-07 真机撞上的那一句）
  const ai = args.indexOf('--alias')
  const alias = ai < 0 ? undefined : args[ai + 1]
  if (!process.stdin.isTTY && alias === undefined) {
    console.error('Flag not specified:\\n\\n--alias\\n\\nThis flag is required in non-interactive terminal environments, such as a CI environment, or when piping input from another process.')
    process.exit(1)
  }
  // 会话存在「CLI 配置目录」里：HOME 指到品牌那一份（路径里有 -sessions）就真写进去；别的 HOME 一律记在脚本旁边
  // （按 HOME 分开，不碰真的 HOME）。存下来的别名是账号邮箱，不是 --alias 给的那个（4.8.5 就是这样）
  const home = process.env.HOME || ''
  const inHome = home.includes('-sessions')
  const storeFile = inHome ? path.join(home, 'fake-shopify-sessions.json') : path.join(__dirname, 'sessions.json')
  let store = {}
  try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')) } catch {}
  const mine = store[home] || []
  fs.appendFileSync(path.join(__dirname, 'logins.jsonl'), JSON.stringify({ args, home, appdata: process.env.APPDATA }) + '\\n')
  if (alias !== undefined && mine.some((s) => s.alias === alias)) { console.log('Current account: ' + alias + '.'); process.exit(0) }
  if (mine.length > 0) { console.error('Failed to prompt: Which account would you like to use? This usually happens when running a command non-interactively'); process.exit(1) }
  let mode = 'ok'
  try { mode = fs.readFileSync(path.join(__dirname, 'mode'), 'utf8').trim() } catch {}
  console.log('\\nTo run this command, log in to Shopify.')
  const url = 'https://accounts.shopify.com/activate-with-code?device_code%5Buser_code%5D=ABCD-EFGH'
  const finish = () => {
    console.log('User verification code: ABCD-EFGH')
    if (mode === 'opened') console.log('Opened link to start the auth process: ' + url)
    else console.log('\\u001b[1m👉 Open this link to start the auth process:\\u001b[0m ' + url)
    if (mode === 'hang') { setInterval(() => {}, 1000); return }
    setTimeout(() => {
      if (mode === 'denied') { console.error('Device authorization failed: Access denied.'); process.exit(1) }
      store[home] = [...mine, { alias: 'owner@example.test' }]
      fs.writeFileSync(storeFile, JSON.stringify(store))
      console.log('Logged in.'); console.log('Current account: owner@example.test.'); process.exit(0)
    }, 150)
  }
  if (mode === 'presskey') {
    console.log('👉 Press any key to open the login page on your browser')
    process.stdin.once('data', () => { process.stdin.pause(); finish() })
    return
  }
  finish()
  return
}
process.exit(2)
`

export const FAKE_NPM_CLI = `#!/usr/bin/env node
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
let mode = 'ok'
try { mode = readFileSync(join(__dirname, 'mode'), 'utf8').trim() } catch {}
if (args[0] !== 'install') process.exit(9)
const prefix = args[args.indexOf('--prefix') + 1]
const target = args[args.length - 1]
if (process.env.npm_config_cache === undefined) process.exit(8)
if (mode === 'hang') { setInterval(() => {}, 1000); return }
if (mode === 'enotfound') {
  console.error('npm error code ENOTFOUND')
  console.error('npm error syscall getaddrinfo')
  console.error('npm error errno ENOTFOUND')
  process.exit(1)
}
for (const p of ['@shopify%2fcli', '@ast-grep%2fnapi', 'esbuild']) console.error('npm http fetch GET 200 https://registry.npmjs.org/' + p + ' 12ms (cache miss)')
const name = target.slice(0, target.lastIndexOf('@'))
const dir = join(prefix, 'node_modules', ...name.split('/'))
mkdirSync(join(dir, 'bin'), { recursive: true })
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '4.8.5', bin: { shopify: './bin/run.js' } }))
writeFileSync(join(dir, 'bin', 'run.js'), readFileSync(join(__dirname, 'run.js'), 'utf8'))
console.log('added 3 packages in 1s')
`

/** 在 `root` 下摆好假 npm（旁边带假 shopify 的入口），回 npm 脚本的路径；`mode` 改演哪一出。 */
export function writeFakeNpm(
  root: string,
  mode: 'ok' | 'enotfound' | 'hang' = 'ok',
): { npmCli: string; setMode: (m: 'ok' | 'enotfound' | 'hang') => void } {
  const dir = join(root, 'fake-npm', 'bin')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'npm-cli.cjs')
  writeFileSync(file, FAKE_NPM_CLI)
  writeFileSync(join(dir, 'run.js'), FAKE_SHOPIFY_RUN)
  const setMode = (m: string): void => writeFileSync(join(dir, 'mode'), m)
  setMode(mode)
  return { npmCli: file, setMode }
}

/** 装好的假 shopify 下一次登录演哪一出。 */
export function setLoginMode(
  entry: string,
  mode: 'ok' | 'presskey' | 'denied' | 'hang' | 'opened',
): void {
  writeFileSync(join(entry, '..', 'mode'), mode)
}
