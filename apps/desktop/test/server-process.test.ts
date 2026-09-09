import { describe, expect, it } from 'vitest'
import { generateSecrets, secretLiterals } from '../src/secrets.js'
import {
  INHERITED_ENV,
  inheritEnv,
  resolveServerEntry,
  resolveServerRuntime,
  type ServerSpawnInput,
  serverSpawnRequest,
} from '../src/server-process.js'
import { seqRandomBytes } from './fakes.js'

const secrets = generateSecrets(seqRandomBytes())

const input = (patch: Partial<ServerSpawnInput> = {}): ServerSpawnInput => ({
  runtime: { kind: 'electron', execPath: '/Applications/agentsws.app/Contents/MacOS/agentsws' },
  entry: '/opt/server/dist/index.js',
  port: 4317,
  dataDir: '/data',
  halt: [],
  secrets,
  version: '0.1.0',
  baseEnv: { PATH: '/usr/bin', HOME: '/Users/x' },
  ...patch,
})

describe('inheritEnv', () => {
  it('只取白名单里存在的变量', () => {
    expect(inheritEnv({ PATH: '/bin', DEEPSEEK_API_KEY: 'sk-live', NOPE: '1' })).toEqual({
      PATH: '/bin',
    })
  })

  it('白名单可以换（测试用）', () => {
    expect(inheritEnv({ A: '1', B: '2' }, ['A'])).toEqual({ A: '1' })
  })

  it('白名单覆盖三个平台的必需变量', () => {
    expect(INHERITED_ENV).toContain('PATH')
    expect(INHERITED_ENV).toContain('SystemRoot')
    expect(INHERITED_ENV).toContain('APPDATA')
  })
})

describe('serverSpawnRequest', () => {
  it('打包后用 Electron 自带 Node（13 §5）', () => {
    const request = serverSpawnRequest(input())
    expect(request.command).toBe('/Applications/agentsws.app/Contents/MacOS/agentsws')
    expect(request.args).toEqual(['/opt/server/dist/index.js'])
    expect(request.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('开发期用独立 Node，就不该设 ELECTRON_RUN_AS_NODE', () => {
    const request = serverSpawnRequest(
      input({ runtime: { kind: 'node', execPath: '/usr/local/bin/node' } }),
    )
    expect(request.command).toBe('/usr/local/bin/node')
    expect(request.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('端口、数据目录、版本号都经环境变量给（apps/server 就读这几个）', () => {
    const request = serverSpawnRequest(input({ port: 0 }))
    expect(request.env.AGENTSWS_PORT).toBe('0')
    expect(request.env.AGENTSWS_DB_DIR).toBe('/data')
    expect(request.env.AGENTSWS_VERSION).toBe('0.1.0')
  })

  it('密钥只走环境变量，且默认封死 proxy', () => {
    const env = serverSpawnRequest(input()).env
    expect(env.OOMOL_CONNECT_ADMIN_TOKEN).toBe(secrets.connectAdminToken)
    expect(env.OOMOL_CONNECT_BLOCKED_PROXIES).toBe('*')
    expect(env.AGENTSWS_SESSION_KEY).toBe(secrets.serverSessionKey)
  })

  it('宿主环境里别人的密钥不会漏进子进程', () => {
    const env = serverSpawnRequest(
      input({
        baseEnv: {
          PATH: '/bin',
          DEEPSEEK_API_KEY: 'sk-someone-elses',
          OOMOL_CONNECT_ADMIN_TOKEN: 'stale-token',
        },
      }),
    ).env
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.OOMOL_CONNECT_ADMIN_TOKEN).toBe(secrets.connectAdminToken)
  })

  it('急停档位跟着走（托盘"暂停"→ 重启即生效）', () => {
    expect(serverSpawnRequest(input()).env.AGENTSWS_HALT).toBeUndefined()
    expect(serverSpawnRequest(input({ halt: ['all'] })).env.AGENTSWS_HALT).toBe('all')
  })

  it('cwd 可选', () => {
    expect(serverSpawnRequest(input()).cwd).toBeUndefined()
    expect(serverSpawnRequest(input({ cwd: '/opt' })).cwd).toBe('/opt')
  })

  it('三把密钥都能在 env 里找到（脱敏器需要它们的字面量）', () => {
    const env = serverSpawnRequest(input()).env
    const flat = Object.values(env).join(' ')
    for (const literal of secretLiterals(secrets)) expect(flat).toContain(literal)
  })
})

describe('resolveServerRuntime', () => {
  const base = {
    env: {},
    resourcesPath: undefined,
    exists: () => false,
    electronExecPath: '/App/agentsws',
  }

  it('默认走 PATH 上的 node（13 §5「不够则用独立打包的 Node」）', () => {
    expect(resolveServerRuntime(base)).toEqual({ kind: 'node', execPath: 'node' })
  })

  it('AGENTSWS_NODE 指定就用它', () => {
    expect(
      resolveServerRuntime({ ...base, env: { AGENTSWS_NODE: '/opt/node22/bin/node' } }),
    ).toEqual({ kind: 'node', execPath: '/opt/node22/bin/node' })
    // 空串当没设
    expect(resolveServerRuntime({ ...base, env: { AGENTSWS_NODE: '' } }).execPath).toBe('node')
  })

  it('安装包里带了 node 就用随包那份', () => {
    expect(
      resolveServerRuntime({ ...base, resourcesPath: '/App/Resources', exists: () => true }),
    ).toEqual({ kind: 'node', execPath: '/App/Resources/node' })
    // 带了目录但里面没有 node
    expect(resolveServerRuntime({ ...base, resourcesPath: '/App/Resources' }).execPath).toBe('node')
    expect(resolveServerRuntime({ ...base, resourcesPath: '', exists: () => true }).execPath).toBe(
      'node',
    )
  })

  it('逃生口：明确要求时才借 Electron 自带的 Node', () => {
    expect(
      resolveServerRuntime({ ...base, env: { AGENTSWS_SIDECAR_RUNTIME: 'electron' } }),
    ).toEqual({ kind: 'electron', execPath: '/App/agentsws' })
  })
})

describe('resolveServerEntry', () => {
  it('第一个存在的候选赢', () => {
    expect(resolveServerEntry(['/a', '/b'], (p) => p === '/b')).toBe('/b')
  })

  it('跳过 undefined 候选（require.resolve 失败时）', () => {
    expect(resolveServerEntry([undefined, '/c'], () => true)).toBe('/c')
  })

  it('全找不到就报清楚试过哪些', () => {
    expect(() => resolveServerEntry(['/a', undefined], () => false)).toThrowError(/\/a/)
    expect(() => resolveServerEntry([], () => false)).toThrowError(/\(空\)/)
  })
})
