/**
 * WP245：给一键安装找 npm——捆绑 node 旁边的 → 下载过的 → 钉死那一版下载并校验 sha512。
 * 下载用替身 fetch（测试自己造的 tgz），不联网；解包是纯 JS（不调系统 tar）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundledNpmCandidates,
  cachedNpmCli,
  ensureNpmCli,
  extractTgz,
  integrityOk,
  NPM_RUNTIME,
  npmTarballUrl,
  safeEntryPath,
} from '../src/npm-runtime.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wp245-npm-'))
  dirs.push(d)
  return d
}

/** 造一份最小的 ustar（够我们的解包器读）。 */
function tarOf(entries: { name: string; body?: string; type?: string }[]): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '', 'utf8')
    const h = Buffer.alloc(512)
    h.write(e.name.slice(0, 100), 0, 'utf8')
    h.write('0000644\0', 100)
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    h.write(e.type ?? '0', 156)
    h.write('ustar\0', 257)
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
const sri = (b: Uint8Array): string => `sha512-${createHash('sha512').update(b).digest('base64')}`

describe('找 npm', () => {
  it('捆绑 node 旁边的两处（官方发行包布局；Windows 在 node.exe 同目录）', () => {
    expect(bundledNpmCandidates('/app/resources/node/bin/node', 'darwin')[0]).toBe(
      '/app/resources/node/lib/node_modules/npm/bin/npm-cli.js',
    )
    expect(bundledNpmCandidates('/x/node/node.exe', 'win32')[0]).toBe(
      join('/x/node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    )
    expect(npmTarballUrl('https://registry.npmmirror.com/', '10.9.9')).toBe(
      'https://registry.npmmirror.com/npm/-/npm-10.9.9.tgz',
    )
    expect(NPM_RUNTIME.integrity.startsWith('sha512-')).toBe(true)
  })

  it('有自带的就用，不下载', async () => {
    const tools = tmp()
    let fetched = 0
    const got = await ensureNpmCli({
      nodeExec: '/app/node/bin/node',
      toolsDir: tools,
      exists: (p) => p === '/app/node/lib/node_modules/npm/bin/npm-cli.js',
      fetchImpl: (async () => {
        fetched += 1
        return new Response('')
      }) as typeof fetch,
    })
    expect(got).toBe('/app/node/lib/node_modules/npm/bin/npm-cli.js')
    expect(fetched).toBe(0)
  })

  it('没有就下钉死的那一版，校验对了才解到 <tools>/npm/<版本>', async () => {
    const tools = tmp()
    const tgz = gzipSync(
      tarOf([
        { name: 'package/', type: '5' },
        { name: 'package/bin/npm-cli.js', body: 'console.log("npm")' },
        { name: 'package/package.json', body: '{"name":"npm"}' },
      ]),
    )
    const pin = { version: '0.0.1-test', integrity: sri(tgz) }
    const urls: string[] = []
    let downloading = 0
    const got = await ensureNpmCli({
      nodeExec: join(tools, 'no-node-here', 'node'),
      toolsDir: tools,
      pin,
      registry: 'https://registry.example.test',
      onDownload: () => {
        downloading += 1
      },
      fetchImpl: (async (url: string) => {
        urls.push(String(url))
        return new Response(tgz)
      }) as unknown as typeof fetch,
    })
    expect(got).toBe(cachedNpmCli(tools, '0.0.1-test'))
    expect(readFileSync(got, 'utf8')).toContain('npm')
    expect(urls).toEqual(['https://registry.example.test/npm/-/npm-0.0.1-test.tgz'])
    expect(downloading).toBe(1)
    // 第二次直接用缓存
    await ensureNpmCli({ nodeExec: join(tools, 'x', 'node'), toolsDir: tools, pin })
  })

  it('校验不对：不解、不留任何文件', async () => {
    const tools = tmp()
    const tgz = gzipSync(tarOf([{ name: 'package/bin/npm-cli.js', body: 'evil' }]))
    await expect(
      ensureNpmCli({
        nodeExec: join(tools, 'x', 'node'),
        toolsDir: tools,
        fetchImpl: (async () => new Response(tgz)) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'integrity' })
    expect(existsSync(join(tools, 'npm'))).toBe(false)
    expect(readdirSync(tools)).toEqual([])
  })

  it('网络不通：network，原因在 cause 链上', async () => {
    const tools = tmp()
    const err = await ensureNpmCli({
      nodeExec: join(tools, 'x', 'node'),
      toolsDir: tools,
      fetchImpl: (async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
        })
      }) as unknown as typeof fetch,
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'network' })
  })
})

describe('解包', () => {
  it('目录穿越的条目一律跳过', () => {
    expect(safeEntryPath('../evil')).toBeUndefined()
    expect(safeEntryPath('/etc/passwd')).toBeUndefined()
    expect(safeEntryPath('C:/Windows/x')).toBeUndefined()
    expect(safeEntryPath('package/a/../../x')).toBeUndefined()
    expect(safeEntryPath('./package/bin/x.js')).toBe('package/bin/x.js')
    const dest = tmp()
    const n = extractTgz(
      gzipSync(
        tarOf([
          { name: '../escape.txt', body: 'x' },
          { name: 'package/ok.txt', body: 'ok' },
        ]),
      ),
      dest,
    )
    expect(n).toBe(1)
    expect(readFileSync(join(dest, 'package', 'ok.txt'), 'utf8')).toBe('ok')
    expect(existsSync(join(dest, '..', 'escape.txt'))).toBe(false)
  })

  it('pax 长名与校验函数', () => {
    const dest = tmp()
    const long = `package/${'很长的目录名'.repeat(12)}/file.js`
    // pax 记录：`<整条字节数> path=<路径>\n`，长度前缀要把自己也算进去
    const rec = (body: string): string => {
      let len = Buffer.byteLength(body) + 2
      for (;;) {
        const s = `${len} ${body}\n`
        if (Buffer.byteLength(s) === len) return s
        len = Buffer.byteLength(s)
      }
    }
    extractTgz(
      gzipSync(
        tarOf([
          { name: 'PaxHeader', type: 'x', body: rec(`path=${long}`) },
          { name: 'truncated', body: 'long-ok' },
        ]),
      ),
      dest,
    )
    expect(readFileSync(join(dest, ...long.split('/')), 'utf8')).toBe('long-ok')
    const bytes = Buffer.from('abc')
    expect(integrityOk(bytes, sri(bytes))).toBe(true)
    expect(integrityOk(bytes, 'sha1-xxx')).toBe(false)
  })
})
