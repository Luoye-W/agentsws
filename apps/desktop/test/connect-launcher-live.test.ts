/**
 * WP247：真子进程端到端——**真的宿主脚本**（`HOST_SCRIPT`）+ 真的监督者 + 真的 127.0.0.1 端口，
 * 只有上游两个包是假的（写进临时版本目录的小 ESM 包：`@oomol-lab/open-connector` 答加固检查要的
 * 两个接口，`@hono/node-server` 用 `node:http` 把请求转给它）。覆盖：
 * 起来后加固检查通过（ready）/ 崩了自己重启又 ready / 加固不过（unhardened）/
 * 缺密钥拒绝启动、连续失败停在 failed / 关 stdin 收尾退出。不联网、不碰任何已有服务。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertRuntimeHardened } from '@agentsws/connect-adapter'
import { localRuntimeLayout, parseSupervisorFile } from '@agentsws/connect-adapter/local-runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalConnectLauncher, type LocalConnectLauncher } from '../src/connect-launcher.js'
import { classify } from '../src/connect-runtime.js'
import { silentLogger } from '../src/logging.js'
import { nodeFileStore } from '../src/node-files.js'
import {
  nodeSpawner,
  nodeTimers,
  osFreePort,
  portIsFree,
  systemClock,
} from '../src/node-runtime.js'

const FAKE_RUNTIME = `
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export async function createConnectorRuntime(opts) {
  // 只记「给没给」，不记值
  writeFileSync(join(opts.dataDir, 'opts.json'), JSON.stringify({
    encryptionKey: typeof opts.encryptionKey === 'string' && opts.encryptionKey.length > 0,
    adminToken: typeof opts.adminToken === 'string' && opts.adminToken.length > 0,
    runtimeToken: typeof opts.runtimeToken === 'string' && opts.runtimeToken.length > 0,
    blockedProxies: opts.actionPolicy?.blockedProxies ?? [],
    publicOrigin: opts.publicOrigin,
  }))
  return {
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/crash') process.exit(3)
      const open = existsSync(join(opts.dataDir, 'open.flag'))
      const authed = (request.headers.get('authorization') ?? '') !== ''
      if (!open && !authed) return new Response('{"error":"unauthorized"}', { status: 401 })
      return Response.json(url.pathname === '/v1/health' ? { ok: true } : [])
    },
    close: async () => { writeFileSync(join(opts.dataDir, 'closed.flag'), 'yes') },
  }
}
`

const FAKE_HONO = `
import http from 'node:http'
export function serve({ fetch, port, hostname }, onListen) {
  const server = http.createServer(async (req, res) => {
    const response = await fetch(new Request('http://' + hostname + ':' + port + req.url, { method: req.method, headers: req.headers }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  server.listen(port, hostname, () => onListen({ port }))
  return server
}
`

const dirs: string[] = []
const launchers: LocalConnectLauncher[] = []
afterEach(async () => {
  for (const l of launchers.splice(0)) await l.stop()
  await new Promise((r) => setTimeout(r, 200))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fakePkg(dir: string, name: string, source: string): void {
  const pkg = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name, version: '1.8.0', type: 'module', exports: './index.js' }),
  )
  writeFileSync(join(pkg, 'index.js'), source)
}

async function machine(opts: { encryptionKey?: string; maxAttempts?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wp247-live-'))
  dirs.push(root)
  const dataDir = join(root, 'data')
  const layout = localRuntimeLayout(dataDir)
  const dir = layout.versionDir('1.8.0')
  fakePkg(dir, '@oomol-lab/open-connector', FAKE_RUNTIME)
  fakePkg(dir, '@hono/node-server', FAKE_HONO)
  writeFileSync(layout.current, JSON.stringify({ version: '1.8.0' }))
  const port = await osFreePort()
  const secrets = {
    encryptionKey: opts.encryptionKey ?? 'e'.repeat(64),
    adminToken: 'a'.repeat(64),
  }
  const launcher = createLocalConnectLauncher({
    dataDir,
    port,
    nodeExec: process.execPath,
    secrets: () => secrets,
    baseEnv: { PATH: process.env.PATH ?? '' },
    files: nodeFileStore(),
    spawner: nodeSpawner(),
    timers: nodeTimers(),
    clock: systemClock,
    logger: silentLogger(),
    pollMs: 50,
    stableAfterMs: 300,
    maxAttempts: opts.maxAttempts ?? 5,
    backoff: { baseMs: 50, maxMs: 100, jitter: 0 },
  })
  launchers.push(launcher)
  const hardened = () =>
    assertRuntimeHardened(launcher.url, {
      env: {
        OOMOL_CONNECT_ENCRYPTION_KEY: secrets.encryptionKey,
        OOMOL_CONNECT_ADMIN_TOKEN: secrets.adminToken,
        OOMOL_CONNECT_BLOCKED_PROXIES: '*',
      },
      timeoutMs: 1000,
    })
  const supervisor = () => {
    try {
      return parseSupervisorFile(JSON.parse(readFileSync(layout.supervisor, 'utf8')))
    } catch {
      return undefined
    }
  }
  return { launcher, layout, port, hardened, supervisor }
}

async function until<T>(probe: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000) {
  const end = Date.now() + ms
  let last: T = await probe()
  while (!ok(last)) {
    if (Date.now() > end) throw new Error(`等不到：${JSON.stringify(last)}`)
    await new Promise((r) => setTimeout(r, 50))
    last = await probe()
  }
  return last
}

describe('本机连接器：真宿主脚本 + 真监督者', { timeout: 40_000 }, () => {
  it('起来 → 加固检查通过；宿主收到了两把密钥、派生的 /v1 令牌、proxy 全封；只听 127.0.0.1', async () => {
    const m = await machine()
    await m.launcher.start()
    const report = await until(m.hardened, (r) => r.ok)
    expect(classify(report)).toBe('ready')
    const got = JSON.parse(readFileSync(join(m.layout.data, 'opts.json'), 'utf8'))
    expect(got).toEqual({
      encryptionKey: true,
      adminToken: true,
      runtimeToken: true,
      blockedProxies: ['*'],
      publicOrigin: `http://127.0.0.1:${m.port}`,
    })
    await until(m.supervisor, (s) => s?.state === 'running')
    // 关 stdin 请它收尾：runtime.close() 跑到了、进程退了、端口空出来
    await m.launcher.stop()
    await until(m.supervisor, (s) => s?.state === 'stopped' && s.pid === undefined)
    expect(readFileSync(join(m.layout.data, 'closed.flag'), 'utf8')).toBe('yes')
    expect(
      await until(
        () => portIsFree(m.port),
        (free) => free,
      ),
    ).toBe(true)
  })

  it('崩了：监督者退避重启，又能通过加固检查', async () => {
    const m = await machine()
    await m.launcher.start()
    await until(m.hardened, (r) => r.ok)
    const firstPid = m.launcher.snapshot().pid
    await fetch(`${m.launcher.url}/crash`, { headers: { authorization: 'Bearer x' } }).catch(
      () => undefined,
    )
    await until(m.launcher.snapshot, (s) => s.pid !== undefined && s.pid !== firstPid)
    expect((await until(m.hardened, (r) => r.ok)).ok).toBe(true)
    expect(m.supervisor()?.last_exit?.code).toBe(3)
  })

  it('加固不过（匿名能读）→ unhardened，不算就绪', async () => {
    const m = await machine()
    mkdirSync(m.layout.data, { recursive: true })
    writeFileSync(join(m.layout.data, 'open.flag'), '1')
    await m.launcher.start()
    const report = await until(m.hardened, (r) => !r.reasons.includes('runtime_unreachable'))
    expect(classify(report)).toBe('unhardened')
    expect(report.reasons).toContain('runtime_auth_disabled')
  })

  it('缺加密主密钥：宿主拒绝启动（78），连续失败停在 failed，最后一行错误报上去', async () => {
    const m = await machine({ encryptionKey: '', maxAttempts: 1 })
    await m.launcher.start()
    const s = await until(m.supervisor, (x) => x?.state === 'failed')
    expect(s?.last_exit?.code).toBe(78)
    expect(s?.last_error).toContain('OOMOL_CONNECT_ENCRYPTION_KEY')
    expect(classify(await m.hardened())).toBe('absent')
  })
})
