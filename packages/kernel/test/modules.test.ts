import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_ALLOWED_PUBLISHERS, ModuleRegistry } from '../src/index.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个临时模块树：每个 entry 写一个真文件，签名 = 该文件的 sha256。 */
function fixture(modules: Record<string, unknown>[], entries: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-modules-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(entries)) writeFileSync(join(dir, name), content)
  const manifestPath = join(dir, 'modules.yml')
  writeFileSync(manifestPath, JSON.stringify({ modules }))
  return { dir, manifestPath }
}

const sha256 = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`

describe('ModuleRegistry（28 §1 模块清单 / 28 §4 用例 2）', () => {
  it('没有清单 → 空列表', () => {
    const registry = new ModuleRegistry()
    expect(registry.health()).toEqual([])
    expect(registry.manifests()).toEqual([])
    expect(registry.activeContracts()).toEqual({})
    expect(DEFAULT_ALLOWED_PUBLISHERS).toEqual(['official'])
  })

  it('签名与允许源都对 + requires 满足 → active', () => {
    const body = 'export const id = "event-log"\n'
    const { manifestPath } = fixture(
      [
        {
          id: 'event-log',
          version: '1.0.0',
          publisher: 'official',
          entry: './event-log.js',
          signature: sha256(body),
          provides: { 'agentsws.event-log': '1.2.0' },
          requires: {},
        },
        {
          id: 'approval',
          version: '1.0.0',
          publisher: 'official',
          entry: './approval.js',
          signature: sha256('approval\n'),
          provides: { 'agentsws.approval': '1.0.0' },
          requires: { 'agentsws.event-log': '^1.1.0' },
        },
      ],
      { 'event-log.js': body, 'approval.js': 'approval\n' },
    )
    const registry = new ModuleRegistry({ manifestPath })
    expect(registry.health()).toEqual([
      { id: 'event-log', state: 'active' },
      { id: 'approval', state: 'active' },
    ])
    expect(registry.activeContracts()).toEqual({
      'agentsws.event-log': '1.2.0',
      'agentsws.approval': '1.0.0',
    })
  })

  it('requires 不满足 → pending + missing', () => {
    const { manifestPath } = fixture(
      [
        {
          id: 'approval',
          version: '1.0.0',
          publisher: 'official',
          entry: './approval.js',
          signature: sha256('approval\n'),
          requires: { 'agentsws.event-log': '^2.0.0', 'agentsws.data': '^1.0.0' },
        },
        {
          id: 'event-log',
          version: '1.0.0',
          publisher: 'official',
          entry: './event-log.js',
          signature: sha256('el\n'),
          provides: { 'agentsws.event-log': '1.2.0' },
        },
      ],
      { 'approval.js': 'approval\n', 'event-log.js': 'el\n' },
    )
    const registry = new ModuleRegistry({ manifestPath })
    expect(registry.get('approval')).toEqual({
      id: 'approval',
      state: 'pending',
      missing: ['agentsws.event-log@^2.0.0', 'agentsws.data@^1.0.0'],
      detail: 'waiting for agentsws.event-log@^2.0.0, agentsws.data@^1.0.0',
    })
    expect(registry.get('event-log')?.state).toBe('active')
  })

  it('挂起会级联：依赖一个挂起模块的模块也挂起', () => {
    const { manifestPath } = fixture(
      [
        {
          id: 'a',
          version: '1.0.0',
          publisher: 'official',
          entry: './a.js',
          signature: sha256('a\n'),
          provides: { 'c.a': '1.0.0' },
          requires: { 'c.missing': '^1.0.0' },
        },
        {
          id: 'b',
          version: '1.0.0',
          publisher: 'official',
          entry: './b.js',
          signature: sha256('b\n'),
          requires: { 'c.a': '^1.0.0' },
        },
      ],
      { 'a.js': 'a\n', 'b.js': 'b\n' },
    )
    const registry = new ModuleRegistry({ manifestPath })
    expect(registry.get('a')?.state).toBe('pending')
    expect(registry.get('b')).toMatchObject({ state: 'pending', missing: ['c.a@^1.0.0'] })
    expect(registry.activeContracts()).toEqual({})
  })

  it('签名与清单不符 → failed（不装载）', () => {
    const { manifestPath } = fixture(
      [
        {
          id: 'tampered',
          version: '1.0.0',
          publisher: 'official',
          entry: './tampered.js',
          signature: sha256('the reviewed source\n'),
        },
      ],
      { 'tampered.js': 'the shipped source\n' },
    )
    const health = new ModuleRegistry({ manifestPath }).get('tampered')
    expect(health?.state).toBe('failed')
    expect(health?.detail).toMatch(/signature mismatch/)
  })

  it('未签名 → failed；关掉强制签名后放行', () => {
    const modules = [
      { id: 'unsigned', version: '1.0.0', publisher: 'official', entry: './unsigned.js' },
    ]
    const { manifestPath } = fixture(modules, { 'unsigned.js': 'x\n' })
    expect(new ModuleRegistry({ manifestPath }).get('unsigned')).toMatchObject({
      state: 'failed',
      detail: 'module is unsigned; a sha256 signature is required',
    })
    expect(
      new ModuleRegistry({ manifestPath, requireSignature: false }).get('unsigned')?.state,
    ).toBe('active')
  })

  it('允许源之外 → failed；显式加入公司私有源后放行', () => {
    const body = 'private\n'
    const modules = [
      {
        id: 'inhouse',
        version: '1.0.0',
        publisher: 'acme-private',
        entry: './inhouse.js',
        signature: sha256(body),
      },
      { id: 'anon', version: '1.0.0', entry: './inhouse.js', signature: sha256(body) },
    ]
    const { manifestPath } = fixture(modules, { 'inhouse.js': body })
    const strict = new ModuleRegistry({ manifestPath })
    expect(strict.get('inhouse')).toMatchObject({ state: 'failed' })
    expect(strict.get('inhouse')?.detail).toMatch(/not in the allowed sources \(official\)/)
    expect(strict.get('anon')?.detail).toMatch(/publisher null is not in the allowed sources/)

    const relaxed = new ModuleRegistry({
      manifestPath,
      allowedPublishers: ['official', 'acme-private'],
    })
    expect(relaxed.get('inhouse')?.state).toBe('active')
  })

  it('签名文件读不到 / 签名格式不对 → failed', () => {
    const { manifestPath } = fixture([
      {
        id: 'gone',
        version: '1.0.0',
        publisher: 'official',
        entry: './gone.js',
        signature: sha256('x'),
      },
      {
        id: 'bad-sig',
        version: '1.0.0',
        publisher: 'official',
        entry: './gone.js',
        signature: 'pgp:whatever',
      },
    ])
    const registry = new ModuleRegistry({ manifestPath })
    expect(registry.get('gone')?.detail).toMatch(/cannot hash entry/)
    expect(registry.get('bad-sig')?.detail).toMatch(/signature must be "sha256:<64 hex>"/)
  })

  it('坏条目单独 failed，不拖垮整份清单', () => {
    const good = 'good\n'
    const { manifestPath } = fixture(
      [
        { version: '1.0.0', publisher: 'official', entry: './x.js' },
        {
          id: 'bad-version',
          version: '1.0.0',
          publisher: 'official',
          entry: './good.js',
          signature: sha256(good),
          provides: { 'c.x': 'not-semver' },
        },
        {
          id: 'bad-range',
          version: '1.0.0',
          publisher: 'official',
          entry: './good.js',
          signature: sha256(good),
          requires: { 'c.x': '>>>' },
        },
        {
          id: 'good',
          version: '1.0.0',
          publisher: 'official',
          entry: './good.js',
          signature: sha256(good),
        },
        {
          id: 'good',
          version: '2.0.0',
          publisher: 'official',
          entry: './good.js',
          signature: sha256(good),
        },
      ],
      { 'good.js': good },
    )
    const health = new ModuleRegistry({ manifestPath }).health()
    expect(health.map((h) => h.state)).toEqual(['failed', 'failed', 'failed', 'active', 'failed'])
    expect(health[0]?.detail).toMatch(/invalid manifest entry/)
    expect(health[1]?.detail).toMatch(/must be an exact semver version/)
    expect(health[2]?.detail).toMatch(/must be a semver range/)
    expect(health[4]?.detail).toMatch(/duplicate module id/)
  })

  it('清单读不到 / 形状不对 → 直接抛（起不来好过带病运行）', () => {
    expect(() => new ModuleRegistry({ manifestPath: '/nope/modules.yml' })).toThrow(
      /cannot read module manifest/,
    )
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-modules-'))
    dirs.push(dir)
    const manifestPath = join(dir, 'modules.yml')
    writeFileSync(manifestPath, 'modules: 42\n')
    expect(() => new ModuleRegistry({ manifestPath })).toThrow(/must be a list/)
  })

  it('裸列表形式的清单也吃，load() 可重读', () => {
    const body = 'x\n'
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-modules-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'x.js'), body)
    const manifestPath = join(dir, 'modules.yml')
    writeFileSync(
      manifestPath,
      `- id: x\n  version: 1.0.0\n  publisher: official\n  entry: ./x.js\n  signature: ${sha256(body)}\n`,
    )
    const registry = new ModuleRegistry({ manifestPath })
    expect(registry.get('x')?.state).toBe('active')
    // 清单里省略的 provides / requires 由 Schemastery 补成空表，activeContracts 不会因此炸掉
    expect(registry.manifests()).toEqual([
      {
        id: 'x',
        version: '1.0.0',
        publisher: 'official',
        entry: './x.js',
        signature: sha256(body),
        provides: {},
        requires: {},
      },
    ])
    expect(registry.activeContracts()).toEqual({})
    writeFileSync(manifestPath, 'modules: []\n')
    expect(registry.load()).toEqual([])
    expect(registry.manifests()).toEqual([])
  })

  it('绝对路径 entry 与注入的 hash 计算（大小写不敏感比对）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-modules-'))
    dirs.push(dir)
    const absolute = join(dir, 'abs.js')
    const manifestPath = join(dir, 'modules.yml')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        modules: [
          {
            id: 'abs',
            version: '1.0.0',
            publisher: 'official',
            entry: absolute,
            signature: `sha256:${'a'.repeat(64)}`,
          },
        ],
      }),
    )
    const seen: string[] = []
    const registry = new ModuleRegistry({
      manifestPath,
      hashEntry: (p) => {
        seen.push(p)
        return 'A'.repeat(64)
      },
    })
    expect(seen).toEqual([absolute])
    expect(registry.get('abs')?.state).toBe('active')
  })
})
