/**
 * WP136（docs/79）：在 Agents 工坊里切换 dsh 场景。
 *
 * 三层：
 * 1. 管理器本身（假的 dsh 启动器 `fixtures/fake-dsh.mjs`，同一条 spawn 路径）：列、建、删、起停、失败；
 * 2. **边界（交付 3）**：其他场景的工作目录不指向我们的数据目录，环境里不带我们的任何密钥，
 *    `DSH_HOME` 永远不是 `~/.dsh`；
 * 3. **真的 dsh**（`@deepseek-ai/dsh@0.1.7-rc.1`，不联网）：建一个自建场景、起官方 `web`、
 *    拿带 token 的网址真的 GET 到 200，再关掉；外加 `/v1/dsh-scenes` 走一遍 HTTP。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDshScenes,
  createServer,
  type DshScenesManager,
  dshHomeOf,
  workspaceProblem,
  workspaceRootOf,
} from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 一台装配了假 dsh 的管理器；数据目录 / 应用目录 / DSH_HOME / 工作区各自独立。 */
function fakeScenes(over: Partial<Parameters<typeof createDshScenes>[0]> = {}): {
  scenes: DshScenesManager
  dshHome: string
  dataDir: string
} {
  const root = temp('agentsws-scenes-')
  const dataDir = join(root, 'app', 'data')
  const dshHome = join(root, 'app', 'dsh')
  mkdirSync(dataDir, { recursive: true })
  const scenes = createDshScenes({
    dshHome,
    workspaceRoot: join(root, 'workspace'),
    protectedDirs: [dataDir, join(root, 'app'), dshHome],
    launcher: { bin: FAKE, version: '0.0.0-fake' },
    baseEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AGENTSWS_SESSION_KEY: 'our-session-key',
      AGENTSWS_SECRETS_KEY: 'our-secrets-key',
      AGENTSWS_DATA_DIR: dataDir,
      OOMOL_CONNECT_ENCRYPTION_KEY: 'our-connect-key',
      OOMOL_CONNECT_ADMIN_TOKEN: 'our-admin-token',
      DEEPSEEK_API_KEY: 'host-deepseek-key',
      DSH_HOME: join(homedir(), '.dsh'),
    },
    startTimeoutMs: 5_000,
    stopTimeoutMs: 3_000,
    ...over,
  })
  cleanups.push(() => scenes.close())
  return { scenes, dshHome, dataDir }
}

describe('列表：Agents 工坊第一个、默认；官方模板都在；自建的在中间', () => {
  it('空的 DSH_HOME', () => {
    const { scenes } = fakeScenes()
    const view = scenes.list()
    expect(view.available).toBe(true)
    expect(view.scenes[0]).toMatchObject({
      name: 'agentsws',
      origin: 'agentsws',
      is_default: true,
      deletable: false,
      state: 'running',
    })
    expect(view.scenes.map((s) => s.name)).toEqual([
      'agentsws',
      'web',
      'headless',
      'sdk',
      'sdk-minimal',
      'acp',
    ])
    expect(view.scenes.filter((s) => s.launchable).map((s) => s.name)).toEqual(['agentsws', 'web'])
    expect(view.scenes.every((s) => s.name === 'agentsws' || !s.deletable)).toBe(true)
    expect(view.templates.map((t) => t.name)).toContain('web')
  })

  it('新建：只建不起，认得出模板；名字不合法 / 保留名 / 重名都拒', async () => {
    const { scenes, dshHome } = fakeScenes()
    const made = await scenes.create({ name: 'coding', template: 'web' })
    expect(made).toMatchObject({
      name: 'coding',
      origin: 'custom',
      surface: 'web',
      template: 'web',
      deletable: true,
      state: 'stopped',
    })
    expect(existsSync(join(dshHome, 'profiles', 'coding', 'package.json'))).toBe(true)
    // 自建的排在官方网页场景之后、命令行类官方场景之前
    expect(
      scenes
        .list()
        .scenes.map((s) => s.name)
        .slice(0, 3),
    ).toEqual(['agentsws', 'web', 'coding'])
    await expect(scenes.create({ name: 'coding', template: 'web' })).rejects.toThrow(/已经有/)
    await expect(scenes.create({ name: 'agentsws', template: 'web' })).rejects.toThrow(/保留/)
    await expect(scenes.create({ name: 'web', template: 'web' })).rejects.toThrow(/保留/)
    await expect(scenes.create({ name: '../x', template: 'web' })).rejects.toThrow(/名字/)
    await expect(scenes.create({ name: 'x', template: 'nope' })).rejects.toThrow(/模板/)
  })
})

describe('起 / 停 / 重启', () => {
  it('网页场景：起来拿到带 token 的网址，真能访问；停了就访问不到', async () => {
    const { scenes } = fakeScenes()
    await scenes.create({ name: 'coding', template: 'web' })
    const opened = await scenes.open('coding')
    expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=fake-token-coding$/)
    expect(opened.scene).toMatchObject({ state: 'running' })
    expect(opened.scene.port).toBeGreaterThan(0)
    expect((await fetch(opened.url)).status).toBe(200)
    // 再点一次 = 同一个进程、同一个网址
    expect((await scenes.open('coding')).url).toBe(opened.url)

    const restarted = await scenes.restart('coding')
    expect(restarted.url).not.toBe('')
    const stopped = await scenes.stop('coding')
    expect(stopped.state).toBe('stopped')
    await expect(fetch(restarted.url)).rejects.toThrow()
  })

  it('起不来：说清楚为什么，状态是 failed', async () => {
    const { scenes } = fakeScenes()
    await scenes.create({ name: 'crashy', template: 'web' })
    await expect(scenes.open('crashy')).rejects.toThrow(/假装起不来/)
    const view = scenes.list().scenes.find((s) => s.name === 'crashy')
    expect(view).toMatchObject({ state: 'failed' })
    expect(view?.error).toContain('假装起不来')
  })

  it('一直不打网址：超时就杀掉', async () => {
    const { scenes } = fakeScenes({ startTimeoutMs: 800 })
    await scenes.create({ name: 'silent', template: 'web' })
    await expect(scenes.open('silent')).rejects.toThrow(/秒内起来/)
  })

  it('Agents 工坊与命令行类场景：打不开也关不掉，说人话', async () => {
    const { scenes } = fakeScenes()
    await expect(scenes.open('agentsws')).rejects.toThrow(/就是这个工作台/)
    await expect(scenes.stop('agentsws')).rejects.toThrow(/就是这个工作台/)
    await expect(scenes.open('headless')).rejects.toThrow(/命令行/)
    await expect(scenes.open('nope')).rejects.toThrow(/没有这个场景/)
  })
})

describe('删除：只删自建的，二次确认，只删 $DSH_HOME/profiles/<name>', () => {
  it('确认名不对不删；删之前先停；官方与 Agents 工坊删不了', async () => {
    const { scenes, dshHome } = fakeScenes()
    await scenes.create({ name: 'coding', template: 'web' })
    const opened = await scenes.open('coding')
    await expect(scenes.remove('coding', 'codin')).rejects.toThrow(/再输入一遍/)
    expect(existsSync(join(dshHome, 'profiles', 'coding'))).toBe(true)

    await scenes.remove('coding', 'coding')
    expect(existsSync(join(dshHome, 'profiles', 'coding'))).toBe(false)
    expect(existsSync(join(dshHome, 'profiles'))).toBe(true)
    await expect(fetch(opened.url)).rejects.toThrow()

    await expect(scenes.remove('web', 'web')).rejects.toThrow(/官方场景不能删/)
    await expect(scenes.remove('agentsws', 'agentsws')).rejects.toThrow(/Agents 工坊不能删/)
  })
})

describe('边界（交付 3）：其他场景够不着我们的数据与密钥', () => {
  it('起网页场景时：工作目录不在也不包含数据目录；环境里没有我们的任何密钥；DSH_HOME 是我们的', async () => {
    const { scenes, dshHome, dataDir } = fakeScenes()
    await scenes.create({ name: 'coding', template: 'web' })
    await scenes.open('coding')
    const seen = JSON.parse(readFileSync(join(dshHome, 'seen-coding.json'), 'utf8')) as {
      env: Record<string, string>
      cwd: string
    }
    // 工作区根：真实进程看到的工作目录
    expect(workspaceProblem(seen.cwd, [dataDir])).toBeUndefined()
    // 环境：我们的四把密钥、数据目录、宿主的 API key 一个都没带过去
    const values = Object.values(seen.env)
    for (const secret of [
      'our-session-key',
      'our-secrets-key',
      'our-connect-key',
      'our-admin-token',
      'host-deepseek-key',
    ])
      expect(values).not.toContain(secret)
    expect(Object.keys(seen.env).filter((k) => /^(AGENTSWS|OOMOL)_/.test(k))).toEqual([])
    expect(values).not.toContain(dataDir)
    // DSH_HOME：我们应用数据目录里那一份，不是宿主给的 ~/.dsh
    expect(seen.env.DSH_HOME).toBe(dshHome)
    expect(seen.env.DSH_HOME).not.toBe(join(homedir(), '.dsh'))
  })

  it('工作区根放进数据目录、或者包含数据目录：不装配', () => {
    const root = temp('agentsws-scenes-ws-')
    const dataDir = join(root, 'data')
    for (const workspaceRoot of [join(dataDir, 'sub'), root]) {
      expect(() =>
        createDshScenes({
          dshHome: join(root, 'dsh'),
          workspaceRoot,
          protectedDirs: [dataDir],
          launcher: { bin: FAKE, version: '0' },
        }),
      ).toThrow(/工作目录/)
    }
  })

  it('DSH_HOME：显式给的优先；否则在数据目录旁边；没有数据目录就没有；永远不是 ~/.dsh', () => {
    expect(dshHomeOf({ AGENTSWS_DSH_HOME: '/app/dsh' }, '/app/data')).toBe('/app/dsh')
    expect(dshHomeOf({}, '/app/data')).toBe('/app/dsh')
    expect(dshHomeOf({}, undefined)).toBeUndefined()
    // 宿主环境里的 DSH_HOME（用户另装的那份 dsh）不算数
    expect(dshHomeOf({ DSH_HOME: join(homedir(), '.dsh') }, '/app/data')).toBe('/app/dsh')
    expect(workspaceRootOf({})).toBe(join(homedir(), 'dsh-workspace'))
    expect(workspaceRootOf({ AGENTSWS_DSH_WORKSPACE: '/w' })).toBe('/w')
  })
})

// ── 真的 dsh（不联网：只起本机网页，不发一条消息） ──────────────────────────────

describe('真的 dsh 0.1.7-rc.1', () => {
  it('建自建场景、起官方 web、GET 到 200、关掉；~/.dsh 一个字节没动', async () => {
    const dotDsh = join(homedir(), '.dsh')
    const before = existsSync(dotDsh) ? statSync(dotDsh).mtimeMs : undefined
    const root = temp('agentsws-real-dsh-')
    const dshHome = join(root, 'app', 'dsh')
    const scenes = createDshScenes({
      dshHome,
      workspaceRoot: join(root, 'workspace'),
      protectedDirs: [join(root, 'app')],
      baseEnv: { PATH: process.env.PATH, HOME: root, DSH_TELEMETRY_DISABLED: '1' },
      startTimeoutMs: 90_000,
    })
    cleanups.push(() => scenes.close())

    expect(scenes.list().dsh_version).toBe('0.1.7-rc.1')
    const made = await scenes.create({ name: 'coding', template: 'web' })
    expect(made).toMatchObject({ origin: 'custom', template: 'web', surface: 'web' })

    const opened = await scenes.open('web')
    expect(opened.scene.state).toBe('running')
    // 带 token 的那一跳发 cookie 再 303 回去；带上 cookie 再取一次就是 200
    const first = await fetch(opened.url, { redirect: 'manual' })
    expect(first.status).toBe(303)
    const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? ''
    const location = new URL(first.headers.get('location') ?? '/', opened.url).toString()
    const page = await fetch(location, { headers: { cookie } })
    expect(page.status).toBe(200)
    // 没 token 没 cookie 的访问被挡在门外
    expect((await fetch(new URL('/', opened.url))).status).toBe(401)

    expect(existsSync(join(dshHome, 'profiles', 'web', 'package.json'))).toBe(true)
    expect((await scenes.stop('web')).state).toBe('stopped')
    const after = existsSync(dotDsh) ? statSync(dotDsh).mtimeMs : undefined
    expect(after).toBe(before)
  }, 120_000)

  it('/v1/dsh-scenes 走一遍 HTTP（本机档装配、托管档不装配）', async () => {
    const root = temp('agentsws-scenes-http-')
    const call = await boot({
      AGENTSWS_DSH_HOME: join(root, 'dsh'),
      AGENTSWS_DSH_WORKSPACE: join(root, 'ws'),
      PATH: process.env.PATH,
    })
    const list = (await (await call('/v1/dsh-scenes')).json()) as {
      data: { available: boolean; scenes: { name: string }[]; dsh_home: string }
    }
    expect(list.data.available).toBe(true)
    expect(list.data.scenes[0]?.name).toBe('agentsws')
    expect(list.data.dsh_home).toBe(join(root, 'dsh'))

    const made = await call('/v1/dsh-scenes', {
      method: 'POST',
      body: JSON.stringify({ name: 'writing', template: 'web' }),
    })
    expect(made.status).toBe(200)
    const bad = await call('/v1/dsh-scenes/headless/open', { method: 'POST' })
    expect(bad.status).toBe(400)
    const noConfirm = await call('/v1/dsh-scenes/writing', { method: 'DELETE' })
    expect(noConfirm.status).toBe(400)
    const del = await call('/v1/dsh-scenes/writing?confirm=writing', { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(existsSync(join(root, 'dsh', 'profiles', 'writing'))).toBe(false)

    // 托管档：列表说「不可用」，动作回 not_implemented
    const hosted = await boot({
      AGENTSWS_RUNTIME_MODE: 'hosted',
      AGENTSWS_DSH_HOME: join(root, 'dsh2'),
    })
    const hostedList = (await (await hosted('/v1/dsh-scenes')).json()) as {
      data: { available: boolean; unavailable_reason: string }
    }
    expect(hostedList.data.available).toBe(false)
    expect(hostedList.data.unavailable_reason).toContain('你自己电脑上')
    expect((await hosted('/v1/dsh-scenes/web/open', { method: 'POST' })).status).toBe(501)
    // 全内存档（没有数据目录、也没给 DSH_HOME）：同样不可用，而且绝不退回 ~/.dsh
    const memory = await boot({})
    const memoryList = (await (await memory('/v1/dsh-scenes')).json()) as {
      data: { available: boolean }
    }
    expect(memoryList.data.available).toBe(false)
  }, 60_000)
})

/** 起一个服务、给所有者一条分配，回一个带好鉴权头的 fetch。 */
async function boot(
  extra: Record<string, string | undefined>,
): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const server = await createServer({
    quiet: true,
    startRun: false,
    scheduleIntervalMs: 0,
    env: {
      AGENTSWS_OWNER_EMAIL: 'owner@example.com',
      AGENTSWS_SECRETS_KEY: 'e'.repeat(64),
      ...extra,
    },
  })
  cleanups.push(() => server.close())
  const { url } = await server.listen(0)
  const owner = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    role_id: 'common.owner',
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
  return (path, init = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${server.bootstrap.internalToken}`,
        'X-Assignment': owner.id,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    })
}
