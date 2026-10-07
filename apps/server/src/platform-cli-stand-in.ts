/**
 * WP245：demo 里「Shopify CLI」卡的**替身**——一键安装 / 一键登录照样能点、能看进度，
 * 但不跑这台机器上任何真的 npm / shopify、不连 npm 源、不打开真的登录页。
 *
 * - 检测：没点过「一键安装」= 没装；装完 = `4.8.5`（工作台自带那份），Node 是捆绑的 22；
 * - 安装：先「下载中」一拍，再一行行打取包进度，最后在临时目录里摆一个空的假包（只为让「装好了」可查）；
 * - 登录：打出确认码与一个 `.test` 域名的假登录网址（永远解析不到），过一会儿「Logged in.」。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProbeExec } from './platform-cli.js'
import type { PlatformCliRunnerOptions, SpawnTool, ToolProcess } from './platform-cli-runner.js'

export interface PlatformCliStandInOptions {
  /** 每一拍多久（毫秒）。 */
  stepMs?: number
  /** 登录等「浏览器」多久才算登好。 */
  loginMs?: number
}

const DEMO_PACKAGES = [
  '@shopify%2fcli',
  '@ast-grep%2fnapi',
  'esbuild',
  'clipboardy',
  'global-agent',
]

function fakeProcess(script: (emit: (line: string) => void) => Promise<number>): ToolProcess {
  const listeners: ((line: string) => void)[] = []
  let killed = false
  let stop: (code: number) => void = () => undefined
  const done = new Promise<number>((resolve) => {
    stop = resolve
    void script((line) => {
      if (!killed) for (const cb of listeners) cb(line)
    }).then((code) => resolve(code))
  })
  return {
    onLine: (cb) => listeners.push(cb),
    write: () => undefined,
    kill: () => {
      killed = true
      stop(143)
    },
    done,
  }
}

export function platformCliStandIn(options: PlatformCliStandInOptions = {}): {
  exec: ProbeExec
  runner: Partial<Omit<PlatformCliRunnerOptions, 'now'>>
} {
  const step = options.stepMs ?? 700
  const loginMs = options.loginMs ?? 20_000
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const toolsDir = mkdtempSync(join(tmpdir(), 'agentsws-demo-tools-'))
  const spawn: SpawnTool = (_command, args) => {
    if (args.includes('install'))
      return fakeProcess(async (emit) => {
        for (const p of DEMO_PACKAGES) {
          await sleep(step)
          emit(`npm http fetch GET 200 https://registry.npmjs.org/${p} 120ms (cache miss)`)
        }
        const prefix = args[args.indexOf('--prefix') + 1] ?? toolsDir
        const dir = join(prefix, 'node_modules', '@shopify', 'cli')
        mkdirSync(join(dir, 'bin'), { recursive: true })
        writeFileSync(join(dir, 'package.json'), '{"bin":{"shopify":"./bin/run.js"}}')
        writeFileSync(join(dir, 'bin', 'run.js'), '')
        emit('added 213 packages in 6s')
        return 0
      })
    return fakeProcess(async (emit) => {
      await sleep(step)
      emit('To run this command, log in to Shopify.')
      emit('User verification code: DEMO-0000')
      emit(
        '👉 Open this link to start the auth process: https://login.example.test/activate?code=DEMO-0000',
      )
      await sleep(loginMs)
      emit('Logged in.')
      return 0
    })
  }
  const exec: ProbeExec = async (bin, args) => {
    if (bin === 'node' || args[0] === '--version') return { ok: true, stdout: 'v22.23.2' }
    if (args[0]?.endsWith('run.js') === true)
      return { ok: true, stdout: 'Current Shopify CLI version: 4.8.5' }
    return { ok: false, stdout: '', missing: true }
  }
  return {
    exec,
    runner: {
      toolsDir,
      spawn,
      npmCli: async (onDownload) => {
        onDownload()
        await sleep(step * 2)
        return join(toolsDir, 'npm-cli.js')
      },
    },
  }
}
