/**
 * WP219（docs/90 §3–§4）：内容包的签名、哈希、分界线与最低版本。
 *
 * 密钥对每次现生成（`generateKeyPairSync('ed25519')`），不入库、不复用。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildContentPack,
  ContentPackError,
  compareAppVersion,
  contentItemDigest,
  contentItemFitsApp,
  contentPathProblem,
  contentPublicKeyOf,
  readContentDir,
  signContentManifest,
  verifyContentItemFiles,
  verifyContentManifest,
} from '../src/index.js'
import { meta, skillDir, testKey } from './content-helpers.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'wp219-pack-'))

function pack(key: string, opts: { serial?: number; min?: string; itemMin?: string } = {}) {
  const root = tmp()
  return buildContentPack({
    channel: 'beta',
    serial: opts.serial ?? 3,
    created_at: '2026-10-05T00:00:00.000Z',
    min_app_version: opts.min ?? '0.1.0',
    items: [
      {
        meta: meta(
          'demo',
          '1.1.0',
          opts.itemMin === undefined ? {} : { min_app_version: opts.itemMin },
        ),
        dir: skillDir(root, 'demo', '新版正文。'),
      },
    ],
    privateKeyPem: key,
  })
}

const reason = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof ContentPackError ? e.reason : `other:${String(e)}`
  }
  return undefined
}

describe('签名', () => {
  const key = testKey()
  const pub = contentPublicKeyOf(key)
  const opts = { keys: [pub], appVersion: '0.2.0-beta.1', channel: 'beta' as const }

  it('签名对得上 → 收', () => {
    const p = pack(key)
    const m = verifyContentManifest(p.manifestBytes, p.signature, opts)
    expect(m.items[0]?.id).toBe('skill:demo')
    expect(m.key_id).toBe(pub.key_id)
  })

  it('清单改了一个字节 → 签名对不上，拒', () => {
    const p = pack(key)
    const tampered = Buffer.from(p.manifestBytes.toString('utf8').replace('补了一段', '补了两段'))
    expect(reason(() => verifyContentManifest(tampered, p.signature, opts))).toBe('bad_signature')
  })

  it('别人的钥匙签的 → 拒；没有内置钥匙 → 通道关着', () => {
    const p = pack(testKey())
    expect(reason(() => verifyContentManifest(p.manifestBytes, p.signature, opts))).toBe(
      'bad_signature',
    )
    expect(
      reason(() => verifyContentManifest(p.manifestBytes, p.signature, { ...opts, keys: [] })),
    ).toBe('no_keys')
  })

  it('签名是对的，但清单写的 key_id 与签的钥匙不一致 → 拒', () => {
    const p = pack(key)
    const lie = Buffer.from(p.manifestBytes.toString('utf8').replace(pub.key_id, '0'.repeat(16)))
    expect(reason(() => verifyContentManifest(lie, signContentManifest(lie, key), opts))).toBe(
      'unknown_key',
    )
  })

  it('渠道不对 / 旧序号 → 拒；同号在 allowSame 时收', () => {
    const p = pack(key, { serial: 3 })
    expect(
      reason(() =>
        verifyContentManifest(p.manifestBytes, p.signature, { ...opts, channel: 'stable' }),
      ),
    ).toBe('channel')
    expect(
      reason(() => verifyContentManifest(p.manifestBytes, p.signature, { ...opts, minSerial: 5 })),
    ).toBe('old_serial')
    expect(
      reason(() => verifyContentManifest(p.manifestBytes, p.signature, { ...opts, minSerial: 3 })),
    ).toBe('old_serial')
    expect(
      reason(() =>
        verifyContentManifest(p.manifestBytes, p.signature, {
          ...opts,
          minSerial: 3,
          allowSame: true,
        }),
      ),
    ).toBeUndefined()
  })
})

describe('最低软件版本', () => {
  const key = testKey()
  const keys = [contentPublicKeyOf(key)]

  it('整包要求的版本这台够不上 → 整包不收', () => {
    const p = pack(key, { min: '0.3.0' })
    expect(
      reason(() =>
        verifyContentManifest(p.manifestBytes, p.signature, {
          keys,
          appVersion: '0.2.9',
          channel: 'beta',
        }),
      ),
    ).toBe('app_too_old')
  })

  it('条目自己的最低版本：只跳过那一条', () => {
    const p = pack(key, { itemMin: '0.4.0' })
    const m = verifyContentManifest(p.manifestBytes, p.signature, {
      keys,
      appVersion: '0.3.0',
      channel: 'beta',
    })
    const item = m.items[0]
    if (item === undefined) throw new Error('没有条目')
    expect(contentItemFitsApp(item, '0.3.0')).toBe(false)
    expect(contentItemFitsApp(item, '0.4.0')).toBe(true)
  })

  it('版本号比较：正式版大于同号预发布，预发布按段比', () => {
    expect(compareAppVersion('0.2.0', '0.2.0-beta.9')).toBe(1)
    expect(compareAppVersion('0.2.0-beta.10', '0.2.0-beta.9')).toBe(1)
    expect(compareAppVersion('v0.2.1', '0.2.0')).toBe(1)
    expect(compareAppVersion('0.2.0', '0.2')).toBe(0)
  })
})

describe('哈希', () => {
  const key = testKey()

  it('文件都对 → 回字节；一个文件差一个字节 → bad_hash（整包拒收由调用方做）', () => {
    const p = pack(key)
    const item = p.manifest.items[0]
    if (item === undefined) throw new Error('没有条目')
    const files = verifyContentItemFiles(item, (sha) => p.blobs.get(sha))
    expect([...files.keys()].sort()).toEqual(['LICENSE', 'SKILL.md', 'references/notes.md'])
    const target = item.files.find((f) => f.path === 'SKILL.md')?.sha256
    const bad = (sha: string) => {
      const b = p.blobs.get(sha)
      if (b === undefined || sha !== target) return b
      const copy = Buffer.from(b)
      copy[copy.length - 2] = 0x41
      return copy
    }
    expect(reason(() => verifyContentItemFiles(item, bad))).toBe('bad_hash')
    expect(reason(() => verifyContentItemFiles(item, () => undefined))).toBe('missing_file')
  })

  it('条目摘要与文件列表对不上（清单内部不一致）→ bad_hash', () => {
    const p = pack(key)
    const raw = JSON.parse(p.manifestBytes.toString('utf8'))
    raw.items[0].files[0].sha256 = 'f'.repeat(64)
    const bytes = Buffer.from(JSON.stringify(raw))
    expect(
      reason(() =>
        verifyContentManifest(bytes, signContentManifest(bytes, key), {
          keys: [contentPublicKeyOf(key)],
          appVersion: '1.0.0',
          channel: 'beta',
        }),
      ),
    ).toBe('bad_hash')
  })

  it('条目摘要与文件顺序无关', () => {
    const a = [
      { path: 'b.md', sha256: '1'.repeat(64) },
      { path: 'a.md', sha256: '2'.repeat(64) },
    ]
    expect(contentItemDigest(a)).toBe(contentItemDigest([...a].reverse()))
  })
})

describe('分界线：内容包里只许声明式文件', () => {
  it('脚本 / 隐藏文件 / 上跳 / 绝对路径都不许', () => {
    expect(contentPathProblem('SKILL.md')).toBeUndefined()
    expect(contentPathProblem('references/liquid.md')).toBeUndefined()
    expect(contentPathProblem('LICENSE')).toBeUndefined()
    expect(contentPathProblem('evals/evals.json')).toBeUndefined()
    for (const bad of [
      'scripts/search.mjs',
      'run.sh',
      'x.js',
      '../SKILL.md',
      '/etc/x.md',
      '.env',
      'a\\b.md',
      'hooks/a.md',
      'package.json',
    ])
      expect(contentPathProblem(bad), bad).toBeDefined()
  })

  it('打包时目录里有脚本 → 不打（bad_path）', () => {
    const root = tmp()
    const dir = skillDir(root, 'withscript', '正文')
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts', 'log_feedback.mjs'), 'fetch("https://example.com")\n')
    expect(reason(() => readContentDir(dir))).toBe('bad_path')
  })

  it('清单里混进一个 .js 路径 → 整包拒收（bad_path）', () => {
    const key = testKey()
    const p = pack(key)
    const raw = JSON.parse(p.manifestBytes.toString('utf8'))
    raw.items[0].files.push({ path: 'scripts/x.js', sha256: 'e'.repeat(64), size: 3 })
    const bytes = Buffer.from(JSON.stringify(raw))
    expect(
      reason(() =>
        verifyContentManifest(bytes, signContentManifest(bytes, key), {
          keys: [contentPublicKeyOf(key)],
          appVersion: '1.0.0',
          channel: 'beta',
        }),
      ),
    ).toBe('bad_path')
  })
})
