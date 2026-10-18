#!/usr/bin/env node
/**
 * WP355：**真账号实测**——用本机已登录的 ChatGPT 订阅跑几条「ChatGPT 自带搜索」（决策 937）。
 *
 * 默认不进 CI；由 Luoye 或主会话手动跑。纪律：
 * - **不读、不打印任何令牌**：令牌照旧在本机加密库里，由官方 pi-ai 自己取、到期自己刷新回写；
 *   脚本只列「哪个人登录过」（记录名，不是值），输出里再兜一道脱敏（形如 JWT / 长串的一律换成 ***）；
 * - 不起服务进程、不碰 4317、不碰别的连接；只打 `chatgpt.com/backend-api/codex/responses`（订阅额度，不花钱）；
 * - 先 `npx tsc -b`（用 `apps/server/dist` 与 `packages/dsh-adapter/dist`）。
 *
 * 两种跑法：
 *
 * 1. 用已登录的那一份（dev-real 的数据目录，密钥在它的 .env.local 里，**只经环境变量进来**）：
 *      ( set -a; . "$HOME/Library/Application Support/agentsws-dev/.env.local"; set +a; \
 *        node scripts/live-codex-search.mjs --data-dir "$HOME/Library/Application Support/agentsws-dev" \
 *          --out docs/assets/web-search/codex-native-2026-10-16.json )
 *    （桌面安装版的密钥在钥匙串里，脚本拿不到——那就用第 2 种。）
 *
 * 2. 临时登录一次（临时目录 + 临时密钥，跑完整个删掉；屏幕上会出一个网址和一串码，用手机打开输入即可）：
 *      node scripts/live-codex-search.mjs --login --out docs/assets/web-search/codex-native-2026-10-16.json
 *
 * 其他参数：`--person <person_id>`（库里登录过不止一个人时挑一个）、`--model gpt-5.5`、
 * `--variants`（第一条查询再用几种 web_search 写法各试一次，看 Codex 后端认哪种）。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = (p) => pathToFileURL(join(ROOT, 'apps/server/dist', p)).href
const { createSecretStore, SECRETS_KEY_ENV } = await import(dist('secret-store.js'))
const { createSubscription } = await import(dist('subscription.js'))
const { searchLocaleOf } = await import(dist('web-browser/locale.js'))

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const flag = (name) => args.includes(name)

const QUERIES = [
  { markets: ['US'], query: 'site:reddit.com smart glasses' },
  { markets: ['US'], query: 'XREAL One review reddit' },
  { markets: ['US'], query: 'site:linkedin.com XREAL' },
  { markets: ['DE'], query: 'smarte Brille Test' },
  { markets: ['US'], query: 'XREAL 智能眼镜 国内 竞品' },
]
/** `--variants`：web_search 工具的几种写法（默认那一种 = Codex CLI 的写法）。 */
const VARIANTS = [
  { name: '默认（external_web_access: true）', tool: undefined },
  { name: '不写 external_web_access', tool: { externalWebAccess: null } },
  { name: '加 include action.sources', tool: { includeSources: true } },
  { name: '加 user_location', tool: { userLocation: true } },
]

/** 输出前兜一道：像令牌的一律换掉（脚本本身不碰令牌，这是防上游错误信息里带出来）。 */
const scrub = (text) =>
  String(text)
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/gu, '***')
    .replace(/(?:sk|rt|at)[-_][\w-]{16,}/giu, '***')
    .replace(/[A-Za-z0-9+/_-]{48,}/gu, '***')

const clock = { now: () => new Date().toISOString() }
const temp = flag('--login') ? mkdtempSync(join(tmpdir(), 'wp355-live-')) : undefined
const dataDir = temp ?? (opt('--data-dir') === undefined ? undefined : resolve(opt('--data-dir')))
if (dataDir === undefined) {
  console.error(
    '要么给 --data-dir（已登录的那份数据目录，密钥经环境变量 AGENTSWS_SECRETS_KEY），要么给 --login。',
  )
  process.exit(2)
}
// 临时登录那一档：密钥只在这个进程的内存里，跑完连目录一起删
const env =
  temp === undefined ? process.env : { [SECRETS_KEY_ENV]: randomBytes(32).toString('hex') }
const secrets = createSecretStore({ dbPath: join(dataDir, 'secrets.sqlite'), clock, env })
if (!secrets.available) {
  console.error(
    `没有秘密库密钥：先把 ${SECRETS_KEY_ENV} 放进环境变量（见文件头的用法），脚本不会打印它。`,
  )
  process.exit(2)
}
const sub = createSubscription({ clock, secrets, runtimeMode: () => 'local' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 挑一个登录过 ChatGPT 订阅的人（只看记录名 `subscription:<人>:openai-codex`，不碰值）。 */
async function personOf() {
  if (temp !== undefined) {
    const actor = {
      workspace_id: 'ws_live',
      person_id: 'p_live',
      assignment_id: 'asg_live',
      role_id: 'owner',
    }
    let view = await sub.port.login(actor, { provider: 'openai-codex', method: 'device' })
    if (view.notice?.url !== undefined)
      console.log(
        `\n用手机打开 ${view.notice.url} ，输入 ${view.notice.code ?? '（见页面）'}，确认授权。等你点完……\n`,
      )
    for (let i = 0; i < 180 && !view.signed_in; i++) {
      await sleep(2000)
      view = await sub.port.get(actor, 'openai-codex')
      if (view.last_error !== undefined) throw new Error(`登录没成：${scrub(view.last_error)}`)
    }
    if (!view.signed_in) throw new Error('6 分钟内没完成登录，先停了。')
    console.log(`已登录（账号 ${view.account ?? '—'}）。`)
    return 'p_live'
  }
  const people = secrets
    .list()
    .map((r) => /^subscription:(.+):openai-codex$/u.exec(r.connection_id)?.[1])
    .filter((p) => p !== undefined)
  const wanted = opt('--person')
  if (wanted !== undefined && !people.includes(wanted))
    throw new Error(`库里没有 ${wanted} 的 ChatGPT 订阅登录。`)
  if (people.length === 0)
    throw new Error(
      '这份数据目录里没人用 ChatGPT 订阅登录过：先在工作台「设置 → 模型」登录，或改用 --login。',
    )
  if (people.length > 1 && wanted === undefined)
    console.log(`登录过的有 ${people.length} 个人，先用第一个（--person 可挑）。`)
  return wanted ?? people[0]
}

async function once(person, q, variant) {
  const locale = searchLocaleOf({ markets: q.markets }, q.query)
  const started = Date.now()
  try {
    const r = await sub.nativeSearch(person, 'openai-codex', {
      query: q.query,
      maxResults: 10,
      locale,
      ...(opt('--model') === undefined ? {} : { model: opt('--model') }),
      ...(variant.tool === undefined ? {} : { tool: variant.tool }),
    })
    const hosts = r.sources.map((s) => {
      try {
        return new URL(s.url).hostname.replace(/^www\./u, '')
      } catch {
        return '?'
      }
    })
    return {
      query: q.query,
      locale,
      variant: variant.name,
      ok: true,
      ms: Date.now() - started,
      model: r.model,
      count: r.sources.length,
      with_snippet: r.sources.filter((s) => s.snippet !== undefined).length,
      hosts: [...new Set(hosts)],
      top: r.sources
        .slice(0, 5)
        .map((s) => ({ url: s.url, title: s.title ?? '', snippet: scrub(s.snippet ?? '') })),
      ...(r.usage === undefined ? {} : { usage: r.usage }),
      ...(r.text === undefined ? {} : { text: scrub(r.text).slice(0, 1200) }),
    }
  } catch (e) {
    return {
      query: q.query,
      locale,
      variant: variant.name,
      ok: false,
      ms: Date.now() - started,
      code: e?.code ?? 'error',
      error: scrub(e instanceof Error ? e.message : String(e)).slice(0, 400),
    }
  }
}

const results = []
let failed = false
try {
  const person = await personOf()
  for (const [i, q] of QUERIES.entries()) {
    const variants = flag('--variants') && i === 0 ? VARIANTS : [VARIANTS[0]]
    for (const v of variants) {
      const r = await once(person, q, v)
      results.push(r)
      console.log(
        r.ok
          ? `✓ ${q.query}（${v.name}）：${r.count} 条，${r.with_snippet} 条有摘要，${r.ms} ms，站点 ${r.hosts.slice(0, 5).join(' / ')}`
          : `✗ ${q.query}（${v.name}）：${r.code} ${r.error}`,
      )
    }
  }
} catch (e) {
  failed = true
  console.error(scrub(e instanceof Error ? e.message : String(e)))
} finally {
  await sub.close()
  secrets.close()
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
}

const out = resolve(opt('--out') ?? join(tmpdir(), `wp355-codex-native-${Date.now()}.json`))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify({ at: clock.now(), results }, null, 2)}\n`)
console.log(`\n结果写在 ${out}`)
process.exit(failed ? 1 : 0)
