/**
 * WP247：本机连接器的起停（`connect-launcher.ts`）。假子进程 + 内存文件系统，
 * 覆盖 地址从哪来 / 选端口 / 没装不起 / 装好就起（只经 env 给密钥）/ 换版本重启 / 按要求重启 /
 * 要求停 / 崩了退避重启 / 连续崩到上限停在 failed / 状态写进 supervisor.json。
 * 真子进程那一套在 `connect-launcher-live.test.ts`。
 */
import { join } from 'node:path'
import {
  HOST_FILE,
  HOST_SCRIPT,
  localRuntimeLayout,
  parseSupervisorFile,
} from '@agentsws/connect-adapter/local-runtime'
import { describe, expect, it } from 'vitest'
import {
  createLocalConnectLauncher,
  DEFAULT_CONNECT_PORT,
  pickConnectPort,
  planConnectRuntime,
} from '../src/connect-launcher.js'
import { silentLogger } from '../src/logging.js'
import { memoryFileStore } from '../src/node-files.js'
import { fakeClock, fakeSpawner, fakeTimers } from './fakes.js'

describe('地址从哪来（只有两种出处：环境变量 / 本机 sidecar）', () => {
  it('env 显式给了 → 用它，不拉起本机的', () => {
    expect(
      planConnectRuntime({
        env: { AGENTSWS_CONNECT_URL: ' http://10.0.0.2:3000 ' },
        packaged: true,
        remote: false,
      }),
    ).toEqual({ kind: 'external', url: 'http://10.0.0.2:3000' })
  })
  it('打包版默认本机；开发期默认替身，开关打开才走本机；替身逃生口；remote 档什么都不起', () => {
    expect(planConnectRuntime({ env: {}, packaged: true, remote: false })).toEqual({
      kind: 'local',
    })
    expect(planConnectRuntime({ env: {}, packaged: false, remote: false })).toEqual({
      kind: 'stand_in',
    })
    expect(
      planConnectRuntime({
        env: { AGENTSWS_CONNECT_LOCAL_RUNTIME: '1' },
        packaged: false,
        remote: false,
      }),
    ).toEqual({ kind: 'local' })
    expect(
      planConnectRuntime({ env: { AGENTSWS_CONNECT_STANDIN: '1' }, packaged: true, remote: false }),
    ).toEqual({ kind: 'stand_in' })
    expect(
      planConnectRuntime({
        env: { AGENTSWS_CONNECT_URL: 'http://x' },
        packaged: true,
        remote: true,
      }),
    ).toEqual({ kind: 'none' })
  })
})

describe('选端口', () => {
  it('上次那个空着就用它；占了往后找；十个都占了让系统给', async () => {
    const osPort = async () => 55555
    expect(await pickConnectPort({ preferred: 0, isFree: async () => true, osPort })).toBe(
      DEFAULT_CONNECT_PORT,
    )
    expect(
      await pickConnectPort({ preferred: 43200, isFree: async (p) => p === 43202, osPort }),
    ).toBe(43202)
    expect(await pickConnectPort({ preferred: 43200, isFree: async () => false, osPort })).toBe(
      55555,
    )
  })
})

const DATA = '/u/data'
const L = localRuntimeLayout(DATA)
const PKG = join(
  L.versionDir('1.8.0'),
  'node_modules',
  '@oomol-lab',
  'open-connector',
  'package.json',
)

function rig(seed: Record<string, string> = {}) {
  const files = memoryFileStore(seed)
  const spawner = fakeSpawner()
  const timers = fakeTimers()
  const clock = fakeClock()
  const launcher = createLocalConnectLauncher({
    dataDir: DATA,
    port: 43170,
    nodeExec: '/app/node/bin/node',
    secrets: () => ({ encryptionKey: 'ENC-KEY', adminToken: 'ADMIN-TOKEN' }),
    baseEnv: { PATH: '/bin', OOMOL_CONNECT_ADMIN_TOKEN: 'leak-from-host', HTTPS_PROXY: 'http://p' },
    files,
    spawner,
    timers,
    clock,
    logger: silentLogger(),
    maxAttempts: 2,
    stableAfterMs: 1000,
    backoff: { baseMs: 10, maxMs: 10, jitter: 0 },
    redact: (s) => s.replaceAll('ADMIN-TOKEN', '***'),
  })
  const supervisor = () => parseSupervisorFile(JSON.parse(files.readText(L.supervisor) ?? 'null'))
  const install = (version = '1.8.0') => {
    files.writeText(
      join(L.versionDir(version), 'node_modules', '@oomol-lab', 'open-connector', 'package.json'),
      '{}',
    )
    files.writeText(L.current, JSON.stringify({ version }))
  }
  const control = (desired: 'run' | 'stop', restart_seq: number) =>
    files.writeText(L.control, JSON.stringify({ desired, restart_seq }))
  return { files, spawner, timers, launcher, supervisor, install, control }
}

describe('起停', () => {
  it('没下载：不起；下载好了：起，宿主脚本写进版本目录，密钥只经 env、只听 127.0.0.1 的那个端口', async () => {
    const r = rig()
    await r.launcher.start()
    expect(r.spawner.requests).toHaveLength(0)
    r.install()
    r.launcher.tick()
    expect(r.spawner.requests).toHaveLength(1)
    const req = r.spawner.requests[0]
    expect(req?.command).toBe('/app/node/bin/node')
    expect(req?.args).toEqual([join(L.versionDir('1.8.0'), HOST_FILE)])
    expect(req?.cwd).toBe(L.versionDir('1.8.0'))
    expect(req?.stopViaStdin).toBe(true)
    expect(req?.env).toMatchObject({
      AGENTSWS_OC_PORT: '43170',
      OOMOL_CONNECT_DATA_DIR: L.data,
      OOMOL_CONNECT_ENCRYPTION_KEY: 'ENC-KEY',
      // 宿主环境里漏进来的同名变量不算数，只认壳的钥匙串
      OOMOL_CONNECT_ADMIN_TOKEN: 'ADMIN-TOKEN',
      OOMOL_CONNECT_BLOCKED_PROXIES: '*',
      NODE_USE_ENV_PROXY: '1',
      PATH: '/bin',
    })
    // 密钥不在参数里
    expect(req?.args.join(' ')).not.toContain('ENC-KEY')
    expect(r.files.readText(join(L.versionDir('1.8.0'), HOST_FILE))).toBe(HOST_SCRIPT)
    expect(r.supervisor()).toMatchObject({ state: 'starting', version: '1.8.0', port: 43170 })
    expect(r.launcher.snapshot()).toMatchObject({ state: 'starting', version: '1.8.0' })
    expect(r.launcher.url).toBe('http://127.0.0.1:43170')
    expect(r.launcher.mode).toBe('npm')
  })

  it('current.json 在但程序文件被删了：当没装', () => {
    const r = rig({ [L.current]: JSON.stringify({ version: '1.8.0' }) })
    r.launcher.tick()
    expect(r.spawner.requests).toHaveLength(0)
    r.files.writeText(PKG, '{}')
    r.launcher.tick()
    expect(r.spawner.requests).toHaveLength(1)
  })

  it('换版本（升级 / 回退）→ 停旧的、起新的', () => {
    const r = rig()
    r.install('1.8.0')
    r.launcher.tick()
    r.install('1.9.0')
    r.launcher.tick()
    expect(r.spawner.children[0]?.killed).toEqual(['SIGTERM'])
    r.spawner.children[0]?.exit(0)
    expect(r.spawner.requests.at(-1)?.cwd).toBe(L.versionDir('1.9.0'))
    expect(r.launcher.snapshot().version).toBe('1.9.0')
  })

  it('「重启」：restart_seq 变了才重启一次；启动时看到的旧次数不算', () => {
    const r = rig()
    r.install()
    r.control('run', 5)
    r.launcher.tick()
    r.launcher.tick()
    expect(r.spawner.requests).toHaveLength(1)
    r.control('run', 6)
    r.launcher.tick()
    r.spawner.children[0]?.exit(0)
    expect(r.spawner.requests).toHaveLength(2)
    r.launcher.tick()
    expect(r.spawner.requests).toHaveLength(2)
  })

  it('要求停（删除下载前）→ 停；又要跑 → 再起', () => {
    const r = rig()
    r.install()
    r.launcher.tick()
    r.control('stop', 0)
    r.launcher.tick()
    r.spawner.children[0]?.exit(0)
    expect(r.supervisor()).toMatchObject({ state: 'stopped' })
    expect(r.supervisor()?.pid).toBeUndefined()
    r.control('run', 0)
    r.launcher.tick()
    expect(r.spawner.requests).toHaveLength(2)
  })

  it('崩了：退避重启；连续崩到上限停在 failed（带最后一行错误，密钥遮掉），等人点重启', () => {
    const r = rig()
    r.install()
    r.launcher.tick()
    r.spawner.children[0]?.emitStderr('boom ADMIN-TOKEN\n')
    r.spawner.children[0]?.exit(1)
    expect(r.supervisor()).toMatchObject({ state: 'backoff', attempts: 1, last_error: 'boom ***' })
    r.timers.runNext()
    expect(r.spawner.requests).toHaveLength(2)
    r.spawner.children[1]?.exit(1)
    r.timers.runNext()
    r.spawner.children[2]?.exit(1)
    expect(r.supervisor()?.state).toBe('failed')
    // failed 不自己硬拉
    r.launcher.tick()
    expect(r.spawner.requests).toHaveLength(3)
    // 人点了重启
    r.control('run', 1)
    r.launcher.tick()
    expect(r.spawner.requests).toHaveLength(4)
  })

  it('stop()：停定时器、停子进程；之后 tick 不会再起', async () => {
    const r = rig()
    r.install()
    await r.launcher.start()
    await r.launcher.start()
    expect(r.spawner.requests).toHaveLength(1)
    await r.launcher.stop()
    expect(r.spawner.children[0]?.killed).toEqual(['SIGTERM'])
    expect(r.timers.pending()).toBeGreaterThanOrEqual(0)
    r.spawner.children[0]?.exit(0)
    expect(r.launcher.snapshot().state).toBe('stopped')
  })

  it('轮询：每 pollMs 看一眼', async () => {
    const r = rig()
    await r.launcher.start()
    r.install()
    r.timers.runNext()
    expect(r.spawner.requests).toHaveLength(1)
  })
})
