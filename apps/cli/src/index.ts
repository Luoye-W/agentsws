/**
 * `agentsws` CLI（26 §5）。
 *
 * - `simulate` 按 glob 跑场景，出报告与合并门禁结论；任一失败退出码非 0
 * - `synth` 生成合成公司数据集（固定 seed 可复现）
 * - `replay` 从事件日志重组 prompt，与 `prompt.assembled.hash` 比对（17 §6.1）
 */

import { isAbsolute, resolve } from 'node:path'
import {
  formatReport,
  isRuntimeName,
  listRuns,
  RUNTIME_NAMES,
  replayRun,
  runSoak,
  runSuite,
  SIZE_PRESETS,
  soakMarkdown,
  synth,
  type Tier,
} from '@agentsws/simulation'
import { Command } from 'commander'
import { createDemo, DEMO_SCENARIO } from './demo.js'

const TIERS: Tier[] = ['fast', 'realistic', 'soak']

/**
 * 相对路径的基准目录。
 *
 * 根 `package.json` 的 `simulate` 走 `pnpm --filter @agentsws/cli exec`，
 * 进程的 cwd 是 `apps/cli/`，而人是在仓库根输入的路径。pnpm 会把原始目录放进
 * `INIT_CWD`（npm 同）——用它做基准，`pnpm simulate --pack packs/...` 才是人想的那个意思。
 */
function baseDir(): string {
  return process.env.INIT_CWD ?? process.cwd()
}

/** 把用户给的相对路径落到 `baseDir()` 上；绝对路径原样。 */
function fromCwd(p: string): string {
  return isAbsolute(p) ? p : resolve(baseDir(), p)
}

function asInt(value: string, name: string): number {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是整数：${value}`)
  return n
}

export function buildProgram(
  write: (s: string) => void = (s) => void process.stdout.write(s),
): Command {
  const program = new Command()
  program
    .name('agentsws')
    .description('agentsws 本地 Agent 中台命令行')
    .version('0.0.0')
    .exitOverride()

  program
    .command('simulate')
    .description('跑模拟场景，出报告与合并门禁结论')
    .option('--tier <tier>', `运行档（${TIERS.join(' | ')}）`, 'fast')
    .option('--pack <dir>', '合成公司数据集目录', 'packs/dtc-3c-3p')
    .option('--scenario <glob...>', '场景 glob（相对 pack 目录）', ['scenarios/**/*.yml'])
    .option('--scenario-root <dir>', '场景根目录（隐藏集用）')
    .option('--seed <n>', '覆盖场景里的 seed')
    .option('--report <dir>', '报告输出目录')
    .option('--baseline <file>', '基线文件（缺省 <pack>/baseline.json）')
    .option(
      '--runtime <name>',
      `用哪个运行时跑（${RUNTIME_NAMES.join(' | ')}）；dsh 缺省按能力探测起 headless 子进程`,
      'stub',
    )
    .option('--write-baseline', '基线不存在时写一份', false)
    .option('--rewrite-baseline', '把这一档基线覆盖写掉（换运行时后重定基线用）', false)
    .option('--max-regression-pct <n>', '指标劣化阈值（%）', '5')
    .option('--days <n>', 'soak 档连着跑几天', '7')
    .option(
      '--max-cost-base <n>',
      'realistic 档跑全部场景的花费上限（基准货币）；超了就停并报告已跑部分',
      '2',
    )
    .action(async (opts: Record<string, unknown>) => {
      const tier = String(opts.tier) as Tier
      if (!TIERS.includes(tier)) throw new Error(`未知运行档：${String(opts.tier)}`)
      const runtime = String(opts.runtime)
      if (!isRuntimeName(runtime)) throw new Error(`未知运行时：${runtime}`)

      // soak 档不按 glob 选题：它是"同一个世界连着过 N 天"，题目由 pack 的到达率生成
      if (tier === 'soak') {
        const soak = await runSoak({
          packDir: fromCwd(String(opts.pack)),
          days: asInt(String(opts.days), '--days'),
          runtime,
          ...(opts.seed === undefined ? {} : { seed: asInt(String(opts.seed), '--seed') }),
          ...(opts.report === undefined ? {} : { reportDir: fromCwd(String(opts.report)) }),
        })
        write(`${formatReport(soak.scenario)}\n\n`)
        write(soakMarkdown(soak).split('## 整段场景')[0]?.split('# soak')[1] ?? '')
        write(
          `\n${soak.passed ? 'soak 通过' : 'soak 不通过'}：${soak.days} 天，${soak.pack}，` +
            `${runtime} 运行时，事件日志 ${(soak.db_bytes / 1024).toFixed(1)} KiB\n`,
        )
        for (const p of soak.problems) write(`  ! ${p}\n`)
        if (!soak.passed) process.exitCode = 1
        return
      }

      const result = await runSuite({
        packDir: fromCwd(String(opts.pack)),
        scenario: opts.scenario as string[],
        tier,
        runtime,
        writeBaseline: opts.rewriteBaseline === true,
        maxRegressionPct: asInt(String(opts.maxRegressionPct), '--max-regression-pct'),
        writeBaselineIfMissing: opts.writeBaseline === true,
        maxCostBase: Number.parseFloat(String(opts.maxCostBase)),
        ...(opts.scenarioRoot === undefined
          ? {}
          : { scenarioRoot: fromCwd(String(opts.scenarioRoot)) }),
        ...(opts.seed === undefined ? {} : { seed: asInt(String(opts.seed), '--seed') }),
        ...(opts.report === undefined ? {} : { reportDir: fromCwd(String(opts.report)) }),
        ...(opts.baseline === undefined ? {} : { baselineFile: fromCwd(String(opts.baseline)) }),
      })
      // 无 key 的 realistic 档整档跳过：说明白为什么，退出码 0（26 §1）
      if (result.skipped !== undefined) {
        write(`${tier} 档跳过：${result.skipped}\n`)
        return
      }
      for (const report of result.reports) write(`${formatReport(report)}\n`)
      const passed = result.reports.filter((r) => r.passed).length
      write(
        `\n${passed}/${result.reports.length} 场景通过（${result.pack}，${result.tier} 档，${runtime} 运行时）\n`,
      )
      for (const id of result.not_in_tier) write(`（${id} 声明了别的档，本档不跑）\n`)
      if (result.cost !== undefined) {
        write(
          `真模型：${result.cost.model}\n花费：${result.cost.spent.toFixed(4)} / 上限 ${result.cost.cap}` +
            (result.cost.stopped_at === undefined
              ? '\n'
              : `——预算用完，停在 ${result.cost.stopped_at} 之前\n`),
        )
      }
      if (result.gate.ok) {
        write('合并门禁：通过（fast 全过且指标未劣化）\n')
      } else {
        write('合并门禁：不通过\n')
        for (const f of result.gate.failures) write(`  [${f.kind}] ${f.scenario} — ${f.detail}\n`)
      }
      for (const f of result.written) write(`报告：${f}\n`)
      if (!result.gate.ok) process.exitCode = 1
    })

  program
    .command('synth')
    .description('生成合成公司数据集（26 §2）')
    .option('--size <n>', '规模档：3 | 15 | 50（人数、店铺数、岗位表、订单量一起定）', '3')
    .option('--pack <family>', 'pack 家族（dtc-3c | dtc-15p | dtc-50p）；不给就按规模档选')
    .option('--people <n>', '人数（覆盖规模档）')
    .option('--orders <n>', '订单数（覆盖规模档）')
    .option('--seed <n>', 'seed', '42')
    .option('--out <dir>', '输出目录；不给就写 packs/<规模档的 pack 名>')
    .option('--anchor <iso>', '数据集时间原点')
    .option('--clean', '生成前清掉生成器拥有的目录', false)
    .action((opts: Record<string, unknown>) => {
      const size = asInt(String(opts.size), '--size')
      const preset = SIZE_PRESETS[size] ?? SIZE_PRESETS[size >= 50 ? 50 : size >= 15 ? 15 : 3]
      const result = synth({
        size,
        seed: asInt(String(opts.seed), '--seed'),
        out: fromCwd(String(opts.out ?? `packs/${preset?.pack ?? 'dtc-3c-3p'}`)),
        clean: opts.clean === true,
        ...(opts.pack === undefined ? {} : { pack: String(opts.pack) }),
        ...(opts.people === undefined ? {} : { people: asInt(String(opts.people), '--people') }),
        ...(opts.orders === undefined ? {} : { orders: asInt(String(opts.orders), '--orders') }),
        ...(opts.anchor === undefined ? {} : { anchor: String(opts.anchor) }),
      })
      write(`生成 ${result.files.size} 个文件 → ${result.dir}\n`)
      for (const rel of result.files.keys()) write(`  ${rel}\n`)
    })

  program
    .command('replay')
    .description('从事件日志重组 prompt，与 prompt.assembled.hash 比对（17 §6.1）')
    .argument('[run_id]', '运行 id；不给就列出全部')
    .requiredOption('--db <path>', '事件日志 SQLite 文件')
    .action(async (runId: string | undefined, opts: Record<string, unknown>) => {
      const db = fromCwd(String(opts.db))
      if (runId === undefined) {
        const runs = await listRuns(db)
        write(`${runs.length} 次运行：\n`)
        for (const r of runs) write(`  ${r}\n`)
        return
      }
      const result = await replayRun(runId, db)
      write(`${result.ok ? 'OK' : 'MISMATCH'}  ${result.run_id}（${result.events} 条事件）\n`)
      write(`  prompt.assembled.hash = ${result.prompt.expected}\n`)
      write(`  回放重组              = ${result.prompt.actual}\n`)
      for (const item of result.items) {
        write(`  ${item.ok ? '✓' : '✗'} ${item.kind}:${item.item_id}\n`)
      }
      for (const p of result.problems) write(`  ! ${p}\n`)
      if (!result.ok) process.exitCode = 1
    })

  program
    .command('demo')
    .description('用合成世界当后端把工作台跑起来（36 §5.7）；只听回环口')
    .option('--port <n>', '端口', '4317')
    .option('--root <dir>', '仓库根（packs/ 与 apps/workstation/dist 相对它找）')
    .option('--static <dir>', '工作台构建产物目录')
    .action(async (opts: Record<string, unknown>) => {
      const root = opts.root === undefined ? baseDir() : fromCwd(String(opts.root))
      const demo = await createDemo({
        root,
        port: asInt(String(opts.port), '--port'),
        quiet: true,
        ...(opts.static === undefined ? {} : { staticDir: fromCwd(String(opts.static)) }),
      })
      const { url } = await demo.server.listen()
      write(`工作台（合成世界）：${url}\n`)
      write(`身份：${demo.server.bootstrap.person.email}（打开页面自动登录，不用填任何东西）\n`)
      write(`工作区：${demo.server.bootstrap.workspace.id}  场景：${DEMO_SCENARIO}\n`)
      write('Ctrl-C 退出\n')
      // 批准之后由执行器施行（15 §5 通过 ≠ 施行）；每两秒看一次有没有东西要施行
      const timer = setInterval(() => {
        void demo.drain()
      }, 2000)
      const stop = (): void => {
        clearInterval(timer)
        void demo.close().then(() => process.exit(0))
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    })

  return program
}

/** bin 入口。 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram()
  try {
    await program.parseAsync(argv)
  } catch (err) {
    const e = err as { code?: string; message?: string }
    // commander 的 --help / --version 走同一条异常路径，不算失败
    if (e.code === 'commander.helpDisplayed' || e.code === 'commander.help') return
    if (e.code === 'commander.version') return
    process.stderr.write(`agentsws: ${e.message ?? String(err)}\n`)
    process.exitCode = 1
  }
}
