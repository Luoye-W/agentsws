/**
 * WP247：本机连接器按需下载。假 npm 是真脚本、真子进程（`fixtures/fake-oc-npm.ts`），
 * 覆盖 首次下载（进度、落位、宿主脚本、清缓存、真 import 冒烟）/ 取消 / 网络失败再重试 / 校验不对 /
 * 升级留一版可回退 / 删除下载只删我们那份 / 重启只是改控制文件。不联网。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOST_FILE,
  OPEN_CONNECTOR_PIN,
  type OpenConnectorLockfile,
  parseControlFile,
  parseCurrentFile,
} from '@agentsws/connect-adapter'
import { afterEach, describe, expect, it } from 'vitest'
import { NpmRuntimeError } from '../src/npm-runtime.js'
import {
  createOpenConnectorInstaller,
  type LocalRuntimeSnapshot,
  localStatus,
  type OpenConnectorInstaller,
  writeJsonAtomic,
} from '../src/open-connector-installer.js'
import { type FakeOcNpmMode, writeFakeOcNpm } from './fixtures/fake-oc-npm.js'

const LOCK: OpenConnectorLockfile = {
  name: 'agentsws-open-connector-host',
  lockfileVersion: 3,
  packages: {
    '': { name: 'agentsws-open-connector-host' },
    'node_modules/a': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/a',
      integrity: 'x',
    },
    'node_modules/b': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/b',
      integrity: 'x',
    },
    'node_modules/c': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/c',
      integrity: 'x',
    },
    'node_modules/d': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/d',
      integrity: 'x',
    },
  },
}

const dirs: string[] = []
const installers: OpenConnectorInstaller[] = []
afterEach(() => {
  for (const i of installers.splice(0)) i.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function machine(opts: { mode?: FakeOcNpmMode; version?: string; realVerify?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wp247-'))
  dirs.push(root)
  const npm = writeFakeOcNpm(root, opts.mode ?? 'ok')
  const dataDir = join(root, 'data')
  let npmCli: (onDownload: () => void) => Promise<string> = async () => npm.npmCli
  const make = (version = opts.version ?? OPEN_CONNECTOR_PIN.version): OpenConnectorInstaller => {
    npm.setVersion(version)
    const installer = createOpenConnectorInstaller({
      dataDir,
      now: () => new Date().toISOString(),
      env: { PATH: '/usr/bin:/bin', HOME: root },
      npmCli: (d) => npmCli(d),
      pin: { ...OPEN_CONNECTOR_PIN, version },
      lockfile: LOCK,
      ...(opts.realVerify === true ? {} : { verify: async () => undefined }),
      stopWaitMs: 1000,
      sleep: async () => undefined,
    })
    installers.push(installer)
    return installer
  }
  return {
    root,
    dataDir,
    npm,
    make,
    setNpmCli: (f: typeof npmCli) => {
      npmCli = f
    },
  }
}

async function settle(i: OpenConnectorInstaller): Promise<LocalRuntimeSnapshot> {
  for (let n = 0; n < 400; n += 1) {
    const s = i.snapshot()
    if (s.job === undefined || !['preparing', 'downloading', 'verifying'].includes(s.job.phase))
      return s
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('下载没结束')
}

const calls = (dir: string): { args: string[]; cwd: string; lock: boolean }[] =>
  readFileSync(join(dir, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { args: string[]; cwd: string; lock: boolean })

describe('首次下载', () => {
  it('npm ci 按锁文件装进暂存目录 → 进度满格 → 真 import 冒烟 → 落位成 <版本>，缓存删掉', async () => {
    const m = machine({ realVerify: true })
    const i = m.make()
    expect(i.snapshot()).toMatchObject({ update_available: false, desired: 'run' })
    expect(i.snapshot().installed).toBeUndefined()
    const started = i.install()
    expect(started).toMatchObject({ phase: 'preparing', fetched: 0, total: 4 })
    const s = await settle(i)
    expect(s.job).toMatchObject({ phase: 'done', fetched: 4, total: 4 })
    expect(s.installed).toBe(OPEN_CONNECTOR_PIN.version)
    const dir = i.layout.versionDir(OPEN_CONNECTOR_PIN.version)
    expect(existsSync(join(dir, HOST_FILE))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))).toEqual(LOCK)
    expect(parseCurrentFile(JSON.parse(readFileSync(i.layout.current, 'utf8')))).toMatchObject({
      version: OPEN_CONNECTOR_PIN.version,
    })
    expect(existsSync(i.layout.cache)).toBe(false)
    // 不跑任何安装脚本；缓存指到我们自己的目录；锁文件在场
    const [call] = calls(m.npm.dir)
    expect(call?.args.slice(0, 2)).toEqual(['ci', '--omit=dev'])
    expect(call?.args).toContain('--ignore-scripts')
    expect(call?.args).toContain(i.layout.cache)
    expect(call?.lock).toBe(true)
    // 暂存目录都清干净了
    expect(readdir(i.layout.root).filter((n) => n.startsWith('.staging-'))).toEqual([])
    // 已经是这一版：再点一次是冲突
    expect(() => i.install()).toThrow(/已经装好/)
  })

  it('冒烟不过（装出来的包 import 不了）→ 失败，不落位', async () => {
    const m = machine({ realVerify: true })
    const i = m.make()
    m.npm.setMode('broken')
    i.install()
    const s = await settle(i)
    expect(s.job?.phase).toBe('failed')
    expect(s.installed).toBeUndefined()
  })
})

const readdir = (p: string): string[] => {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

describe('取消 / 失败 / 重试', () => {
  it('下到一半取消：npm 被杀掉，暂存目录清掉，什么都没装', async () => {
    const m = machine({ mode: 'slow' })
    const i = m.make()
    i.install()
    // 等假 npm 真的起来、打出第一行
    for (let n = 0; n < 200 && (i.snapshot().job?.fetched ?? 0) === 0; n += 1)
      await new Promise((r) => setTimeout(r, 25))
    expect(i.snapshot().job).toMatchObject({ phase: 'downloading', fetched: 1 })
    expect(i.cancel()?.phase).toBe('downloading')
    const s = await settle(i)
    expect(s.job?.phase).toBe('cancelled')
    expect(s.installed).toBeUndefined()
    await new Promise((r) => setTimeout(r, 50))
    expect(readdir(i.layout.root).filter((n) => n.startsWith('.staging-'))).toEqual([])
  })

  it('网络不通（npm error code ENOTFOUND）→ network + 原始码；修好网再点一次就装上', async () => {
    const m = machine({ mode: 'enotfound' })
    const i = m.make()
    i.install()
    const failed = await settle(i)
    expect(failed.job).toMatchObject({
      phase: 'failed',
      error: { code: 'network', detail: 'ENOTFOUND' },
    })
    expect(failed.installed).toBeUndefined()
    m.npm.setMode('ok')
    i.install()
    const ok = await settle(i)
    expect(ok.job?.phase).toBe('done')
    expect(ok.installed).toBe(OPEN_CONNECTOR_PIN.version)
  })

  it('下 npm 那一步就断网（WP242 cause.code）→ network', async () => {
    const m = machine()
    const i = m.make()
    m.setNpmCli(async (onDownload) => {
      onDownload()
      throw new NpmRuntimeError('network', '下载 npm 失败', {
        cause: Object.assign(new Error('getaddrinfo EAI_AGAIN registry.npmjs.org'), {
          code: 'EAI_AGAIN',
        }),
      })
    })
    i.install()
    const s = await settle(i)
    expect(s.job).toMatchObject({
      phase: 'failed',
      error: { code: 'network', detail: 'EAI_AGAIN' },
    })
  })

  it('校验不对（EINTEGRITY / 装出来的版本不对）→ integrity，不落位', async () => {
    const m = machine({ mode: 'eintegrity' })
    const i = m.make()
    i.install()
    expect((await settle(i)).job?.error?.code).toBe('integrity')
    m.npm.setMode('wrong_version')
    i.install()
    const s = await settle(i)
    expect(s.job?.error).toMatchObject({ code: 'integrity', detail: 'version 0.0.1' })
    expect(s.installed).toBeUndefined()
  })

  it('同时只下一份', () => {
    const m = machine({ mode: 'slow' })
    const i = m.make()
    i.install()
    expect(() => i.install()).toThrow(/已经在下载/)
  })
})

describe('升级、回退、重启、删除下载', () => {
  it('升级：新版落位，上一版留一份可回退，更早的删掉；回退就是把 current 换回去', async () => {
    const m = machine()
    for (const v of ['1.6.0', '1.7.0', '1.8.0']) {
      const i = m.make(v)
      i.install()
      expect((await settle(i)).job?.phase).toBe('done')
    }
    const i = m.make('1.8.0')
    const s = i.snapshot()
    expect(s).toMatchObject({ installed: '1.8.0', previous: '1.7.0', update_available: false })
    expect(existsSync(i.layout.versionDir('1.6.0'))).toBe(false)
    // 代码里钉的是 1.9.0 时：装着的 1.8.0 算「有新版」
    expect(m.make('1.9.0').snapshot().update_available).toBe(true)
    i.rollback()
    expect(i.snapshot()).toMatchObject({ installed: '1.7.0', previous: '1.8.0' })
  })

  it('没有上一版不能回退；没装不能重启', () => {
    const i = machine().make()
    expect(() => i.rollback()).toThrow(/上一版/)
    expect(() => i.restart()).toThrow(/还没下载/)
  })

  it('重启 = 控制文件里的次数 +1（桌面壳看到就重启一次）', async () => {
    const m = machine()
    const i = m.make()
    i.install()
    await settle(i)
    i.restart()
    i.restart()
    expect(parseControlFile(JSON.parse(readFileSync(i.layout.control, 'utf8')))).toMatchObject({
      desired: 'run',
      restart_seq: 2,
    })
  })

  it('删除下载：先请壳停、等它报「停了」，再只删 open-connector；连接数据目录不动', async () => {
    const m = machine()
    const i = m.make()
    i.install()
    await settle(i)
    mkdirSync(i.layout.data, { recursive: true })
    writeFileSync(join(i.layout.data, 'connect.sqlite'), 'x')
    writeJsonAtomic(i.layout.supervisor, { state: 'running', pid: 42, port: 1, attempts: 0 })
    let polled = 0
    const i2 = createOpenConnectorInstaller({
      dataDir: m.dataDir,
      now: () => 't',
      verify: async () => undefined,
      stopWaitMs: 5000,
      sleep: async () => {
        polled += 1
        // 壳读到 desired=stop 之后把它停了
        const control = parseControlFile(JSON.parse(readFileSync(i.layout.control, 'utf8')))
        if (control?.desired === 'stop')
          writeJsonAtomic(i.layout.supervisor, { state: 'stopped', port: 1, attempts: 0 })
      },
    })
    await i2.remove()
    expect(polled).toBeGreaterThan(0)
    expect(existsSync(i.layout.root)).toBe(false)
    expect(readFileSync(join(i.layout.data, 'connect.sqlite'), 'utf8')).toBe('x')
    expect(i2.snapshot().installed).toBeUndefined()
  })

  it('壳一直停不下来：不删，回 busy', async () => {
    const m = machine()
    const i = m.make()
    i.install()
    await settle(i)
    writeJsonAtomic(i.layout.supervisor, { state: 'running', pid: 42, port: 1, attempts: 0 })
    await expect(i.remove()).rejects.toThrow(/没能停下来/)
    expect(i.snapshot().installed).toBe(OPEN_CONNECTOR_PIN.version)
  })
})

describe('顶上那一行（localStatus）', () => {
  const base: LocalRuntimeSnapshot = {
    version: '1.8.0',
    download_bytes: 1,
    update_available: false,
    desired: 'run',
  }
  const sup = (state: 'starting' | 'running' | 'backoff' | 'failed' | 'stopped', attempts = 0) => ({
    state,
    attempts,
    port: 1,
    updated_at: '',
  })
  it.each([
    ['没下载', base, 'absent', 'not_installed'],
    [
      '下载中',
      {
        ...base,
        job: { phase: 'downloading', version: '1', started_at: '', fetched: 1, total: 2 },
      },
      'absent',
      'downloading',
    ],
    [
      '下载失败',
      { ...base, job: { phase: 'failed', version: '1', started_at: '', fetched: 1, total: 2 } },
      'absent',
      'error',
    ],
    ['装好、壳还没报', { ...base, installed: '1.8.0' }, 'absent', 'starting'],
    [
      '起着、加固过了',
      { ...base, installed: '1.8.0', supervisor: sup('running') },
      'ready',
      'ready',
    ],
    [
      '起着、加固不过',
      { ...base, installed: '1.8.0', supervisor: sup('running') },
      'unhardened',
      'error',
    ],
    [
      '起着、还探不到',
      { ...base, installed: '1.8.0', supervisor: sup('running') },
      'absent',
      'starting',
    ],
    ['反复崩', { ...base, installed: '1.8.0', supervisor: sup('backoff', 3) }, 'absent', 'error'],
    [
      '崩一次在退避',
      { ...base, installed: '1.8.0', supervisor: sup('backoff', 1) },
      'absent',
      'starting',
    ],
    ['放弃了', { ...base, installed: '1.8.0', supervisor: sup('failed') }, 'absent', 'error'],
    ['壳报停着', { ...base, installed: '1.8.0', supervisor: sup('stopped') }, 'absent', 'stopped'],
    ['要求停', { ...base, installed: '1.8.0', desired: 'stop' }, 'absent', 'stopped'],
  ] as const)('%s', (_name, snapshot, hardened, expected) => {
    expect(localStatus(snapshot as LocalRuntimeSnapshot, hardened)).toBe(expected)
  })
})
