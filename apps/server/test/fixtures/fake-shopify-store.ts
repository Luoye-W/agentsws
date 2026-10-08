/**
 * WP261：假 `shopify`（**真脚本、真子进程**）——`store auth` / `store execute` 照 CLI 4.8.5 发行包的样子回话。
 *
 * 起法与 WP245 的私有安装一样：`<node> <入口> store …`。
 *
 * - 授权的结果（权限、过期时间）存在 **`$HOME/.fake-store-session.json`**——子进程的 HOME 是哪个品牌那一份会话目录，
 *   令牌就落在哪（断言「每品牌会话隔离」看的就是它）；真 CLI 存在 `$HOME/Library/Preferences/shopify-cli-store-nodejs` 等处。
 * - 脚本旁边的控制文件：`auth-mode`（`ok` / `deny` / `fewer:<scope,…>` / `hang` / `no-browser` / `port`）、
 *   `expires-in`（秒，默认 86399）、`refresh`（有就回续期令牌）、`revoked` / `net-fail` / `old-version`（执行时撞上的）。
 * - 查询 / 改动按**操作名**取 `state.json` 里 `responses[<操作名>]`（数组 = 按次取，最后一个一直用），
 *   每次执行记一行到 `calls.jsonl`（参数、变量、HOME、有没有 `--allow-mutations`——**不记令牌**）。
 * - 每个操作要的权限按 `state.json` 的 `scopes[<操作名>]`；会话里没有就照 Shopify 原文报 ACCESS_DENIED。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const here = __dirname
const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1] }
const ctl = (n) => { const f = path.join(here, n); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : undefined }
const home = process.env.HOME || ''
const sessionFile = path.join(home, '.fake-store-session.json')
const readSession = () => fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : {}
const store = flag('--store')
const log = (extra) => fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ argv, home, ci: process.env.CI === '1', env: Object.keys(process.env).sort(), ...extra }) + '\\n')
if (argv[0] === 'version') { console.log('4.8.5'); process.exit(0) }
if (argv[0] !== 'store') { console.error('unknown'); process.exit(2) }
if (argv[1] === 'auth') {
  log({})
  const scopes = (flag('--scopes') || '').split(',').filter(Boolean)
  const mode = ctl('auth-mode') || 'ok'
  const url = 'https://' + store + '/admin/oauth/authorize?client_id=7e9cb568cfd431c538f36d1ad3f2b4f6&scope=' + scopes.join(',') + '&redirect_uri=http%3A%2F%2F127.0.0.1%3A13387%2Fauth%2Fcallback&state=abc&response_type=code'
  console.error('Shopify CLI will open the app authorization page in your browser.')
  if (mode === 'no-browser') { console.error('Browser did not open automatically. Open this URL manually:'); console.error(url) }
  if (mode === 'port') { console.error('Port 13387 is already in use.'); process.exit(1) }
  const finish = () => {
    if (mode === 'deny') { console.error('Shopify returned an OAuth error: access_denied'); process.exit(1) }
    if (mode.startsWith('fewer:')) { console.error('Shopify granted fewer scopes than were requested.\\nMissing scopes: ' + mode.slice(6).split(',').join(', ') + '.'); process.exit(1) }
    const before = readSession()[store]
    const merged = [...new Set([...(before ? before.scopes : []), ...scopes])].sort()
    const nowMs = Date.now()
    const expiresIn = Number(ctl('expires-in') || 86399)
    const refresh = ctl('refresh') !== undefined
    const s = readSession()
    s[store] = { scopes: merged, expiresAt: new Date(nowMs + expiresIn * 1000).toISOString(), refresh, token: 'shpua_fake_' + nowMs }
    fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(sessionFile, JSON.stringify(s))
    console.error('Logged in.')
    process.stdout.write(JSON.stringify({ store, userId: '42', scopes: merged, acquiredAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + expiresIn * 1000).toISOString(), ...(refresh ? { refreshTokenExpiresAt: new Date(nowMs + 30 * 86400000).toISOString() } : {}), hasRefreshToken: refresh, associatedUser: { id: 42, email: 'owner@example.test' } }, null, 2) + '\\n')
    process.exit(0)
  }
  if (mode === 'hang') { setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(143)) } else setTimeout(finish, 30)
  return
}
if (argv[1] === 'execute') {
  const qf = flag('--query-file'), vf = flag('--variable-file'), of = flag('--output-file')
  const doc = fs.readFileSync(qf, 'utf8')
  const vars = vf ? JSON.parse(fs.readFileSync(vf, 'utf8')) : {}
  const m = /^\\s*(query|mutation)\\s+(\\w+)/.exec(doc.replace(/#[^\\n]*/g, ''))
  const kind = m ? m[1] : 'query', op = m ? m[2] : 'anon'
  log({ op, vars, mutations: argv.includes('--allow-mutations'), version: flag('--version') })
  if (ctl('net-fail') !== undefined) { console.error('request to https://' + store + '/admin/api/graphql.json failed, reason: getaddrinfo ENOTFOUND ' + store + ' (fetch failed)'); process.exit(1) }
  if (ctl('old-version') !== undefined && flag('--version') !== undefined) { console.error('Invalid API version: ' + flag('--version') + '\\nAllowed versions: 2026-04, 2026-07'); process.exit(1) }
  if (kind === 'mutation' && !argv.includes('--allow-mutations')) { console.error('Mutations are disabled by default for shopify store execute.\\nRe-run with --allow-mutations if you intend to modify store data.'); process.exit(1) }
  const s = readSession()[store]
  if (!s) { console.error('No stored app authentication found for ' + store + '.\\nRun shopify store auth --store ' + store + ' --scopes <comma-separated-scopes> to authenticate'); process.exit(1) }
  if (ctl('revoked') !== undefined) { const all = readSession(); delete all[store]; fs.writeFileSync(sessionFile, JSON.stringify(all)); console.error('Stored app authentication for ' + store + ' is no longer valid.'); process.exit(1) }
  if (Date.parse(s.expiresAt) - 240000 < Date.now() && !s.refresh) { console.error('No refresh token stored for ' + store + '.\\nRun shopify store auth --store ' + store + ' --scopes ' + s.scopes.join(',') + ' to re-authenticate'); process.exit(1) }
  const statePath = path.join(here, 'state.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const need = (state.scopes || {})[op]
  const implied = new Set(s.scopes); for (const x of s.scopes) { const w = /^write_(.+)$/.exec(x); if (w) implied.add('read_' + w[1]) }
  if (need && !implied.has(need)) { console.error('GraphQL operation failed.\\n' + JSON.stringify({ errors: [{ message: 'Access denied for ' + op + ' field. Required access: \`' + need + '\` access scope.', extensions: { code: 'ACCESS_DENIED' } }] }, null, 2)); process.exit(1) }
  let data = (state.responses || {})[op]
  if (Array.isArray(data)) { const first = data.length > 1 ? data.shift() : data[0]; fs.writeFileSync(statePath, JSON.stringify(state)); data = first }
  if (data === undefined) { console.error('GraphQL operation failed.\\n' + JSON.stringify({ errors: [{ message: 'Field ' + op + ' doesn\\'t exist' }] })); process.exit(1) }
  fs.writeFileSync(of, JSON.stringify(data, null, 2)); process.exit(0)
}
console.error('unknown'); process.exit(2)
`

export interface FakeStoreCli {
  /** 入口脚本（`node <entry> store …`）。 */
  entry: string
  dir: string
  setAuthMode(mode: string): void
  set(control: 'expires-in' | 'refresh' | 'revoked' | 'net-fail' | 'old-version', value?: string): void
  clear(control: 'expires-in' | 'refresh' | 'revoked' | 'net-fail' | 'old-version'): void
  respond(op: string, data: unknown): void
  requireScope(op: string, scope: string): void
  calls(): {
    argv: string[]
    home: string
    ci: boolean
    env: string[]
    op?: string
    vars?: Record<string, unknown>
    mutations?: boolean
    version?: string
  }[]
}

export function fakeStoreCli(dir: string): FakeStoreCli {
  const entry = join(dir, 'shopify-store.cjs')
  writeFileSync(entry, SCRIPT)
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify({ responses: {}, scopes: {} }))
  const state = (): { responses: Record<string, unknown>; scopes: Record<string, string> } =>
    JSON.parse(readFileSync(statePath, 'utf8'))
  return {
    entry,
    dir,
    setAuthMode: (mode) => writeFileSync(join(dir, 'auth-mode'), mode),
    set: (control, value = '1') => writeFileSync(join(dir, control), value),
    clear: (control) => rmSync(join(dir, control), { force: true }),
    respond(op, data) {
      const s = state()
      s.responses[op] = data
      writeFileSync(statePath, JSON.stringify(s))
    },
    requireScope(op, scope) {
      const s = state()
      s.scopes[op] = scope
      writeFileSync(statePath, JSON.stringify(s))
    },
    calls: () => {
      const f = join(dir, 'calls.jsonl')
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l))
    },
  }
}
