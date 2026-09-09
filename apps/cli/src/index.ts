/**
 * `agentsws` CLI（26 §5）。
 *
 * - `simulate` 按 glob 跑场景，出报告与合并门禁结论；任一失败退出码非 0
 * - `synth` 生成合成公司数据集（固定 seed 可复现）
 * - `replay` 从事件日志重组 prompt，与 `prompt.assembled.hash` 比对（17 §6.1）
 */

import { isAbsolute, resolve } from 'node:path'
import { formatReport, listRuns, replayRun, runSuite, synth, type Tier } from '@agentsws/simulation'
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
    .option('--write-baseline', '基线不存在时写一份', false)
    .option('--max-regression-pct <n>', '指标劣化阈值（%）', '5')
    .action(async (opts: Record<string, unknown>) => {
      const tier = String(opts.tier) as Tier
      if (!TIERS.includes(tier)) throw new Error(`未知运行档：${String(opts.tier)}`)
      const result = await runSuite({
        packDir: fromCwd(String(opts.pack)),
        scenario: opts.scenario as string[],
        tier,
        maxRegressionPct: asInt(String(opts.maxRegressionPct), '--max-regression-pct'),
        writeBaselineIfMissing: opts.writeBaseline === true,
        ...(opts.scenarioRoot === undefined
          ? {}
          : { scenarioRoot: fromCwd(String(opts.scenarioRoot)) }),
        ...(opts.seed === undefined ? {} : { seed: asInt(String(opts.seed), '--seed') }),
        ...(opts.report === undefined ? {} : { reportDir: fromCwd(String(opts.report)) }),
        ...(opts.baseline === undefined ? {} : { baselineFile: fromCwd(String(opts.baseline)) }),
      })
      for (const report of result.reports) write(`${formatReport(report)}\n`)
      const passed = result.reports.filter((r) => r.passed).length
      write(`\n${passed}/${result.reports.length} 场景通过（${result.pack}，${result.tier} 档）\n`)
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
    .option('--pack <family>', 'pack 家族', 'dtc-3c')
    .option('--people <n>', '人数', '3')
    .option('--orders <n>', '订单数', '50')
    .option('--seed <n>', 'seed', '42')
    .option('--out <dir>', '输出目录', 'packs/dtc-3c-3p')
    .option('--anchor <iso>', '数据集时间原点')
    .option('--clean', '生成前清掉生成器拥有的目录', false)
    .action((opts: Record<string, unknown>) => {
      const result = synth({
        pack: String(opts.pack),
        people: asInt(String(opts.people), '--people'),
        orders: asInt(String(opts.orders), '--orders'),
        seed: asInt(String(opts.seed), '--seed'),
        out: fromCwd(String(opts.out)),
        clean: opts.clean === true,
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
