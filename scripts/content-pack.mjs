#!/usr/bin/env node
/**
 * WP219（docs/90 §4）：内容包的打包 / 签名 / 自检。**发版流水线里跑**（`.github/workflows/release.yml`
 * 的 `content` 作业）；本机只用来演练（用现生成的测试钥匙）。
 *
 * ```
 * node scripts/content-pack.mjs check                                  # 登记表形状（CI）
 * node scripts/content-pack.mjs plan                                   # 这一趟会打哪几条（不签）
 * CONTENT_SIGNING_KEY="$(cat key.pem)" \
 *   node scripts/content-pack.mjs build --channel beta --out out/content [--serial N]
 * node scripts/content-pack.mjs verify --dir out/content/r2/beta --public-key <base64>
 * node scripts/content-pack.mjs verify --dir out/content/r2/beta --builtin   # 用应用里内置的公钥验
 * ```
 *
 * - 私钥只从环境变量 `CONTENT_SIGNING_KEY` 读（GitHub Actions secret，值由 Luoye 填），**不打印、不落盘**；
 * - 没有审过的条目 → 不出包、退出 0（`$GITHUB_OUTPUT` 写 `published=false`），发版照常；
 * - 序号缺省用当前秒数（只增）；
 * - 写两份布局：`<out>/r2/<渠道>/…`（传 `dl.agentsws.com/content/`）与 `<out>/github/…`（平铺，传 Release）。
 *
 * 要先 `pnpm exec tsc -b`（打包、签名、扫描都在 `packages/skills/dist`）。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  checkLedger,
  loadSkills,
  packLayout,
  planPack,
  REPO_ROOT,
  readLedger,
  renderPlan,
} from './content-pack-lib.mjs'

const KEY_ENV = 'CONTENT_SIGNING_KEY'

function arg(args, name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

function output(key, value, env = process.env) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`)
}

function summary(text, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text)
}

export async function run(argv = process.argv.slice(2), env = process.env, root = REPO_ROOT) {
  const [cmd, ...args] = argv
  const log = (s) => process.stdout.write(`${s}\n`)
  if (cmd === 'check') {
    const problems = checkLedger(readLedger(root))
    for (const p of problems) log(`✗ ${p}`)
    if (problems.length === 0) log('✓ content-reviews.json 形状没问题')
    return problems.length === 0 ? 0 : 1
  }
  const skills = await loadSkills()
  if (cmd === 'plan') {
    const ledger = readLedger(root)
    const problems = checkLedger(ledger)
    if (problems.length > 0) {
      for (const p of problems) log(`✗ ${p}`)
      return 1
    }
    log(renderPlan(planPack(ledger, { root, skills })))
    return 0
  }
  if (cmd === 'build') {
    const channel = arg(args, '--channel', 'beta')
    if (channel !== 'stable' && channel !== 'beta') throw new Error('--channel 只认 stable / beta')
    const out = resolve(arg(args, '--out', join(root, 'out/content')))
    const serial = Number(arg(args, '--serial', String(Math.floor(Date.now() / 1000))))
    if (!Number.isInteger(serial) || serial < 1) throw new Error('--serial 要是正整数')
    const ledger = readLedger(root)
    const problems = checkLedger(ledger)
    if (problems.length > 0) {
      for (const p of problems) log(`✗ ${p}`)
      return 1
    }
    const plan = planPack(ledger, { root, skills })
    if (plan.ready.length === 0) {
      log(renderPlan(plan))
      summary(renderPlan(plan), env)
      output('published', 'false', env)
      return 0
    }
    const key = env[KEY_ENV]
    if (key === undefined || key.trim() === '') {
      log(
        `✗ 没有 ${KEY_ENV}（GitHub Actions secret，值由 Luoye 填）：有 ${plan.ready.length} 条审过的内容，但签不了，不出包`,
      )
      output('published', 'false', env)
      return 1
    }
    const built = skills.buildContentPack({
      channel,
      serial,
      created_at: new Date().toISOString(),
      min_app_version: ledger.min_app_version,
      items: plan.ready.map((r) => ({ meta: r.meta, dir: r.dir })),
      privateKeyPem: key,
    })
    for (const f of packLayout(built)) {
      for (const [base, rel] of [
        [join(out, 'r2'), f.r2],
        [join(out, 'github'), f.gh],
      ]) {
        const target = join(base, rel)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, f.bytes)
      }
    }
    const text = renderPlan(plan, built.manifest)
    log(text)
    summary(text, env)
    output('published', 'true', env)
    output('serial', String(serial), env)
    output('key_id', built.manifest.key_id, env)
    return 0
  }
  if (cmd === 'verify') {
    const dir = resolve(arg(args, '--dir', ''))
    const pub = arg(args, '--public-key', '')
    const bytes = readFileSync(join(dir, 'content-manifest.json'))
    const sig = readFileSync(join(dir, 'content-manifest.json.sig'), 'utf8')
    // `--builtin`：用**应用里内置的**公钥验（发版流水线用它确认 secret 里的私钥与发出去的应用对得上）
    const keys = args.includes('--builtin')
      ? (await import(join(REPO_ROOT, 'packages/contracts/dist/index.js')))
          .CONTENT_SIGNING_PUBLIC_KEYS
      : [{ key_id: skills.contentKeyId(Buffer.from(pub, 'base64')), public_key: pub }]
    if (keys.length === 0) {
      log(
        '✗ 应用里还没有内置公钥（CONTENT_SIGNING_PUBLIC_KEYS 是空的）：用户端一份都不会收，先别传',
      )
      return 1
    }
    const m = skills.verifyContentManifest(bytes, sig, {
      keys,
      appVersion: '999.0.0',
      channel: JSON.parse(bytes.toString('utf8')).channel,
    })
    for (const item of m.items)
      skills.verifyContentItemFiles(item, (sha) => readFileSync(join(dir, 'blobs', sha)))
    log(`✓ 签名对、${m.items.length} 条条目的文件哈希全对（序号 ${m.serial}）`)
    return 0
  }
  log(
    '用法：content-pack.mjs check | plan | build --channel beta --out <dir> [--serial N] | verify --dir <dir> --public-key <b64>',
  )
  return 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    },
  )
}
