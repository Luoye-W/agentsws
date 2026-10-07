/**
 * WP247：假 npm（真脚本、真子进程，跑在测试自己的 node 上）——冒充 `npm ci` 把本机连接器
 * 「下载」进暂存目录。不联网：所谓的下载就是往 `node_modules` 里写两个能 import 的小 ESM 包。
 *
 * 模式写在脚本旁边的 `mode.txt` 里（子进程环境走白名单，环境变量传不进去）：
 * `ok` / `slow`（打一行就挂住，等取消）/ `enotfound` / `eintegrity` / `wrong_version` / `broken`（装出 import 不了的包）/
 * `mirror_only`（WP254：只有源是国内源 npmmirror 时才连得上，别的一律 ENOTFOUND——冒充国内网络）。
 * 每次被调用把参数与工作目录记进 `calls.jsonl`。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type FakeOcNpmMode =
  | 'ok'
  | 'slow'
  | 'enotfound'
  | 'eintegrity'
  | 'wrong_version'
  | 'broken'
  | 'mirror_only'

const SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const here = __dirname
const mode = fs.readFileSync(path.join(here, 'mode.txt'), 'utf8').trim()
const version = fs.readFileSync(path.join(here, 'version.txt'), 'utf8').trim()
fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), lock: fs.existsSync('package-lock.json'), registry: process.env.npm_config_registry }) + '\\n')
const fetched = (name) => console.error('npm http fetch GET 200 https://registry.npmjs.org/' + name + '/-/' + name + '-1.0.0.tgz 3ms (cache miss)')
if (mode === 'enotfound' || (mode === 'mirror_only' && process.env.npm_config_registry !== 'https://registry.npmmirror.com')) { console.error('npm error code ENOTFOUND'); console.error('npm error network request failed'); process.exit(1) }
if (mode === 'eintegrity') { fetched('a'); console.error('npm error code EINTEGRITY'); process.exit(1) }
fetched('a')
if (mode === 'slow') { setTimeout(() => {}, 60000); return }
fetched('b'); fetched('c')
const pkg = (name, v) => {
  const dir = path.join(process.cwd(), 'node_modules', ...name.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: v, type: 'module', exports: './index.js' }))
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const ok = true\\n')
}
pkg('@oomol-lab/open-connector', mode === 'wrong_version' ? '0.0.1' : version)
pkg('@hono/node-server', '2.0.10')
if (mode === 'broken') fs.writeFileSync(path.join(process.cwd(), 'node_modules', '@hono', 'node-server', 'index.js'), 'export const = ')
process.exit(0)
`

export interface FakeOcNpm {
  npmCli: string
  dir: string
  setMode(mode: FakeOcNpmMode): void
  setVersion(version: string): void
}

export function writeFakeOcNpm(root: string, mode: FakeOcNpmMode = 'ok'): FakeOcNpm {
  const dir = join(root, 'fake-npm')
  mkdirSync(dir, { recursive: true })
  const npmCli = join(dir, 'npm-cli.cjs')
  writeFileSync(npmCli, SCRIPT)
  const setMode = (m: FakeOcNpmMode): void => writeFileSync(join(dir, 'mode.txt'), m)
  const setVersion = (v: string): void => writeFileSync(join(dir, 'version.txt'), v)
  setMode(mode)
  setVersion('1.8.0')
  return { npmCli, dir, setMode, setVersion }
}
