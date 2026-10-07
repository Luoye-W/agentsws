/**
 * WP253：假 `shopify`（**真脚本、真子进程**）——主题那几条命令照 CLI 4.x 的样子回话。
 *
 * 用法与 WP245 的私有安装同一个起法：`<node> <入口> theme …`。店里的主题落在脚本旁边的
 * `state.json`（子进程环境走白名单，传不进路径，只能靠脚本自己的位置找）；每次调用记一行到 `calls.jsonl`
 * （参数、工作目录、环境变量名——**不记值**，凭据断言看的是「有没有这个名字」）。
 * 脚本旁边放一个 `logged-out` 文件 = 模拟 CLI 自己的会话过期（要碰店铺的命令报「没登录」）。
 *
 * WP258：`organization list --json` / `store list --json` 照 4.8.5 发行包的样子回话（`state.orgs` 没设 =
 * 这条命令不认识，退出 2——老测试照旧走「没找成 → 手填」）：多组织又没带 `--organization-id` 时非交互报错；
 * `stores-fail` 文件 = 网络错。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const here = __dirname
const argv = process.argv.slice(2)
fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), env: Object.keys(process.env).sort(), home: process.env.HOME, appdata: process.env.APPDATA }) + '\\n')
const statePath = path.join(here, 'state.json')
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const save = () => fs.writeFileSync(statePath, JSON.stringify(state))
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1] }
const store = process.env.SHOPIFY_FLAG_STORE || 'none'
const DIRS = ['assets','blocks','config','layout','locales','sections','snippets','templates']
const readTheme = (root) => { const out = {}; for (const top of DIRS) { const d = path.join(root, top); if (!fs.existsSync(d)) continue; const walk = (x) => { for (const n of fs.readdirSync(x)) { const f = path.join(x, n); if (fs.statSync(f).isDirectory()) walk(f); else out[path.relative(root, f).split(path.sep).join('/')] = fs.readFileSync(f, 'utf8') } }; walk(d) } return out }
const view = (t) => ({ id: Number(t.id), name: t.name, role: t.role, shop: store, preview_url: 'https://' + store + '?preview_theme_id=' + t.id, editor_url: 'https://' + store + '/admin/themes/' + t.id + '/editor' })
if (argv[0] === 'version') { console.log('4.8.5'); process.exit(0) }
const loggedOut = fs.existsSync(path.join(here, 'logged-out'))
const storesFail = fs.existsSync(path.join(here, 'stores-fail'))
if (argv[0] === 'organization' && argv[1] === 'list') {
  if (!state.orgs) { console.error('unknown'); process.exit(2) }
  if (storesFail) { console.error('Error: getaddrinfo ENOTFOUND app.shopify.com'); process.exit(1) }
  if (loggedOut) { process.stdout.write(JSON.stringify({ organizations: [] }, null, 2)); process.exit(0) }
  process.stdout.write(JSON.stringify({ organizations: state.orgs.map((o) => ({ id: o.id, gid: 'gid://shopify/Organization/' + o.id, name: o.name })) }, null, 2)); process.exit(0)
}
if (argv[0] === 'store' && argv[1] === 'list') {
  if (!state.orgs) { console.error('unknown'); process.exit(2) }
  if (storesFail) { console.error('Error: getaddrinfo ENOTFOUND app.shopify.com'); process.exit(1) }
  if (loggedOut) { console.error('Error: You are not logged in. Run shopify auth login (401 Unauthorized)'); process.exit(1) }
  if (state.orgs.length === 0) { process.stdout.write(JSON.stringify({ stores: [] }, null, 2)); process.exit(0) }
  const id = flag('--organization-id')
  let org
  if (id !== undefined) { org = state.orgs.find((o) => o.id === id); if (!org) { console.error('Organization with ID ' + id + ' not found.'); process.exit(1) } }
  else if (state.orgs.length > 1 && process.env.CI) { console.error('An organization ID is required to list stores non-interactively.\\nProvide \`--organization-id\`, for example \`--organization-id 1234567\`. Run \`shopify organization list\` to find IDs.'); process.exit(1) }
  else org = state.orgs[0]
  process.stdout.write(JSON.stringify({ stores: org.stores.map((s, i) => ({ id: 'gid://shopify/Shop/' + (900 + i), store: s.store, createdAt: '2026-10-0' + (i + 1) + 'T00:00:00Z', organizationId: org.id, organizationName: org.name, name: s.name, plan: s.plan })), organization: { id: org.id, name: org.name } }, null, 2)); process.exit(0)
}
if (argv[0] !== 'theme') { console.error('unknown'); process.exit(2) }
const sub = argv[1]
const remote = ['list','pull','push','publish'].includes(sub)
if (remote && fs.existsSync(path.join(here, 'logged-out'))) { console.error('Error: You are not logged in. Run shopify auth login (401 Unauthorized)'); process.exit(1) }
if (remote && store === 'none') { console.error('Error: --store is required'); process.exit(1) }
if (sub === 'list') { process.stdout.write('Fetching themes...\\n' + JSON.stringify(state.themes.map((t) => ({ id: Number(t.id), name: t.name, role: t.role })))); process.exit(0) }
if (sub === 'check') {
  const files = readTheme(process.cwd())
  const out = Object.entries(files).filter(([, b]) => b.includes('{% broken')).map(([p]) => ({ path: p, offenses: [{ check: 'LiquidHTMLSyntaxError', message: 'Unknown tag broken', severity: 0, start: { line: 2, character: 0 } }], errorCount: 1, warningCount: 0 }))
  const warn = Object.entries(files).filter(([, b]) => b.includes('TODO')).map(([p]) => ({ path: p, offenses: [{ check: 'Todo', message: 'TODO left', severity: 1, start: { line: 0 } }] }))
  process.stdout.write(JSON.stringify([...out, ...warn])); process.exit(out.length > 0 ? 1 : 0)
}
if (sub === 'pull') {
  const id = flag('--theme')
  const t = id === undefined ? state.themes.find((x) => x.role === 'main') : state.themes.find((x) => x.id === id)
  if (!t) { console.error('Theme not found (404)'); process.exit(1) }
  for (const [rel, body] of Object.entries(t.files)) { fs.mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), rel), body) }
  console.log('Pulled ' + t.name); process.exit(0)
}
if (sub === 'push') {
  const files = readTheme(process.cwd())
  if (argv.includes('--unpublished')) {
    state.seq += 1
    const t = { id: String(state.seq), name: flag('--theme') || 'Copy', role: 'unpublished', files }
    state.themes.push(t); save()
    process.stdout.write('Uploading...\\n' + JSON.stringify({ theme: view(t) })); process.exit(0)
  }
  const t = state.themes.find((x) => x.id === flag('--theme'))
  if (!t) { console.error('Theme not found (404)'); process.exit(1) }
  t.files = files; save()
  process.stdout.write(JSON.stringify({ theme: view(t) })); process.exit(0)
}
if (sub === 'publish') {
  if (!argv.includes('--force')) { console.error('would prompt'); process.exit(3) }
  const t = state.themes.find((x) => x.id === flag('--theme'))
  if (!t) { console.error('Theme not found (404)'); process.exit(1) }
  for (const x of state.themes) if (x.role === 'main') x.role = 'unpublished'
  t.role = 'main'; save()
  console.log(t.name + ' is now the live theme'); process.exit(0)
}
console.error('unsupported ' + sub); process.exit(2)
`

export interface FakeShopifyTheme {
  /** CLI 入口（`<node> <entry> …` 起）。 */
  entry: string
  calls(): { argv: string[]; cwd: string; env: string[]; home?: string; appdata?: string }[]
  themes(): { id: string; name: string; role: string; files: Record<string, string> }[]
  setLoggedOut(out: boolean): void
  /** WP258：这个账号下的组织与店（不设 = `store list` / `organization list` 这两条命令不认识）。 */
  setOrgs(orgs: FakeOrg[] | undefined): void
  /** WP258：找店那两条命令报网络错。 */
  setStoresFail(fail: boolean): void
}

export interface FakeOrg {
  id: string
  name: string
  stores: { store: string; name: string; plan: string }[]
}

export function writeFakeShopifyTheme(dir: string): FakeShopifyTheme {
  const entry = join(dir, 'shopify.cjs')
  writeFileSync(entry, SCRIPT, 'utf8')
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      seq: 200000,
      themes: [
        {
          id: '100001',
          name: 'Horizon',
          role: 'main',
          files: { 'layout/theme.liquid': '<html>{{ content_for_layout }}</html>\n' },
        },
      ],
    }),
  )
  return {
    entry,
    calls: () => {
      const file = join(dir, 'calls.jsonl')
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; env: string[] })
    },
    themes: () => (JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { themes: [] }).themes,
    setLoggedOut: (out) => {
      const flag = join(dir, 'logged-out')
      if (out) writeFileSync(flag, '1')
      else rmSync(flag, { force: true })
    },
    setOrgs: (orgs) => {
      const file = join(dir, 'state.json')
      const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      if (orgs === undefined) delete state.orgs
      else state.orgs = orgs
      writeFileSync(file, JSON.stringify(state))
    },
    setStoresFail: (fail) => {
      const flag = join(dir, 'stores-fail')
      if (fail) writeFileSync(flag, '1')
      else rmSync(flag, { force: true })
    },
  }
}
