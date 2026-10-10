/**
 * WP292：本机传 R2 脚本的用例。全部不出网：gh / wrangler / curl 都是临时目录里的假替身，
 * 假 wrangler 把对象「传」进一个临时目录，假 curl 从那个目录取——校验看到的就是刚传的东西。
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LONG,
  parseArgs,
  planContentUploads,
  planUploads,
  readBundle,
  readContentBundle,
  resolveRelease,
  run,
  SHORT,
  wranglerArgs,
  wranglerEnv,
} from './release-upload-r2.mjs'

const SCRIPT = resolve(import.meta.dirname, 'release-upload-r2.mjs')
const V = '0.2.0-beta.1'
const tmp = (p) => mkdtempSync(join(tmpdir(), `wp292-${p}-`))
const EXE = `Agents-Workshop-Setup-${V}-x64.exe`
const ARM = `Agents-Workshop-${V}-arm64.dmg`
const X64 = `Agents-Workshop-${V}-x64.dmg`
const yml = (version, files) =>
  `version: ${version}\nfiles:\n${files.map((f) => `  - url: ${f}\n    sha512: x\n    size: 3\n`).join('')}path: ${files[0]}\nsha512: x\nreleaseDate: '2026-10-10T00:00:00.000Z'\n`

/** 一套假的 release-bundle（与 release.yml 上传的形状一样：artifacts/ + downloads.json + release-meta.json）。 */
function fakeBundle({ version = V, meta = {}, drop = [] } = {}) {
  const root = tmp('bundle')
  const art = join(root, 'artifacts')
  mkdirSync(art)
  const files = {
    [EXE]: 'exe',
    [`${EXE}.blockmap`]: 'bm',
    [ARM]: 'dmg',
    [X64]: 'dmg',
    [`Agents-Workshop-${V}-arm64-mac.zip`]: 'zip',
    [`agents-workshop-extension-${V}.zip`]: 'zip',
    'latest.yml': yml(version, [EXE]),
    'latest-mac.yml': yml(version, [ARM, X64]),
  }
  for (const [n, body] of Object.entries(files))
    if (!drop.includes(n)) writeFileSync(join(art, n), body)
  const channel = version.includes('-') ? 'beta' : 'stable'
  writeFileSync(join(root, 'downloads.json'), JSON.stringify({ version, channel }))
  const m = { tag: `v${version}`, version, channel, dry_run: false, site_channel: 'beta', ...meta }
  writeFileSync(join(root, 'release-meta.json'), JSON.stringify(m))
  return root
}

describe('参数', () => {
  it('默认只打印计划；--upload 才传；--dry-run 压过 --upload', () => {
    expect(parseArgs(['--run', '123']).dryRun).toBe(true)
    expect(parseArgs(['--dir', 'x', '--dry-run']).dryRun).toBe(true)
    expect(parseArgs(['--run', '123', '--upload']).dryRun).toBe(false)
    expect(parseArgs(['--run', '123', '--upload', '--dry-run']).dryRun).toBe(true)
    expect(parseArgs(['--dir', 'x']).bucket).toBeUndefined()
    expect(parseArgs(['--dir', 'x', '--bucket', 'b2']).bucket).toBe('b2')
  })
  it('拒：两个都给 / 都不给 / run id 不是数字 / 渠道写错 / 不认识的参数', () => {
    expect(() => parseArgs([])).toThrow('二选一')
    expect(() => parseArgs(['--run', '1', '--dir', 'x'])).toThrow('二选一')
    expect(() => parseArgs(['--run', 'abc'])).toThrow('数字')
    expect(() => parseArgs(['--dir', 'x', '--channel', 'nightly'])).toThrow('beta / stable')
    expect(() => parseArgs(['--dir', 'x', '--force'])).toThrow('不认识')
    expect(() => parseArgs(['--dir'])).toThrow('值')
  })
})

describe('上传计划', () => {
  it('目录、顺序、cache-control、content-type 与 release.yml 原来那两步一致', () => {
    const b = readBundle(fakeBundle())
    const rel = resolveRelease(b, undefined)
    expect(rel).toMatchObject({
      version: V,
      channel: 'beta',
      siteChannel: 'beta',
      tag: `v${V}`,
      bucket: 'agentsws-downloads',
    })
    expect(resolveRelease(readBundle(fakeBundle({ meta: { bucket: 'other' } }))).bucket).toBe(
      'other',
    )
    const plan = planUploads({ ...b, channel: rel.channel, siteChannel: rel.siteChannel })
    expect(plan.map((p) => [p.key, p.contentType, p.cacheControl])).toEqual([
      [`beta/${EXE}`, 'application/vnd.microsoft.portable-executable', LONG],
      [`beta/${ARM}`, 'application/x-apple-diskimage', LONG],
      [`beta/${X64}`, 'application/x-apple-diskimage', LONG],
      [`beta/${EXE}.blockmap`, 'application/octet-stream', LONG],
      [`beta/Agents-Workshop-${V}-arm64-mac.zip`, 'application/zip', LONG],
      [`beta/agents-workshop-extension-${V}.zip`, 'application/zip', LONG],
      ['beta/latest-mac.yml', 'text/yaml', SHORT],
      ['beta/latest.yml', 'text/yaml', SHORT],
      ['beta/downloads.json', 'application/json', SHORT],
      ['downloads.json', 'application/json', SHORT],
    ])
    expect(LONG).toBe('public, max-age=31536000, immutable')
    expect(SHORT).toBe('no-cache, max-age=0')
  })
  it('根目录 downloads.json：beta 只在官网渠道是 beta 时动；stable 总是动', () => {
    const b = readBundle(fakeBundle())
    const keys = (channel, siteChannel) =>
      planUploads({ ...b, channel, siteChannel }).map((p) => p.key)
    expect(keys('beta', 'stable')).not.toContain('downloads.json')
    expect(keys('stable', 'beta').at(-1)).toBe('downloads.json')
  })
  it('wrangler 命令行与环境：OAuth 身份、不带 API 令牌、不发统计', () => {
    const item = { file: '/x/a.exe', key: 'beta/a.exe', contentType: 'ct', cacheControl: LONG }
    expect(wranglerArgs('agentsws-downloads', item)).toEqual([
      'r2',
      'object',
      'put',
      'agentsws-downloads/beta/a.exe',
      '--file',
      '/x/a.exe',
      '--cache-control',
      LONG,
      '--content-type',
      'ct',
      '--remote',
    ])
    const env = wranglerEnv({ PATH: '/bin', CLOUDFLARE_API_TOKEN: 'fake', CF_API_TOKEN: 'fake' })
    expect(env).toEqual({ PATH: '/bin', CI: 'true', WRANGLER_SEND_METRICS: 'false' })
  })
  it('拒：渠道对不上、缺 latest-mac.yml、downloads.json 版本不对', () => {
    const rel = (opts, ch) => resolveRelease(readBundle(fakeBundle(opts)), ch)
    expect(() => rel({}, 'stable')).toThrow('对不上')
    expect(() => rel({ drop: ['latest-mac.yml'] })).toThrow('缺 latest-mac.yml')
    const root = fakeBundle()
    writeFileSync(
      join(root, 'downloads.json'),
      JSON.stringify({ version: '0.1.0', channel: 'beta' }),
    )
    expect(() => resolveRelease(readBundle(root))).toThrow('downloads.json 的版本是 0.1.0')
  })
})

/** 假 gh / wrangler / curl：gh 把假产物拷进 -D；wrangler 记账并把文件「传」进 R2 目录；curl 从 R2 目录取。 */
function fakeTools() {
  const bin = tmp('bin')
  const r2 = tmp('r2')
  const log = join(tmp('log'), 'calls.jsonl')
  const tool = (name, body) => {
    const p = join(bin, name)
    writeFileSync(
      p,
      `#!/usr/bin/env node\nconst fs = require('node:fs'), path = require('node:path')\nconst a = process.argv.slice(2)\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: ${JSON.stringify(name)}, a, ci: process.env.CI, metrics: process.env.WRANGLER_SEND_METRICS, token: process.env.CLOUDFLARE_API_TOKEN ?? null }) + '\\n')\n${body}\n`,
    )
    chmodSync(p, 0o755)
    return p
  }
  tool(
    'gh',
    `if ((process.env.FAKE_GH_MISSING ?? '').split(',').includes(a[a.indexOf('-n') + 1])) process.exit(1)
fs.cpSync(process.env.FAKE_BUNDLE, a[a.indexOf('-D') + 1], { recursive: true })`,
  )
  const wrangler = tool(
    'wrangler',
    `const key = a[3].split('/').slice(1).join('/')
if (process.env.FAKE_FAIL_ON === key) process.exit(1)
const to = path.join(${JSON.stringify(r2)}, key)
fs.mkdirSync(path.dirname(to), { recursive: true })
fs.copyFileSync(a[a.indexOf('--file') + 1], to)`,
  )
  tool(
    'curl',
    `const u = new URL(a.at(-1)), p = path.join(${JSON.stringify(r2)}, u.pathname)
if (!fs.existsSync(p)) process.exit(22)
process.stdout.write(fs.readFileSync(p))`,
  )
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : []
  const contentPack = tool('content-pack', 'if (process.env.FAKE_VERIFY_FAIL) process.exit(1)')
  return { bin, r2, wrangler, contentPack, calls }
}

function cli(args, t, extra = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--base', 'https://dl.example.test'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${t.bin}${delimiter}${process.env.PATH}`,
      AGENTSWS_WRANGLER: t.wrangler,
      CLOUDFLARE_API_TOKEN: 'fake-should-be-stripped',
      ...extra,
    },
  })
}

describe('端到端（假 gh / wrangler / curl）', () => {
  it('默认 dry-run：取了产物、打印计划，一次 wrangler / curl 都不调', () => {
    const t = fakeTools()
    const r = cli(['--run', '42'], t, { FAKE_BUNDLE: fakeBundle() })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('一个字节都没传')
    expect(r.stdout).toContain('beta/latest.yml')
    expect(t.calls().map((c) => c.tool)).toEqual(['gh'])
    expect(t.calls()[0].a).toEqual(
      expect.arrayContaining(['run', 'download', '42', '-n', 'release-bundle']),
    )
  })
  it('--upload：按顺序传、wrangler 不见 API 令牌、curl 取回 latest*.yml 版本对', () => {
    const t = fakeTools()
    const r = cli(['--run', '42', '--upload'], t, { FAKE_BUNDLE: fakeBundle() })
    expect(r.status, r.stderr).toBe(0)
    const puts = t.calls().filter((c) => c.tool === 'wrangler')
    expect(puts.map((c) => c.a[3])).toEqual([
      `agentsws-downloads/beta/${EXE}`,
      `agentsws-downloads/beta/${ARM}`,
      `agentsws-downloads/beta/${X64}`,
      `agentsws-downloads/beta/${EXE}.blockmap`,
      `agentsws-downloads/beta/Agents-Workshop-${V}-arm64-mac.zip`,
      `agentsws-downloads/beta/agents-workshop-extension-${V}.zip`,
      'agentsws-downloads/beta/latest-mac.yml',
      'agentsws-downloads/beta/latest.yml',
      'agentsws-downloads/beta/downloads.json',
      'agentsws-downloads/downloads.json',
    ])
    for (const c of puts) {
      expect(c).toMatchObject({ ci: 'true', metrics: 'false', token: null })
      expect(c.a.at(-1)).toBe('--remote')
    }
    const curls = t
      .calls()
      .filter((c) => c.tool === 'curl')
      .map((c) => new URL(c.a.at(-1)).pathname)
    expect(curls).toEqual(['/beta/latest.yml', '/beta/latest-mac.yml', '/downloads.json'])
    expect(r.stdout).toContain(`latest.yml 已是 ${V}`)
  })
  it('中途传挂：停下，latest*.yml 一个都没动', () => {
    const t = fakeTools()
    const r = cli(['--run', '42', '--upload'], t, {
      FAKE_BUNDLE: fakeBundle(),
      FAKE_FAIL_ON: `beta/${X64}`,
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('没成')
    expect(existsSync(join(t.r2, 'beta', 'latest.yml'))).toBe(false)
    expect(t.calls().some((c) => c.tool === 'curl')).toBe(false)
  })
  it('--dir 读本地目录；远端版本不对就红', async () => {
    const t = fakeTools()
    const logs = []
    const exec = (cmd, args, opts) => {
      if (cmd === 'curl') return { status: 0, stdout: yml('0.1.9', [EXE]) }
      return spawnSync(cmd, args, { ...opts, encoding: 'utf8', stdio: 'ignore' })
    }
    const env = { ...process.env, AGENTSWS_WRANGLER: t.wrangler }
    await expect(
      run(['--dir', fakeBundle(), '--upload'], { env, exec, log: (s) => logs.push(s) }),
    ).rejects.toThrow('beta/latest.yml 上的版本是 0.1.9')
    expect(t.calls().filter((c) => c.tool === 'wrangler')).toHaveLength(10)
  })
  it('有对象超过 wrangler 的 300 MiB 上限：一个都不传，dry-run 也报', async () => {
    const root = fakeBundle()
    truncateSync(join(root, 'artifacts', ARM), 301 * 1024 * 1024) // 稀疏文件，不真占盘
    const exec = () => {
      throw new Error('不该调任何外部命令')
    }
    try {
      await expect(run(['--dir', root], { exec, log: () => {} })).rejects.toThrow('一个都没传')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('dry-run 那次的产物（release-dry-run）：能看计划演练，不能真传', () => {
    const t = fakeTools()
    const extra = {
      FAKE_BUNDLE: fakeBundle({ meta: { dry_run: true } }),
      FAKE_GH_MISSING: 'release-bundle',
    }
    const plan = cli(['--run', '42'], t, extra)
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('只能看计划')
    expect(t.calls().map((c) => c.a[c.a.indexOf('-n') + 1])).toEqual([
      'release-bundle',
      'release-dry-run',
    ])
    const up = cli(['--run', '42', '--upload'], t, extra)
    expect(up.status).toBe(1)
    expect(up.stderr).toContain('release-bundle')
    const local = cli(['--dir', extra.FAKE_BUNDLE, '--upload'], t)
    expect(local.status).toBe(1)
    expect(local.stderr).toContain('不传')
    expect(t.calls().some((c) => c.tool === 'wrangler')).toBe(false)
  })
})

const REPO = resolve(import.meta.dirname, '..')
const SHA1 = 'a'.repeat(64)
const SHA2 = 'b'.repeat(64)

/** 一份假的 content-pack artifact（与 content 作业上传的形状一样：r2/<渠道>/…、github/…、release-meta.json）。 */
function fakeContent({ channel = 'beta', serial = 1760000000, meta = {}, sig = 'c2ln' } = {}) {
  const root = tmp('content')
  const ch = join(root, 'r2', channel)
  mkdirSync(join(ch, 'blobs'), { recursive: true })
  mkdirSync(join(root, 'github'))
  writeFileSync(join(ch, 'blobs', SHA2), 'two')
  writeFileSync(join(ch, 'blobs', SHA1), 'one')
  writeFileSync(join(ch, 'content-manifest.json'), JSON.stringify({ channel, serial, items: [] }))
  writeFileSync(join(ch, 'content-manifest.json.sig'), sig)
  writeFileSync(join(root, 'github', 'content-manifest.json'), '{}')
  const m = { kind: 'content', channel, upload: true, bucket: 'agentsws-downloads', ...meta }
  writeFileSync(join(root, 'release-meta.json'), JSON.stringify(m))
  return root
}

describe('内容包（--content）', () => {
  it('目录、顺序、cache-control、content-type 与 content 作业原来那一步一致', () => {
    const b = readContentBundle(fakeContent())
    expect(b).toMatchObject({ channel: 'beta', serial: 1760000000, blobs: expect.any(Array) })
    expect(planContentUploads(b).map((p) => [p.key, p.contentType, p.cacheControl])).toEqual([
      [`content/beta/blobs/${SHA1}`, 'application/octet-stream', LONG],
      [`content/beta/blobs/${SHA2}`, 'application/octet-stream', LONG],
      ['content/beta/content-manifest.json.sig', 'text/plain', SHORT],
      ['content/beta/content-manifest.json', 'application/json', SHORT],
    ])
    // 直接给 r2/<渠道> 那一层也认
    expect(readContentBundle(join(fakeContent(), 'r2', 'beta')).channel).toBe('beta')
  })
  it('拒：--channel 对不上、目录名与清单渠道对不上、没有清单', () => {
    expect(() => readContentBundle(fakeContent(), 'stable')).toThrow('里的渠道是 beta')
    expect(() => readContentBundle(join(fakeContent(), 'r2', 'beta'), 'stable')).toThrow('对不上')
    const root = fakeContent()
    const ch = join(root, 'r2', 'beta', 'content-manifest.json')
    writeFileSync(ch, JSON.stringify({ channel: 'stable', serial: 1 }))
    expect(() => readContentBundle(root)).toThrow('目录 r2/beta')
    expect(() => readContentBundle(tmp('empty'))).toThrow('没有 content-manifest.json')
  })
  it('默认 dry-run：取 content-pack、用内置公钥验，不调 wrangler / curl', () => {
    const t = fakeTools()
    const r = cli(['--content', '--run', '42'], t, {
      FAKE_BUNDLE: fakeContent(),
      AGENTSWS_CONTENT_PACK: t.contentPack,
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('一个字节都没传')
    const calls = t.calls()
    expect(calls.map((c) => c.tool)).toEqual(['gh', 'content-pack'])
    expect(calls[0].a).toEqual(expect.arrayContaining(['-n', 'content-pack']))
    expect(calls[1].a[0]).toBe('verify')
    expect(calls[1].a.at(-1)).toBe('--builtin')
    expect(calls[1].a[2]).toMatch(/r2[\\/]beta$/)
  })
  it('--upload：验过 → 先文件、再签名、最后清单；取回清单序号与签名都对', () => {
    const t = fakeTools()
    const r = cli(['--content', '--run', '42', '--upload'], t, {
      FAKE_BUNDLE: fakeContent(),
      AGENTSWS_CONTENT_PACK: t.contentPack,
    })
    expect(r.status, r.stderr).toBe(0)
    const tools = t.calls().map((c) => c.tool)
    expect(tools.indexOf('content-pack')).toBeLessThan(tools.indexOf('wrangler'))
    const puts = t.calls().filter((c) => c.tool === 'wrangler')
    expect(puts.map((c) => c.a[3])).toEqual([
      `agentsws-downloads/content/beta/blobs/${SHA1}`,
      `agentsws-downloads/content/beta/blobs/${SHA2}`,
      'agentsws-downloads/content/beta/content-manifest.json.sig',
      'agentsws-downloads/content/beta/content-manifest.json',
    ])
    for (const c of puts) expect(c).toMatchObject({ ci: 'true', metrics: 'false', token: null })
    const curls = t.calls().filter((c) => c.tool === 'curl')
    expect(curls.map((c) => new URL(c.a.at(-1)).pathname)).toEqual([
      '/content/beta/content-manifest.json',
      '/content/beta/content-manifest.json.sig',
    ])
    expect(r.stdout).toContain('已是序号 1760000000')
  })
  it('内置公钥验不过：一个都不传（dry-run 也报）', () => {
    const t = fakeTools()
    const extra = {
      FAKE_BUNDLE: fakeContent(),
      AGENTSWS_CONTENT_PACK: t.contentPack,
      FAKE_VERIFY_FAIL: '1',
    }
    for (const args of [
      ['--content', '--run', '42', '--upload'],
      ['--content', '--run', '42'],
    ]) {
      const r = cli(args, t, extra)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('内置公钥验不过')
    }
    expect(t.calls().some((c) => c.tool === 'wrangler' || c.tool === 'curl')).toBe(false)
  })
  it('那次只打包自检（upload: false）：能看计划，不能传', () => {
    const t = fakeTools()
    const extra = {
      FAKE_BUNDLE: fakeContent({ meta: { upload: false } }),
      AGENTSWS_CONTENT_PACK: t.contentPack,
    }
    const plan = cli(['--content', '--run', '42'], t, extra)
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('只能看计划')
    const up = cli(['--content', '--run', '42', '--upload'], t, extra)
    expect(up.status).toBe(1)
    expect(up.stderr).toContain('不传')
    expect(t.calls().some((c) => c.tool === 'wrangler')).toBe(false)
  })
  const built =
    existsSync(join(REPO, 'packages/skills/dist')) &&
    existsSync(join(REPO, 'packages/contracts/dist/index.js'))
  it.skipIf(!built)(
    '真验签（content-pack.mjs verify --builtin）：签名不是内置那把钥匙签的 → 一个都不传',
    () => {
      const t = fakeTools()
      const r = cli(
        ['--content', '--dir', fakeContent({ sig: 'bm90LWEtcmVhbC1zaWc=' }), '--upload'],
        t,
      )
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('内置公钥验不过')
      expect(r.stderr).not.toContain('Cannot find module')
      expect(t.calls().some((c) => c.tool === 'wrangler')).toBe(false)
    },
  )
})
