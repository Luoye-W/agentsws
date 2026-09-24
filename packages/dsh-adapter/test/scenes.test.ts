/**
 * WP136（docs/79）：dsh 场景的「事实」对照上游，一处不对就红。
 *
 * - 官方模板表逐项对照 `@deepseek-ai/dsh-app-boot` 的 `PROFILE_TEMPLATES`（从 dsh 自己的
 *   位置解析——那是 dsh 启动器真正用的那一份）；
 * - 启动器解析到的就是 dsh-adapter 依赖的那一版；
 * - 名字规则比上游 `resolveProfileDir` 严（我们要拿它当目录名、要挡住保留名）；
 * - 起其他场景的环境：白名单，任何像密钥的变量都带不过去。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AGENTSWS_SCENE,
  DSH_SCENE_TEMPLATES,
  dshLauncher,
  isInside,
  parseWebSceneUrl,
  portOfUrl,
  RESERVED_SCENE_NAMES,
  redactSceneUrl,
  SCENE_INHERITED_ENV,
  sceneDir,
  sceneEnv,
  sceneNameProblem,
  sceneTemplate,
  surfaceOfBundles,
  webSceneArgs,
} from '../src/index.js'

const require = createRequire(import.meta.url)

/** dsh 启动器自己 import 的那一份 `dsh-app-boot`（从 dsh 的位置解析，不从我们的）。 */
async function upstreamTemplates(): Promise<Record<string, { bundles: string[] }>> {
  const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
  const fromDsh = createRequire(dshManifest)
  const bootManifest = fromDsh.resolve('@deepseek-ai/dsh-app-boot/package.json')
  const pkg = JSON.parse(readFileSync(bootManifest, 'utf8')) as {
    exports: { '.': { default?: string; import?: string } | string }
  }
  const dot = pkg.exports['.']
  const entry = typeof dot === 'string' ? dot : (dot.default ?? dot.import ?? './lib/index.js')
  const mod = (await import(pathToFileURL(join(dirname(bootManifest), entry)).href)) as {
    PROFILE_TEMPLATES: Record<string, { bundles: string[] }>
  }
  return mod.PROFILE_TEMPLATES
}

describe('官方模板表（对照上游 PROFILE_TEMPLATES）', () => {
  it('名字与 bundles 逐项相同，一个不多一个不少', async () => {
    const upstream = await upstreamTemplates()
    expect(DSH_SCENE_TEMPLATES.map((t) => t.name).sort()).toEqual(Object.keys(upstream).sort())
    for (const t of DSH_SCENE_TEMPLATES) expect(t.bundles).toEqual(upstream[t.name]?.bundles)
  })

  it('只有 web 能开网页', () => {
    expect(DSH_SCENE_TEMPLATES.filter((t) => t.surface === 'web').map((t) => t.name)).toEqual([
      'web',
    ])
    for (const t of DSH_SCENE_TEMPLATES) expect(surfaceOfBundles(t.bundles)).toBe(t.surface)
    // 上游把 headless 装机组合规整成「base + web-app + headless」——那也不是网页
    expect(
      surfaceOfBundles([
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@deepseek-ai/dsh-headless',
      ]),
    ).toBe('cli')
    expect(sceneTemplate('web')?.surface).toBe('web')
    expect(sceneTemplate('nope')).toBeUndefined()
  })
})

describe('启动器', () => {
  it('解析到 dsh-adapter 依赖的那一版 dsh，bin.js 真的在', () => {
    const own = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> }
    const launcher = dshLauncher()
    expect(launcher.version).toBe(own.dependencies['@deepseek-ai/dsh'])
    expect(existsSync(launcher.bin)).toBe(true)
    expect(launcher.bin.endsWith(join('lib', 'bin.js'))).toBe(true)
  })

  it('网页场景：不开浏览器、只听回环、端口让系统挑', () => {
    expect(webSceneArgs()).toEqual(['--no-open', '--host', '127.0.0.1', '--port', '0'])
  })
})

describe('名字', () => {
  it('保留名：我们自己、Electron 版 dsh、官方模板', () => {
    for (const name of [AGENTSWS_SCENE, 'desktop', 'web', 'headless', 'sdk', 'sdk-minimal', 'acp'])
      expect(RESERVED_SCENE_NAMES).toContain(name)
    expect(sceneNameProblem('agentsws')).toMatch(/保留/)
    expect(sceneNameProblem('web')).toMatch(/保留/)
  })

  it('合法 / 不合法', () => {
    expect(sceneNameProblem('coding')).toBeUndefined()
    expect(sceneNameProblem('my-code-2')).toBeUndefined()
    for (const bad of [
      '',
      'Coding',
      '2x',
      '../x',
      'a/b',
      'a\\b',
      '.',
      '..',
      '编程',
      `a${'b'.repeat(32)}`,
    ])
      expect(sceneNameProblem(bad), bad).toBeDefined()
  })

  it('sceneDir 只落在 profiles/ 下一层', () => {
    expect(sceneDir('/h', 'coding')).toBe(join('/h', 'profiles', 'coding'))
    for (const bad of ['', '..', '.', 'a/b', 'a\\b']) expect(() => sceneDir('/h', bad)).toThrow()
  })

  it('isInside', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/bc', '/a/b')).toBe(false)
    expect(isInside('/a', '/a/b')).toBe(false)
  })
})

describe('网页场景的网址', () => {
  it('认出 `dsh web:` 那一行，只认回环', () => {
    const url = parseWebSceneUrl('dsh web: http://127.0.0.1:53748/?token=abcDEF_123\n')
    expect(url).toBe('http://127.0.0.1:53748/?token=abcDEF_123')
    expect(portOfUrl(url ?? '')).toBe(53748)
    expect(parseWebSceneUrl('dsh web: http://192.168.1.2:53748/?token=x')).toBeUndefined()
    expect(parseWebSceneUrl('something else')).toBeUndefined()
    expect(portOfUrl('not a url')).toBeUndefined()
  })

  it('token 进日志前抹掉', () => {
    expect(redactSceneUrl('http://127.0.0.1:1/?token=secret&x=1')).toBe(
      'http://127.0.0.1:1/?token=…&x=1',
    )
  })
})

describe('其他场景的环境（交付 3：不带我们的任何密钥）', () => {
  it('白名单继承 + DSH_HOME；我们的密钥、宿主的 API key 一个都不带', () => {
    const base: Record<string, string> = {
      PATH: '/usr/bin',
      HOME: '/Users/x',
      HTTPS_PROXY: 'http://proxy:8080',
      DSH_TELEMETRY_DISABLED: '1',
      AGENTSWS_SESSION_KEY: 's1',
      AGENTSWS_SECRETS_KEY: 's2',
      AGENTSWS_DB_DIR: '/data',
      OOMOL_CONNECT_ENCRYPTION_KEY: 's3',
      OOMOL_CONNECT_ADMIN_TOKEN: 's4',
      DEEPSEEK_API_KEY: 's5',
      OPENAI_API_KEY: 's6',
      DSH_HOME: '/Users/x/.dsh',
    }
    const env = sceneEnv({ base, dshHome: '/app/dsh' })
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      HTTPS_PROXY: 'http://proxy:8080',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_HOME: '/app/dsh',
    })
    for (const secret of ['s1', 's2', 's3', 's4', 's5', 's6'])
      expect(Object.values(env)).not.toContain(secret)
    for (const name of SCENE_INHERITED_ENV)
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|AGENTSWS|OOMOL/)
  })
})
