/**
 * WP245 测试用的**假 npm / 假 Shopify CLI**（真脚本、真子进程，跑在测试自己的 node 上；不联网）。
 *
 * 子进程的环境是白名单（传不进 `FAKE_*`），所以「演哪一出」写在脚本旁边的 `mode` 文件里：
 * 假 npm：`ok` = 打几行取包进度、在 `--prefix` 下造一个假 `@shopify/cli`（入口抄自旁边的 `run.js`）；
 * `enotfound` = 打 npm 10 的网络错误行退出 1；`hang` = 一直不退；`mirror_only`（WP254）= 只有源是国内源
 * npmmirror 时才装得上，别的源一律当 ENOTFOUND（冒充国内网络）。
 * 假 shopify 的 `auth login`：`ok` / `presskey` / `denied` / `hang`（`bin/mode` 文件，默认 ok）；
 * 带着 `CI` 就照真 CLI 那样拒绝交互登录（退出 3）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FAKE_SHOPIFY_RUN = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'version') { console.log('Current Shopify CLI version: 4.8.5'); process.exit(0) }
if (args[0] === 'auth' && args[1] === 'login') {
  if ('CI' in process.env) { console.error('Authorization is required to continue, but the current environment does not support interactive prompts.'); process.exit(3) }
  let mode = 'ok'
  try { mode = require('node:fs').readFileSync(require('node:path').join(__dirname, 'mode'), 'utf8').trim() } catch {}
  console.log('\\nTo run this command, log in to Shopify.')
  const url = 'https://accounts.shopify.com/activate-with-code?device_code%5Buser_code%5D=ABCD-EFGH'
  const finish = () => {
    console.log('User verification code: ABCD-EFGH')
    console.log('\\u001b[1m👉 Open this link to start the auth process:\\u001b[0m ' + url)
    if (mode === 'hang') { setInterval(() => {}, 1000); return }
    setTimeout(() => {
      if (mode === 'denied') { console.error('Device authorization failed: Access denied.'); process.exit(1) }
      console.log('Logged in.'); process.exit(0)
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
if (mode === 'enotfound' || (mode === 'mirror_only' && process.env.npm_config_registry !== 'https://registry.npmmirror.com')) {
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

export type FakeNpmMode = 'ok' | 'enotfound' | 'hang' | 'mirror_only'

/** 在 `root` 下摆好假 npm（旁边带假 shopify 的入口），回 npm 脚本的路径；`mode` 改演哪一出。 */
export function writeFakeNpm(
  root: string,
  mode: FakeNpmMode = 'ok',
): { npmCli: string; setMode: (m: FakeNpmMode) => void } {
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
export function setLoginMode(entry: string, mode: 'ok' | 'presskey' | 'denied' | 'hang'): void {
  writeFileSync(join(entry, '..', 'mode'), mode)
}
