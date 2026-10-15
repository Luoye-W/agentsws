#!/usr/bin/env node
/**
 * WP331（决策 691）：**报告能力化的真模型评测**——「用户一句话 → 工坊自己配出周报 → 再一句话改格式」。
 *
 * 用例：`evals/report-as-capability/weekly-report.json`（state + turns + expect，替身数据，不开 Reddit）；
 * 评测台：`evals/report-as-capability/harness.mjs`（与 vitest 场景测试同一份）。
 *
 * 跑法（先 `npx tsc -b`）：
 *   node scripts/eval-report-capability.mjs                # stub 运行时：不花钱，验评测台本身（应当全过）
 *   node scripts/eval-report-capability.mjs --live         # 真模型，经 dsh 运行时（与安装包同一条路）
 *   node scripts/eval-report-capability.mjs --live --runtime direct --json out/wp331-eval.json --max-usd 0.5
 *
 * 真模型那一档用哪个模型：与模拟 realistic 档**同一套环境变量**（`packages/simulation` 的 `resolveSimEndpoint`）——
 * `AGENTSWS_SIM_MODEL_API_KEY`（+ 可选 `_PROVIDER` / `_NAME` / `_BASE_URL`），没有就用 `DEEPSEEK_API_KEY`
 * （DeepSeek 官方 `deepseek-flash`）。key 只在本进程里现取一次、经本机 `PUT /v1/models/providers` 存进**临时数据目录**
 * 的加密库，跑完随目录删掉；脚本不打印、不落盘任何 key。dsh 的家目录也指到临时目录（不碰本机 dsh 配置）。
 * 除模型外一个字节不出网（云 / 连接器都指到 127.0.0.1:9）；不碰 4317（服务进程不听端口，请求走进程内网关）。
 *
 * 退出码：0 全过；1 有一项没过（或超预算停下）；2 起不来（没构建 / 没 key）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CASE = join(REPO, 'evals/report-as-capability/weekly-report.json')

export function parseArgs(argv) {
  const out = { live: false, runtime: 'dsh', case: DEFAULT_CASE, maxUsd: 1 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => {
      i += 1
      if (argv[i] === undefined) throw new Error(`${a} 后面要跟一个值`)
      return argv[i]
    }
    if (a === '--live') out.live = true
    else if (a === '--runtime') out.runtime = next()
    else if (a === '--case') out.case = resolve(next())
    else if (a === '--json') out.json = resolve(next())
    else if (a === '--max-usd') out.maxUsd = Number(next())
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`不认识的参数：${a}`)
  }
  if (out.runtime !== 'dsh' && out.runtime !== 'direct')
    throw new Error('--runtime 只认 dsh / direct')
  if (!Number.isFinite(out.maxUsd) || out.maxUsd <= 0) throw new Error('--max-usd 要是正数')
  return out
}

const mod = async (rel) => {
  const path = join(REPO, rel)
  try {
    return await import(pathToFileURL(path).href)
  } catch (e) {
    throw Object.assign(new Error(`载不进 ${rel}——先 \`npx tsc -b\`（${e?.message ?? e}）`), {
      exit: 2,
    })
  }
}

/** 真模型：接在哪、价多少（不含 key）。 */
async function liveModel() {
  const sim = await mod('packages/simulation/dist/index.js')
  const gw = await mod('packages/model-gateway/dist/index.js')
  const endpoint = sim.resolveSimEndpoint(process.env)
  if (endpoint === undefined)
    throw Object.assign(
      new Error(
        '没有模型 key：设 AGENTSWS_SIM_MODEL_API_KEY（或 DEEPSEEK_API_KEY）后再跑 --live。',
      ),
      { exit: 2 },
    )
  const price = gw.catalogPrice(endpoint.baseUrl, endpoint.model)
  return { endpoint, price }
}

const usd = (usage, price) =>
  price === undefined
    ? undefined
    : ((usage.input_tokens - usage.cached_tokens) * price.in +
        usage.cached_tokens * price.cached +
        usage.output_tokens * price.out) /
      1_000_000

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(
      `${readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]}*/\n`,
    )
    return 0
  }
  const log = (line) => process.stderr.write(`${line}\n`)
  const kase = JSON.parse(readFileSync(args.case, 'utf8'))
  const harness = await import(
    pathToFileURL(join(REPO, 'evals/report-as-capability/harness.mjs')).href
  )
  const server = await mod('apps/server/dist/index.js')

  let model
  let configureModel
  let serverOptions = {}
  let dshHome
  if (args.live) {
    model = await liveModel()
    const { endpoint } = model
    // dsh 子进程继承这个进程的环境：家目录落在临时目录里（不碰本机 dsh 配置）
    dshHome = mkdtempSync(join(tmpdir(), 'agentsws-eval-dsh-'))
    process.env.DSH_HOME = dshHome
    process.env.AGENTSWS_DSH_HOME = dshHome
    // key 只取这一次，存进临时数据目录的加密库；然后从环境里拿掉这几个名字（dsh 子进程拿不到）
    const key = process.env[endpoint.keyEnv]
    for (const name of new Set([endpoint.keyEnv, 'DEEPSEEK_API_KEY', 'AGENTSWS_SIM_MODEL_API_KEY']))
      delete process.env[name]
    const official = endpoint.baseUrl.replace(/\/+$/, '') === 'https://api.deepseek.com'
    // 配模型要「改设置」权限（老板那一份分配）；评测用的岗位分配没有这权限会回 403
    configureModel = async (call, server) => {
      const owner = server.bootstrap.ownerAssignment?.id
      const res = await call('PUT', '/v1/models/providers/eval', {
        kind: official ? 'deepseek' : 'openai_compatible',
        label: '评测模型',
        base_url: endpoint.baseUrl,
        model: endpoint.model,
        region: endpoint.region,
        api_key: key,
      }, owner)
      if (res.status >= 300)
        throw Object.assign(new Error(`配模型失败：HTTP ${res.status} ${res.code ?? ''}`), {
          exit: 2,
        })
    }
    serverOptions = args.runtime === 'dsh' ? { runtime: { dshAllRuns: true } } : {}
    log(
      `真模型：${endpoint.provider}/${endpoint.model} @ ${endpoint.baseUrl}（key 来自环境变量 ${endpoint.keyEnv}）；运行时 ${args.runtime}；预算上限 $${args.maxUsd}`,
    )
  } else log('stub 运行时（不调模型、不花钱）')

  const t0 = Date.now()
  const result = await harness
    .runReportCase(kase, {
      createServer: server.createServer,
      serverOptions,
      ...(configureModel === undefined ? {} : { configureModel }),
      log,
      onTurn: ({ turn, usage }) => {
        const cost = model === undefined ? undefined : usd(usage, model.price)
        log(
          `  第 ${turn} 轮后：运行 ${usage.runs} 次，输入 ${usage.input_tokens} / 输出 ${usage.output_tokens} token` +
            (cost === undefined ? '' : `，约 $${cost.toFixed(4)}`),
        )
        if (cost !== undefined && cost > args.maxUsd)
          throw new Error(`超出预算上限 $${args.maxUsd}（已约 $${cost.toFixed(4)}），停下`)
      },
    })
    .finally(() => {
      if (dshHome !== undefined) rmSync(dshHome, { recursive: true, force: true })
    })
  const cost = model === undefined ? 0 : usd(result.usage, model.price)
  for (const t of result.transcript) {
    log(`\n— 第 ${t.turn} 轮 ${t.say === undefined ? `到点 ${t.fire_at}` : `「${t.say}」`}`)
    log(`  工具：${t.tools.join(' → ') || '（没有）'}`)
    for (const a of t.answers) log(`  回话：${a.replace(/\s+/g, ' ').slice(0, 200)}`)
    for (const n of t.notes) log(`  注：${n}`)
    if (t.report !== undefined)
      log(
        `  报告：${t.report.title}（第 ${t.report.version} 版）各节 ${t.report.sections.join(' → ')}`,
      )
  }
  log('')
  for (const c of result.checks)
    log(`${c.pass ? '✓' : '✗'} 第 ${c.turn} 轮 ${c.name}${c.pass ? '' : `  ${c.detail}`}`)
  const passed = result.checks.filter((c) => c.pass).length
  log(
    `\n${result.pass ? '全过' : '没过'}：${passed}/${result.checks.length} 项；运行 ${result.usage.runs} 次，` +
      `输入 ${result.usage.input_tokens} / 输出 ${result.usage.output_tokens} token` +
      (cost === undefined ? '（价目表里没有这个模型，没算钱）' : `，约 $${cost.toFixed(4)}`) +
      `；${Math.round((Date.now() - t0) / 1000)} 秒`,
  )
  if (args.json !== undefined) {
    writeFileSync(
      args.json,
      `${JSON.stringify(
        {
          case: kase.id,
          live: args.live,
          runtime: args.live ? args.runtime : 'stub',
          ...(model === undefined
            ? {}
            : { model: `${model.endpoint.provider}/${model.endpoint.model}`, usd: cost }),
          ...result,
        },
        null,
        2,
      )}\n`,
    )
    log(`结果写在 ${args.json}`)
  }
  return result.pass ? 0 : 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(typeof e?.exit === 'number' ? e.exit : 1)
    },
  )
}
